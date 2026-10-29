//! Opt-in integration check against an ephemeral local OpenSSH/SFTP server.
//! SIDEX_TEST_SSH_HOST/PORT/USER/KEY/ROOT select the disposable fixture.
//! This test creates its own known_hosts file and never changes HOME.

use russh_keys::PublicKeyBase64;
use serde_json::json;
use sidex_remote::ssh::{probe_host_key, SshAuth, SshTransport};
use sidex_remote::RemoteTransport;
use std::path::PathBuf;
use std::time::Duration;

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable SSH server"]
async fn ssh_live_transport() -> anyhow::Result<()> {
    let host = std::env::var("SIDEX_TEST_SSH_HOST")?;
    let port: u16 = std::env::var("SIDEX_TEST_SSH_PORT")?.parse()?;
    let user = std::env::var("SIDEX_TEST_SSH_USER")?;
    let auth = SshAuth::KeyFile {
        path: PathBuf::from(std::env::var("SIDEX_TEST_SSH_KEY")?),
        passphrase: None,
    };
    let root = format!(
        "{}/sidex-test-{}",
        std::env::var("SIDEX_TEST_SSH_ROOT")?,
        std::process::id()
    );
    let profile = tempfile::tempdir()?;
    let known_hosts = profile.path().join("known_hosts");
    std::env::set_var("SIDEX_SSH_KNOWN_HOSTS", &known_hosts);

    let probe = probe_host_key(&host, port).await?;
    assert_eq!(probe.status, "unknown");
    assert!(probe.fingerprint.starts_with("SHA256:"));
    assert!(
        SshTransport::connect_as(&user, &host, port, auth.clone(), Some(30))
            .await
            .is_err()
    );
    assert!(SshTransport::connect_as_trusted(
        &user,
        &host,
        port,
        auth.clone(),
        Some(30),
        Some("SHA256:incorrect".into())
    )
    .await
    .is_err());
    let ssh = SshTransport::connect_as_trusted(
        &user,
        &host,
        port,
        auth.clone(),
        Some(30),
        Some(probe.fingerprint.clone()),
    )
    .await?;
    assert_eq!(probe_host_key(&host, port).await?.status, "trusted");

    let output = ssh
        .exec("printf 'Привет'; printf 'problem' >&2; exit 37")
        .await?;
    assert_eq!(output.stdout, "Привет");
    assert_eq!(output.stderr, "problem");
    assert_eq!(output.exit_code, 37);
    ssh.set_env("SIDEX_TEST_LITERAL", "'$(printf should-not-execute)'")
        .await?;
    assert_eq!(
        ssh.exec("printf '%s' \"$SIDEX_TEST_LITERAL\"")
            .await?
            .stdout,
        "'$(printf should-not-execute)'"
    );

    ssh.file_request(json!({"op":"mkdir","path":root})).await?;
    let name = "bin 中文 'quoted'\n$(touch should-not-exist):test";
    let file = format!("{root}/{name}");
    let binary: Vec<u8> = (0..=255).cycle().take(1_048_576).collect();
    ssh.file_request(
        json!({"op":"write","path":file,"data":binary,"create":true,"overwrite":false}),
    )
    .await?;
    assert_eq!(ssh.read_file(&file).await?, binary);
    assert!(ssh
        .file_request(json!({"op":"write","path":file,"data":[9],"create":true,"overwrite":false}))
        .await
        .unwrap_err()
        .to_string()
        .starts_with("FileExists:"));
    assert_eq!(ssh.read_file(&file).await?, binary);
    assert!(ssh.file_request(json!({"op":"write","path":format!("{root}/missing"),"data":[9],"create":false,"overwrite":true})).await.is_err());
    assert!(ssh
        .file_request(json!({"op":"readdir","path":root}))
        .await?
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry[0] == name && entry[1] == 1));

    let link = format!("{root}/link");
    assert_eq!(
        ssh.exec(&format!(
            "chmod 640 -- {}; ln -s -- {} {}",
            quote(&file),
            quote(&file),
            quote(&link)
        ))
        .await?
        .exit_code,
        0
    );
    ssh.write_file(&link, b"updated\0\xff").await?;
    assert_eq!(ssh.read_file(&file).await?, b"updated\0\xff");
    assert!(ssh.stat(&link).await?.is_symlink);
    assert_eq!(
        ssh.exec(&format!("stat -c %a -- {}", quote(&file)))
            .await?
            .stdout
            .trim(),
        "640"
    );
    let snapshot = ssh
        .file_request(json!({"op":"snapshot","path":root,"recursive":true,"excludes":[]}))
        .await?;
    assert!(snapshot.get(&file).is_some());

    let moved = format!("{root}/renamed");
    ssh.file_request(json!({"op":"rename","path":file,"target":moved,"overwrite":false}))
        .await?;
    assert_eq!(ssh.read_file(&moved).await?, b"updated\0\xff");
    assert!(ssh
        .file_request(json!({"op":"delete","path":"/tmp/..","recursive":true}))
        .await
        .unwrap_err()
        .to_string()
        .starts_with("NoPermissions:"));

    let mut pty = ssh.open_pty(80, 24).await?;
    let status = pty.exit_code_handle();
    pty.resize(101, 43).await?;
    pty.write(b"stty size; printf '__SIDEX_PTY_DONE__\\n'; exit 42\n")
        .await?;
    let transcript = tokio::time::timeout(Duration::from_secs(10), async {
        let mut transcript = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = pty.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            transcript.extend_from_slice(&buffer[..count]);
        }
        anyhow::Ok(String::from_utf8_lossy(&transcript).into_owned())
    })
    .await??;
    assert!(
        transcript.contains("43 101"),
        "resize did not reach PTY: {transcript}"
    );

    assert_eq!(status.load(std::sync::atomic::Ordering::Acquire), 42);

    if std::env::var_os("SSH_AUTH_SOCK").is_some() {
        let agent = SshTransport::connect_as(&user, &host, port, SshAuth::Agent, Some(30)).await?;
        assert_eq!(agent.exec("printf agent-ok").await?.stdout, "agent-ok");
        agent.disconnect().await?;
    }
    let proxy = SshTransport::connect_via_proxy(
        &host,
        port,
        auth.clone(),
        &host,
        port,
        auth.clone(),
        &user,
    )
    .await?;
    assert_eq!(proxy.exec("printf proxy-ok").await?.stdout, "proxy-ok");
    proxy.disconnect().await?;

    ssh.file_request(json!({"op":"delete","path":root,"recursive":true}))
        .await?;
    ssh.disconnect().await?;
    let fake = russh_keys::key::KeyPair::generate_ed25519().clone_public_key()?;
    std::fs::write(
        &known_hosts,
        format!(
            "[{host}]:{port} {} {}\n",
            fake.name(),
            fake.public_key_base64()
        ),
    )?;
    assert_eq!(probe_host_key(&host, port).await?.status, "changed");
    assert!(SshTransport::connect_as_trusted(
        &user,
        &host,
        port,
        auth,
        Some(30),
        Some(probe.fingerprint)
    )
    .await
    .is_err());
    Ok(())
}
