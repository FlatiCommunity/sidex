use serde::Serialize;
use std::env;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize)]
pub struct OsInfo {
    pub platform: String,
    pub arch: String,
    pub hostname: String,
    pub homedir: String,
    pub tmpdir: String,
}

#[tauri::command]
pub fn get_os_info() -> OsInfo {
    OsInfo {
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        hostname: hostname::get().map_or_else(
            |_| "unknown".to_string(),
            |h| h.to_string_lossy().to_string(),
        ),
        homedir: dirs::home_dir().map_or_else(
            || "unknown".to_string(),
            |p| p.to_string_lossy().to_string(),
        ),
        tmpdir: env::temp_dir().to_string_lossy().to_string(),
    }
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn get_env(key: String) -> Option<String> {
    env::var(&key).ok()
}

const SENSITIVE_ENV_PATTERNS: &[&str] = &[
    "SECRET",
    "TOKEN",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "PRIVATE_KEY",
    "API_KEY",
    "APIKEY",
    "AUTH",
    "AWS_",
    "AZURE_",
    "GCP_",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "DOCKER_PASSWORD",
    "SSH_",
    "GPG_",
];

#[tauri::command]
pub fn get_all_env() -> std::collections::HashMap<String, String> {
    env::vars()
        .filter(|(key, _)| {
            let upper = key.to_uppercase();
            !SENSITIVE_ENV_PATTERNS.iter().any(|p| upper.contains(p))
        })
        .collect()
}

#[tauri::command]
pub fn get_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            super::terminal::resolve_windows_shell()
        } else {
            "/bin/sh".to_string()
        }
    })
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn get_user_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let user_dir = resolve_user_data_dir(&app)?;
    std::fs::create_dir_all(&user_dir)
        .map_err(|e| format!("failed to create UserData dir: {e}"))?;
    Ok(user_dir.to_string_lossy().to_string())
}

pub(crate) fn resolve_user_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_dirs::app_data_dir().join("UserData");
    if sidex_extensions::paths::portable_data_dir().is_none() && !dir.exists() {
        // Earlier builds used Tauri's identifier directory on Windows/macOS,
        // while the native settings service read SideX/UserData instead.
        let previous = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("UserData");
        if previous != dir && previous.is_dir() {
            copy_user_data(&previous, &dir)
                .map_err(|e| format!("Could not migrate user data: {e}"))?;
        }
    }
    Ok(dir)
}

fn copy_user_data(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_user_data(&entry.path(), &destination)?;
        } else if kind.is_file() && !destination.exists() {
            std::fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}
