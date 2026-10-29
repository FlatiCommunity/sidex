//! SSH workspace files and PTYs share an authenticated native connection.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sidex_remote::transport::RemoteTransport;
use tauri::{Emitter, State, Window};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use super::remote::RemoteManagerStore;
use super::terminal::stream::Utf8Decoder;

async fn transport(
    store: &RemoteManagerStore,
    authority: &str,
) -> Result<Arc<dyn RemoteTransport>, String> {
    store
        .inner
        .lock()
        .await
        .get_by_label(authority)
        .ok_or_else(|| {
            format!("SSH_NOT_CONNECTED: reconnect to {authority} using Connect to SSH Host")
        })
}

#[tauri::command]
pub async fn remote_ssh_probe_host(
    host: String,
    port: u16,
) -> Result<sidex_remote::ssh::HostKeyInfo, String> {
    if port == 0
        || host.is_empty()
        || host.contains(char::is_whitespace)
        || host.contains(char::is_control)
    {
        return Err("invalid SSH host or port".into());
    }
    sidex_remote::ssh::probe_host_key(&host, port)
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn remote_ssh_file_request(
    authority: String,
    request: Value,
    store: State<'_, Arc<RemoteManagerStore>>,
) -> Result<Value, String> {
    let transport = transport(&store, &authority).await?;
    transport
        .file_request(request)
        .await
        .map_err(|error| format!("{error:#}"))
}

enum PtyControl {
    Write(Vec<u8>),
    Resize(u16, u16),
    Acknowledge(usize),
    Kill,
}

struct PtyEntry {
    owner: String,
    sender: mpsc::Sender<PtyControl>,
}

#[derive(Default)]
pub struct SshTerminalStore {
    terminals: Mutex<HashMap<u64, PtyEntry>>,
}

impl SshTerminalStore {
    fn sender(&self, id: u64, owner: &str) -> Result<mpsc::Sender<PtyControl>, String> {
        self.terminals
            .lock()
            .map_err(|error| error.to_string())?
            .get(&id)
            .filter(|entry| entry.owner == owner)
            .map(|entry| entry.sender.clone())
            .ok_or_else(|| "SSH terminal does not belong to this window or has exited".into())
    }

    pub fn close_window(&self, owner: &str) {
        if let Ok(mut terminals) = self.terminals.lock() {
            let ids: Vec<u64> = terminals
                .iter()
                .filter(|(_, entry)| entry.owner == owner)
                .map(|(&id, _)| id)
                .collect();
            for id in ids {
                if let Some(entry) = terminals.remove(&id) {
                    tauri::async_runtime::spawn(async move {
                        let _ = entry.sender.send(PtyControl::Kill).await;
                    });
                }
            }
        }
    }
}

static NEXT_TERMINAL: AtomicU64 = AtomicU64::new(1);

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Preserve the named Tauri IPC parameters alongside the injected window and application state"
)]
pub async fn remote_ssh_terminal_spawn(
    window: Window,
    authority: String,
    cwd: String,
    cols: u16,
    rows: u16,
    client_id: String,
    shell: Option<String>,
    args: Option<Vec<String>>,
    remote: State<'_, Arc<RemoteManagerStore>>,
    store: State<'_, Arc<SshTerminalStore>>,
) -> Result<u64, String> {
    if cols == 0 || rows == 0 || !cwd.starts_with('/') || cwd.contains('\0') {
        return Err("invalid SSH terminal size or working directory".into());
    }
    let transport = transport(&remote, &authority).await?;
    let stat = transport
        .stat(&cwd)
        .await
        .map_err(|error| format!("{error:#}"))?;
    if !stat.is_dir {
        return Err("SSH working directory is not a folder".into());
    }
    let mut pty = transport
        .open_pty(cols, rows)
        .await
        .map_err(|error| format!("{error:#}"))?;
    pty.write(format!("cd -- {}\r", shell_quote(&cwd)).as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    if let Some(shell) = shell.filter(|shell| shell != "ssh") {
        let command = std::iter::once(shell)
            .chain(args.unwrap_or_default())
            .map(|arg| shell_quote(&arg))
            .collect::<Vec<_>>()
            .join(" ");
        pty.write(format!("exec {command}\r").as_bytes())
            .await
            .map_err(|error| error.to_string())?;
    }
    let remote_exit_code = pty.exit_code_handle();
    let (mut reader, mut writer, resize) = pty.into_parts();
    let (sender, mut receiver) = mpsc::channel(128);
    let id = NEXT_TERMINAL.fetch_add(1, Ordering::Relaxed);
    let store = Arc::clone(store.inner());
    store
        .terminals
        .lock()
        .map_err(|error| error.to_string())?
        .insert(
            id,
            PtyEntry {
                owner: window.label().to_string(),
                sender,
            },
        );
    tauri::async_runtime::spawn(async move {
        let mut decoder = Utf8Decoder::default();
        let mut buffer = [0_u8; 8192];
        let mut outstanding = 0_usize;
        let mut exit_code = 0;
        loop {
            tokio::select! {
                message = receiver.recv() => match message {
                    Some(PtyControl::Write(data)) => if writer.write_all(&data).await.is_err() { exit_code = 1; break; },
                    Some(PtyControl::Resize(cols, rows)) => { if resize.send((cols, rows)).await.is_err() { break; } },
                    Some(PtyControl::Acknowledge(chars)) => outstanding = outstanding.saturating_sub(chars),
                    Some(PtyControl::Kill) | None => break,
                },
                result = reader.read(&mut buffer), if outstanding < 100_000 => match result {
                    Ok(0) => { exit_code = remote_exit_code.load(Ordering::Acquire); break; },
                    Ok(count) => {
                        let data = decoder.decode(&buffer[..count], false);
                        outstanding = outstanding.saturating_add(data.encode_utf16().count());
                        if !data.is_empty() && window.emit("ssh-terminal-data", json!({ "terminal_id": id, "client_id": client_id, "data": data })).is_err() { break; }
                    },
                    Err(_) => { exit_code = 1; break; }
                }
            }
        }
        let _ = writer.shutdown().await;
        let tail = decoder.decode(&[], true);
        if !tail.is_empty() {
            let _ = window.emit(
                "ssh-terminal-data",
                json!({ "terminal_id": id, "client_id": client_id, "data": tail }),
            );
        }
        let _ = window.emit(
            "ssh-terminal-exit",
            json!({ "terminal_id": id, "client_id": client_id, "exit_code": exit_code }),
        );
        if let Ok(mut terminals) = store.terminals.lock() {
            terminals.remove(&id);
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn remote_ssh_terminal_write(
    window: Window,
    terminal_id: u64,
    data: String,
    store: State<'_, Arc<SshTerminalStore>>,
) -> Result<(), String> {
    store
        .sender(terminal_id, window.label())?
        .send(PtyControl::Write(data.into_bytes()))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn remote_ssh_terminal_write_binary(
    window: Window,
    terminal_id: u64,
    data: Vec<u8>,
    store: State<'_, Arc<SshTerminalStore>>,
) -> Result<(), String> {
    store
        .sender(terminal_id, window.label())?
        .send(PtyControl::Write(data))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn remote_ssh_terminal_resize(
    window: Window,
    terminal_id: u64,
    cols: u16,
    rows: u16,
    store: State<'_, Arc<SshTerminalStore>>,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("invalid terminal size".into());
    }
    store
        .sender(terminal_id, window.label())?
        .send(PtyControl::Resize(cols, rows))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn remote_ssh_terminal_acknowledge(
    window: Window,
    terminal_id: u64,
    char_count: usize,
    store: State<'_, Arc<SshTerminalStore>>,
) -> Result<(), String> {
    store
        .sender(terminal_id, window.label())?
        .send(PtyControl::Acknowledge(char_count))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn remote_ssh_terminal_kill(
    window: Window,
    terminal_id: u64,
    store: State<'_, Arc<SshTerminalStore>>,
) -> Result<(), String> {
    if let Ok(sender) = store.sender(terminal_id, window.label()) {
        let _ = sender.send(PtyControl::Kill).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_commands_are_scoped_to_the_owning_window() {
        let store = SshTerminalStore::default();
        let (sender, _) = mpsc::channel(1);
        store.terminals.lock().unwrap().insert(
            5,
            PtyEntry {
                owner: "first".into(),
                sender,
            },
        );
        assert!(store.sender(5, "first").is_ok());
        assert!(store.sender(5, "second").is_err());
    }

    #[test]
    fn remote_working_directory_is_quoted_literally() {
        assert_eq!(
            shell_quote("/workspace/a'b $(touch nope)"),
            "'/workspace/a'\"'\"'b $(touch nope)'"
        );
    }
}
