use reqwest::StatusCode;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{Emitter, Window};

use super::keyring;
use super::models::{ConversationMessage, GenerationOptions, GroqStreamPayload};

const GROQ_ENDPOINT: &str = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY_ENV: &str = "GROQ_API_KEY";

const SYSTEM_PROMPT: &str = r##"You are an expert database architect and schema designer.
When given an application description, you must respond with a structured JSON schema definition followed by a human-readable explanation.

Response format:

```json
{
  "schema": {
    "tables": [
      {
        "name": "string",
        "description": "string",
        "columns": [
          {
            "name": "string",
            "type": "string",
            "nullable": false,
            "primaryKey": false,
            "unique": false,
            "default": null,
            "references": null,
            "description": "string"
          }
        ],
        "indexes": [],
        "color": "#6366f1"
      }
    ],
    "enums": [],
    "metadata": {
      "databaseType": "string",
      "version": "1.0",
      "description": "Overall schema description",
      "totalTables": 0,
      "totalRelationships": 0
    }
  }
}
```

After the JSON block, provide:
## Schema Overview
## Table Descriptions
## Relationship Map
## Performance Notes
## Next Steps"##;

fn emit_stream(
    window: &Window,
    event: &str,
    request_id: &str,
    content: &str,
) -> Result<(), String> {
    window
        .emit(
            event,
            GroqStreamPayload {
                request_id: request_id.to_string(),
                content: content.to_string(),
            },
        )
        .map_err(|e| format!("Failed to emit Groq stream event: {e}"))
}

fn build_prompt(user_prompt: &str, options: &GenerationOptions) -> String {
    format!(
        "Design a complete {database_type} database schema for the following application:\n\n{user_prompt}\n\nRequirements:\n- Normalization level: {normalization_level}\n- Naming convention: {naming_convention}\n- Include audit columns: {include_audit_columns}\n- Include performance indexes: {include_indexes}\n- Include enum types: {include_enums}\n- Include sample data: {include_sample_data}\n- Output detail: {output_format}\n\nAssign a distinct hex color to each table for visual grouping in the diagram. Ensure all foreign key relationships are explicitly defined with proper cascade behavior.",
        database_type = options.database_type,
        normalization_level = options.normalization_level,
        naming_convention = options.naming_convention,
        include_audit_columns = options.include_audit_columns,
        include_indexes = options.include_indexes,
        include_enums = options.include_enums,
        include_sample_data = options.include_sample_data,
        output_format = options.output_format,
    )
}

fn error_message_from_body(status: StatusCode, body: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<Value>(body) {
        if let Some(message) = parsed
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return format!("{status}: {message}");
        }
    }

    let fallback = body.trim();
    if fallback.is_empty() {
        format!("Groq request failed with status {status}")
    } else {
        format!("{status}: {fallback}")
    }
}

fn resolve_groq_api_key(
    app_data_dir: Option<PathBuf>,
    api_key_id: Option<&str>,
) -> Result<String, String> {
    if let Ok(env_key) = std::env::var(GROQ_API_KEY_ENV) {
        let trimmed = env_key.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let stored_key = keyring::resolve_api_key(app_data_dir, api_key_id)?;
    Ok(stored_key.secret)
}

fn process_sse_line(
    line: &str,
    window: &Window,
    request_id: &str,
    full_response: &mut String,
) -> Result<bool, String> {
    if !line.starts_with("data:") {
        return Ok(false);
    }

    let data = line.trim_start_matches("data:").trim();
    if data.is_empty() {
        return Ok(false);
    }
    if data == "[DONE]" {
        return Ok(true);
    }

    let parsed = match serde_json::from_str::<Value>(data) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };

    let Some(delta) = parsed
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("delta"))
    else {
        return Ok(false);
    };

    if let Some(content) = delta.get("content").and_then(Value::as_str) {
        full_response.push_str(content);
        emit_stream(
            window,
            "schema-designer://stream-token",
            request_id,
            content,
        )?;
    }

    if let Some(reasoning) = delta
        .get("reasoning")
        .and_then(Value::as_str)
        .or_else(|| delta.get("reasoning_content").and_then(Value::as_str))
    {
        emit_stream(
            window,
            "schema-designer://stream-reasoning",
            request_id,
            reasoning,
        )?;
    }

    Ok(false)
}

pub async fn stream_schema_generation(
    window: &Window,
    app_data_dir: Option<PathBuf>,
    request_id: String,
    prompt: String,
    model: String,
    options: GenerationOptions,
    conversation_history: Vec<ConversationMessage>,
) -> Result<String, String> {
    let api_key = resolve_groq_api_key(app_data_dir.clone(), options.api_key_id.as_deref())?;
    let client = reqwest::Client::new();

    let mut messages = vec![json!({
        "role": "system",
        "content": SYSTEM_PROMPT,
    })];

    for message in conversation_history {
        messages.push(json!({
            "role": message.role,
            "content": message.content,
        }));
    }

    messages.push(json!({
        "role": "user",
        "content": build_prompt(&prompt, &options),
    }));

    let request_body = json!({
        "model": model,
        "messages": messages,
        "temperature": options.temperature,
        "max_completion_tokens": options.max_tokens,
        "stream": true,
        "reasoning_effort": options.reasoning_effort,
        "top_p": 1,
    });

    let mut response = client
        .post(GROQ_ENDPOINT)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Failed to reach Groq: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let message = error_message_from_body(status, &body);
        let _ = emit_stream(
            window,
            "schema-designer://stream-error",
            &request_id,
            &message,
        );
        return Err(message);
    }

    let mut buffer = String::new();
    let mut full_response = String::new();
    let mut done = false;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed while reading Groq stream: {e}"))?
    {
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].trim_end_matches('\r').to_string();
            buffer.drain(..=index);
            if process_sse_line(&line, window, &request_id, &mut full_response)? {
                done = true;
                break;
            }
        }

        if done {
            break;
        }
    }

    if !done && !buffer.trim().is_empty() {
        let _ = process_sse_line(
            buffer.trim_end_matches('\r'),
            window,
            &request_id,
            &mut full_response,
        )?;
    }

    if let Ok(stored_key) = keyring::resolve_api_key(app_data_dir.clone(), options.api_key_id.as_deref()) {
        let _ = keyring::mark_key_validated(app_data_dir, &stored_key.meta.id);
    }
    emit_stream(
        window,
        "schema-designer://stream-done",
        &request_id,
        &full_response,
    )?;

    Ok(full_response)
}
