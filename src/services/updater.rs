use crate::errors::{Error, Result};
use crate::fmt::dim;
use crate::schema::UpdateCache;
use crate::services::{config, shell};
use crate::version::VERSION;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const REPO: &str = "timzolleis/ship";
pub const REFRESH_CMD: &str = "__refresh-update-cache";

fn cache_path() -> PathBuf {
    config::config_dir().join("update-cache.json")
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn is_refresh_invocation() -> bool {
    std::env::args().skip(1).any(|a| a == REFRESH_CMD)
}

// -- Cache I/O (read errors swallowed: cache is best-effort) --

pub fn read_cache() -> Option<UpdateCache> {
    let raw = fs::read_to_string(cache_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_cache(cache: &UpdateCache) -> Result<()> {
    let json = serde_json::to_string_pretty(cache)
        .map_err(|e| Error::EncodeConfig { detail: e.to_string() })?;
    fs::write(cache_path(), json + "\n").map_err(|e| Error::WriteFile {
        path: cache_path().display().to_string(),
        detail: e.to_string(),
    })
}

pub fn is_cache_stale(cache: &UpdateCache) -> bool {
    match DateTime::parse_from_rfc3339(&cache.last_checked_at) {
        Err(_) => true,
        Ok(t) => Utc::now().signed_duration_since(t) > Duration::hours(1),
    }
}

// -- Network --

pub fn fetch_latest_version() -> Result<String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "ship-cli")
        .call()
        .map_err(|e| Error::UpdateCheck {
            detail: match e {
                ureq::Error::Status(code, _) => format!("GitHub API responded {code}"),
                other => other.to_string(),
            },
        })?;
    let json: serde_json::Value = resp
        .into_json()
        .map_err(|e| Error::UpdateCheck { detail: e.to_string() })?;
    json.get("tag_name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| Error::UpdateCheck {
            detail: "response missing tag_name".to_string(),
        })
}

pub fn refresh_cache() -> Result<()> {
    let latest = fetch_latest_version()?;
    write_cache(&UpdateCache {
        last_checked_at: now_iso(),
        latest_version: latest,
    })
}

// -- Post-command hooks --

pub fn notify_if_available() {
    if VERSION == "dev" || is_refresh_invocation() {
        return;
    }
    let Some(cache) = read_cache() else { return };
    if cache.latest_version == VERSION {
        return;
    }
    // Notice goes to stderr so command stdout (used in pipes) stays clean.
    eprintln!(
        "{}",
        dim(format!(
            "ship {} is available — run 'ship update'",
            cache.latest_version
        ))
    );
}

pub fn spawn_background_refresh_if_stale() {
    if VERSION == "dev" || is_refresh_invocation() {
        return;
    }
    if let Some(cache) = read_cache() {
        if !is_cache_stale(&cache) {
            return;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let _ = Command::new(exe)
            .arg(REFRESH_CMD)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

// -- ship update --

pub fn install_latest(version: &str) -> Result<()> {
    if VERSION == "dev" {
        return Err(Error::UpdateInstall {
            detail: "running from source (debug build); rebuild with `cargo build --release` instead of self-updating"
                .to_string(),
        });
    }

    // Asset names use Node-style identifiers (darwin/arm64/x64) so Rust and
    // Bun builds share release artifacts.
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    if platform != "darwin" || (arch != "arm64" && arch != "x64") {
        return Err(Error::UnsupportedPlatform {
            platform: platform.to_string(),
            arch: arch.to_string(),
        });
    }

    let asset = format!("ship-{platform}-{arch}");
    let url = format!("https://github.com/{REPO}/releases/download/{version}/{asset}");

    let target = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| Error::UpdateInstall {
            detail: format!("cannot resolve binary path: {e}"),
        })?;
    let temp_path = PathBuf::from(format!("{}.new", target.display()));

    let resp = ureq::get(&url)
        .set("User-Agent", "ship-cli")
        .call()
        .map_err(|e| Error::UpdateDownload {
            url: url.clone(),
            detail: match e {
                ureq::Error::Status(code, _) => format!("HTTP {code}"),
                other => other.to_string(),
            },
        })?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| Error::UpdateDownload {
            url: url.clone(),
            detail: e.to_string(),
        })?;

    fs::write(&temp_path, &bytes).map_err(|e| Error::UpdateInstall {
        detail: format!("write temp: {e}"),
    })?;

    fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o755)).map_err(|e| {
        Error::UpdateInstall {
            detail: format!("chmod: {e}"),
        }
    })?;

    // Ad-hoc signing keeps macOS from killing the swapped-in binary.
    shell::exec("codesign", &["--sign", "-", "--force", &temp_path.display().to_string()])
        .map_err(|e| Error::UpdateInstall {
            detail: format!("codesign: {e}"),
        })?;

    fs::rename(&temp_path, &target).map_err(|e| Error::UpdateInstall {
        detail: format!("rename: {e}"),
    })?;

    let _ = write_cache(&UpdateCache {
        last_checked_at: now_iso(),
        latest_version: version.to_string(),
    });
    Ok(())
}
