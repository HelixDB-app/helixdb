mod auth_layer;
mod catalog_meta;
mod conn;
mod extended;
mod query_exec;
mod table_ops;
mod types;

use auth_layer::AuthState;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Request, StatusCode};
use axum::middleware::{from_fn, Next};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use conn::ConnectionManager;
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use types::{
    CapabilitiesResponse, ColumnInfo, ConnectRequest, ConnectionResponse, CreateColumnDef,
    EventTriggerInfo, ExecuteQueryBody, FunctionInfo, HealthResponse, PgSession, QueryResult,
    SchemaInfo, TableDetails, TableInfo, TableSearchBody, TopologyData, TypeDefinitionDetail,
    TypeInfo,
};

#[derive(Clone)]
struct AppState {
    connections: Arc<ConnectionManager>,
    redis_url: Option<String>,
    pool_max_size: usize,
    statement_timeout_ms: u64,
}

fn parse_cors_origins() -> Option<Vec<HeaderValue>> {
    let raw = env::var("DATA_PLANE_CORS_ORIGINS").ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for part in raw.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        out.push(HeaderValue::from_str(p).ok()?);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let api_key = env::var("DATA_PLANE_API_KEY").ok().filter(|s| !s.is_empty());
    let jwt_hs256_secret = env::var("DATA_PLANE_JWT_SECRET")
        .ok()
        .filter(|s| !s.is_empty());
    let jwt_issuer = env::var("DATA_PLANE_JWT_ISSUER")
        .ok()
        .filter(|s| !s.is_empty());
    let jwt_audience = env::var("DATA_PLANE_JWT_AUDIENCE")
        .ok()
        .filter(|s| !s.is_empty());
    let jwks_url = env::var("DATA_PLANE_JWKS_URL")
        .ok()
        .filter(|s| !s.is_empty());
    let jwks = jwks_url.map(|u| Arc::new(auth_layer::JwksCache::new(u)));
    let require_auth = env::var("DATA_PLANE_REQUIRE_AUTH")
        .ok()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));

    let auth = Arc::new(AuthState {
        api_key,
        jwt_hs256_secret,
        jwt_issuer,
        jwt_audience,
        jwks,
        require_auth,
    });

    if require_auth && !auth.any_verifier_configured() {
        tracing::warn!(
            "DATA_PLANE_REQUIRE_AUTH is set but no DATA_PLANE_API_KEY, DATA_PLANE_JWT_SECRET, or DATA_PLANE_JWKS_URL — /v1 routes will return 401"
        );
    }

    let redis_url = env::var("REDIS_URL").ok().filter(|s| !s.is_empty());
    let pool_max_size: usize = env::var("DATA_PLANE_POOL_MAX_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8);
    let statement_timeout_ms: u64 = env::var("DATA_PLANE_STATEMENT_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60_000);

    let state = AppState {
        connections: Arc::new(ConnectionManager::new()),
        redis_url,
        pool_max_size,
        statement_timeout_ms,
    };

    let cors_layer = if let Some(origins) = parse_cors_origins() {
        tracing::info!(
            "DATA_PLANE_CORS_ORIGINS: {} explicit origin(s)",
            origins.len()
        );
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        tracing::warn!(
            "DATA_PLANE_CORS_ORIGINS not set — allowing any origin (avoid in production; use a BFF or list origins)"
        );
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    let auth_for_mw = auth.clone();
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/connections", post(connect))
        .route(
            "/v1/connections/:connection_id",
            delete(disconnect).get(connection_ping),
        )
        .route(
            "/v1/connections/:connection_id/metadata/refresh",
            post(refresh_metadata),
        )
        .route(
            "/v1/connections/:connection_id/databases",
            get(list_connection_databases).post(create_database_http_handler),
        )
        .route(
            "/v1/connections/:connection_id/databases/:db_name",
            delete(drop_database_http_handler),
        )
        .route(
            "/v1/connections/:connection_id/event-triggers",
            get(list_connection_event_triggers),
        )
        .route(
            "/v1/connections/:connection_id/schemas",
            get(list_schemas),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/functions/:function_name/definition",
            get(get_function_definition_handler),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/functions",
            get(list_schema_functions),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/types/:type_name/definition",
            get(get_type_definition_handler),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/types/enum",
            post(create_enum_handler),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/types/:type_name/enum-values",
            patch(patch_enum_values_handler),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/types",
            get(list_schema_types),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/tables",
            get(list_tables).post(create_table_http_handler),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/tables/:table/search",
            post(table_search_handler),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/tables/:table/rows",
            get(get_rows),
        )
        .route(
            "/v1/connections/:connection_id/query",
            post(execute_query_handler),
        )
        .route(
            "/v1/connections/:connection_id/sessions",
            get(list_sessions),
        )
        .route(
            "/v1/connections/:connection_id/sessions/:pid/terminate",
            post(terminate_session),
        )
        .route(
            "/v1/connections/:connection_id/sessions/:pid/cancel",
            post(cancel_session),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/topology",
            get(get_topology),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/tables/:table/columns",
            get(get_table_columns),
        )
        .route(
            "/v1/connections/:connection_id/schemas/:schema/tables/:table/details",
            get(get_table_details_handler),
        )
        .with_state(state)
        .layer(from_fn(move |req: Request<Body>, next: Next| {
            let a = auth_for_mw.clone();
            async move { auth_layer::auth_middleware_inner(a, req, next).await }
        }))
        .layer(cors_layer)
        .layer(TraceLayer::new_for_http());

    let addr = env::var("DATA_PLANE_BIND")
        .unwrap_or_else(|_| "0.0.0.0:9847".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind");
    tracing::info!("helix-data-plane listening on http://{}", addr);
    axum::serve(listener, app).await.expect("serve");
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let redis = if let Some(ref url) = state.redis_url {
        match redis::Client::open(url.as_str()) {
            Ok(c) => match c.get_multiplexed_async_connection().await {
                Ok(mut conn) => match redis::cmd("PING").query_async::<String>(&mut conn).await {
                    Ok(_) => "ok",
                    Err(_) => "error",
                },
                Err(_) => "error",
            },
            Err(_) => "error",
        }
    } else {
        "skipped"
    };
    Json(HealthResponse {
        ok: true,
        redis: redis.to_string(),
    })
}

async fn capabilities() -> Json<CapabilitiesResponse> {
    Json(CapabilitiesResponse {
        version: "1".to_string(),
        ssh_tunnel: false,
        local_postgres: false,
    })
}

async fn connect(
    State(state): State<AppState>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<ConnectionResponse>, (StatusCode, String)> {
    let had_explicit_id = body
        .connection_id
        .as_ref()
        .is_some_and(|id| !id.is_empty());
    let connection_id = body
        .connection_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Saved profiles reuse a stable `connection_id`. The server pool may still exist after a
    // browser refresh, tab close, or failed disconnect — reconnect must replace it, not 409.
    if had_explicit_id && state.connections.disconnect(&connection_id) {
        tracing::info!(
            connection_id = %connection_id,
            "dropped existing pool before reconnect (explicit connection_id)"
        );
    }

    state
        .connections
        .connect(
            &connection_id,
            &body.connection_string,
            state.pool_max_size,
            state.statement_timeout_ms,
        )
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let (database_name, server_version) = table_ops::get_server_info(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let pg_version_num = state.connections.get_pg_version(&connection_id);

    Ok(Json(ConnectionResponse {
        connection_id,
        database_name,
        server_version,
        pg_version_num,
    }))
}

async fn disconnect(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    if state.connections.disconnect(&connection_id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "unknown connection_id".to_string()))
    }
}

async fn connection_ping(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let client = pool
        .get()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

/// No server-side metadata cache yet; returns fresh schema list (UI-compatible).
async fn refresh_metadata(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
) -> Result<Json<Vec<SchemaInfo>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let schemas = table_ops::list_schemas(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(schemas))
}

async fn list_connection_databases(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let names = catalog_meta::list_databases(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(names))
}

#[derive(Debug, Deserialize)]
struct CreateDatabaseHttpBody {
    name: String,
}

async fn create_database_http_handler(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
    Json(body): Json<CreateDatabaseHttpBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    catalog_meta::create_database(&pool, body.name.trim())
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn drop_database_http_handler(
    State(state): State<AppState>,
    Path((connection_id, db_name)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    catalog_meta::drop_database(&pool, &db_name)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_schema_functions(
    State(state): State<AppState>,
    Path((connection_id, schema)): Path<(String, String)>,
) -> Result<Json<Vec<FunctionInfo>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let pg_version = state.connections.get_pg_version(&connection_id);
    let list = catalog_meta::list_functions(&pool, &schema, pg_version)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(list))
}

async fn list_schema_types(
    State(state): State<AppState>,
    Path((connection_id, schema)): Path<(String, String)>,
) -> Result<Json<Vec<TypeInfo>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let list = catalog_meta::list_types(&pool, &schema)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(list))
}

async fn list_schemas(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
) -> Result<Json<Vec<SchemaInfo>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let schemas = table_ops::list_schemas(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(schemas))
}

async fn list_tables(
    State(state): State<AppState>,
    Path((connection_id, schema)): Path<(String, String)>,
) -> Result<Json<Vec<TableInfo>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let tables = table_ops::list_tables(&pool, &schema)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tables))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTableHttpBody {
    table: String,
    columns: Vec<CreateColumnDef>,
    if_not_exists: bool,
}

#[derive(Debug, Serialize)]
struct CreateTableSqlResponse {
    sql: String,
}

async fn create_table_http_handler(
    State(state): State<AppState>,
    Path((connection_id, schema)): Path<(String, String)>,
    Json(body): Json<CreateTableHttpBody>,
) -> Result<Json<CreateTableSqlResponse>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let sql = catalog_meta::create_table(
        &pool,
        &schema,
        body.table.trim(),
        &body.columns,
        body.if_not_exists,
    )
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(CreateTableSqlResponse { sql }))
}

#[derive(serde::Deserialize)]
struct RowsQuery {
    page: Option<u32>,
    page_size: Option<u32>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
}

async fn table_search_handler(
    State(state): State<AppState>,
    Path((connection_id, schema, table)): Path<(String, String, String)>,
    Json(body): Json<TableSearchBody>,
) -> Result<Json<QueryResult>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let limit = body.limit.unwrap_or(100);
    let page = body.page.unwrap_or(1);
    let sort_dir = body.sort_direction.as_deref().unwrap_or("ASC");
    let result = table_ops::search_table_data_multi(
        &pool,
        &schema,
        &table,
        &body.conditions,
        limit,
        page,
        body.sort_column.as_deref(),
        sort_dir,
    )
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(result))
}

async fn get_rows(
    State(state): State<AppState>,
    Path((connection_id, schema, table)): Path<(String, String, String)>,
    axum::extract::Query(q): axum::extract::Query<RowsQuery>,
) -> Result<Json<QueryResult>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let page = q.page.unwrap_or(1).max(1);
    let page_size = q.page_size.unwrap_or(50).clamp(1, 10_000);
    let result = table_ops::get_table_data(
        &pool,
        &schema,
        &table,
        page,
        page_size,
        q.sort_column.as_deref(),
        q.sort_direction.as_deref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(result))
}

async fn execute_query_handler(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
    Json(body): Json<ExecuteQueryBody>,
) -> Result<Json<QueryResult>, (StatusCode, String)> {
    let _ = (
        body.environment,
        body.guard_reason,
    );
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let result = query_exec::execute_query(&pool, &body.sql)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(result))
}

async fn list_sessions(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
) -> Result<Json<Vec<PgSession>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let sessions = extended::get_sessions(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(sessions))
}

async fn terminate_session(
    State(state): State<AppState>,
    Path((connection_id, pid)): Path<(String, i32)>,
) -> Result<Json<bool>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let ok = extended::terminate_backend(&pool, pid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(ok))
}

async fn cancel_session(
    State(state): State<AppState>,
    Path((connection_id, pid)): Path<(String, i32)>,
) -> Result<Json<bool>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let ok = extended::cancel_backend(&pool, pid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(ok))
}

async fn get_topology(
    State(state): State<AppState>,
    Path((connection_id, schema)): Path<(String, String)>,
) -> Result<Json<TopologyData>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let data = extended::get_schema_topology(&pool, &schema)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(data))
}

async fn get_table_columns(
    State(state): State<AppState>,
    Path((connection_id, schema, table)): Path<(String, String, String)>,
) -> Result<Json<Vec<ColumnInfo>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let cols = extended::get_columns(&pool, &schema, &table)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(cols))
}

async fn get_table_details_handler(
    State(state): State<AppState>,
    Path((connection_id, schema, table)): Path<(String, String, String)>,
) -> Result<Json<TableDetails>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let details = extended::get_table_details(&pool, &schema, &table)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(details))
}

async fn list_connection_event_triggers(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
) -> Result<Json<Vec<EventTriggerInfo>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let list = catalog_meta::list_event_triggers(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(list))
}

#[derive(Debug, Deserialize)]
struct FunctionDefinitionQuery {
    #[serde(default)]
    arguments: String,
}

async fn get_function_definition_handler(
    State(state): State<AppState>,
    Path((connection_id, schema, function_name)): Path<(String, String, String)>,
    Query(q): Query<FunctionDefinitionQuery>,
) -> Result<Json<Option<String>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let def = catalog_meta::get_function_definition(&pool, &schema, &function_name, &q.arguments)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(def))
}

async fn get_type_definition_handler(
    State(state): State<AppState>,
    Path((connection_id, schema, type_name)): Path<(String, String, String)>,
) -> Result<Json<Option<TypeDefinitionDetail>>, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    let detail = catalog_meta::get_type_definition(&pool, &schema, &type_name)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(detail))
}

#[derive(Debug, Deserialize)]
struct CreateEnumBody {
    name: String,
    values: Vec<String>,
}

async fn create_enum_handler(
    State(state): State<AppState>,
    Path((connection_id, schema)): Path<(String, String)>,
    Json(body): Json<CreateEnumBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    catalog_meta::create_enum(&pool, &schema, &body.name, &body.values)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct AlterEnumBody {
    renames: Vec<(String, String)>,
    additions: Vec<(String, Option<String>)>,
}

async fn patch_enum_values_handler(
    State(state): State<AppState>,
    Path((connection_id, schema, type_name)): Path<(String, String, String)>,
    Json(body): Json<AlterEnumBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    let pool = state
        .connections
        .get_pool(&connection_id)
        .map_err(|_| (StatusCode::NOT_FOUND, "unknown connection".to_string()))?;
    catalog_meta::alter_enum_values(
        &pool,
        &schema,
        &type_name,
        &body.renames,
        &body.additions,
    )
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState {
            connections: Arc::new(ConnectionManager::new()),
            redis_url: None,
            pool_max_size: 2,
            statement_timeout_ms: 30_000,
        }
    }

    fn test_auth() -> Arc<AuthState> {
        Arc::new(AuthState {
            api_key: Some("secret".to_string()),
            jwt_hs256_secret: None,
            jwt_issuer: None,
            jwt_audience: None,
            jwks: None,
            require_auth: false,
        })
    }

    fn app(state: AppState) -> Router {
        let auth = test_auth();
        let auth_for_mw = auth.clone();
        Router::new()
            .route("/health", get(health))
            .route("/v1/capabilities", get(capabilities))
            .route("/v1/connections", post(connect))
            .route(
                "/v1/connections/:connection_id",
                delete(disconnect),
            )
            .route(
                "/v1/connections/:connection_id/schemas",
                get(list_schemas),
            )
            .with_state(state)
            .layer(from_fn(move |req: Request<Body>, next: Next| {
                let a = auth_for_mw.clone();
                async move { auth_layer::auth_middleware_inner(a, req, next).await }
            }))
    }

    #[tokio::test]
    async fn rejects_missing_api_key_when_configured() {
        let s = test_state();
        let app = app(s);
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/v1/connections")
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn health_without_redis() {
        let s = test_state();
        let app = Router::new()
            .route("/health", get(health))
            .with_state(s);
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let v: HealthResponse = serde_json::from_slice(&body).unwrap();
        assert!(v.ok);
        assert_eq!(v.redis, "skipped");
    }
}
