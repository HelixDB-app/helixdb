use tauri::{AppHandle, Manager, State};

use crate::connections_storage::{self, SavedConnection};
use crate::db::{
    cache::MetadataCache,
    connection::ConnectionManager,
    queries,
    types::{TypeDefinitionDetail, *},
};

/// Application state shared across all Tauri commands
pub struct AppState {
    pub conn_manager: ConnectionManager,
    pub cache: MetadataCache,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            conn_manager: ConnectionManager::new(),
            cache: MetadataCache::new(),
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

/// Get paginated table data
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
    queries::get_table_data(
        &pool,
        &schema,
        &table,
        page,
        page_size,
        sort_column.as_deref(),
        sort_direction.as_deref(),
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
