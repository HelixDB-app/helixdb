//! Schema AI API key: OS keychain + optional env vars (dev).

const KEYRING_SERVICE: &str = "pgstudio";
const KEYRING_USER_GROQ: &str = "groq_api_key";

fn read_env_trimmed(name: &str) -> Option<String> {
    let raw = std::env::var(name).ok()?;
    let value = raw.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub fn read_cloudflare_auth_token() -> Option<String> {
    read_env_trimmed("CLOUDFLARE_AUTH_TOKEN")
}

pub fn read_cloudflare_account_id() -> Option<String> {
    read_env_trimmed("CLOUDFLARE_ACCOUNT_ID")
}

pub fn read_gemini_api_key() -> Option<String> {
    for key in ["GEMINI_API_KEY", "GOOGLE_API_KEY"] {
        if let Some(value) = read_env_trimmed(key) {
            return Some(value);
        }
    }
    None
}

pub fn read_schema_ai_worker_url() -> String {
    read_env_trimmed("SCHEMA_AI_WORKER_URL")
        .unwrap_or_else(|| "https://auto-comment.gokulakrishnanr812-492.workers.dev/".to_string())
}

pub fn read_schema_ai_worker_api_key() -> Option<String> {
    for key in ["SCHEMA_AI_WORKER_API_KEY", "AI_WORKER_API_KEY", "X_API_KEY"] {
        if let Some(value) = read_env_trimmed(key) {
            return Some(value);
        }
    }
    None
}

pub fn read_schema_ai_worker_auth_token() -> Option<String> {
    for key in ["SCHEMA_AI_WORKER_AUTH_TOKEN", "WORKER_AUTH_TOKEN", "AI_WORKER_AUTH_TOKEN"] {
        if let Some(value) = read_env_trimmed(key) {
            return Some(value);
        }
    }
    None
}

pub fn read_groq_api_key() -> Option<String> {
    for key in [
        "OPENROUTER_API_KEY",
        "GROQ_API_KEY",
        "GROQ_AUTH_TOKEN",
        "AI_API_KEY",
        "OPENAI_API_KEY",
    ] {
        if let Some(value) = read_env_trimmed(key) {
            return Some(value);
        }
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_GROQ).ok()?;
    match entry.get_password() {
        Ok(p) => {
            let t = p.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            log::warn!("[schema_ai] keyring read failed: {e}");
            None
        }
    }
}

pub fn store_groq_api_key(api_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_GROQ)
        .map_err(|e| format!("Keyring error: {e}"))?;
    entry
        .set_password(api_key.trim())
        .map_err(|e| format!("Failed to store Groq API key: {e}"))?;
    log::info!("[schema_ai] Groq API key stored in keychain");
    Ok(())
}

pub fn delete_groq_api_key() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_GROQ)
        .map_err(|e| format!("Keyring error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete Groq API key: {e}")),
    }
}
