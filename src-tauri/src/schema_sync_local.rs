//! SQLite mirror of schema sync cache + outbox (desktop durability).

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
pub struct OutboxEntry {
    pub id: i64,
    pub project_id: String,
    pub payload: String,
    pub client_op_id: String,
    pub created_at: String,
}

fn db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("pgstudio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("schema_sync.sqlite"))
}

fn open_conn(app: &AppHandle) -> Result<Connection, String> {
    let p = db_path(app)?;
    let conn = Connection::open(p).map_err(|e| e.to_string())?;
    conn
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS project_cache (
                project_id TEXT PRIMARY KEY,
                json TEXT NOT NULL,
                revision INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                client_op_id TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub fn schema_sync_local_put_cache(
    app: AppHandle,
    project_id: String,
    json: String,
    revision: i64,
) -> Result<(), String> {
    let conn = open_conn(&app)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        r#"
        INSERT INTO project_cache (project_id, json, revision, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(project_id) DO UPDATE SET
            json = excluded.json,
            revision = excluded.revision,
            updated_at = excluded.updated_at
        "#,
        rusqlite::params![project_id, json, revision, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn schema_sync_local_enqueue(
    app: AppHandle,
    project_id: String,
    payload: String,
    client_op_id: String,
) -> Result<(), String> {
    let conn = open_conn(&app)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        r#"
        INSERT OR IGNORE INTO outbox (project_id, payload, client_op_id, created_at)
        VALUES (?1, ?2, ?3, ?4)
        "#,
        rusqlite::params![project_id, payload, client_op_id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn schema_sync_local_list_outbox(app: AppHandle) -> Result<Vec<OutboxEntry>, String> {
    let conn = open_conn(&app)?;
    let mut stmt = conn
        .prepare(
            r#"SELECT id, project_id, payload, client_op_id, created_at FROM outbox ORDER BY id ASC"#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(OutboxEntry {
                id: r.get(0)?,
                project_id: r.get(1)?,
                payload: r.get(2)?,
                client_op_id: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn schema_sync_local_remove_outbox_ids(app: AppHandle, ids: Vec<i64>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let conn = open_conn(&app)?;
    for id in ids {
        conn.execute("DELETE FROM outbox WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
