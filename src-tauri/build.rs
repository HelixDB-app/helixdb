fn main() {
    // Keep in sync with NEXT_PUBLIC_WEB_APP_URL in the frontend (.env / CI).
    let base = std::env::var("PGSTUDIO_WEB_APP_URL")
        .or_else(|_| std::env::var("NEXT_PUBLIC_WEB_APP_URL"))
        .unwrap_or_else(|_| "https://pgstudio-web.vercel.app".to_string());
    let base = base.trim_end_matches('/').to_string();
    println!("cargo:rustc-env=PGSTUDIO_WEB_APP_URL={base}");
    tauri_build::build()
}
