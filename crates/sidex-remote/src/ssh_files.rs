//! Binary SFTP operations. Paths never become shell commands.

use anyhow::{bail, Context, Result};
use russh_sftp::client::{error::Error, RawSftpSession};
use russh_sftp::protocol::{File, FileAttributes, OpenFlags, Packet, StatusCode};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncRead, AsyncWrite};

const MAX_FILE: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

pub(super) struct SftpClient {
    session: RawSftpSession,
    posix_rename: bool,
    fsync: bool,
}

impl SftpClient {
    pub(super) async fn new<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
        stream: S,
    ) -> Result<Self> {
        let session = RawSftpSession::new(stream);
        session.set_timeout(30).await;
        let version = session.init().await.map_err(map_error)?;
        Ok(Self {
            session,
            posix_rename: version.extensions.contains_key("posix-rename@openssh.com"),
            fsync: version.extensions.contains_key("fsync@openssh.com"),
        })
    }

    pub(super) async fn metadata(&self, path: &str) -> Result<FileAttributes> {
        Ok(self.session.stat(path).await.map_err(map_error)?.attrs)
    }

    pub(super) async fn symlink_metadata(&self, path: &str) -> Result<FileAttributes> {
        Ok(self.session.lstat(path).await.map_err(map_error)?.attrs)
    }

    async fn optional_metadata(&self, path: &str) -> Result<Option<FileAttributes>> {
        match self.session.lstat(path).await {
            Ok(result) => Ok(Some(result.attrs)),
            Err(Error::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
            Err(error) => Err(map_error(error)),
        }
    }

    async fn canonicalize(&self, path: &str) -> Result<String> {
        self.session
            .realpath(path)
            .await
            .map_err(map_error)?
            .files
            .into_iter()
            .next()
            .map(|file| file.filename)
            .context("Unavailable: SFTP realpath returned no filename")
    }

    pub(super) async fn read_dir(&self, path: &str) -> Result<Vec<File>> {
        let handle = self.session.opendir(path).await.map_err(map_error)?.handle;
        let operation = async {
            let mut files = Vec::new();
            loop {
                match self.session.readdir(handle.as_str()).await {
                    Ok(entries) => {
                        for entry in entries.files {
                            // Refuse malformed entries before joining a path for
                            // recursive traversal; a server cannot escape a root.
                            if entry.filename == "." || entry.filename == ".." {
                                continue;
                            }
                            if entry.filename.is_empty() || entry.filename.contains(['/', '\0']) {
                                bail!("Unavailable: invalid SFTP directory entry");
                            }
                            files.push(entry);
                        }
                        if files.len() > MAX_ENTRIES {
                            bail!("Unavailable: directory exceeds {MAX_ENTRIES} entries");
                        }
                    }
                    Err(Error::Status(status)) if status.status_code == StatusCode::Eof => break,
                    Err(error) => return Err(map_error(error)),
                }
            }
            Ok(files)
        }
        .await;
        let close = self.session.close(handle).await.map_err(map_error);
        let files = operation?;
        close?;
        Ok(files)
    }

    async fn rename(&self, from: &str, to: &str, overwrite: bool) -> Result<()> {
        if overwrite && self.posix_rename {
            let mut bytes = Vec::new();
            for name in [from, to] {
                bytes.extend_from_slice(&u32::try_from(name.len())?.to_be_bytes());
                bytes.extend_from_slice(name.as_bytes());
            }
            match self
                .session
                .extended("posix-rename@openssh.com", bytes)
                .await
                .map_err(map_error)?
            {
                Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
                Packet::Status(status) => Err(map_error(Error::Status(status))),
                _ => bail!("Unavailable: invalid SFTP rename response"),
            }
        } else if overwrite && self.optional_metadata(to).await?.is_some() {
            // SFTP v3 rename cannot replace existing files. Keep a recoverable
            // backup until the replacement has succeeded on older servers.
            let backup = temporary_sibling(to);
            self.session.rename(to, &backup).await.map_err(map_error)?;
            if let Err(error) = self.session.rename(from, to).await {
                if let Err(restore) = self.session.rename(&backup, to).await {
                    bail!("Unavailable: rename failed ({error}); original retained at {backup} ({restore})");
                }
                return Err(map_error(error));
            }
            if let Err(error) = delete(self, &backup, true).await {
                // The requested replacement succeeded; retain the old file and
                // report its path in logs rather than pretending the save failed.
                log::warn!("SFTP replacement succeeded; backup retained at {backup}: {error}");
            }
            Ok(())
        } else {
            self.session.rename(from, to).await.map_err(map_error)?;
            Ok(())
        }
    }
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "Matches the owned error callback expected by Result::map_err"
)]
fn map_error(error: Error) -> anyhow::Error {
    let code = match &error {
        Error::Status(status) if status.status_code == StatusCode::NoSuchFile => "FileNotFound",
        Error::Status(status) if status.status_code == StatusCode::PermissionDenied => {
            "NoPermissions"
        }
        _ => "Unavailable",
    };
    anyhow::anyhow!("{code}: {error}")
}

fn path(value: &Value, key: &str) -> Result<String> {
    let path = value
        .get(key)
        .and_then(Value::as_str)
        .context("Unavailable: missing remote path")?;
    validate_path(path)?;
    Ok(path.to_string())
}

fn validate_path(path: &str) -> Result<()> {
    if !path.starts_with('/') || path.contains('\0') || path.len() > 32_768 {
        bail!("Unavailable: expected an absolute remote path without NUL");
    }
    Ok(())
}

fn guarded_mutation_path(path: &str) -> Result<()> {
    validate_path(path)?;
    // Lexical aliases for root must be rejected as well as the literal '/'.
    let mut depth = 0usize;
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => depth = depth.saturating_sub(1),
            _ => depth += 1,
        }
    }
    if depth == 0 {
        bail!("NoPermissions: refusing to rename or delete the remote root");
    }
    Ok(())
}

pub(super) fn file_type(metadata: &FileAttributes) -> u8 {
    // Compare the complete POSIX type bits. A socket must not be treated as a
    // directory merely because its mode contains S_IFDIR's bit.
    match metadata.permissions.unwrap_or(0) & 0o170_000 {
        0o040_000 => 2,
        0o100_000 => 1,
        0o120_000 => 64,
        _ => 0,
    }
}

async fn stat(sftp: &SftpClient, path: &str) -> Result<Value> {
    let mut metadata = sftp.symlink_metadata(path).await?;
    let mut kind = file_type(&metadata);
    if kind == 64 {
        if let Ok(target) = sftp.metadata(path).await {
            kind |= file_type(&target);
            metadata = target;
        }
    }
    let mtime = u64::from(metadata.mtime.unwrap_or(0)) * 1000;
    Ok(
        json!({"type":kind,"size":metadata.len(),"mtime":mtime,"ctime":mtime,
        "readonly":metadata.permissions.is_some_and(|mode| mode & 0o222 == 0)}),
    )
}

pub(super) async fn read(sftp: &SftpClient, path: &str) -> Result<Vec<u8>> {
    validate_path(path)?;
    let metadata = sftp.metadata(path).await?;
    if file_type(&metadata) == 2 {
        bail!("FileIsADirectory: {path}");
    }
    if metadata.len() > MAX_FILE as u64 {
        bail!("FileTooLarge: SFTP transfer limit is 64 MiB");
    }
    let handle = sftp
        .session
        .open(path, OpenFlags::READ, FileAttributes::empty())
        .await
        .map_err(map_error)?
        .handle;
    let operation = async {
        let mut bytes = Vec::new();
        loop {
            match sftp
                .session
                .read(handle.as_str(), bytes.len() as u64, 32_768)
                .await
            {
                Ok(data) => {
                    if data.data.is_empty() {
                        break;
                    }
                    bytes.extend_from_slice(&data.data);
                    if bytes.len() > MAX_FILE {
                        bail!("FileTooLarge: SFTP transfer limit is 64 MiB");
                    }
                }
                Err(Error::Status(status)) if status.status_code == StatusCode::Eof => break,
                Err(error) => return Err(map_error(error)),
            }
        }
        Ok(bytes)
    }
    .await;
    let close = sftp.session.close(handle).await.map_err(map_error);
    let bytes = operation?;
    close?;
    Ok(bytes)
}

pub(super) async fn write(
    sftp: &SftpClient,
    path: &str,
    bytes: &[u8],
    create: bool,
    overwrite: bool,
) -> Result<()> {
    validate_path(path)?;
    if bytes.len() > MAX_FILE {
        bail!("FileTooLarge: SFTP transfer limit is 64 MiB");
    }
    let metadata = sftp.optional_metadata(path).await?;
    if metadata.is_some() && !overwrite {
        bail!("FileExists: {path}");
    }
    if metadata.is_none() && !create {
        bail!("FileNotFound: {path}");
    }
    if metadata.as_ref().is_some_and(|m| file_type(m) == 2) {
        bail!("FileIsADirectory: {path}");
    }
    // Preserve an existing symlink; atomic replacement applies to its target.
    let target = if metadata.as_ref().is_some_and(|m| file_type(m) == 64) {
        sftp.canonicalize(path).await?
    } else {
        path.to_string()
    };
    let target_metadata = if target == path {
        metadata
    } else {
        Some(sftp.metadata(&target).await?)
    };
    let temporary = temporary_sibling(&target);
    let mut attributes = FileAttributes::empty();
    attributes.permissions = target_metadata
        .as_ref()
        .and_then(|m| m.permissions)
        .map(|mode| mode & 0o7777);
    let handle = sftp
        .session
        .open(
            &temporary,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            attributes,
        )
        .await
        .map_err(map_error)?
        .handle;
    let operation: Result<()> = async {
        for (index, chunk) in bytes.chunks(32_768).enumerate() {
            sftp.session
                .write(handle.as_str(), (index * 32_768) as u64, chunk.to_vec())
                .await
                .map_err(map_error)?;
        }
        if let Some(mode) = target_metadata
            .as_ref()
            .and_then(|metadata| metadata.permissions)
        {
            let mut permissions = FileAttributes::empty();
            permissions.permissions = Some(mode & 0o7777);
            sftp.session
                .fsetstat(handle.as_str(), permissions)
                .await
                .map_err(map_error)?;
        }
        if sftp.fsync {
            sftp.session
                .fsync(handle.as_str())
                .await
                .map_err(map_error)?;
        }
        Ok(())
    }
    .await;
    let close = sftp.session.close(handle).await.map_err(map_error);
    if let Err(error) = operation.and(close.map(|_| ())) {
        let _ = sftp.session.remove(&temporary).await;
        return Err(error);
    }
    if let Err(error) = sftp
        .rename(&temporary, &target, overwrite && target_metadata.is_some())
        .await
    {
        let _ = sftp.session.remove(&temporary).await;
        return Err(error);
    }
    Ok(())
}

fn temporary_sibling(path: &str) -> String {
    let (parent, _) = path.rsplit_once('/').unwrap_or(("", path));
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{parent}/.sidex-save-{}-{stamp}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    )
}

async fn delete(sftp: &SftpClient, path: &str, recursive: bool) -> Result<()> {
    guarded_mutation_path(path)?;
    let root = sftp.symlink_metadata(path).await?;
    if file_type(&root) == 2 && sftp.canonicalize(path).await? == "/" {
        bail!("NoPermissions: refusing to delete a symlink-resolved remote root");
    }
    if file_type(&root) != 2 {
        sftp.session.remove(path).await.map_err(map_error)?;
        return Ok(());
    }
    if !recursive {
        sftp.session.rmdir(path).await.map_err(map_error)?;
        return Ok(());
    }
    let mut pending = vec![path.to_string()];
    let mut entries = Vec::new();
    while let Some(directory) = pending.pop() {
        entries.push((directory.clone(), true));
        for entry in sftp.read_dir(&directory).await? {
            let child = format!(
                "{}/{name}",
                directory.trim_end_matches('/'),
                name = entry.filename
            );
            if file_type(&entry.attrs) == 2 {
                pending.push(child);
            } else {
                entries.push((child, false));
            }
            if entries.len() + pending.len() > MAX_ENTRIES {
                bail!("Unavailable: recursive deletion exceeds {MAX_ENTRIES} entries");
            }
        }
    }
    // Traverse the entire subtree before deleting anything. Never recurse
    // through directory symlinks, and leave files outside the root untouched.
    for (entry, directory) in entries.into_iter().rev() {
        if directory {
            sftp.session.rmdir(&entry).await.map_err(map_error)?;
        } else {
            sftp.session.remove(&entry).await.map_err(map_error)?;
        }
    }
    Ok(())
}

pub(super) async fn request(sftp: &SftpClient, request: Value) -> Result<Value> {
    let operation = request["op"]
        .as_str()
        .context("Unavailable: missing SFTP operation")?;
    if operation == "home" {
        return Ok(json!(sftp.canonicalize(".").await?));
    }
    let path = path(&request, "path")?;
    match operation {
        "stat" => stat(sftp, &path).await,
        "read" => Ok(json!(read(sftp, &path).await?)),
        "write" => {
            if request["data"]
                .as_array()
                .is_some_and(|bytes| bytes.len() > MAX_FILE)
            {
                bail!("FileTooLarge: SFTP transfer limit is 64 MiB");
            }
            let bytes: Vec<u8> = serde_json::from_value(request["data"].clone())
                .context("Unavailable: invalid binary file data")?;
            write(
                sftp,
                &path,
                &bytes,
                request["create"].as_bool().unwrap_or(true),
                request["overwrite"].as_bool().unwrap_or(true),
            )
            .await?;
            Ok(Value::Null)
        }
        "readdir" => read_directory(sftp, &path).await,
        "mkdir" => {
            if let Some(existing) = sftp.optional_metadata(&path).await? {
                if file_type(&existing) != 2 {
                    bail!("FileExists: {path}");
                }
            } else {
                sftp.session
                    .mkdir(&path, FileAttributes::empty())
                    .await
                    .map_err(map_error)?;
            }
            Ok(Value::Null)
        }
        "delete" => {
            delete(sftp, &path, request["recursive"].as_bool().unwrap_or(false)).await?;
            Ok(Value::Null)
        }
        "rename" => {
            let target = self::path(&request, "target")?;
            guarded_mutation_path(&path)?;
            guarded_mutation_path(&target)?;
            for candidate in [&path, &target] {
                if let Some(metadata) = sftp.optional_metadata(candidate).await? {
                    if file_type(&metadata) == 2 && sftp.canonicalize(candidate).await? == "/" {
                        bail!("NoPermissions: refusing to rename a symlink-resolved remote root");
                    }
                }
            }
            let overwrite = request["overwrite"].as_bool().unwrap_or(false);
            if path != target {
                if !overwrite && sftp.optional_metadata(&target).await?.is_some() {
                    bail!("FileExists: {target}");
                }
                sftp.rename(&path, &target, overwrite).await?;
            }
            Ok(Value::Null)
        }
        "snapshot" => {
            snapshot(
                sftp,
                &path,
                request["recursive"].as_bool().unwrap_or(false),
                &request["excludes"],
            )
            .await
        }
        _ => bail!("Unavailable: unknown SFTP filesystem operation"),
    }
}

async fn read_directory(sftp: &SftpClient, path: &str) -> Result<Value> {
    let metadata = sftp.metadata(path).await?;
    if file_type(&metadata) != 2 {
        bail!("FileNotADirectory: {path}");
    }
    let mut entries = Vec::new();
    for entry in sftp.read_dir(path).await? {
        let mut kind = file_type(&entry.attrs);
        if kind == 64 {
            if let Ok(target) = sftp
                .metadata(&format!(
                    "{}/{}",
                    path.trim_end_matches('/'),
                    entry.filename
                ))
                .await
            {
                kind |= file_type(&target);
            }
        }
        entries.push(json!([entry.filename, kind]));
    }
    Ok(Value::Array(entries))
}

async fn snapshot(
    sftp: &SftpClient,
    root: &str,
    recursive: bool,
    excludes: &Value,
) -> Result<Value> {
    let mut result = serde_json::Map::new();
    let Some(root_metadata) = sftp.optional_metadata(root).await? else {
        return Ok(Value::Object(result));
    };
    let mut pending = vec![(root.to_string(), root_metadata)];
    while let Some((path, metadata)) = pending.pop() {
        let kind = file_type(&metadata);
        result.insert(
            path.clone(),
            json!([
                kind,
                u64::from(metadata.mtime.unwrap_or(0)) * 1000,
                metadata.len()
            ]),
        );
        if kind != 2 || (!recursive && path != root) {
            continue;
        }
        for entry in sftp.read_dir(&path).await? {
            let child = format!("{}/{}", path.trim_end_matches('/'), entry.filename);
            if excluded(&child, excludes) {
                continue;
            }
            pending.push((child, entry.attrs));
            if pending.len() + result.len() > MAX_ENTRIES {
                bail!("Unavailable: remote watch exceeds {MAX_ENTRIES} entries; exclude large directories");
            }
        }
    }
    Ok(Value::Object(result))
}

fn excluded(path: &str, excludes: &Value) -> bool {
    excludes.as_array().is_some_and(|patterns| {
        patterns.iter().filter_map(Value::as_str).any(|pattern| {
            glob_match(pattern.as_bytes(), path.as_bytes())
                || glob_match(pattern.trim_end_matches("/**").as_bytes(), path.as_bytes())
        })
    })
}

fn glob_match(pattern: &[u8], value: &[u8]) -> bool {
    let mut matched = vec![false; value.len() + 1];
    matched[0] = true;
    for &character in pattern {
        let mut next = vec![false; value.len() + 1];
        if character == b'*' {
            next[0] = matched[0];
        }
        for index in 1..=value.len() {
            next[index] = if character == b'*' {
                next[index - 1] || matched[index]
            } else {
                matched[index - 1] && (character == b'?' || character == value[index - 1])
            };
        }
        matched = next;
    }
    matched[value.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_remote_filename_semantics_and_guards_root_aliases() {
        assert!(validate_path("/tmp/quotes '中文'\n$(literal):file").is_ok());
        for root in ["/", "/..", "/tmp/../", "/./"] {
            assert!(guarded_mutation_path(root).is_err());
        }
        assert!(guarded_mutation_path("/tmp/../project").is_ok());
        assert!(validate_path("/tmp/nul\0").is_err());
    }

    #[test]
    fn socket_and_symlink_modes_do_not_masquerade_as_directories() {
        let mut attrs = FileAttributes::empty();
        for (mode, expected) in [
            (0o040_755, 2),
            (0o100_644, 1),
            (0o120_777, 64),
            (0o140_755, 0),
        ] {
            attrs.permissions = Some(mode);
            assert_eq!(file_type(&attrs), expected);
        }
    }

    #[test]
    fn remote_watch_excludes_subtrees_case_sensitively() {
        let patterns = json!(["**/node_modules/**", "**/.git/objects/**"]);
        assert!(excluded("/work/node_modules", &patterns));
        assert!(excluded("/work/node_modules/example/index.js", &patterns));
        assert!(!excluded("/work/Node_Modules/example.js", &patterns));
        assert!(!excluded("/work/src/index.ts", &patterns));
    }
}
