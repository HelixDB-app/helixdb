use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use uuid::Uuid;

const SERVICE: &str = "pgstudio";
const GITHUB_TOKEN_KEY: &str = "pgstudio_github_token";
const GIT_AUTHOR_NAME_KEY: &str = "pgstudio_git_author_name";
const GIT_AUTHOR_EMAIL_KEY: &str = "pgstudio_git_author_email";

/// Base directory for pgStudio app data (e.g. ~/Library/Application Support/pgstudio on macOS).
pub fn pgstudio_data_dir() -> PathBuf {
    let base = dirs_sys::data_dir()
        .or_else(dirs_sys::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("pgstudio")
}

fn db_path() -> PathBuf {
    pgstudio_data_dir().join("git_workspaces.db")
}

fn table_columns(conn: &Connection, table: &str) -> SqlResult<HashSet<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    let mut cols = HashSet::new();
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        cols.insert(name);
    }
    Ok(cols)
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> SqlResult<()> {
    let cols = table_columns(conn, table)?;
    if !cols.contains(column) {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn open_db() -> SqlResult<Connection> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(&path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS git_workspaces (
            id           TEXT PRIMARY KEY,
            path         TEXT NOT NULL UNIQUE,
            remote_url   TEXT,
            github_owner TEXT,
            github_repo  TEXT,
            author_name  TEXT,
            author_email TEXT,
            created_at   TEXT NOT NULL
        );",
    )?;
    ensure_column(&conn, "git_workspaces", "project_key", "TEXT")?;
    ensure_column(&conn, "git_workspaces", "host_name", "TEXT")?;
    ensure_column(&conn, "git_workspaces", "workspace_name", "TEXT")?;
    ensure_column(&conn, "git_workspaces", "connection_scope", "TEXT")?;
    ensure_column(&conn, "git_workspaces", "updated_at", "TEXT")?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_git_workspaces_project_key
           ON git_workspaces(project_key)
         WHERE project_key IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_git_workspaces_host_name
           ON git_workspaces(host_name);
         CREATE INDEX IF NOT EXISTS idx_git_workspaces_updated_at
           ON git_workspaces(updated_at DESC);
         UPDATE git_workspaces
            SET updated_at = created_at
          WHERE updated_at IS NULL;",
    )?;
    Ok(conn)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitWorkspace {
    pub id: String,
    pub path: String,
    pub remote_url: Option<String>,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    pub created_at: String,
    pub project_key: Option<String>,
    pub host_name: Option<String>,
    pub workspace_name: Option<String>,
    pub connection_scope: Option<String>,
    pub updated_at: String,
}

fn workspace_from_row(row: &Row<'_>) -> SqlResult<GitWorkspace> {
    Ok(GitWorkspace {
        id: row.get(0)?,
        path: row.get(1)?,
        remote_url: row.get(2)?,
        github_owner: row.get(3)?,
        github_repo: row.get(4)?,
        author_name: row.get(5)?,
        author_email: row.get(6)?,
        created_at: row.get(7)?,
        project_key: row.get(8)?,
        host_name: row.get(9)?,
        workspace_name: row.get(10)?,
        connection_scope: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn normalize_text(value: Option<&str>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn fetch_workspace_by_id(conn: &Connection, id: &str) -> Result<Option<GitWorkspace>, String> {
    conn.query_row(
        "SELECT
            id, path, remote_url, github_owner, github_repo, author_name, author_email, created_at,
            project_key, host_name, workspace_name, connection_scope, updated_at
         FROM git_workspaces
         WHERE id = ?1",
        params![id],
        workspace_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn save_workspace(path: &str) -> Result<GitWorkspace, String> {
    save_workspace_with_project(path, None, None, None, None)
}

pub fn save_workspace_with_project(
    path: &str,
    project_key: Option<&str>,
    host_name: Option<&str>,
    workspace_name: Option<&str>,
    connection_scope: Option<&str>,
) -> Result<GitWorkspace, String> {
    let conn = open_db().map_err(|e| e.to_string())?;
    let normalized_path = path.trim();
    if normalized_path.is_empty() {
        return Err("Workspace path must not be empty".to_string());
    }
    let now = Utc::now().to_rfc3339();
    let project_key = normalize_text(project_key);
    let host_name = normalize_text(host_name);
    let workspace_name = normalize_text(workspace_name);
    let connection_scope = normalize_text(connection_scope);

    let existing: Option<GitWorkspace> = conn
        .query_row(
            "SELECT
                id, path, remote_url, github_owner, github_repo, author_name, author_email, created_at,
                project_key, host_name, workspace_name, connection_scope, updated_at
             FROM git_workspaces
             WHERE path = ?1 OR (?2 IS NOT NULL AND project_key = ?2)
             LIMIT 1",
            params![normalized_path, project_key],
            workspace_from_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(ws) = existing {
        let merged_project_key = project_key.or(ws.project_key.clone());
        let merged_host_name = host_name.or(ws.host_name.clone());
        let merged_workspace_name = workspace_name.or(ws.workspace_name.clone());
        let merged_connection_scope = connection_scope.or(ws.connection_scope.clone());

        conn.execute(
            "UPDATE git_workspaces
                SET path = ?1,
                    project_key = ?2,
                    host_name = ?3,
                    workspace_name = ?4,
                    connection_scope = ?5,
                    updated_at = ?6
              WHERE id = ?7",
            params![
                normalized_path,
                merged_project_key,
                merged_host_name,
                merged_workspace_name,
                merged_connection_scope,
                now,
                ws.id
            ],
        )
        .map_err(|e| e.to_string())?;

        return fetch_workspace_by_id(&conn, &ws.id)?
            .ok_or_else(|| "Failed to reload workspace after update".to_string());
    }

    let ws = GitWorkspace {
        id: Uuid::new_v4().to_string(),
        path: normalized_path.to_string(),
        remote_url: None,
        github_owner: None,
        github_repo: None,
        author_name: None,
        author_email: None,
        created_at: now.clone(),
        project_key,
        host_name,
        workspace_name,
        connection_scope,
        updated_at: now,
    };

    conn.execute(
        "INSERT INTO git_workspaces (
            id, path, remote_url, github_owner, github_repo, author_name, author_email, created_at,
            project_key, host_name, workspace_name, connection_scope, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            ws.id,
            ws.path,
            ws.remote_url,
            ws.github_owner,
            ws.github_repo,
            ws.author_name,
            ws.author_email,
            ws.created_at,
            ws.project_key,
            ws.host_name,
            ws.workspace_name,
            ws.connection_scope,
            ws.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(ws)
}

pub fn list_workspaces() -> Result<Vec<GitWorkspace>, String> {
    let conn = open_db().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT
                id, path, remote_url, github_owner, github_repo, author_name, author_email, created_at,
                project_key, host_name, workspace_name, connection_scope, updated_at
             FROM git_workspaces
             ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], workspace_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<SqlResult<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn get_workspace(path: &str) -> Result<Option<GitWorkspace>, String> {
    let conn = open_db().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT
            id, path, remote_url, github_owner, github_repo, author_name, author_email, created_at,
            project_key, host_name, workspace_name, connection_scope, updated_at
         FROM git_workspaces
         WHERE path = ?1",
        params![path],
        workspace_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn get_workspace_by_project_key(project_key: &str) -> Result<Option<GitWorkspace>, String> {
    let conn = open_db().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT
            id, path, remote_url, github_owner, github_repo, author_name, author_email, created_at,
            project_key, host_name, workspace_name, connection_scope, updated_at
         FROM git_workspaces
         WHERE project_key = ?1",
        params![project_key],
        workspace_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn update_workspace_remote(
    path: &str,
    remote_url: Option<&str>,
    github_owner: Option<&str>,
    github_repo: Option<&str>,
) -> Result<(), String> {
    let conn = open_db().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE git_workspaces
            SET remote_url = ?1,
                github_owner = ?2,
                github_repo = ?3,
                updated_at = ?4
          WHERE path = ?5",
        params![remote_url, github_owner, github_repo, now, path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_workspace_author(
    path: &str,
    author_name: &str,
    author_email: &str,
) -> Result<(), String> {
    let conn = open_db().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE git_workspaces
            SET author_name = ?1,
                author_email = ?2,
                updated_at = ?3
          WHERE path = ?4",
        params![author_name, author_email, now, path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_workspace(path: &str) -> Result<(), String> {
    let conn = open_db().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM git_workspaces WHERE path = ?1", params![path])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Keyring helpers ───────────────────────────────────────────────────────────

pub fn store_github_token(token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, GITHUB_TOKEN_KEY).map_err(|e| e.to_string())?;
    entry.set_password(token).map_err(|e| e.to_string())
}

pub fn get_github_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, GITHUB_TOKEN_KEY).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete_github_token() -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, GITHUB_TOKEN_KEY).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn store_git_author(name: &str, email: &str) -> Result<(), String> {
    let name_entry =
        keyring::Entry::new(SERVICE, GIT_AUTHOR_NAME_KEY).map_err(|e| e.to_string())?;
    name_entry.set_password(name).map_err(|e| e.to_string())?;
    let email_entry =
        keyring::Entry::new(SERVICE, GIT_AUTHOR_EMAIL_KEY).map_err(|e| e.to_string())?;
    email_entry.set_password(email).map_err(|e| e.to_string())
}

pub fn get_git_author() -> Result<Option<(String, String)>, String> {
    let name_entry =
        keyring::Entry::new(SERVICE, GIT_AUTHOR_NAME_KEY).map_err(|e| e.to_string())?;
    let email_entry =
        keyring::Entry::new(SERVICE, GIT_AUTHOR_EMAIL_KEY).map_err(|e| e.to_string())?;
    match (name_entry.get_password(), email_entry.get_password()) {
        (Ok(name), Ok(email)) => Ok(Some((name, email))),
        _ => Ok(None),
    }
}

// Tauri commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn git_storage_list_workspaces() -> Result<Vec<GitWorkspace>, String> {
    list_workspaces()
}

#[tauri::command]
pub fn git_storage_save_workspace(path: String) -> Result<GitWorkspace, String> {
    save_workspace(&path)
}

#[tauri::command]
pub fn git_storage_delete_workspace(path: String) -> Result<(), String> {
    delete_workspace(&path)
}

#[tauri::command]
pub fn git_storage_update_remote(
    path: String,
    remote_url: Option<String>,
    github_owner: Option<String>,
    github_repo: Option<String>,
) -> Result<(), String> {
    update_workspace_remote(
        &path,
        remote_url.as_deref(),
        github_owner.as_deref(),
        github_repo.as_deref(),
    )
}

#[tauri::command]
pub fn git_storage_update_author(
    path: String,
    author_name: String,
    author_email: String,
) -> Result<(), String> {
    update_workspace_author(&path, &author_name, &author_email)
}

#[tauri::command]
pub fn git_storage_get_github_token() -> Result<Option<String>, String> {
    get_github_token()
}

// dirs_sys re-export so we don't need to add a separate crate ─────────────────
mod dirs_sys {
    use std::path::PathBuf;

    pub fn data_dir() -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        {
            std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join("Library").join("Application Support"))
        }
        #[cfg(target_os = "windows")]
        {
            std::env::var_os("APPDATA").map(PathBuf::from)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"))
                })
        }
    }

    pub fn home_dir() -> Option<PathBuf> {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}
