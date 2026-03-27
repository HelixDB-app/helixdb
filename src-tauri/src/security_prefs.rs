//! Persisted security preferences (desktop app lock).

use serde::{Deserialize, Serialize};
use std::fs;

use crate::biometric;
use crate::git_storage::pgstudio_data_dir;

const PREFS_FILE: &str = "security_prefs.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SecurityPrefs {
    #[serde(default)]
    pub biometric_app_lock: bool,
    /// Touch ID / Windows Hello before destructive or bulk operations (drops, truncates, risky SQL, etc.).
    #[serde(default)]
    pub biometric_sensitive_operations: bool,
}

fn prefs_path() -> std::path::PathBuf {
    let dir = pgstudio_data_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join(PREFS_FILE)
}

pub fn load() -> SecurityPrefs {
    let path = prefs_path();
    let data = fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    serde_json::from_str(&data).unwrap_or_default()
}

pub fn save(prefs: &SecurityPrefs) -> Result<(), String> {
    let path = prefs_path();
    let json = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

pub fn biometric_app_lock_enabled() -> bool {
    load().biometric_app_lock
}

pub fn biometric_sensitive_operations_enabled() -> bool {
    load().biometric_sensitive_operations
}

/// Native OS biometric prompt when [`SecurityPrefs::biometric_sensitive_operations`] is enabled.
pub fn require_sensitive_biometric(reason: &str) -> Result<(), String> {
    if !load().biometric_sensitive_operations {
        return Ok(());
    }
    biometric::authenticate(reason)
}

/// Minimum PK rows in one call to treat as a bulk delete for biometric gating.
pub const SENSITIVE_BULK_DELETE_ROW_THRESHOLD: usize = 10;

/// Minimum rows in one bulk insert to require biometric when sensitive-ops is on.
pub const SENSITIVE_BULK_INSERT_ROW_THRESHOLD: usize = 50;
