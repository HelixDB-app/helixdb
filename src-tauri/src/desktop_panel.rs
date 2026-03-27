use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::biometric;
use crate::commands::AppState;
use crate::security_prefs;

pub const QUICK_SEARCH_PANEL_LABEL: &str = "desktop_search_panel";

/// macOS: native window corner radius (points). Matches `NSVisualEffectView` / `window_vibrancy` mask.
#[cfg(target_os = "macos")]
pub(crate) const QUICK_SEARCH_PANEL_CORNER_RADIUS: f64 = 20.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConnectedConnection {
    pub connection_id: String,
    pub database_name: String,
    pub server_version: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopQuickSearchContext {
    pub active_connection_id: Option<String>,
    pub connected_connections: Vec<DesktopConnectedConnection>,
}

fn parse_connection_summary(
    connection_id: String,
    active_connection_id: Option<&str>,
    connection_string: &str,
    pg_version_num: u32,
) -> DesktopConnectedConnection {
    let mut database_name = "postgres".to_string();
    let mut host = "localhost".to_string();
    let mut port = 5432;
    let mut user = "postgres".to_string();

    if let Ok(config) = connection_string.parse::<tokio_postgres::Config>() {
        if let Some(db_name) = config.get_dbname() {
            database_name = db_name.to_string();
        }
        if let Some(config_user) = config.get_user() {
            user = config_user.to_string();
        }
        if let Some(config_port) = config.get_ports().first() {
            port = *config_port;
        }
        if let Some(config_host) = config.get_hosts().first() {
            host = match config_host {
                tokio_postgres::config::Host::Tcp(value) => value.clone(),
                #[cfg(unix)]
                tokio_postgres::config::Host::Unix(path) => path.to_string_lossy().to_string(),
            };
        }
    }

    DesktopConnectedConnection {
        is_active: active_connection_id == Some(connection_id.as_str()),
        connection_id,
        database_name,
        server_version: format_pg_version(pg_version_num),
        host,
        port,
        user,
    }
}

fn format_pg_version(version_num: u32) -> String {
    let major = version_num / 10_000;
    let minor = (version_num % 10_000) / 100;
    if minor > 0 {
        format!("PostgreSQL {}.{}", major, minor)
    } else {
        format!("PostgreSQL {}", major)
    }
}

#[tauri::command]
pub fn desktop_get_quick_search_context(
    state: State<'_, AppState>,
) -> Result<DesktopQuickSearchContext, String> {
    let active_connection_id = state.active_connection_id();
    let active_ref = active_connection_id.as_deref();

    let mut connected_connections = state
        .conn_manager
        .list_connection_ids()
        .into_iter()
        .filter_map(|connection_id| {
            let connection_string = state.conn_manager.get_connection_string(&connection_id)?;
            Some(parse_connection_summary(
                connection_id.clone(),
                active_ref,
                &connection_string,
                state.conn_manager.get_pg_version(&connection_id),
            ))
        })
        .collect::<Vec<_>>();

    connected_connections.sort_by(|left, right| {
        right
            .is_active
            .cmp(&left.is_active)
            .then_with(|| left.database_name.cmp(&right.database_name))
            .then_with(|| left.host.cmp(&right.host))
    });

    Ok(DesktopQuickSearchContext {
        active_connection_id,
        connected_connections,
    })
}

#[tauri::command]
pub fn desktop_set_active_connection(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> Result<(), String> {
    if let Some(connection_id) = connection_id {
        if !state.conn_manager.is_connected(&connection_id) {
            return Err(format!("No connection found with ID: {}", connection_id));
        }
        state.set_active_connection_id(Some(connection_id));
    } else {
        state.set_active_connection_id(None);
    }

    Ok(())
}

#[tauri::command]
pub fn desktop_focus_main_window(app: AppHandle) -> Result<(), String> {
    focus_main_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_toggle_quick_search_panel(app: AppHandle) -> Result<(), String> {
    toggle_quick_search_panel(&app, None).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_hide_quick_search_panel(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(QUICK_SEARCH_PANEL_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(desktop)]
fn ensure_quick_search_panel<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(QUICK_SEARCH_PANEL_LABEL) {
        return Ok(window);
    }

    #[cfg(target_os = "macos")]
    let use_drop_shadow: bool = false;
    #[cfg(not(target_os = "macos"))]
    let use_drop_shadow: bool = true;

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        QUICK_SEARCH_PANEL_LABEL,
        tauri::WebviewUrl::App("/desktop-search".into()),
    )
    .title("Quick Search")
    .inner_size(980.0, 720.0)
    .min_inner_size(720.0, 480.0)
    .resizable(true)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .decorations(false)
    .focused(true)
    // macOS: native shadow + transparent vibrancy often produces light fringe at the radius; depth comes from CSS.
    .shadow(use_drop_shadow)
    .skip_taskbar(true)
    .visible(false);

    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};

        builder = builder
            .transparent(true)
            .effects(
                EffectsBuilder::new()
                    // Floating utility panel — system HUD material, clipped with `radius`.
                    .effect(Effect::HudWindow)
                    .state(EffectState::Active)
                    .radius(QUICK_SEARCH_PANEL_CORNER_RADIUS)
                    .build(),
            )
            .visible_on_all_workspaces(true);
    }

    let window = builder.build()?;
    let panel_window = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = panel_window.hide();
        }
        tauri::WindowEvent::Focused(false) => {
            let _ = panel_window.hide();
        }
        _ => {}
    });

    Ok(window)
}

#[cfg(not(desktop))]
fn ensure_quick_search_panel<R: tauri::Runtime>(
    _app: &AppHandle<R>,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    unreachable!("desktop quick search panel is only available on desktop targets")
}

#[cfg(desktop)]
fn position_quick_search_panel<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    anchor: Option<tauri::PhysicalPosition<f64>>,
) -> tauri::Result<()> {
    let outer_size = window.outer_size()?;
    let panel_width = outer_size.width as i32;
    let panel_height = outer_size.height as i32;
    let margin = 14;

    let fallback = window.current_monitor()?.map(|monitor| {
        let work_area = monitor.work_area();
        let position = work_area.position;
        let size = work_area.size;
        tauri::PhysicalPosition::new(
            f64::from(position.x + (size.width as i32 / 2)),
            f64::from(position.y + margin),
        )
    });

    let anchor = anchor.or(fallback).unwrap_or_else(|| tauri::PhysicalPosition::new(80.0, 80.0));
    let monitor = window
        .monitor_from_point(anchor.x, anchor.y)?
        .or(window.current_monitor()?);

    let mut x = anchor.x.round() as i32 - panel_width + 48;
    let mut y = anchor.y.round() as i32 + margin;

    #[cfg(target_os = "windows")]
    {
        y = anchor.y.round() as i32 - panel_height - margin;
    }

    if let Some(monitor) = monitor {
        let work_area = monitor.work_area();
        let min_x = work_area.position.x + margin;
        let min_y = work_area.position.y + margin;
        let max_x = work_area.position.x + work_area.size.width as i32 - panel_width - margin;
        let max_y = work_area.position.y + work_area.size.height as i32 - panel_height - margin;

        if max_x >= min_x {
            x = x.clamp(min_x, max_x);
        }

        if max_y >= min_y {
            if y < min_y {
                y = anchor.y.round() as i32 + margin;
            }
            y = y.clamp(min_y, max_y);
        }
    }

    window.set_position(tauri::PhysicalPosition::new(x, y))?;
    Ok(())
}

#[cfg(not(desktop))]
fn position_quick_search_panel<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _anchor: Option<tauri::PhysicalPosition<f64>>,
) -> tauri::Result<()> {
    Ok(())
}

#[cfg(desktop)]
pub fn focus_main_window<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.unminimize();
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    Ok(())
}

#[cfg(not(desktop))]
pub fn focus_main_window<R: tauri::Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(desktop)]
pub fn toggle_quick_search_panel<R: tauri::Runtime>(
    app: &AppHandle<R>,
    anchor: Option<tauri::PhysicalPosition<f64>>,
) -> tauri::Result<()> {
    let window = ensure_quick_search_panel(app)?;
    let is_visible = window.is_visible().unwrap_or(false);
    if is_visible {
        window.hide()?;
        return Ok(());
    }

    if security_prefs::biometric_app_lock_enabled() {
        if let Err(e) = biometric::authenticate("Unlock Quick Search") {
            log::warn!("[quick-search] biometric authentication failed or canceled: {e}");
            return Ok(());
        }
    }

    position_quick_search_panel(&window, anchor)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

#[cfg(not(desktop))]
pub fn toggle_quick_search_panel<R: tauri::Runtime>(
    _app: &AppHandle<R>,
    _anchor: Option<tauri::PhysicalPosition<f64>>,
) -> tauri::Result<()> {
    Ok(())
}

#[cfg(desktop)]
pub fn install_desktop_quick_access<R: tauri::Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    #[cfg(target_os = "macos")]
    use tauri::menu::IconMenuItemBuilder;
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open_main_item = MenuItemBuilder::with_id("tray_open_main", "Open pgStudio").build(app)?;
    #[cfg(target_os = "macos")]
    let open_quick_search_item = IconMenuItemBuilder::with_id("tray_open_quick_search", "Quick Search")
        .icon(crate::quick_search_icon::raster_quick_search_icon())
        .build(app)?;
    #[cfg(not(target_os = "macos"))]
    let open_quick_search_item =
        MenuItemBuilder::with_id("tray_open_quick_search", "Quick Search").build(app)?;
    let hide_quick_search_item =
        MenuItemBuilder::with_id("tray_hide_quick_search", "Hide Quick Search").build(app)?;

    #[cfg(target_os = "macos")]
    let quit_item = MenuItemBuilder::with_id("tray_quit", "Quit pgStudio").build(app)?;

    #[cfg(not(target_os = "macos"))]
    let quit_item = MenuItemBuilder::with_id("tray_quit", "Quit")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let tray_menu = MenuBuilder::new(app)
        .item(&open_main_item)
        .item(&open_quick_search_item)
        .item(&hide_quick_search_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let mut tray_builder = TrayIconBuilder::with_id("quick_search_tray")
        .menu(&tray_menu)
        .tooltip("pgStudio — Quick Search (global: Ctrl+Shift+K / ⌘⇧K)")
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "tray_open_main" => {
                let _ = focus_main_window(app_handle);
            }
            "tray_open_quick_search" => {
                let _ = toggle_quick_search_panel(app_handle, None);
            }
            "tray_hide_quick_search" => {
                if let Some(panel) = app_handle.get_webview_window(QUICK_SEARCH_PANEL_LABEL) {
                    let _ = panel.hide();
                }
            }
            "tray_quit" => app_handle.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                let _ = toggle_quick_search_panel(&tray.app_handle(), Some(position));
            }
        });

    // macOS: must use a monochrome (black + alpha) bitmap with `icon_as_template(true)`.
    // The full-color `default_window_icon` + template reads as a solid white block in the menu bar.
    #[cfg(target_os = "macos")]
    {
        tray_builder = tray_builder.icon(crate::quick_search_icon::raster_quick_search_icon());
        tray_builder = tray_builder.icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            tray_builder = tray_builder.icon(icon.clone());
        }
    }

    tray_builder.build(app)?;
    Ok(())
}

#[cfg(not(desktop))]
pub fn install_desktop_quick_access<R: tauri::Runtime>(_app: &mut tauri::App<R>) -> tauri::Result<()> {
    Ok(())
}
