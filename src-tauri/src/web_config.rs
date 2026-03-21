//! Build-time web app URL (control plane) and shared HTTP client for auth / trial / billing calls.
//! Set `PGSTUDIO_WEB_APP_URL` or `NEXT_PUBLIC_WEB_APP_URL` before `cargo build` / `tauri build`
//! (see `src-tauri/build.rs`).

use once_cell::sync::Lazy;
use reqwest::Client;

/// Public pgStudio web app origin, no trailing slash (matches frontend default).
pub const WEB_APP_URL: &str = env!("PGSTUDIO_WEB_APP_URL");

/// Changelog page on the same host as the control plane.
pub const WEB_CHANGELOG_URL: &str = concat!(env!("PGSTUDIO_WEB_APP_URL"), "/changelog");

/// Shared client: connection pooling, consistent timeouts for control-plane APIs.
pub static CONTROL_PLANE_HTTP: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("reqwest client for control plane")
});
