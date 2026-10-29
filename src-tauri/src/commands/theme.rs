use serde::Serialize;
use sidex_theme::builtin::{find_theme, themes, BundledTheme};
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    id: String,
    label: String,
    ui_theme: String,
}

/// VS Code-style color IDs and camelCase token settings cross the IPC boundary unchanged.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeData {
    workbench_colors: HashMap<String, String>,
    token_colors: Vec<serde_json::Value>,
    semantic_token_colors: HashMap<String, serde_json::Value>,
    semantic_highlighting: bool,
}

fn theme_to_data(theme: &BundledTheme) -> ThemeData {
    ThemeData {
        workbench_colors: theme.colors.clone(),
        token_colors: theme.token_colors.clone(),
        semantic_token_colors: theme.semantic_token_colors.clone(),
        semantic_highlighting: theme.semantic_highlighting,
    }
}

#[tauri::command]
#[allow(clippy::unnecessary_wraps)]
pub fn theme_list() -> Result<Vec<ThemeInfo>, String> {
    let mut entries: Vec<_> = themes()
        .iter()
        .map(|theme| ThemeInfo {
            id: theme.id.to_lowercase().replace(' ', "-"),
            label: theme.label.clone(),
            ui_theme: theme.ui_theme.clone(),
        })
        .collect();
    entries.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(entries)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn theme_get(id: String) -> Result<ThemeData, String> {
    find_theme(&id)
        .map(theme_to_data)
        .ok_or_else(|| format!("theme not found: {id}"))
}

#[tauri::command]
pub fn theme_get_default_dark() -> Result<ThemeData, String> {
    theme_get("Default Dark Modern".to_owned())
}

#[tauri::command]
pub fn theme_get_default_light() -> Result<ThemeData, String> {
    theme_get("Default Light Modern".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_ipc_preserves_vscode_color_ids_and_token_settings() {
        let theme = theme_get("Quiet Light".into()).unwrap();
        let value = serde_json::to_value(theme).unwrap();
        assert_eq!(value["workbenchColors"]["editor.background"], "#F5F5F5");
        assert!(value["tokenColors"].as_array().unwrap().len() > 10);
        assert_eq!(
            theme_list()
                .unwrap()
                .iter()
                .find(|theme| theme.id == "quiet-light")
                .unwrap()
                .ui_theme,
            "vs"
        );
    }
}
