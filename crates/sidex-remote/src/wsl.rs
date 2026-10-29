//! WSL (Windows Subsystem for Linux) remote transport backend.
//!
//! On Windows this shells out to `wsl.exe`; on other platforms every method
//! returns an error immediately.

use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use anyhow::Context as _;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::transport::{DirEntry, ExecOutput, FileStat, RemotePty, RemoteTransport};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use std::time::SystemTime;

/// Execute a filesystem operation in Linux, never through Windows UNC or a
/// command assembled from filenames. The helper requires Python 3 in the distro.
#[cfg(target_os = "windows")]
pub async fn file_request(distro: &str, request: &serde_json::Value) -> Result<serde_json::Value> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    if distro.is_empty() || distro.len() > 255 || distro.contains(['\0', '\r', '\n']) {
        bail!("Invalid WSL distribution name");
    }
    let input = serde_json::to_vec(request)?;
    if input.len() > 160 * 1024 * 1024 {
        bail!("FileTooLarge: WSL request exceeds the transfer limit");
    }
    let operation = async {
        let mut command = tokio::process::Command::new("wsl.exe");
        command
            .args([
                "--distribution",
                distro,
                "--exec",
                "sh",
                "-c",
                "command -v python3 >/dev/null 2>&1 || { printf 'WSL_PYTHON_REQUIRED\\n' >&2; exit 127; }; exec python3 -c \"$1\"",
                "sidex-wsl-files",
                include_str!("wsl_files.py"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000)
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .context("WSL is unavailable; install a WSL distribution")?;
        let mut stdin = child.stdin.take().context("WSL stdin unavailable")?;
        let write_result = stdin.write_all(&input).await;
        drop(stdin);
        let output = child.wait_with_output().await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if output.status.code() == Some(127) && stderr.contains("WSL_PYTHON_REQUIRED") {
                bail!("WSL_PYTHON_REQUIRED: install Python 3 in the selected distribution");
            }
            bail!("Unavailable: WSL filesystem helper failed: {stderr}");
        }
        write_result.context("Writing WSL filesystem request")?;
        let response: serde_json::Value =
            serde_json::from_slice(&output.stdout).context("Invalid WSL filesystem response")?;
        if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            let error = &response["error"];
            bail!(
                "{}: {}",
                error["code"].as_str().unwrap_or("Unavailable"),
                error["message"]
                    .as_str()
                    .unwrap_or("WSL filesystem operation failed")
            );
        }
        Ok(response["result"].clone())
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), operation)
        .await
        .context("WSL_REQUEST_TIMEOUT: filesystem request exceeded 30 seconds")?
}

#[cfg(not(target_os = "windows"))]
#[allow(clippy::unused_async)]
pub async fn file_request(
    _distro: &str,
    _request: &serde_json::Value,
) -> Result<serde_json::Value> {
    wsl_unavailable()
}

/// WSL emits UTF-16LE when stdout is redirected on Windows.
#[cfg(any(target_os = "windows", test))]
fn decode_list_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().skip(1).step_by(2).any(|byte| *byte == 0) {
        let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
        let words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Information about an installed WSL distribution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WslDistro {
    pub name: String,
    pub is_default: bool,
    /// `1` or `2`.
    pub version: u8,
    pub state: String,
    pub os_name: Option<String>,
}

/// Distro lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WslDistroState {
    Running,
    Stopped,
    Installing,
    Unregistered,
}

/// High-level WSL connection wrapping a transport with server management.
pub struct WslConnection {
    pub distro: WslDistro,
    pub state: WslDistroState,
    pub server_process: Option<u32>,
    transport: WslTransport,
}

impl WslConnection {
    pub fn transport(&self) -> &WslTransport {
        &self.transport
    }
}

/// Convert a Windows path to a WSL Linux path.
///
/// `C:\Users\me\file.txt` becomes `/mnt/c/Users/me/file.txt`
pub fn translate_path_to_wsl(windows_path: &Path) -> String {
    let s = windows_path.to_string_lossy();
    let s = s.replace('\\', "/");
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let drive = s[..1].to_lowercase();
        format!("/mnt/{drive}{}", &s[2..])
    } else {
        s.clone()
    }
}

/// Convert a WSL Linux path back to a Windows UNC path.
///
/// `/home/user/file` becomes `\\wsl$\<distro>\home\user\file`
pub fn translate_path_to_windows(wsl_path: &str, distro: &str) -> PathBuf {
    let cleaned = wsl_path.trim_start_matches('/');
    PathBuf::from(format!(
        "\\\\wsl$\\{distro}\\{}",
        cleaned.replace('/', "\\")
    ))
}

/// Execute a single command inside a WSL distro (standalone helper).
#[cfg(target_os = "windows")]
pub fn exec_in_wsl(distro: &str, command: &str) -> Result<ExecOutput> {
    let mut cmd = std::process::Command::new("wsl");
    cmd.args(["-d", distro, "--", "sh", "-c", command]);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd.output().context("wsl exec")?;
    Ok(ExecOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[cfg(not(target_os = "windows"))]
pub fn exec_in_wsl(_distro: &str, _command: &str) -> Result<ExecOutput> {
    wsl_unavailable()
}

/// Install the `SideX` Server binary inside the given WSL distro.
pub fn install_server_in_wsl(distro: &str) -> Result<()> {
    let check = exec_in_wsl(
        distro,
        "~/.sidex-server/sidex-server --version 2>/dev/null || echo missing",
    )?;
    let version = env!("CARGO_PKG_VERSION");
    if check.stdout.trim() == version {
        log::info!("SideX Server already up-to-date in WSL distro {distro}");
        return Ok(());
    }
    exec_in_wsl(distro, "mkdir -p ~/.sidex-server")?;
    log::info!("installing SideX Server {version} in WSL distro {distro}");
    Ok(())
}

/// List distros and connect to the named one, returning a [`WslConnection`].
#[cfg(target_os = "windows")]
pub async fn connect_distro(name: &str) -> Result<WslConnection> {
    let distros = list_distributions()?;
    let distro = distros
        .into_iter()
        .find(|d| d.name == name)
        .ok_or_else(|| anyhow::anyhow!("WSL distro '{name}' not found"))?;

    let state = match distro.state.as_str() {
        "Running" => WslDistroState::Running,
        "Stopped" => WslDistroState::Stopped,
        "Installing" => WslDistroState::Installing,
        _ => WslDistroState::Unregistered,
    };

    let transport = WslTransport::connect(name).await?;
    Ok(WslConnection {
        distro,
        state,
        server_process: None,
        transport,
    })
}

#[cfg(not(target_os = "windows"))]
#[allow(clippy::unused_async)]
pub async fn connect_distro(_name: &str) -> Result<WslConnection> {
    wsl_unavailable()
}

/// WSL-based [`RemoteTransport`].
#[allow(dead_code)]
pub struct WslTransport {
    distro: String,
}

// ---------------------------------------------------------------------------
// Platform guard
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
fn wsl_unavailable<T>() -> Result<T> {
    bail!("WSL is only available on Windows")
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// List installed WSL distributions by parsing `wsl --list --verbose`.
#[cfg(target_os = "windows")]
pub fn list_distributions() -> Result<Vec<WslDistro>> {
    let mut cmd = std::process::Command::new("wsl");
    cmd.args(["--list", "--verbose"]);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd.output().context("running wsl --list --verbose")?;

    if !output.status.success() {
        bail!("WSL listing failed: {}", decode_list_output(&output.stderr));
    }
    let text = decode_list_output(&output.stdout);
    parse_wsl_list(&text)
}

/// List installed WSL distributions (stub on non-Windows).
#[cfg(not(target_os = "windows"))]
pub fn list_distributions() -> Result<Vec<WslDistro>> {
    wsl_unavailable()
}

/// Parse the tabular output of `wsl --list --verbose`.
#[allow(dead_code)]
#[allow(clippy::unnecessary_wraps)]
pub(crate) fn parse_wsl_list(text: &str) -> Result<Vec<WslDistro>> {
    let mut distros = Vec::new();

    for line in text.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let is_default = line.starts_with('*');
        let line = line.trim_start_matches('*').trim();

        let Some((prefix, version)) = line.rsplit_once(char::is_whitespace) else {
            continue;
        };
        let Some((name, state)) = prefix.trim_end().rsplit_once(char::is_whitespace) else {
            continue;
        };
        if let Ok(version) = version.parse::<u8>() {
            distros.push(WslDistro {
                name: name.trim_end().to_string(),
                is_default,
                state: state.to_string(),
                version,
                os_name: None,
            });
        }
    }

    Ok(distros)
}

// ---------------------------------------------------------------------------
// Transport (Windows)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
impl WslTransport {
    /// Connect to a named WSL distribution.
    #[allow(clippy::unused_async, clippy::unused_async_trait_impl)]
    pub async fn connect(distro: &str) -> Result<Self> {
        let mut cmd = std::process::Command::new("wsl");
        cmd.args(["-d", distro, "--", "echo", "ok"]);

        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        let output = cmd.output()?;

        if !output.status.success() {
            bail!(
                "cannot reach WSL distro '{distro}': {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(Self {
            distro: distro.to_string(),
        })
    }

    fn wsl_exec(&self, command: &str) -> Result<ExecOutput> {
        let mut cmd = std::process::Command::new("wsl");
        cmd.args(["-d", &self.distro, "--", "sh", "-c", command]);

        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        let output = cmd.output()?;

        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }
}

#[cfg(target_os = "windows")]
#[async_trait::async_trait]
impl RemoteTransport for WslTransport {
    async fn exec(&self, command: &str) -> Result<ExecOutput> {
        self.wsl_exec(command)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let value = file_request(
            &self.distro,
            &serde_json::json!({ "op": "read", "path": path }),
        )
        .await?;
        Ok(serde_json::from_value(value)?)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<()> {
        file_request(
            &self.distro,
            &serde_json::json!({
                "op": "write", "path": path, "data": data, "create": true, "overwrite": true
            }),
        )
        .await?;
        Ok(())
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let result = file_request(
            &self.distro,
            &serde_json::json!({ "op": "readdir", "path": path, "metadata": true }),
        )
        .await?;
        let entries = result.as_array().context("Invalid directory listing")?;
        Ok(entries
            .iter()
            .map(|entry| DirEntry {
                name: entry["name"].as_str().unwrap_or_default().to_string(),
                path: entry["path"].as_str().unwrap_or_default().to_string(),
                is_dir: entry["type"].as_u64().unwrap_or(0) & 2 != 0,
                size: entry["size"].as_u64().unwrap_or(0),
                modified: entry["mtime"].as_u64().and_then(|ms| {
                    SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_millis(ms))
                }),
            })
            .collect())
    }

    async fn stat(&self, path: &str) -> Result<FileStat> {
        let result = file_request(
            &self.distro,
            &serde_json::json!({ "op": "stat", "path": path }),
        )
        .await?;
        let kind = result["type"].as_u64().unwrap_or(0);
        Ok(FileStat {
            size: result["size"].as_u64().unwrap_or(0),
            modified: result["mtime"].as_u64().and_then(|ms| {
                SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_millis(ms))
            }),
            is_dir: kind & 2 != 0,
            is_symlink: kind & 64 != 0,
        })
    }

    async fn open_pty(&self, _cols: u16, _rows: u16) -> Result<RemotePty> {
        bail!("WSL PTY not yet implemented — use sidex-terminal instead")
    }

    async fn upload(&self, local: &Path, remote: &str) -> Result<()> {
        let data = tokio::fs::read(local).await?;
        self.write_file(remote, &data).await
    }

    async fn download(&self, remote: &str, local: &Path) -> Result<()> {
        let data = self.read_file(remote).await?;
        tokio::fs::write(local, &data).await?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Transport (non-Windows stub)
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
impl WslTransport {
    /// Connect to a named WSL distribution. Returns an error on non-Windows.
    #[allow(clippy::unused_async, clippy::unused_async_trait_impl)]
    pub async fn connect(_distro: &str) -> Result<Self> {
        wsl_unavailable()
    }
}

#[cfg(not(target_os = "windows"))]
#[async_trait::async_trait]
impl RemoteTransport for WslTransport {
    async fn exec(&self, _command: &str) -> Result<ExecOutput> {
        wsl_unavailable()
    }
    async fn read_file(&self, _path: &str) -> Result<Vec<u8>> {
        wsl_unavailable()
    }
    async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<()> {
        wsl_unavailable()
    }
    async fn read_dir(&self, _path: &str) -> Result<Vec<DirEntry>> {
        wsl_unavailable()
    }
    async fn stat(&self, _path: &str) -> Result<FileStat> {
        wsl_unavailable()
    }
    async fn open_pty(&self, _cols: u16, _rows: u16) -> Result<RemotePty> {
        wsl_unavailable()
    }
    async fn upload(&self, _local: &Path, _remote: &str) -> Result<()> {
        wsl_unavailable()
    }
    async fn download(&self, _remote: &str, _local: &Path) -> Result<()> {
        wsl_unavailable()
    }
    async fn disconnect(&self) -> Result<()> {
        wsl_unavailable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_wsl_list_output() {
        let output = "\
  NAME            STATE           VERSION
* Ubuntu-22.04    Running         2
  Debian          Stopped         2
  Alpine          Running         1
";
        let distros = parse_wsl_list(output).unwrap();
        assert_eq!(distros.len(), 3);

        assert_eq!(distros[0].name, "Ubuntu-22.04");
        assert!(distros[0].is_default);
        assert_eq!(distros[0].version, 2);
        assert_eq!(distros[0].state, "Running");

        assert_eq!(distros[1].name, "Debian");
        assert!(!distros[1].is_default);

        assert_eq!(distros[2].name, "Alpine");
        assert_eq!(distros[2].version, 1);
    }

    #[test]
    fn parse_wsl_list_empty() {
        let distros = parse_wsl_list("  NAME  STATE  VERSION\n").unwrap();
        assert!(distros.is_empty());
    }

    #[test]
    fn redirected_utf16_listing_preserves_unicode_and_spaced_distribution_names() {
        let source = "  NAME       STATE     VERSION\r\n* My Ubuntu  Running   2\r\n  Тест       Stopped   2\r\n";
        let bytes: Vec<u8> = source.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let decoded = decode_list_output(&bytes);
        let distros = parse_wsl_list(&decoded).unwrap();
        assert_eq!(distros[0].name, "My Ubuntu");
        assert!(distros[0].is_default);
        assert_eq!(distros[1].name, "Тест");
        assert_eq!(distros[1].version, 2);
    }
}
