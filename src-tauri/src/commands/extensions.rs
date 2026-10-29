use crate::commands::extension_platform::{read_extension_manifest, ExtensionManifest};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Serialize;
use sidex_extensions::contributions::{parse_contributions, ContributionPoint};
use sidex_extensions::installer::{
    install_from_vsix as crate_install_from_vsix, uninstall as crate_uninstall,
};
use sidex_extensions::manifest::sanitize_ext_id;
use sidex_extensions::marketplace::{current_target_platform, MarketplaceClient};
use sidex_extensions::paths::user_extensions_dir;
use sidex_extensions::vsix::{install_package, unpack_vsix, validate_vsix};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use url::Url;

/// Shared marketplace client — one HTTP connection pool per process,
/// so searches don't re-do TCP+TLS handshakes on every keystroke.
/// The client also owns the in-process query cache, which was
/// previously wiped every call because a fresh client was constructed.
pub struct MarketplaceClientState {
    inner: Mutex<MarketplaceClient>,
}

impl Default for MarketplaceClientState {
    fn default() -> Self {
        Self::new()
    }
}

impl MarketplaceClientState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(MarketplaceClient::new()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct InstalledExtension {
    pub id: String,
    pub name: String,
    pub version: String,
    pub path: String,
}

fn to_installed(
    manifest: &sidex_extensions::manifest::ExtensionManifest,
    path: &Path,
) -> InstalledExtension {
    InstalledExtension {
        id: manifest.canonical_id(),
        name: if manifest.display_name.is_empty() {
            manifest.name.clone()
        } else {
            manifest.display_name.clone()
        },
        version: manifest.version.clone(),
        path: path.to_string_lossy().to_string(),
    }
}

/// Replaces an URL's target platform with the current native build target.
///
/// The webview's platform detection can be unavailable or incorrect. The
/// native backend is the authoritative source because its target is fixed at
/// compile time.
fn ensure_target_platform(url: &str) -> String {
    let Ok(mut parsed) = Url::parse(url) else {
        return url.to_owned();
    };

    let platform = current_target_platform();
    let mut found_platform = false;
    let mut query = Vec::new();

    for (key, value) in parsed.query_pairs() {
        if key == "targetPlatform" {
            if !found_platform {
                query.push((key.into_owned(), platform.to_owned()));
                found_platform = true;
            }
        } else {
            query.push((key.into_owned(), value.into_owned()));
        }
    }

    if !found_platform {
        query.push(("targetPlatform".to_owned(), platform.to_owned()));
    }

    let mut query_pairs = parsed.query_pairs_mut();
    query_pairs.clear();
    for (key, value) in query {
        query_pairs.append_pair(&key, &value);
    }
    drop(query_pairs);

    parsed.into()
}

/// Rewrites the platform embedded in a `SideX` Open VSX proxy VSIX URL.
///
/// The proxy's `vsix-<base64url>` segment contains the original Open VSX URL.
/// It does not honor `targetPlatform` on the outer URL, so platform-specific
/// VSIX files must be corrected before the request is made.
fn rewrite_proxy_vsix_platform(url: &str, new_platform: &str) -> String {
    let Ok(mut proxy_url) = Url::parse(url) else {
        return url.to_owned();
    };
    if !proxy_url.path().contains("/api/asset/openvsx/") {
        return url.to_owned();
    }

    let Some(mut proxy_segments) = proxy_url
        .path_segments()
        .map(|segments| segments.map(ToOwned::to_owned).collect::<Vec<_>>())
    else {
        return url.to_owned();
    };
    let Some((vsix_segment_index, encoded_upstream_url)) = proxy_segments
        .iter()
        .enumerate()
        .find_map(|(index, segment)| {
            segment
                .strip_prefix("vsix-")
                .map(|encoded| (index, encoded))
        })
    else {
        return url.to_owned();
    };
    let Ok(decoded_bytes) = URL_SAFE_NO_PAD.decode(encoded_upstream_url) else {
        return url.to_owned();
    };
    let Ok(decoded_url) = String::from_utf8(decoded_bytes) else {
        return url.to_owned();
    };
    let Ok(mut upstream_url) = Url::parse(&decoded_url) else {
        return url.to_owned();
    };
    if upstream_url.host_str() != Some("open-vsx.org") {
        return url.to_owned();
    }

    let Some(mut upstream_segments) = upstream_url
        .path_segments()
        .map(|segments| segments.map(ToOwned::to_owned).collect::<Vec<_>>())
    else {
        return url.to_owned();
    };
    let Some(file_index) = upstream_segments
        .iter()
        .position(|segment| segment == "file")
    else {
        return url.to_owned();
    };
    let Some(filename) = upstream_segments.get(file_index + 1).cloned() else {
        return url.to_owned();
    };
    let Some(filename_without_extension) = filename.strip_suffix(".vsix") else {
        return url.to_owned();
    };
    let Some((filename_prefix, old_platform)) = filename_without_extension.rsplit_once('@') else {
        return url.to_owned();
    };
    let Some(platform_index) = file_index.checked_sub(2) else {
        return url.to_owned();
    };
    if old_platform.is_empty()
        || old_platform == "universal"
        || old_platform == new_platform
        || upstream_segments
            .get(platform_index)
            .is_none_or(|platform| platform != old_platform)
    {
        return url.to_owned();
    }

    new_platform.clone_into(&mut upstream_segments[platform_index]);
    upstream_segments[file_index + 1] = format!("{filename_prefix}@{new_platform}.vsix");
    upstream_url.set_path(&format!("/{}", upstream_segments.join("/")));

    proxy_segments[vsix_segment_index] =
        format!("vsix-{}", URL_SAFE_NO_PAD.encode(upstream_url.as_str()));
    proxy_url.set_path(&format!("/{}", proxy_segments.join("/")));
    proxy_url.into()
}

#[tauri::command]
pub fn extension_get_target_platform() -> &'static str {
    current_target_platform()
}

#[tauri::command]
pub async fn read_vsix_manifest(vsix_path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pkg = unpack_vsix(Path::new(&vsix_path)).map_err(|e| format!("unpack vsix: {e:#}"))?;
        let validation = validate_vsix(&pkg);
        if !validation.valid {
            return Err(format!(
                "vsix validation failed: {}",
                validation.errors.join("; ")
            ));
        }
        let bytes = pkg
            .contents
            .get("package.json")
            .ok_or("missing extension/package.json")?;
        let text =
            sidex_extensions::encoding::decode_manifest_text(bytes).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("invalid extension manifest: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_extension(vsix_path: String) -> Result<InstalledExtension, String> {
    let vsix = Path::new(&vsix_path);
    if !vsix.exists() {
        return Err(format!("VSIX not found: {vsix_path}"));
    }

    let target_dir = user_extensions_dir();
    let installed =
        crate_install_from_vsix(vsix, &target_dir).map_err(|e| format!("install: {e:#}"))?;
    let safe_id = sanitize_ext_id(&installed.canonical_id()).map_err(|e| format!("{e:#}"))?;
    let ext_dir = target_dir.join(&safe_id);

    log::info!("installed extension {safe_id} to {}", ext_dir.display());
    Ok(to_installed(&installed, &ext_dir))
}

#[tauri::command]
pub async fn install_extension_from_url(
    url: String,
    expected_id: Option<String>,
) -> Result<InstalledExtension, String> {
    let url = rewrite_proxy_vsix_platform(&url, current_target_platform());
    let url = ensure_target_platform(&url);
    log::info!("downloading extension from {url}");
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("download client: {e}"))?;
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    const MAX_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;
    if resp
        .content_length()
        .is_some_and(|size| size > MAX_DOWNLOAD_BYTES as u64)
    {
        return Err("VSIX download exceeds 512 MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read body: {e}"))? {
        if bytes.len().saturating_add(chunk.len()) > MAX_DOWNLOAD_BYTES {
            return Err("VSIX download exceeds 512 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }

    let tmp_path = std::env::temp_dir().join(format!("sidex-{}.vsix", uuid::Uuid::new_v4()));
    fs::write(&tmp_path, &bytes).map_err(|e| format!("write tempfile: {e}"))?;

    let result = (|| -> Result<InstalledExtension, String> {
        let pkg = unpack_vsix(&tmp_path).map_err(|e| format!("unpack vsix: {e:#}"))?;
        if expected_id
            .as_ref()
            .is_some_and(|expected| !pkg.manifest.canonical_id().eq_ignore_ascii_case(expected))
        {
            return Err(format!(
                "downloaded extension {} does not match requested {}",
                pkg.manifest.canonical_id(),
                expected_id.as_deref().unwrap_or_default()
            ));
        }
        let validation = validate_vsix(&pkg);
        if !validation.valid {
            return Err(format!(
                "vsix validation failed: {}",
                validation.errors.join("; ")
            ));
        }
        let target_dir = user_extensions_dir();
        let installed =
            install_package(&pkg, &target_dir).map_err(|e| format!("install: {e:#}"))?;
        log::info!(
            "installed extension {} to {}",
            installed.manifest.canonical_id(),
            installed.install_dir.display()
        );
        Ok(to_installed(&installed.manifest, &installed.install_dir))
    })();

    let _ = fs::remove_file(&tmp_path);
    result
}

#[tauri::command]
pub async fn uninstall_extension(extension_id: String) -> Result<(), String> {
    let safe_id = sanitize_ext_id(&extension_id).map_err(|e| format!("{e:#}"))?;
    let target_dir = user_extensions_dir();
    let ext_dir = target_dir.join(&safe_id);
    if !ext_dir.exists() {
        return Ok(());
    }
    crate_uninstall(&safe_id, &target_dir).map_err(|e| format!("remove: {e:#}"))?;
    log::info!("uninstalled {extension_id}");
    Ok(())
}

#[tauri::command]
pub async fn list_installed_extensions(app: AppHandle) -> Result<Vec<InstalledExtension>, String> {
    let dir = user_extensions_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("readdir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(ExtensionManifest {
            id,
            display_name,
            version,
            path,
            ..
        }) = read_extension_manifest(&app, &path)
        {
            out.push(InstalledExtension {
                id,
                name: display_name,
                version,
                path,
            });
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct MarketplaceResult {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub publisher: String,
    pub install_count: u64,
    pub rating: f32,
    pub icon_url: Option<String>,
    pub download_url: String,
}

#[tauri::command]
pub async fn extension_search_marketplace(
    state: tauri::State<'_, Arc<MarketplaceClientState>>,
    query: String,
    page: u32,
) -> Result<Vec<MarketplaceResult>, String> {
    let mut client = state.inner.lock().await;
    let result = client
        .search(&query, page, 20)
        .await
        .map_err(|e| format!("marketplace search: {e}"))?;

    Ok(result
        .results
        .into_iter()
        .map(|ext| {
            let desc = if ext.short_description.is_empty() {
                ext.description.clone()
            } else {
                ext.short_description.clone()
            };
            MarketplaceResult {
                id: ext.id,
                name: ext.name,
                display_name: ext.display_name,
                description: desc,
                version: ext.version,
                publisher: ext.publisher.display_name,
                install_count: ext.install_count,
                rating: ext.rating,
                icon_url: ext.icon_url,
                download_url: ext.download_url,
            }
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct ContributionInfo {
    pub kind: String,
    pub count: usize,
    pub details: Vec<String>,
}

fn summarize_point(point: &ContributionPoint) -> ContributionInfo {
    match point {
        ContributionPoint::Commands(v) => ContributionInfo {
            kind: "commands".into(),
            count: v.len(),
            details: v.iter().map(|c| c.title.clone()).collect(),
        },
        ContributionPoint::Languages(v) => ContributionInfo {
            kind: "languages".into(),
            count: v.len(),
            details: v.iter().map(|l| l.id.clone()).collect(),
        },
        ContributionPoint::Themes(v) => ContributionInfo {
            kind: "themes".into(),
            count: v.len(),
            details: v.iter().map(|t| t.label.clone()).collect(),
        },
        ContributionPoint::Grammars(v) => ContributionInfo {
            kind: "grammars".into(),
            count: v.len(),
            details: v.iter().map(|g| g.scope_name.clone()).collect(),
        },
        ContributionPoint::Keybindings(v) => ContributionInfo {
            kind: "keybindings".into(),
            count: v.len(),
            details: v.iter().map(|k| k.command.clone()).collect(),
        },
        ContributionPoint::Snippets(v) => ContributionInfo {
            kind: "snippets".into(),
            count: v.len(),
            details: v.iter().map(|s| s.path.clone()).collect(),
        },
        ContributionPoint::Debuggers(v) => ContributionInfo {
            kind: "debuggers".into(),
            count: v.len(),
            details: v.iter().map(|d| d.label.clone()).collect(),
        },
        ContributionPoint::Views(m) => ContributionInfo {
            kind: "views".into(),
            count: m.values().map(Vec::len).sum(),
            details: m.values().flatten().map(|v| v.id.clone()).collect(),
        },
        ContributionPoint::Configuration(v) => ContributionInfo {
            kind: "configuration".into(),
            count: v.len(),
            details: v.iter().filter_map(|c| c.title.clone()).collect(),
        },
        ContributionPoint::IconThemes(v) => ContributionInfo {
            kind: "iconThemes".into(),
            count: v.len(),
            details: v.iter().map(|t| t.label.clone()).collect(),
        },
        ContributionPoint::ViewsContainers(m) => ContributionInfo {
            kind: "viewsContainers".into(),
            count: m.values().map(Vec::len).sum(),
            details: m.values().flatten().map(|c| c.title.clone()).collect(),
        },
        ContributionPoint::Menus(m) => ContributionInfo {
            kind: "menus".into(),
            count: m.values().map(Vec::len).sum(),
            details: m.keys().cloned().collect(),
        },
        ContributionPoint::TaskDefinitions(v) => ContributionInfo {
            kind: "taskDefinitions".into(),
            count: v.len(),
            details: v.iter().map(|t| t.task_type.clone()).collect(),
        },
        ContributionPoint::ProblemMatchers(v) => ContributionInfo {
            kind: "problemMatchers".into(),
            count: v.len(),
            details: v.iter().map(|p| p.name.clone()).collect(),
        },
        ContributionPoint::Terminal(t) => ContributionInfo {
            kind: "terminal".into(),
            count: t.profiles.len(),
            details: t.profiles.iter().map(|p| p.title.clone()).collect(),
        },
    }
}

#[tauri::command]
pub async fn extension_get_contributions(
    extension_dir: String,
) -> Result<Vec<ContributionInfo>, String> {
    let pkg_path = Path::new(&extension_dir).join("package.json");
    let value: serde_json::Value = crate::commands::encoding::read_json_file(&pkg_path)?;

    let points = parse_contributions(&value);
    Ok(points.iter().map(summarize_point).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy_url(platform: &str) -> String {
        let upstream_url = format!(
            "https://open-vsx.org/api/kilocode/kilo-code/{platform}/7.7.6/file/kilocode.kilo-code-7.7.6@{platform}.vsix?probe= "
        );
        let encoded = URL_SAFE_NO_PAD.encode(upstream_url);
        assert!(encoded.contains('_'));
        format!(
            "https://marketplace.siden.ai/api/asset/openvsx/vsix-{encoded}/Microsoft.VisualStudio.Services.VSIXPackage?redirect=true"
        )
    }

    fn decoded_proxy_target(url: &str) -> Url {
        let proxy_url = Url::parse(url).expect("proxy URL");
        let encoded = proxy_url
            .path_segments()
            .expect("path segments")
            .find_map(|segment| segment.strip_prefix("vsix-"))
            .expect("VSIX segment");
        let decoded = URL_SAFE_NO_PAD.decode(encoded).expect("base64url");
        Url::parse(&String::from_utf8(decoded).expect("UTF-8 URL")).expect("Open VSX URL")
    }

    #[test]
    fn rewrites_url_safe_proxy_vsix_platform() {
        let url = proxy_url("alpine-arm64");
        let rewritten = rewrite_proxy_vsix_platform(&url, "win32-x64");
        let upstream_url = decoded_proxy_target(&rewritten);
        let segments = upstream_url
            .path_segments()
            .expect("path segments")
            .collect::<Vec<_>>();

        assert_eq!(segments[3], "win32-x64");
        assert_eq!(segments[6], "kilocode.kilo-code-7.7.6@win32-x64.vsix");
    }

    #[test]
    fn leaves_matching_or_malformed_proxy_urls_unchanged() {
        let matching = proxy_url("win32-x64");
        assert_eq!(
            rewrite_proxy_vsix_platform(&matching, "win32-x64"),
            matching
        );

        let malformed =
            "https://marketplace.siden.ai/api/asset/openvsx/vsix-not-base64/VSIXPackage";
        assert_eq!(
            rewrite_proxy_vsix_platform(malformed, "win32-x64"),
            malformed
        );
    }

    #[test]
    fn does_not_rewrite_urls_without_matching_platform_path_and_filename() {
        let inner = "https://open-vsx.org/api/kilocode/kilo-code/linux-x64/7.7.6/file/kilocode.kilo-code-7.7.6@alpine-arm64.vsix";
        let encoded = URL_SAFE_NO_PAD.encode(inner);
        let url =
            format!("https://marketplace.siden.ai/api/asset/openvsx/vsix-{encoded}/VSIXPackage");

        assert_eq!(rewrite_proxy_vsix_platform(&url, "win32-x64"), url);
    }

    #[test]
    fn replaces_all_target_platform_query_values() {
        let rewritten = ensure_target_platform(
            "https://marketplace.siden.ai/api/download/openvsx/example?before=1&targetPlatform=linux-x64&targetPlatform=darwin-arm64#fragment",
        );
        let parsed = Url::parse(&rewritten).expect("URL");
        let query = parsed.query_pairs().collect::<Vec<_>>();

        assert_eq!(parsed.fragment(), Some("fragment"));
        assert_eq!(query[0], ("before".into(), "1".into()));
        assert_eq!(
            query[1],
            ("targetPlatform".into(), current_target_platform().into())
        );
        assert_eq!(query.len(), 2);
    }
}
