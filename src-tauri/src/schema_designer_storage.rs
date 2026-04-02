//! Persist AI Schema Designer projects in app data directory.
//! Stored as JSON; mirrors the connections_storage / notes_storage pattern.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const PROJECTS_FILE: &str = "schema_designer_projects.json";
const SUBDIR: &str = "pgstudio";

// ── Data Structures ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyRef {
    pub target_table_id: String,
    pub target_column_id: String,
    #[serde(default)]
    pub on_delete: Option<String>,
    #[serde(default)]
    pub on_update: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaColumn {
    pub id: String,
    pub name: String,
    pub data_type: String,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub foreign_key: Option<ForeignKeyRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaIndex {
    pub id: String,
    pub name: String,
    pub columns: Vec<String>,
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub method: String, // btree, hash, gin, gist
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaFunction {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub returns: String,
    #[serde(default)]
    pub definition: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaExtension {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaCronJob {
    pub id: String,
    pub name: String,
    pub schedule: String,
    pub command: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaDocumentation {
    pub overview: String,
    #[serde(default)]
    pub capacity_estimate: Option<String>,
    #[serde(default)]
    pub design_rationale: Option<String>,
    #[serde(default)]
    pub migration_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaTrigger {
    pub id: String,
    pub name: String,
    pub table_id: String,
    pub function_name: String,
    #[serde(default)]
    pub timing: String,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasItem {
    pub id: String,
    pub kind: String, // note | image
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub schedule: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaTable {
    pub id: String,
    pub name: String,
    pub columns: Vec<SchemaColumn>,
    #[serde(default)]
    pub indexes: Vec<SchemaIndex>,
    #[serde(default)]
    pub position: Option<TablePosition>,
    #[serde(default)]
    pub hex_color: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaSnapshot {
    pub id: String,
    pub label: String,
    pub timestamp: String,
    pub tables: Vec<SchemaTable>,
    #[serde(default)]
    pub conversation_turn_id: Option<String>,
}

/// Image payload for schema designer chat (raw base64, no `data:` prefix).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaMessageAttachment {
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaDesignerMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub attachments: Option<Vec<SchemaMessageAttachment>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub app_type: String,
    #[serde(default)]
    pub description: String,
    pub tables: Vec<SchemaTable>,
    #[serde(default)]
    pub version_history: Vec<SchemaSnapshot>,
    #[serde(default)]
    pub functions: Vec<SchemaFunction>,
    #[serde(default)]
    pub triggers: Vec<SchemaTrigger>,
    #[serde(default)]
    pub extensions: Vec<SchemaExtension>,
    #[serde(default)]
    pub cron_jobs: Vec<SchemaCronJob>,
    #[serde(default)]
    pub documentation: Option<SchemaDocumentation>,
    #[serde(default)]
    pub canvas_items: Vec<CanvasItem>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub code: String,
    /// Sidebar / card accent (hex).
    #[serde(default)]
    pub thumbnail_color: Option<String>,
    /// Chat history for AI schema designer.
    #[serde(default)]
    pub messages: Vec<SchemaDesignerMessage>,
    /// Last streamed markdown (sections after JSON).
    #[serde(default)]
    pub ai_panel_markdown: Option<String>,
    #[serde(default)]
    pub last_model_id: Option<String>,
    #[serde(default)]
    pub last_generation_options_json: Option<String>,
    /// ReactFlow viewport: JSON `{ x, y, zoom }`.
    #[serde(default)]
    pub canvas_state_json: Option<String>,
}

// ── File Persistence ─────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProjectsFile {
    projects: Vec<SchemaProject>,
}

fn projects_path(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let base = app_data_dir.ok_or("App data directory not available")?;
    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(dir.join(PROJECTS_FILE))
}

fn load_raw(path: &PathBuf) -> Result<ProjectsFile, String> {
    let data = fs::read_to_string(path).unwrap_or_else(|_| "{\"projects\":[]}".to_string());
    Ok(serde_json::from_str(&data).unwrap_or_else(|_| ProjectsFile::default()))
}

fn save_raw(path: &PathBuf, file: &ProjectsFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    fs::write(path, json).map_err(|e| format!("Failed to write projects: {}", e))?;
    Ok(())
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Load all projects (sorted by updated_at descending).
pub fn load_all(app_data_dir: Option<PathBuf>) -> Result<Vec<SchemaProject>, String> {
    let path = projects_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.projects
        .sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(file.projects)
}

/// Get a single project by ID.
pub fn get_project(
    app_data_dir: Option<PathBuf>,
    id: &str,
) -> Result<Option<SchemaProject>, String> {
    let path = projects_path(app_data_dir)?;
    let file = load_raw(&path)?;
    Ok(file.projects.into_iter().find(|p| p.id == id))
}

/// Save a project (create or update by id). Returns updated list.
pub fn save_project(
    app_data_dir: Option<PathBuf>,
    project: SchemaProject,
) -> Result<Vec<SchemaProject>, String> {
    let path = projects_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    if let Some(existing) = file.projects.iter_mut().find(|p| p.id == project.id) {
        existing.name = project.name;
        existing.app_type = project.app_type;
        existing.description = project.description;
        existing.tables = project.tables;
        existing.version_history = project.version_history;
        existing.functions = project.functions;
        existing.triggers = project.triggers;
        existing.extensions = project.extensions;
        existing.cron_jobs = project.cron_jobs;
        existing.documentation = project.documentation;
        existing.canvas_items = project.canvas_items;
        existing.code = project.code;
        existing.updated_at = project.updated_at;
        existing.thumbnail_color = project.thumbnail_color;
        existing.messages = project.messages;
        existing.ai_panel_markdown = project.ai_panel_markdown;
        existing.last_model_id = project.last_model_id;
        existing.last_generation_options_json = project.last_generation_options_json;
        existing.canvas_state_json = project.canvas_state_json;
    } else {
        file.projects.push(project);
    }
    file.projects
        .sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    save_raw(&path, &file)?;
    Ok(file.projects)
}

/// Delete a project by id. Returns updated list.
pub fn delete_project(
    app_data_dir: Option<PathBuf>,
    id: &str,
) -> Result<Vec<SchemaProject>, String> {
    let path = projects_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.projects.retain(|p| p.id != id);
    save_raw(&path, &file)?;
    Ok(file.projects)
}
