use helix_data_plane::build_router;
use std::env;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let app = build_router();
    let addr = env::var("DATA_PLANE_BIND").unwrap_or_else(|_| "0.0.0.0:9847".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind");
    tracing::info!("helix-data-plane listening on http://{}", addr);
    axum::serve(listener, app).await.expect("serve");
}
