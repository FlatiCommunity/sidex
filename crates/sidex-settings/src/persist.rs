//! Atomic edits of the current on-disk settings document.

use anyhow::{Context, Result};
use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// Change one top-level setting without replacing unrelated values or comments.
/// The caller serializes edits to the same file.
pub fn persist_setting(path: &Path, key: &str, value: &Value) -> Result<()> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "{\n}\n".to_string(),
        Err(error) => return Err(error).context("could not read settings before updating"),
    };
    let updated = crate::modify_jsonc(&contents, &[key], value)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let temporary = path.with_extension(format!(
        "json.tmp.{}.{timestamp}.{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        if let Ok(metadata) = std::fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(updated.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.context("could not atomically save settings")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sidex-settings-test-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn sequential_updates_keep_external_edits_comments_and_value_types() {
        let directory = test_directory();
        let path = directory.join("settings.json");
        std::fs::write(&path, "{\n // keep me\n \"external\": \"Кириллица\"\n}\n").unwrap();
        persist_setting(&path, "enabled", &Value::Bool(true)).unwrap();
        persist_setting(&path, "size", &Value::from(15)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("// keep me"));
        let value = crate::parse_jsonc(&text).unwrap();
        assert_eq!(value["external"], "Кириллица");
        assert_eq!(value["enabled"], true);
        assert_eq!(value["size"], 15);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_existing_document_is_never_overwritten() {
        let directory = test_directory();
        let path = directory.join("settings.json");
        std::fs::write(&path, "{ invalid user edits").unwrap();
        assert!(persist_setting(&path, "enabled", &Value::Bool(true)).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ invalid user edits"
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
