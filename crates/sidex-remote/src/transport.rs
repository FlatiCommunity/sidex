//! Unified remote transport abstraction.
//!
//! Every remote backend (SSH, WSL, containers, Codespaces, tunnels) implements
//! [`RemoteTransport`] so the rest of `SideX` can operate without knowing which
//! backend is active.

use std::path::Path;
use std::sync::{atomic::AtomicI32, Arc};
use std::time::SystemTime;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// Output produced by a single remote command execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Directory entry returned by [`RemoteTransport::read_dir`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<SystemTime>,
}

/// File metadata returned by [`RemoteTransport::stat`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStat {
    pub size: u64,
    pub modified: Option<SystemTime>,
    pub is_dir: bool,
    pub is_symlink: bool,
}

// ---------------------------------------------------------------------------
// Remote PTY
// ---------------------------------------------------------------------------

/// Handle to a pseudo-terminal running on the remote side.
pub struct RemotePty {
    writer: Box<dyn AsyncWrite + Unpin + Send>,
    reader: Box<dyn AsyncRead + Unpin + Send>,
    resize_tx: tokio::sync::mpsc::Sender<(u16, u16)>,
    exit_code: Arc<AtomicI32>,
}

impl RemotePty {
    /// Create a new `RemotePty` from raw async streams and a resize channel.
    pub fn new(
        writer: Box<dyn AsyncWrite + Unpin + Send>,
        reader: Box<dyn AsyncRead + Unpin + Send>,
        resize_tx: tokio::sync::mpsc::Sender<(u16, u16)>,
    ) -> Self {
        Self {
            writer,
            reader,
            resize_tx,
            exit_code: Arc::new(AtomicI32::new(-1)),
        }
    }

    /// Write bytes into the remote PTY stdin.
    pub async fn write(&mut self, data: &[u8]) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        self.writer.write_all(data).await?;
        Ok(())
    }

    /// Read available bytes from the remote PTY stdout.
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        use tokio::io::AsyncReadExt;
        let n = self.reader.read(buf).await?;
        Ok(n)
    }

    /// Resize the remote PTY window.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.resize_tx.send((cols, rows)).await?;
        Ok(())
    }

    /// The status becomes available before output reaches EOF. `-1` means the
    /// server closed the channel without reporting a process exit status.
    pub fn exit_code_handle(&self) -> Arc<AtomicI32> {
        Arc::clone(&self.exit_code)
    }

    /// Split ownership so reading output never holds the lock needed for input
    /// or a window resize.
    pub fn into_parts(
        self,
    ) -> (
        Box<dyn AsyncRead + Unpin + Send>,
        Box<dyn AsyncWrite + Unpin + Send>,
        tokio::sync::mpsc::Sender<(u16, u16)>,
    ) {
        (self.reader, self.writer, self.resize_tx)
    }
}

// ---------------------------------------------------------------------------
// Transport trait
// ---------------------------------------------------------------------------

/// Unified interface for all remote development backends.
///
/// Implementations must be `Send + Sync` so they can be stored in the
/// connection manager and shared across tasks.
#[async_trait::async_trait]
pub trait RemoteTransport: Send + Sync {
    /// Structured filesystem operations preserve binary bytes and remote names.
    async fn file_request(&self, _request: serde_json::Value) -> Result<serde_json::Value> {
        anyhow::bail!("Unavailable: this remote transport has no filesystem provider")
    }

    /// Execute a shell command on the remote and collect its output.
    async fn exec(&self, command: &str) -> Result<ExecOutput>;

    /// Read the entire contents of a remote file.
    async fn read_file(&self, path: &str) -> Result<Vec<u8>>;

    /// Write `data` to a remote file, creating or truncating it.
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<()>;

    /// List the entries of a remote directory.
    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>>;

    /// Retrieve metadata for a remote path.
    async fn stat(&self, path: &str) -> Result<FileStat>;

    /// Open an interactive pseudo-terminal on the remote.
    async fn open_pty(&self, cols: u16, rows: u16) -> Result<RemotePty>;

    /// Upload a local file to the remote.
    async fn upload(&self, local: &Path, remote: &str) -> Result<()>;

    /// Download a remote file to the local filesystem.
    async fn download(&self, remote: &str, local: &Path) -> Result<()>;

    /// Gracefully close the remote connection.
    async fn disconnect(&self) -> Result<()>;
}
