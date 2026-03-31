use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use super::models::{SchemaDesignerProject, SchemaProjectSummary};

const SUBDIR: &str = "pgstudio/schema_designer_v2";
const PROJECTS_FILE: &str = "projects.json";

static STORAGE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProjectsFile {
    projects: Vec<SchemaDesignerProject>,
}

fn schema_designer_dir(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let base = app_data_dir.ok_or("App data directory not available")?;
    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create schema designer dir: {e}"))?;
    Ok(dir)
}

fn projects_path(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    Ok(schema_designer_dir(app_data_dir)?.join(PROJECTS_FILE))
}

fn load_raw(path: &PathBuf) -> Result<ProjectsFile, String> {
    if !path.exists() {
        return Ok(ProjectsFile::default());
    }

    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read schema designer projects: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse schema designer projects: {e}"))
}

fn save_raw(path: &PathBuf, file: &ProjectsFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| format!("Failed to serialize schema designer projects: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Failed to write schema designer projects: {e}"))
}

fn sort_projects(projects: &mut [SchemaDesignerProject]) {
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
}

fn searchable_text(project: &SchemaDesignerProject) -> String {
    let mut chunks = vec![
        project.name.as_str(),
        project.description.as_str(),
        project.prompt.as_str(),
    ]
    .join(" ");

    if !project.conversation.is_empty() {
        chunks.push(' ');
        chunks.push_str(
            &project
                .conversation
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        );
    }

    if let Ok(schema_json) = serde_json::to_string(&project.schema) {
        chunks.push(' ');
        chunks.push_str(&schema_json);
    }

    chunks.to_lowercase()
}

pub fn list_projects(app_data_dir: Option<PathBuf>) -> Result<Vec<SchemaProjectSummary>, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = projects_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    sort_projects(&mut file.projects);
    Ok(file
        .projects
        .iter()
        .map(SchemaProjectSummary::from)
        .collect())
}

pub fn search_projects(
    app_data_dir: Option<PathBuf>,
    query: &str,
) -> Result<Vec<SchemaProjectSummary>, String> {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return list_projects(app_data_dir);
    }

    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = projects_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    sort_projects(&mut file.projects);

    Ok(file
        .projects
        .iter()
        .filter(|project| searchable_text(project).contains(&normalized))
        .map(SchemaProjectSummary::from)
        .collect())
}

pub fn get_project(
    app_data_dir: Option<PathBuf>,
    project_id: &str,
) -> Result<Option<SchemaDesignerProject>, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = projects_path(app_data_dir)?;
    let file = load_raw(&path)?;
    Ok(file
        .projects
        .into_iter()
        .find(|project| project.id == project_id))
}

pub fn upsert_project(
    app_data_dir: Option<PathBuf>,
    mut project: SchemaDesignerProject,
) -> Result<SchemaDesignerProject, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = projects_path(app_data_dir)?;
    let mut file = load_raw(&path)?;

    if let Some(existing) = file.projects.iter().find(|entry| entry.id == project.id) {
        if project.created_at.trim().is_empty() {
            project.created_at = existing.created_at.clone();
        }
    }

    file.projects.retain(|entry| entry.id != project.id);
    file.projects.push(project.clone());
    sort_projects(&mut file.projects);
    save_raw(&path, &file)?;

    Ok(project)
}

pub fn delete_project(app_data_dir: Option<PathBuf>, project_id: &str) -> Result<(), String> {
    let _guard = STORAGE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = projects_path(app_data_dir)?;
    let mut file = load_raw(&path)?;
    file.projects.retain(|project| project.id != project_id);
    save_raw(&path, &file)
}
