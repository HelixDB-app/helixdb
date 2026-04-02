//! Dispatch schema designer persistence: MongoDB when URI is set, else local JSON file.

use tauri::{AppHandle, Manager};

use crate::schema_designer_mongo;
use crate::schema_designer_storage::{self, SchemaProject};

pub fn mongo_enabled() -> bool {
    schema_designer_mongo::mongo_connection_uri().is_some()
}

pub async fn load_all(app: AppHandle) -> Result<Vec<SchemaProject>, String> {
    if mongo_enabled() {
        return schema_designer_mongo::load_all().await;
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    schema_designer_storage::load_all(Some(app_data_dir))
}

pub async fn get_project(app: AppHandle, id: &str) -> Result<Option<SchemaProject>, String> {
    if mongo_enabled() {
        return schema_designer_mongo::get_project(id).await;
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    schema_designer_storage::get_project(Some(app_data_dir), id)
}

pub async fn save_project(
    app: AppHandle,
    project: SchemaProject,
) -> Result<Vec<SchemaProject>, String> {
    if mongo_enabled() {
        return schema_designer_mongo::save_project(project).await;
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    schema_designer_storage::save_project(Some(app_data_dir), project)
}

pub async fn delete_project(app: AppHandle, id: &str) -> Result<Vec<SchemaProject>, String> {
    if mongo_enabled() {
        return schema_designer_mongo::delete_project(id).await;
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    schema_designer_storage::delete_project(Some(app_data_dir), id)
}
