use std::time::Duration;

pub const FALLBACK_CHAIN: &[&str] = &[
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
];

pub fn model_chain(primary: &str) -> Vec<String> {
    let mut models = Vec::new();
    let first = primary.trim();
    if !first.is_empty() {
        models.push(first.to_string());
    }
    for m in FALLBACK_CHAIN {
        if !models.iter().any(|x| x == m) {
            models.push((*m).to_string());
        }
    }
    models
}

pub fn is_retryable_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains(" 500")
        || lower.contains(" 502")
        || lower.contains(" 503")
        || lower.contains(" 504")
        || lower.contains("service unavailable")
        || lower.contains("bad gateway")
        || lower.contains("timeout")
        || lower.contains("temporarily unavailable")
        || lower.contains("connection reset")
        || lower.contains("stream read error")
}

pub fn backoff_for_attempt(attempt: usize) -> Duration {
    let secs = match attempt {
        0 => 2,
        1 => 4,
        _ => 8,
    };
    Duration::from_secs(secs)
}
