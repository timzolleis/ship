use crate::domain::caddyfile::{self, Route, BASE_PORT};
use crate::errors::{Error, Result};
use crate::services::{config, shell};
use std::fs;
use std::path::{Path, PathBuf};

const CONTAINER: &str = "ship-proxy";

fn proxy_dir() -> PathBuf {
    config::config_dir()
}

pub fn caddyfile_path() -> PathBuf {
    proxy_dir().join("Caddyfile")
}

fn caddy_data() -> PathBuf {
    proxy_dir().join("caddy-data")
}

fn caddy_config() -> PathBuf {
    proxy_dir().join("caddy-config")
}

fn mk_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|e| Error::CreateDirectory {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
}

fn write_caddyfile(content: &str) -> Result<()> {
    let path = caddyfile_path();
    fs::write(&path, content).map_err(|e| Error::WriteFile {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
}

pub fn ensure_setup() -> Result<()> {
    mk_dir(&proxy_dir())?;
    mk_dir(&caddy_data())?;
    mk_dir(&caddy_config())?;
    if !caddyfile_path().exists() {
        write_caddyfile("")?;
    }
    Ok(())
}

fn read_caddyfile() -> Result<String> {
    ensure_setup()?;
    let path = caddyfile_path();
    fs::read_to_string(&path).map_err(|e| Error::ReadFile {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
}

pub fn is_running() -> bool {
    shell::exec("docker", &["ps", "--format", "{{.Names}}"])
        .map(|r| r.stdout.lines().any(|name| name.trim() == CONTAINER))
        .unwrap_or(false)
}

pub fn get_routes() -> Result<Vec<Route>> {
    Ok(caddyfile::parse_routes(&read_caddyfile()?))
}

pub fn reload() {
    if is_running() {
        let _ = shell::exec(
            "docker",
            &["exec", CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
        );
    }
}

pub fn add_route(domain: &str, port: u16) -> Result<()> {
    let content = read_caddyfile()?;
    if caddyfile::parse_routes(&content).iter().any(|r| r.domain == domain) {
        return Err(Error::RouteExists {
            domain: domain.to_string(),
        });
    }
    write_caddyfile(&caddyfile::add_route(&content, domain, port))?;
    reload();
    Ok(())
}

pub fn remove_route(domain: &str) -> Result<()> {
    let content = read_caddyfile()?;
    if !caddyfile::parse_routes(&content).iter().any(|r| r.domain == domain) {
        return Err(Error::RouteNotFound {
            domain: domain.to_string(),
        });
    }
    write_caddyfile(&caddyfile::remove_route(&content, domain))?;
    reload();
    Ok(())
}

pub fn start() -> Result<()> {
    ensure_setup()?;
    if is_running() {
        return Ok(());
    }
    let _ = shell::exec("docker", &["rm", "-f", CONTAINER]);
    let caddyfile_mount = format!("{}:/etc/caddy/Caddyfile:ro", caddyfile_path().display());
    let data_mount = format!("{}:/data", caddy_data().display());
    let config_mount = format!("{}:/config", caddy_config().display());
    shell::exec(
        "docker",
        &[
            "run", "-d",
            "--name", CONTAINER,
            "--restart", "unless-stopped",
            "-p", "80:80",
            "-p", "443:443",
            "-v", &caddyfile_mount,
            "-v", &data_mount,
            "-v", &config_mount,
            "caddy:2-alpine",
        ],
    )
    .map(|_| ())
}

pub fn stop() {
    let _ = shell::exec("docker", &["rm", "-f", CONTAINER]);
}

pub fn status() -> Result<(bool, Vec<Route>)> {
    Ok((is_running(), get_routes()?))
}

pub fn trust() -> Result<()> {
    let ca_path = caddy_data().join("caddy/pki/authorities/local/root.crt");
    if !ca_path.exists() {
        return Err(Error::CertNotFound);
    }
    shell::exec(
        "sudo",
        &[
            "security", "add-trusted-cert", "-d", "-r", "trustRoot",
            "-k", "/Library/Keychains/System.keychain",
            &ca_path.display().to_string(),
        ],
    )
    .map(|_| ())
}

pub fn next_port() -> Result<u16> {
    Ok(caddyfile::next_port(&get_routes()?, BASE_PORT))
}

pub fn edit_caddyfile() -> Result<()> {
    ensure_setup()?;
    let editor = std::env::var("EDITOR").unwrap_or_else(|_| "vi".to_string());
    shell::exec_interactive(&editor, &[&caddyfile_path().display().to_string()])?;
    reload();
    Ok(())
}
