//! PostgreSQL replication monitoring: pg_stat_replication, pg_replication_slots, optional Patroni REST.

use deadpool_postgres::Pool;
use serde::{Deserialize, Serialize};
use std::error::Error as StdError;
use std::time::Duration;
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::Error as PgError;

/// Rich Postgres error for Tauri (tokio_postgres `Display` is often just "db error").
fn format_pg_error(e: &PgError) -> String {
    if let Some(db) = e.as_db_error() {
        let mut s = db.message().to_string();
        if let Some(d) = db.detail() {
            s.push_str("\n\nDetail: ");
            s.push_str(d);
        }
        if let Some(h) = db.hint() {
            s.push_str("\n\nHint: ");
            s.push_str(h);
        }
        if let Some(w) = db.where_() {
            s.push_str("\n\nContext:\n");
            s.push_str(w);
        }
        match db.position() {
            Some(ErrorPosition::Original(pos)) => {
                s.push_str("\n\nPosition: character ");
                s.push_str(&pos.to_string());
            }
            Some(ErrorPosition::Internal { position, query }) => {
                s.push_str("\n\nQuery:\n");
                s.push_str(query);
                s.push_str("\n\nPosition: character ");
                s.push_str(&position.to_string());
            }
            None => {}
        }
        s.push_str("\n\nSQLSTATE: ");
        s.push_str(db.code().code());
        return s;
    }
    let top = e.to_string();
    if top.is_empty() || top == "db error" {
        if let Some(src) = e.source() {
            return src.to_string();
        }
    }
    top
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaRow {
    pub pid: i32,
    pub usename: String,
    pub application_name: String,
    pub client_addr: Option<String>,
    pub client_port: Option<i32>,
    pub state: String,
    pub sent_lsn: Option<String>,
    pub write_lsn: Option<String>,
    pub flush_lsn: Option<String>,
    pub replay_lsn: Option<String>,
    pub write_lag_ms: Option<i64>,
    pub flush_lag_ms: Option<i64>,
    pub replay_lag_ms: Option<i64>,
    pub sync_state: String,
    pub sync_priority: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotRow {
    pub slot_name: String,
    pub slot_type: String,
    pub active: bool,
    pub active_pid: Option<i32>,
    pub restart_lsn: Option<String>,
    pub confirmed_flush_lsn: Option<String>,
    pub wal_retained_bytes: Option<i64>,
    pub database: Option<String>,
    pub plugin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicationSnapshot {
    pub captured_at_ms: i64,
    pub primary_lsn: String,
    pub replicas: Vec<ReplicaRow>,
    pub slots: Vec<SlotRow>,
    pub wal_retained_total_bytes: i64,
    pub max_replay_lag_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetch_warning: Option<String>,
    pub is_in_recovery: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatroniNode {
    pub name: String,
    pub role: String,
    pub state: String,
    pub lag: Option<i64>,
    pub timeline: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatroniCluster {
    pub scope: String,
    pub nodes: Vec<PatroniNode>,
    pub failover_possible: bool,
}

fn permission_like_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("permission denied")
        || m.contains("must be superuser")
        || m.contains("insufficient_privilege")
        || m.contains("must be a member")
        || m.contains("pg_monitor")
}

fn wal_diff_missing_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("pg_wal_lsn_diff")
        || m.contains("function pg_wal_lsn_diff")
        || m.contains("does not exist")
}

pub async fn fetch_replication_snapshot(pool: &Pool) -> Result<ReplicationSnapshot, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;

    let is_in_recovery: bool = client
        .query_one("SELECT pg_is_in_recovery() AS v", &[])
        .await
        .map_err(|e| e.to_string())?
        .get("v");

    let primary_lsn: String = client
        .query_one(
            "SELECT pg_current_wal_lsn()::text AS lsn",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?
        .get::<_, Option<String>>("lsn")
        .unwrap_or_else(|| "0/0".to_string());

    let mut fetch_warning: Option<String> = None;

    let replicas: Vec<ReplicaRow> = match client
        .query(
            "SELECT
      pid, COALESCE(usename::text, '') AS usename, COALESCE(application_name::text, '') AS application_name,
      client_addr::text, client_port,
      state::text, sent_lsn::text, write_lsn::text,
      flush_lsn::text, replay_lsn::text,
      (EXTRACT(EPOCH FROM write_lag)::bigint * 1000)  AS write_lag_ms,
      (EXTRACT(EPOCH FROM flush_lag)::bigint * 1000)  AS flush_lag_ms,
      (EXTRACT(EPOCH FROM replay_lag)::bigint * 1000) AS replay_lag_ms,
      sync_state::text, sync_priority
    FROM pg_stat_replication
    ORDER BY application_name",
            &[],
        )
        .await
    {
        Ok(rows) => rows
            .iter()
            .map(|row| ReplicaRow {
                pid: row.get("pid"),
                usename: row.get("usename"),
                application_name: row.get("application_name"),
                client_addr: row.try_get("client_addr").ok().flatten(),
                client_port: row.try_get("client_port").ok().flatten(),
                state: row
                    .try_get::<_, Option<String>>("state")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                sent_lsn: row.try_get("sent_lsn").ok().flatten(),
                write_lsn: row.try_get("write_lsn").ok().flatten(),
                flush_lsn: row.try_get("flush_lsn").ok().flatten(),
                replay_lsn: row.try_get("replay_lsn").ok().flatten(),
                write_lag_ms: row.try_get("write_lag_ms").ok().flatten(),
                flush_lag_ms: row.try_get("flush_lag_ms").ok().flatten(),
                replay_lag_ms: row.try_get("replay_lag_ms").ok().flatten(),
                sync_state: row
                    .try_get::<_, Option<String>>("sync_state")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                sync_priority: row.try_get("sync_priority").unwrap_or(0),
            })
            .collect(),
        Err(e) => {
            let msg = e.to_string();
            if permission_like_error(&msg) {
                fetch_warning = Some(format!(
                    "Could not read pg_stat_replication (permission denied). Grant pg_monitor or use a superuser. Details: {}",
                    msg
                ));
                vec![]
            } else {
                return Err(msg);
            }
        }
    };

    let slots_sql_full = "SELECT
      slot_name, slot_type::text, active, active_pid,
      restart_lsn::text, confirmed_flush_lsn::text,
      pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS wal_retained_bytes,
      database::text, plugin::text
    FROM pg_replication_slots
    ORDER BY slot_name";

    let slots_sql_fallback = "SELECT
      slot_name, slot_type::text, active, active_pid,
      restart_lsn::text, confirmed_flush_lsn::text,
      database::text, plugin::text
    FROM pg_replication_slots
    ORDER BY slot_name";

    let slots: Vec<SlotRow> = match client.query(slots_sql_full, &[]).await {
        Ok(rows) => rows
            .iter()
            .map(|row| SlotRow {
                slot_name: row.get("slot_name"),
                slot_type: row
                    .try_get::<_, Option<String>>("slot_type")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                active: row.get("active"),
                active_pid: row.try_get("active_pid").ok().flatten(),
                restart_lsn: row.try_get("restart_lsn").ok().flatten(),
                confirmed_flush_lsn: row.try_get("confirmed_flush_lsn").ok().flatten(),
                wal_retained_bytes: row.try_get("wal_retained_bytes").ok().flatten(),
                database: row.try_get("database").ok().flatten(),
                plugin: row.try_get("plugin").ok().flatten(),
            })
            .collect(),
        Err(e) => {
            let msg = e.to_string();
            if permission_like_error(&msg) {
                let slot_msg = format!(
                    "Could not read pg_replication_slots (permission denied). Grant pg_monitor or use a superuser. Details: {}",
                    msg
                );
                fetch_warning = match fetch_warning {
                    None => Some(slot_msg),
                    Some(prev) => Some(format!("{}; also {}", prev, slot_msg)),
                };
                vec![]
            } else if wal_diff_missing_error(&msg) {
                let w = format!(
                    "WAL retained size per slot unavailable (pg_wal_lsn_diff not usable on this server). Details: {}",
                    msg
                );
                fetch_warning = match fetch_warning {
                    Some(prev) => Some(format!("{} {}", prev, w)),
                    None => Some(w),
                };
                client
                    .query(slots_sql_fallback, &[])
                    .await
                    .map_err(|e2| e2.to_string())?
                    .iter()
                    .map(|row| SlotRow {
                        slot_name: row.get("slot_name"),
                        slot_type: row
                            .try_get::<_, Option<String>>("slot_type")
                            .ok()
                            .flatten()
                            .unwrap_or_default(),
                        active: row.get("active"),
                        active_pid: row.try_get("active_pid").ok().flatten(),
                        restart_lsn: row.try_get("restart_lsn").ok().flatten(),
                        confirmed_flush_lsn: row.try_get("confirmed_flush_lsn").ok().flatten(),
                        wal_retained_bytes: None,
                        database: row.try_get("database").ok().flatten(),
                        plugin: row.try_get("plugin").ok().flatten(),
                    })
                    .collect()
            } else {
                return Err(msg);
            }
        }
    };

    let wal_retained_total_bytes: i64 = slots
        .iter()
        .map(|s| s.wal_retained_bytes.unwrap_or(0))
        .sum();

    let max_replay_lag_ms: Option<i64> = replicas
        .iter()
        .filter_map(|r| r.replay_lag_ms)
        .max();

    Ok(ReplicationSnapshot {
        captured_at_ms: chrono::Utc::now().timestamp_millis(),
        primary_lsn,
        replicas,
        slots,
        wal_retained_total_bytes,
        max_replay_lag_ms,
        fetch_warning,
        is_in_recovery,
    })
}

#[derive(Debug, Deserialize)]
struct PatroniMemberRaw {
    name: Option<String>,
    role: Option<String>,
    state: Option<String>,
    #[serde(default)]
    lag_in_mb: Option<f64>,
    #[serde(default)]
    lag: Option<serde_json::Value>,
    timeline: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct PatroniClusterRaw {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    members: Vec<PatroniMemberRaw>,
}

fn lag_bytes_from_member(m: &PatroniMemberRaw) -> Option<i64> {
    if let Some(mb) = m.lag_in_mb {
        return Some((mb * 1_048_576.0) as i64);
    }
    if let Some(ref v) = m.lag {
        if let Some(n) = v.as_f64() {
            return Some(n as i64);
        }
        if let Some(n) = v.as_i64() {
            return Some(n);
        }
        if let Some(n) = v.as_u64() {
            return Some(n as i64);
        }
    }
    None
}

pub async fn fetch_patroni_cluster(patroni_url: &str) -> Result<PatroniCluster, String> {
    let base = patroni_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Patroni URL is empty".to_string());
    }
    let url = format!("{}/cluster", base);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "Patroni HTTP {}: {}",
            resp.status().as_u16(),
            resp.text().await.unwrap_or_default()
        ));
    }

    let raw: PatroniClusterRaw = resp.json().await.map_err(|e| e.to_string())?;

    let scope = raw.scope.unwrap_or_default();
    let mut nodes: Vec<PatroniNode> = Vec::new();
    for m in raw.members {
        let lag = lag_bytes_from_member(&m);
        let name = m.name.unwrap_or_default();
        let role = m.role.unwrap_or_default();
        let state = m.state.unwrap_or_default();
        nodes.push(PatroniNode {
            name,
            role,
            state,
            lag,
            timeline: m.timeline,
        });
    }

    let failover_possible = nodes.iter().any(|n| {
        n.role == "replica"
            && n.state == "running"
            && n.lag.map(|l| l < 1_000_000).unwrap_or(false)
    });

    Ok(PatroniCluster {
        scope,
        nodes,
        failover_possible,
    })
}

// ─── Logical publication + physical standby helpers ─────────────────────────

const PG_VER_TABLES_IN_SCHEMA: u32 = 150_000;

/// Strict SQL identifier for publication/schema names (ASCII alnum + underscore).
fn validate_sql_identifier(label: &str, raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    let ok = raw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok {
        return Err(format!(
            "{label} may contain only letters, numbers, and underscores"
        ));
    }
    Ok(())
}

fn quote_ident(raw: &str) -> Result<String, String> {
    validate_sql_identifier("Name", raw)?;
    Ok(format!(
        "\"{}\"",
        raw.replace('\\', "").replace('"', "\"\"")
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationRow {
    pub name: String,
    pub all_tables: bool,
    pub pub_insert: bool,
    pub pub_update: bool,
    pub pub_delete: bool,
    pub pub_truncate: bool,
}

pub async fn list_publications(pool: &Pool) -> Result<Vec<PublicationRow>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let rows = client
        .query(
            "SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
             FROM pg_publication
             ORDER BY pubname",
            &[],
        )
        .await
        .map_err(|e| format_pg_error(&e))?;
    Ok(rows
        .iter()
        .map(|row| PublicationRow {
            name: row.get::<_, String>("pubname"),
            all_tables: row.get("puballtables"),
            pub_insert: row.get("pubinsert"),
            pub_update: row.get("pubupdate"),
            pub_delete: row.get("pubdelete"),
            pub_truncate: row.get("pubtruncate"),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePublicationRequest {
    pub name: String,
    /// `allTables` or `schemas`
    pub mode: String,
    #[serde(default)]
    pub schemas: Vec<String>,
}

pub async fn create_logical_publication(
    pool: &Pool,
    pg_version: u32,
    req: CreatePublicationRequest,
) -> Result<String, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let in_recovery: bool = client
        .query_one("SELECT pg_is_in_recovery() AS ir", &[])
        .await
        .map_err(|e| format_pg_error(&e))?
        .get("ir");
    if in_recovery {
        return Err(
            "Logical publications must be created on the primary writer, not a standby.".into(),
        );
    }

    validate_sql_identifier("Publication name", &req.name)?;
    let pub_q = quote_ident(&req.name)?;
    let name_for_param = req.name.trim();

    let exists: bool = client
        .query_one(
            "SELECT EXISTS(SELECT 1 FROM pg_publication WHERE pubname = $1) AS e",
            &[&name_for_param],
        )
        .await
        .map_err(|e| format_pg_error(&e))?
        .get("e");
    if exists {
        return Err(format!(
            "Publication \"{name_for_param}\" already exists. Choose a different name or run DROP PUBLICATION first."
        ));
    }

    let sql = match req.mode.as_str() {
        "allTables" => format!("CREATE PUBLICATION {pub_q} FOR ALL TABLES"),
        "schemas" => {
            if pg_version < PG_VER_TABLES_IN_SCHEMA {
                return Err(format!(
                    "FOR TABLES IN SCHEMA requires PostgreSQL 15+ (this server reports server_version_num={pg_version})."
                ));
            }
            if req.schemas.is_empty() {
                return Err("Select at least one schema.".into());
            }
            for s in &req.schemas {
                validate_sql_identifier("Schema", s)?;
                let found: bool = client
                    .query_one(
                        "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1) AS e",
                        &[s],
                    )
                    .await
                    .map_err(|e| format_pg_error(&e))?
                    .get("e");
                if !found {
                    return Err(format!("Schema \"{s}\" does not exist on this server."));
                }
            }
            let mut parts = Vec::with_capacity(req.schemas.len());
            for s in &req.schemas {
                parts.push(quote_ident(s)?);
            }
            format!(
                "CREATE PUBLICATION {pub_q} FOR TABLES IN SCHEMA {}",
                parts.join(", ")
            )
        }
        _ => return Err("mode must be \"allTables\" or \"schemas\".".into()),
    };

    client
        .execute(sql.as_str(), &[])
        .await
        .map_err(|e| format_pg_error(&e))?;
    Ok(sql)
}

fn escape_conninfo_value(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "''")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandbyReplicationPlan {
    /// Ready-to-paste `primary_conninfo` for `postgresql.auto.conf` (password placeholder).
    pub primary_conninfo_line: String,
    /// Example `pg_basebackup` using the same host/port/user as the GUI connection.
    pub pg_basebackup_example: String,
    /// After base backup, PostgreSQL 12+ uses `standby.signal`; included as a reminder.
    pub standby_signal_note: String,
    pub hints: Vec<String>,
}

/// Build standby snippets from a libpq connection string (password never echoed).
pub fn build_standby_replication_plan(connection_string: &str) -> Result<StandbyReplicationPlan, String> {
    let cfg: tokio_postgres::Config = connection_string
        .parse()
        .map_err(|e| format!("Invalid connection string: {e}"))?;

    let host = match cfg.get_hosts().first() {
        Some(tokio_postgres::config::Host::Tcp(h)) => h.clone(),
        Some(tokio_postgres::config::Host::Unix(p)) => p.to_string_lossy().into_owned(),
        None => return Err("Connection string has no host.".into()),
    };

    let port = cfg.get_ports().first().copied().unwrap_or(5432);
    let user = cfg.get_user().unwrap_or("postgres");
    let dbname = cfg.get_dbname().unwrap_or("postgres");

    let h = escape_conninfo_value(&host);
    let u = escape_conninfo_value(user);
    let d = escape_conninfo_value(dbname);

    let primary_conninfo_line = format!(
        "primary_conninfo = 'host={h} port={port} user={u} password=CHANGE_ME dbname={d} application_name=pgstudio_replica sslmode=prefer'"
    );

    let pg_basebackup_example = format!(
        "pg_basebackup -h {host} -p {port} -U {user} -D ./pg_replica_data -Fp -Xs -P -R -C -S pgstudio_replica_slot",
    );

    let hints = vec![
        "Use a role with the REPLICATION attribute (not necessarily your GUI superuser).".into(),
        "Set wal_level = replica (or logical) on the primary and ensure pg_hba.conf allows replication connections.".into(),
        "Replace CHANGE_ME with the replication password; prefer a dedicated replicator user.".into(),
        "Run pg_basebackup on the machine that will host the replica data directory.".into(),
        "-R writes standby.signal (PG12+) and primary_conninfo into postgresql.auto.conf.".into(),
        "-C -S creates a permanent replication slot named pgstudio_replica_slot (optional; omit if you manage slots yourself).".into(),
    ];

    Ok(StandbyReplicationPlan {
        primary_conninfo_line,
        pg_basebackup_example,
        standby_signal_note: "Ensure standby.signal exists in the data directory (pg_basebackup -R creates it on PostgreSQL 12+).".into(),
        hints,
    })
}
