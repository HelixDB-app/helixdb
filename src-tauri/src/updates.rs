use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::time::Duration;
use tauri::AppHandle;

const ITUNES_LOOKUP_URL: &str = "https://itunes.apple.com/lookup";
const DEFAULT_COUNTRY: &str = "us";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStoreUpdateCheck {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub app_store_url: Option<String>,
    pub release_notes: Option<String>,
    pub track_id: Option<u64>,
    pub fetched_at: String,
}

#[derive(Debug, Deserialize)]
struct ItunesLookupResponse {
    #[serde(rename = "resultCount")]
    result_count: u32,
    results: Vec<ItunesLookupResult>,
}

#[derive(Debug, Deserialize)]
struct ItunesLookupResult {
    version: Option<String>,
    #[serde(rename = "trackViewUrl")]
    track_view_url: Option<String>,
    #[serde(rename = "trackId")]
    track_id: Option<u64>,
    #[serde(rename = "releaseNotes")]
    release_notes: Option<String>,
}

fn parse_version_segments(value: &str) -> Vec<u32> {
    let cleaned = value.trim().trim_start_matches(|c: char| c == 'v' || c == 'V');
    cleaned
        .split(|c| c == '.' || c == '-' || c == '+')
        .filter_map(|part| {
            let digits: String = part
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if digits.is_empty() {
                None
            } else {
                digits.parse::<u32>().ok()
            }
        })
        .collect()
}

fn compare_versions(current: &str, latest: &str) -> Ordering {
    let current_parts = parse_version_segments(current);
    let latest_parts = parse_version_segments(latest);
    let max_len = current_parts.len().max(latest_parts.len());

    for idx in 0..max_len {
        let a = *current_parts.get(idx).unwrap_or(&0);
        let b = *latest_parts.get(idx).unwrap_or(&0);
        match a.cmp(&b) {
            Ordering::Equal => continue,
            other => return other,
        }
    }

    Ordering::Equal
}

fn build_lookup_url(bundle_id: &str, country: &str) -> String {
    format!("{ITUNES_LOOKUP_URL}?bundleId={bundle_id}&country={country}")
}

#[tauri::command]
pub async fn app_store_check_update(app: AppHandle) -> Result<AppStoreUpdateCheck, String> {
    let bundle_id = app.config().identifier.clone();
    let country = std::env::var("PGSTUDIO_APPSTORE_COUNTRY").unwrap_or_else(|_| DEFAULT_COUNTRY.to_string());
    let lookup_url = build_lookup_url(&bundle_id, &country);

    let client = reqwest::Client::builder()
        .user_agent("pgStudio/auto-update")
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let response = client
        .get(lookup_url)
        .send()
        .await
        .map_err(|e| format!("App Store lookup failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("App Store lookup failed with status {}", response.status()));
    }

    let payload = response
        .json::<ItunesLookupResponse>()
        .await
        .map_err(|e| format!("Failed to parse App Store response: {e}"))?;

    let current_version = app.package_info().version.to_string();
    let fetched_at = chrono::Utc::now().to_rfc3339();

    if payload.result_count == 0 || payload.results.is_empty() {
        return Ok(AppStoreUpdateCheck {
            current_version,
            latest_version: None,
            update_available: false,
            app_store_url: None,
            release_notes: None,
            track_id: None,
            fetched_at,
        });
    }

    let result = &payload.results[0];
    let latest_version = result.version.clone();
    let update_available = latest_version
        .as_deref()
        .map(|latest| compare_versions(&current_version, latest) == Ordering::Less)
        .unwrap_or(false);

    Ok(AppStoreUpdateCheck {
        current_version,
        latest_version,
        update_available,
        app_store_url: result.track_view_url.clone(),
        release_notes: result.release_notes.clone(),
        track_id: result.track_id,
        fetched_at,
    })
}
