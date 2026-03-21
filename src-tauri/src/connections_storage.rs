//! Persist saved database connections in app data directory.
//! Stored as JSON; only accessible by this application.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const CONNECTIONS_FILE: &str = "connections.json";
const SUBDIR: &str = "pgstudio";

/// SSH tunnel config for connecting via a bastion. Do not log ssh_password.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnelConfig {
    pub use_ssh_tunneling: bool,
    pub tunnel_host: String,
    #[serde(default = "default_tunnel_port")]
    pub tunnel_port: u16,
    pub username: String,
    pub authentication: String, // "password" | "identity_file"
    #[serde(default)]
    pub identity_file_path: Option<String>,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub save_ssh_password: Option<bool>,
    #[serde(default)]
    pub keep_alive_seconds: Option<u32>,
}

fn default_tunnel_port() -> u16 {
    22
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub connection_string: String,
    #[serde(default)]
    pub database_name: Option<String>,
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub criticality: Option<String>,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConnectionsFile {
    connections: Vec<SavedConnection>,
}

fn connections_path(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let base = app_data_dir.ok_or("App data directory not available")?;
    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(dir.join(CONNECTIONS_FILE))
}

fn load_raw(path: &PathBuf) -> Result<ConnectionsFile, String> {
    let data = fs::read_to_string(path).unwrap_or_else(|_| "{\"connections\":[]}".to_string());
    Ok(serde_json::from_str(&data).unwrap_or_else(|_| ConnectionsFile::default()))
}

fn save_raw(path: &PathBuf, file: &ConnectionsFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    fs::write(path, json).map_err(|e| format!("Failed to write connections: {}", e))?;
    Ok(())
}

/// Load all saved connections from disk.
pub fn load(app_data_dir: Option<PathBuf>) -> Result<Vec<SavedConnection>, String> {
    let path = connections_path(app_data_dir)?;
    let file = load_raw(&path)?;
    Ok(file.connections)
}

/// Save a single connection (create or update by id).
pub fn save(
    app_data_dir: Option<PathBuf>,
    conn: SavedConnection,
) -> Result<Vec<SavedConnection>, String> {
    let path = connections_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    if let Some(existing) = file.connections.iter_mut().find(|c| c.id == conn.id) {
        existing.name = conn.name;
        existing.connection_string = conn.connection_string;
        existing.database_name = conn.database_name.or(existing.database_name.clone());
        existing.environment = conn.environment.or(existing.environment.clone());
        existing.owner = conn.owner;
        existing.criticality = conn.criticality.or(existing.criticality.clone());
        existing.ssh_tunnel = conn.ssh_tunnel.clone();
    } else {
        file.connections.push(conn);
    }
    save_raw(&path, &file)?;
    Ok(file.connections)
}

/// Delete a connection by id.
pub fn delete(app_data_dir: Option<PathBuf>, id: &str) -> Result<Vec<SavedConnection>, String> {
    let path = connections_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.connections.retain(|c| c.id != id);
    save_raw(&path, &file)?;
    Ok(file.connections)
}

/// Update only the database_name for a connection (e.g. after first connect).
pub fn update_database_name(
    app_data_dir: Option<PathBuf>,
    id: &str,
    database_name: String,
) -> Result<Vec<SavedConnection>, String> {
    let path = connections_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    if let Some(c) = file.connections.iter_mut().find(|c| c.id == id) {
        c.database_name = Some(database_name);
    }
    save_raw(&path, &file)?;
    Ok(file.connections)
}
