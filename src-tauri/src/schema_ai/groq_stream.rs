use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::key;
use super::prompt;
use super::retry;
use crate::schema_designer_storage::SchemaMessageAttachment;

const GROQ_CHAT_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_CHAT_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const GEMINI_GENERATE_URL_FMT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}";
const CLOUDFLARE_RESPONSES_URL_FMT: &str =
    "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/responses";
const CLOUDFLARE_RUN_URL_FMT: &str =
    "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}";

/// Allowed model id pattern for configured providers (no prompt injection via model field).
fn validate_model_id(model: &str) -> Result<(), String> {
    let m = model.trim();
    if m.len() < 3 || m.len() > 120 {
        return Err("Invalid model id length".into());
    }
    if !m
        .chars()
        .all(|c| {
            c.is_ascii_alphanumeric()
                || c == '-'
                || c == '_'
                || c == '.'
                || c == '/'
                || c == '@'
                || c == ':'
        })
    {
        return Err("Model id contains invalid characters".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Option<Vec<SchemaMessageAttachment>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamOptions {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub database_target: Option<String>,
    #[serde(default)]
    pub output_format: Option<String>,
    #[serde(default)]
    pub audit_columns: Option<bool>,
    #[serde(default)]
    pub include_indexes: Option<bool>,
    #[serde(default)]
    pub include_enums: Option<bool>,
    #[serde(default)]
    pub include_sample_data: Option<bool>,
    #[serde(default)]
    pub normalization: Option<String>,
    #[serde(default)]
    pub naming_convention: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub run_features_phase: Option<bool>,
    #[serde(default)]
    pub run_docs_phase: Option<bool>,
    #[serde(default)]
    pub run_saving_stage: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    pub messages: Vec<AiChatMessage>,
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub options: Option<AiStreamOptions>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageEvent {
    pub request_id: String,
    pub stage: String,
    pub status: String,
    pub message: Option<String>,
    pub retry_count: Option<u32>,
    pub provider: Option<String>,
}

fn default_temperature() -> f32 {
    0.4
}

fn default_max_tokens() -> u32 {
    8192
}

fn requested_provider(req: &AiStreamRequest) -> &'static str {
    let explicit = req
        .options
        .as_ref()
        .and_then(|o| o.provider.as_ref())
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if explicit == "worker" || is_worker_model(&req.model) {
        return "worker";
    }
    if explicit == "cloudflare" || req.model.trim().starts_with("@cf/") {
        return "cloudflare";
    }
    if explicit == "gemini"
        || req.model.trim().starts_with("gemini-")
        || req.model.trim().starts_with("models/gemini-")
    {
        return "gemini";
    }
    if explicit == "openrouter"
        || req.model.trim().contains(":free")
        || req.model.trim().starts_with("openrouter/")
    {
        return "openrouter";
    }
    "groq"
}

fn is_worker_model(model: &str) -> bool {
    model.trim() == "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
}

fn cloudflare_uses_run_api(model: &str) -> bool {
    matches!(
        model.trim(),
        "@cf/moonshotai/kimi-k2.5"
            | "@cf/nvidia/nemotron-3-120b-a12b"
            | "@cf/meta/llama-4-scout-17b-16e-instruct"
    )
}

fn user_context_suffix(opts: &Option<AiStreamOptions>) -> String {
    let Some(o) = opts else {
        return String::new();
    };
    let mut parts = Vec::new();
    if let Some(ref db) = o.database_target {
        parts.push(format!("Target database engine: {db}."));
    }
    if let Some(ref fm) = o.output_format {
        parts.push(format!("Output detail level: {fm}."));
    }
    if o.audit_columns == Some(true) {
        parts.push("Include created_at/updated_at and optional soft-delete columns where appropriate.".into());
    }
    if o.include_indexes == Some(true) {
        parts.push("Prefer explicit indexes for FK columns and common filters.".into());
    }
    if o.include_enums == Some(true) {
        parts.push("Use enum types for small fixed sets of values.".into());
    }
    if o.include_sample_data == Some(true) {
        parts.push("The JSON may include example row hints in column descriptions (not full seed data).".into());
    }
    if let Some(ref n) = o.normalization {
        parts.push(format!("Normalization target: {n}."));
    }
    if let Some(ref n) = o.naming_convention {
        parts.push(format!("Naming convention for tables/columns: {n}."));
    }
    if let Some(ref r) = o.reasoning_effort {
        parts.push(format!("Reasoning depth hint: {r}."));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("\n\n[User preferences]\n{}", parts.join(" "))
    }
}

/// OpenAI-compatible `content`: string or multimodal part array (images first, then text).
fn message_content_for_groq(
    m: &AiChatMessage,
    append_user_ctx: bool,
    user_ctx: &str,
) -> Value {
    let attachments: &[SchemaMessageAttachment] = m
        .attachments
        .as_deref()
        .unwrap_or_default();

    if attachments.is_empty() {
        let mut text = m.content.clone();
        if append_user_ctx {
            text.push_str(user_ctx);
        }
        return Value::String(text);
    }

    let mut parts: Vec<Value> = Vec::new();
    for att in attachments {
        let mime = att.mime_type.trim();
        let b64 = att.data_base64.trim();
        if mime.is_empty() || b64.is_empty() {
            continue;
        }
        let url = format!("data:{mime};base64,{b64}");
        parts.push(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": url }
        }));
    }

    let mut text = m.content.clone();
    if append_user_ctx {
        text.push_str(user_ctx);
    }
    if text.trim().is_empty() && !parts.is_empty() {
        text.push(' ');
    }
    parts.push(serde_json::json!({
        "type": "text",
        "text": text
    }));

    Value::Array(parts)
}

pub async fn run_groq_stream(
    app: AppHandle,
    request_id: String,
    cancel_flag: Arc<AtomicBool>,
    req: AiStreamRequest,
) {
    let stage = "schema".to_string();
    let result = run_groq_phase_with_retry(
        &app,
        &request_id,
        cancel_flag,
        &req,
        &stage,
        prompt::schema_designer_system_prompt(),
        req.messages.clone(),
        true,
    )
    .await;
    emit_done_event(&app, &request_id, result.err());
}

pub async fn run_groq_phase_with_retry(
    app: &AppHandle,
    request_id: &str,
    cancel_flag: Arc<AtomicBool>,
    req: &AiStreamRequest,
    stage: &str,
    phase_system_prompt: &str,
    messages: Vec<AiChatMessage>,
    emit_tokens: bool,
) -> Result<String, String> {
    let provider_name = requested_provider(req);
    let chain = if provider_name == "cloudflare" || provider_name == "openrouter" || provider_name == "gemini" {
        vec![req.model.clone()]
    } else {
        retry::model_chain(&req.model)
    };
    let mut last_error = "Unknown error".to_string();

    for (i, model) in chain.iter().enumerate().take(3) {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        emit_stage_event(
            app,
            request_id,
            StageEvent {
                request_id: request_id.to_string(),
                stage: stage.to_string(),
                status: "start".to_string(),
                message: Some(format!("Attempt {} with {}", i + 1, model)),
                retry_count: Some(i as u32),
                provider: Some(provider_name.to_string()),
            },
        );
        match run_groq_once(
            app,
            request_id,
            cancel_flag.clone(),
            req,
            model,
            phase_system_prompt,
            &messages,
            emit_tokens,
        )
        .await
        {
            Ok(text) => {
                emit_stage_event(
                    app,
                    request_id,
                    StageEvent {
                        request_id: request_id.to_string(),
                        stage: stage.to_string(),
                        status: "end".to_string(),
                        message: Some(format!("Completed using {}", model)),
                        retry_count: Some(i as u32),
                        provider: Some(provider_name.to_string()),
                    },
                );
                return Ok(text);
            }
            Err(err) => {
                last_error = err;
                emit_stage_event(
                    app,
                    request_id,
                    StageEvent {
                        request_id: request_id.to_string(),
                        stage: stage.to_string(),
                        status: "error".to_string(),
                        message: Some(last_error.clone()),
                        retry_count: Some(i as u32),
                        provider: Some(provider_name.to_string()),
                    },
                );
                if !retry::is_retryable_error(&last_error) || i >= 2 {
                    break;
                }
                let wait = retry_delay_ms_from_error(&last_error)
                    .map(std::time::Duration::from_millis)
                    .unwrap_or_else(|| retry::backoff_for_attempt(i));
                tokio::time::sleep(wait).await;
            }
        }
    }

    Err(last_error)
}

fn emit_stage_event(app: &AppHandle, request_id: &str, ev: StageEvent) {
    let _ = app.emit(
        "schema-designer-ai-stage",
        serde_json::json!({
            "requestId": request_id,
            "stage": ev.stage,
            "status": ev.status,
            "message": ev.message,
            "retryCount": ev.retry_count,
            "provider": ev.provider,
        }),
    );
}

fn emit_token_event(app: &AppHandle, request_id: &str, text: &str) {
    let _ = app.emit(
        "schema-designer-ai-token",
        serde_json::json!({
            "requestId": request_id,
            "chunk": { "type": "content", "text": text },
        }),
    );
}

fn emit_done_event(app: &AppHandle, request_id: &str, err: Option<String>) {
    let _ = app.emit(
        "schema-designer-ai-done",
        serde_json::json!({
            "requestId": request_id,
            "error": err,
        }),
    );
}

fn format_http_error(source: &str, status: u16, retry_after: Option<&str>, body: &str) -> String {
    let body_trimmed = body.trim();
    let retry = retry_after.unwrap_or_default().trim();
    if status == 429 {
        if retry.is_empty() {
            return format!("{source} rate limit (429): {body_trimmed}");
        }
        return format!("{source} rate limit (429, retry-after={retry}s): {body_trimmed}");
    }
    format!("{source} error {status}: {body_trimmed}")
}

fn retry_delay_ms_from_error(message: &str) -> Option<u64> {
    let lower = message.to_ascii_lowercase();
    let marker = "retry-after=";
    let start = lower.find(marker)?;
    let rest = &lower[start + marker.len()..];
    let num: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if num.is_empty() {
        return None;
    }
    let secs = num.parse::<f64>().ok()?;
    Some((secs.max(0.0) * 1000.0) as u64)
}

async fn run_groq_once(
    app: &AppHandle,
    request_id: &str,
    cancel_flag: Arc<AtomicBool>,
    req: &AiStreamRequest,
    model: &str,
    phase_system_prompt: &str,
    source_messages: &[AiChatMessage],
    emit_tokens: bool,
) -> Result<String, String> {
    validate_model_id(model)?;
    if requested_provider(req) == "worker" {
        return run_worker_once(
            app,
            request_id,
            cancel_flag,
            req,
            model,
            phase_system_prompt,
            source_messages,
            emit_tokens,
        )
        .await;
    }
    if requested_provider(req) == "cloudflare" {
        return run_cloudflare_once(
            app,
            request_id,
            cancel_flag,
            req,
            model,
            phase_system_prompt,
            source_messages,
            emit_tokens,
        )
        .await;
    }
    if requested_provider(req) == "openrouter" {
        return run_openrouter_once(
            app,
            request_id,
            cancel_flag,
            req,
            model,
            phase_system_prompt,
            source_messages,
            emit_tokens,
        )
        .await;
    }
    if requested_provider(req) == "gemini" {
        return run_gemini_once(
            app,
            request_id,
            cancel_flag,
            req,
            model,
            phase_system_prompt,
            source_messages,
            emit_tokens,
        )
        .await;
    }
    let api_key = key::read_groq_api_key().ok_or_else(|| {
        "No API key configured. Set OPENROUTER_API_KEY (or GROQ_API_KEY / Cloudflare envs)."
            .to_string()
    })?;

    let user_ctx = user_context_suffix(&req.options);
    let mut body_messages: Vec<Value> = vec![serde_json::json!({
        "role": "system",
        "content": phase_system_prompt,
    })];
    let last_user_idx = source_messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role.trim() == "user")
        .map(|(i, _)| i)
        .last();
    for (i, m) in source_messages.iter().enumerate() {
        let role = m.role.trim();
        if role != "user" && role != "assistant" {
            continue;
        }
        let append_ctx = role == "user" && !user_ctx.is_empty() && last_user_idx == Some(i);
        let content = if role == "assistant" {
            Value::String(m.content.clone())
        } else {
            message_content_for_groq(m, append_ctx, &user_ctx)
        };
        body_messages.push(serde_json::json!({ "role": role, "content": content }));
    }

    let mut payload = serde_json::json!({
        "model": model.trim(),
        "messages": body_messages,
        "temperature": req.temperature.clamp(0.0, 2.0),
        "max_tokens": req.max_tokens.min(32768).max(256),
        "stream": true,
    });
    if let Some(ref effort) = req.options.as_ref().and_then(|o| o.reasoning_effort.as_ref()) {
        if !effort.is_empty() {
            payload["reasoning_effort"] = Value::String(effort.to_string());
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .post(GROQ_CHAT_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Groq request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let text = resp.text().await.unwrap_or_default();
        return Err(format_http_error(
            "Groq",
            status.as_u16(),
            retry_after.as_deref(),
            &text,
        ));
    }

    let mut stream = resp.bytes_stream();
    let mut line_buf = String::new();
    let mut full = String::new();
    while let Some(item) = stream.next().await {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        let chunk = item.map_err(|e| format!("Stream read error: {e}"))?;
        line_buf.push_str(&String::from_utf8_lossy(&chunk));
        loop {
            let Some(pos) = line_buf.find('\n') else {
                break;
            };
            let line = line_buf[..pos].trim_end_matches('\r').to_string();
            line_buf.drain(..=pos);
            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line[6..];
            if data == "[DONE]" {
                return Ok(full);
            }
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(err) = v.get("error") {
                return Err(
                    err.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Groq API error")
                        .to_string(),
                );
            }
            let text_piece = v
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|ch| ch.get("delta"))
                .and_then(|d| d.get("content"))
                .and_then(|x| x.as_str())
                .unwrap_or_default();
            if text_piece.is_empty() {
                continue;
            }
            full.push_str(text_piece);
            if emit_tokens {
                emit_token_event(app, request_id, text_piece);
            }
        }
    }
    Ok(full)
}

async fn run_openrouter_once(
    app: &AppHandle,
    request_id: &str,
    cancel_flag: Arc<AtomicBool>,
    req: &AiStreamRequest,
    model: &str,
    phase_system_prompt: &str,
    source_messages: &[AiChatMessage],
    emit_tokens: bool,
) -> Result<String, String> {
    let api_key = key::read_groq_api_key().ok_or_else(|| {
        "No OpenRouter API key configured. Set OPENROUTER_API_KEY (or store in keychain).".to_string()
    })?;
    let user_ctx = user_context_suffix(&req.options);
    let mut body_messages: Vec<Value> = vec![serde_json::json!({
        "role": "system",
        "content": phase_system_prompt,
    })];
    let last_user_idx = source_messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role.trim() == "user")
        .map(|(i, _)| i)
        .last();
    for (i, m) in source_messages.iter().enumerate() {
        let role = m.role.trim();
        if role != "user" && role != "assistant" {
            continue;
        }
        let append_ctx = role == "user" && !user_ctx.is_empty() && last_user_idx == Some(i);
        let content = if role == "assistant" {
            Value::String(m.content.clone())
        } else {
            message_content_for_groq(m, append_ctx, &user_ctx)
        };
        body_messages.push(serde_json::json!({ "role": role, "content": content }));
    }
    let mut payload = serde_json::json!({
        "model": model.trim(),
        "messages": body_messages,
        "temperature": req.temperature.clamp(0.0, 2.0),
        "max_tokens": req.max_tokens.min(32768).max(256),
        "stream": true,
    });
    if let Some(ref effort) = req.options.as_ref().and_then(|o| o.reasoning_effort.as_ref()) {
        if !effort.is_empty() {
            payload["reasoning"] = serde_json::json!({ "effort": effort });
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .post(OPENROUTER_CHAT_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", "https://pgstudio.app")
        .header("X-Title", "pgStudio Schema Designer")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("OpenRouter request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let text = resp.text().await.unwrap_or_default();
        return Err(format_http_error(
            "OpenRouter",
            status.as_u16(),
            retry_after.as_deref(),
            &text,
        ));
    }

    let mut stream = resp.bytes_stream();
    let mut line_buf = String::new();
    let mut full = String::new();
    while let Some(item) = stream.next().await {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        let chunk = item.map_err(|e| format!("Stream read error: {e}"))?;
        line_buf.push_str(&String::from_utf8_lossy(&chunk));
        loop {
            let Some(pos) = line_buf.find('\n') else {
                break;
            };
            let line = line_buf[..pos].trim_end_matches('\r').to_string();
            line_buf.drain(..=pos);
            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line[6..];
            if data == "[DONE]" {
                return Ok(full);
            }
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(err) = v.get("error") {
                return Err(
                    err.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("OpenRouter API error")
                        .to_string(),
                );
            }
            let text_piece = v
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|ch| ch.get("delta"))
                .and_then(|d| d.get("content"))
                .and_then(|x| x.as_str())
                .unwrap_or_default();
            if text_piece.is_empty() {
                continue;
            }
            full.push_str(text_piece);
            if emit_tokens {
                emit_token_event(app, request_id, text_piece);
            }
        }
    }
    Ok(full)
}

async fn run_gemini_once(
    app: &AppHandle,
    request_id: &str,
    cancel_flag: Arc<AtomicBool>,
    req: &AiStreamRequest,
    model: &str,
    phase_system_prompt: &str,
    source_messages: &[AiChatMessage],
    emit_tokens: bool,
) -> Result<String, String> {
    let api_key = key::read_gemini_api_key()
        .ok_or_else(|| "Missing GEMINI_API_KEY (or GOOGLE_API_KEY) env variable".to_string())?;
    let model_name = model.trim().trim_start_matches("models/");
    let url = GEMINI_GENERATE_URL_FMT
        .replace("{model}", model_name)
        .replace("{key}", &api_key);

    let user_ctx = user_context_suffix(&req.options);
    let mut contents: Vec<Value> = Vec::new();
    let last_user_idx = source_messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role.trim() == "user")
        .map(|(i, _)| i)
        .last();
    for (i, m) in source_messages.iter().enumerate() {
        let role = m.role.trim();
        if role != "user" && role != "assistant" {
            continue;
        }
        let mut text = m.content.clone();
        if role == "user" && !user_ctx.is_empty() && last_user_idx == Some(i) {
            text.push_str(&user_ctx);
        }
        if role == "user" {
            if let Some(atts) = &m.attachments {
                if !atts.is_empty() {
                    text.push_str("\n\n[Note] Image attachments were provided in the UI.");
                }
            }
        }
        if text.trim().is_empty() {
            continue;
        }
        let gemini_role = if role == "assistant" { "model" } else { "user" };
        contents.push(serde_json::json!({
            "role": gemini_role,
            "parts": [{ "text": text }]
        }));
    }
    let payload = serde_json::json!({
        "systemInstruction": {
            "parts": [{ "text": phase_system_prompt }]
        },
        "contents": contents,
        "generationConfig": {
            "temperature": req.temperature.clamp(0.0, 2.0),
            "maxOutputTokens": req.max_tokens.min(32768).max(256)
        }
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let text = resp.text().await.unwrap_or_default();
        return Err(format_http_error(
            "Gemini",
            status.as_u16(),
            retry_after.as_deref(),
            &text,
        ));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Gemini parse error: {e}"))?;
    let mut full = String::new();
    if let Some(parts) = body
        .get("candidates")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
    {
        for part in parts {
            if let Some(text) = part.get("text").and_then(|x| x.as_str()) {
                full.push_str(text);
            }
        }
    }
    if full.trim().is_empty() {
        if let Some(reason) = body
            .get("candidates")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|c| c.get("finishReason"))
            .and_then(|x| x.as_str())
        {
            return Err(format!("Gemini returned empty output (finishReason={reason})"));
        }
        return Err("Gemini returned empty output".to_string());
    }
    if emit_tokens {
        const CHUNK_SIZE: usize = 220;
        let chars: Vec<char> = full.chars().collect();
        let mut idx = 0usize;
        while idx < chars.len() {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("Cancelled".to_string());
            }
            let end = (idx + CHUNK_SIZE).min(chars.len());
            let chunk: String = chars[idx..end].iter().collect();
            if !chunk.is_empty() {
                emit_token_event(app, request_id, &chunk);
            }
            idx = end;
        }
    }
    Ok(full)
}

async fn run_worker_once(
    app: &AppHandle,
    request_id: &str,
    cancel_flag: Arc<AtomicBool>,
    req: &AiStreamRequest,
    model: &str,
    phase_system_prompt: &str,
    source_messages: &[AiChatMessage],
    emit_tokens: bool,
) -> Result<String, String> {
    if cancel_flag.load(Ordering::SeqCst) {
        return Err("Cancelled".into());
    }
    let mut messages: Vec<Value> = Vec::new();
    messages.push(serde_json::json!({
        "role": "system",
        "content": phase_system_prompt
    }));
    for m in source_messages {
        let role = m.role.trim();
        if role != "user" && role != "assistant" {
            continue;
        }
        let mut content = m.content.trim().to_string();
        if role == "user" {
            if let Some(atts) = &m.attachments {
                if !atts.is_empty() {
                    content.push_str("\n\n[Note] Image attachments were provided in the UI.");
                }
            }
        }
        if content.is_empty() {
            continue;
        }
        messages.push(serde_json::json!({
            "role": role,
            "content": content
        }));
    }

    let payload = serde_json::json!({
        "conversationId": req.project_id.clone().unwrap_or_else(|| request_id.to_string()),
        "model": model.trim(),
        "temperature": req.temperature.clamp(0.0, 2.0),
        "max_tokens": req.max_tokens.min(32768).max(256),
        "stream": false,
        "skipCache": false,
        "messages": messages
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let worker_url = key::read_schema_ai_worker_url();
    let mut request_builder = client
        .post(worker_url)
        .header("Content-Type", "application/json")
        .json(&payload);
    if let Some(api_key) = key::read_schema_ai_worker_api_key() {
        request_builder = request_builder.header("X-Api-Key", api_key);
    }
    if let Some(auth_token) = key::read_schema_ai_worker_auth_token() {
        request_builder = request_builder.header("Authorization", format!("Bearer {auth_token}"));
    }
    let resp = request_builder
        .send()
        .await
        .map_err(|e| format!("Worker request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let text = resp.text().await.unwrap_or_default();
        let base_err = format_http_error(
            "Worker",
            status.as_u16(),
            retry_after.as_deref(),
            &text,
        );
        if status.is_server_error() {
            return Err(format!(
                "{base_err} (check worker logs and ensure required worker env/auth headers are configured)"
            ));
        }
        return Err(base_err);
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Worker parse error: {e}"))?;

    let mut full = body
        .get("response")
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();
    if full.is_empty() {
        full = body
            .get("result")
            .and_then(|r| r.get("response"))
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string();
    }
    if full.is_empty() {
        full = body
            .get("text")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string();
    }
    if full.is_empty() {
        return Err("Worker returned empty output".to_string());
    }
    if emit_tokens {
        const CHUNK_SIZE: usize = 220;
        let chars: Vec<char> = full.chars().collect();
        let mut idx = 0usize;
        while idx < chars.len() {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("Cancelled".to_string());
            }
            let end = (idx + CHUNK_SIZE).min(chars.len());
            let chunk: String = chars[idx..end].iter().collect();
            if !chunk.is_empty() {
                emit_token_event(app, request_id, &chunk);
            }
            idx = end;
        }
    }
    Ok(full)
}

async fn run_cloudflare_once(
    app: &AppHandle,
    request_id: &str,
    cancel_flag: Arc<AtomicBool>,
    req: &AiStreamRequest,
    model: &str,
    phase_system_prompt: &str,
    source_messages: &[AiChatMessage],
    emit_tokens: bool,
) -> Result<String, String> {
    let auth_token = key::read_cloudflare_auth_token()
        .ok_or_else(|| "Missing CLOUDFLARE_AUTH_TOKEN env variable".to_string())?;
    let account_id = key::read_cloudflare_account_id()
        .ok_or_else(|| "Missing CLOUDFLARE_ACCOUNT_ID env variable".to_string())?;
    let use_run_api = cloudflare_uses_run_api(model);
    let url = if use_run_api {
        CLOUDFLARE_RUN_URL_FMT
            .replace("{account}", &account_id)
            .replace("{model}", model.trim())
    } else {
        CLOUDFLARE_RESPONSES_URL_FMT.replace("{account}", &account_id)
    };
    let payload = if use_run_api {
        let mut messages: Vec<Value> = Vec::new();
        messages.push(serde_json::json!({
            "role": "system",
            "content": phase_system_prompt
        }));
        for m in source_messages {
            let role = m.role.trim();
            if role != "user" && role != "assistant" {
                continue;
            }
            if m.content.trim().is_empty() {
                continue;
            }
            messages.push(serde_json::json!({
                "role": role,
                "content": m.content
            }));
        }
        serde_json::json!({
            "messages": messages,
            "temperature": req.temperature.clamp(0.0, 2.0),
            "max_tokens": req.max_tokens.min(131072).max(256),
        })
    } else {
        let mut input_blocks: Vec<Value> = Vec::new();
        input_blocks.push(serde_json::json!({
            "role": "system",
            "content": [{ "type": "input_text", "text": phase_system_prompt }]
        }));
        for m in source_messages {
            let role = m.role.trim();
            if role != "user" && role != "assistant" {
                continue;
            }
            let mut parts: Vec<Value> = Vec::new();
            if !m.content.trim().is_empty() {
                parts.push(serde_json::json!({
                    "type": "input_text",
                    "text": m.content,
                }));
            }
            if let Some(atts) = &m.attachments {
                for att in atts {
                    let mime = att.mime_type.trim();
                    let b64 = att.data_base64.trim();
                    if mime.is_empty() || b64.is_empty() {
                        continue;
                    }
                    parts.push(serde_json::json!({
                        "type": "input_image",
                        "image_url": format!("data:{mime};base64,{b64}")
                    }));
                }
            }
            if parts.is_empty() {
                continue;
            }
            input_blocks.push(serde_json::json!({
                "role": role,
                "content": parts
            }));
        }
        serde_json::json!({
            "model": model.trim(),
            "input": input_blocks,
            "temperature": req.temperature.clamp(0.0, 2.0),
            "max_output_tokens": req.max_tokens.min(131072).max(256),
        })
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {auth_token}"))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Cloudflare request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let text = resp.text().await.unwrap_or_default();
        return Err(format_http_error(
            "Cloudflare",
            status.as_u16(),
            retry_after.as_deref(),
            &text,
        ));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Cloudflare parse error: {e}"))?;

    let mut full = body
        .get("result")
        .and_then(|r| r.get("response"))
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();
    if full.is_empty() {
        full = body
            .get("result")
            .and_then(|r| r.get("output_text"))
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string();
    }
    if full.is_empty() {
        if let Some(items) = body
            .get("result")
            .and_then(|r| r.get("output"))
            .and_then(|v| v.as_array())
        {
            for item in items {
                if let Some(content) = item.get("content").and_then(|x| x.as_array()) {
                    for piece in content {
                        if let Some(text) = piece.get("text").and_then(|x| x.as_str()) {
                            full.push_str(text);
                        }
                    }
                }
            }
        }
    }
    if full.is_empty() {
        return Err("Cloudflare returned empty output".to_string());
    }
    if emit_tokens {
        const CHUNK_SIZE: usize = 220;
        let chars: Vec<char> = full.chars().collect();
        let mut idx = 0usize;
        while idx < chars.len() {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("Cancelled".to_string());
            }
            let end = (idx + CHUNK_SIZE).min(chars.len());
            let chunk: String = chars[idx..end].iter().collect();
            if !chunk.is_empty() {
                emit_token_event(app, request_id, &chunk);
            }
            idx = end;
        }
    }
    Ok(full)
}
