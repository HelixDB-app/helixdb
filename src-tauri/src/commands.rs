use tauri::{AppHandle, Manager, State};

use crate::connections_storage::{self, SavedConnection};
use crate::local_postgres::{self, LocalPostgresStatus};
use crate::db::types::{FilterCondition, ColumnStats};
use crate::db::{
    cache::MetadataCache,
    connection::ConnectionManager,
    queries,
    sandbox::{SandboxManager, SandboxResult},
    types::{TableDetails, TypeDefinitionDetail, *},
    watcher::WatchManager,
};

/// Application state shared across all Tauri commands
pub struct AppState {
    pub conn_manager: ConnectionManager,
    pub cache: MetadataCache,
    pub watch_manager: WatchManager,
    pub sandbox_manager: SandboxManager,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            conn_manager: ConnectionManager::new(),
            cache: MetadataCache::new(),
            watch_manager: WatchManager::new(),
            sandbox_manager: SandboxManager::new(),
        }
    }
}

/// Connect to a PostgreSQL database
#[tauri::command]
pub async fn db_connect(
    state: State<'_, AppState>,
    connection_string: String,
) -> Result<ConnectionResponse, String> {
    let connection_id = uuid::Uuid::new_v4().to_string();

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

fn is_created_at_column(name: &str) -> bool {
    let lower = name.to_lowercase();
    matches!(
        lower.as_str(),
        "created_at" | "createdat" | "create_date" | "creation_date" | "date_created" | "created"
    )
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

/// Execute a raw SQL query
#[tauri::command]
pub async fn db_execute_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<QueryResult, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::execute_query(&pool, &sql).await
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
    let values_tuples: Vec<(String, Option<String>)> = values
        .into_iter()
        .map(|u| (u.column, u.value))
        .collect();
    queries::insert_table_row(&pool, &schema, &table, &values_tuples).await
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
    let updates_tuples: Vec<(String, Option<String>)> = updates
        .into_iter()
        .map(|u| (u.column, u.value))
        .collect();
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
    state.cache.invalidate_columns(&connection_id, &schema, &table);
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
        &pool, &schema, &table, &column,
        new_type.as_deref(), new_default.as_deref(), nullable,
    ).await?;
    state.cache.invalidate_columns(&connection_id, &schema, &table);
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
        &pool, &schema, &table, &column,
        &data_type, is_nullable, default_value.as_deref(),
    ).await?;
    state.cache.invalidate_columns(&connection_id, &schema, &table);
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
    state.cache.invalidate_columns(&connection_id, &schema, &table);
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
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    connections_storage::load(Some(app_data_dir))
}

#[tauri::command]
pub async fn save_connection(
    app: AppHandle,
    connection: SavedConnection,
) -> Result<Vec<SavedConnection>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    connections_storage::save(Some(app_data_dir), connection)
}

#[tauri::command]
pub async fn delete_saved_connection(
    app: AppHandle,
    id: String,
) -> Result<Vec<SavedConnection>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    connections_storage::delete(Some(app_data_dir), &id)
}

#[tauri::command]
pub async fn update_saved_connection_database_name(
    app: AppHandle,
    id: String,
    database_name: String,
) -> Result<Vec<SavedConnection>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
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
    state.watch_manager
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
    state.watch_manager
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
    Ok(state.watch_manager.is_watching(&connection_id, &schema, &table))
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
    let row = rows.first().ok_or_else(|| "No output from EXPLAIN".to_string())?;
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
    state
        .sandbox_manager
        .begin(&sandbox_id, &conn_str)
        .await?;
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

/// Get all indexes in a schema with live usage statistics from pg_stat_user_indexes.
#[tauri::command]
pub async fn db_get_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> Result<Vec<crate::db::types::IndexStats>, String> {
    let pool = state.conn_manager.get_pool(&connection_id)?;
    queries::get_indexes_with_stats(&pool, &schema).await
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
