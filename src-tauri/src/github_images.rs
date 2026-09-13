use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::Url;
use serde::Deserialize;
use std::{path::Path, time::Duration};

const USER_AGENT: &str = "NontHub/0.4.4";

#[derive(Deserialize)]
struct GithubRepoMetadata {
    default_branch: String,
    owner: GithubOwner,
}

#[derive(Deserialize)]
struct GithubOwner {
    avatar_url: String,
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

fn validate_repository(repository: &str) -> Result<(), String> {
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return Err("Repository must look like owner/repo".into());
    }
    let valid = |value: &str| value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid(owner) || !valid(repo) {
        return Err("Repository contains unsupported characters".into());
    }
    Ok(())
}

fn icon_score(path: &str, repository: &str) -> i32 {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let file = Path::new(&lower).file_name().and_then(|v| v.to_str()).unwrap_or("");
    let stem = Path::new(file).file_stem().and_then(|v| v.to_str()).unwrap_or("");
    let supported = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"];
    if !supported.iter().any(|ext| lower.ends_with(ext)) { return -10_000; }

    let reject = [
        "screenshot", "screen-shot", "screenshots/", "banner", "splash", "background", "wallpaper",
        "mockup", "preview", "cover", "hero", "social", "og-image", "og_image", "twitter",
        "thumbnail", "thumb", "sponsor", "badge", "button", "qr", "diagram",
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
    if file.contains("favicon") { score -= 90; }
    if file.contains("16x16") || file.contains("24x24") || file.contains("32x32") { score -= 75; }
    if lower.ends_with(".png") || lower.ends_with(".webp") { score += 50; }
    if lower.ends_with(".svg") { score += 45; }
    if lower.ends_with(".ico") { score += 30; }
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { score -= 25; }
    if lower.matches('/').count() <= 4 { score += 20; }
    score
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" { return None; }
    Some((u32::from_be_bytes(bytes[16..20].try_into().ok()?), u32::from_be_bytes(bytes[20..24].try_into().ok()?)))
}

fn ico_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 8 || &bytes[..4] != b"\x00\x00\x01\x00" { return None; }
    Some((if bytes[6] == 0 { 256 } else { bytes[6] as u32 }, if bytes[7] == 0 { 256 } else { bytes[7] as u32 }))
}

fn artwork_shape_score(path: &str, bytes: &[u8]) -> i32 {
    let lower = path.to_ascii_lowercase();
    let dimensions = if lower.ends_with(".png") { png_dimensions(bytes) } else if lower.ends_with(".ico") { ico_dimensions(bytes) } else { None };
    let Some((width, height)) = dimensions else { return if lower.ends_with(".svg") { 70 } else { 0 }; };
    let min_side = width.min(height) as f64;
    if min_side <= 0.0 { return -300; }
    let ratio = width.max(height) as f64 / min_side;
    let mut score = if ratio <= 1.03 { 180 } else if ratio <= 1.15 { 135 } else if ratio <= 1.35 { 55 } else if ratio >= 2.0 { -260 } else { -80 };
    score += match width.max(height) { 0..=31 => -180, 32..=63 => -80, 64..=127 => 10, 128..=255 => 55, 256..=2048 => 95, _ => 35 };
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

async fn fetch_small(client: &reqwest::Client, url: Url, max_bytes: usize) -> Result<Option<Vec<u8>>, String> {
    let response = client.get(url).send().await.map_err(|e| format!("Could not read GitHub image: {e}"))?;
    if !response.status().is_success() || response.content_length().unwrap_or(0) > max_bytes as u64 { return Ok(None); }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > max_bytes { return Ok(None); }
    Ok(Some(bytes.to_vec()))
}

async fn raw_file(client: &reqwest::Client, repository: &str, branch: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let mut parts = repository.split('/');
    let owner = parts.next().ok_or("Invalid repository")?;
    let repo = parts.next().ok_or("Invalid repository")?;
    let mut url = Url::parse("https://raw.githubusercontent.com").map_err(|e| e.to_string())?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| "Could not build GitHub image URL")?;
        segments.push(owner).push(repo).push(branch);
        for segment in path.split('/') { if !segment.is_empty() { segments.push(segment); } }
    }
    fetch_small(client, url, 2_500_000).await
}

pub async fn repository_image(repository: &str) -> Result<Option<String>, String> {
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
    if tree_response.status().is_success() {
        let tree: GithubTree = tree_response.json().await.map_err(|e| e.to_string())?;
        let mut candidates = tree.tree.into_iter()
            .filter(|item| item.kind == "blob" && item.size.unwrap_or(0) <= 2_500_000)
            .map(|item| {
                let mut score = icon_score(&item.path, repository);
                let size = item.size.unwrap_or(0);
                if (2_000..=1_000_000).contains(&size) { score += 25; }
                if size > 1_800_000 { score -= 55; }
                (score, item.path)
            })
            .filter(|(score, _)| *score > 0)
            .collect::<Vec<_>>();
        candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

        let mut best: Option<(i32, String, Vec<u8>)> = None;
        for (base_score, path) in candidates.into_iter().take(18) {
            let Some(bytes) = raw_file(&client, repository, &meta.default_branch, &path).await? else { continue; };
            let score = base_score + artwork_shape_score(&path, &bytes);
            if best.as_ref().map(|(old, _, _)| score > *old).unwrap_or(true) { best = Some((score, path, bytes)); }
        }
        if let Some((_, path, bytes)) = best { return Ok(Some(bytes_to_data_url(&path, &bytes))); }
    }

    let avatar = Url::parse(&meta.owner.avatar_url).map_err(|e| e.to_string())?;
    Ok(fetch_small(&client, avatar, 2_500_000).await?.map(|bytes| bytes_to_data_url("avatar.png", &bytes)))
}
