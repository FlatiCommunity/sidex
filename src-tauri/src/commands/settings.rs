use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use serde_json::Value;
use sidex_settings::{Settings, modify_jsonc, parse_jsonc, persist_setting};
use tauri::{AppHandle, State};

pub struct SettingsStore {
    pub(crate) inner: RwLock<Settings>,
    /// Path of the user settings.json — set during app startup so user-scope
    /// updates can be persisted to disk (otherwise toggles vanish on restart).
    user_path: RwLock<Option<PathBuf>>,
    user_updates: Mutex<()>,
}

impl SettingsStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Settings::new()),
            user_path: RwLock::new(None),
            user_updates: Mutex::new(()),
        }
    }

    pub fn load_user(&self, path: &std::path::Path) -> Result<(), String> {
        let _guard = self.user_updates.lock().map_err(|e| e.to_string())?;
        self.set_user_path(path);
        self.inner
            .write()
            .map_err(|e| e.to_string())?
            .load_user(path)
            .map_err(|e| e.to_string())
    }

    /// Record where the user settings file lives so later updates persist.
    pub fn set_user_path(&self, path: &std::path::Path) {
        if let Ok(mut p) = self.user_path.write() {
            *p = Some(path.to_path_buf());
        }
    }

    /// Serialize updates and edit the latest disk contents, preserving unrelated edits.
    fn update_user(&self, key: &str, value: Value) -> Result<(), String> {
        let _guard = self.user_updates.lock().map_err(|e| e.to_string())?;
        let path = self.user_path.read().map_err(|e| e.to_string())?.clone();
        if let Some(path) = path {
            persist_setting(&path, key, &value).map_err(|e| format!("{e:#}"))?;
            self.inner
                .write()
                .map_err(|e| e.to_string())?
                .load_user(&path)
                .map_err(|e| e.to_string())?;
        } else {
            self.inner
                .write()
                .map_err(|e| e.to_string())?
                .set(key, value);
        }
        Ok(())
    }

    pub fn load_workspace(&self, path: &std::path::Path) -> Result<(), String> {
        self.inner
            .write()
            .map_err(|e| e.to_string())?
            .load_workspace(path)
            .map_err(|e| e.to_string())
    }
}

/// Get settings.
///
/// - `section`: if provided, returns only the value for that key
/// - `scope`: one of `"user"`, `"workspace"`, or omitted/`"merged"` for the
///   full merged object across all layers
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_get(
    state: State<'_, Arc<SettingsStore>>,
    section: Option<String>,
    scope: Option<String>,
) -> Result<Value, String> {
    let settings = state.inner.read().map_err(|e| e.to_string())?;

    if let Some(key) = section {
        if let Some(value) = settings.get_raw(&key) {
            return Ok(value.clone());
        }

        let section = settings.get_section(&key);
        return if section.as_object().is_some_and(serde_json::Map::is_empty) {
            Ok(Value::Null)
        } else {
            Ok(section)
        };
    }

    match scope.as_deref() {
        Some("user") => Ok(settings.user_layer().clone()),
        Some("workspace") => Ok(settings.workspace_layer().clone()),
        Some("merged") | None => {
            let mut merged = serde_json::Map::new();
            // Collect all keys across layers via the builtin defaults as the
            // canonical key set, then overlay user/workspace via get_raw.
            let defaults = sidex_settings::builtin_defaults();
            if let Some(obj) = defaults.as_object() {
                for key in obj.keys() {
                    if let Some(val) = settings.get_raw(key) {
                        merged.insert(key.clone(), val.clone());
                    }
                }
            }
            Ok(Value::Object(merged))
        }
        Some(other) => Err(format!(
            "invalid scope '{other}': expected \"user\", \"workspace\", or \"merged\""
        )),
    }
}

/// Update a setting.
///
/// `scope` must be `"user"` or `"workspace"`.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_update(
    state: State<'_, Arc<SettingsStore>>,
    app: AppHandle,
    key: String,
    value: Value,
    scope: String,
) -> Result<(), String> {
    match scope.as_str() {
        "user" => state.update_user(&key, value)?,
        "workspace" => state
            .inner
            .write()
            .map_err(|e| e.to_string())?
            .set_workspace(&key, value),
        _ => {
            return Err(format!(
                "invalid scope '{scope}': expected user or workspace"
            ));
        }
    }

    // This setting owns SideX's bundled loopback server only. Keep the
    // lifecycle hook here so every settings client (not only the UI toggle)
    // applies it consistently, without touching system or external agents.
    if key == "sidex.agent.enabled" {
        if let Err(e) = crate::server::sync_enabled_from_settings(&app) {
            log::warn!("failed to apply sidex.agent.enabled: {e}");
        }
    }

    Ok(())
}

/// Load settings from a JSONC file into the specified layer.
///
/// `scope` must be `"user"` or `"workspace"`.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_load(
    state: State<'_, Arc<SettingsStore>>,
    path: String,
    scope: String,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    match scope.as_str() {
        "user" => state.load_user(p),
        "workspace" => state.load_workspace(p),
        _ => Err(format!(
            "invalid scope '{scope}': expected \"user\" or \"workspace\""
        )),
    }
}

/// Parse a JSONC string (strips comments & trailing commas) and return the
/// resulting JSON value. Useful for the frontend to preview or validate
/// settings files.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_parse_jsonc(input: String) -> Result<Value, String> {
    parse_jsonc(&input).map_err(|e| e.to_string())
}

/// Edit a value inside a JSONC document by key-path, preserving surrounding
/// comments and formatting. Returns the modified JSONC string.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_modify_jsonc(
    input: String,
    path: Vec<String>,
    value: Value,
) -> Result<String, String> {
    let refs: Vec<&str> = path.iter().map(String::as_str).collect();
    modify_jsonc(&input, &refs, &value).map_err(|e| e.to_string())
}
