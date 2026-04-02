use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use super::groq_stream::{run_groq_phase_with_retry, AiChatMessage, AiStreamRequest};
use super::prompt;

fn emit_done(app: &AppHandle, request_id: &str, error: Option<String>) {
    let _ = app.emit(
        "schema-designer-ai-done",
        serde_json::json!({
            "requestId": request_id,
            "error": error,
        }),
    );
}

pub async fn run_agentic_pipeline(
    app: AppHandle,
    request_id: String,
    cancel_flag: Arc<AtomicBool>,
    req: AiStreamRequest,
) {
    let base_messages = req.messages.clone();
    let run_features = req
        .options
        .as_ref()
        .and_then(|o| o.run_features_phase)
        .unwrap_or(true);
    let run_docs = req
        .options
        .as_ref()
        .and_then(|o| o.run_docs_phase)
        .unwrap_or(true);
    let run_saving = req
        .options
        .as_ref()
        .and_then(|o| o.run_saving_stage)
        .unwrap_or(true);

    let schema_text = match run_groq_phase_with_retry(
        &app,
        &request_id,
        cancel_flag.clone(),
        &req,
        "schema",
        prompt::SCHEMA_DESIGN_PROMPT,
        base_messages.clone(),
        true,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            emit_done(&app, &request_id, Some(e));
            return;
        }
    };

    let mut features_messages = base_messages.clone();
    features_messages.push(AiChatMessage {
        role: "assistant".to_string(),
        content: schema_text,
        attachments: None,
    });
    let mut features_text = String::new();
    if run_features {
        features_text = match run_groq_phase_with_retry(
            &app,
            &request_id,
            cancel_flag.clone(),
            &req,
            "features",
            prompt::PG_FEATURES_PROMPT,
            features_messages.clone(),
            true,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                emit_done(&app, &request_id, Some(e));
                return;
            }
        };
    }

    let mut docs_messages = features_messages;
    if run_features {
        docs_messages.push(AiChatMessage {
            role: "assistant".to_string(),
            content: features_text,
            attachments: None,
        });
    }

    let docs_result = if run_docs {
        run_groq_phase_with_retry(
            &app,
            &request_id,
            cancel_flag.clone(),
            &req,
            "docs",
            prompt::DOCUMENTATION_PROMPT,
            docs_messages,
            true,
        )
        .await
    } else {
        Ok(String::new())
    };

    match docs_result {
        Ok(_) => {
            if run_saving {
                let _ = app.emit(
                    "schema-designer-ai-stage",
                    serde_json::json!({
                        "requestId": request_id,
                        "stage": "saving",
                        "status": "start",
                        "message": "Finalizing generated output",
                    }),
                );
                let _ = app.emit(
                    "schema-designer-ai-stage",
                    serde_json::json!({
                        "requestId": request_id,
                        "stage": "saving",
                        "status": "end",
                        "message": "Finalized",
                    }),
                );
            }
            emit_done(&app, &request_id, None)
        }
        Err(e) => emit_done(&app, &request_id, Some(e)),
    }
}
