mod auth;
mod pg_pool;

use std::sync::Arc;

use auth::{auth_from_env, extract_bearer, verify_bearer_returns_sub, AuthState};
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Request, StatusCode};
use axum::middleware::{from_fn, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use dashmap::DashMap;
use deadpool_postgres::Object;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    pool: deadpool_postgres::Pool,
    auth: Arc<AuthState>,
    /// Per-project fan-out for WebSocket subscribers.
    rooms: Arc<DashMap<Uuid, broadcast::Sender<String>>>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "helix_schema_sync=info,tower_http=info".into()),
        )
        .init();

    dotenvy::dotenv().ok();

    let database_url = std::env::var("SCHEMA_SYNC_DATABASE_URL")
        .expect("SCHEMA_SYNC_DATABASE_URL must be set");
    let max_size: usize = std::env::var("SCHEMA_SYNC_POOL_MAX_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(16);

    let pool = pg_pool::create_pool(&database_url, max_size)
        .await
        .expect("database pool");

    {
        let c = pool.get().await.expect("db conn");
        c.batch_execute(pg_pool::MIGRATION_SQL)
            .await
            .expect("migration");
        tracing::info!("schema-sync: migrations applied");
    }

    let auth = Arc::new(auth_from_env().await);
    if auth.require_auth && !auth.any_verifier_configured() {
        tracing::warn!(
            "SCHEMA_SYNC_REQUIRE_AUTH is set but no SCHEMA_SYNC_API_KEY, SCHEMA_SYNC_JWT_HS256_SECRET, or SCHEMA_SYNC_JWKS_URL"
        );
    }

    let state = AppState {
        pool,
        auth: auth.clone(),
        rooms: Arc::new(DashMap::new()),
    };

    let auth_for_mw = auth.clone();
    let protected = Router::new()
        .route("/projects", get(list_projects).post(create_project))
        .route(
            "/projects/{id}",
            get(get_project).patch(patch_project),
        )
        .route("/projects/{id}/share", post(create_share))
        .with_state(state.clone())
        .layer(from_fn(move |req: Request<Body>, next: Next| {
            let a = auth_for_mw.clone();
            async move { require_auth_middleware(a, req, next).await }
        }));

    let public = Router::new()
        .route("/share/{token}/resolve", get(share_resolve))
        .with_state(state.clone());

    let v1 = Router::new().merge(protected).merge(public);

    let cors = cors_layer();

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_handler))
        .nest("/v1", v1)
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr = std::env::var("SCHEMA_SYNC_LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:3031".into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("bind {addr}: {e}"));
    tracing::info!("helix-schema-sync listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
}

fn cors_layer() -> CorsLayer {
    let raw = std::env::var("SCHEMA_SYNC_CORS_ORIGINS").unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() {
        tracing::warn!("SCHEMA_SYNC_CORS_ORIGINS not set — allowing any origin");
        return CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any);
    }
    let mut origins = Vec::new();
    for part in raw.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        if let Ok(h) = HeaderValue::from_str(p) {
            origins.push(h);
        }
    }
    if origins.is_empty() {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods(Any)
            .allow_headers(Any)
    }
}

async fn require_auth_middleware(
    auth: Arc<AuthState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let configured = auth.any_verifier_configured();
    if !configured && !auth.require_auth {
        return next.run(req).await;
    }
    if !configured && auth.require_auth {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    let headers = req.headers();
    let bearer = extract_bearer(headers).map(str::trim).filter(|s| !s.is_empty());
    let Some(bearer) = bearer else {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };
    match verify_bearer_returns_sub(&auth, bearer).await {
        Ok(sub) => {
            let mut req = req;
            req.extensions_mut().insert(AuthUser(sub));
            next.run(req).await
        }
        Err(_) => (StatusCode::UNAUTHORIZED, "Unauthorized").into_response(),
    }
}

#[derive(Clone)]
struct AuthUser(pub String);

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "service": "helix-schema-sync" }))
}

#[derive(Serialize)]
struct ProjectListRow {
    id: Uuid,
    name: String,
    updated_at: chrono::DateTime<chrono::Utc>,
    revision: i64,
}

async fn list_projects(
    State(state): State<AppState>,
    axum::Extension(AuthUser(uid)): axum::Extension<AuthUser>,
) -> Result<Json<Vec<ProjectListRow>>, ApiError> {
    let c = state.pool.get().await?;
    let rows = c
        .query(
            r#"
            SELECT DISTINCT p.id, p.name, p.updated_at, p.revision
            FROM schema_projects p
            LEFT JOIN schema_project_members m ON m.project_id = p.id AND m.user_id = $1
            WHERE p.owner_user_id = $1 OR m.user_id IS NOT NULL
            ORDER BY p.updated_at DESC
            "#,
            &[&uid],
        )
        .await?;
    let out: Vec<ProjectListRow> = rows
        .iter()
        .map(|r| ProjectListRow {
            id: r.get(0),
            name: r.get(1),
            updated_at: r.get(2),
            revision: r.get(3),
        })
        .collect();
    Ok(Json(out))
}

#[derive(Deserialize)]
struct CreateProjectBody {
    project: Value,
}

async fn create_project(
    State(state): State<AppState>,
    axum::Extension(AuthUser(user_id)): axum::Extension<AuthUser>,
    Json(body): Json<CreateProjectBody>,
) -> Result<Json<Value>, ApiError> {
    let id_str = body
        .project
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad_request("project.id required"))?;
    let id = Uuid::parse_str(id_str).map_err(|_| ApiError::bad_request("invalid project id"))?;
    let name = body
        .project
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let description = body
        .project
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let app_type = body
        .project
        .get("app_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let c = state.pool.get().await?;
    let content = serde_json::to_value(&body.project)?;
    let inserted = c
        .execute(
        r#"
        INSERT INTO schema_projects (id, owner_user_id, name, description, app_type, content_jsonb, revision)
        VALUES ($1, $2, $3, $4, $5, $6, 1)
        ON CONFLICT (id) DO NOTHING
        "#,
        &[&id, &user_id, &name, &description, &app_type, &content],
    )
    .await?;

    if inserted == 0 {
        let owner: String = c
            .query_one(
                "SELECT owner_user_id FROM schema_projects WHERE id = $1",
                &[&id],
            )
            .await?
            .get(0);
        if owner != user_id {
            return Err(ApiError::forbidden("project already exists for another user"));
        }
        let rev: i64 = c
            .query_one("SELECT revision FROM schema_projects WHERE id = $1", &[&id])
            .await?
            .get(0);
        return Ok(Json(json!({ "id": id, "revision": rev, "existing": true })));
    }

    c.execute(
        r#"
        INSERT INTO schema_project_members (project_id, user_id, role)
        VALUES ($1, $2, 'owner')
        ON CONFLICT DO NOTHING
        "#,
        &[&id, &user_id],
    )
    .await?;

    Ok(Json(json!({ "id": id, "revision": 1 })))
}

async fn get_project(
    State(state): State<AppState>,
    axum::Extension(AuthUser(uid)): axum::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let c = state.pool.get().await?;
    if !project_access(&c, id, &uid).await? {
        return Err(ApiError::forbidden("no access"));
    }
    let row = c
        .query_one(
            r#"SELECT content_jsonb, revision FROM schema_projects WHERE id = $1"#,
            &[&id],
        )
        .await?;
    let content: Value = row.get(0);
    let revision: i64 = row.get(1);
    Ok(Json(json!({
        "project": content,
        "revision": revision
    })))
}

#[derive(Deserialize)]
struct PatchBody {
    base_revision: i64,
    client_op_id: Uuid,
    project: Value,
}

async fn patch_project(
    State(state): State<AppState>,
    axum::Extension(AuthUser(uid)): axum::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchBody>,
) -> Result<Json<Value>, ApiError> {
    let mut c = state.pool.get().await?;
    if !can_edit(&c, id, &uid).await? {
        return Err(ApiError::forbidden("cannot edit"));
    }

    let dup = c
        .query_opt(
            "SELECT seq FROM schema_project_ops WHERE client_op_id = $1",
            &[&body.client_op_id],
        )
        .await?;
    if dup.is_some() {
        let row = c
            .query_one(
                "SELECT content_jsonb, revision FROM schema_projects WHERE id = $1",
                &[&id],
            )
            .await?;
        let content: Value = row.get(0);
        let revision: i64 = row.get(1);
        return Ok(Json(json!({
            "ok": true,
            "dedup": true,
            "project": content,
            "revision": revision
        })));
    }

    let tx = c.transaction().await?;
    let row = tx
        .query_opt(
            r#"SELECT revision FROM schema_projects WHERE id = $1 FOR UPDATE"#,
            &[&id],
        )
        .await?;
    let Some(row) = row else {
        return Err(ApiError::not_found());
    };
    let current: i64 = row.get(0);
    if current != body.base_revision {
        let snap = tx
            .query_one(
                "SELECT content_jsonb, revision FROM schema_projects WHERE id = $1",
                &[&id],
            )
            .await?;
        let content: Value = snap.get(0);
        let revision: i64 = snap.get(1);
        tx.rollback().await.ok();
        return Ok(Json(json!({
            "ok": false,
            "conflict": true,
            "project": content,
            "revision": revision
        })));
    }

    let name = body
        .project
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let description = body
        .project
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let app_type = body
        .project
        .get("app_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let content = serde_json::to_value(&body.project)?;
    let new_rev = current + 1;

    tx.execute(
        r#"
        UPDATE schema_projects
        SET name = $2, description = $3, app_type = $4, content_jsonb = $5,
            revision = $6, updated_at = NOW()
        WHERE id = $1
        "#,
        &[&id, &name, &description, &app_type, &content, &new_rev],
    )
    .await?;

    tx.execute(
        r#"
        INSERT INTO schema_project_ops (project_id, seq, author_user_id, client_op_id, payload_jsonb)
        VALUES ($1, $2, $3, $4, $5)
        "#,
        &[&id, &new_rev, &uid, &body.client_op_id, &content],
    )
    .await?;

    tx.commit().await?;

    let msg = serde_json::to_string(&json!({
        "type": "snapshot",
        "project_id": id,
        "revision": new_rev,
        "project": content,
        "from_user": uid
    }))
    .unwrap_or_default();
    if let Some(tx) = state.rooms.get(&id) {
        let _ = tx.send(msg);
    }

    Ok(Json(json!({
        "ok": true,
        "revision": new_rev,
        "project": content
    })))
}

#[derive(Deserialize)]
struct ShareCreateBody {
    permission: String,
}

async fn create_share(
    State(state): State<AppState>,
    axum::Extension(AuthUser(uid)): axum::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<ShareCreateBody>,
) -> Result<Json<Value>, ApiError> {
    if body.permission != "viewer" && body.permission != "editor" {
        return Err(ApiError::bad_request("permission must be viewer or editor"));
    }
    let c = state.pool.get().await?;
    if !can_edit(&c, id, &uid).await? {
        return Err(ApiError::forbidden("cannot share"));
    }

    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|_| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        msg: "rng failed",
    })?;
    let raw_token = hex::encode(bytes);
    let mut hasher = Sha256::new();
    hasher.update(raw_token.as_bytes());
    let token_hash = hex::encode(hasher.finalize());
    let link_id = Uuid::new_v4();

    c.execute(
        r#"
        INSERT INTO schema_share_links (id, token_hash, project_id, permission, created_by)
        VALUES ($1, $2, $3, $4, $5)
        "#,
        &[&link_id, &token_hash, &id, &body.permission, &uid],
    )
    .await?;

    Ok(Json(json!({
        "token": raw_token,
        "permission": body.permission,
        "project_id": id
    })))
}

async fn share_resolve(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut hasher = Sha256::new();
    hasher.update(token.trim().as_bytes());
    let token_hash = hex::encode(hasher.finalize());
    let c = state.pool.get().await?;
    let row = c
        .query_opt(
            r#"
            SELECT project_id, permission, expires_at
            FROM schema_share_links
            WHERE token_hash = $1
            "#,
            &[&token_hash],
        )
        .await?;
    let Some(row) = row else {
        return Err(ApiError::not_found());
    };
    let project_id: Uuid = row.get(0);
    let permission: String = row.get(1);
    let expires: Option<chrono::DateTime<chrono::Utc>> = row.get(2);
    if let Some(exp) = expires {
        if exp < chrono::Utc::now() {
            return Err(ApiError::not_found());
        }
    }
    let snap = c
        .query_one(
            "SELECT content_jsonb, revision FROM schema_projects WHERE id = $1",
            &[&project_id],
        )
        .await?;
    let content: Value = snap.get(0);
    let revision: i64 = snap.get(1);
    Ok(Json(json!({
        "project_id": project_id,
        "permission": permission,
        "project": content,
        "revision": revision
    })))
}

async fn project_access(c: &Object, project_id: Uuid, user_id: &str) -> Result<bool, ApiError> {
    let row = c
        .query_opt(
            r#"
            SELECT 1 FROM schema_projects p
            LEFT JOIN schema_project_members m ON m.project_id = p.id AND m.user_id = $2
            WHERE p.id = $1 AND (p.owner_user_id = $2 OR m.user_id IS NOT NULL)
            "#,
            &[&project_id, &user_id],
        )
        .await?;
    Ok(row.is_some())
}

async fn can_edit(c: &Object, project_id: Uuid, user_id: &str) -> Result<bool, ApiError> {
    let row = c
        .query_opt(
            r#"
            SELECT 1 FROM schema_projects p
            WHERE p.id = $1 AND p.owner_user_id = $2
            "#,
            &[&project_id, &user_id],
        )
        .await?;
    if row.is_some() {
        return Ok(true);
    }
    let row = c
        .query_opt(
            r#"
            SELECT role FROM schema_project_members
            WHERE project_id = $1 AND user_id = $2
            "#,
            &[&project_id, &user_id],
        )
        .await?;
    Ok(row.map(|r| r.get::<_, String>(0) == "editor" || r.get::<_, String>(0) == "owner")
        .unwrap_or(false))
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    msg: &'static str,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.msg)
    }
}

impl ApiError {
    fn bad_request(msg: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            msg,
        }
    }
    fn forbidden(msg: &'static str) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            msg,
        }
    }
    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            msg: "not found",
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.msg }))).into_response()
    }
}

impl From<deadpool_postgres::PoolError> for ApiError {
    fn from(_: deadpool_postgres::PoolError) -> Self {
        ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            msg: "db pool",
        }
    }
}

impl From<tokio_postgres::Error> for ApiError {
    fn from(_: tokio_postgres::Error) -> Self {
        ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            msg: "db error",
        }
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(_: serde_json::Error) -> Self {
        ApiError::bad_request("invalid json")
    }
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let auth = state.auth.clone();
    let bearer = q.token.trim();
    let sub = match verify_bearer_returns_sub(&auth, bearer).await {
        Ok(s) => s,
        Err(_) => {
            return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
        }
    };
    ws.on_upgrade(move |socket| handle_ws(socket, state, sub))
}

async fn handle_ws(socket: WebSocket, state: AppState, user_id: String) {
    let (mut sender, mut receiver) = socket.split();
    let mut subscribed: Option<Uuid> = None;
    let mut broadcast_rx: Option<broadcast::Receiver<String>> = None;

    loop {
        tokio::select! {
            biased;
            m = receiver.next() => {
                let Some(m) = m else { break };
                match m {
                    Ok(Message::Text(t)) => {
                        if let Err(e) = handle_ws_client_message(
                            &t,
                            &state,
                            &user_id,
                            &mut subscribed,
                            &mut broadcast_rx,
                            &mut sender,
                        ).await {
                            let _ = sender.send(Message::Text(
                                serde_json::to_string(&json!({ "type": "error", "message": e })).unwrap_or_default().into(),
                            )).await;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            recv_result = async {
                match &mut broadcast_rx {
                    Some(rx) => Some(rx.recv().await),
                    None => None,
                }
            }, if broadcast_rx.is_some() => {
                if let Some(Ok(text)) = recv_result {
                    let _ = sender.send(Message::Text(text.into())).await;
                }
            }
        }
    }
}

async fn handle_ws_client_message(
    text: &str,
    state: &AppState,
    user_id: &str,
    subscribed: &mut Option<Uuid>,
    broadcast_rx: &mut Option<broadcast::Receiver<String>>,
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
) -> Result<(), String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");

    match ty {
        "subscribe" => {
            let pid_str = v
                .get("project_id")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "project_id required".to_string())?;
            let pid = Uuid::parse_str(pid_str).map_err(|_| "bad project_id".to_string())?;
            let c = state.pool.get().await.map_err(|e| e.to_string())?;
            if !project_access(&c, pid, user_id)
                .await
                .map_err(|e| e.to_string())?
            {
                return Err("no access".into());
            }
            let tx = state
                .rooms
                .entry(pid)
                .or_insert_with(|| broadcast::channel(1024).0)
                .clone();
            *broadcast_rx = Some(tx.subscribe());
            *subscribed = Some(pid);
            let row = c
                .query_one(
                    "SELECT content_jsonb, revision FROM schema_projects WHERE id = $1",
                    &[&pid],
                )
                .await
                .map_err(|e| e.to_string())?;
            let content: Value = row.get(0);
            let revision: i64 = row.get(1);
            let out = serde_json::to_string(&json!({
                "type": "snapshot",
                "project_id": pid,
                "revision": revision,
                "project": content
            }))
            .map_err(|e| e.to_string())?;
            sender.send(Message::Text(out.into())).await.map_err(|e| e.to_string())?;
        }
        "push" => {
            let pid = subscribed.ok_or_else(|| "subscribe first".to_string())?;
            let base = v
                .get("base_revision")
                .and_then(|x| x.as_i64())
                .ok_or_else(|| "base_revision required".to_string())?;
            let client_op_id = v
                .get("client_op_id")
                .and_then(|x| x.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
                .ok_or_else(|| "client_op_id required".to_string())?;
            let project = v
                .get("project")
                .cloned()
                .ok_or_else(|| "project required".to_string())?;
            let patch = PatchBody {
                base_revision: base,
                client_op_id,
                project,
            };
            let res = apply_push_http(state, user_id, pid, patch).await?;
            sender
                .send(Message::Text(serde_json::to_string(&res).unwrap_or_default().into()))
                .await
                .map_err(|e| e.to_string())?;
        }
        "presence" => {
            let pid = subscribed.ok_or_else(|| "subscribe first".to_string())?;
            let x = v.get("x").and_then(|x| x.as_f64()).unwrap_or(0.);
            let y = v.get("y").and_then(|x| x.as_f64()).unwrap_or(0.);
            let node_id = v.get("node_id").and_then(|x| x.as_str()).unwrap_or("");
            let msg = serde_json::to_string(&json!({
                "type": "presence",
                "project_id": pid,
                "user_id": user_id,
                "x": x,
                "y": y,
                "node_id": node_id
            }))
            .unwrap_or_default();
            if let Some(tx) = state.rooms.get(&pid) {
                let _ = tx.send(msg);
            }
        }
        _ => return Err(format!("unknown type: {ty}")),
    }
    Ok(())
}

async fn apply_push_http(
    state: &AppState,
    user_id: &str,
    id: Uuid,
    body: PatchBody,
) -> Result<Value, String> {
    let mut c = state.pool.get().await.map_err(|e| e.to_string())?;
    if !can_edit(&c, id, user_id)
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("cannot edit".into());
    }

    let dup = c
        .query_opt(
            "SELECT 1 FROM schema_project_ops WHERE client_op_id = $1",
            &[&body.client_op_id],
        )
        .await
        .map_err(|e: tokio_postgres::Error| e.to_string())?;
    if dup.is_some() {
        let row = c
            .query_one(
                "SELECT content_jsonb, revision FROM schema_projects WHERE id = $1",
                &[&id],
            )
            .await
            .map_err(|e| e.to_string())?;
        let content: Value = row.get(0);
        let revision: i64 = row.get(1);
        return Ok(json!({
            "type": "push_result",
            "ok": true,
            "dedup": true,
            "revision": revision,
            "project": content
        }));
    }

    let tx = c.transaction().await.map_err(|e| e.to_string())?;
    let row = tx
        .query_opt(
            r#"SELECT revision FROM schema_projects WHERE id = $1 FOR UPDATE"#,
            &[&id],
        )
        .await
        .map_err(|e| e.to_string())?;
    let Some(row) = row else {
        return Err("not found".into());
    };
    let current: i64 = row.get(0);
    if current != body.base_revision {
        let snap = tx
            .query_one(
                "SELECT content_jsonb, revision FROM schema_projects WHERE id = $1",
                &[&id],
            )
            .await
            .map_err(|e| e.to_string())?;
        let content: Value = snap.get(0);
        let revision: i64 = snap.get(1);
        tx.rollback().await.ok();
        return Ok(json!({
            "type": "push_result",
            "ok": false,
            "conflict": true,
            "revision": revision,
            "project": content
        }));
    }

    let name = body
        .project
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let description = body
        .project
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let app_type = body
        .project
        .get("app_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let content = serde_json::to_value(&body.project).map_err(|e| e.to_string())?;
    let new_rev = current + 1;

    tx.execute(
        r#"
        UPDATE schema_projects
        SET name = $2, description = $3, app_type = $4, content_jsonb = $5,
            revision = $6, updated_at = NOW()
        WHERE id = $1
        "#,
        &[&id, &name, &description, &app_type, &content, &new_rev],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.execute(
        r#"
        INSERT INTO schema_project_ops (project_id, seq, author_user_id, client_op_id, payload_jsonb)
        VALUES ($1, $2, $3, $4, $5)
        "#,
        &[&id, &new_rev, &user_id, &body.client_op_id, &content],
    )
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    let msg = serde_json::to_string(&json!({
        "type": "snapshot",
        "project_id": id,
        "revision": new_rev,
        "project": content.clone(),
        "from_user": user_id
    }))
    .unwrap_or_default();
    if let Some(tx) = state.rooms.get(&id) {
        let _ = tx.send(msg);
    }

    Ok(json!({
        "type": "push_result",
        "ok": true,
        "revision": new_rev,
        "project": content
    }))
}
