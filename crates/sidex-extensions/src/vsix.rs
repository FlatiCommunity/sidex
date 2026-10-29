//! VSIX package handling — parse, extract, validate, and install `.vsix` files.
//!
//! A `.vsix` is a ZIP archive following the Open VSIX Packaging format:
//!
//! ```text
//! [Content_Types].xml
//! extension.vsixmanifest          (XML metadata)
//! extension/
//!   package.json                  (extension manifest)
//!   README.md
//!   CHANGELOG.md
//!   LICENSE
//!   icon.png
//!   ...extension files...
//! ```

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::encoding::decode_manifest_text;
use crate::manifest::{parse_manifest_str, sanitize_ext_id, ExtensionManifest};
use crate::marketplace::current_target_platform;

const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A fully unpacked VSIX package held in memory.
#[derive(Debug, Clone)]
pub struct VsixPackage {
    pub manifest: ExtensionManifest,
    pub readme: Option<String>,
    pub changelog: Option<String>,
    pub license_text: Option<String>,
    pub icon: Option<Vec<u8>>,
    /// Raw file contents keyed by their path relative to `extension/`.
    pub contents: HashMap<String, Vec<u8>>,
    /// Unix mode bits for each content entry (when present in the zip).
    /// Used to restore `+x` on binaries shipped inside the VSIX.
    pub modes: HashMap<String, u32>,
    pub vsix_manifest_xml: Option<String>,
}

/// An installed extension with its location on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledExtension {
    pub manifest: ExtensionManifest,
    pub install_dir: PathBuf,
}

/// Result of VSIX integrity validation.
#[derive(Debug, Clone)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Unpack
// ---------------------------------------------------------------------------

/// Unpacks a `.vsix` file into a `VsixPackage` in memory.
#[allow(
    clippy::too_many_lines,
    reason = "Keep ordered archive limits, path validation, and extraction together for auditability"
)]
pub fn unpack_vsix(vsix_path: &Path) -> Result<VsixPackage> {
    let file = std::fs::File::open(vsix_path)
        .with_context(|| format!("failed to open .vsix: {}", vsix_path.display()))?;
    let mut archive = zip::ZipArchive::new(file).context("failed to read .vsix as ZIP")?;

    let mut manifest_json: Option<String> = None;
    let mut vsix_manifest_xml: Option<String> = None;
    let mut readme: Option<String> = None;
    let mut changelog: Option<String> = None;
    let mut license_text: Option<String> = None;
    let mut icon: Option<Vec<u8>> = None;
    let mut contents: HashMap<String, Vec<u8>> = HashMap::new();
    let mut modes: HashMap<String, u32> = HashMap::new();
    anyhow::ensure!(
        archive.len() <= MAX_ARCHIVE_ENTRIES,
        "VSIX has too many entries"
    );
    let mut total_bytes = 0_u64;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry
            .enclosed_name()
            .context("VSIX contains an unsafe entry path")?;
        let name_str = name.to_string_lossy().to_string();
        anyhow::ensure!(
            !name_str.contains('\\'),
            "VSIX entry uses an unsafe path separator"
        );
        anyhow::ensure!(
            entry
                .unix_mode()
                .is_none_or(|mode| mode & 0o170_000 != 0o120_000),
            "VSIX symlinks are not supported"
        );
        anyhow::ensure!(
            entry.size() <= MAX_FILE_BYTES,
            "VSIX file exceeds the size limit"
        );
        total_bytes = total_bytes
            .checked_add(entry.size())
            .context("VSIX size overflow")?;
        anyhow::ensure!(
            total_bytes <= MAX_PACKAGE_BYTES,
            "VSIX exceeds the unpacked size limit"
        );

        if name_str == "extension.vsixmanifest" {
            let mut buf = Vec::new();
            entry
                .by_ref()
                .take(MAX_FILE_BYTES + 1)
                .read_to_end(&mut buf)?;
            anyhow::ensure!(
                buf.len() as u64 <= MAX_FILE_BYTES,
                "VSIX manifest exceeds the size limit"
            );
            vsix_manifest_xml = Some(decode_manifest_text(&buf)?);
            continue;
        }

        let Some(rel) = name_str.strip_prefix("extension/") else {
            continue;
        };
        if rel.is_empty() || entry.is_dir() {
            continue;
        }

        validate_relative_path(rel)?;
        anyhow::ensure!(
            !contents.contains_key(rel),
            "VSIX contains duplicate file {rel}"
        );
        let unix_mode = entry.unix_mode();
        let mut buf = Vec::new();
        entry
            .by_ref()
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut buf)?;
        anyhow::ensure!(
            buf.len() as u64 <= MAX_FILE_BYTES,
            "VSIX file exceeds the size limit"
        );

        let rel_lower = rel.to_lowercase();
        match rel_lower.as_str() {
            "package.json" => {
                manifest_json = Some(decode_manifest_text(&buf)?);
            }
            "readme.md" => {
                readme = Some(String::from_utf8_lossy(&buf).to_string());
            }
            "changelog.md" => {
                changelog = Some(String::from_utf8_lossy(&buf).to_string());
            }
            "license" | "license.md" | "license.txt" => {
                license_text = Some(String::from_utf8_lossy(&buf).to_string());
            }
            _ => {}
        }

        if (std::path::Path::new(&rel_lower)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
            || std::path::Path::new(&rel_lower)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jpg"))
            || std::path::Path::new(&rel_lower)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("svg")))
            && rel_lower.contains("icon")
        {
            icon = Some(buf.clone());
        }

        contents.insert(rel.to_string(), buf);
        if let Some(mode) = unix_mode {
            modes.insert(rel.to_string(), mode);
        }
    }

    let json = manifest_json.context("missing extension/package.json in .vsix")?;
    let manifest = parse_manifest_str(&json)?;

    Ok(VsixPackage {
        manifest,
        readme,
        changelog,
        license_text,
        icon,
        contents,
        modes,
        vsix_manifest_xml,
    })
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/// Validates a VSIX package for integrity and required fields.
pub fn validate_vsix(pkg: &VsixPackage) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if pkg.manifest.name.is_empty() {
        errors.push("manifest is missing 'name'".to_string());
    }
    if pkg.manifest.version.is_empty() {
        errors.push("manifest is missing 'version'".to_string());
    }

    if let Err(error) = sanitize_ext_id(&pkg.manifest.canonical_id()) {
        errors.push(error.to_string());
    }
    let derived_id = pkg.manifest.publisher.as_ref().map_or_else(
        || pkg.manifest.name.clone(),
        |publisher| format!("{publisher}.{}", pkg.manifest.name),
    );
    if !pkg
        .manifest
        .canonical_id()
        .eq_ignore_ascii_case(&derived_id)
    {
        errors.push("manifest id disagrees with publisher and name".to_string());
    }
    if let Err(error) =
        validate_target_platform(pkg.vsix_manifest_xml.as_deref(), current_target_platform())
    {
        errors.push(error.to_string());
    }
    for path in pkg.contents.keys() {
        if let Err(error) = validate_relative_path(path) {
            errors.push(error.to_string());
        }
    }

    if pkg.manifest.publisher.is_none() {
        warnings.push("manifest has no 'publisher' field".to_string());
    }
    if pkg.manifest.main.is_none() && pkg.manifest.browser.is_none() {
        warnings.push("no entry point: neither 'main' nor 'browser' specified".to_string());
    }
    if pkg.readme.is_none() {
        warnings.push("no README.md found".to_string());
    }
    if pkg.license_text.is_none() {
        warnings.push("no LICENSE file found".to_string());
    }
    if pkg.contents.is_empty() {
        errors.push("VSIX contains no extension files".to_string());
    }

    if let Some(ref main) = pkg.manifest.main {
        let main_normalized = main.strip_prefix("./").unwrap_or(main);
        if !pkg.contents.contains_key(main_normalized) {
            let with_js = format!("{main_normalized}.js");
            if !pkg.contents.contains_key(&with_js) {
                warnings.push(format!("entry point '{main}' not found in archive"));
            }
        }
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

/// Validates a `.vsix` file on disk.
pub fn validate_vsix_file(vsix_path: &Path) -> Result<ValidationResult> {
    let pkg = unpack_vsix(vsix_path)?;
    Ok(validate_vsix(&pkg))
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/// Installs a VSIX package (already unpacked) to an extensions directory.
pub fn install_package(pkg: &VsixPackage, extensions_dir: &Path) -> Result<InstalledExtension> {
    let validation = validate_vsix(pkg);
    anyhow::ensure!(
        validation.valid,
        "VSIX validation failed: {}",
        validation.errors.join("; ")
    );
    let ext_id = sanitize_ext_id(&pkg.manifest.canonical_id())?;
    std::fs::create_dir_all(extensions_dir)?;
    let ext_dir = extensions_dir.join(&ext_id);
    anyhow::ensure!(
        !std::fs::symlink_metadata(&ext_dir)
            .is_ok_and(|metadata| metadata.file_type().is_symlink()),
        "extension directory must not be a symlink"
    );

    // Stage on the same filesystem: a failed extraction must keep the old
    // installation intact, and committing is a rename, not a partial copy.
    let staging = tempfile::Builder::new()
        .prefix(".sidex-install-")
        .tempdir_in(extensions_dir)?;
    let payload = staging.path().join("extension");
    std::fs::create_dir(&payload)?;
    for (rel_path, data) in &pkg.contents {
        let out_path = payload.join(rel_path);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&out_path, data)?;
        apply_file_mode(&out_path, pkg.modes.get(rel_path).copied(), rel_path);
    }

    // Older hosts kept state inside the installation directory. Keep that
    // state across updates until the host migrates it to user data on activation.
    // Copy before changing the old installation so any I/O error is harmless.
    for legacy in [".storage", ".global-storage"] {
        let source = ext_dir.join(legacy);
        if std::fs::symlink_metadata(&source).is_ok() {
            let destination = payload.join(legacy);
            anyhow::ensure!(
                !destination.exists(),
                "VSIX conflicts with legacy extension state: {legacy}"
            );
            copy_legacy_storage(&source, &destination)?;
        }
    }

    let previous = staging.path().join("previous");
    let had_previous = ext_dir.exists();
    if had_previous {
        std::fs::rename(&ext_dir, &previous).context("failed to prepare extension update")?;
    }
    if let Err(error) = std::fs::rename(&payload, &ext_dir) {
        if had_previous {
            if let Err(rollback) = std::fs::rename(&previous, &ext_dir) {
                // Keep the backup recoverable if the OS also refuses rollback.
                let backup = staging.keep();
                anyhow::bail!("install failed: {error}; restore failed: {rollback}; previous installation is in {}", backup.join("previous").display());
            }
        }
        return Err(error).context("failed to commit extension installation");
    }

    Ok(InstalledExtension {
        manifest: pkg.manifest.clone(),
        install_dir: ext_dir,
    })
}

fn copy_legacy_storage(source: &Path, destination: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(source)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, destination)?;
        #[cfg(windows)]
        if source.is_dir() {
            std::os::windows::fs::symlink_dir(target, destination)?;
        } else {
            std::os::windows::fs::symlink_file(target, destination)?;
        }
    } else if metadata.is_dir() {
        std::fs::create_dir(destination)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_legacy_storage(&entry.path(), &destination.join(entry.file_name()))?;
        }
        std::fs::set_permissions(destination, metadata.permissions())?;
    } else {
        std::fs::copy(source, destination)?;
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<()> {
    anyhow::ensure!(
        !path.is_empty()
            && !path.contains(['\\', ':', '\0'])
            && Path::new(path)
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_))),
        "unsafe VSIX file path: {path}"
    );
    Ok(())
}

fn validate_target_platform(manifest: Option<&str>, expected: &str) -> Result<()> {
    let Some(manifest) = manifest else {
        return Ok(());
    };
    let mut reader = quick_xml::Reader::from_str(manifest);
    loop {
        match reader.read_event().context("invalid VSIX XML manifest")? {
            quick_xml::events::Event::Start(element) | quick_xml::events::Event::Empty(element)
                if element.local_name().as_ref() == b"Identity" =>
            {
                for attribute in element.attributes() {
                    let attribute = attribute.context("invalid VSIX Identity attribute")?;
                    if attribute.key.local_name().as_ref() == b"TargetPlatform" {
                        let value = attribute.decode_and_unescape_value(reader.decoder())?;
                        anyhow::ensure!(
                            value.is_empty() || value == "universal" || value == expected,
                            "extension targets {value}, but SideX requires {expected}"
                        );
                    }
                }
            }
            quick_xml::events::Event::Eof => return Ok(()),
            _ => {}
        }
    }
}

/// Restore Unix executable bits for files shipped inside a VSIX.
///
/// VSIX archives sometimes carry executable binaries or shell scripts; the
/// zip entries store POSIX modes in their external attributes. We apply them
/// on install so extensions relying on `spawn(path)` don't fail with EACCES.
/// As a safety net, files under `bin/` or with common script extensions get
/// `+x` even when no mode was recorded.
#[cfg(unix)]
fn apply_file_mode(path: &Path, mode: Option<u32>, rel: &str) {
    use std::os::unix::fs::PermissionsExt;

    let is_script_like = rel.starts_with("bin/")
        || rel.contains("/bin/")
        || std::path::Path::new(rel)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("sh"))
        || rel.ends_with(".command");

    let target_mode = match mode {
        Some(m) if m != 0 => m & 0o777,
        _ if is_script_like => 0o755,
        _ => return,
    };

    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        if perms.mode() & 0o777 != target_mode & 0o777 {
            perms.set_mode(target_mode);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
}

#[cfg(not(unix))]
fn apply_file_mode(_path: &Path, _mode: Option<u32>, _rel: &str) {}

/// Convenience: unpack, validate, and install a `.vsix` file.
pub fn install_vsix(vsix_path: &Path, extensions_dir: &Path) -> Result<InstalledExtension> {
    let pkg = unpack_vsix(vsix_path)?;
    let validation = validate_vsix(&pkg);
    if !validation.valid {
        anyhow::bail!("VSIX validation failed: {}", validation.errors.join("; "));
    }
    install_package(&pkg, extensions_dir)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_catches_empty_name() {
        let pkg = VsixPackage {
            manifest: ExtensionManifest {
                name: String::new(),
                version: "1.0.0".into(),
                ..default_test_manifest()
            },
            readme: None,
            changelog: None,
            license_text: None,
            icon: None,
            contents: HashMap::from([("dist/main.js".into(), vec![])]),
            modes: HashMap::new(),
            vsix_manifest_xml: None,
        };
        let r = validate_vsix(&pkg);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|e| e.contains("name")));
    }

    #[test]
    fn validation_warns_on_no_readme() {
        let pkg = VsixPackage {
            manifest: default_test_manifest(),
            readme: None,
            changelog: None,
            license_text: Some("MIT".into()),
            icon: None,
            contents: HashMap::from([("dist/main.js".into(), vec![])]),
            modes: HashMap::new(),
            vsix_manifest_xml: None,
        };
        let r = validate_vsix(&pkg);
        assert!(r.valid);
        assert!(r.warnings.iter().any(|w| w.contains("README")));
    }

    #[test]
    fn validation_ok_for_complete_package() {
        let pkg = VsixPackage {
            manifest: default_test_manifest(),
            readme: Some("# Test".into()),
            changelog: Some("## 1.0.0".into()),
            license_text: Some("MIT".into()),
            icon: None,
            contents: HashMap::from([
                ("package.json".into(), b"{}".to_vec()),
                ("dist/main.js".into(), b"module.exports={}".to_vec()),
            ]),
            modes: HashMap::new(),
            vsix_manifest_xml: None,
        };
        let r = validate_vsix(&pkg);
        assert!(r.valid);
        assert!(r.errors.is_empty());
    }

    fn write_vsix(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        use std::io::Write;
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut archive = zip::ZipWriter::new(file.reopen().unwrap());
        for (name, content) in entries {
            archive
                .start_file(
                    *name,
                    zip::write::SimpleFileOptions::default().unix_permissions(0o755),
                )
                .unwrap();
            archive.write_all(content).unwrap();
        }
        archive.finish().unwrap();
        file
    }

    #[test]
    fn platform_validation_accepts_universal_and_exact_build_only() {
        for platform in ["", "universal", "darwin-arm64"] {
            let xml = format!(
                r#"<PackageManifest><Metadata><Identity TargetPlatform="{platform}" /></Metadata></PackageManifest>"#
            );
            assert!(validate_target_platform(Some(&xml), "darwin-arm64").is_ok());
        }
        assert!(validate_target_platform(None, "darwin-arm64").is_ok());
        assert!(validate_target_platform(
            Some("<Identity TargetPlatform='linux-arm64'/>"),
            "darwin-arm64"
        )
        .is_err());
        assert!(validate_target_platform(
            Some("<Identity TargetPlatform='linux-x64'"),
            "linux-x64"
        )
        .is_err());
    }

    #[test]
    fn rejects_unsafe_identity_and_payload_before_replacing_installed_extension() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("test.ext");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("previous.txt"), b"keep me").unwrap();
        let fixture = write_vsix(&[
            (
                "extension/package.json",
                br#"{"name":"ext","publisher":"test","version":"2.0.0"}"#,
            ),
            ("extension/main.js", b"new"),
        ]);
        let mut pkg = unpack_vsix(fixture.path()).unwrap();
        pkg.contents.insert("../../escape".into(), vec![1]);
        assert!(install_package(&pkg, dir.path()).is_err());
        assert_eq!(std::fs::read(old.join("previous.txt")).unwrap(), b"keep me");
        pkg.contents.remove("../../escape");
        pkg.manifest.id = "../test.ext".into();
        assert!(install_package(&pkg, dir.path()).is_err());
        assert_eq!(std::fs::read(old.join("previous.txt")).unwrap(), b"keep me");
    }

    #[test]
    fn local_and_gallery_install_share_permissions_and_atomic_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = write_vsix(&[
            (
                "extension/package.json",
                br#"{"name":"ext","publisher":"test","version":"2.0.0"}"#,
            ),
            ("extension/bin/tool", b"#!/bin/sh\nexit 0\n"),
        ]);
        let old = dir.path().join("test.ext");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("stale.txt"), b"obsolete").unwrap();
        std::fs::create_dir_all(old.join(".global-storage/nested")).unwrap();
        std::fs::write(old.join(".global-storage/nested/state.json"), b"user state").unwrap();
        let manifest = crate::installer::install_from_vsix(fixture.path(), dir.path()).unwrap();
        assert_eq!(manifest.version, "2.0.0");
        assert!(!old.join("stale.txt").exists());
        assert!(old.join("bin/tool").is_file());
        assert_eq!(
            std::fs::read(old.join(".global-storage/nested/state.json")).unwrap(),
            b"user state"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(
                std::fs::metadata(old.join("bin/tool"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0
            );
        }
    }

    #[test]
    fn rejects_wrong_platform_before_modifying_disk() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = write_vsix(&[
            ("extension.vsixmanifest", br#"<PackageManifest><Metadata><Identity TargetPlatform="not-this-platform"/></Metadata></PackageManifest>"#),
            ("extension/package.json", br#"{"name":"ext","publisher":"test","version":"2.0.0"}"#),
        ]);
        assert!(crate::installer::install_from_vsix(fixture.path(), dir.path()).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn archive_with_more_than_ten_thousand_entries_is_read_completely() {
        use std::io::Write;
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut archive = zip::ZipWriter::new(file.reopen().unwrap());
        archive
            .start_file(
                "extension/package.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive
            .write_all(br#"{"name":"ext","publisher":"test","version":"1.0.0"}"#)
            .unwrap();
        for i in 0..10_001 {
            archive
                .start_file(
                    format!("extension/files/{i}"),
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
        }
        archive.finish().unwrap();
        let pkg = unpack_vsix(file.path()).unwrap();
        assert_eq!(pkg.contents.len(), 10_002);
        assert!(pkg.contents.contains_key("files/10000"));
    }

    fn default_test_manifest() -> ExtensionManifest {
        ExtensionManifest {
            id: "test.ext".into(),
            name: "ext".into(),
            display_name: "Test Extension".into(),
            version: "1.0.0".into(),
            publisher: Some("test".into()),
            main: Some("./dist/main.js".into()),
            ..serde_json::from_str(
                r#"{"name":"ext","version":"1.0.0","publisher":"test","main":"./dist/main.js"}"#,
            )
            .unwrap()
        }
    }
}
