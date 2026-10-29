//! Parse desktop launch arguments without involving a webview or shell.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetKind {
    File,
    Folder,
    Workspace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenTarget {
    pub path: PathBuf,
    pub kind: TargetKind,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Default)]
pub struct LaunchOptions {
    pub targets: Vec<OpenTarget>,
    pub help: bool,
    pub version: bool,
}

pub const HELP: &str = "SideX [options] [paths...]\n\nOpen a folder, .code-workspace, or files. Relative paths use the launching shell's directory.\n\n  -g, --goto <file:line[:column]>  Open a file at a position\n  -n, --new-window                Open in a new application window\n  -h, --help                      Print this help\n  -v, --version                   Print the application version\n  --                             Treat remaining arguments as paths";

pub fn parse(
    args: impl IntoIterator<Item = OsString>,
    cwd: &Path,
) -> Result<LaunchOptions, String> {
    let mut options = LaunchOptions::default();
    let mut literal_paths = false;
    let mut goto = false;
    for arg in args {
        if !literal_paths {
            match arg.to_str() {
                Some("--") => {
                    literal_paths = true;
                    continue;
                }
                Some("-h" | "--help") => {
                    options.help = true;
                    continue;
                }
                Some("-v" | "--version") => {
                    options.version = true;
                    continue;
                }
                Some("-n" | "--new-window") => continue,
                Some("-g" | "--goto") => {
                    goto = true;
                    continue;
                }
                // Finder supplies this process serial-number argument on older macOS.
                Some(value) if value.starts_with("-psn_") => continue,
                Some(value) if value.starts_with('-') => {
                    return Err(format!("Unknown option: {value}\n\n{HELP}"));
                }
                _ => {}
            }
        }
        let (path, line, column) = if goto {
            let value = arg.to_str().ok_or("--goto requires a UTF-8 file path")?;
            let (path, line, column) = split_position(value);
            (PathBuf::from(path), line, column)
        } else {
            (PathBuf::from(arg), None, None)
        };
        goto = false;
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        let kind = if path.is_dir() {
            TargetKind::Folder
        } else if path.extension().is_some_and(|ext| ext == "code-workspace") {
            TargetKind::Workspace
        } else {
            TargetKind::File
        };
        options.targets.push(OpenTarget {
            path,
            kind,
            line,
            column,
        });
    }
    if goto {
        return Err("--goto requires a file path".to_string());
    }
    Ok(options)
}

fn split_position(value: &str) -> (&str, Option<u32>, Option<u32>) {
    let Some((prefix, number)) = value.rsplit_once(':') else {
        return (value, None, None);
    };
    let Ok(last) = number.parse::<u32>() else {
        return (value, None, None);
    };
    if let Some((path, number)) = prefix.rsplit_once(':') {
        if let Ok(line) = number.parse::<u32>() {
            return (path, Some(line.max(1)), Some(last.max(1)));
        }
    }
    (prefix, Some(last.max(1)), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn relative_dot_opens_the_launch_directory() {
        let cwd = std::env::current_dir().unwrap();
        let parsed = parse(args(&["."]), &cwd).unwrap();
        assert_eq!(parsed.targets[0].kind, TargetKind::Folder);
        assert_eq!(parsed.targets[0].path, cwd.join("."));
    }

    #[test]
    fn files_with_spaces_unicode_and_literal_options_are_not_shell_parsed() {
        let cwd = Path::new("/work");
        let parsed = parse(args(&["src/пример file.ts", "--", "-name.txt"]), cwd).unwrap();
        assert_eq!(parsed.targets[0].path, cwd.join("src/пример file.ts"));
        assert_eq!(parsed.targets[1].path, cwd.join("-name.txt"));
    }

    #[test]
    fn goto_preserves_windows_drives_and_defaults_positions() {
        assert_eq!(
            split_position("C:\\work\\file.ts:12:3"),
            ("C:\\work\\file.ts", Some(12), Some(3))
        );
        assert_eq!(
            split_position("C:\\work\\file.ts:12"),
            ("C:\\work\\file.ts", Some(12), None)
        );
        assert_eq!(
            split_position("/work/file.ts:0:0"),
            ("/work/file.ts", Some(1), Some(1))
        );
    }

    #[test]
    fn validates_options_and_recognizes_workspace_files() {
        assert!(parse(args(&["--goto"]), Path::new("/work")).is_err());
        assert!(parse(args(&["--unknown"]), Path::new("/work")).is_err());
        let parsed = parse(args(&["project.code-workspace"]), Path::new("/work")).unwrap();
        assert_eq!(parsed.targets[0].kind, TargetKind::Workspace);
    }
}
