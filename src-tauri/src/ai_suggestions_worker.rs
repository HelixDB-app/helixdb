//! POST SQL AI suggestion payloads to a Cloudflare Worker (or compatible proxy).
//! Used from the desktop shell so traffic does not depend on the WebView fetch stack.

use reqwest::Client;
use std::time::Duration;

fn build_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(45))
        .connect_timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))
}

/// POST JSON body to the worker URL; returns raw response body on HTTP success.
#[tauri::command]
pub async fn ai_suggestions_worker_post(url: String, body: serde_json::Value) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("AI suggestions worker URL is empty".into());
    }
    if !url.starts_with("https://") {
        return Err("AI suggestions worker URL must use HTTPS".into());
    }

    let client = build_client()?;
    let res = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI worker request failed: {e}"))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("AI worker response read failed: {e}"))?;

    if !status.is_success() {
        let snippet: String = text.chars().take(280).collect();
        return Err(format!("AI worker HTTP {}: {}", status.as_u16(), snippet));
    }

    Ok(text)
}
