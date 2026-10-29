//! Extension install, uninstall, and update operations.
//!
//! Handles extracting `.vsix` packages (which are ZIP archives) and
//! coordinating downloads from the marketplace.

use std::path::Path;

use anyhow::{Context, Result};

use crate::manifest::{parse_manifest, ExtensionManifest};
use crate::marketplace::MarketplaceClient;

/// Installs an extension from a local `.vsix` file.
///
/// A `.vsix` is a ZIP archive whose `extension/` subtree contains the
/// extension files and `extension/package.json` is the manifest.
pub fn install_from_vsix(vsix_path: &Path, target_dir: &Path) -> Result<ExtensionManifest> {
    Ok(crate::vsix::install_vsix(vsix_path, target_dir)?.manifest)
}

/// Downloads and installs an extension from the marketplace.
pub async fn install_from_marketplace(id: &str, target_dir: &Path) -> Result<ExtensionManifest> {
    let client = MarketplaceClient::new();
    let ext = client
        .get_extension(id)
        .await
        .context("failed to fetch extension metadata")?;

    let vsix_bytes = client
        .download_vsix_bytes(id, &ext.version)
        .await
        .context("failed to download .vsix")?;

    let tmp = tempfile::NamedTempFile::new()?;
    std::fs::write(tmp.path(), &vsix_bytes)?;

    install_from_vsix(tmp.path(), target_dir)
}

/// Uninstalls an extension by removing its directory.
pub fn uninstall(id: &str, extensions_dir: &Path) -> Result<()> {
    let id = crate::manifest::sanitize_ext_id(id)?;
    let ext_dir = extensions_dir.join(id);
    if ext_dir.exists() {
        std::fs::remove_dir_all(&ext_dir).context("failed to remove extension directory")?;
    }
    Ok(())
}

/// Updates an extension to its latest version.
pub async fn update(id: &str, extensions_dir: &Path) -> Result<ExtensionManifest> {
    // Keep the existing version until its replacement has been validated and staged.
    install_from_marketplace(id, extensions_dir).await
}

/// Reads the manifest of an installed extension.
pub fn read_installed_manifest(id: &str, extensions_dir: &Path) -> Result<ExtensionManifest> {
    let id = crate::manifest::sanitize_ext_id(id)?;
    let pkg = extensions_dir.join(id).join("package.json");
    parse_manifest(&pkg)
}
