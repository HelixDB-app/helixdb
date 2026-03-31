use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

use super::models::{ApiKeyMeta, ApiKeyRecord, StoredApiKey};

const SUBDIR: &str = "pgstudio/schema_designer_v2";
const API_KEYS_FILE: &str = "api_keys.json";
const KEYRING_SERVICE: &str = "pgstudio.schema-designer";

static KEYRING_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Default, Serialize, Deserialize)]
struct ApiKeysFile {
    keys: Vec<ApiKeyMeta>,
}

fn schema_designer_dir(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let base = app_data_dir.ok_or("App data directory not available")?;
    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create schema designer dir: {e}"))?;
    Ok(dir)
}

fn api_keys_path(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    Ok(schema_designer_dir(app_data_dir)?.join(API_KEYS_FILE))
}

fn keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| format!("Keyring error: {e}"))
}

fn read_secret(id: &str) -> Result<Option<String>, String> {
    let entry = keyring_entry(id)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("Failed to read API key from keyring: {err}")),
    }
}

fn write_secret(id: &str, value: &str) -> Result<(), String> {
    keyring_entry(id)?
        .set_password(value)
        .map_err(|e| format!("Failed to store API key: {e}"))
}

fn delete_secret(id: &str) -> Result<(), String> {
    match keyring_entry(id)?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("Failed to remove API key: {err}")),
    }
}

fn load_raw(path: &PathBuf) -> Result<ApiKeysFile, String> {
    if !path.exists() {
        return Ok(ApiKeysFile::default());
    }

    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read API keys: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse API keys: {e}"))
}

fn save_raw(path: &PathBuf, file: &ApiKeysFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| format!("Failed to serialize API keys: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Failed to write API keys: {e}"))
}

fn sort_meta(keys: &mut [ApiKeyMeta]) {
    keys.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
}

fn mask_secret(secret: &str) -> String {
    let trimmed = secret.trim();
    if trimmed.len() <= 4 {
        return "••••".to_string();
    }

    let visible = &trimmed[trimmed.len().saturating_sub(4)..];
    format!("•••• {visible}")
}

fn list_from_file(file: &ApiKeysFile) -> Result<Vec<ApiKeyRecord>, String> {
    let mut records = Vec::with_capacity(file.keys.len());
    for meta in &file.keys {
        let masked_value = read_secret(&meta.id)?
            .map(|secret| mask_secret(&secret))
            .unwrap_or_else(|| "Unavailable".to_string());

        records.push(ApiKeyRecord {
            id: meta.id.clone(),
            label: meta.label.clone(),
            masked_value,
            is_default: meta.is_default,
            created_at: meta.created_at.clone(),
            last_validated_at: meta.last_validated_at.clone(),
        });
    }

    Ok(records)
}

pub fn list_api_keys(app_data_dir: Option<PathBuf>) -> Result<Vec<ApiKeyRecord>, String> {
    let _guard = KEYRING_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = api_keys_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    sort_meta(&mut file.keys);
    list_from_file(&file)
}

pub fn store_api_key(
    app_data_dir: Option<PathBuf>,
    label: String,
    value: String,
    make_default: bool,
) -> Result<Vec<ApiKeyRecord>, String> {
    let trimmed_label = label.trim();
    let trimmed_value = value.trim();

    if trimmed_label.is_empty() {
        return Err("Please provide a label for the API key.".to_string());
    }
    if trimmed_value.is_empty() {
        return Err("Please provide a Groq API key value.".to_string());
    }

    let _guard = KEYRING_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = api_keys_path(app_data_dir)?;
    let mut file = load_raw(&path)?;

    if make_default || file.keys.is_empty() {
        for key in &mut file.keys {
            key.is_default = false;
        }
    }

    let meta = ApiKeyMeta {
        id: Uuid::new_v4().to_string(),
        label: trimmed_label.to_string(),
        is_default: make_default || file.keys.is_empty(),
        created_at: chrono::Utc::now().to_rfc3339(),
        last_validated_at: None,
    };

    write_secret(&meta.id, trimmed_value)?;
    file.keys.push(meta);
    sort_meta(&mut file.keys);
    save_raw(&path, &file)?;
    list_from_file(&file)
}

pub fn delete_api_key(
    app_data_dir: Option<PathBuf>,
    api_key_id: &str,
) -> Result<Vec<ApiKeyRecord>, String> {
    let _guard = KEYRING_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = api_keys_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    let was_default = file
        .keys
        .iter()
        .find(|meta| meta.id == api_key_id)
        .map(|meta| meta.is_default)
        .unwrap_or(false);

    file.keys.retain(|meta| meta.id != api_key_id);
    if was_default {
        if let Some(first) = file.keys.first_mut() {
            first.is_default = true;
        }
    }
    sort_meta(&mut file.keys);
    save_raw(&path, &file)?;
    delete_secret(api_key_id)?;
    list_from_file(&file)
}

pub fn resolve_api_key(
    app_data_dir: Option<PathBuf>,
    api_key_id: Option<&str>,
) -> Result<StoredApiKey, String> {
    let _guard = KEYRING_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = api_keys_path(app_data_dir)?;
    let file = load_raw(&path)?;

    let meta = if let Some(id) = api_key_id.filter(|value| !value.trim().is_empty()) {
        file.keys.iter().find(|meta| meta.id == id)
    } else {
        file.keys
            .iter()
            .find(|meta| meta.is_default)
            .or_else(|| file.keys.first())
    }
    .cloned()
    .ok_or("No Groq API key is configured yet.")?;

    let secret = read_secret(&meta.id)?
        .ok_or("The selected API key could not be found in the secure keychain.")?;

    Ok(StoredApiKey { meta, secret })
}

pub fn mark_key_validated(app_data_dir: Option<PathBuf>, api_key_id: &str) -> Result<(), String> {
    let _guard = KEYRING_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = api_keys_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    let validated_at = chrono::Utc::now().to_rfc3339();
    for meta in &mut file.keys {
        if meta.id == api_key_id {
            meta.last_validated_at = Some(validated_at.clone());
        }
    }
    save_raw(&path, &file)
}
