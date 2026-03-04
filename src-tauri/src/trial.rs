use serde::{Deserialize, Serialize};

use crate::device_fingerprint::get_device_fingerprint;

const WEB_BASE_URL: &str = "https://pgstudio-web.vercel.app";

// ─── Public Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrialStatus {
    /// "active" | "expired" | "blocked"
    pub state: String,
    pub trial_start_date: String,
    pub trial_expiry_date: String,
    pub days_remaining: i64,
    pub trial_used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialCheckResult {
    /// Whether the user may use the app without a paid subscription
    pub allowed: bool,
    pub trial: Option<TrialStatus>,
    /// Set when the trial feature is globally disabled by the admin
    pub trial_disabled: bool,
    /// Human-readable message for UI display
    pub message: String,
}

// ─── Internal API Response Types ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitResponse {
    trial: Option<TrialStatus>,
    #[serde(default)]
    trial_disabled: bool,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    trial: Option<TrialStatus>,
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

/// Build a reqwest client with a short timeout.
fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Call POST /api/trial/init on the web backend.
/// This is called on every cold launch; the backend is idempotent.
async fn init_trial_remote(
    device_fingerprint: &str,
    associated_user_id: Option<&str>,
) -> Result<TrialCheckResult, String> {
    let client = build_client()?;

    let mut body = serde_json::json!({ "deviceId": device_fingerprint });
    if let Some(uid) = associated_user_id {
        body["associatedUserId"] = serde_json::Value::String(uid.to_string());
    }

    let resp = client
        .post(format!("{WEB_BASE_URL}/api/trial/init"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = resp.status();

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        // We've been rate-limited — fall back to the cached status endpoint
        log::warn!("[trial] init rate-limited, falling back to status endpoint");
        return get_trial_status_remote(device_fingerprint).await;
    }

    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("Trial init API error {status}: {body_text}"));
    }

    let data: InitResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse trial init response: {e}"))?;

    Ok(evaluate_trial_result(data.trial, data.trial_disabled, data.message))
}

/// Call GET /api/trial/status?deviceId=... (lighter, read-only endpoint).
async fn get_trial_status_remote(device_fingerprint: &str) -> Result<TrialCheckResult, String> {
    let client = build_client()?;

    let resp = client
        .get(format!("{WEB_BASE_URL}/api/trial/status"))
        .query(&[("deviceId", device_fingerprint)])
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Trial status API error {}", resp.status()));
    }

    let data: StatusResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse trial status response: {e}"))?;

    Ok(evaluate_trial_result(data.trial, false, None))
}

/// Convert an API-returned trial (or lack of one) into a unified `TrialCheckResult`.
fn evaluate_trial_result(
    trial: Option<TrialStatus>,
    trial_disabled: bool,
    message: Option<String>,
) -> TrialCheckResult {
    match trial {
        Some(t) => {
            let allowed = t.state == "active" && t.days_remaining > 0;
            let msg = if allowed {
                format!("Free trial — {} day{} remaining", t.days_remaining, if t.days_remaining == 1 { "" } else { "s" })
            } else {
                "Your free trial has expired. Please log in and subscribe to continue.".to_string()
            };
            TrialCheckResult {
                allowed,
                trial: Some(t),
                trial_disabled: false,
                message: message.unwrap_or(msg),
            }
        }
        None if trial_disabled => TrialCheckResult {
            allowed: false,
            trial: None,
            trial_disabled: true,
            message: message.unwrap_or_else(|| "Free trial is not available. Please log in to continue.".to_string()),
        },
        None => TrialCheckResult {
            allowed: false,
            trial: None,
            trial_disabled: false,
            message: message.unwrap_or_else(|| "Unable to determine trial status. Please log in.".to_string()),
        },
    }
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Called on every app cold-start (before the user has authenticated).
///
/// Returns a `TrialCheckResult` that drives the frontend to:
/// - Show the trial banner with days remaining
/// - Block access and redirect to login when the trial is expired
/// - Allow normal usage during an active trial
#[tauri::command]
pub async fn trial_init(associated_user_id: Option<String>) -> Result<TrialCheckResult, String> {
    let fp = get_device_fingerprint().map_err(|e| {
        log::error!("[trial] device fingerprint error: {e}");
        format!("Device identification failed: {e}")
    })?;

    log::info!("[trial] trial_init — fingerprint={} (truncated)", &fp[..8]);

    let result = init_trial_remote(&fp, associated_user_id.as_deref()).await;

    match &result {
        Ok(r) => log::info!(
            "[trial] trial_init result: allowed={} state={:?} days_remaining={:?}",
            r.allowed,
            r.trial.as_ref().map(|t| &t.state),
            r.trial.as_ref().map(|t| t.days_remaining),
        ),
        Err(e) => log::warn!("[trial] trial_init error: {e}"),
    }

    result
}

/// Lightweight status check — use for periodic background re-validation.
#[tauri::command]
pub async fn trial_get_status() -> Result<TrialCheckResult, String> {
    let fp = get_device_fingerprint().map_err(|e| {
        log::error!("[trial] device fingerprint error: {e}");
        format!("Device identification failed: {e}")
    })?;

    log::debug!("[trial] trial_get_status — fingerprint={} (truncated)", &fp[..8]);

    get_trial_status_remote(&fp).await
}

/// Associate the current device with a logged-in user.
/// Call this after the user completes authentication.
#[tauri::command]
pub async fn trial_associate_user(user_id: String) -> Result<TrialCheckResult, String> {
    let fp = get_device_fingerprint().map_err(|e| {
        format!("Device identification failed: {e}")
    })?;

    init_trial_remote(&fp, Some(&user_id)).await
}

/// Returns the raw device fingerprint (64-char hex).
/// Useful for displaying to support staff for device management.
/// Safe to expose: it's already a one-way hash of the hardware UUID.
#[tauri::command]
pub async fn trial_get_device_id() -> Result<String, String> {
    get_device_fingerprint()
}
