//! Cross-platform application menu (macOS menu bar, Windows/Linux menubar).
//! Item actions forward to the webview via Tauri events.
//!
//! On iOS and Android, Tauri does not expose `tauri::menu`; this module is a no-op there.

#[cfg(desktop)]
mod desktop {
    use crate::commands;
    use crate::web_config::{WEB_APP_URL, WEB_CHANGELOG_URL};
    use serde::Serialize;
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    use tauri::{App, Emitter, Runtime};

    #[derive(Clone, Serialize)]
    struct OpenExternalPayload {
        url: String,
    }

    fn about_metadata() -> AboutMetadata<'static> {
        AboutMetadata {
            name: Some("pgStudio".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            copyright: Some("Copyright © pgStudio. All rights reserved.".to_string()),
            credits: Some(
                "A performance-first PostgreSQL studio for schema design, queries, sessions, \
                 extensions, migrations, and collaboration.\n\n\
                 Built with Rust, Tauri, and Next.js."
                    .to_string(),
            ),
            website: Some(WEB_APP_URL.to_string()),
            authors: Some(vec!["pgStudio".to_string()]),
            ..Default::default()
        }
    }

    fn emit_navigate<R: Runtime>(app: &tauri::AppHandle<R>, path: &str) {
        if let Err(e) = app.emit("pgstudio-menu-navigate", path) {
            log::warn!("[menu] emit navigate failed: {e}");
        }
    }

    fn emit_action<R: Runtime>(app: &tauri::AppHandle<R>, action: &str) {
        if let Err(e) = app.emit("pgstudio-menu-action", action) {
            log::warn!("[menu] emit action failed: {e}");
        }
    }

    fn emit_open_url<R: Runtime>(app: &tauri::AppHandle<R>, url: impl Into<String>) {
        let payload = OpenExternalPayload { url: url.into() };
        if let Err(e) = app.emit("pgstudio-open-external", payload) {
            log::warn!("[menu] emit open url failed: {e}");
        }
    }

    pub fn install_native_menu<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
        let new_window_item = MenuItemBuilder::with_id("new_window", "New Window")
            .accelerator("CmdOrCtrl+Shift+N")
            .build(app)?;

        let settings_item = MenuItemBuilder::with_id("open_settings", "Settings…")
            .accelerator("CmdOrCtrl+,")
            .build(app)?;

        #[cfg(target_os = "macos")]
        let check_updates_item = MenuItemBuilder::with_id("check_updates", "Check for Updates…")
            .accelerator("CmdOrCtrl+U")
            .build(app)?;

        let nav_home = MenuItemBuilder::with_id("nav_home", "Workspace Home")
            .accelerator("CmdOrCtrl+0")
            .build(app)?;

        let nav_history = MenuItemBuilder::with_id("nav_query_history", "Query History && Performance")
            .accelerator("CmdOrCtrl+Shift+H")
            .build(app)?;

        let nav_ext = MenuItemBuilder::with_id("nav_extensions", "Extensions && Roles")
            .accelerator("CmdOrCtrl+Shift+E")
            .build(app)?;

        let nav_benchmarks = MenuItemBuilder::with_id("nav_benchmarks", "Benchmarks")
            .build(app)?;

        let nav_migration = MenuItemBuilder::with_id("nav_migration", "Migration Studio")
            .build(app)?;

        let nav_schema = MenuItemBuilder::with_id("nav_schema_projects", "Schema Projects")
            .build(app)?;

        let nav_map = MenuItemBuilder::with_id("nav_map", "Map View")
            .build(app)?;

        let open_docs = MenuItemBuilder::with_id("open_docs", "Documentation (web)")
            .build(app)?;

        let settings_about = MenuItemBuilder::with_id("open_settings_about", "About pgStudio (details)")
            .build(app)?;

        let settings_shortcuts = MenuItemBuilder::with_id("open_settings_shortcuts", "Keyboard Shortcuts…")
            .build(app)?;

        let reload_item = MenuItemBuilder::with_id("reload_window", "Reload Window")
            .accelerator("CmdOrCtrl+R")
            .build(app)?;

        let command_palette_item = MenuItemBuilder::with_id("open_command_palette", "Command Palette")
            .accelerator("CmdOrCtrl+K")
            .build(app)?;

        #[cfg(target_os = "macos")]
        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        #[cfg(not(target_os = "macos"))]
        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let view_menu = SubmenuBuilder::new(app, "View")
            .item(&reload_item)
            .item(&command_palette_item)
            .build()?;

        let help_release = MenuItemBuilder::with_id("help_release_notes", "Release Notes")
            .build(app)?;
        #[cfg(target_os = "macos")]
        let help_updates = MenuItemBuilder::with_id("help_check_updates", "Check for Updates…").build(app)?;

        #[cfg(not(target_os = "macos"))]
        let help_updates = MenuItemBuilder::with_id("help_check_updates", "Check for Updates…")
            .accelerator("CmdOrCtrl+U")
            .build(app)?;
        let help_bug = MenuItemBuilder::with_id("help_bug_report", "Report a Bug…")
            .build(app)?;
        let help_site = MenuItemBuilder::with_id("help_website", "Visit Website")
            .build(app)?;

        let help_menu = SubmenuBuilder::new(app, "Help")
            .item(&help_release)
            .item(&help_updates)
            .separator()
            .item(&nav_history)
            .item(&nav_ext)
            .item(&nav_benchmarks)
            .item(&nav_migration)
            .item(&nav_schema)
            .item(&nav_map)
            .separator()
            .item(&open_docs)
            .item(&help_site)
            .item(&help_bug)
            .separator()
            .item(&settings_shortcuts)
            .item(&settings_about)
            .build()?;

        #[cfg(target_os = "linux")]
        let quit_linux = MenuItemBuilder::with_id("quit_app", "Quit")
            .accelerator("CmdOrCtrl+Q")
            .build(app)?;

        #[cfg(target_os = "macos")]
        let menu = {
            let about = about_metadata();
            let app_menu = SubmenuBuilder::new(app, "pgStudio")
                .about(Some(about))
                .separator()
                .item(&check_updates_item)
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_window_item)
                .separator()
                .item(&nav_home)
                .separator()
                .close_window()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .fullscreen()
                .separator()
                .close_window()
                .build()?;

            MenuBuilder::new(app)
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()?
        };

        #[cfg(target_os = "windows")]
        let menu = {
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_window_item)
                .separator()
                .item(&nav_home)
                .separator()
                .close_window()
                .separator()
                .quit()
                .build()?;

            MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&help_menu)
                .build()?
        };

        #[cfg(target_os = "linux")]
        let menu = {
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_window_item)
                .separator()
                .item(&nav_home)
                .separator()
                .item(&quit_linux)
                .build()?;

            MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&help_menu)
                .build()?
        };

        app.set_menu(menu)?;

        app.on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                "new_window" => commands::create_app_window(app),
                "reload_window" => commands::reload_focused_webview(app),
                "nav_home" => emit_navigate(app, "/"),
                "help_release_notes" => emit_open_url(app, WEB_CHANGELOG_URL.to_string()),
                "help_bug_report" => emit_navigate(app, "/bug-report"),
                "nav_query_history" => emit_navigate(app, "/query-history"),
                "nav_extensions" => emit_navigate(app, "/extensions-management"),
                "nav_benchmarks" => emit_navigate(app, "/benchmarks"),
                "nav_migration" => emit_navigate(app, "/migration-studio"),
                "nav_schema_projects" => emit_navigate(app, "/schema-projects"),
                "nav_map" => emit_navigate(app, "/map-view"),
                "open_settings" => emit_action(app, "open-settings"),
                "open_settings_about" => emit_action(app, "open-settings-about"),
                "open_settings_shortcuts" => emit_action(app, "open-settings-shortcuts"),
                "open_command_palette" => emit_action(app, "open-command-palette"),
                "check_updates" | "help_check_updates" => emit_action(app, "check-updates"),
                "help_website" => emit_open_url(app, WEB_APP_URL.to_string()),
                "open_docs" => emit_open_url(app, WEB_APP_URL.to_string()),
                "quit_app" => {
                    app.exit(0);
                }
                _ => {}
            }
        });

        Ok(())
    }
}

#[cfg(desktop)]
pub use desktop::install_native_menu;

#[cfg(not(desktop))]
pub fn install_native_menu<R: tauri::Runtime>(_app: &mut tauri::App<R>) -> tauri::Result<()> {
    Ok(())
}
