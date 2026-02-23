//! Persist SQL query notes in app data directory.
//! Stored as JSON; mirrors the connections_storage pattern.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const NOTES_FILE: &str = "notes.json";
const SUBDIR: &str = "pgstudio";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryNote {
    pub id: String,
    pub title: String,
    pub sql: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct NotesFile {
    notes: Vec<QueryNote>,
}

fn notes_path(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let base = app_data_dir.ok_or("App data directory not available")?;
    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(dir.join(NOTES_FILE))
}

fn load_raw(path: &PathBuf) -> Result<NotesFile, String> {
    let data = fs::read_to_string(path).unwrap_or_else(|_| "{\"notes\":[]}".to_string());
    Ok(serde_json::from_str(&data).unwrap_or_else(|_| NotesFile::default()))
}

fn save_raw(path: &PathBuf, file: &NotesFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    fs::write(path, json).map_err(|e| format!("Failed to write notes: {}", e))?;
    Ok(())
}

/// Load all saved notes from disk, sorted by updated_at descending (newest first).
pub fn load_all(app_data_dir: Option<PathBuf>) -> Result<Vec<QueryNote>, String> {
    let path = notes_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(file.notes)
}

/// Save a single note (create or update by id). Returns updated list.
pub fn save_note(
    app_data_dir: Option<PathBuf>,
    note: QueryNote,
) -> Result<Vec<QueryNote>, String> {
    let path = notes_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    if let Some(existing) = file.notes.iter_mut().find(|n| n.id == note.id) {
        existing.title = note.title;
        existing.sql = note.sql;
        existing.updated_at = note.updated_at;
        existing.tags = note.tags;
    } else {
        file.notes.push(note);
    }
    file.notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    save_raw(&path, &file)?;
    Ok(file.notes)
}

/// Delete a note by id. Returns updated list.
pub fn delete_note(
    app_data_dir: Option<PathBuf>,
    id: &str,
) -> Result<Vec<QueryNote>, String> {
    let path = notes_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.notes.retain(|n| n.id != id);
    save_raw(&path, &file)?;
    Ok(file.notes)
}

/// Search notes by query string (case-insensitive substring match on title and sql).
pub fn search_notes(
    app_data_dir: Option<PathBuf>,
    query: &str,
) -> Result<Vec<QueryNote>, String> {
    let path = notes_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    let q = query.to_lowercase();
    file.notes.retain(|n| {
        n.title.to_lowercase().contains(&q) || n.sql.to_lowercase().contains(&q)
    });
    file.notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(file.notes)
}
