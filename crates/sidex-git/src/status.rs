//! Git status — parse `git status --porcelain=v2`.

use std::path::Path;

use serde::Serialize;

use crate::cmd::run_git;
use crate::error::GitResult;

/// High-level status of a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflicted,
    Copied,
}

/// One entry from `git status`.
#[derive(Debug, Clone, Serialize)]
pub struct StatusEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub status: FileStatus,
    pub staged: bool,
}

/// NUL-delimited porcelain preserves spaces, quotes, Unicode and newlines in names.
pub fn get_status(repo_root: &Path) -> GitResult<Vec<StatusEntry>> {
    let output = run_git(repo_root, &["status", "--porcelain=v2", "-z", "-uall"])?;
    Ok(parse_status(&output))
}

fn parse_status(output: &str) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    let mut records = output.split('\0');
    while let Some(record) = records.next() {
        let kind = record.as_bytes().first();
        if matches!(kind, Some(b'?' | b'!')) {
            entries.push(StatusEntry {
                path: record.get(2..).unwrap_or_default().to_owned(),
                original_path: None,
                status: if kind == Some(&b'?') {
                    FileStatus::Untracked
                } else {
                    FileStatus::Ignored
                },
                staged: false,
            });
            continue;
        }
        let fields = match kind {
            Some(b'1') => 9,
            Some(b'2') => 10,
            Some(b'u') => 11,
            _ => continue,
        };
        let parts: Vec<_> = record.splitn(fields, ' ').collect();
        if parts.len() != fields {
            continue;
        }
        let path = parts[fields - 1];
        let original = if kind == Some(&b'2') {
            records.next().map(str::to_owned)
        } else {
            None
        };
        if kind == Some(&b'u') {
            entries.push(StatusEntry {
                path: path.to_owned(),
                original_path: original,
                status: FileStatus::Conflicted,
                staged: false,
            });
            continue;
        }
        // A partially staged file belongs to both groups, with separate baselines.
        for (index, status) in parts[1].bytes().take(2).enumerate() {
            if status == b'.' {
                continue;
            }
            entries.push(StatusEntry {
                path: path.to_owned(),
                original_path: if index == 0 { original.clone() } else { None },
                status: char_to_status(status),
                staged: index == 0,
            });
        }
    }
    entries
}

fn char_to_status(c: u8) -> FileStatus {
    match c {
        b'A' => FileStatus::Added,
        b'D' => FileStatus::Deleted,
        b'R' => FileStatus::Renamed,
        b'C' => FileStatus::Copied,
        _ => FileStatus::Modified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_repo() -> TempDir {
        let tmp = TempDir::new().unwrap();
        std::process::Command::new("git")
            .current_dir(tmp.path())
            .args(["init", "-b", "main"])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .current_dir(tmp.path())
            .args(["config", "user.email", "test@test.com"])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .current_dir(tmp.path())
            .args(["config", "user.name", "Test"])
            .output()
            .unwrap();
        tmp
    }

    #[test]
    fn nul_records_preserve_names_and_partial_staging() {
        let records =
            "1 MM N... 100644 100644 100644 abc abc файл with\nline.txt\0? new\tfile.txt\0";
        let entries = parse_status(records);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "файл with\nline.txt");
        assert!(entries[0].staged);
        assert!(!entries[1].staged);
        assert_eq!(entries[2].path, "new\tfile.txt");
    }

    #[test]
    fn rename_records_preserve_old_and_new_path() {
        let entries = parse_status(
            "2 RM N... 100644 100644 100644 abc abc R100 new name.txt\0old name.txt\0",
        );
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "new name.txt");
        assert_eq!(entries[0].original_path.as_deref(), Some("old name.txt"));
        assert!(entries[1].original_path.is_none());
    }

    #[test]
    fn untracked_files_detected() {
        let tmp = init_repo();
        fs::write(tmp.path().join("new.txt"), "hello").unwrap();

        let entries = get_status(tmp.path()).unwrap();
        assert!(!entries.is_empty());
        assert!(entries
            .iter()
            .any(|e| e.path == "new.txt" && e.status == FileStatus::Untracked));
    }

    #[test]
    fn staged_files_detected() {
        let tmp = init_repo();
        fs::write(tmp.path().join("a.txt"), "a").unwrap();
        std::process::Command::new("git")
            .current_dir(tmp.path())
            .args(["add", "a.txt"])
            .output()
            .unwrap();

        let entries = get_status(tmp.path()).unwrap();
        let entry = entries.iter().find(|e| e.path == "a.txt").unwrap();
        assert!(entry.staged);
        assert_eq!(entry.status, FileStatus::Added);
    }
}
