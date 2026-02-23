mod commands;
mod connections_storage;
mod db;
mod local_postgres;
mod notes_storage;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::db_connect,
            commands::db_disconnect,
            commands::db_list_schemas,
            commands::db_list_tables,
            commands::db_get_schema_topology,
            commands::db_get_columns,
            commands::db_get_table_data,
            commands::db_execute_query,
            commands::db_refresh_cache,
            commands::db_list_databases,
            commands::db_create_database,
            commands::db_drop_database,
            commands::db_list_event_triggers,
            commands::db_list_functions,
            commands::db_list_types,
            commands::db_get_pg_version,
            commands::db_get_function_definition,
            commands::db_get_type_definition,
            commands::db_create_enum,
            commands::db_alter_enum_values,
            commands::db_search_table_data,
            commands::db_insert_table_row,
            commands::db_update_table_row,
            commands::db_delete_table_rows,
            commands::db_get_table_details,
            commands::db_rename_table,
            commands::db_rename_column,
            commands::db_alter_column,
            commands::db_add_column,
            commands::db_drop_column,
            commands::db_create_table,
            commands::db_truncate_table,
            commands::db_drop_table,
            commands::get_saved_connections,
            commands::save_connection,
            commands::delete_saved_connection,
            commands::update_saved_connection_database_name,
            commands::db_search_table_data_multi,
            commands::db_get_column_stats,
            commands::local_postgres_check,
            commands::local_postgres_start,
            commands::local_postgres_stop,
            commands::local_postgres_restart,
            commands::local_postgres_install,
            commands::db_watch_table,
            commands::db_unwatch_table,
            commands::db_is_watching,
            commands::db_get_sessions,
            commands::db_terminate_backend,
            commands::db_cancel_backend,
            commands::db_explain_query,
            commands::db_sandbox_begin,
            commands::db_sandbox_execute,
            commands::db_sandbox_commit,
            commands::db_sandbox_rollback,
            commands::db_sandbox_elapsed,
            commands::db_get_indexes,
            commands::db_get_index_impact,
            commands::db_create_index,
            commands::db_drop_index,
            commands::db_get_index_build_progress,
            commands::notes_load_all,
            commands::notes_save,
            commands::notes_delete,
            commands::notes_search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
