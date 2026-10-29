//! SSH remote transport backend.
//!
//! Verified host keys, native agent authentication, SFTP and interactive PTYs.

use std::collections::HashMap;
use std::fmt::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use files::SftpClient;
use russh::client;
use russh_keys::key;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, OnceCell};

#[path = "ssh_known_hosts.rs"]
mod known_hosts;
pub use known_hosts::{check_known_host, HostKeyInfo, KnownHostStatus};

#[path = "ssh_files.rs"]
mod files;

use crate::transport::{DirEntry, ExecOutput, FileStat, RemotePty, RemoteTransport};

// ---------------------------------------------------------------------------
// Auth & config types
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub enum SshAuth {
    Password(String),
    KeyFile {
        path: PathBuf,
        passphrase: Option<String>,
    },
    Agent,
    KeyboardInteractive,
}

impl std::fmt::Debug for SshAuth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Password(_) => formatter.write_str("Password([redacted])"),
            Self::KeyFile { path, .. } => formatter
                .debug_struct("KeyFile")
                .field("path", path)
                .finish_non_exhaustive(),
            Self::Agent => formatter.write_str("Agent"),
            Self::KeyboardInteractive => formatter.write_str("KeyboardInteractive"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    Linux,
    MacOS,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Authenticating,
    InstallingServer,
    Connected,
    Reconnecting { attempt: u32 },
}

#[derive(Debug, Clone)]
pub struct SshChannel {
    pub id: u32,
    pub channel_type: ChannelType,
}

#[derive(Debug, Clone)]
pub enum ChannelType {
    Session,
    DirectTcpIp { host: String, port: u16 },
    ForwardedTcpIp { host: String, port: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForward {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub direction: ForwardDirection,
    pub is_active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForwardDirection {
    LocalToRemote,
    RemoteToLocal,
}

#[derive(Debug, Clone)]
pub struct RemoteFileSystem {
    pub root: PathBuf,
    pub home_dir: PathBuf,
}

/// High-level SSH connection that wraps the low-level transport with
/// reconnection logic, channel tracking, port forwards, and remote FS metadata.
pub struct SshConnection {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub state: ConnectionState,
    pub channels: Vec<SshChannel>,
    pub port_forwards: Vec<PortForward>,
    pub file_system: Option<RemoteFileSystem>,
    pub keep_alive_interval: Duration,
    pub connect_timeout: Duration,
    pub proxy_command: Option<String>,
    pub remote_platform: Option<Platform>,
    transport: Option<SshTransport>,
    next_channel_id: u32,
}

impl SshConnection {
    pub fn new(host: &str, port: u16, username: &str, auth: SshAuth) -> Self {
        Self {
            host: host.to_string(),
            port,
            username: username.to_string(),
            auth,
            state: ConnectionState::Disconnected,
            channels: Vec::new(),
            port_forwards: Vec::new(),
            file_system: None,
            keep_alive_interval: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(15),
            proxy_command: None,
            remote_platform: None,
            transport: None,
            next_channel_id: 1,
        }
    }

    pub async fn connect(&mut self) -> Result<()> {
        self.state = ConnectionState::Connecting;
        let transport = SshTransport::connect_as(
            &self.username,
            &self.host,
            self.port,
            self.auth.clone(),
            Some(self.keep_alive_interval.as_secs()),
        )
        .await?;

        self.state = ConnectionState::Connected;
        self.transport = Some(transport);

        if let Ok(out) = self.exec_command("echo $HOME").await {
            let home = out.stdout.trim().to_string();
            if !home.is_empty() {
                self.file_system = Some(RemoteFileSystem {
                    root: PathBuf::from("/"),
                    home_dir: PathBuf::from(&home),
                });
            }
        }

        if let Ok(out) = self.exec_command("uname -s").await {
            self.remote_platform = match out.stdout.trim().to_lowercase().as_str() {
                "linux" => Some(Platform::Linux),
                "darwin" => Some(Platform::MacOS),
                _ if out.stdout.contains("MINGW") || out.stdout.contains("MSYS") => {
                    Some(Platform::Windows)
                }
                _ => None,
            };
        }

        Ok(())
    }

    pub async fn reconnect_with_backoff(&mut self, max_attempts: u32) -> Result<()> {
        for attempt in 1..=max_attempts {
            self.state = ConnectionState::Reconnecting { attempt };
            let delay = Duration::from_millis(500 * 2u64.pow(attempt.min(6)));
            tokio::time::sleep(delay).await;

            log::info!(
                "SSH reconnect attempt {attempt}/{max_attempts} to {}:{}",
                self.host,
                self.port
            );

            match self.connect().await {
                Ok(()) => return Ok(()),
                Err(e) if attempt == max_attempts => return Err(e),
                Err(e) => log::warn!("reconnect failed: {e}"),
            }
        }
        bail!("reconnection exhausted")
    }

    pub async fn exec_command(&self, cmd: &str) -> Result<ExecOutput> {
        let t = self.transport.as_ref().context("not connected")?;
        t.exec(cmd).await
    }

    pub async fn upload_file(&self, local: &Path, remote: &Path) -> Result<()> {
        let t = self.transport.as_ref().context("not connected")?;
        t.upload(local, &remote.to_string_lossy()).await
    }

    pub async fn download_file(&self, remote: &Path, local: &Path) -> Result<()> {
        let t = self.transport.as_ref().context("not connected")?;
        t.download(&remote.to_string_lossy(), local).await
    }

    pub async fn forward_port(
        &mut self,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<()> {
        let t = self.transport.as_ref().context("not connected")?;
        t.forward_port(local_port, remote_host, remote_port).await?;
        self.port_forwards.push(PortForward {
            local_port,
            remote_host: remote_host.to_string(),
            remote_port,
            direction: ForwardDirection::LocalToRemote,
            is_active: true,
        });
        let ch_id = self.next_channel_id;
        self.next_channel_id += 1;
        self.channels.push(SshChannel {
            id: ch_id,
            channel_type: ChannelType::DirectTcpIp {
                host: remote_host.to_string(),
                port: remote_port,
            },
        });
        Ok(())
    }

    pub async fn reverse_forward_port(
        &mut self,
        remote_port: u16,
        local_host: &str,
        local_port: u16,
    ) -> Result<()> {
        let t = self.transport.as_ref().context("not connected")?;
        t.reverse_forward_port(remote_port, local_host, local_port)
            .await?;
        self.port_forwards.push(PortForward {
            local_port,
            remote_host: local_host.to_string(),
            remote_port,
            direction: ForwardDirection::RemoteToLocal,
            is_active: true,
        });
        Ok(())
    }

    pub async fn install_server(&mut self) -> Result<()> {
        self.state = ConnectionState::InstallingServer;
        let version = env!("CARGO_PKG_VERSION");
        let check = self
            .exec_command("~/.sidex-server/sidex-server --version 2>/dev/null || echo missing")
            .await?;

        if check.stdout.trim() == version {
            log::info!("SideX Server {version} already installed");
            self.state = ConnectionState::Connected;
            return Ok(());
        }

        let platform = self.remote_platform.unwrap_or(Platform::Linux);
        let arch_out = self.exec_command("uname -m").await?;
        let arch = arch_out.stdout.trim();
        let _target = match (platform, arch) {
            (Platform::Linux, "x86_64") => "x86_64-unknown-linux-gnu",
            (Platform::Linux, "aarch64") => "aarch64-unknown-linux-gnu",
            (Platform::MacOS, "x86_64") => "x86_64-apple-darwin",
            (Platform::MacOS, "arm64") => "aarch64-apple-darwin",
            _ => bail!("unsupported remote platform: {platform:?} / {arch}"),
        };

        self.exec_command("mkdir -p ~/.sidex-server").await?;
        log::info!("installing SideX Server {version} on remote");
        self.state = ConnectionState::Connected;
        Ok(())
    }

    pub async fn disconnect(&mut self) -> Result<()> {
        if let Some(ref t) = self.transport {
            t.disconnect().await?;
        }
        self.transport = None;
        self.state = ConnectionState::Disconnected;
        self.channels.clear();
        for pf in &mut self.port_forwards {
            pf.is_active = false;
        }
        Ok(())
    }

    pub fn transport(&self) -> Option<&SshTransport> {
        self.transport.as_ref()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshHostConfig {
    pub host_pattern: String,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<PathBuf>,
    pub proxy_jump: Option<String>,
    pub forward_agent: Option<bool>,
    pub server_alive_interval: Option<u64>,
    pub server_alive_count_max: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct SshConfig {
    pub hosts: Vec<SshHostConfig>,
}

// ---------------------------------------------------------------------------
// SSH config parsing
// ---------------------------------------------------------------------------

pub fn parse_ssh_config(path: &Path) -> Result<Vec<SshHostConfig>> {
    let contents =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;

    let mut hosts = Vec::new();
    let mut current: Option<SshHostConfig> = None;

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let (keyword, value) = match line.split_once(char::is_whitespace) {
            Some((k, v)) => (k, v.trim()),
            None => continue,
        };

        match keyword.to_lowercase().as_str() {
            "host" => {
                if let Some(entry) = current.take() {
                    hosts.push(entry);
                }
                current = Some(SshHostConfig {
                    host_pattern: value.to_string(),
                    hostname: None,
                    port: None,
                    user: None,
                    identity_file: None,
                    proxy_jump: None,
                    forward_agent: None,
                    server_alive_interval: None,
                    server_alive_count_max: None,
                });
            }
            "hostname" => {
                if let Some(ref mut e) = current {
                    e.hostname = Some(value.to_string());
                }
            }
            "port" => {
                if let Some(ref mut e) = current {
                    e.port = value.parse().ok();
                }
            }
            "user" => {
                if let Some(ref mut e) = current {
                    e.user = Some(value.to_string());
                }
            }
            "identityfile" => {
                if let Some(ref mut e) = current {
                    let expanded = if value.starts_with("~/") {
                        dirs::home_dir()
                            .map_or_else(|| PathBuf::from(value), |h| h.join(&value[2..]))
                    } else {
                        PathBuf::from(value)
                    };
                    e.identity_file = Some(expanded);
                }
            }
            "proxyjump" => {
                if let Some(ref mut e) = current {
                    e.proxy_jump = Some(value.to_string());
                }
            }
            "forwardagent" => {
                if let Some(ref mut e) = current {
                    e.forward_agent = Some(value.eq_ignore_ascii_case("yes"));
                }
            }
            "serveraliveinterval" => {
                if let Some(ref mut e) = current {
                    e.server_alive_interval = value.parse().ok();
                }
            }
            "serveralivecountmax" => {
                if let Some(ref mut e) = current {
                    e.server_alive_count_max = value.parse().ok();
                }
            }
            _ => {}
        }
    }

    if let Some(entry) = current {
        hosts.push(entry);
    }

    Ok(hosts)
}

// ---------------------------------------------------------------------------
// Client handler
// ---------------------------------------------------------------------------

pub struct ClientHandler {
    host: String,
    port: u16,
    trusted_fingerprint: Option<String>,
    probe: Option<Arc<std::sync::Mutex<Option<HostKeyInfo>>>>,
}

impl ClientHandler {
    fn new(host: &str, port: u16, trusted_fingerprint: Option<String>) -> Self {
        Self {
            host: host.into(),
            port,
            trusted_fingerprint,
            probe: None,
        }
    }
}

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, server_key: &key::PublicKey) -> Result<bool> {
        let info = known_hosts::inspect_host(&self.host, self.port, server_key)?;
        if let Some(probe) = &self.probe {
            *probe
                .lock()
                .map_err(|_| anyhow::anyhow!("SSH probe state poisoned"))? = Some(info);
            // This connection performs key exchange only, without authentication.
            return Ok(true);
        }
        match info.status.as_str() {
            "trusted" => Ok(true),
            "changed" => bail!(
                "SSH_HOST_KEY_CHANGED: {}:{} presented {}, expected {}",
                self.host,
                self.port,
                info.fingerprint,
                info.old_fingerprint.unwrap_or_default()
            ),
            _ if self.trusted_fingerprint.as_deref() == Some(&info.fingerprint) => {
                known_hosts::remember_approved_host(&self.host, self.port, server_key)
                    .context("Could not save the approved SSH host key")?;
                Ok(true)
            }
            _ => bail!(
                "SSH_HOST_KEY_UNKNOWN: {}:{} {}",
                self.host,
                self.port,
                info.fingerprint
            ),
        }
    }
}

pub async fn probe_host_key(host: &str, port: u16) -> Result<HostKeyInfo> {
    known_hosts::validate_endpoint(host, port)?;
    let result = Arc::new(std::sync::Mutex::new(None));
    let mut handler = ClientHandler::new(host, port, None);
    handler.probe = Some(Arc::clone(&result));
    let session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(ssh_config(None), (host, port), handler),
    )
    .await
    .context("SSH host-key probe timed out")??;
    let _ = session
        .disconnect(
            russh::Disconnect::ByApplication,
            "host-key probe complete",
            "en",
        )
        .await;
    let info = result
        .lock()
        .map_err(|_| anyhow::anyhow!("SSH probe state poisoned"))?
        .take();
    info.context("SSH server did not present a host key")
}

fn ssh_config(keepalive_secs: Option<u64>) -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: keepalive_secs
            .filter(|seconds| *seconds > 0)
            .map(Duration::from_secs),
        keepalive_max: 3,
        ..Default::default()
    })
}

async fn authenticate(
    session: &mut client::Handle<ClientHandler>,
    user: &str,
    auth: &SshAuth,
) -> Result<()> {
    let success = match auth {
        SshAuth::Password(password) => session.authenticate_password(user, password).await?,
        SshAuth::KeyFile { path, passphrase } => {
            let pair = russh_keys::load_secret_key(path, passphrase.as_deref())
                .with_context(|| format!("Loading SSH key {}", path.display()))?;
            session.authenticate_publickey(user, Arc::new(pair)).await?
        }
        SshAuth::Agent => authenticate_agent(session, user).await?,
        SshAuth::KeyboardInteractive => {
            bail!("SSH keyboard-interactive authentication requires an interactive challenge UI")
        }
    };
    if !success {
        bail!("SSH authentication failed for {user}");
    }
    Ok(())
}

async fn authenticate_agent(
    session: &mut client::Handle<ClientHandler>,
    user: &str,
) -> Result<bool> {
    #[cfg(unix)]
    let mut agent = russh_keys::agent::client::AgentClient::connect_env()
        .await
        .context("Could not connect to SSH_AUTH_SOCK")?;
    #[cfg(windows)]
    let mut agent = russh_keys::agent::client::AgentClient::connect_named_pipe(
        std::env::var_os("SSH_AUTH_SOCK")
            .unwrap_or_else(|| std::ffi::OsString::from(r"\\.\pipe\openssh-ssh-agent")),
    )
    .await
    .context("Could not connect to the Windows OpenSSH authentication agent")?;
    #[cfg(any(unix, windows))]
    {
        let identities = agent
            .request_identities()
            .await
            .context("Could not list SSH agent keys")?;
        if identities.is_empty() {
            bail!("The SSH agent has no identities; add a key with ssh-add");
        }
        for public_key in identities {
            let (next_agent, accepted) = session.authenticate_future(user, public_key, agent).await;
            agent = next_agent;
            if accepted.context("SSH agent signing failed")? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    #[cfg(not(any(unix, windows)))]
    anyhow::bail!("SSH authentication agents are unsupported on this platform")
}

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

struct PooledSession {
    #[allow(dead_code)]
    handle: client::Handle<ClientHandler>,
    last_used: Instant,
}

pub struct SshConnectionPool {
    sessions: Mutex<HashMap<String, PooledSession>>,
    max_idle: Duration,
}

impl SshConnectionPool {
    pub fn new(max_idle_secs: u64) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            max_idle: Duration::from_secs(max_idle_secs),
        }
    }

    pub async fn get_or_connect(
        &self,
        host: &str,
        port: u16,
        auth: &SshAuth,
        user: &str,
    ) -> Result<client::Handle<ClientHandler>> {
        let key = format!("{user}@{host}:{port}");
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(entry) = sessions.get_mut(&key) {
                if entry.last_used.elapsed() < self.max_idle {
                    entry.last_used = Instant::now();
                    // Return a freshly-opened session instead; Handle is not Clone.
                    drop(sessions);
                    return Self::do_connect(host, port, auth, user).await;
                }
                sessions.remove(&key);
            }
        }

        let handle = Self::do_connect(host, port, auth, user).await?;
        Ok(handle)
    }

    async fn do_connect(
        host: &str,
        port: u16,
        auth: &SshAuth,
        user: &str,
    ) -> Result<client::Handle<ClientHandler>> {
        known_hosts::validate_endpoint(host, port)?;
        let mut session = tokio::time::timeout(
            Duration::from_secs(15),
            client::connect(
                ssh_config(Some(30)),
                (host, port),
                ClientHandler::new(host, port, None),
            ),
        )
        .await
        .context("SSH connection timed out")??;
        tokio::time::timeout(
            Duration::from_secs(60),
            authenticate(&mut session, user, auth),
        )
        .await
        .context("SSH authentication timed out")??;
        Ok(session)
    }

    pub async fn evict_idle(&self) {
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, entry| entry.last_used.elapsed() < self.max_idle);
    }
}

// ---------------------------------------------------------------------------
// SshTransport
// ---------------------------------------------------------------------------

pub struct SshTransport {
    session: Arc<Mutex<client::Handle<ClientHandler>>>,
    host: String,
    port: u16,
    #[allow(dead_code)]
    user: String,
    env_vars: Arc<Mutex<HashMap<String, String>>>,
    sftp: OnceCell<SftpClient>,
    forwarding_tasks: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    _proxy: Option<Box<SshTransport>>,
}

impl SshTransport {
    pub async fn connect(host: &str, port: u16, auth: SshAuth) -> Result<Self> {
        Self::connect_as("root", host, port, auth, None).await
    }

    pub async fn connect_as(
        user: &str,
        host: &str,
        port: u16,
        auth: SshAuth,
        keepalive_secs: Option<u64>,
    ) -> Result<Self> {
        Self::connect_as_trusted(user, host, port, auth, keepalive_secs, None).await
    }

    pub async fn connect_as_trusted(
        user: &str,
        host: &str,
        port: u16,
        auth: SshAuth,
        keepalive_secs: Option<u64>,
        trusted_fingerprint: Option<String>,
    ) -> Result<Self> {
        known_hosts::validate_endpoint(host, port)?;
        let mut handle = tokio::time::timeout(
            Duration::from_secs(15),
            client::connect(
                ssh_config(keepalive_secs),
                (host, port),
                ClientHandler::new(host, port, trusted_fingerprint),
            ),
        )
        .await
        .context("SSH connection timed out")??;
        tokio::time::timeout(
            Duration::from_secs(60),
            authenticate(&mut handle, user, &auth),
        )
        .await
        .context("SSH authentication timed out")??;
        Ok(Self::from_handle(handle, user, host, port, None))
    }

    fn from_handle(
        handle: client::Handle<ClientHandler>,
        user: &str,
        host: &str,
        port: u16,
        proxy: Option<Self>,
    ) -> Self {
        Self {
            session: Arc::new(Mutex::new(handle)),
            host: host.into(),
            port,
            user: user.into(),
            env_vars: Arc::new(Mutex::new(HashMap::new())),
            sftp: OnceCell::new(),
            forwarding_tasks: std::sync::Mutex::new(Vec::new()),
            _proxy: proxy.map(Box::new),
        }
    }

    async fn connect_next(self, user: &str, host: &str, port: u16, auth: SshAuth) -> Result<Self> {
        known_hosts::validate_endpoint(host, port)?;
        let stream = self
            .session
            .lock()
            .await
            .channel_open_direct_tcpip(host, port.into(), "127.0.0.1", 0)
            .await?
            .into_stream();
        let mut handle = tokio::time::timeout(
            Duration::from_secs(15),
            client::connect_stream(
                ssh_config(Some(30)),
                stream,
                ClientHandler::new(host, port, None),
            ),
        )
        .await
        .context("SSH proxy connection timed out")??;
        tokio::time::timeout(
            Duration::from_secs(60),
            authenticate(&mut handle, user, &auth),
        )
        .await
        .context("SSH authentication timed out")??;
        Ok(Self::from_handle(handle, user, host, port, Some(self)))
    }

    /// The target SSH handshake travels through the proxy's direct-tcpip channel.
    pub async fn connect_via_proxy(
        proxy_host: &str,
        proxy_port: u16,
        proxy_auth: SshAuth,
        target_host: &str,
        target_port: u16,
        target_auth: SshAuth,
        user: &str,
    ) -> Result<Self> {
        Self::connect_as(user, proxy_host, proxy_port, proxy_auth, Some(30))
            .await?
            .connect_next(user, target_host, target_port, target_auth)
            .await
    }

    async fn sftp(&self) -> Result<&SftpClient> {
        self.sftp
            .get_or_try_init(|| async {
                let channel = self.session.lock().await.channel_open_session().await?;
                channel.request_subsystem(true, "sftp").await?;
                SftpClient::new(channel.into_stream())
                    .await
                    .context("The SSH server has no working SFTP subsystem")
            })
            .await
    }

    /// Set an environment variable for subsequent exec calls.
    pub async fn set_env(&self, key: &str, value: &str) -> Result<()> {
        if key.is_empty()
            || key.bytes().enumerate().any(|(i, c)| {
                !(c.is_ascii_alphabetic() || c == b'_' || (i > 0 && c.is_ascii_digit()))
            })
        {
            bail!("Invalid remote environment variable name");
        }
        self.env_vars
            .lock()
            .await
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    /// Forward local -> remote.
    pub async fn forward_port(
        &self,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<()> {
        let session = Arc::clone(&self.session);
        let remote_host = remote_host.to_string();
        let log_host = remote_host.clone();

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], local_port)))
            .await
            .with_context(|| format!("binding local port {local_port}"))?;

        let task = tokio::spawn(async move {
            loop {
                let Ok((mut local_stream, _)) = listener.accept().await else {
                    break;
                };
                let session = Arc::clone(&session);
                let rh = remote_host.clone();
                tokio::spawn(async move {
                    let channel = {
                        let sess = session.lock().await;
                        match sess
                            .channel_open_direct_tcpip(&rh, remote_port.into(), "127.0.0.1", 0)
                            .await
                        {
                            Ok(ch) => ch,
                            Err(e) => {
                                log::error!("port-forward channel open: {e}");
                                return;
                            }
                        }
                    };
                    let mut remote_stream = channel.into_stream();
                    let _ =
                        tokio::io::copy_bidirectional(&mut local_stream, &mut remote_stream).await;
                });
            }
        });

        self.forwarding_tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("Port-forward state poisoned"))?
            .push(task);
        log::info!(
            "forwarding 127.0.0.1:{local_port} -> {log_host}:{remote_port} via {}:{}",
            self.host,
            self.port
        );
        Ok(())
    }

    /// Reverse port forward: remote -> local.
    #[allow(clippy::unused_async, clippy::unused_async_trait_impl)]
    pub async fn reverse_forward_port(
        &self,
        remote_port: u16,
        local_host: &str,
        local_port: u16,
    ) -> Result<()> {
        let _ = (remote_port, local_host, local_port);
        bail!("Remote-to-local port forwarding is not supported by this SSH transport")
    }

    async fn build_env_prefix(&self) -> String {
        let env = self.env_vars.lock().await;
        if env.is_empty() {
            return String::new();
        }
        let mut prefix = String::new();
        for (k, v) in env.iter() {
            let quoted = shell_quote(v);
            let _ = write!(prefix, "export {k}={quoted}; ");
        }
        prefix
    }

    async fn exec_inner(&self, command: &str) -> Result<ExecOutput> {
        let env_prefix = self.build_env_prefix().await;
        let full_cmd = format!("{env_prefix}{command}");

        let mut channel = self.session.lock().await.channel_open_session().await?;
        channel.exec(true, full_cmd.as_bytes()).await?;
        channel.eof().await?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = -1;
        while let Some(message) = channel.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                russh::ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = i32::try_from(exit_status).unwrap_or(-1)
                }
                russh::ChannelMsg::ExitSignal { error_message, .. } => {
                    exit_code = -1;
                    stderr.extend_from_slice(error_message.as_bytes());
                }
                russh::ChannelMsg::Failure => bail!("The SSH server rejected the command"),
                russh::ChannelMsg::Close => break,
                _ => {}
            }
            if stdout.len() + stderr.len() > 64 * 1024 * 1024 {
                let _ = channel.close().await;
                bail!("Remote command output exceeds 64 MiB");
            }
        }
        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
        })
    }
}

impl Drop for SshTransport {
    fn drop(&mut self) {
        if let Ok(tasks) = self.forwarding_tasks.get_mut() {
            for task in tasks.drain(..) {
                task.abort();
            }
        }
    }
}

#[async_trait::async_trait]
impl RemoteTransport for SshTransport {
    async fn exec(&self, command: &str) -> Result<ExecOutput> {
        self.exec_inner(command).await
    }

    async fn file_request(&self, request: serde_json::Value) -> Result<serde_json::Value> {
        files::request(self.sftp().await?, request).await
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        files::read(self.sftp().await?, path).await
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<()> {
        files::write(self.sftp().await?, path, data, true, true).await
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let entries = self.sftp().await?.read_dir(path).await?;
        Ok(entries
            .into_iter()
            .map(|entry| {
                let name = entry.filename;
                let metadata = entry.attrs;
                DirEntry {
                    path: format!("{}/{name}", path.trim_end_matches('/')),
                    name,
                    is_dir: files::file_type(&metadata) == 2,
                    size: metadata.len(),
                    modified: metadata.modified().ok(),
                }
            })
            .collect())
    }

    async fn stat(&self, path: &str) -> Result<FileStat> {
        let mut metadata = self.sftp().await?.symlink_metadata(path).await?;
        let is_symlink = files::file_type(&metadata) == 64;
        if is_symlink {
            if let Ok(target) = self.sftp().await?.metadata(path).await {
                metadata = target;
            }
        }
        Ok(FileStat {
            size: metadata.len(),
            modified: metadata.modified().ok(),
            is_dir: files::file_type(&metadata) == 2,
            is_symlink,
        })
    }

    async fn open_pty(&self, cols: u16, rows: u16) -> Result<RemotePty> {
        let mut channel = self.session.lock().await.channel_open_session().await?;
        channel
            .request_pty(
                true,
                "xterm-256color",
                cols.max(1).into(),
                rows.max(1).into(),
                0,
                0,
                &[],
            )
            .await?;
        channel.request_shell(true).await?;
        let (resize_tx, mut resize_rx) = tokio::sync::mpsc::channel::<(u16, u16)>(8);
        let (frontend, driver) = tokio::io::duplex(256 * 1024);
        let (mut input, mut output) = tokio::io::split(driver);
        let (reader, writer) = tokio::io::split(frontend);
        let pty = RemotePty::new(Box::new(writer), Box::new(reader), resize_tx);
        let exit_code = pty.exit_code_handle();
        tokio::spawn(async move {
            let mut buffer = [0u8; 8192];
            let mut can_resize = true;
            loop {
                tokio::select! {
                    incoming = input.read(&mut buffer) => match incoming {
                        Ok(0) | Err(_) => { let _ = channel.close().await; break; }
                        Ok(length) => if channel.data(&buffer[..length]).await.is_err() { break; },
                    },
                    resize = resize_rx.recv(), if can_resize => match resize {
                        Some((cols, rows)) => if channel.window_change(cols.max(1).into(), rows.max(1).into(), 0, 0).await.is_err() { break; },
                        None => can_resize = false,
                    },
                    message = channel.wait() => match message {
                        Some(russh::ChannelMsg::Data { data } | russh::ChannelMsg::ExtendedData { data, .. }) => {
                            if output.write_all(&data).await.is_err() { let _ = channel.close().await; break; }
                        }
                        Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                            exit_code.store(i32::try_from(exit_status).unwrap_or(-1), std::sync::atomic::Ordering::Release);
                        }
                        Some(russh::ChannelMsg::Close | russh::ChannelMsg::Failure) | None => break,
                        _ => {}
                    }
                }
            }
        });
        Ok(pty)
    }

    async fn upload(&self, local: &Path, remote: &str) -> Result<()> {
        let data = tokio::fs::read(local)
            .await
            .with_context(|| format!("reading local file {}", local.display()))?;
        self.write_file(remote, &data).await
    }

    async fn download(&self, remote: &str, local: &Path) -> Result<()> {
        let data = self.read_file(remote).await?;
        tokio::fs::write(local, &data)
            .await
            .with_context(|| format!("writing local file {}", local.display()))?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        if let Ok(mut tasks) = self.forwarding_tasks.lock() {
            for task in tasks.drain(..) {
                task.abort();
            }
        }
        let session = self.session.lock().await;
        session
            .disconnect(russh::Disconnect::ByApplication, "bye", "en")
            .await?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

impl SshConfig {
    pub fn resolve(&self, alias: &str) -> Option<&SshHostConfig> {
        self.hosts.iter().find(|h| {
            let pat = &h.host_pattern;
            if let Some(suffix) = pat.strip_prefix('*') {
                alias.ends_with(suffix)
            } else if let Some(prefix) = pat.strip_suffix('*') {
                alias.starts_with(prefix)
            } else {
                pat == alias
            }
        })
    }

    pub fn load_default() -> Result<Self> {
        let path = dirs::home_dir()
            .map(|h| h.join(".ssh/config"))
            .unwrap_or_default();
        if path.exists() {
            let hosts = parse_ssh_config(&path)?;
            Ok(Self { hosts })
        } else {
            Ok(Self { hosts: Vec::new() })
        }
    }
}

/// Connect through a chain of proxy-jump hosts.
pub async fn connect_multi_hop(
    hops: &[(String, u16, SshAuth)],
    final_user: &str,
) -> Result<SshTransport> {
    if hops.is_empty() {
        bail!("multi-hop chain must have at least one hop");
    }
    let (host, port, auth) = &hops[0];
    let mut transport =
        SshTransport::connect_as(final_user, host, *port, auth.clone(), Some(30)).await?;
    for (host, port, auth) in &hops[1..] {
        transport = transport
            .connect_next(final_user, host, *port, auth.clone())
            .await?;
    }
    Ok(transport)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_config(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f
    }

    #[test]
    fn parse_simple_ssh_config() {
        let cfg = write_config(
            "\
Host myserver
    HostName 192.168.1.100
    Port 2222
    User deploy
    IdentityFile ~/.ssh/deploy_key
    ForwardAgent yes
    ServerAliveInterval 60

Host *.example.com
    User admin
    ProxyJump bastion
",
        );
        let hosts = parse_ssh_config(cfg.path()).unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].host_pattern, "myserver");
        assert_eq!(hosts[0].hostname.as_deref(), Some("192.168.1.100"));
        assert_eq!(hosts[0].port, Some(2222));
        assert_eq!(hosts[0].forward_agent, Some(true));
        assert_eq!(hosts[0].server_alive_interval, Some(60));
        assert_eq!(hosts[1].proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn parse_empty_config() {
        let cfg = write_config("");
        let hosts = parse_ssh_config(cfg.path()).unwrap();
        assert!(hosts.is_empty());
    }

    #[test]
    fn config_resolve_exact() {
        let config = SshConfig {
            hosts: vec![SshHostConfig {
                host_pattern: "prod".to_string(),
                hostname: Some("10.0.0.1".to_string()),
                port: Some(22),
                user: Some("root".to_string()),
                identity_file: None,
                proxy_jump: None,
                forward_agent: None,
                server_alive_interval: None,
                server_alive_count_max: None,
            }],
        };
        assert!(config.resolve("prod").is_some());
        assert!(config.resolve("staging").is_none());
    }

    #[test]
    fn known_host_unknown() {
        let fake_key = key::KeyPair::generate_ed25519().clone_public_key().unwrap();
        let status = check_known_host("nonexistent.test", 22, &fake_key).unwrap();
        assert!(matches!(status, KnownHostStatus::Unknown { .. }));
    }

    #[test]
    fn pool_creation() {
        let pool = SshConnectionPool::new(300);
        assert_eq!(pool.max_idle, Duration::from_secs(300));
    }
}
