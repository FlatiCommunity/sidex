use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::storage::StorageDb;
use crate::cli::{OpenTarget, TargetKind};

pub struct StartupTargets(Mutex<(String, Vec<OpenTarget>)>);

impl StartupTargets {
    pub fn new(targets: Vec<OpenTarget>) -> Self {
        Self(Mutex::new(("main".to_string(), targets)))
    }

    #[cfg(target_os = "macos")]
    pub fn queue_for(&self, label: &str, targets: Vec<OpenTarget>) -> Result<(), String> {
        let mut pending = self.0.lock().map_err(|e| e.to_string())?;
        pending.0 = label.to_string();
        pending.1.extend(targets);
        Ok(())
    }
}

#[derive(Serialize)]
pub struct StartupTarget {
    path: String,
    kind: &'static str,
    line: Option<u32>,
    column: Option<u32>,
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn take_startup_targets(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, StartupTargets>,
) -> Result<Vec<StartupTarget>, String> {
    // Only the designated window consumes process args or a Finder open event.
    let mut pending = state.0.lock().map_err(|e| e.to_string())?;
    if window.label() != pending.0 {
        return Ok(Vec::new());
    }
    let targets = std::mem::take(&mut pending.1);
    Ok(targets
        .into_iter()
        .map(|target| StartupTarget {
            path: target.path.to_string_lossy().into_owned(),
            kind: match target.kind {
                TargetKind::File => "file",
                TargetKind::Folder => "folder",
                TargetKind::Workspace => "workspace",
            },
            line: target.line,
            column: target.column,
        })
        .collect())
}

fn workbench_path(requested: Option<&str>, current: &url::Url) -> Result<PathBuf, String> {
    let Some(requested) = requested else {
        return Ok(PathBuf::from("index.html"));
    };
    let target = current
        .join(requested)
        .map_err(|e| format!("Invalid window URL: {e}"))?;
    if target.scheme() != current.scheme()
        || target.host_str() != current.host_str()
        || target.port_or_known_default() != current.port_or_known_default()
        || !target.username().is_empty()
        || target.password().is_some()
        || !matches!(target.path(), "/" | "/index.html")
    {
        return Err("New editor windows must use the local workbench URL".to_string());
    }
    let mut path = String::from("index.html");
    if let Some(query) = target.query() {
        path.push('?');
        path.push_str(query);
    }
    if let Some(fragment) = target.fragment() {
        path.push('#');
        path.push_str(fragment);
    }
    Ok(PathBuf::from(path))
}

#[derive(Debug, Serialize)]
pub struct MonitorInfo {
    pub name: Option<String>,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn create_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    label: String,
    title: String,
    url: Option<String>,
) -> Result<(), String> {
    if !label.starts_with("sidex-") {
        return Err("Editor window labels must start with sidex-".to_string());
    }
    let current = window.url().map_err(|e| e.to_string())?;
    // App URLs preserve Tauri's local IPC origin. External pages belong in the
    // system browser, never in a privileged editor window.
    let webview_url = WebviewUrl::App(workbench_path(url.as_deref(), &current)?);

    let builder = WebviewWindowBuilder::new(&app, &label, webview_url)
        .title(&title)
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .use_https_scheme(true);

    let builder = if let Some(portable) = sidex_extensions::paths::portable_data_dir() {
        builder.data_directory(portable.join("webview"))
    } else {
        builder
    };

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).shadow(true);

    builder
        .build()
        .map_err(|e| format!("Failed to create window '{label}': {e}"))?;

    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn close_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window '{label}' not found"))?;

    window
        .close()
        .map_err(|e| format!("Failed to close window '{label}': {e}"))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn set_window_title(app: AppHandle, label: String, title: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window '{label}' not found"))?;

    window
        .set_title(&title)
        .map_err(|e| format!("Failed to set title for '{label}': {e}"))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn get_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitors: {e}"))?;

    Ok(monitors
        .into_iter()
        .map(|m| {
            let size = m.size();
            let pos = m.position();
            MonitorInfo {
                name: m.name().cloned(),
                width: size.width,
                height: size.height,
                x: pos.x,
                y: pos.y,
                scale_factor: m.scale_factor(),
            }
        })
        .collect())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

const WINDOW_STATE_KEY: &str = "sidex.windowState";

#[allow(clippy::cast_possible_wrap)]
pub fn restore_and_show(app: &tauri::App, db: &StorageDb) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if let Ok(Some(json)) = db.get(WINDOW_STATE_KEY) {
        if let Ok(state) = serde_json::from_str::<WindowState>(&json) {
            // Only restores position if it lands on an available monitor.
            let on_screen = app.available_monitors().is_ok_and(|monitors| {
                monitors.iter().any(|m| {
                    let pos = m.position();
                    let size = m.size();
                    let right = pos.x + size.width as i32;
                    let bottom = pos.y + size.height as i32;
                    // Require at least 100x50px of the window to be visible
                    state.x + 100 < right
                        && state.x + state.width as i32 > pos.x + 100
                        && state.y + 50 < bottom
                        && state.y > pos.y - 50
                })
            });

            if on_screen {
                let _ = window.set_size(tauri::PhysicalSize::new(state.width, state.height));
                let _ = window.set_position(tauri::PhysicalPosition::new(state.x, state.y));
                if state.maximized {
                    let _ = window.maximize();
                }
            }
        }
    }

    let _ = window.show();
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn save_window_state(
    app: AppHandle,
    label: String,
    db: tauri::State<'_, Arc<StorageDb>>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window '{label}' not found"))?;

    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let maximized = window.is_maximized().unwrap_or(false);

    let state = WindowState {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
    };

    let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    db.set(WINDOW_STATE_KEY, &json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_windows_preserve_queries_and_reject_external_origins() {
        for origin in [
            "tauri://localhost/",
            "https://tauri.localhost/",
            "http://localhost:1420/",
        ] {
            let current = url::Url::parse(origin).unwrap();
            let path =
                workbench_path(Some("?folder=file%3A%2F%2F%2Fwork%2Fa%20b"), &current).unwrap();
            assert_eq!(
                path,
                PathBuf::from("index.html?folder=file%3A%2F%2F%2Fwork%2Fa%20b")
            );
            assert!(workbench_path(Some("https://example.com/"), &current).is_err());
            assert!(workbench_path(Some("/extensions/untrusted/index.html"), &current).is_err());
            assert!(workbench_path(Some("javascript:alert(1)"), &current).is_err());
        }
    }
}
