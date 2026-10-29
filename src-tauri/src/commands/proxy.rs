use super::settings::SettingsStore;
use base64::Engine as _;
use serde::Serialize;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::State;

const MAX_RESPONSE_BYTES: usize = 50 * 1024 * 1024; // 50 MB
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

const ALLOWED_HOSTS: &[&str] = &[
    // SideX marketplace (Open VSX + Microsoft, via the siden.ai Worker)
    "marketplace.siden.ai",
    // Open VSX
    "open-vsx.org",
    "openvsx.eclipsecontent.org",
    // Microsoft Marketplace
    "marketplace.visualstudio.com",
    "az764295.vo.msecnd.net",
    "vscode-unpkg.net",
    "gallery.vsassets.io",
    "vsmarketplacebadges.dev",
    "vscode.blob.core.windows.net",
    // VS Code asset CDN (VSIX packages + icons)
    "vsassets.io",
    "openvsxorg.blob.core.windows.net",
    // GitHub (readme images, OAuth, API, codespaces, extension assets)
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
    // Updates
    "update.code.visualstudio.com",
];

fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed: reqwest::Url = url.parse().map_err(|_| "invalid URL".to_string())?;

    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("blocked scheme: {s}")),
    }

    let host = parsed.host_str().ok_or("missing host")?;

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("credentials in request URLs are not allowed".to_string());
    }
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return Err("requests to localhost are blocked".to_string());
    }
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        if ip.is_loopback() || ip.is_unspecified() {
            return Err("requests to loopback/unspecified addresses are blocked".to_string());
        }
        if let IpAddr::V4(v4) = ip {
            if v4.is_private() || v4.is_link_local() {
                return Err("requests to private/link-local addresses are blocked".to_string());
            }
            if v4.octets() == [169, 254, 169, 254] {
                return Err("requests to metadata endpoints are blocked".to_string());
            }
        }
        if let IpAddr::V6(v6) = ip {
            if v6.is_unique_local() || v6.is_unicast_link_local() {
                return Err("requests to private/link-local addresses are blocked".to_string());
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                if v4.is_private() || v4.is_link_local() || v4.is_loopback() || v4.is_unspecified()
                {
                    return Err("requests to private/loopback addresses are blocked".to_string());
                }
            }
        }
    }

    Ok(parsed)
}

/// Checks if a URL's host is allowed to be proxied.
///
/// # Security
///
/// The allowlist comparison is case-insensitive to prevent bypass attacks
/// where an attacker uses mixed-case hostnames (e.g., "OpenVSX.org" vs "openvsx.org").
///
/// Also prevents subdomain takeover attacks by ensuring the host is either:
/// - An exact match for an allowed host
/// - A proper subdomain (e.g., "extension.openvsx.org" matches "openvsx.org")
fn is_host_allowed(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    // SECURITY: Normalize to lowercase for case-insensitive comparison
    // Prevents bypass via case variation (e.g., "OpenVSX.org" vs "openvsx.org")
    let host = host.to_ascii_lowercase();

    for allowed in ALLOWED_HOSTS {
        let allowed = allowed.to_ascii_lowercase();
        if host == allowed {
            return true;
        }
        // Check if host is a subdomain of allowed
        // e.g., "ext.openvsx.org" ends with ".openvsx.org"
        if host.ends_with(&format!(".{allowed}")) {
            return true;
        }
    }
    false
}

/// Only the user's application settings can authorize an additional gallery origin.
/// Workspace files and subdomains of a custom registry never grant proxy access.
fn is_configured_gallery_allowed(url: &reqwest::Url, user: &serde_json::Value) -> bool {
    let configured = user
        .get("sidex.extensions.galleryUrl")
        .and_then(serde_json::Value::as_str);
    let origins = user
        .get("sidex.extensions.allowedGalleryOrigins")
        .and_then(serde_json::Value::as_array);
    configured
        .into_iter()
        .chain(
            origins
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str),
        )
        .any(|value| {
            let Ok(allowed) = reqwest::Url::parse(value) else {
                return false;
            };
            allowed.scheme() == "https"
                && allowed.username().is_empty()
                && allowed.password().is_none()
                && allowed.query().is_none()
                && allowed.fragment().is_none()
                && allowed.origin() == url.origin()
        })
}

fn is_proxy_allowed(url: &reqwest::Url, settings: &SettingsStore) -> bool {
    if is_host_allowed(url) {
        return true;
    }
    settings
        .inner
        .read()
        .is_ok_and(|settings| is_configured_gallery_allowed(url, settings.user_layer()))
}

/// Process-wide shared HTTP client. One client = one connection pool
/// shared across all proxy requests. This eliminates the per-request
/// TCP + TLS handshake overhead that was causing 8-10 s cold requests.
static PROXY_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn get_client() -> Result<&'static reqwest::Client, String> {
    PROXY_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .connect_timeout(Duration::from_secs(5))
                .tcp_keepalive(Some(Duration::from_mins(1)))
                .pool_idle_timeout(Some(Duration::from_secs(90)))
                .pool_max_idle_per_host(8)
                .http2_keep_alive_interval(Some(Duration::from_secs(30)))
                .http2_keep_alive_timeout(Duration::from_secs(10))
                .http2_keep_alive_while_idle(true)
                .http2_adaptive_window(true)
                .gzip(true)
                .brotli(true)
                // Each redirect is checked against the same policy as the initial URL.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| format!("HTTP client initialization failed: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

async fn read_body_limited(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if let Some(len) = response.content_length() {
        if len > MAX_RESPONSE_BYTES as u64 {
            return Err(format!("response too large: {len} bytes"));
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("read failed: {e}"))?
    {
        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
            return Err("response too large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn checked_redirect(
    current: &reqwest::Url,
    location: &str,
    allowed: impl Fn(&reqwest::Url) -> bool,
) -> Result<reqwest::Url, String> {
    let next = current
        .join(location)
        .map_err(|e| format!("invalid redirect: {e}"))?;
    let next = validate_url(next.as_str())?;
    if !allowed(&next) {
        return Err(format!(
            "redirect to '{}' is not allowed",
            next.origin().ascii_serialization()
        ));
    }
    Ok(next)
}

fn redirect_request(
    status: reqwest::StatusCode,
    current: &reqwest::Url,
    next: &reqwest::Url,
    method: &mut reqwest::Method,
    headers: &mut HashMap<String, String>,
    body: &mut Option<String>,
) {
    if current.origin() != next.origin() {
        headers.retain(|key, _| {
            !matches!(
                key.to_ascii_lowercase().as_str(),
                "authorization" | "proxy-authorization" | "cookie" | "cookie2" | "host"
            )
        });
    }
    if (matches!(status.as_u16(), 301 | 302) && *method == reqwest::Method::POST)
        || (status == reqwest::StatusCode::SEE_OTHER && *method != reqwest::Method::HEAD)
    {
        *method = reqwest::Method::GET;
        *body = None;
        headers.retain(|key, _| {
            !matches!(
                key.to_ascii_lowercase().as_str(),
                "content-type" | "content-length" | "transfer-encoding"
            )
        });
    }
}

async fn send_request(
    url: &str,
    method: &str,
    mut headers: HashMap<String, String>,
    mut body: Option<String>,
    settings: Option<&SettingsStore>,
) -> Result<reqwest::Response, String> {
    let mut current = validate_url(url)?;
    let allowed =
        |url: &reqwest::Url| settings.is_none_or(|settings| is_proxy_allowed(url, settings));
    if !allowed(&current) {
        return Err(format!(
            "proxy requests to '{}' are not allowed",
            current.origin().ascii_serialization()
        ));
    }
    let mut method = reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes())
        .map_err(|e| format!("invalid HTTP method: {e}"))?;
    let client = get_client()?;
    for hop in 0..=5 {
        let mut request = client.request(method.clone(), current.clone());
        for (key, value) in &headers {
            if !key.eq_ignore_ascii_case("accept-encoding") && !key.eq_ignore_ascii_case("host") {
                request = request.header(key.as_str(), value.as_str());
            }
        }
        if let Some(body) = &body {
            request = request.body(body.clone());
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Ok(response);
        }
        let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
            return Ok(response);
        };
        if hop == 5 {
            return Err("too many HTTP redirects".to_string());
        }
        let next = checked_redirect(
            &current,
            location
                .to_str()
                .map_err(|e| format!("invalid redirect: {e}"))?,
            allowed,
        )?;
        redirect_request(
            response.status(),
            &current,
            &next,
            &mut method,
            &mut headers,
            &mut body,
        );
        current = next;
    }
    unreachable!("redirect limit is handled above")
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn fetch_url(url: String) -> Result<Vec<u8>, String> {
    let response = send_request(&url, "GET", HashMap::new(), None, None).await?;
    read_body_limited(response).await
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn fetch_url_text(url: String) -> Result<String, String> {
    let response = send_request(&url, "GET", HashMap::new(), None, None).await?;
    let bytes = read_body_limited(response).await?;
    String::from_utf8(bytes).map_err(|e| format!("invalid UTF-8: {e}"))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn proxy_request(
    state: State<'_, Arc<SettingsStore>>,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    let response = send_request(&url, &method, headers, body, Some(&state)).await?;

    let bytes = read_body_limited(response).await?;
    String::from_utf8(bytes).map_err(|e| format!("invalid UTF-8 in proxy response: {e}"))
}

#[derive(Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_b64: String,
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn proxy_request_full(
    state: State<'_, Arc<SettingsStore>>,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<ProxyResponse, String> {
    let response = send_request(&url, &method, headers, body, Some(&state)).await?;

    let status = response.status().as_u16();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in response.headers() {
        if let Ok(v_str) = v.to_str() {
            resp_headers.insert(k.to_string(), v_str.to_string());
        }
    }

    let bytes = read_body_limited(response).await?;
    let body_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(ProxyResponse {
        status,
        headers: resp_headers,
        body_b64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_policy_checks_every_destination_including_private_ipv6() {
        let current = reqwest::Url::parse("https://open-vsx.org/api/example").unwrap();
        assert_eq!(
            checked_redirect(&current, "/asset.vsix", is_host_allowed)
                .unwrap()
                .as_str(),
            "https://open-vsx.org/asset.vsix"
        );
        for location in [
            "https://other.invalid/package",
            "http://127.0.0.1/admin",
            "http://localhost/admin",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
            "file:///etc/passwd",
            "https://user:secret@open-vsx.org/",
        ] {
            assert!(
                checked_redirect(&current, location, is_host_allowed).is_err(),
                "{location}"
            );
        }
        let user = serde_json::json!({"sidex.extensions.galleryUrl": "https://custom.example/vscode/gallery"});
        assert!(
            checked_redirect(&current, "https://custom.example/package", |url| {
                is_configured_gallery_allowed(url, &user)
            })
            .is_ok()
        );
        assert!(
            checked_redirect(&current, "https://cdn.custom.example/package", |url| {
                is_configured_gallery_allowed(url, &user)
            })
            .is_err()
        );
    }

    #[test]
    fn redirect_methods_and_credentials_follow_http_semantics() {
        let current = reqwest::Url::parse("https://open-vsx.org/query").unwrap();
        let next = reqwest::Url::parse("https://openvsx.eclipsecontent.org/asset").unwrap();
        let mut method = reqwest::Method::POST;
        let mut headers = HashMap::from([
            ("Authorization".to_string(), "secret".to_string()),
            ("Cookie".to_string(), "session".to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Accept".to_string(), "application/json".to_string()),
        ]);
        let mut body = Some("{}".to_string());
        redirect_request(
            reqwest::StatusCode::TEMPORARY_REDIRECT,
            &current,
            &current,
            &mut method,
            &mut headers,
            &mut body,
        );
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(body.as_deref(), Some("{}"));
        assert!(headers.contains_key("Authorization"));
        redirect_request(
            reqwest::StatusCode::FOUND,
            &current,
            &next,
            &mut method,
            &mut headers,
            &mut body,
        );
        assert_eq!(method, reqwest::Method::GET);
        assert!(body.is_none());
        assert_eq!(
            headers,
            HashMap::from([("Accept".to_string(), "application/json".to_string())])
        );
    }

    #[test]
    fn custom_registry_permissions_match_exact_origins() {
        let user = serde_json::json!({
            "sidex.extensions.galleryUrl": "https://registry.example:8443/vscode/gallery",
            "sidex.extensions.allowedGalleryOrigins": ["https://assets.example"]
        });
        for value in [
            "https://registry.example:8443/extensionquery",
            "https://assets.example/icon.png",
        ] {
            assert!(is_configured_gallery_allowed(
                &value.parse().unwrap(),
                &user
            ));
        }
        for value in [
            "https://registry.example/extensionquery",
            "https://other.registry.example:8443/",
            "http://assets.example/icon.png",
            "https://assets.example.evil.invalid/",
        ] {
            assert!(!is_configured_gallery_allowed(
                &value.parse().unwrap(),
                &user
            ));
        }
    }

    #[test]
    fn malformed_or_credential_bearing_registry_settings_grant_no_access() {
        let url = reqwest::Url::parse("https://registry.example/").unwrap();
        for value in [
            "https://user@registry.example/",
            "https://registry.example/?secret=1",
            "ftp://registry.example/",
            "not a url",
        ] {
            let user = serde_json::json!({ "sidex.extensions.galleryUrl": value });
            assert!(!is_configured_gallery_allowed(&url, &user));
        }
    }
}
