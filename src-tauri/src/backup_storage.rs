//! Persist backup history, schedules, and optional Google Drive settings.
//! Backup files themselves live under the backups/ directory; this module stores metadata only.

use crate::connections_storage::SshTunnelConfig;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const STATE_FILE: &str = "backup_state.json";
const SUBDIR: &str = "pgstudio";
const BACKUPS_SUBDIR: &str = "backups";
const KEYRING_SERVICE: &str = "pgstudio.backup";
const KEY_REFRESH_TOKEN: &str = "google_drive_refresh_token";
const KEY_ACCESS_TOKEN: &str = "google_drive_access_token";

static STORAGE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupScope {
    Database,
    Cluster,
}

impl BackupScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Database => "database",
            Self::Cluster => "cluster",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupRecordStatus {
    Running,
    Success,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupCloudSyncStatus {
    NotConfigured,
    Pending,
    Synced,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupArtifact {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub format: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub bytes: u64,
    #[serde(default)]
    pub database_name: Option<String>,
    #[serde(default)]
    pub google_drive_file_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRecord {
    pub id: String,
    pub name: String,
    pub scope: BackupScope,
    #[serde(default)]
    pub source_database: Option<String>,
    pub connection_label: String,
    pub connection_string: String,
    #[serde(default)]
    pub output_root: String,
    pub backup_dir: String,
    pub status: BackupRecordStatus,
    pub started_at: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub bytes_written: u64,
    #[serde(default)]
    pub estimated_bytes: Option<u64>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub triggered_by: String,
    #[serde(default)]
    pub schedule_id: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<BackupArtifact>,
    #[serde(default)]
    pub server_version: Option<String>,
    #[serde(default)]
    pub postgres_client_path: Option<String>,
    #[serde(default)]
    pub postgres_client_version: Option<String>,
    #[serde(default)]
    pub cloud_sync_status: Option<BackupCloudSyncStatus>,
    #[serde(default)]
    pub cloud_sync_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSchedule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub cron: String,
    pub scope: BackupScope,
    #[serde(default)]
    pub source_database: Option<String>,
    pub connection_label: String,
    pub connection_string: String,
    #[serde(default)]
    pub output_root: String,
    #[serde(default)]
    pub sync_to_google_drive: bool,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub next_run_at: Option<i64>,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    #[serde(default)]
    pub last_status: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BackupGoogleDriveConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub connected_email: Option<String>,
    #[serde(default)]
    pub connected_at: Option<i64>,
    #[serde(default)]
    pub access_token_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupGoogleDriveStatus {
    pub enabled: bool,
    pub configured: bool,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub connected_email: Option<String>,
    #[serde(default)]
    pub connected_at: Option<i64>,
    #[serde(default)]
    pub access_token_expires_at: Option<i64>,
    pub has_refresh_token: bool,
    pub has_access_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupGoogleDriveConfigInput {
    pub enabled: bool,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub connected_email: Option<String>,
    #[serde(default)]
    pub connected_at: Option<i64>,
    #[serde(default)]
    pub access_token_expires_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct BackupGoogleDriveRuntime {
    pub config: BackupGoogleDriveConfig,
    pub refresh_token: Option<String>,
    pub access_token: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct BackupStateFile {
    #[serde(default)]
    pub backups: Vec<BackupRecord>,
    #[serde(default)]
    pub schedules: Vec<BackupSchedule>,
    #[serde(default)]
    pub google_drive: BackupGoogleDriveConfig,
}

fn config_dir(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let base = app_data_dir.ok_or("App data directory not available")?;
    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create backup config dir: {}", e))?;
    Ok(dir)
}

fn state_path(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    Ok(config_dir(app_data_dir)?.join(STATE_FILE))
}

pub fn backup_root(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let dir = config_dir(app_data_dir)?.join(BACKUPS_SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create backup root: {}", e))?;
    Ok(dir)
}

pub fn default_output_root(app_data_dir: Option<PathBuf>) -> Result<String, String> {
    Ok(backup_root(app_data_dir)?.to_string_lossy().to_string())
}

fn trim_option(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn load_raw(path: &PathBuf) -> Result<BackupStateFile, String> {
    let raw = fs::read_to_string(path).unwrap_or_else(|_| {
        "{\"backups\":[],\"schedules\":[],\"google_drive\":{\"enabled\":false}}".to_string()
    });
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse backup state: {}", e))
}

fn sort_state(file: &mut BackupStateFile) {
    file.backups.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    file.schedules.sort_by(|a, b| {
        let a_next = a.next_run_at.unwrap_or(i64::MAX);
        let b_next = b.next_run_at.unwrap_or(i64::MAX);
        a_next
            .cmp(&b_next)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.name.cmp(&b.name))
    });
}

fn save_raw(path: &PathBuf, file: &BackupStateFile) -> Result<(), String> {
    let mut cloned = BackupStateFile {
        backups: file.backups.clone(),
        schedules: file.schedules.clone(),
        google_drive: file.google_drive.clone(),
    };
    sort_state(&mut cloned);
    let json = serde_json::to_string_pretty(&cloned).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create backup state dir: {}", e))?;
    }
    fs::write(path, json).map_err(|e| format!("Failed to write backup state: {}", e))?;
    Ok(())
}

pub fn load_state(app_data_dir: Option<PathBuf>) -> Result<BackupStateFile, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    sort_state(&mut file);
    Ok(file)
}

pub fn find_backup(
    app_data_dir: Option<PathBuf>,
    id: &str,
) -> Result<Option<BackupRecord>, String> {
    let file = load_state(app_data_dir)?;
    Ok(file.backups.into_iter().find(|record| record.id == id))
}

pub fn upsert_backup(
    app_data_dir: Option<PathBuf>,
    record: BackupRecord,
) -> Result<BackupRecord, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    if let Some(existing) = file.backups.iter_mut().find(|item| item.id == record.id) {
        *existing = record.clone();
    } else {
        file.backups.push(record.clone());
    }
    save_raw(&path, &file)?;
    Ok(record)
}

pub fn delete_backup(app_data_dir: Option<PathBuf>, id: &str) -> Result<Vec<BackupRecord>, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.backups.retain(|record| record.id != id);
    save_raw(&path, &file)?;
    sort_state(&mut file);
    Ok(file.backups)
}

pub fn upsert_schedule(
    app_data_dir: Option<PathBuf>,
    schedule: BackupSchedule,
) -> Result<Vec<BackupSchedule>, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    if let Some(existing) = file
        .schedules
        .iter_mut()
        .find(|item| item.id == schedule.id)
    {
        *existing = schedule;
    } else {
        file.schedules.push(schedule);
    }
    save_raw(&path, &file)?;
    sort_state(&mut file);
    Ok(file.schedules)
}

pub fn find_schedule(
    app_data_dir: Option<PathBuf>,
    id: &str,
) -> Result<Option<BackupSchedule>, String> {
    let file = load_state(app_data_dir)?;
    Ok(file.schedules.into_iter().find(|item| item.id == id))
}

pub fn delete_schedule(
    app_data_dir: Option<PathBuf>,
    id: &str,
) -> Result<Vec<BackupSchedule>, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.schedules.retain(|schedule| schedule.id != id);
    save_raw(&path, &file)?;
    sort_state(&mut file);
    Ok(file.schedules)
}

fn keyring_entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, user).map_err(|e| format!("Keyring error: {}", e))
}

fn get_secret(user: &str) -> Result<Option<String>, String> {
    let entry = keyring_entry(user)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("Failed to read backup secret: {}", err)),
    }
}

fn set_secret(user: &str, value: Option<&str>) -> Result<(), String> {
    let entry = keyring_entry(user)?;
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(secret) => entry
            .set_password(secret)
            .map_err(|e| format!("Failed to store backup secret: {}", e)),
        None => match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("Failed to clear backup secret: {}", err)),
        },
    }
}

fn google_drive_status_from_config(
    config: &BackupGoogleDriveConfig,
) -> Result<BackupGoogleDriveStatus, String> {
    let has_refresh_token = get_secret(KEY_REFRESH_TOKEN)?.is_some();
    let has_access_token = get_secret(KEY_ACCESS_TOKEN)?.is_some();
    let configured = trim_option(config.folder_id.clone()).is_some()
        && trim_option(config.client_id.clone()).is_some()
        && (has_refresh_token || has_access_token);

    Ok(BackupGoogleDriveStatus {
        enabled: config.enabled,
        configured,
        folder_id: config.folder_id.clone(),
        client_id: config.client_id.clone(),
        connected_email: config.connected_email.clone(),
        connected_at: config.connected_at,
        access_token_expires_at: config.access_token_expires_at,
        has_refresh_token,
        has_access_token,
    })
}

pub fn google_drive_status(
    app_data_dir: Option<PathBuf>,
) -> Result<BackupGoogleDriveStatus, String> {
    let file = load_state(app_data_dir)?;
    google_drive_status_from_config(&file.google_drive)
}

pub fn load_google_drive_runtime(
    app_data_dir: Option<PathBuf>,
) -> Result<Option<BackupGoogleDriveRuntime>, String> {
    let file = load_state(app_data_dir)?;
    let config = file.google_drive;
    if trim_option(config.folder_id.clone()).is_none()
        || trim_option(config.client_id.clone()).is_none()
    {
        return Ok(None);
    }

    Ok(Some(BackupGoogleDriveRuntime {
        config,
        refresh_token: get_secret(KEY_REFRESH_TOKEN)?,
        access_token: get_secret(KEY_ACCESS_TOKEN)?,
    }))
}

pub fn save_google_drive_config(
    app_data_dir: Option<PathBuf>,
    input: BackupGoogleDriveConfigInput,
) -> Result<BackupGoogleDriveStatus, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.google_drive.enabled = input.enabled;
    file.google_drive.folder_id = trim_option(input.folder_id);
    file.google_drive.client_id = trim_option(input.client_id);
    file.google_drive.connected_email = trim_option(input.connected_email);
    file.google_drive.connected_at = input.connected_at;
    file.google_drive.access_token_expires_at = input.access_token_expires_at;

    if input.refresh_token.is_some() {
        set_secret(KEY_REFRESH_TOKEN, input.refresh_token.as_deref())?;
    }
    if input.access_token.is_some() {
        set_secret(KEY_ACCESS_TOKEN, input.access_token.as_deref())?;
    }

    save_raw(&path, &file)?;
    google_drive_status_from_config(&file.google_drive)
}

pub fn store_google_access_token(
    app_data_dir: Option<PathBuf>,
    access_token: Option<&str>,
    expires_at: Option<i64>,
) -> Result<BackupGoogleDriveStatus, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.google_drive.access_token_expires_at = expires_at;
    set_secret(KEY_ACCESS_TOKEN, access_token)?;
    save_raw(&path, &file)?;
    google_drive_status_from_config(&file.google_drive)
}

pub fn clear_google_drive_config(
    app_data_dir: Option<PathBuf>,
) -> Result<BackupGoogleDriveStatus, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.google_drive = BackupGoogleDriveConfig::default();
    set_secret(KEY_REFRESH_TOKEN, None)?;
    set_secret(KEY_ACCESS_TOKEN, None)?;
    save_raw(&path, &file)?;
    google_drive_status_from_config(&file.google_drive)
}
