mod account_security_storage;
mod auth;
mod commands;
mod connections_storage;
mod db;
mod device_fingerprint;
mod local_postgres;
mod notes_storage;
mod query_history_storage;
mod schema_designer_storage;
mod trial;

use commands::AppState;
use tauri::{Emitter, Listener};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Listen for deep-link events and re-emit as a friendly event for the frontend.
            // The web app sends:  pgstudio://auth/callback?token=JWT&state=NONCE
            let handle = app.handle().clone();
            app.handle().listen("deep-link://new-url", move |event: tauri::Event| {
                log::debug!("[deep-link] received payload: {}", event.payload());
                match serde_json::from_str::<Vec<String>>(event.payload()) {
                    Ok(urls) => {
                        for url in urls {
                            if url.starts_with("pgstudio://auth/callback") {
                                log::info!("[deep-link] emitting pgstudio-auth-callback");
                                if let Err(e) = handle.emit("pgstudio-auth-callback", &url) {
                                    log::error!("[deep-link] failed to emit event: {e}");
                                }
                            } else {
                                log::debug!("[deep-link] ignored url: {url}");
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[deep-link] failed to parse payload as Vec<String>: {e} — raw: {}", event.payload());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_connect,
            commands::db_disconnect,
            commands::db_list_schemas,
            commands::db_list_tables,
            commands::db_track_recent_table_open,
            commands::db_list_recent_tables,
            commands::db_get_schema_topology,
            commands::db_get_columns,
            commands::db_get_documentation_context,
            commands::db_apply_documentation_comments,
            commands::db_get_table_data,
            commands::db_get_table_data_geojson,
            commands::db_export_sql,
            commands::db_execute_query,
            commands::db_refresh_cache,
            commands::db_list_databases,
            commands::db_get_access_profile,
            commands::db_list_extensions,
            commands::db_install_extension,
            commands::db_get_extension_detail,
            commands::db_uninstall_extension,
            commands::db_update_extension,
            commands::db_list_database_roles,
            commands::db_list_database_users,
            commands::db_create_database_role,
            commands::db_get_database_role_detail,
            commands::db_grant_database_role_membership,
            commands::db_revoke_database_role_membership,
            commands::db_create_database_user,
            commands::db_set_database_user_login,
            commands::db_set_database_user_password,
            commands::db_delete_database_user,
            commands::db_list_password_reminders,
            commands::db_delete_password_reminder,
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
            commands::db_insert_table_rows_bulk,
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
            commands::db_pg_stat_statements_status,
            commands::db_pg_stat_statements_enable,
            commands::db_pg_stat_statements_list,
            commands::db_get_indexes,
            commands::db_get_table_query_samples,
            commands::db_get_index_impact,
            commands::db_create_index,
            commands::db_drop_index,
            commands::db_get_index_build_progress,
            commands::notes_load_all,
            commands::notes_save,
            commands::notes_delete,
            commands::notes_search,
            commands::schema_designer_load_all,
            commands::schema_designer_get_project,
            commands::schema_designer_save_project,
            commands::schema_designer_delete_project,
            commands::query_history_list,
            commands::query_history_get_detail,
            commands::query_history_get_dashboard,
            commands::query_history_save_ai_analysis,
            commands::query_history_save_explain,
            commands::query_history_toggle_bookmark,
            commands::query_history_save_note,
            commands::query_history_export_csv,
            commands::open_path,
            commands::app_log_write,
            commands::app_log_path,
            // Auth commands
            auth::auth_open_login,
            auth::auth_open_url,
            auth::auth_store_token,
            auth::auth_get_token,
            auth::auth_delete_token,
            auth::auth_fetch_profile,
            // Plans & Checkout commands
            auth::auth_fetch_plans,
            auth::auth_create_checkout,
            // Subscription commands
            auth::subscription_fetch_status,
            // Trial commands
            trial::trial_init,
            trial::trial_get_status,
            trial::trial_associate_user,
            trial::trial_get_device_id,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
