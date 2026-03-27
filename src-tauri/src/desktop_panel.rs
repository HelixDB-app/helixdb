use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::biometric;
use crate::commands::AppState;
use crate::security_prefs;

pub const QUICK_SEARCH_PANEL_LABEL: &str = "desktop_search_panel";

/// macOS: native window corner radius (points). Matches `NSVisualEffectView` / `window_vibrancy` mask.
#[cfg(target_os = "macos")]
pub(crate) const QUICK_SEARCH_PANEL_CORNER_RADIUS: f64 = 22.0;

/// Default / mode sizes for the quick-search webview (logical px).
/// **Keep in sync** with `src/components/desktop-search-panel.tsx` (`QS_SEARCH`, `QS_TABLE`, `QS_SQL_SPLIT`).
/// The React layer calls `setSize` on mode changes; these values define creation-time size and documentation for Rust callers.
/// Placement: horizontally centered in the monitor work area; top edge at `QUICK_SEARCH_WORK_AREA_TOP_FRACTION` of work-area height (see below).
#[allow(dead_code)]
pub(crate) mod quick_search_sizes {
    /// Initial / compact search + empty state (matches HUD width in CSS).
    pub const PICK_W: f64 = 580.0;
    pub const PICK_H: f64 = 720.0;
    pub const SEARCH_W: f64 = 580.0;
    pub const SEARCH_H: f64 = 720.0;
    pub const TABLE_W: f64 = 1480.0;
    pub const TABLE_H: f64 = 920.0;
    pub const SQL_SPLIT_W: f64 = 1280.0;
    pub const SQL_SPLIT_H: f64 = 800.0;
    /// Allow slightly narrower resize; table/SQL modes clamp up from JS.
    pub const MIN_W: f64 = 380.0;
    pub const MIN_H: f64 = 420.0;
}

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

/// Resize the quick-search webview (logical px). Used from JS when browse vs table/SQL-split layouts change.
/// Host-side `set_size` is more reliable than calling the Webview API from the child webview on some platforms.
#[tauri::command]
pub fn desktop_resize_quick_search_panel(
    app: AppHandle,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let Some(window) = app.get_webview_window(QUICK_SEARCH_PANEL_LABEL) else {
            return Err("Quick search panel window not found".into());
        };
        let w = width.max(quick_search_sizes::MIN_W);
        let h = height.max(quick_search_sizes::MIN_H);
        window
            .set_size(tauri::LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
        recenter_quick_search_panel_after_resize(&window).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, width, height);
        Ok(())
    }
}

/// Re-apply quick-search geometry (center + top 10%) without changing size. Used when JS falls back to `setSize`.
#[tauri::command]
pub fn desktop_reposition_quick_search_panel(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let Some(window) = app.get_webview_window(QUICK_SEARCH_PANEL_LABEL) else {
            return Err("Quick search panel window not found".into());
        };
        apply_quick_search_panel_placement(&window).map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(())
    }
}

/// Margin from work-area edges (physical px).
const PANEL_WORK_AREA_MARGIN: i32 = 24;

/// Top edge of the panel aligns below the work-area top by this fraction of work-area height (10% = HUD below menu bar).
const QUICK_SEARCH_WORK_AREA_TOP_FRACTION: f64 = 0.1;

#[cfg(desktop)]
fn quick_search_panel_outer_top_left(
    work_area: &tauri::PhysicalRect<i32, u32>,
    outer_width: u32,
    outer_height: u32,
    margin: i32,
    top_inset_fraction: f64,
) -> (i32, i32) {
    let wx = work_area.position.x;
    let wy = work_area.position.y;
    let wa_w = work_area.size.width as i32;
    let wa_h = work_area.size.height as i32;
    let pw = outer_width as i32;
    let ph = outer_height as i32;

    // Horizontal: centered in work area.
    let mut x = wx + (wa_w - pw) / 2;
    // Vertical: top of window at (work-area top) + fraction * height.
    let inset_y = (wa_h as f64 * top_inset_fraction).round() as i32;
    let mut y = wy + inset_y;

    let min_x = wx + margin;
    let min_y = wy + margin;
    let max_x = wx + wa_w - pw - margin;
    let max_y = wy + wa_h - ph - margin;

    if max_x >= min_x {
        x = x.clamp(min_x, max_x);
    } else {
        x = min_x.max(wx);
    }
    if max_y >= min_y {
        y = y.clamp(min_y, max_y);
    } else {
        y = min_y.max(wy);
    }
    (x, y)
}

#[cfg(desktop)]
fn pick_monitor_for_panel_at_point<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    x: f64,
    y: f64,
) -> tauri::Result<Option<tauri::Monitor>> {
    Ok(window
        .monitor_from_point(x, y)?
        .or(window.current_monitor()?))
}

#[cfg(desktop)]
fn apply_quick_search_panel_on_monitor<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    monitor: &tauri::Monitor,
) -> tauri::Result<()> {
    let outer_size = window.outer_size()?;
    let (x, y) = quick_search_panel_outer_top_left(
        monitor.work_area(),
        outer_size.width,
        outer_size.height,
        PANEL_WORK_AREA_MARGIN,
        QUICK_SEARCH_WORK_AREA_TOP_FRACTION,
    );
    window.set_position(tauri::PhysicalPosition::new(x, y))?;
    Ok(())
}

/// Horizontally center + top 10% placement on the monitor that contains the window center.
#[cfg(desktop)]
fn apply_quick_search_panel_placement<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    let outer_pos = window.outer_position()?;
    let outer_size = window.outer_size()?;
    let cx = f64::from(outer_pos.x) + f64::from(outer_size.width as i32) / 2.0;
    let cy = f64::from(outer_pos.y) + f64::from(outer_size.height as i32) / 2.0;
    let Some(monitor) = pick_monitor_for_panel_at_point(window, cx, cy)? else {
        return Ok(());
    };
    apply_quick_search_panel_on_monitor(window, &monitor)
}

#[cfg(desktop)]
fn recenter_quick_search_panel_after_resize<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    apply_quick_search_panel_placement(window)
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
    .inner_size(quick_search_sizes::PICK_W, quick_search_sizes::PICK_H)
    .min_inner_size(quick_search_sizes::MIN_W, quick_search_sizes::MIN_H)
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
        tauri::WindowEvent::Resized(_) => {
            let _ = apply_quick_search_panel_placement(&panel_window);
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
    let monitor = if let Some(pos) = anchor.as_ref() {
        pick_monitor_for_panel_at_point(window, pos.x, pos.y)?
    } else {
        window.current_monitor()?
    };

    let Some(monitor) = monitor else {
        return Ok(());
    };

    apply_quick_search_panel_on_monitor(window, &monitor)
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
