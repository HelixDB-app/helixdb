use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const KEYRING_SERVICE: &str = "pgstudio";
const KEYRING_USER: &str = "desktop_auth_token";
const WEB_BASE_URL: &str = "https://pgstudio-web.vercel.app";

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: String,
    pub name: String,
    pub email: String,
    pub image: Option<String>,
    pub provider: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Open the system browser at the pgstudio-web login page.
/// `state` is a random nonce that the frontend generates to prevent CSRF.
#[tauri::command]
pub async fn auth_open_login(_app: AppHandle, state: String) -> Result<(), String> {
    let url = format!("{}/login?source=desktop&state={}", WEB_BASE_URL, state);
    opener::open_browser(&url).map_err(|e| format!("Failed to open browser: {e}"))?;
    Ok(())
}

/// Open any URL in the system browser (used to open the web profile page, etc.)
#[tauri::command]
pub async fn auth_open_url(_app: AppHandle, url: String) -> Result<(), String> {
    opener::open_browser(&url).map_err(|e| format!("Failed to open browser: {e}"))?;
    Ok(())
}

/// Store the JWT in the OS keychain (macOS Keychain / Windows Credential Store /
/// Linux Secret Service).
#[tauri::command]
pub async fn auth_store_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("Keyring error: {e}"))?;
    entry
        .set_password(&token)
        .map_err(|e| format!("Failed to store token: {e}"))?;
    log::info!(
        "[auth] desktop JWT stored in keychain (len={})",
        token.len()
    );
    Ok(())
}

/// Retrieve the stored JWT from the OS keychain.
/// Returns `None` when no token is stored (user is not authenticated).
#[tauri::command]
pub async fn auth_get_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("Keyring error: {e}"))?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read token: {e}")),
    }
}

/// Delete the stored JWT — effectively signs the user out.
#[tauri::command]
pub async fn auth_delete_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("Keyring error: {e}"))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone — no-op
        Err(e) => Err(format!("Failed to delete token: {e}")),
    }
}

/// Fetch the current user's profile from pgstudio-web using the stored JWT.
/// Returns `None` if no token is stored or if the token is expired / invalid.
#[tauri::command]
pub async fn auth_fetch_profile() -> Result<Option<UserProfile>, String> {
    let token = match auth_get_token().await? {
        Some(t) => t,
        None => {
            log::debug!("[auth] auth_fetch_profile: no token in keychain");
            return Ok(None);
        }
    };

    log::info!("[auth] auth_fetch_profile: calling {WEB_BASE_URL}/api/user/me");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get(format!("{WEB_BASE_URL}/api/user/me"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            log::warn!("[auth] auth_fetch_profile: network error — {e}");
            format!("Network error: {e}")
        })?;

    let status = resp.status();
    log::info!("[auth] auth_fetch_profile: response status = {status}");

    if status == reqwest::StatusCode::UNAUTHORIZED {
        // Token expired or session invalidated — clear it
        log::warn!("[auth] auth_fetch_profile: 401 — clearing stale token from keychain");
        let _ = auth_delete_token().await;
        return Ok(None);
    }

    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        log::error!("[auth] auth_fetch_profile: API error {status} — {body}");
        return Err(format!("API error {status}: {body}"));
    }

    let profile: UserProfile = resp.json().await.map_err(|e| {
        log::error!("[auth] auth_fetch_profile: failed to parse JSON — {e}");
        format!("Failed to parse profile: {e}")
    })?;

    log::info!(
        "[auth] auth_fetch_profile: success for user={}",
        profile.email
    );
    Ok(Some(profile))
}

// ─── Checkout ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CheckoutResponse {
    url: Option<String>,
    error: Option<String>,
}

/// Create a Stripe Checkout Session for the given plan ID.
/// Uses the stored desktop JWT as Bearer auth.
/// Returns the Stripe checkout URL to open in the browser.
#[tauri::command]
pub async fn auth_create_checkout(plan_id: String) -> Result<String, String> {
    let token = match auth_get_token().await? {
        Some(t) => t,
        None => return Err("Not authenticated".into()),
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{WEB_BASE_URL}/api/stripe/checkout"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"planId":"{}"}}"#, plan_id))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = resp.status();
    let body: CheckoutResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    if !status.is_success() {
        return Err(body.error.unwrap_or_else(|| "Checkout failed".into()));
    }

    body.url.ok_or_else(|| "No checkout URL returned".into())
}

// ─── Plans ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanInfo {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub price: i64,
    pub currency: String,
    #[serde(rename = "durationDays")]
    pub duration_days: i64,
    pub features: Vec<String>,
    #[serde(rename = "discordAccess")]
    pub discord_access: String,
    #[serde(rename = "isFeatured")]
    pub is_featured: bool,
    #[serde(rename = "promoTag")]
    pub promo_tag: Option<String>,
}

/// Fetch available plans from pgstudio-web.
#[tauri::command]
pub async fn auth_fetch_plans() -> Result<Vec<PlanInfo>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{WEB_BASE_URL}/api/plans"))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("API error: {}", resp.status()));
    }

    let plans: Vec<PlanInfo> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse plans: {e}"))?;

    Ok(plans)
}

// ─── Subscription Types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionStatus {
    pub id: String,
    #[serde(rename = "planName")]
    pub plan_name: String,
    #[serde(rename = "planSlug")]
    pub plan_slug: String,
    pub status: String,
    #[serde(rename = "discordAccess")]
    pub discord_access: String,
    #[serde(rename = "startDate")]
    pub start_date: String,
    #[serde(rename = "endDate")]
    pub end_date: String,
    #[serde(rename = "paymentAmount")]
    pub payment_amount: i64,
    #[serde(rename = "paymentCurrency")]
    pub payment_currency: String,
    #[serde(rename = "cancelledAt")]
    pub cancelled_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SubscriptionResponse {
    subscription: Option<SubscriptionStatus>,
}

/// Fetch the current user's subscription status from pgstudio-web.
/// Returns `None` if the user has no active subscription or is not authenticated.
#[tauri::command]
pub async fn subscription_fetch_status() -> Result<Option<SubscriptionStatus>, String> {
    let token = match auth_get_token().await? {
        Some(t) => t,
        None => return Ok(None),
    };

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{WEB_BASE_URL}/api/subscription/status"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(None);
    }

    if !resp.status().is_success() {
        return Err(format!("API error: {}", resp.status()));
    }

    let body: SubscriptionResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse subscription: {e}"))?;

    Ok(body.subscription)
}
