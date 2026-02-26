//! Local storage for database-account security reminders.
//! Passwords are never persisted here; only optional reminder notes.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const REMINDERS_FILE: &str = "account_reminders.json";
const SUBDIR: &str = "pgstudio";
const MAX_REMINDER_LEN: usize = 240;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordReminder {
    pub id: String,
    pub username: String,
    pub reminder: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredPasswordReminder {
    pub id: String,
    pub scope: String,
    pub username: String,
    pub reminder: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ReminderFile {
    reminders: Vec<StoredPasswordReminder>,
}

fn reminders_path(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let base = app_data_dir.ok_or("App data directory not available")?;
    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }

    Ok(dir.join(REMINDERS_FILE))
}

fn load_raw(path: &PathBuf) -> Result<ReminderFile, String> {
    let data = fs::read_to_string(path).unwrap_or_else(|_| "{\"reminders\":[]}".to_string());
    Ok(serde_json::from_str(&data).unwrap_or_else(|_| ReminderFile::default()))
}

fn save_raw(path: &PathBuf, file: &ReminderFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }

    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, json).map_err(|e| format!("Failed to write reminders: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&tmp_path, path).map_err(|e| format!("Failed to persist reminders: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

fn validate_scope(scope: &str) -> Result<String, String> {
    let scoped = scope.trim();
    if scoped.is_empty() || scoped.len() > 256 {
        return Err("Invalid reminder scope".to_string());
    }
    Ok(scoped.to_string())
}

fn validate_username(username: &str) -> Result<String, String> {
    let name = username.trim();
    if name.is_empty() || name.len() > 63 {
        return Err("Username must be between 1 and 63 characters".to_string());
    }
    Ok(name.to_string())
}

fn validate_reminder(reminder: &str) -> Result<String, String> {
    let text = reminder.trim();
    if text.is_empty() {
        return Err("Reminder cannot be empty".to_string());
    }
    if text.len() > MAX_REMINDER_LEN {
        return Err(format!(
            "Reminder must be at most {} characters",
            MAX_REMINDER_LEN
        ));
    }
    Ok(text.to_string())
}

fn map_for_scope(file: &ReminderFile, scope: &str) -> Vec<PasswordReminder> {
    let mut list: Vec<PasswordReminder> = file
        .reminders
        .iter()
        .filter(|item| item.scope == scope)
        .map(|item| PasswordReminder {
            id: item.id.clone(),
            username: item.username.clone(),
            reminder: item.reminder.clone(),
            created_at: item.created_at,
            updated_at: item.updated_at,
        })
        .collect();
    list.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    list
}

pub fn list_for_scope(
    app_data_dir: Option<PathBuf>,
    scope: &str,
) -> Result<Vec<PasswordReminder>, String> {
    let scope = validate_scope(scope)?;
    let path = reminders_path(app_data_dir)?;
    let file = load_raw(&path)?;
    Ok(map_for_scope(&file, &scope))
}

pub fn upsert_for_scope(
    app_data_dir: Option<PathBuf>,
    scope: &str,
    username: &str,
    reminder: &str,
) -> Result<Vec<PasswordReminder>, String> {
    let scope = validate_scope(scope)?;
    let username = validate_username(username)?;
    let reminder = validate_reminder(reminder)?;
    let path = reminders_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    let now = chrono::Utc::now().timestamp_millis();

    if let Some(existing) = file
        .reminders
        .iter_mut()
        .find(|item| item.scope == scope && item.username == username)
    {
        existing.reminder = reminder;
        existing.updated_at = now;
    } else {
        file.reminders.push(StoredPasswordReminder {
            id: uuid::Uuid::new_v4().to_string(),
            scope: scope.clone(),
            username,
            reminder,
            created_at: now,
            updated_at: now,
        });
    }

    save_raw(&path, &file)?;
    Ok(map_for_scope(&file, &scope))
}

pub fn delete_for_scope(
    app_data_dir: Option<PathBuf>,
    scope: &str,
    id: &str,
) -> Result<Vec<PasswordReminder>, String> {
    let scope = validate_scope(scope)?;
    let path = reminders_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.reminders
        .retain(|item| !(item.scope == scope && item.id == id));
    save_raw(&path, &file)?;
    Ok(map_for_scope(&file, &scope))
}
