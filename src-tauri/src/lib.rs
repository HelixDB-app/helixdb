mod account_security_storage;
mod biometric;
mod ai_suggestions_worker;
mod auth;
mod backup;
mod backup_storage;
mod commands;
mod connections_storage;
mod db;
mod device_fingerprint;
mod desktop_panel;
mod git;
mod git_storage;
mod github;
mod local_postgres;
mod native_menu;
#[cfg(all(desktop, target_os = "macos"))]
mod quick_search_icon;
mod notes_storage;
mod query_history_storage;
mod schema_designer_storage;
mod sql_sensitive;
mod security_commands;
mod security_prefs;
mod sql_lint;
mod ssh_tunnel;
mod trial;
mod updates;
mod web_config;

use commands::AppState;
use git::GitState;
use tauri::{Emitter, Listener};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env: project root (dev), then app data dir (installed/TestFlight).
    // This makes GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET available at runtime.
    dotenvy::dotenv().ok();
    let app_env = git_storage::pgstudio_data_dir().join(".env");
    if app_env.exists() {
        dotenvy::from_path(&app_env).ok();
    }

    tauri::Builder::default()
        .manage(AppState::new())
        .manage(GitState::new())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Listen for deep-link events and re-emit as friendly events for the frontend.
            let handle = app.handle().clone();
            app.handle()
                .listen("deep-link://new-url", move |event: tauri::Event| {
                    log::debug!("[deep-link] received payload: {}", event.payload());
                    match serde_json::from_str::<Vec<String>>(event.payload()) {
                        Ok(urls) => {
                            for url in urls {
                                if url.starts_with("pgstudio://auth/callback") {
                                    log::info!("[deep-link] emitting pgstudio-auth-callback");
                                    if let Err(e) = handle.emit("pgstudio-auth-callback", &url) {
                                        log::error!("[deep-link] failed to emit auth event: {e}");
                                    }
                                } else if url.starts_with("pgstudio://git/callback") {
                                    log::info!("[deep-link] emitting pgstudio-git-callback");
                                    if let Err(e) = handle.emit("pgstudio-git-callback", &url) {
                                        log::error!("[deep-link] failed to emit git event: {e}");
                                    }
                                } else if url.starts_with("pgstudio://collab/join") {
                                    log::info!("[deep-link] emitting pgstudio-collab-join");
                                    if let Err(e) = handle.emit("pgstudio-collab-join", &url) {
                                        log::error!(
                                            "[deep-link] failed to emit collaboration event: {e}"
                                        );
                                    }
                                } else {
                                    log::debug!("[deep-link] ignored url: {url}");
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!(
                                "[deep-link] failed to parse payload as Vec<String>: {e} — raw: {}",
                                event.payload()
                            );
                        }
                    }
                });

            native_menu::install_native_menu(app)?;
            desktop_panel::install_desktop_quick_access(app)?;
            backup::start_scheduler(app.handle().clone());

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                use tauri_plugin_global_shortcut::{Builder, ShortcutState};

                let shortcut_label = "CmdOrCtrl+Shift+K";
                match Builder::new().with_shortcuts([shortcut_label]) {
                    Ok(builder) => {
                        let plugin = builder
                            .with_handler(move |app, _shortcut, event| {
                                if event.state != ShortcutState::Pressed {
                                    return;
                                }
                                if let Err(error) =
                                    desktop_panel::toggle_quick_search_panel(app, None)
                                {
                                    log::warn!(
                                        "[global-shortcut] quick search toggle failed: {error}"
                                    );
                                }
                            })
                            .build();
                        if let Err(error) = app.handle().plugin(plugin) {
                            log::warn!(
                                "[global-shortcut] failed to register {shortcut_label}: {error}"
                            );
                        } else {
                            log::info!(
                                "[global-shortcut] quick search hotkey active system-wide ({shortcut_label})"
                            );
                        }
                    }
                    Err(error) => {
                        log::warn!("[global-shortcut] invalid shortcut {shortcut_label}: {error}");
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backup::backup_get_module_state,
            backup::backup_estimate_size,
            backup::backup_run_now,
            backup::backup_restore,
            backup::backup_upsert_schedule,
            backup::backup_delete_schedule,
            backup::backup_delete_record,
            backup::backup_connect_google_drive,
            backup::backup_save_google_drive_config,
            backup::backup_clear_google_drive_config,
            commands::db_connect,
            commands::db_disconnect,
            commands::db_list_schemas,
            commands::db_list_tables,
            commands::db_track_recent_table_open,
            commands::db_list_recent_tables,
            commands::db_get_schema_topology,
            commands::db_get_database_topology,
            commands::db_preview_alter_table,
            commands::db_get_columns,
            commands::db_get_documentation_context,
            commands::db_apply_documentation_comments,
            commands::db_get_table_data,
            commands::db_get_table_data_geojson,
            commands::db_export_sql,
            commands::db_execute_query,
            sql_lint::db_lint_sql,
            ai_suggestions_worker::ai_suggestions_worker_post,
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
            commands::get_media_permission_status,
            commands::request_media_permissions,
            commands::open_media_permission_settings,
            commands::app_log_write,
            commands::app_log_path,
            commands::open_new_window,
            security_commands::security_get_biometric_lock,
            security_commands::security_set_biometric_lock,
            security_commands::security_get_biometric_sensitive_ops,
            security_commands::security_set_biometric_sensitive_ops,
            security_commands::biometric_get_status,
            security_commands::biometric_authenticate,
            security_commands::biometric_authenticate_sensitive_action,
            desktop_panel::desktop_focus_main_window,
            desktop_panel::desktop_get_quick_search_context,
            desktop_panel::desktop_hide_quick_search_panel,
            desktop_panel::desktop_resize_quick_search_panel,
            desktop_panel::desktop_reposition_quick_search_panel,
            desktop_panel::desktop_set_active_connection,
            desktop_panel::desktop_toggle_quick_search_panel,
            commands::db_import_schema,
            // Auth commands
            auth::auth_open_login,
            auth::auth_exchange_desktop_code,
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
            // Git workspace commands
            git::git_open_workspace,
            git::git_ensure_workspace_for_connection,
            git::git_set_workspace,
            git::git_get_status,
            git::git_get_diff,
            git::git_stage_files,
            git::git_stage_all,
            git::git_unstage_files,
            git::git_commit,
            git::git_push,
            git::git_fetch_remote,
            git::git_set_remote,
            git::git_list_branches,
            git::git_create_branch,
            git::git_checkout_branch,
            git::git_delete_branch,
            git::git_get_log,
            git::git_get_remote_info,
            git::git_get_diff_summary,
            git::git_discard_changes,
            git::write_workspace_file,
            git::delete_workspace_file,
            git::sync_ide_files_to_workspace,
            // Update commands
            updates::app_store_check_update,
            // Git storage commands
            git_storage::git_storage_list_workspaces,
            git_storage::git_storage_save_workspace,
            git_storage::git_storage_delete_workspace,
            git_storage::git_storage_update_remote,
            git_storage::git_storage_update_author,
            git_storage::git_storage_get_github_token,
            // GitHub OAuth & API commands
            github::github_start_oauth,
            github::github_exchange_code,
            github::github_get_current_user,
            github::github_get_token,
            github::github_revoke_token,
            github::github_list_repos,
            github::github_create_repo,
            github::github_create_pr,
            github::github_list_collaborators,
            github::github_list_remote_branches,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
