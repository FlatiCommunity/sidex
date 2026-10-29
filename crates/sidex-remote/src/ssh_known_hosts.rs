//! OpenSSH known-host verification. No credentials are sent before this passes.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use russh_keys::key;
use russh_keys::PublicKeyBase64;
use serde::Serialize;
use sha1::Sha1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KnownHostStatus {
    Trusted,
    Unknown {
        fingerprint: String,
    },
    Changed {
        old_fingerprint: String,
        new_fingerprint: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub status: String,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_fingerprint: Option<String>,
}

pub(super) fn validate_endpoint(host: &str, port: u16) -> Result<()> {
    if host.is_empty()
        || host.len() > 255
        || port == 0
        || host
            .chars()
            .any(|c| c.is_whitespace() || "\0,|*?!/@\\".contains(c))
    {
        bail!("Invalid SSH host or port");
    }
    Ok(())
}

pub(super) fn known_hosts_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("SIDEX_SSH_KNOWN_HOSTS").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(dirs::home_dir()
        .context("SSH home directory is unavailable")?
        .join(".ssh/known_hosts"))
}

pub fn check_known_host(host: &str, port: u16, key: &key::PublicKey) -> Result<KnownHostStatus> {
    check_known_host_path(host, port, key, &known_hosts_path()?)
}

pub(super) fn remember_approved_host(host: &str, port: u16, key: &key::PublicKey) -> Result<()> {
    let path = known_hosts_path()?;
    // Recheck after the approval round trip: another connection may have updated
    // the file in the meantime. Never append an approval over a changed key.
    match check_known_host_path(host, port, key, &path)? {
        KnownHostStatus::Trusted => return Ok(()),
        KnownHostStatus::Changed { .. } => {
            bail!("SSH_HOST_KEY_CHANGED: known_hosts changed during approval")
        }
        KnownHostStatus::Unknown { .. } => {}
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?;
    let target = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    // RSA signature negotiation is not the public-key encoding name.
    let algorithm = if matches!(key, key::PublicKey::RSA { .. }) {
        "ssh-rsa"
    } else {
        key.name()
    };
    file.write_all(format!("\n{target} {algorithm} {}\n", key.public_key_base64()).as_bytes())?;
    file.flush()?;
    file.sync_data()?;
    Ok(())
}

pub(super) fn inspect_host(host: &str, port: u16, key: &key::PublicKey) -> Result<HostKeyInfo> {
    let fingerprint = format!("SHA256:{}", key.fingerprint());
    Ok(match check_known_host(host, port, key)? {
        KnownHostStatus::Trusted => HostKeyInfo {
            status: "trusted".into(),
            fingerprint,
            old_fingerprint: None,
        },
        KnownHostStatus::Unknown { .. } => HostKeyInfo {
            status: "unknown".into(),
            fingerprint,
            old_fingerprint: None,
        },
        KnownHostStatus::Changed {
            old_fingerprint, ..
        } => HostKeyInfo {
            status: "changed".into(),
            fingerprint,
            old_fingerprint: Some(old_fingerprint),
        },
    })
}

fn check_known_host_path(
    host: &str,
    port: u16,
    key: &key::PublicKey,
    path: &Path,
) -> Result<KnownHostStatus> {
    validate_endpoint(host, port)?;
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error).context("Could not read SSH known_hosts"),
    };
    let target = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    let mut recorded = Vec::new();
    for (line_number, line) in content.lines().enumerate() {
        let mut fields = line.split_whitespace();
        let Some(mut hosts) = fields.next().filter(|s| !s.starts_with('#')) else {
            continue;
        };
        let marker = if hosts.starts_with('@') {
            let marker = hosts;
            hosts = fields
                .next()
                .context("Invalid marked SSH known_hosts entry")?;
            Some(marker)
        } else {
            None
        };
        if !matches_hosts(&target, hosts) {
            continue;
        }
        let _algorithm = fields.next().context("Missing SSH host-key algorithm")?;
        let encoded = fields.next().context("Missing SSH host key")?;
        let public_key = russh_keys::parse_public_key_base64(encoded)
            .with_context(|| format!("Invalid SSH host key on line {}", line_number + 1))?;
        match marker {
            Some("@revoked") if public_key == *key => {
                bail!("SSH_HOST_KEY_REVOKED: {}", key.fingerprint())
            }
            Some("@cert-authority") | Some("@revoked") => continue,
            Some(marker) => bail!("Unsupported known_hosts marker {marker}"),
            None => recorded.push(public_key),
        }
    }
    // Hosts may legitimately list more than one algorithm or rotated key.
    if recorded.iter().any(|known| *known == *key) {
        return Ok(KnownHostStatus::Trusted);
    }
    let fingerprint = format!("SHA256:{}", key.fingerprint());
    if let Some(previous) = recorded.first() {
        return Ok(KnownHostStatus::Changed {
            old_fingerprint: format!("SHA256:{}", previous.fingerprint()),
            new_fingerprint: fingerprint,
        });
    }
    Ok(KnownHostStatus::Unknown { fingerprint })
}

fn matches_hosts(host: &str, patterns: &str) -> bool {
    let mut matched = false;
    for raw in patterns.split(',') {
        let (negative, pattern) = raw.strip_prefix('!').map_or((false, raw), |p| (true, p));
        let matches = if let Some(hashed) = pattern.strip_prefix("|1|") {
            hashed.split_once('|').is_some_and(|(salt, expected)| {
                let (Ok(salt), Ok(expected)) = (STANDARD.decode(salt), STANDARD.decode(expected))
                else {
                    return false;
                };
                Hmac::<Sha1>::new_from_slice(&salt)
                    .is_ok_and(|mac| mac.chain_update(host).verify_slice(&expected).is_ok())
            })
        } else {
            wildcard_match(pattern.as_bytes(), host.as_bytes())
        };
        if matches && negative {
            return false;
        }
        matched |= matches;
    }
    matched
}

fn wildcard_match(pattern: &[u8], value: &[u8]) -> bool {
    let mut matched = vec![false; value.len() + 1];
    matched[0] = true;
    for &character in pattern {
        let mut next = vec![false; value.len() + 1];
        if character == b'*' {
            next[0] = matched[0];
        }
        for i in 1..=value.len() {
            next[i] = if character == b'*' {
                next[i - 1] || matched[i]
            } else {
                matched[i - 1]
                    && (character == b'?' || character.eq_ignore_ascii_case(&value[i - 1]))
            };
        }
        matched = next;
    }
    matched[value.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_keys::PublicKeyBase64;

    fn keys() -> (key::PublicKey, key::PublicKey) {
        let first = key::KeyPair::generate_ed25519().clone_public_key().unwrap();
        let second = key::KeyPair::generate_ed25519().clone_public_key().unwrap();
        (first, second)
    }

    #[test]
    fn hostname_alone_never_trusts_a_different_key_or_port() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let (first, second) = keys();
        std::fs::write(
            file.path(),
            format!(
                "example.test\t{}\t{}\n",
                first.name(),
                first.public_key_base64()
            ),
        )
        .unwrap();
        assert_eq!(
            check_known_host_path("example.test", 22, &first, file.path()).unwrap(),
            KnownHostStatus::Trusted
        );
        assert!(matches!(
            check_known_host_path("example.test", 22, &second, file.path()).unwrap(),
            KnownHostStatus::Changed { .. }
        ));
        assert!(matches!(
            check_known_host_path("example.test", 2222, &first, file.path()).unwrap(),
            KnownHostStatus::Unknown { .. }
        ));
    }

    #[test]
    fn hashed_entries_match_real_keys_and_revocation_wins() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let (first, _) = keys();
        let target = "[example.test]:2222";
        let salt = b"test random salt";
        let digest = Hmac::<Sha1>::new_from_slice(salt)
            .unwrap()
            .chain_update(target)
            .finalize()
            .into_bytes();
        let entry = format!(
            "|1|{}|{} {} {}\n",
            STANDARD.encode(salt),
            STANDARD.encode(digest),
            first.name(),
            first.public_key_base64()
        );
        std::fs::write(file.path(), &entry).unwrap();
        assert_eq!(
            check_known_host_path("example.test", 2222, &first, file.path()).unwrap(),
            KnownHostStatus::Trusted
        );
        std::fs::write(file.path(), format!("{entry}@revoked {entry}")).unwrap();
        assert!(
            check_known_host_path("example.test", 2222, &first, file.path())
                .unwrap_err()
                .to_string()
                .contains("REVOKED")
        );
    }

    #[test]
    fn wildcard_negation_and_endpoint_validation() {
        assert!(matches_hosts(
            "build.example.test",
            "*.example.test,!prod.example.test"
        ));
        assert!(!matches_hosts(
            "prod.example.test",
            "*.example.test,!prod.example.test"
        ));
        assert!(validate_endpoint("2001:db8::1", 22).is_ok());
        assert!(validate_endpoint("host\n*", 22).is_err());
    }
}
