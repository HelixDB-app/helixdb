use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::account_security_storage;
use crate::connections_storage::{self, SavedConnection};
use crate::db::types::{ColumnStats, FilterCondition};
use crate::db::{
    cache::MetadataCache,
    connection::ConnectionManager,
    queries,
    sandbox::{SandboxManager, SandboxResult},
    types::{TableDetails, TopologyData, TypeDefinitionDetail, *},
    watcher::WatchManager,
};
use crate::local_postgres::{self, LocalPostgresStatus};
use crate::query_history_storage::{self, QueryHistoryRecordInput};

/// Application state shared across all Tauri commands
pub struct AppState {
    pub conn_manager: ConnectionManager,
    pub cache: MetadataCache,
    pub watch_manager: WatchManager,
    pub sandbox_manager: SandboxManager,
    pub recent_tables: Mutex<HashMap<String, Vec<RecentTableOpen>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            conn_manager: ConnectionManager::new(),
            cache: MetadataCache::new(),
            watch_manager: WatchManager::new(),
            sandbox_manager: SandboxManager::new(),
            recent_tables: Mutex::new(HashMap::new()),
        }
    }

    pub fn list_recent_tables(&self, connection_id: &str, limit: usize) -> Vec<RecentTableOpen> {
        let map = self
            .recent_tables
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.get(connection_id)
            .map(|items| items.iter().take(limit).cloned().collect())
            .unwrap_or_default()
    }

    pub fn track_recent_table_open(
        &self,
        connection_id: &str,
        schema: String,
        table: String,
        table_type: String,
        opened_at: i64,
    ) {
        const MAX_RECENT_TABLES: usize = 20;

        let mut map = self
            .recent_tables
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let list = map.entry(connection_id.to_string()).or_default();
        list.retain(|item| !(item.schema == schema && item.table == table));
        list.insert(
            0,
            RecentTableOpen {
                schema,
                table,
                table_type,
                opened_at,
            },
        );
        if list.len() > MAX_RECENT_TABLES {
            list.truncate(MAX_RECENT_TABLES);
        }
    }
}

/// Connect to a PostgreSQL database.
/// If `connection_id` is provided and not already connected, it is used (e.g. for reconnecting a saved connection);
/// otherwise a new UUID is generated.
#[tauri::command]
pub async fn db_connect(
    state: State<'_, AppState>,
    connection_string: String,
    connection_id: Option<String>,
) -> Result<ConnectionResponse, String> {
    let connection_id = connection_id
        .filter(|id| !id.is_empty())
        .filter(|id| !state.conn_manager.is_connected(id))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    state
        .conn_manager
        .connect(&connection_id, &connection_string)
        .await?;

    // Get server info and numeric version
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let (db_name, version) = queries::get_server_info(&pool).await?;
    let pg_version_num = state.conn_manager.get_pg_version(&connection_id);

    Ok(ConnectionResponse {
        connection_id,
        database_name: db_name,
        server_version: version,
        pg_version_num,
    })
}

/// Disconnect from a database
#[tauri::command]
pub async fn db_disconnect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<bool, String> {
    state.watch_manager.stop_all_for_connection(&connection_id);
    state.cache.invalidate(&connection_id);
    Ok(state.conn_manager.disconnect(&connection_id))
}

/// List schemas (with caching)
#[tauri::command]
pub async fn db_list_schemas(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SchemaInfo>, String> {
    // Check cache first
    if let Some(cached) = state.cache.get_schemas(&connection_id) {
        return Ok(cached);
    }

    let pool = state.conn_manager.get_pool(&connection_id)?;
    let schemas = queries::list_schemas(&pool).await?;

    state.cache.set_schemas(&connection_id, schemas.clone());
    Ok(schemas)
}

/// List tables in a schema (with caching)
#[tauri::command]
pub async fn db_list_tables(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> Result<Vec<TableInfo>, String> {
    // Check cache first
    if let Some(cached) = state.cache.get_tables(&connection_id, &schema) {
        return Ok(cached);
    }

    let pool = state.conn_manager.get_pool(&connection_id)?;
    let tables = queries::list_tables(&pool, &schema).await?;

    state
        .cache
        .set_tables(&connection_id, &schema, tables.clone());
    Ok(tables)
}

/// Track a table/view open action and return the refreshed recent list.
#[tauri::command]
pub async fn db_track_recent_table_open(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    table_type: Option<String>,
) -> Result<Vec<RecentTableOpen>, String> {
    let normalized_type = match table_type.as_deref() {
        Some("VIEW") => "VIEW".to_string(),
        _ => "BASE TABLE".to_string(),
    };

    state.track_recent_table_open(
        &connection_id,
        schema,
        table,
        normalized_type,
        chrono::Utc::now().timestamp_millis(),
    );
    Ok(state.list_recent_tables(&connection_id, 8))
}

/// Return recent table/view selections for a connection.
#[tauri::command]
pub async fn db_list_recent_tables(
    state: State<'_, AppState>,
    connection_id: String,
    limit: Option<u32>,
) -> Result<Vec<RecentTableOpen>, String> {
    let max = limit.unwrap_or(8).clamp(1, 20) as usize;
    Ok(state.list_recent_tables(&connection_id, max))
}

/// Get schema topology (nodes + FK edges) for ER diagram. Not cached.
#[tauri::command]
pub async fn db_get_schema_topology(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> Result<TopologyData, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_schema_topology(&pool, &schema).await
}

/// Get columns for a table (with caching)
#[tauri::command]
pub async fn db_get_columns(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    // Check cache first
    if let Some(cached) = state.cache.get_columns(&connection_id, &schema, &table) {
        return Ok(cached);
    }

    let pool = state.conn_manager.get_pool(&connection_id)?;
    let columns = queries::get_columns(&pool, &schema, &table).await?;

    state
        .cache
        .set_columns(&connection_id, &schema, &table, columns.clone());
    Ok(columns)
}

/// Get complete schema documentation context for AI comment generation.
#[tauri::command]
pub async fn db_get_documentation_context(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
) -> Result<DocumentationContext, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_documentation_context(&pool, schema.as_deref()).await
}

/// Apply COMMENT ON statements in one transaction.
#[tauri::command]
pub async fn db_apply_documentation_comments(
    state: State<'_, AppState>,
    connection_id: String,
    patches: Vec<DocumentationCommentPatch>,
) -> Result<u64, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let applied = queries::apply_documentation_comments(&pool, &patches).await?;
    state.cache.invalidate(&connection_id);
    Ok(applied)
}

fn is_created_at_column(name: &str) -> bool {
    let lower = name.to_lowercase();
    matches!(
        lower.as_str(),
        "created_at" | "createdat" | "create_date" | "creation_date" | "date_created" | "created"
    )
}

fn infer_connection_label(connection_string: Option<String>, fallback: &str) -> String {
    let Some(raw) = connection_string else {
        return fallback.to_string();
    };
    if let Ok(cfg) = raw.parse::<tokio_postgres::Config>() {
        if let Some(db) = cfg.get_dbname() {
            let db_name = db.to_string();
            if !db_name.is_empty() {
                return db_name;
            }
        }
    }
    fallback.to_string()
}

fn extract_error_code(message: Option<&str>) -> Option<String> {
    let text = message?;

    if let Some(idx) = text.find("SqlState(") {
        let rest = &text[idx + "SqlState(".len()..];
        if let Some(end) = rest.find(')') {
            let code = &rest[..end];
            if !code.trim().is_empty() {
                return Some(code.trim().to_string());
            }
        }
    }

    if let Some(idx) = text.to_ascii_uppercase().find("SQLSTATE") {
        let rest = &text[idx..];
        let code: String = rest
            .chars()
            .skip_while(|c| !c.is_ascii_alphanumeric())
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if code.len() == 5 {
            return Some(code);
        }
    }

    None
}

fn extract_rows_affected(result: &QueryResult) -> Option<i64> {
    if result.columns.len() == 1 && result.columns[0].name == "affected_rows" {
        if let Some(first_row) = result.rows.first() {
            if let Some(cell) = first_row.first() {
                return match cell {
                    CellValue::Int64(v) => Some(*v),
                    CellValue::Int32(v) => Some(*v as i64),
                    CellValue::Int16(v) => Some(*v as i64),
                    _ => None,
                };
            }
        }
    }
    None
}

fn reminder_scope_for_connection(state: &AppState, connection_id: &str) -> String {
    let Some(connection_string) = state.conn_manager.get_connection_string(connection_id) else {
        return connection_id.to_string();
    };

    let Ok(cfg) = connection_string.parse::<tokio_postgres::Config>() else {
        return connection_id.to_string();
    };

    let host = cfg
        .get_hosts()
        .first()
        .map(|host| match host {
            tokio_postgres::config::Host::Tcp(value) => value.clone(),
            #[cfg(unix)]
            tokio_postgres::config::Host::Unix(path) => path.to_string_lossy().to_string(),
        })
        .unwrap_or_else(|| "localhost".to_string());

    let port = cfg.get_ports().first().copied().unwrap_or(5432);
    let db_name = cfg
        .get_dbname()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "postgres".to_string());
    let username = cfg
        .get_user()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    format!("{}@{}:{}/{}", username, host, port, db_name)
}

/// Get paginated table data. When no sort is given, defaults to ORDER BY created_at (or similar) DESC so newest rows appear first.
#[tauri::command]
pub async fn db_get_table_data(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    page: u32,
    page_size: u32,
    sort_column: Option<String>,
    sort_direction: Option<String>,
) -> Result<QueryResult, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let (sort_col, sort_dir): (Option<String>, Option<String>) = if sort_column.is_some() {
        (sort_column, sort_direction)
    } else if let Some(columns) = state.cache.get_columns(&connection_id, &schema, &table) {
        columns
            .iter()
            .find(|c| is_created_at_column(&c.name))
            .map(|c| (Some(c.name.clone()), Some("DESC".to_string())))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };
    queries::get_table_data(
        &pool,
        &schema,
        &table,
        page,
        page_size,
        sort_col.as_deref(),
        sort_dir.as_deref(),
    )
    .await
}

/// Get table data with geometry columns as GeoJSON for map view. Limit capped at 10000.
#[tauri::command]
pub async fn db_get_table_data_geojson(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    geometry_column_names: Vec<String>,
    limit: u32,
) -> Result<QueryResult, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_table_data_geojson(
        &pool,
        &schema,
        &table,
        geometry_column_names,
        limit,
    )
    .await
}

/// Execute a raw SQL query
#[tauri::command]
pub async fn db_execute_query(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    sql: String,
    environment: Option<String>,
    guard_reason: Option<String>,
) -> Result<QueryResult, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let query_start = std::time::Instant::now();
    let executed_at = chrono::Utc::now().timestamp_millis();
    let environment = environment
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "dev" | "staging" | "prod"));
    let guard_reason = guard_reason
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let connection_label = infer_connection_label(
        state.conn_manager.get_connection_string(&connection_id),
        &connection_id,
    );
    let app_data_dir = app.path().app_data_dir().ok();

    match queries::execute_query(&pool, &sql).await {
        Ok(result) => {
            let rows_affected = extract_rows_affected(&result);
            let rows_returned = if result.is_error || rows_affected.is_some() {
                None
            } else {
                Some(result.row_count as i64)
            };

            let status = if result.is_error { "failed" } else { "success" }.to_string();
            let error_message = result.error_message.clone();
            let error_code = extract_error_code(error_message.as_deref());
            let record = QueryHistoryRecordInput {
                query_text: sql.clone(),
                connection_id: connection_id.clone(),
                connection_label,
                environment: environment.clone(),
                guard_reason: guard_reason.clone(),
                executed_at,
                planning_ms: None,
                execution_ms: result.execution_time_ms,
                total_ms: result.execution_time_ms,
                rows_returned,
                rows_affected,
                status,
                error_code,
                error_message,
                explain_json: None,
                blks_hit: None,
                blks_read: None,
                temp_blks_written: None,
                query_type: None,
                tables_touched: None,
                was_cached: false,
            };

            tokio::task::spawn_blocking(move || {
                let _ = query_history_storage::record_query(app_data_dir, record);
            });

            Ok(result)
        }
        Err(err) => {
            let elapsed_ms = query_start.elapsed().as_secs_f64() * 1000.0;
            let error_message = Some(err.clone());
            let record = QueryHistoryRecordInput {
                query_text: sql,
                connection_id,
                connection_label,
                environment,
                guard_reason,
                executed_at,
                planning_ms: None,
                execution_ms: elapsed_ms,
                total_ms: elapsed_ms,
                rows_returned: None,
                rows_affected: None,
                status: "failed".to_string(),
                error_code: extract_error_code(error_message.as_deref()),
                error_message,
                explain_json: None,
                blks_hit: None,
                blks_read: None,
                temp_blks_written: None,
                query_type: None,
                tables_touched: None,
                was_cached: false,
            };

            tokio::task::spawn_blocking(move || {
                let _ = query_history_storage::record_query(app_data_dir, record);
            });

            Err(err)
        }
    }
}

/// Export database to SQL file. Emits "db-export-progress" events during export.
#[tauri::command]
pub async fn db_export_sql(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ExportRequest,
) -> Result<ExportResult, String> {
    let pool = state.conn_manager.get_pool(&request.connection_id)?;
    let progress = |payload: ExportProgressPayload| {
        let _ = app.emit("db-export-progress", &payload);
    };
    queries::run_sql_export(&pool, &request, progress).await
}

/// List all databases on the connected server
#[tauri::command]
pub async fn db_list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::list_databases(&pool).await
}

/// Return the access profile for the currently connected DB role.
#[tauri::command]
pub async fn db_get_access_profile(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DatabaseAccessProfile, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_database_access_profile(&pool).await
}

/// List all available extensions, including install permission metadata.
#[tauri::command]
pub async fn db_list_extensions(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DatabaseExtensionInfo>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::list_database_extensions(&pool).await
}

/// Install an extension with server-side permission enforcement.
#[tauri::command]
pub async fn db_install_extension(
    state: State<'_, AppState>,
    connection_id: String,
    extension_name: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::install_database_extension(&pool, &extension_name).await
}

/// Get rich metadata for one extension (versions, owner, permissions).
#[tauri::command]
pub async fn db_get_extension_detail(
    state: State<'_, AppState>,
    connection_id: String,
    extension_name: String,
) -> Result<DatabaseExtensionDetail, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_database_extension_detail(&pool, &extension_name).await
}

/// Uninstall an extension with permission checks.
#[tauri::command]
pub async fn db_uninstall_extension(
    state: State<'_, AppState>,
    connection_id: String,
    extension_name: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::uninstall_database_extension(&pool, &extension_name).await
}

/// Update an installed extension to latest/default or a specific version.
#[tauri::command]
pub async fn db_update_extension(
    state: State<'_, AppState>,
    connection_id: String,
    extension_name: String,
    target_version: Option<String>,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::update_database_extension(&pool, &extension_name, target_version.as_deref()).await
}

/// List all roles in the database cluster with RBAC assignment metadata.
#[tauri::command]
pub async fn db_list_database_roles(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DatabaseRoleInfo>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::list_database_roles(&pool).await
}

/// List database roles with account fields used by user-management views.
#[tauri::command]
pub async fn db_list_database_users(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DatabaseUserInfo>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::list_database_users(&pool).await
}

/// Create a custom NOLOGIN RBAC role.
#[tauri::command]
pub async fn db_create_database_role(
    state: State<'_, AppState>,
    connection_id: String,
    request: CreateDatabaseRoleRequest,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::create_database_role(&pool, &request).await
}

/// Get detailed metadata for one RBAC role.
#[tauri::command]
pub async fn db_get_database_role_detail(
    state: State<'_, AppState>,
    connection_id: String,
    role_name: String,
) -> Result<DatabaseRoleDetail, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_database_role_detail(&pool, &role_name).await
}

/// Grant role membership (optionally with ADMIN OPTION).
#[tauri::command]
pub async fn db_grant_database_role_membership(
    state: State<'_, AppState>,
    connection_id: String,
    role_name: String,
    member_name: String,
    with_admin_option: bool,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::grant_database_role_membership(
        &pool,
        &role_name,
        &member_name,
        with_admin_option,
    )
    .await
}

/// Revoke role membership.
#[tauri::command]
pub async fn db_revoke_database_role_membership(
    state: State<'_, AppState>,
    connection_id: String,
    role_name: String,
    member_name: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::revoke_database_role_membership(&pool, &role_name, &member_name).await
}

/// Create a new login role and optional role memberships.
#[tauri::command]
pub async fn db_create_database_user(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    request: CreateDatabaseUserRequest,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let reminder = request
        .password_reminder
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let username = request.username.clone();

    queries::create_database_user(&pool, &request).await?;

    if let Some(reminder_text) = reminder {
        let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let scope = reminder_scope_for_connection(&state, &connection_id);
        account_security_storage::upsert_for_scope(
            Some(app_data_dir),
            &scope,
            &username,
            &reminder_text,
        )?;
    }

    Ok(())
}

/// Set whether a database role can login (active/inactive account).
#[tauri::command]
pub async fn db_set_database_user_login(
    state: State<'_, AppState>,
    connection_id: String,
    username: String,
    can_login: bool,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::set_database_user_login(&pool, &username, can_login).await
}

/// Update password for an existing database user.
#[tauri::command]
pub async fn db_set_database_user_password(
    state: State<'_, AppState>,
    connection_id: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::set_database_user_password(&pool, &username, &password).await
}

/// Delete a database user role. Optionally reassign owned objects first.
#[tauri::command]
pub async fn db_delete_database_user(
    state: State<'_, AppState>,
    connection_id: String,
    username: String,
    reassign_owned_to: Option<String>,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::delete_database_user(&pool, &username, reassign_owned_to.as_deref()).await
}

/// List locally stored password reminders for the current connection scope.
#[tauri::command]
pub async fn db_list_password_reminders(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<account_security_storage::PasswordReminder>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let scope = reminder_scope_for_connection(&state, &connection_id);
    account_security_storage::list_for_scope(Some(app_data_dir), &scope)
}

/// Delete one local password reminder in the current connection scope.
#[tauri::command]
pub async fn db_delete_password_reminder(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    id: String,
) -> Result<Vec<account_security_storage::PasswordReminder>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let scope = reminder_scope_for_connection(&state, &connection_id);
    account_security_storage::delete_for_scope(Some(app_data_dir), &scope, &id)
}

/// Create a new database
#[tauri::command]
pub async fn db_create_database(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::create_database(&pool, &name).await
}

/// Drop a database
#[tauri::command]
pub async fn db_drop_database(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::drop_database(&pool, &name).await
}

/// List event triggers (database level)
#[tauri::command]
pub async fn db_list_event_triggers(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<EventTriggerInfo>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::list_event_triggers(&pool).await
}

/// List functions and procedures in a schema
#[tauri::command]
pub async fn db_list_functions(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> Result<Vec<FunctionInfo>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let pg_version = state.conn_manager.get_pg_version(&connection_id);
    queries::list_functions(&pool, &schema, pg_version).await
}

/// List user-defined types in a schema
#[tauri::command]
pub async fn db_list_types(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> Result<Vec<TypeInfo>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::list_types(&pool, &schema).await
}

/// Return the numeric PostgreSQL version for a connection (e.g. 160004).
#[tauri::command]
pub async fn db_get_pg_version(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<u32, String> {
    Ok(state.conn_manager.get_pg_version(&connection_id))
}

/// Get full CREATE FUNCTION/PROCEDURE source for preview.
#[tauri::command]
pub async fn db_get_function_definition(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    name: String,
    arguments: String,
) -> Result<Option<String>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_function_definition(&pool, &schema, &name, &arguments).await
}

/// Get type definition details (enum labels, composite attrs, domain, range).
#[tauri::command]
pub async fn db_get_type_definition(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    name: String,
) -> Result<Option<TypeDefinitionDetail>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_type_definition(&pool, &schema, &name).await
}

/// Create a new enum type. Values must be non-empty.
#[tauri::command]
pub async fn db_create_enum(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    name: String,
    values: Vec<String>,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::create_enum(&pool, &schema, &name, &values).await
}

/// Alter enum: rename values and/or add new values. Single transaction.
#[tauri::command]
pub async fn db_alter_enum_values(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    name: String,
    renames: Vec<(String, String)>,
    additions: Vec<(String, Option<String>)>,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::alter_enum_values(&pool, &schema, &name, &renames, &additions).await
}

#[derive(serde::Deserialize)]
pub struct UpdateItem {
    column: String,
    value: Option<String>,
}

/// Insert one table row. Values: (column, value); omit column or use null to use DEFAULT/NULL.
#[tauri::command]
pub async fn db_insert_table_row(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    values: Vec<UpdateItem>,
) -> Result<u64, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let values_tuples: Vec<(String, Option<String>)> =
        values.into_iter().map(|u| (u.column, u.value)).collect();
    queries::insert_table_row(&pool, &schema, &table, &values_tuples).await
}

/// Insert multiple table rows in a single transaction. All-or-nothing.
#[tauri::command]
pub async fn db_insert_table_rows_bulk(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    rows: Vec<Vec<UpdateItem>>,
) -> Result<u64, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let rows_tuples: Vec<Vec<(String, Option<String>)>> = rows
        .into_iter()
        .map(|row| row.into_iter().map(|u| (u.column, u.value)).collect())
        .collect();
    queries::insert_table_rows_bulk(&pool, &schema, &table, &rows_tuples).await
}

/// Update one table row by primary key. Returns rows affected (0 or 1).
#[tauri::command]
pub async fn db_update_table_row(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    pk_columns: Vec<String>,
    pk_values: Vec<Option<String>>,
    updates: Vec<UpdateItem>,
) -> Result<u64, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let updates_tuples: Vec<(String, Option<String>)> =
        updates.into_iter().map(|u| (u.column, u.value)).collect();
    queries::update_table_row(
        &pool,
        &schema,
        &table,
        &pk_columns,
        &pk_values,
        &updates_tuples,
    )
    .await
}

/// Delete table rows by primary key. `rows_pk_values` is an array of rows, each row an array of PK values in same order as pk_columns.
#[tauri::command]
pub async fn db_delete_table_rows(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    pk_columns: Vec<String>,
    rows_pk_values: Vec<Vec<Option<String>>>,
) -> Result<u64, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::delete_table_rows(&pool, &schema, &table, &pk_columns, &rows_pk_values).await
}

/// Structured filter search: SELECT * FROM schema.table WHERE col OP value LIMIT limit.
/// Operator is whitelisted; value is a bind parameter for safety.
#[tauri::command]
pub async fn db_search_table_data(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    column: String,
    operator: String,
    value: Option<String>,
    limit: Option<u32>,
) -> Result<QueryResult, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::search_table_data(
        &pool,
        &schema,
        &table,
        &column,
        &operator,
        value.as_deref(),
        limit.unwrap_or(200),
    )
    .await
}

/// Invalidate all caches for a connection and refetch schemas
#[tauri::command]
pub async fn db_refresh_cache(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SchemaInfo>, String> {
    state.cache.invalidate(&connection_id);
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let schemas = queries::list_schemas(&pool).await?;
    state.cache.set_schemas(&connection_id, schemas.clone());
    Ok(schemas)
}

// ---------- Table details & DDL ----------

/// Get full table details: columns, constraints, indexes, triggers, stats
#[tauri::command]
pub async fn db_get_table_details(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<TableDetails, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_table_details(&pool, &schema, &table).await
}

/// Rename a table
#[tauri::command]
pub async fn db_rename_table(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    new_name: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::rename_table(&pool, &schema, &table, &new_name).await?;
    // Invalidate cache so sidebar refreshes
    state.cache.invalidate_tables(&connection_id, &schema);
    Ok(())
}

/// Rename a column
#[tauri::command]
pub async fn db_rename_column(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    column: String,
    new_name: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::rename_column(&pool, &schema, &table, &column, &new_name).await?;
    state
        .cache
        .invalidate_columns(&connection_id, &schema, &table);
    Ok(())
}

/// Alter column: change type, default, or nullability
#[tauri::command]
pub async fn db_alter_column(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    column: String,
    new_type: Option<String>,
    new_default: Option<String>,
    nullable: Option<bool>,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::alter_column(
        &pool,
        &schema,
        &table,
        &column,
        new_type.as_deref(),
        new_default.as_deref(),
        nullable,
    )
    .await?;
    state
        .cache
        .invalidate_columns(&connection_id, &schema, &table);
    Ok(())
}

/// Add a column
#[tauri::command]
pub async fn db_add_column(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    column: String,
    data_type: String,
    is_nullable: bool,
    default_value: Option<String>,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::add_column(
        &pool,
        &schema,
        &table,
        &column,
        &data_type,
        is_nullable,
        default_value.as_deref(),
    )
    .await?;
    state
        .cache
        .invalidate_columns(&connection_id, &schema, &table);
    Ok(())
}

/// Drop a column
#[tauri::command]
pub async fn db_drop_column(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    column: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::drop_column(&pool, &schema, &table, &column).await?;
    state
        .cache
        .invalidate_columns(&connection_id, &schema, &table);
    Ok(())
}

/// Truncate a table (removes all rows, resets sequences)
#[tauri::command]
pub async fn db_truncate_table(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::truncate_table(&pool, &schema, &table).await?;
    state.cache.invalidate_tables(&connection_id, &schema);
    Ok(())
}

/// Create a new table with the given column definitions.
/// Returns the generated CREATE TABLE SQL string on success.
#[tauri::command]
pub async fn db_create_table(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    columns: Vec<crate::db::types::CreateColumnDef>,
    if_not_exists: bool,
) -> Result<String, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let sql = queries::create_table(&pool, &schema, &table, &columns, if_not_exists).await?;
    // Invalidate caches so the sidebar picks up the new table immediately
    state.cache.invalidate_tables(&connection_id, &schema);
    Ok(sql)
}

/// Drop a table
#[tauri::command]
pub async fn db_drop_table(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    cascade: bool,
) -> Result<(), String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::drop_table(&pool, &schema, &table, cascade).await?;
    state.cache.invalidate_tables(&connection_id, &schema);
    Ok(())
}

// ---------- Saved connections (persisted in app data dir) ----------

#[tauri::command]
pub async fn get_saved_connections(app: AppHandle) -> Result<Vec<SavedConnection>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    connections_storage::load(Some(app_data_dir))
}

#[tauri::command]
pub async fn save_connection(
    app: AppHandle,
    connection: SavedConnection,
) -> Result<Vec<SavedConnection>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    connections_storage::save(Some(app_data_dir), connection)
}

#[tauri::command]
pub async fn delete_saved_connection(
    app: AppHandle,
    id: String,
) -> Result<Vec<SavedConnection>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    connections_storage::delete(Some(app_data_dir), &id)
}

#[tauri::command]
pub async fn update_saved_connection_database_name(
    app: AppHandle,
    id: String,
    database_name: String,
) -> Result<Vec<SavedConnection>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    connections_storage::update_database_name(Some(app_data_dir), &id, database_name)
}

/// Compute statistics for a single column (null%, distinct count, min, max, avg, top values).
#[tauri::command]
pub async fn db_get_column_stats(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    column: String,
) -> Result<ColumnStats, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_column_stats(&pool, &schema, &table, &column).await
}

/// Multi-condition structured table search with pagination and sort.
#[tauri::command]
pub async fn db_search_table_data_multi(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    conditions: Vec<FilterCondition>,
    limit: Option<u32>,
    page: Option<u32>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
) -> Result<QueryResult, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::search_table_data_multi(
        &pool,
        &schema,
        &table,
        &conditions,
        limit.unwrap_or(100),
        page.unwrap_or(1),
        sort_column.as_deref(),
        sort_direction.as_deref().unwrap_or("ASC"),
    )
    .await
}

// ─── Live Table Watcher ────────────────────────────────────────────────────

/// Start watching a table for real-time INSERT / UPDATE / DELETE events.
/// Creates an AFTER trigger in the database and opens a dedicated LISTEN connection.
/// Emits Tauri events named `tw||<connection_id>||<schema>||<table>`.
#[tauri::command]
pub async fn db_watch_table(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<(), String> {
    let conn_str = state
        .conn_manager
        .get_connection_string(&connection_id)
        .ok_or_else(|| format!("No connection found with ID: {connection_id}"))?;
    state
        .watch_manager
        .start_watch(app, connection_id, schema, table, conn_str)
        .await
}

/// Stop watching a table and drop the associated trigger from the database.
#[tauri::command]
pub async fn db_unwatch_table(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<(), String> {
    let conn_str = state.conn_manager.get_connection_string(&connection_id);
    state
        .watch_manager
        .stop_watch(&connection_id, &schema, &table, conn_str.as_deref())
        .await;
    Ok(())
}

/// Returns whether a table is currently being watched.
#[tauri::command]
pub async fn db_is_watching(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<bool, String> {
    Ok(state
        .watch_manager
        .is_watching(&connection_id, &schema, &table))
}

// ─── Session Monitor ──────────────────────────────────────────────────────

/// Fetch all active sessions from pg_stat_activity (requires superuser or pg_monitor role).
#[tauri::command]
pub async fn db_get_sessions(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<crate::db::types::PgSession>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_sessions(&pool).await
}

/// Terminate a backend process (SIGTERM). Returns true if signal was sent.
#[tauri::command]
pub async fn db_terminate_backend(
    state: State<'_, AppState>,
    connection_id: String,
    pid: i32,
) -> Result<bool, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::terminate_backend(&pool, pid).await
}

/// Cancel the current query of a backend (SIGINT — gentler than terminate).
#[tauri::command]
pub async fn db_cancel_backend(
    state: State<'_, AppState>,
    connection_id: String,
    pid: i32,
) -> Result<bool, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::cancel_backend(&pool, pid).await
}

// ─── Local PostgreSQL ──────────────────────────────────────────────────────

/// Detect if local PostgreSQL is installed and running.
#[tauri::command]
pub async fn local_postgres_check() -> Result<LocalPostgresStatus, String> {
    Ok(local_postgres::check_local_postgres().await)
}

/// Start the local PostgreSQL service.
#[tauri::command]
pub async fn local_postgres_start() -> Result<LocalPostgresStatus, String> {
    local_postgres::start_local_postgres().await
}

/// Stop the local PostgreSQL service.
#[tauri::command]
pub async fn local_postgres_stop() -> Result<LocalPostgresStatus, String> {
    local_postgres::stop_local_postgres().await
}

/// Restart the local PostgreSQL service.
#[tauri::command]
pub async fn local_postgres_restart() -> Result<LocalPostgresStatus, String> {
    local_postgres::restart_local_postgres().await
}

/// Install PostgreSQL (emits progress events to the frontend).
#[tauri::command]
pub async fn local_postgres_install(app: AppHandle) -> Result<LocalPostgresStatus, String> {
    local_postgres::install_local_postgres(&app).await
}

// ─── Visual Query Plan ─────────────────────────────────────────────────────

/// Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on a SQL statement and return
/// the raw JSON string. The frontend parses and visualises the plan tree.
#[tauri::command]
pub async fn db_explain_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<String, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let client = pool.get().await.map_err(|e| e.to_string())?;

    // Wrap in a transaction so we can ROLLBACK any side-effects from DML
    client
        .execute("BEGIN", &[])
        .await
        .map_err(|e| e.to_string())?;

    let explain_sql = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}");
    let result = client.query(&explain_sql, &[]).await;

    // Always roll back — we don't want EXPLAIN ANALYZE to mutate data
    let _ = client.execute("ROLLBACK", &[]).await;

    let rows = result.map_err(|e| e.to_string())?;
    let row = rows
        .first()
        .ok_or_else(|| "No output from EXPLAIN".to_string())?;
    let json_val: serde_json::Value = row.get(0);
    Ok(json_val.to_string())
}

// ─── Smart Query Sandbox ───────────────────────────────────────────────────

/// Open a dedicated database connection, BEGIN a transaction, and return a sandbox_id.
/// All subsequent `db_sandbox_execute` calls use this open transaction until
/// `db_sandbox_commit` or `db_sandbox_rollback` is called.
#[tauri::command]
pub async fn db_sandbox_begin(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<String, String> {
    let conn_str = state
        .conn_manager
        .get_connection_string(&connection_id)
        .ok_or_else(|| format!("No connection found with ID: {connection_id}"))?;

    let sandbox_id = uuid::Uuid::new_v4().to_string();
    state.sandbox_manager.begin(&sandbox_id, &conn_str).await?;
    Ok(sandbox_id)
}

/// Execute SQL inside the open sandbox transaction.
/// Returns a full diff of before/after rows so the user can review before committing.
#[tauri::command]
pub async fn db_sandbox_execute(
    state: State<'_, AppState>,
    sandbox_id: String,
    sql: String,
) -> Result<SandboxResult, String> {
    state.sandbox_manager.execute(&sandbox_id, &sql).await
}

/// COMMIT the sandbox transaction — changes become permanent.
#[tauri::command]
pub async fn db_sandbox_commit(
    state: State<'_, AppState>,
    sandbox_id: String,
) -> Result<(), String> {
    state.sandbox_manager.commit(&sandbox_id).await
}

/// ROLLBACK the sandbox transaction — all changes are discarded.
#[tauri::command]
pub async fn db_sandbox_rollback(
    state: State<'_, AppState>,
    sandbox_id: String,
) -> Result<(), String> {
    state.sandbox_manager.rollback(&sandbox_id).await
}

/// Returns the number of seconds the sandbox transaction has been open.
#[tauri::command]
pub async fn db_sandbox_elapsed(
    state: State<'_, AppState>,
    sandbox_id: String,
) -> Result<u64, String> {
    Ok(state.sandbox_manager.elapsed_secs(&sandbox_id))
}

// ─── Visual Index Builder ──────────────────────────────────────────────────

/// Check runtime availability of pg_stat_statements on the current connection.
#[tauri::command]
pub async fn db_pg_stat_statements_status(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<PgStatStatementsStatus, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_pg_stat_statements_status(&pool).await
}

/// Enable pg_stat_statements extension in the current database and return refreshed status.
#[tauri::command]
pub async fn db_pg_stat_statements_enable(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<PgStatStatementsStatus, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::enable_pg_stat_statements(&pool).await
}

/// List statements from pg_stat_statements with server-side pagination.
#[tauri::command]
pub async fn db_pg_stat_statements_list(
    state: State<'_, AppState>,
    connection_id: String,
    filter: PgStatStatementsFilter,
) -> Result<PgStatStatementsPage, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::list_pg_stat_statements(&pool, &filter).await
}

/// Get all indexes in a schema with live usage statistics from pg_stat_user_indexes.
/// Wrapped in a timeout so the UI never hangs (e.g. slow pool or large catalogs).
#[tauri::command]
pub async fn db_get_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> Result<Vec<crate::db::types::IndexStats>, String> {
    use tokio::time::{timeout, Duration};
    let pool = state.conn_manager.get_pool(&connection_id)?;
    let result = timeout(
        Duration::from_secs(20),
        queries::get_indexes_with_stats(&pool, &schema),
    )
    .await
    .map_err(|_| "Loading indexes timed out".to_string())?;
    result
}

/// Get sample queries from pg_stat_statements that reference a table (for AI index optimization).
#[tauri::command]
pub async fn db_get_table_query_samples(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<Vec<crate::db::types::QuerySample>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_table_query_samples(&pool, &schema, &table, 15).await
}

/// Analyze pg_stat_statements to find queries that would benefit from a proposed index.
#[tauri::command]
pub async fn db_get_index_impact(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    columns: Vec<String>,
    where_clause: Option<String>,
) -> Result<Vec<crate::db::types::IndexImpactQuery>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_index_impact(&pool, &schema, &table, &columns, where_clause.as_deref()).await
}

/// Create an index using CONCURRENTLY (no table locking). Returns the generated SQL.
#[tauri::command]
pub async fn db_create_index(
    state: State<'_, AppState>,
    connection_id: String,
    request: crate::db::types::CreateIndexRequest,
) -> Result<String, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::create_index_concurrently(&pool, &request).await
}

/// Drop an index using CONCURRENTLY to avoid locking.
#[tauri::command]
pub async fn db_drop_index(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    index_name: String,
) -> Result<bool, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::drop_index(&pool, &schema, &index_name)
        .await
        .map(|_| true)
}

/// Poll build progress for an index being created CONCURRENTLY.
/// Returns None once the index is fully built (no longer in pg_stat_progress_create_index).
#[tauri::command]
pub async fn db_get_index_build_progress(
    state: State<'_, AppState>,
    connection_id: String,
    index_name: String,
) -> Result<Option<crate::db::types::IndexBuildProgress>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_index_build_progress(&pool, &index_name).await
}

// ─── Query Notes (persisted in app data dir) ──────────────────────────────

#[tauri::command]
pub async fn notes_load_all(
    app: AppHandle,
) -> Result<Vec<crate::notes_storage::QueryNote>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::notes_storage::load_all(Some(app_data_dir))
}

#[tauri::command]
pub async fn notes_save(
    app: AppHandle,
    note: crate::notes_storage::QueryNote,
) -> Result<Vec<crate::notes_storage::QueryNote>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::notes_storage::save_note(Some(app_data_dir), note)
}

#[tauri::command]
pub async fn notes_delete(
    app: AppHandle,
    id: String,
) -> Result<Vec<crate::notes_storage::QueryNote>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::notes_storage::delete_note(Some(app_data_dir), &id)
}

#[tauri::command]
pub async fn notes_search(
    app: AppHandle,
    query: String,
) -> Result<Vec<crate::notes_storage::QueryNote>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::notes_storage::search_notes(Some(app_data_dir), &query)
}

// ─── Schema Designer (persisted in app data dir) ──────────────────────────

#[tauri::command]
pub async fn schema_designer_load_all(
    app: AppHandle,
) -> Result<Vec<crate::schema_designer_storage::SchemaProject>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::schema_designer_storage::load_all(Some(app_data_dir))
}

#[tauri::command]
pub async fn schema_designer_get_project(
    app: AppHandle,
    id: String,
) -> Result<Option<crate::schema_designer_storage::SchemaProject>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::schema_designer_storage::get_project(Some(app_data_dir), &id)
}

#[tauri::command]
pub async fn schema_designer_save_project(
    app: AppHandle,
    project: crate::schema_designer_storage::SchemaProject,
) -> Result<Vec<crate::schema_designer_storage::SchemaProject>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::schema_designer_storage::save_project(Some(app_data_dir), project)
}

#[tauri::command]
pub async fn schema_designer_delete_project(
    app: AppHandle,
    id: String,
) -> Result<Vec<crate::schema_designer_storage::SchemaProject>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::schema_designer_storage::delete_project(Some(app_data_dir), &id)
}

// ─── Query History & Performance Intelligence (SQLite local store) ────────

#[tauri::command]
pub async fn query_history_list(
    app: AppHandle,
    filter: query_history_storage::QueryHistoryFilter,
) -> Result<query_history_storage::QueryHistoryListResponse, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        query_history_storage::list_queries(Some(app_data_dir), filter)
    })
    .await
    .map_err(|e| format!("Query history worker failed: {}", e))?
}

#[tauri::command]
pub async fn query_history_get_detail(
    app: AppHandle,
    id: i64,
) -> Result<query_history_storage::QueryHistoryDetail, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        query_history_storage::get_query_detail(Some(app_data_dir), id)
    })
    .await
    .map_err(|e| format!("Query history detail worker failed: {}", e))?
}

#[tauri::command]
pub async fn query_history_get_dashboard(
    app: AppHandle,
    filter: query_history_storage::QueryHistoryDashboardFilter,
) -> Result<query_history_storage::QueryHistoryDashboard, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        query_history_storage::get_dashboard(Some(app_data_dir), filter)
    })
    .await
    .map_err(|e| format!("Query history dashboard worker failed: {}", e))?
}

#[tauri::command]
pub async fn query_history_save_ai_analysis(
    app: AppHandle,
    id: i64,
    analysis_json: String,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        query_history_storage::save_ai_analysis(Some(app_data_dir), id, analysis_json)
    })
    .await
    .map_err(|e| format!("Query history AI analysis worker failed: {}", e))?
}

#[tauri::command]
pub async fn query_history_save_explain(
    app: AppHandle,
    id: i64,
    explain_json: String,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        query_history_storage::save_explain_json(Some(app_data_dir), id, explain_json)
    })
    .await
    .map_err(|e| format!("Query history explain worker failed: {}", e))?
}

#[tauri::command]
pub async fn query_history_toggle_bookmark(
    app: AppHandle,
    id: i64,
    bookmark: bool,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        query_history_storage::toggle_bookmark(Some(app_data_dir), id, bookmark)
    })
    .await
    .map_err(|e| format!("Query history bookmark worker failed: {}", e))?
}

#[tauri::command]
pub async fn query_history_save_note(
    app: AppHandle,
    id: i64,
    note: Option<String>,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        query_history_storage::save_note(Some(app_data_dir), id, note)
    })
    .await
    .map_err(|e| format!("Query history note worker failed: {}", e))?
}

#[tauri::command]
pub async fn query_history_export_csv(
    app: AppHandle,
    filter: query_history_storage::QueryHistoryFilter,
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        query_history_storage::export_csv(Some(app_data_dir), filter)
    })
    .await
    .map_err(|e| format!("Query history CSV export worker failed: {}", e))?
}

/// Open the given path in the system file manager (e.g. reveal in Finder). Pass a file path to open its parent folder.
#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    let to_open = if path.is_file() {
        path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.to_path_buf())
    } else {
        path.to_path_buf()
    };
    opener::open(to_open).map_err(|e| format!("Failed to open path: {}", e))
}

/// Append a line to the app debug log (for TestFlight / support). Log file: App Support/com.pgstudio.helixdb/app-debug.log
#[tauri::command]
pub async fn app_log_write(app: AppHandle, message: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| format!("Create app data dir: {}", e))?;
    let log_path = app_data_dir.join("app-debug.log");
    let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    let line = format!("[{}] {}\n", ts, message.replace('\n', " "));
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Open log file: {}", e))?
        .write_all(line.as_bytes())
        .map_err(|e| format!("Write log: {}", e))?;
    Ok(())
}

/// Return the path to the app debug log file (so the user can open it or attach to feedback).
#[tauri::command]
pub async fn app_log_path(app: AppHandle) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_data_dir.join("app-debug.log").to_string_lossy().to_string())
}
