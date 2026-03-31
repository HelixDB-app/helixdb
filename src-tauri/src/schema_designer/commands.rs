use tauri::{AppHandle, Manager, Window};

use super::groq;
use super::keyring;
use super::models::{
    ApiKeyRecord, ConversationMessage, GenerationOptions, SchemaDesignerProject,
    SchemaProjectSummary,
};
use super::storage;

#[tauri::command]
pub async fn schema_designer_v2_list_projects(
    app: AppHandle,
) -> Result<Vec<SchemaProjectSummary>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::list_projects(Some(app_data_dir))
}

#[tauri::command]
pub async fn schema_designer_v2_search_projects(
    app: AppHandle,
    query: String,
) -> Result<Vec<SchemaProjectSummary>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::search_projects(Some(app_data_dir), &query)
}

#[tauri::command]
pub async fn schema_designer_v2_get_project(
    app: AppHandle,
    project_id: String,
) -> Result<Option<SchemaDesignerProject>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::get_project(Some(app_data_dir), &project_id)
}

#[tauri::command]
pub async fn schema_designer_v2_upsert_project(
    app: AppHandle,
    project: SchemaDesignerProject,
) -> Result<SchemaDesignerProject, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::upsert_project(Some(app_data_dir), project)
}

#[tauri::command]
pub async fn schema_designer_v2_delete_project(
    app: AppHandle,
    project_id: String,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::delete_project(Some(app_data_dir), &project_id)
}

#[tauri::command]
pub async fn schema_designer_v2_list_api_keys(app: AppHandle) -> Result<Vec<ApiKeyRecord>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    keyring::list_api_keys(Some(app_data_dir))
}

#[tauri::command]
pub async fn schema_designer_v2_store_api_key(
    app: AppHandle,
    label: String,
    value: String,
    make_default: bool,
) -> Result<Vec<ApiKeyRecord>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    keyring::store_api_key(Some(app_data_dir), label, value, make_default)
}

#[tauri::command]
pub async fn schema_designer_v2_delete_api_key(
    app: AppHandle,
    api_key_id: String,
) -> Result<Vec<ApiKeyRecord>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    keyring::delete_api_key(Some(app_data_dir), &api_key_id)
}

#[tauri::command]
pub async fn schema_designer_v2_stream_generate(
    window: Window,
    app: AppHandle,
    request_id: String,
    prompt: String,
    model: String,
    options: GenerationOptions,
    conversation_history: Vec<ConversationMessage>,
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    groq::stream_schema_generation(
        &window,
        Some(app_data_dir),
        request_id,
        prompt,
        model,
        options,
        conversation_history,
    )
    .await
}
