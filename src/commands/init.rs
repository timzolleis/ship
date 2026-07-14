use crate::errors::{Error, Result};
use crate::fmt::{blue, bold, dim, green};
use crate::prompt;
use crate::schema::{
    CommandsConfig, DatabaseConfig, EnvConfig, EnvVarConfig, EnvVarType, ExecutionRuntime,
    ProjectConfig, WorktreeConfig,
};
use crate::services::{config, proxy};
use crate::util::cwd_string;
use indexmap::IndexMap;
use regex::Regex;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

#[derive(clap::Args)]
pub struct InitArgs {
    #[arg(long)]
    alias: Option<String>,
    #[arg(long)]
    path: Option<String>,
    #[arg(long)]
    db_container: Option<String>,
    #[arg(long)]
    db_user: Option<String>,
    #[arg(long)]
    db_source: Option<String>,
    #[arg(long)]
    install_cmd: Option<String>,
    #[arg(long)]
    generate_cmd: Option<String>,
    #[arg(long)]
    migrate_cmd: Option<String>,
    #[arg(long)]
    dev_cmd: Option<String>,
}

// ---------------------------------------------------------------------------
// .env auto-detection
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS: &[&str] = &["node_modules", ".git", "dist", "build", ".next", ".cache", ".turbo"];

static ENV_LINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Z_]+)=(.+)$").unwrap());
static DATABASE_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"postgres(?:ql)?://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)").unwrap()
});

struct DetectedEnv {
    file: String,
    vars: Vec<(String, String, EnvVarType)>,
}

fn find_env_files(dir: &Path, root: &Path, results: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if EXCLUDED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let Ok(meta) = fs::metadata(&full) else { continue };
        if meta.is_dir() {
            find_env_files(&full, root, results);
        } else if name == ".env" {
            if let Ok(rel) = full.strip_prefix(root) {
                results.push(rel.display().to_string());
            }
        }
    }
}

fn strip_quotes(v: &str) -> &str {
    let v = v.strip_prefix('"').or_else(|| v.strip_prefix('\'')).unwrap_or(v);
    v.strip_suffix('"').or_else(|| v.strip_suffix('\'')).unwrap_or(v)
}

fn detect_env_files(cwd: &Path) -> Vec<DetectedEnv> {
    let mut files = Vec::new();
    find_env_files(cwd, cwd, &mut files);

    let mut results = Vec::new();
    for candidate in files {
        let Ok(content) = fs::read_to_string(cwd.join(&candidate)) else {
            continue;
        };
        let mut vars = Vec::new();
        for line in content.split('\n') {
            let Some(caps) = ENV_LINE_RE.captures(line) else { continue };
            let key = caps[1].to_string();
            let value = strip_quotes(&caps[2]).to_string();

            if key == "DATABASE_URL" || key.ends_with("_DATABASE_URL") {
                vars.push((key, value, EnvVarType::DatabaseUrl));
            } else if key.ends_with("_URL") && value.contains(".localhost") {
                vars.push((key, value, EnvVarType::ProxyUrl));
            } else if key.ends_with("_CALLBACK_URL") && value.starts_with("http://localhost") {
                vars.push((key, value, EnvVarType::DevUrl));
            }
        }
        if !vars.is_empty() {
            results.push(DetectedEnv { file: candidate, vars });
        }
    }
    results
}

struct ParsedDbUrl {
    user: String,
    host: String,
    port: u16,
    database: String,
}

fn parse_database_url(url: &str) -> Option<ParsedDbUrl> {
    let caps = DATABASE_URL_RE.captures(url)?;
    Some(ParsedDbUrl {
        user: caps[1].to_string(),
        host: caps[3].to_string(),
        port: caps[4].parse().ok()?,
        database: caps[5].to_string(),
    })
}

fn resolve(opt: Option<String>, msg: &str, default: &str) -> Result<String> {
    match opt {
        Some(v) => Ok(v),
        None => prompt::input(msg, Some(default)),
    }
}

// ---------------------------------------------------------------------------
// ship init
// ---------------------------------------------------------------------------

pub fn run(args: InitArgs) {
    if let Err(e) = run_inner(args) {
        eprintln!("Error: {e}");
    }
}

fn run_inner(opts: InitArgs) -> Result<()> {
    let cwd = cwd_string();
    let dir_name = Path::new(&cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    println!();
    println!("  Detected: {} ({})", bold(&dir_name), dim(&cwd));
    println!();

    // Existing registration (matched by cwd) seeds the alias prompt.
    let ship_config = config::load_config()?;
    let alias_for_cwd = ship_config
        .projects
        .iter()
        .find(|(_, p)| p.path == cwd)
        .map(|(a, _)| a.clone());

    // 1. Project alias.
    let default_alias =
        alias_for_cwd.unwrap_or_else(|| dir_name.chars().take(3).collect::<String>());
    let alias = resolve(opts.alias, "Project alias:", &default_alias)?;

    // Re-running init on a known alias updates it — prompts default to stored values.
    let existing = ship_config.projects.get(&alias).cloned();
    if existing.is_some() {
        println!(
            "  {}",
            dim(format!(
                "Updating existing project \"{alias}\" — press enter to keep current values."
            ))
        );
        println!();
    }

    // 2. Project path.
    let default_path = existing.as_ref().map(|e| e.path.clone()).unwrap_or_else(|| cwd.clone());
    let project_path = resolve(opts.path, "Project path:", &default_path)?;

    // 3. Auto-detect .env files.
    println!();
    println!("  Scanning for .env files...");
    let detected = detect_env_files(Path::new(&cwd));

    let mut inferred_db_user = existing
        .as_ref()
        .map(|e| e.database.user.clone())
        .unwrap_or_else(|| "postgres".to_string());
    let mut inferred_db_host = existing
        .as_ref()
        .map(|e| e.database.host.clone())
        .unwrap_or_else(|| "localhost".to_string());
    let mut inferred_db_port = existing.as_ref().map(|e| e.database.port).unwrap_or(5432);
    let mut inferred_db_source = existing
        .as_ref()
        .map(|e| e.database.source.clone())
        .unwrap_or_else(|| "postgres".to_string());
    let mut all_env_files: Vec<String> = Vec::new();
    let mut all_detected_vars: IndexMap<String, EnvVarConfig> = IndexMap::new();

    for env in &detected {
        println!("    Found {}", blue(&env.file));
        all_env_files.push(env.file.clone());

        for (key, value, var_type) in &env.vars {
            let preview: String = value.chars().take(60).collect();
            let ellipsis = if value.len() > 60 { "..." } else { "" };
            println!("      {} → {}{}", dim(key), dim(&preview), ellipsis);
            all_detected_vars.insert(
                key.clone(),
                EnvVarConfig {
                    var_type: *var_type,
                    path: None,
                },
            );

            if *var_type == EnvVarType::DatabaseUrl && key == "DATABASE_URL" {
                if let Some(parsed) = parse_database_url(value) {
                    inferred_db_user = parsed.user;
                    inferred_db_host = parsed.host;
                    inferred_db_port = parsed.port;
                    inferred_db_source = parsed.database;
                }
            }
        }
    }

    if !detected.is_empty() {
        println!();
        println!("  Inferred database config:");
        println!("    User            {}", blue(&inferred_db_user));
        println!(
            "    Host            {}:{}",
            blue(&inferred_db_host),
            blue(inferred_db_port)
        );
        println!("    Source database  {}", blue(&inferred_db_source));
        println!();
    }

    // 4. Database config (confirm or override).
    let existing_container = existing
        .as_ref()
        .map(|e| e.database.docker_container().to_string())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "postgres".to_string());
    let db_container = resolve(opts.db_container, "Database container name:", &existing_container)?;
    let db_user = resolve(opts.db_user, "Database user:", &inferred_db_user)?;
    let db_source = resolve(opts.db_source, "Source database to clone from:", &inferred_db_source)?;

    // 5. Commands.
    let existing_cmds = existing.as_ref().map(|e| e.commands.clone()).unwrap_or_default();
    let install_cmd = resolve(
        opts.install_cmd,
        "Install command:",
        existing_cmds.install.as_deref().unwrap_or("pnpm install"),
    )?;
    let generate_cmd = resolve(
        opts.generate_cmd,
        "Generate command (e.g. prisma):",
        existing_cmds.generate.as_deref().unwrap_or("pnpm db generate"),
    )?;
    let migrate_cmd = resolve(
        opts.migrate_cmd,
        "Migrate command:",
        existing_cmds.migrate.as_deref().unwrap_or("pnpm db migrate:deploy"),
    )?;
    let dev_cmd = resolve(
        opts.dev_cmd,
        "Dev command:",
        existing_cmds.dev.as_deref().unwrap_or("pnpm dev -p {port}"),
    )?;

    // 6. Root checkout route — reuse domain/port if registered before.
    let root_domain = existing
        .as_ref()
        .and_then(|e| e.domain.clone())
        .unwrap_or_else(|| format!("{alias}.localhost"));
    let root_port = match existing.as_ref().and_then(|e| e.port) {
        Some(p) => p,
        None => proxy::next_port()?,
    };

    // 7. Build the config — merge env with existing (manual tweaks like dev_url
    // paths win over fresh detection), keep customized worktree patterns.
    let mut env_files: Vec<String> = existing.as_ref().map(|e| e.env.files.clone()).unwrap_or_default();
    for f in all_env_files {
        if !env_files.contains(&f) {
            env_files.push(f);
        }
    }
    let mut auto_detected = all_detected_vars;
    if let Some(e) = &existing {
        for (k, v) in &e.env.auto_detected {
            auto_detected.insert(k.clone(), v.clone());
        }
    }

    let project = ProjectConfig {
        path: project_path,
        domain: Some(root_domain.clone()),
        port: Some(root_port),
        database: DatabaseConfig {
            runtime: ExecutionRuntime::Docker {
                container: db_container,
            },
            user: db_user,
            source: db_source,
            host: inferred_db_host,
            port: inferred_db_port,
        },
        commands: CommandsConfig {
            install: Some(install_cmd),
            generate: Some(generate_cmd),
            migrate: Some(migrate_cmd),
            dev: Some(dev_cmd),
            seed: existing.as_ref().and_then(|e| e.commands.seed.clone()),
        },
        env: EnvConfig {
            files: env_files,
            auto_detected,
        },
        worktree: existing
            .as_ref()
            .map(|e| e.worktree.clone())
            .unwrap_or_else(|| WorktreeConfig {
                dir_pattern: format!("../{dir_name}-{{branch_slug}}/"),
                proxy_domain_pattern: format!("{{branch_slug}}.{alias}.localhost"),
                db_name_pattern: format!("{alias}_{{branch_slug_safe}}"),
            }),
    };

    config::add_project(&alias, project)?;

    match proxy::add_route(&root_domain, root_port) {
        Ok(()) | Err(Error::RouteExists { .. }) => {}
        Err(e) => return Err(e),
    }

    println!();
    println!(
        "  {} Project {} {}.",
        green("✓"),
        bold(format!("\"{alias}\"")),
        if existing.is_some() { "updated" } else { "registered" }
    );
    println!(
        "  {} Root route     https://{} → :{}",
        green("✓"),
        bold(&root_domain),
        blue(root_port)
    );
    println!();
    Ok(())
}
