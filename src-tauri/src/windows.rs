use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures_util::StreamExt;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

const USER_AGENT: &str = "NontHub/3.0.1";

fn hide_console_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[derive(Default)]
struct DownloadState {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Default)]
struct ProfileState {
    write_lock: tokio::sync::Mutex<()>,
}


#[derive(Clone, Serialize)]
struct DownloadProgress {
    id: String,
    received_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<f64>,
    status: String,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Clone, Deserialize)]
struct GithubAsset {
    id: u64,
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Clone, Deserialize)]
struct GithubOwner {
    login: String,
}

#[derive(Clone, Deserialize)]
struct GithubRepoMetadata {
    name: String,
    full_name: String,
    description: Option<String>,
    html_url: String,
    default_branch: String,
    owner: GithubOwner,
    #[serde(default)]
    topics: Vec<String>,
}

#[derive(Clone, Serialize)]
struct GithubRepositoryInfo {
    repository: String,
    name: String,
    full_name: String,
    description: Option<String>,
    html_url: String,
    owner: String,
    default_branch: String,
    topics: Vec<String>,
    latest_release_tag: Option<String>,
    latest_release_name: Option<String>,
    latest_version: Option<String>,
}

#[derive(Deserialize)]
struct GithubTree {
    #[serde(default)]
    tree: Vec<GithubTreeItem>,
}

#[derive(Deserialize)]
struct GithubTreeItem {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ResolvedAsset {
    name: String,
    download_url: String,
    version: String,
    tag_name: String,
    release_name: Option<String>,
    prerelease: bool,
    package_type: String,
    asset_id: u64,
    asset_size: u64,
    asset_updated_at: Option<String>,
    asset_digest: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct InstalledAppInfo {
    app_id: String,
    installed: bool,
    version: Option<String>,
    executable_path: Option<String>,
    #[serde(default)]
    asset_name: Option<String>,
    #[serde(default)]
    package_type: Option<String>,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    release_tag: Option<String>,
    #[serde(default)]
    asset_id: Option<u64>,
    #[serde(default)]
    asset_digest: Option<String>,
    #[serde(default)]
    asset_updated_at: Option<String>,
}


fn safe_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect();

    let trimmed = sanitized.trim().trim_matches(|c| c == '.' || c == ' ');
    let mut safe = if trimmed.is_empty() { "download.bin".to_string() } else { trimmed.to_string() };

    let stem = Path::new(&safe)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim_end_matches(|c| c == '.' || c == ' ')
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" |
        "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" |
        "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    );
    if reserved { safe.insert(0, '_'); }

    // Keep filenames comfortably below legacy Windows path-component limits.
    if safe.chars().count() > 180 {
        let path = Path::new(&safe);
        let ext = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_string();
        let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("download").to_string();
        let ext_len = if ext.is_empty() { 0 } else { ext.chars().count() + 1 };
        let keep = 180usize.saturating_sub(ext_len);
        let shortened: String = stem.chars().take(keep).collect();
        safe = if ext.is_empty() { shortened } else { format!("{shortened}.{ext}") };
    }
    safe
}

fn safe_identifier(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 96 {
        return Err("Invalid identifier".into());
    }
    if value.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.') {
        Ok(value.to_string())
    } else {
        Err("Identifier contains unsupported characters".into())
    }
}

fn validate_repository(repository: &str) -> Result<(), String> {
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return Err("Repository must look like owner/repo".into());
    }
    if !owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || !repo.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("Repository contains unsupported characters".into());
    }
    Ok(())
}

fn normalize_extensions(extensions: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    extensions
        .iter()
        .filter_map(|value| {
            let mut ext = value.trim().to_ascii_lowercase();
            if ext.is_empty() { return None; }
            if !ext.starts_with('.') { ext.insert(0, '.'); }
            if seen.insert(ext.clone()) { Some(ext) } else { None }
        })
        .collect()
}

fn package_type_from_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for (suffix, kind) in [(".exe", "exe"), (".msi", "msi"), (".zip", "zip"), (".7z", "7z")] {
        if lower.ends_with(suffix) { return kind.into(); }
    }
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "file".into())
}

fn is_windows_installer_asset(name: &str, package_type: &str) -> bool {
    if package_type.eq_ignore_ascii_case("msi") { return true; }
    if !package_type.eq_ignore_ascii_case("exe") { return false; }
    let lower = name.to_ascii_lowercase();
    ["setup", "installer", "install-", "install_", "-install", "_install", "nsis"]
        .iter()
        .any(|token| lower.contains(token))
}

fn extract_numeric_version(value: &str) -> Option<String> {
    let mut best: Option<String> = None;
    let mut current = String::new();
    for ch in value.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() || ch == '.' {
            current.push(ch);
        } else if !current.is_empty() {
            let token = current.trim_matches('.').to_string();
            if token.chars().any(|c| c.is_ascii_digit()) {
                let better = best.as_ref().map(|old| token.matches('.').count() > old.matches('.').count()).unwrap_or(true);
                if better { best = Some(token); }
            }
            current.clear();
        }
    }
    best
}

fn release_version(release: &GithubRelease) -> String {
    release
        .name
        .as_deref()
        .and_then(extract_numeric_version)
        .or_else(|| extract_numeric_version(&release.tag_name))
        .unwrap_or_else(|| release.tag_name.clone())
}

fn architecture_compatible(asset_name: &str) -> bool {
    let lower = asset_name.to_ascii_lowercase();
    let arm64_tokens = ["arm64", "aarch64", "armv8"];
    let x64_tokens = ["x86_64", "x86-64", "x64", "amd64", "win64"];
    // Do not use a bare "x86" token here: it is also a substring of "x86_64".
    let x86_32_tokens = ["i386", "i486", "i586", "i686", "ia32", "x86-32", "x86_32", "win32-x86", "win32-ia32"];

    let has_arm64 = arm64_tokens.iter().any(|token| lower.contains(token));
    let has_x64 = x64_tokens.iter().any(|token| lower.contains(token));
    let has_x86_32 = x86_32_tokens.iter().any(|token| lower.contains(token));

    match std::env::consts::ARCH {
        "x86_64" => !has_arm64 && !has_x86_32,
        "aarch64" => !has_x64 && !has_x86_32,
        "x86" => !has_arm64 && !has_x64,
        _ => true,
    }
}

fn architecture_score(asset_name: &str) -> i32 {
    let lower = asset_name.to_ascii_lowercase();
    match std::env::consts::ARCH {
        "x86_64" if ["x86_64", "x86-64", "x64", "amd64", "win64"].iter().any(|t| lower.contains(t)) => 25,
        "aarch64" if ["arm64", "aarch64", "armv8"].iter().any(|t| lower.contains(t)) => 25,
        "x86" if ["i386", "i486", "i586", "i686", "ia32", "x86-32", "x86_32", "win32-x86", "win32-ia32"].iter().any(|t| lower.contains(t)) => 25,
        _ => 0,
    }
}

fn choose_asset(release: &GithubRelease, extensions: &[String], repository: &str, preferred_asset_name: Option<&str>) -> Option<GithubAsset> {
    let repo_name = repository.split('/').nth(1).unwrap_or_default().trim_end_matches(".exe").to_ascii_lowercase();
    let preferred_lower = preferred_asset_name.map(|name| name.to_ascii_lowercase());
    let preferred_stem = preferred_asset_name
        .and_then(|name| Path::new(name).file_stem().and_then(|value| value.to_str()))
        .map(|value| value.to_ascii_lowercase());
    let mut best: Option<(i32, GithubAsset)> = None;

    for asset in &release.assets {
        let lower = asset.name.to_ascii_lowercase();
        if !architecture_compatible(&lower) { continue; }

        for (index, ext) in extensions.iter().enumerate() {
            if !lower.ends_with(ext) { continue; }
            let mut score = 1000 - (index as i32 * 100);
            score += architecture_score(&lower);
            if !repo_name.is_empty() && lower.contains(&repo_name) { score += 10; }

            // For NontHub itself, prefer a real installer over a portable/runtime executable.
            // Tauri NSIS assets normally contain words like setup/installer; MSI is always an installer.
            if repository.eq_ignore_ascii_case("voidnont/NontHub") {
                if lower.ends_with(".msi") { score += 220; }
                if ["setup", "installer", "install", "nsis"].iter().any(|token| lower.contains(token)) { score += 180; }
                if lower.contains("portable") { score -= 120; }
            }
            if preferred_lower.as_deref() == Some(lower.as_str()) { score += 120; }
            if let Some(stem) = &preferred_stem {
                let candidate_stem = Path::new(&asset.name).file_stem().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
                if !stem.is_empty() && candidate_stem.starts_with(stem) { score += 55; }
            }
            if lower.contains("source") || lower.contains("symbols") || lower.contains("debug") { score -= 80; }
            if lower.contains("portable") { score += 3; }
            if best.as_ref().map(|(old, _)| score > *old).unwrap_or(true) {
                best = Some((score, asset.clone()));
            }
            break;
        }
    }

    best.map(|(_, asset)| asset)
}

async fn github_latest_asset(repository: &str, extensions: &[String], preferred_asset_name: Option<&str>) -> Result<ResolvedAsset, String> {
    validate_repository(repository)?;
    let extensions = normalize_extensions(extensions);
    if extensions.is_empty() {
        return Err("At least one package extension is required".into());
    }

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    // Use the releases collection instead of only /releases/latest. GitHub's
    // latest endpoint intentionally ignores prereleases, which caused NONT's
    // prerelease-only build to return 404 even though nont.exe existed.
    let url = format!("https://api.github.com/repos/{repository}/releases?per_page=30");
    let response = client.get(url).send().await.map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub returned HTTP {}", response.status()));
    }

    let releases: Vec<GithubRelease> = response.json().await.map_err(|e| format!("Could not read GitHub releases: {e}"))?;
    let published: Vec<&GithubRelease> = releases.iter().filter(|release| !release.draft).collect();
    if published.is_empty() {
        return Err("No published GitHub Releases were found for this repository".into());
    }

    let mut available = Vec::new();
    for release in published {
        available.extend(release.assets.iter().map(|asset| asset.name.clone()));
        if let Some(asset) = choose_asset(release, &extensions, repository, preferred_asset_name) {
            return Ok(ResolvedAsset {
                name: asset.name.clone(),
                download_url: asset.browser_download_url,
                version: release_version(release),
                tag_name: release.tag_name.clone(),
                release_name: release.name.clone(),
                prerelease: release.prerelease,
                package_type: package_type_from_name(&asset.name),
                asset_id: asset.id,
                asset_size: asset.size,
                asset_updated_at: asset.updated_at.clone(),
                asset_digest: asset.digest.clone(),
            });
        }
    }

    available.sort();
    available.dedup();
    let shown = available.into_iter().take(12).collect::<Vec<_>>().join(", ");
    Err(format!(
        "No compatible release asset matched {} on {} / {}. Available assets: {}",
        extensions.join(", "),
        std::env::consts::OS,
        std::env::consts::ARCH,
        if shown.is_empty() { "none".into() } else { shown }
    ))
}

#[tauri::command]
async fn get_github_repository_info(repository: String) -> Result<GithubRepositoryInfo, String> {
    validate_repository(&repository)?;
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let meta_url = format!("https://api.github.com/repos/{repository}");
    let response = client.get(meta_url).send().await.map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub returned HTTP {} for {repository}", response.status()));
    }
    let meta: GithubRepoMetadata = response.json().await.map_err(|e| format!("Could not read GitHub repository metadata: {e}"))?;

    let release_url = format!("https://api.github.com/repos/{repository}/releases?per_page=20");
    let release_response = client.get(release_url).send().await.map_err(|e| format!("Could not read GitHub releases: {e}"))?;
    let latest_release = if release_response.status().is_success() {
        let releases: Vec<GithubRelease> = release_response.json().await.map_err(|e| format!("Could not read GitHub releases: {e}"))?;
        releases.into_iter().find(|release| !release.draft)
    } else {
        None
    };

    Ok(GithubRepositoryInfo {
        repository: meta.full_name.clone(),
        name: meta.name,
        full_name: meta.full_name,
        description: meta.description,
        html_url: meta.html_url,
        owner: meta.owner.login,
        default_branch: meta.default_branch,
        topics: meta.topics,
        latest_release_tag: latest_release.as_ref().map(|release| release.tag_name.clone()),
        latest_release_name: latest_release.as_ref().and_then(|release| release.name.clone()),
        latest_version: latest_release.as_ref().map(release_version),
    })
}

#[tauri::command]
async fn resolve_github_release(repository: String, extensions: Vec<String>, preferred_asset_name: Option<String>) -> Result<ResolvedAsset, String> {
    github_latest_asset(&repository, &extensions, preferred_asset_name.as_deref()).await
}

#[tauri::command]
async fn list_github_release_assets(repository: String) -> Result<Vec<ResolvedAsset>, String> {
    validate_repository(&repository)?;
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://api.github.com/repos/{repository}/releases?per_page=30");
    let response = client.get(url).send().await.map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub returned HTTP {}", response.status()));
    }
    let releases: Vec<GithubRelease> = response.json().await.map_err(|e| format!("Could not read GitHub releases: {e}"))?;
    let release = releases.into_iter().find(|release| !release.draft && !release.assets.is_empty())
        .ok_or("No published GitHub Release with downloadable assets was found")?;
    let version = release_version(&release);
    let tag_name = release.tag_name.clone();
    let release_name = release.name.clone();
    let prerelease = release.prerelease;
    let mut assets = release.assets.into_iter().map(|asset| ResolvedAsset {
        name: asset.name.clone(),
        download_url: asset.browser_download_url,
        version: version.clone(),
        tag_name: tag_name.clone(),
        release_name: release_name.clone(),
        prerelease,
        package_type: package_type_from_name(&asset.name),
        asset_id: asset.id,
        asset_size: asset.size,
        asset_updated_at: asset.updated_at,
        asset_digest: asset.digest,
    }).collect::<Vec<_>>();
    assets.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    Ok(assets)
}

fn icon_score(path: &str, repository: &str) -> i32 {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let file = Path::new(&lower).file_name().and_then(|v| v.to_str()).unwrap_or("");
    let stem = Path::new(file).file_stem().and_then(|v| v.to_str()).unwrap_or("");
    let supported = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"];
    if !supported.iter().any(|ext| lower.ends_with(ext)) { return -10_000; }

    let reject = [
        "screenshot", "screen-shot", "screenshots/", "banner", "splash", "background",
        "wallpaper", "mockup", "preview", "cover", "hero", "social", "og-image", "og_image",
        "twitter", "thumbnail", "thumb", "sponsor", "badge", "button", "qr", "diagram",
    ];
    if reject.iter().any(|token| lower.contains(token)) { return -700; }

    let repo_name = repository.split('/').nth(1).unwrap_or_default().to_ascii_lowercase();
    let compact_repo = repo_name.chars().filter(|ch| !matches!(ch, '-' | '_' | '.')).collect::<String>();
    let compact_stem = stem.chars().filter(|ch| !matches!(ch, '-' | '_' | '.' | ' ')).collect::<String>();
    let mut score = 0;

    if lower.contains("src-tauri/icons/") { score += 390; }
    if lower.contains("/mipmap-") && (file.contains("launcher") || file.contains("icon")) { score += 360; }
    if lower.contains("/branding/") || lower.contains("/brand/") { score += 210; }
    if lower.contains("/appicon") || lower.contains("/app-icon") || lower.contains("/app_icon") { score += 230; }
    if lower.contains("/icons/") || lower.contains("/icon/") { score += 190; }
    if lower.contains("/resources/") { score += 95; }
    if lower.contains("/assets/") { score += 70; }
    if lower.contains("/public/") || lower.starts_with("public/") { score += 40; }

    match file {
        "icon.png" | "icon.webp" | "icon.svg" | "icon.ico" => score += 420,
        "app-icon.png" | "app_icon.png" | "appicon.png" | "app-icon.webp" | "appicon.svg" => score += 410,
        "logo.png" | "logo.webp" | "logo.svg" => score += 270,
        "ic_launcher.png" | "ic_launcher.webp" | "ic_launcher_round.png" | "ic_launcher_foreground.png" => score += 390,
        "favicon.png" | "favicon.ico" | "favicon.svg" => score += 55,
        _ => {}
    }

    if file.contains("launcher") && (file.contains("icon") || file.starts_with("ic_")) { score += 300; }
    if file.contains("app") && file.contains("icon") { score += 280; }
    if file.contains("application") && file.contains("icon") { score += 260; }
    if file.contains("brand") && (file.contains("mark") || file.contains("icon")) { score += 250; }
    if file.contains("logo") { score += 220; }
    if file.contains("icon") { score += 165; }
    if file.contains("mark") { score += 100; }

    if !repo_name.is_empty() && file.contains(&repo_name) { score += 180; }
    if !compact_repo.is_empty() && compact_stem.contains(&compact_repo) { score += 150; }

    if file.contains("dark") || file.contains("light") { score += 15; }
    if file.contains("mono") || file.contains("maskable") { score += 10; }
    if file.contains("favicon") { score -= 90; }
    if file.contains("16x16") || file.contains("24x24") || file.contains("32x32") { score -= 75; }

    if lower.ends_with(".png") || lower.ends_with(".webp") { score += 50; }
    if lower.ends_with(".svg") { score += 45; }
    if lower.ends_with(".ico") { score += 30; }
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { score -= 25; }

    let depth = lower.matches('/').count();
    if depth <= 4 { score += 20; }
    score
}

fn explicit_icon_hint_score(path: &str, hints: &[String]) -> i32 {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let file = Path::new(&lower).file_name().and_then(|v| v.to_str()).unwrap_or("");
    let stem = Path::new(file).file_stem().and_then(|v| v.to_str()).unwrap_or("");
    let mut score = 0;
    for hint in hints {
        let normalized = hint.replace('\\', "/").trim_start_matches("./").to_ascii_lowercase();
        if normalized.is_empty() { continue; }
        if lower == normalized || lower.ends_with(&format!("/{normalized}")) { score += 900; continue; }
        let hint_file = Path::new(&normalized).file_name().and_then(|v| v.to_str()).unwrap_or("");
        let hint_stem = Path::new(hint_file).file_stem().and_then(|v| v.to_str()).unwrap_or("");
        if !hint_file.is_empty() && file == hint_file { score += 500; }
        if hint_stem.len() >= 3 && stem == hint_stem { score += 340; }
        if normalized.contains("mipmap") && lower.contains("/mipmap-") && stem == hint_stem { score += 420; }
    }
    score
}

fn collect_json_icon_hints(value: &serde_json::Value, key: Option<&str>, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (next_key, next_value) in map {
                collect_json_icon_hints(next_value, Some(next_key), out);
            }
        }
        serde_json::Value::Array(values) => {
            for item in values { collect_json_icon_hints(item, key, out); }
        }
        serde_json::Value::String(value) => {
            let lower_key = key.unwrap_or_default().to_ascii_lowercase();
            let lower_value = value.to_ascii_lowercase();
            let image_like = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"].iter().any(|ext| lower_value.contains(ext));
            if (lower_key.contains("icon") || lower_key.contains("logo") || lower_key.contains("image") || lower_key == "src") && image_like {
                out.push(value.clone());
            }
        }
        _ => {}
    }
}

fn text_icon_hints(path: &str, text: &str) -> Vec<String> {
    let lower_path = path.to_ascii_lowercase();
    let mut hints = Vec::new();
    if lower_path.ends_with(".json") {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
            collect_json_icon_hints(&value, None, &mut hints);
        }
    }
    hints
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" { return None; }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    if width == 0 || height == 0 { None } else { Some((width, height)) }
}

fn ico_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 8 || &bytes[..4] != b"\x00\x00\x01\x00" { return None; }
    let width = if bytes[6] == 0 { 256 } else { bytes[6] as u32 };
    let height = if bytes[7] == 0 { 256 } else { bytes[7] as u32 };
    Some((width, height))
}

fn svg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let lower = text.to_ascii_lowercase();
    if !lower.contains("<svg") { return None; }
    if let Some(index) = lower.find("viewbox=") {
        let rest = &lower[index + 8..];
        let quote = rest.chars().next()?;
        if quote == '\'' || quote == '"' {
            let rest = &rest[quote.len_utf8()..];
            if let Some(end) = rest.find(quote) {
                let numbers = rest[..end].split(|c: char| c.is_whitespace() || c == ',')
                    .filter_map(|part| part.parse::<f64>().ok()).collect::<Vec<_>>();
                if numbers.len() >= 4 && numbers[2] > 0.0 && numbers[3] > 0.0 {
                    return Some((numbers[2].round() as u32, numbers[3].round() as u32));
                }
            }
        }
    }
    None
}

fn artwork_shape_score(path: &str, bytes: &[u8]) -> i32 {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".svg") && svg_dimensions(bytes).is_none() { return 70; }
    let dimensions = if lower.ends_with(".png") { png_dimensions(bytes) }
        else if lower.ends_with(".ico") { ico_dimensions(bytes) }
        else if lower.ends_with(".svg") { svg_dimensions(bytes) }
        else { None };
    let Some((width, height)) = dimensions else { return 0; };
    let min_side = width.min(height) as f64;
    let max_side = width.max(height) as f64;
    if min_side <= 0.0 { return -300; }
    let ratio = max_side / min_side;
    let mut score = if ratio <= 1.03 { 180 } else if ratio <= 1.15 { 135 } else if ratio <= 1.35 { 55 } else if ratio >= 2.0 { -260 } else { -80 };
    let largest = width.max(height);
    score += match largest {
        0..=31 => -180,
        32..=63 => -80,
        64..=127 => 10,
        128..=255 => 55,
        256..=2048 => 95,
        _ => 35,
    };
    score
}

fn image_mime(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") { "image/png" }
    else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg" }
    else if lower.ends_with(".webp") { "image/webp" }
    else if lower.ends_with(".svg") { "image/svg+xml" }
    else if lower.ends_with(".ico") { "image/x-icon" }
    else { "application/octet-stream" }
}

fn bytes_to_data_url(path: &str, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", image_mime(path), BASE64_STANDARD.encode(bytes))
}

fn is_icon_metadata_file(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let file = Path::new(&lower).file_name().and_then(|v| v.to_str()).unwrap_or("");
    matches!(file,
        "tauri.conf.json" | "package.json" | "manifest.json" | "manifest.webmanifest" |
        "site.webmanifest"
    ) || (lower.contains("tauri") && lower.ends_with(".conf.json"))
}

async fn github_raw_file(
    client: &reqwest::Client,
    repository: &str,
    branch: &str,
    path: &str,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut parts = repository.split('/');
    let owner = parts.next().ok_or("Invalid repository")?;
    let repo = parts.next().ok_or("Invalid repository")?;
    let mut url = Url::parse("https://raw.githubusercontent.com").map_err(|e| e.to_string())?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| "Could not build repository file URL")?;
        segments.push(owner).push(repo).push(branch);
        for segment in path.split('/') { if !segment.is_empty() { segments.push(segment); } }
    }
    let response = client.get(url).send().await.map_err(|e| format!("Could not read repository file: {e}"))?;
    if !response.status().is_success() { return Ok(None); }
    if response.content_length().unwrap_or(0) > max_bytes as u64 { return Ok(None); }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > max_bytes { return Ok(None); }
    Ok(Some(bytes.to_vec()))
}

async fn github_source_icon(repository: &str) -> Result<Option<String>, String> {
    validate_repository(repository)?;
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(18))
        .build()
        .map_err(|e| e.to_string())?;

    let meta_url = format!("https://api.github.com/repos/{repository}");
    let meta_response = client.get(meta_url).send().await.map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if !meta_response.status().is_success() { return Ok(None); }
    let meta: GithubRepoMetadata = meta_response.json().await.map_err(|e| e.to_string())?;

    let tree_url = format!("https://api.github.com/repos/{repository}/git/trees/{}?recursive=1", meta.default_branch);
    let tree_response = client.get(tree_url).send().await.map_err(|e| format!("Could not read repository files: {e}"))?;
    if !tree_response.status().is_success() { return Ok(None); }
    let tree: GithubTree = tree_response.json().await.map_err(|e| e.to_string())?;

    let mut icon_hints = Vec::<String>::new();
    let metadata_files = tree.tree.iter()
        .filter(|item| item.kind == "blob" && item.size.unwrap_or(0) <= 300_000 && is_icon_metadata_file(&item.path))
        .map(|item| item.path.clone())
        .take(14)
        .collect::<Vec<_>>();

    for path in metadata_files {
        let Some(bytes) = github_raw_file(&client, repository, &meta.default_branch, &path, 300_000).await? else { continue; };
        let Ok(text) = std::str::from_utf8(&bytes) else { continue; };
        icon_hints.extend(text_icon_hints(&path, text));
        if icon_hints.len() > 80 { icon_hints.truncate(80); break; }
    }

    let mut candidates = tree.tree.into_iter()
        .filter(|item| item.kind == "blob" && item.size.unwrap_or(0) <= 2_500_000)
        .map(|item| {
            let mut score = icon_score(&item.path, repository) + explicit_icon_hint_score(&item.path, &icon_hints);
            let size = item.size.unwrap_or(0);
            if (2_000..=1_000_000).contains(&size) { score += 25; }
            if size > 1_800_000 { score -= 55; }
            (score, item.path)
        })
        .filter(|(score, _)| *score > 0)
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

    let mut best: Option<(i32, String, Vec<u8>)> = None;
    for (base_score, path) in candidates.into_iter().take(16) {
        let Some(bytes) = github_raw_file(&client, repository, &meta.default_branch, &path, 2_500_000).await? else { continue; };
        let final_score = base_score + artwork_shape_score(&path, &bytes);
        let replace = best.as_ref().map(|(score, _, _)| final_score > *score).unwrap_or(true);
        if replace { best = Some((final_score, path, bytes)); }
    }

    Ok(best.map(|(_, path, bytes)| bytes_to_data_url(&path, &bytes)))
}

fn installed_windows_icon(app: &tauri::AppHandle, app_id: &str) -> Result<Option<String>, String> {
    let manifest = app_manifest_path(app, app_id)?;
    if !manifest.exists() { return Ok(None); }
    let content = std::fs::read(&manifest).map_err(|e| e.to_string())?;
    let info: InstalledAppInfo = serde_json::from_slice(&content).map_err(|e| e.to_string())?;
    let executable = match info.executable_path { Some(path) => PathBuf::from(path), None => return Ok(None) };
    if !executable.exists() || executable.extension().and_then(|v| v.to_str()).map(|v| !v.eq_ignore_ascii_case("exe")).unwrap_or(true) { return Ok(None); }

    let cache = app_dir(app, app_id)?.join(".nonthub-app-icon.png");
    if !cache.exists() {
        let exe_q = executable.to_string_lossy().replace('\'', "''");
        let out_q = cache.to_string_lossy().replace('\'', "''");
        let script = format!(r#"
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon('{exe_q}')
if ($null -eq $icon) {{ exit 2 }}
$bmp = $icon.ToBitmap()
$bmp.Save('{out_q}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$icon.Dispose()
"#);
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", &script]);
        command.creation_flags(CREATE_NO_WINDOW);
        let status = command.status().map_err(|e| format!("Could not extract app icon: {e}"))?;
        if !status.success() || !cache.exists() { return Ok(None); }
    }
    let bytes = std::fs::read(&cache).map_err(|e| e.to_string())?;
    Ok(Some(bytes_to_data_url("icon.png", &bytes)))
}


#[tauri::command]
async fn resolve_repository_icon(app: tauri::AppHandle, repository: String, app_id: Option<String>) -> Result<Option<String>, String> {
    if let Some(icon) = github_source_icon(&repository).await? { return Ok(Some(icon)); }
    if let Some(id) = app_id.as_deref() {
        let safe = safe_identifier(id)?;
        if let Some(icon) = installed_windows_icon(&app, &safe)? { return Ok(Some(icon)); }
    }
    Ok(None)
}

fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() { return candidate; }

    let path = Path::new(filename);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("download");
    let extension = path.extension().and_then(|v| v.to_str());

    for index in 1..10_000 {
        let next_name = match extension {
            Some(ext) => format!("{} ({index}).{ext}", stem),
            None => format!("{} ({index})", stem),
        };
        let next = dir.join(next_name);
        if !next.exists() { return next; }
    }

    dir.join(format!("{}-{}", filename, std::process::id()))
}

fn nonthub_profile_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = dirs::config_dir()
        .or_else(dirs::data_local_dir)
        .ok_or_else(|| "Could not find the NontHub configuration folder".to_string())?;
    Ok(root.join("NontHub"))
}

fn nonthub_profile_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(nonthub_profile_dir(app)?.join("profile.json"))
}

async fn read_profile_file(path: &Path) -> Result<serde_json::Value, String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| format!("Could not read NontHub profile: {e}"))?;
    if bytes.len() > 5_000_000 { return Err("NontHub profile is unexpectedly large".into()); }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("Could not parse NontHub profile: {e}"))?;
    if !value.is_object() { return Err("NontHub profile is invalid".into()); }
    Ok(value)
}

#[tauri::command]
async fn load_user_profile(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = nonthub_profile_path(&app)?;
    let backup = nonthub_profile_dir(&app)?.join("profile.json.bak");

    if path.exists() {
        match read_profile_file(&path).await {
            Ok(value) => return Ok(Some(value)),
            Err(primary_error) if backup.exists() => {
                if let Ok(value) = read_profile_file(&backup).await {
                    let _ = tokio::fs::copy(&backup, &path).await;
                    return Ok(Some(value));
                }
                return Err(primary_error);
            }
            Err(error) => return Err(error),
        }
    }

    if backup.exists() {
        let value = read_profile_file(&backup).await?;
        let _ = tokio::fs::copy(&backup, &path).await;
        return Ok(Some(value));
    }

    Ok(None)
}

#[tauri::command]
async fn save_user_profile(app: tauri::AppHandle, state: State<'_, ProfileState>, profile: serde_json::Value) -> Result<(), String> {
    let _guard = state.write_lock.lock().await;
    if !profile.is_object() { return Err("NontHub profile must be an object".into()); }
    let bytes = serde_json::to_vec_pretty(&profile).map_err(|e| e.to_string())?;
    if bytes.len() > 5_000_000 { return Err("NontHub profile is too large".into()); }

    let dir = nonthub_profile_dir(&app)?;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Could not create NontHub profile folder: {e}"))?;
    let path = nonthub_profile_path(&app)?;
    let temp = dir.join("profile.json.tmp");
    tokio::fs::write(&temp, &bytes).await.map_err(|e| format!("Could not write NontHub profile: {e}"))?;

    // On Windows rename does not replace an existing file. Keep a backup while
    // swapping so a power loss or interrupted update cannot silently reset NontHub.
    let backup = dir.join("profile.json.bak");
    if path.exists() {
        let _ = tokio::fs::remove_file(&backup).await;
        tokio::fs::rename(&path, &backup).await.map_err(|e| format!("Could not rotate NontHub profile: {e}"))?;
    }
    if let Err(error) = tokio::fs::rename(&temp, &path).await {
        if backup.exists() { let _ = tokio::fs::rename(&backup, &path).await; }
        return Err(format!("Could not activate NontHub profile: {error}"));
    }
    let _ = tokio::fs::remove_file(&backup).await;
    Ok(())
}

fn nonthub_apps_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = dirs::data_local_dir()
        .ok_or_else(|| "Could not find the NontHub application-data folder".to_string())?;
    Ok(root.join("NontHub").join("apps"))
}

fn app_dir(app: &tauri::AppHandle, app_id: &str) -> Result<PathBuf, String> {
    let id = safe_identifier(app_id)?;
    Ok(nonthub_apps_dir(app)?.join(id))
}

fn app_manifest_path(app: &tauri::AppHandle, app_id: &str) -> Result<PathBuf, String> {
    Ok(app_dir(app, app_id)?.join(".nonthub-app.json"))
}

fn download_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().download_dir().map_err(|e| format!("Could not find the Downloads folder: {e}"))
}


async fn download_to_path(
    app: &tauri::AppHandle,
    id: &str,
    url: &str,
    final_path: &Path,
    cancellation: &Arc<AtomicBool>,
) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("Only HTTPS downloads are supported".into());
    }

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed with HTTP {}", response.status()));
    }

    let total = response.content_length();
    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }

    let part_path = final_path.with_extension(format!(
        "{}part",
        final_path.extension().and_then(|x| x.to_str()).map(|x| format!("{x}.")).unwrap_or_default()
    ));
    let mut file = tokio::fs::File::create(&part_path).await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut received = 0u64;

    while let Some(next) = stream.next().await {
        if cancellation.load(Ordering::Relaxed) {
            let _ = tokio::fs::remove_file(&part_path).await;
            let _ = app.emit("download-progress", DownloadProgress {
                id: id.to_string(), received_bytes: received, total_bytes: total,
                percent: total.map(|t| received as f64 / t as f64 * 100.0), status: "cancelled".into(), path: None, error: None,
            });
            return Err("Download cancelled".into());
        }

        let chunk = match next {
            Ok(chunk) => chunk,
            Err(error) => {
                drop(file);
                let _ = tokio::fs::remove_file(&part_path).await;
                return Err(format!("Download interrupted: {error}"));
            }
        };
        if let Err(error) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(format!("Could not write download: {error}"));
        }
        received += chunk.len() as u64;
        let _ = app.emit("download-progress", DownloadProgress {
            id: id.to_string(), received_bytes: received, total_bytes: total,
            percent: total.map(|t| received as f64 / t as f64 * 100.0), status: "downloading".into(), path: None, error: None,
        });
    }

    if let Err(error) = file.flush().await {
        drop(file);
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(format!("Could not finish download: {error}"));
    }
    drop(file);

    // Never destroy a working install before the new file is fully downloaded.
    // On Windows an in-use EXE can be locked, so keep the old file until the final swap.
    let backup_path = final_path.with_extension(format!(
        "{}nonthub-old",
        final_path.extension().and_then(|x| x.to_str()).map(|x| format!("{x}.")).unwrap_or_default()
    ));
    if backup_path.exists() {
        let _ = tokio::fs::remove_file(&backup_path).await;
    }
    let had_existing = final_path.exists();
    if had_existing {
        tokio::fs::rename(final_path, &backup_path).await.map_err(|e| {
            format!(
                "The installed app is currently in use and could not be replaced ({e}). Close the app, then press Update again."
            )
        })?;
    }

    if let Err(error) = tokio::fs::rename(&part_path, final_path).await {
        if had_existing && backup_path.exists() {
            let _ = tokio::fs::rename(&backup_path, final_path).await;
        }
        return Err(format!("Could not activate the downloaded update: {error}"));
    }
    if had_existing && backup_path.exists() {
        let _ = tokio::fs::remove_file(&backup_path).await;
    }
    let final_string = final_path.to_string_lossy().to_string();

    let _ = app.emit("download-progress", DownloadProgress {
        id: id.to_string(), received_bytes: received, total_bytes: total, percent: Some(100.0),
        status: "complete".into(), path: Some(final_string.clone()), error: None,
    });
    Ok(final_string)
}

#[tauri::command]
async fn download_file(
    app: tauri::AppHandle,
    state: State<'_, DownloadState>,
    id: String,
    url: String,
    preferred_name: String,
) -> Result<String, String> {
    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.cancellations.lock().map_err(|_| "Download state is unavailable")?;
        map.insert(id.clone(), cancellation.clone());
    }

    let downloads_dir = download_root(&app)?;
    tokio::fs::create_dir_all(&downloads_dir).await.map_err(|e| e.to_string())?;
    let filename = safe_filename(&preferred_name);
    let final_path = unique_path(&downloads_dir, &filename);
    let result = download_to_path(&app, &id, &url, &final_path, &cancellation).await;

    if let Ok(mut map) = state.cancellations.lock() { map.remove(&id); }
    result
}

#[tauri::command]
async fn install_github_app(
    app: tauri::AppHandle,
    state: State<'_, DownloadState>,
    id: String,
    app_id: String,
    repository: String,
    extensions: Vec<String>,
) -> Result<InstalledAppInfo, String> {
    let safe_app_id = safe_identifier(&app_id)?;
    let previous = if app_manifest_path(&app, &safe_app_id)?.exists() {
        tokio::fs::read(app_manifest_path(&app, &safe_app_id)?).await.ok().and_then(|raw| serde_json::from_slice::<InstalledAppInfo>(&raw).ok())
    } else { None };
    let preferred_asset_name = previous.as_ref().and_then(|info| info.asset_name.as_deref());
    let asset = github_latest_asset(&repository, &extensions, preferred_asset_name).await?;
    let directory = app_dir(&app, &safe_app_id)?;
    tokio::fs::create_dir_all(&directory).await.map_err(|e| e.to_string())?;
    let installer_asset = is_windows_installer_asset(&asset.name, &asset.package_type);

    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.cancellations.lock().map_err(|_| "Download state is unavailable")?;
        map.insert(id.clone(), cancellation.clone());
    }

    let filename = safe_filename(&asset.name);
    let final_path = if installer_asset {
        let downloads = download_root(&app)?;
        tokio::fs::create_dir_all(&downloads).await.map_err(|e| e.to_string())?;
        unique_path(&downloads, &filename)
    } else {
        directory.join(&filename)
    };
    let result = download_to_path(&app, &id, &asset.download_url, &final_path, &cancellation).await;
    if let Ok(mut map) = state.cancellations.lock() { map.remove(&id); }

    let path = result?;
    if installer_asset {
        spawn_windows_installer(Path::new(&path))?;
    } else if let Some(old) = previous.as_ref().and_then(|info| info.executable_path.as_ref()) {
        let old_path = PathBuf::from(old);
        if old_path != final_path && old_path.starts_with(&directory) && old_path.exists() {
            let _ = tokio::fs::remove_file(old_path).await;
        }
    }

    let info = InstalledAppInfo {
        app_id: safe_app_id.clone(),
        installed: !installer_asset,
        version: Some(asset.version),
        executable_path: Some(path),
        asset_name: Some(asset.name),
        package_type: Some(asset.package_type),
        repository: Some(repository),
        release_tag: Some(asset.tag_name),
        asset_id: Some(asset.asset_id),
        asset_digest: asset.asset_digest,
        asset_updated_at: asset.asset_updated_at,
    };
    let manifest = serde_json::to_vec_pretty(&info).map_err(|e| e.to_string())?;
    tokio::fs::write(app_manifest_path(&app, &safe_app_id)?, manifest).await.map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
async fn get_installed_app(app: tauri::AppHandle, app_id: String) -> Result<InstalledAppInfo, String> {
    let safe_app_id = safe_identifier(&app_id)?;
    let manifest = app_manifest_path(&app, &safe_app_id)?;
    if !manifest.exists() {
        return Ok(InstalledAppInfo {
            app_id: safe_app_id, installed: false, version: None, executable_path: None,
            asset_name: None, package_type: None, repository: None,
            release_tag: None, asset_id: None, asset_digest: None, asset_updated_at: None,
        });
    }

    let content = tokio::fs::read(&manifest).await.map_err(|e| e.to_string())?;
    let mut info: InstalledAppInfo = serde_json::from_slice(&content).map_err(|e| e.to_string())?;
    if let Some(path) = &info.executable_path {
        if !Path::new(path).exists() { info.installed = false; }
        if info.asset_name.is_none() {
            info.asset_name = Path::new(path).file_name().and_then(|v| v.to_str()).map(str::to_string);
        }
        if info.package_type.is_none() {
            info.package_type = info.asset_name.as_deref().map(package_type_from_name);
        }
    }
    Ok(info)
}

fn running_pid_for_executable(path: &Path) -> Option<u32> {
    let target = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let target_q = powershell_quote(&target.to_string_lossy());
    let script = format!(r#"
$target = '{target_q}'
$match = Get-Process | Where-Object {{
  try {{ $_.Path -and [string]::Equals($_.Path, $target, [System.StringComparison]::OrdinalIgnoreCase) }} catch {{ $false }}
}} | Select-Object -First 1
if ($match) {{ [Console]::Out.Write($match.Id) }}
"#);
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-Command")
        .arg(script);
    hide_console_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() { return None; }
    String::from_utf8_lossy(&output.stdout).trim().parse::<u32>().ok()
}


fn focus_process(pid: u32) {
    let script = format!("$w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate({pid})");
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-Command")
        .arg(script);
    hide_console_window(&mut command);
    let _ = command.status();
}


#[tauri::command]
fn launch_installed_app(app: tauri::AppHandle, app_id: String) -> Result<(), String> {
    {
        let safe_app_id = safe_identifier(&app_id)?;
        let manifest = app_manifest_path(&app, &safe_app_id)?;
        let content = std::fs::read(&manifest).map_err(|_| "App is not installed through NontHub yet".to_string())?;
        let info: InstalledAppInfo = serde_json::from_slice(&content).map_err(|e| e.to_string())?;
        let path = info.executable_path.ok_or("Installed app has no executable path")?;
        let executable = PathBuf::from(path);
        if !executable.exists() { return Err("Installed application file is missing".into()); }

        let package = info.package_type.unwrap_or_else(|| package_type_from_name(executable.to_string_lossy().as_ref()));
        match package.as_str() {
            "exe" => {
                if let Some(pid) = running_pid_for_executable(&executable) {
                    focus_process(pid);
                    return Ok(());
                }
                let mut command = Command::new(&executable);
                hide_console_window(&mut command);
                command.spawn().map_err(|e| format!("Could not launch app: {e}"))?;
            }
            _ => return Err(format!("NontHub cannot directly launch a .{package} package as an installed app")),
        }
        Ok(())
    }
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Main NontHub window is unavailable")?;
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn exit_nonthub(app: tauri::AppHandle) {
    app.exit(0);
}

fn spawn_windows_installer(path: &Path) -> Result<(), String> {
    let extension = path.extension().and_then(|x| x.to_str()).unwrap_or_default().to_ascii_lowercase();
    let quoted_path = powershell_quote(&path.to_string_lossy());
    let script = match extension.as_str() {
        "exe" => format!("Start-Process -FilePath '{quoted_path}' -Verb RunAs"),
        "msi" => format!("Start-Process -FilePath 'msiexec.exe' -Verb RunAs -ArgumentList @('/i','{quoted_path}')"),
        _ => return Err("Only .exe and .msi release assets can be run automatically on Windows".into()),
    };

    // Use ShellExecute through PowerShell so installers that require admin rights
    // receive a normal UAC prompt instead of failing with Windows error 740.
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script);
    hide_console_window(&mut command);
    let status = command.status().map_err(|e| format!("Could not request installer elevation: {e}"))?;
    if !status.success() {
        return Err("Windows did not allow the installer to start. Approve the UAC prompt and try again.".into());
    }
    Ok(())
}



fn validated_downloaded_installer(app: &tauri::AppHandle, path: String) -> Result<PathBuf, String> {
    let requested = PathBuf::from(path);
    if !requested.exists() || !requested.is_file() { return Err("Downloaded installer does not exist".into()); }

    let downloads = download_root(app)?;
    let canonical_downloads = downloads.canonicalize().map_err(|e| e.to_string())?;
    let canonical_requested = requested.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_requested.starts_with(&canonical_downloads) {
        return Err("For safety, NontHub only runs installers it downloaded into your Downloads folder".into());
    }
    Ok(canonical_requested)
}

#[tauri::command]
fn run_downloaded_installer(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let canonical_requested = validated_downloaded_installer(&app, path)?;
    spawn_windows_installer(&canonical_requested)
}

fn powershell_quote(value: &str) -> String {
    value.replace('\'', "''")
}

fn start_portable_self_replace(app: &tauri::AppHandle, downloaded: &Path) -> Result<(), String> {
    let current = std::env::current_exe().map_err(|e| format!("Could not locate the running NontHub executable: {e}"))?;
    let current = current.canonicalize().unwrap_or(current);
    let source = downloaded.canonicalize().map_err(|e| format!("Could not resolve downloaded update: {e}"))?;
    if current == source {
        return Err("The downloaded update is already the running executable".into());
    }

    let source_q = powershell_quote(&source.to_string_lossy());
    let target_q = powershell_quote(&current.to_string_lossy());
    let pid = std::process::id();

    // GitHub releases sometimes contain the raw NontHub EXE rather than an NSIS/MSI
    // installer. In that case start a tiny elevated PowerShell helper that waits
    // for NontHub to exit, swaps the new EXE into the exact current path, and restarts it.
    let script = format!(r#"
$ErrorActionPreference = 'Stop'
$source = '{source_q}'
$target = '{target_q}'
$backup = "$target.nonthub-old"
$processId = {pid}
try {{ Wait-Process -Id $processId -ErrorAction SilentlyContinue }} catch {{}}
Start-Sleep -Milliseconds 700
try {{
  if (Test-Path -LiteralPath $backup) {{ Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }}
  if (Test-Path -LiteralPath $target) {{ Copy-Item -LiteralPath $target -Destination $backup -Force }}
  Copy-Item -LiteralPath $source -Destination $target -Force
  Start-Process -FilePath $target
  if (Test-Path -LiteralPath $backup) {{ Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }}
  Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
}} catch {{
  $message = $_.Exception.Message
  try {{
    if (Test-Path -LiteralPath $backup) {{ Copy-Item -LiteralPath $backup -Destination $target -Force }}
    if (Test-Path -LiteralPath $target) {{ Start-Process -FilePath $target }}
  }} catch {{}}
}}
"#);

    let utf16: Vec<u8> = script.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
    let encoded = BASE64_STANDARD.encode(utf16);
    let launcher = format!(
        "Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand','{encoded}')"
    );
    let mut updater_command = Command::new("powershell.exe");
    updater_command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(launcher);
    hide_console_window(&mut updater_command);
    let status = updater_command
        .status()
        .map_err(|e| format!("Could not start the NontHub self-updater: {e}"))?;
    if !status.success() {
        return Err("Windows did not allow the NontHub updater to start. Approve the UAC prompt and try again.".into());
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
fn install_nonthub_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let canonical_requested = validated_downloaded_installer(&app, path)?;
    let lower_name = canonical_requested.file_name().and_then(|v| v.to_str()).unwrap_or_default().to_ascii_lowercase();
    let extension = canonical_requested.extension().and_then(|v| v.to_str()).unwrap_or_default().to_ascii_lowercase();
    let looks_like_installer = extension == "msi"
        || ["setup", "installer", "install", "nsis"].iter().any(|token| lower_name.contains(token));

    if extension == "exe" && !looks_like_installer {
        // Fallback for releases like `nonthub.exe` that contain the raw app binary.
        let result = start_portable_self_replace(&app, &canonical_requested);
        return result;
    }

    spawn_windows_installer(&canonical_requested)?;
    // A running executable can block its own installer from replacing files.
    // Exit NontHub only after the updater process has started successfully.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
fn cancel_download(state: State<'_, DownloadState>, id: String) -> Result<(), String> {
    let map = state.cancellations.lock().map_err(|_| "Download state is unavailable")?;
    let flag = map.get(&id).ok_or("Download is not active")?;
    flag.store(true, Ordering::Relaxed);
    Ok(())
}


#[derive(Clone, Serialize)]
struct PlatformInfo {
    os: String,
    arch: String,
    download_location: String,
}


#[tauri::command]
fn open_official_website(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Website URL is invalid".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only HTTPS official websites can be opened".into());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if !matches!(host.as_str(), "www.nont.me" | "nont.me" | "music.nont.me") {
        return Err("Website is not an approved Nont site".into());
    }

    let mut command = Command::new("rundll32.exe");
    command.args(["url.dll,FileProtocolHandler", parsed.as_str()]);
    hide_console_window(&mut command);
    command.spawn().map_err(|e| format!("Could not open website: {e}"))?;
    Ok(())
}

#[tauri::command]
fn get_platform_info() -> PlatformInfo {
    PlatformInfo {
        os: "windows".into(),
        arch: std::env::consts::ARCH.to_string(),
        download_location: "Downloads".into(),
    }
}

#[tauri::command]
fn get_nonthub_runtime_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}



pub fn run() {
    let mut builder = tauri::Builder::default();

    // NontHub itself is single-instance. Launching it again restores/focuses the
    // already-running main window instead of starting a second client process.
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));

    builder
        .manage(DownloadState::default())
        .manage(ProfileState::default())
        .setup(|app| {
            let open_item = MenuItem::with_id(app, "nonthub-open", "Open NontHub", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "nonthub-quit", "Exit NontHub", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

                let mut tray_builder = TrayIconBuilder::new()
                    .tooltip("NontHub")
                    .menu(&menu)
                    .show_menu_on_left_click(false);
                if let Some(icon) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(icon.clone());
                }
                let tray = tray_builder.build(app)?;

                tray.on_menu_event(|app, event| match event.id().as_ref() {
                    "nonthub-open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "nonthub-quit" => {
                        app.exit(0);
                    },
                    _ => {}
                });

                tray.on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_user_profile,
            save_user_profile,
            get_platform_info,
            get_nonthub_runtime_version,
            open_official_website,
            get_github_repository_info,
            resolve_github_release,
            list_github_release_assets,
            resolve_repository_icon,
            download_file,
            install_github_app,
            get_installed_app,
            launch_installed_app,
            hide_main_window,
            exit_nonthub,
            run_downloaded_installer,
            install_nonthub_update,
            cancel_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running NontHub");
}
