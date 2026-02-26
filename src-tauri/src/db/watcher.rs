//! Live table watcher — uses PostgreSQL LISTEN/NOTIFY for zero-poll, push-based
//! real-time updates. Each watched table gets a dedicated AFTER trigger that
//! serialises INSERT/UPDATE/DELETE rows as JSON and notifies a channel.
//! A background tokio task listens on that channel and forwards events to the
//! Tauri frontend via `app.emit`.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::future::poll_fn;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio_postgres::{AsyncMessage, NoTls};

// ── helpers ────────────────────────────────────────────────────────────────

/// Sanitise a schema/table name: keep alphanumeric + underscore, lowercase.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// Build the channel name from schema + table (max 63 bytes for PG idents).
pub fn channel_name(schema: &str, table: &str) -> String {
    let s = format!("helix_{}_{}", sanitize(schema), sanitize(table));
    // PostgreSQL NOTIFY channel idents are case-insensitive and limited to 63 bytes
    if s.len() > 63 {
        s[..63].to_string()
    } else {
        s
    }
}

/// The Tauri event name the frontend listens to.
/// Tauri only allows: alphanumeric, `-`, `/`, `:`, `_`.
/// Schema/table names are sanitized (non-allowed chars → `_`).
pub fn watch_event_name(connection_id: &str, schema: &str, table: &str) -> String {
    let safe = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    format!("tw/{}/{}/{}", connection_id, safe(schema), safe(table))
}

// ── types ──────────────────────────────────────────────────────────────────

/// Sent to the frontend for every INSERT / UPDATE / DELETE on a watched table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableChangeEvent {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    /// "INSERT" | "UPDATE" | "DELETE"
    pub op: String,
    /// Full new row (INSERT, UPDATE)
    pub new_row: Option<serde_json::Value>,
    /// Full old row (UPDATE, DELETE)
    pub old_row: Option<serde_json::Value>,
    /// true when the row was too large for pg_notify — frontend should do a full refresh
    pub oversized: bool,
}

// ── WatchManager ───────────────────────────────────────────────────────────

struct WatchHandle {
    abort_tx: oneshot::Sender<()>,
}

/// Manages all active table-watch sessions (one per connection+schema+table).
pub struct WatchManager {
    watches: DashMap<String, WatchHandle>,
}

impl WatchManager {
    pub fn new() -> Self {
        Self {
            watches: DashMap::new(),
        }
    }

    fn key(connection_id: &str, schema: &str, table: &str) -> String {
        format!("{}\0{}\0{}", connection_id, schema, table)
    }

    pub fn is_watching(&self, connection_id: &str, schema: &str, table: &str) -> bool {
        self.watches
            .contains_key(&Self::key(connection_id, schema, table))
    }

    /// Install the trigger on the table and start a background LISTEN task.
    pub async fn start_watch(
        &self,
        app: AppHandle,
        connection_id: String,
        schema: String,
        table: String,
        connection_string: String,
    ) -> Result<(), String> {
        let key = Self::key(&connection_id, &schema, &table);
        if self.watches.contains_key(&key) {
            return Ok(()); // already watching
        }

        // ── create trigger ─────────────────────────────────────────────────
        let (setup_client, setup_conn) =
            tokio_postgres::connect(&connection_string, NoTls)
                .await
                .map_err(|e| format!("Watch setup connection failed: {e}"))?;
        tokio::spawn(async move {
            if let Err(e) = setup_conn.await {
                eprintln!("watch-setup conn error: {e}");
            }
        });
        create_trigger(&setup_client, &schema, &table)
            .await
            .map_err(|e| format!("Failed to create watch trigger: {e}"))?;

        // ── start listener task ────────────────────────────────────────────
        let (abort_tx, abort_rx) = oneshot::channel::<()>();
        {
            let app = app.clone();
            let connection_id = connection_id.clone();
            let schema = schema.clone();
            let table = table.clone();
            let channel = channel_name(&schema, &table);
            let conn_str = connection_string.clone();
            tokio::spawn(async move {
                if let Err(e) = run_listener(
                    app,
                    connection_id,
                    schema,
                    table,
                    conn_str,
                    channel,
                    abort_rx,
                )
                .await
                {
                    eprintln!("watch listener error: {e}");
                }
            });
        }

        self.watches.insert(key, WatchHandle { abort_tx });
        Ok(())
    }

    /// Signal the listener to stop. Optionally drops the trigger from the DB.
    pub async fn stop_watch(
        &self,
        connection_id: &str,
        schema: &str,
        table: &str,
        connection_string: Option<&str>,
    ) {
        let key = Self::key(connection_id, schema, table);
        if let Some((_, handle)) = self.watches.remove(&key) {
            let _ = handle.abort_tx.send(());
        }
        if let Some(conn_str) = connection_string {
            if let Ok((client, conn)) = tokio_postgres::connect(conn_str, NoTls).await {
                tokio::spawn(async move {
                    if let Err(e) = conn.await {
                        eprintln!("watch-cleanup conn error: {e}");
                    }
                });
                let _ = drop_trigger(&client, schema, table).await;
            }
        }
    }

    /// Abort all watches belonging to a connection (called on disconnect).
    pub fn stop_all_for_connection(&self, connection_id: &str) {
        let prefix = format!("{}\0", connection_id);
        let keys: Vec<String> = self
            .watches
            .iter()
            .filter(|e| e.key().starts_with(&prefix))
            .map(|e| e.key().clone())
            .collect();
        for key in keys {
            if let Some((_, h)) = self.watches.remove(&key) {
                let _ = h.abort_tx.send(());
            }
        }
    }
}

// ── trigger DDL ────────────────────────────────────────────────────────────

async fn create_trigger(
    client: &tokio_postgres::Client,
    schema: &str,
    table: &str,
) -> Result<(), tokio_postgres::Error> {
    let channel = channel_name(schema, table);
    let fn_name = format!("helix_notify_{}", sanitize(table));
    let trig_name = format!("helix_watch_{}", sanitize(table));

    // AFTER trigger function — serialises row to JSON, respects 7900-byte limit
    let create_fn = format!(
        r#"CREATE OR REPLACE FUNCTION "{schema}"."{fn_name}"()
        RETURNS trigger LANGUAGE plpgsql AS $BODY$
        DECLARE
          payload text;
        BEGIN
          IF TG_OP = 'DELETE' THEN
            payload := json_build_object('op', TG_OP, 'old', row_to_json(OLD))::text;
          ELSIF TG_OP = 'UPDATE' THEN
            payload := json_build_object('op', TG_OP,
              'new', row_to_json(NEW), 'old', row_to_json(OLD))::text;
          ELSE
            payload := json_build_object('op', TG_OP, 'new', row_to_json(NEW))::text;
          END IF;
          IF octet_length(payload) > 7900 THEN
            payload := json_build_object('op', TG_OP, 'oversized', true)::text;
          END IF;
          PERFORM pg_notify('{channel}', payload);
          RETURN NULL;
        END;
        $BODY$;"#,
    );

    let drop_trig = format!(r#"DROP TRIGGER IF EXISTS "{trig_name}" ON "{schema}"."{table}";"#,);
    let create_trig = format!(
        r#"CREATE TRIGGER "{trig_name}"
          AFTER INSERT OR UPDATE OR DELETE ON "{schema}"."{table}"
          FOR EACH ROW EXECUTE FUNCTION "{schema}"."{fn_name}"();"#,
    );

    client.batch_execute(&create_fn).await?;
    client.batch_execute(&drop_trig).await?;
    client.batch_execute(&create_trig).await?;
    Ok(())
}

async fn drop_trigger(
    client: &tokio_postgres::Client,
    schema: &str,
    table: &str,
) -> Result<(), tokio_postgres::Error> {
    let fn_name = format!("helix_notify_{}", sanitize(table));
    let trig_name = format!("helix_watch_{}", sanitize(table));
    let _ = client
        .batch_execute(&format!(
            r#"DROP TRIGGER IF EXISTS "{trig_name}" ON "{schema}"."{table}";"#
        ))
        .await;
    let _ = client
        .batch_execute(&format!(
            r#"DROP FUNCTION IF EXISTS "{schema}"."{fn_name}"();"#
        ))
        .await;
    Ok(())
}

// ── listener task ──────────────────────────────────────────────────────────

async fn run_listener(
    app: AppHandle,
    connection_id: String,
    schema: String,
    table: String,
    connection_string: String,
    channel: String,
    mut abort_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let (client, connection) = tokio_postgres::connect(&connection_string, NoTls)
        .await
        .map_err(|e| format!("Listener connection failed: {e}"))?;

    // Drive the connection in a separate task, piping notifications out
    let (notif_tx, mut notif_rx) =
        tokio::sync::mpsc::unbounded_channel::<tokio_postgres::Notification>();
    tokio::spawn(async move {
        tokio::pin!(connection);
        loop {
            match poll_fn(|cx| connection.as_mut().poll_message(cx)).await {
                Some(Ok(AsyncMessage::Notification(n))) => {
                    if notif_tx.send(n).is_err() {
                        break;
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    eprintln!("listener conn error: {e}");
                    break;
                }
                None => break,
            }
        }
    });

    client
        .batch_execute(&format!(r#"LISTEN "{channel}""#))
        .await
        .map_err(|e| e.to_string())?;

    let event_name = watch_event_name(&connection_id, &schema, &table);

    loop {
        tokio::select! {
            _ = &mut abort_rx => {
                let _ = client.batch_execute(&format!(r#"UNLISTEN "{channel}""#)).await;
                break;
            }
            Some(notif) = notif_rx.recv() => {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(notif.payload()) {
                    let op = payload.get("op")
                        .and_then(|v| v.as_str())
                        .unwrap_or("UNKNOWN")
                        .to_string();
                    let oversized = payload.get("oversized")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let event = TableChangeEvent {
                        connection_id: connection_id.clone(),
                        schema: schema.clone(),
                        table: table.clone(),
                        op,
                        new_row: payload.get("new").cloned(),
                        old_row: payload.get("old").cloned(),
                        oversized,
                    };
                    let _ = app.emit(&event_name, &event);
                }
            }
        }
    }

    Ok(())
}
