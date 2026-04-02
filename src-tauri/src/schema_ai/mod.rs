//! Groq-backed AI streaming for the schema designer (keychain + SSE).

mod cancel;
mod groq_stream;
mod key;
mod pipeline;
mod prompt;
mod retry;

pub use groq_stream::AiStreamRequest;

use tauri::AppHandle;
use uuid::Uuid;

#[tauri::command]
pub async fn schema_designer_groq_set_api_key(api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty".into());
    }
    key::store_groq_api_key(&api_key)
}

#[tauri::command]
pub async fn schema_designer_groq_delete_api_key() -> Result<(), String> {
    key::delete_groq_api_key()
}

#[tauri::command]
pub async fn schema_designer_groq_has_api_key() -> Result<bool, String> {
    Ok(
        key::read_groq_api_key().is_some()
            || key::read_gemini_api_key().is_some()
            || (key::read_cloudflare_auth_token().is_some()
                && key::read_cloudflare_account_id().is_some()),
    )
}

/// Starts a Groq chat completion stream; tokens arrive on `schema-designer-ai-token`, finish on `schema-designer-ai-done`.
#[tauri::command]
pub async fn schema_designer_ai_stream_start(
    app: AppHandle,
    mut request: AiStreamRequest,
) -> Result<String, String> {
    let request_id = request
        .request_id
        .take()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let cancel_flag = cancel::register_cancel(&request_id);
    let app_clone = app.clone();
    let rid = request_id.clone();
    request.request_id = Some(request_id.clone());

    tauri::async_runtime::spawn(async move {
        groq_stream::run_groq_stream(app_clone, rid.clone(), cancel_flag, request).await;
        cancel::unregister_cancel(&rid);
    });

    Ok(request_id)
}

#[tauri::command]
pub async fn schema_designer_ai_stream_cancel(request_id: String) -> Result<(), String> {
    cancel::cancel_request(&request_id);
    Ok(())
}

#[tauri::command]
pub async fn schema_designer_ai_pipeline_start(
    app: AppHandle,
    mut request: AiStreamRequest,
) -> Result<String, String> {
    let request_id = request
        .request_id
        .take()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let cancel_flag = cancel::register_cancel(&request_id);
    let rid = request_id.clone();
    request.request_id = Some(request_id.clone());
    tauri::async_runtime::spawn(async move {
        pipeline::run_agentic_pipeline(app, rid.clone(), cancel_flag, request).await;
        cancel::unregister_cancel(&rid);
    });
    Ok(request_id)
}
