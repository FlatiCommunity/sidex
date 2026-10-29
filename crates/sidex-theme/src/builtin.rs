//! Official VS Code color themes, flattened by the checked-in asset generator.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::Value;

use crate::theme::Theme;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledTheme {
    pub id: String,
    pub label: String,
    pub ui_theme: String,
    pub colors: HashMap<String, String>,
    pub token_colors: Vec<Value>,
    pub semantic_token_colors: HashMap<String, Value>,
    pub semantic_highlighting: bool,
}

static THEMES: LazyLock<Vec<BundledTheme>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("builtin_themes.json"))
        .expect("bundled themes are validated during source generation")
});

pub fn themes() -> &'static [BundledTheme] {
    &THEMES
}

fn normalize_id(id: &str) -> String {
    let id = id.trim().to_ascii_lowercase();
    let id = id
        .strip_prefix("vs-dark ")
        .or_else(|| id.strip_prefix("vs "))
        .or_else(|| id.strip_prefix("hc-black "))
        .or_else(|| id.strip_prefix("hc-light "))
        .unwrap_or(&id);
    id.strip_prefix("sidex-builtin-")
        .unwrap_or(id)
        .replace('-', " ")
}

pub fn find_theme(id: &str) -> Option<&'static BundledTheme> {
    let normalized = normalize_id(id);
    themes().iter().find(|theme| {
        normalize_id(&theme.id) == normalized || normalize_id(&theme.label) == normalized
    })
}

pub fn parsed_themes() -> Vec<Theme> {
    let mut themes: Vec<Theme> = themes()
        .iter()
        .map(|theme| {
            let kind = match theme.ui_theme.as_str() {
                "vs" => "light",
                "hc-black" => "hc",
                "hc-light" => "hcLight",
                _ => "dark",
            };
            Theme::from_value(&serde_json::json!({
                "name": theme.id,
                "type": kind,
                "colors": theme.colors,
                "tokenColors": theme.token_colors,
            }))
            .expect("bundled theme must parse")
        })
        .collect();
    if let Some(index) = themes
        .iter()
        .position(|theme| theme.name == "Default Dark Modern")
    {
        themes.swap(0, index);
    }
    themes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ThemeKind;

    #[test]
    fn classic_themes_have_complete_colors_and_tokens() {
        for name in [
            "Quiet Light",
            "Monokai",
            "Solarized Light",
            "Default Dark Modern",
        ] {
            let theme = find_theme(name).unwrap();
            assert!(theme.colors.contains_key("editor.background"));
            assert!(theme.token_colors.len() > 10);
        }
        let quiet = parsed_themes()
            .into_iter()
            .find(|theme| theme.name == "Quiet Light")
            .unwrap();
        assert_eq!(quiet.kind, ThemeKind::Light);
        assert!(quiet.workbench_colors.editor_background.is_some());
    }

    #[test]
    fn display_names_and_legacy_picker_ids_resolve() {
        for id in [
            "Quiet Light",
            "quiet-light",
            "sidex-builtin-quiet-light",
            "vs sidex-builtin-quiet-light",
        ] {
            assert_eq!(find_theme(id).unwrap().id, "Quiet Light");
        }
        assert!(find_theme("unknown").is_none());
    }
}
