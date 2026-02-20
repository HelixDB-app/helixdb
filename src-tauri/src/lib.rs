mod commands;
mod connections_storage;
mod db;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_log::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::db_connect,
            commands::db_disconnect,
            commands::db_list_schemas,
            commands::db_list_tables,
            commands::db_get_columns,
            commands::db_get_table_data,
            commands::db_execute_query,
            commands::db_refresh_cache,
            commands::db_list_databases,
            commands::db_list_event_triggers,
            commands::db_list_functions,
            commands::db_list_types,
            commands::db_get_pg_version,
            commands::db_get_function_definition,
            commands::db_get_type_definition,
            commands::db_update_table_row,
            commands::db_delete_table_rows,
            commands::get_saved_connections,
            commands::save_connection,
            commands::delete_saved_connection,
            commands::update_saved_connection_database_name,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
