/// Filesystem requests execute in the selected Linux distribution. Paths are
/// transmitted as JSON, preserving binary files and Linux-specific filenames.
#[tauri::command]
pub async fn wsl_file_request(
    distro: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    sidex_remote::wsl::file_request(&distro, &request)
        .await
        .map_err(|error| error.to_string())
}
