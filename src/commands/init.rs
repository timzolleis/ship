use crate::errors::{Error, Result};
use crate::fmt::{blue, bold, dim, green};
use crate::prompt;
use crate::schema::{
    CommandsConfig, DatabaseConfig, EnvConfig, EnvFileVars, EnvVarConfig, EnvVarType,
    ExecutionRuntime, ProjectConfig, ShipConfig, WorktreeConfig,
};
use crate::services::{config, copy, git, proxy};
use crate::util::cwd_string;
use indexmap::IndexMap;
use regex::Regex;
use std::fs;
use std::io::IsTerminal;
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
    install_cmd: Vec<String>,
    #[arg(long)]
    db_cmd: Vec<String>,
    #[arg(long)]
    dev_cmd: Vec<String>,
}

// ---------------------------------------------------------------------------
// .env auto-detection
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".cache",
    ".turbo",
];

// Local state a git checkout can't carry. Deliberately narrow: uploads/ and
// storage/ are plausible but easily multi-GB, and a silent huge copy on every
// `ship create` is worse than adding the path by hand once.
const STATE_EXTENSIONS: &[&str] = &["db", "sqlite", "sqlite3", "pem", "key", "crt"];

static ENV_LINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Z_]+)=(.+)$").unwrap());
static DATABASE_URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"postgres(?:ql)?://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)").unwrap());

struct DetectedEnv {
    file: String,
    vars: Vec<(String, String, EnvVarType)>,
}

fn find_env_files(dir: &Path, root: &Path, results: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if EXCLUDED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let Ok(meta) = fs::metadata(&full) else {
            continue;
        };
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
    let v = v
        .strip_prefix('"')
        .or_else(|| v.strip_prefix('\''))
        .unwrap_or(v);
    v.strip_suffix('"')
        .or_else(|| v.strip_suffix('\''))
        .unwrap_or(v)
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
            let Some(caps) = ENV_LINE_RE.captures(line) else {
                continue;
            };
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
            results.push(DetectedEnv {
                file: candidate,
                vars,
            });
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
// Copy-path detection
// ---------------------------------------------------------------------------

fn find_state_files(dir: &Path, root: &Path, results: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if EXCLUDED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let Ok(meta) = fs::metadata(&full) else {
            continue;
        };
        if meta.is_dir() {
            find_state_files(&full, root, results);
        } else if full
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| STATE_EXTENSIONS.contains(&e))
        {
            if let Ok(rel) = full.strip_prefix(root) {
                results.push(rel.display().to_string());
            }
        }
    }
}

/// Gitignored local state worth copying into a worktree. Tracked files already
/// arrive with the checkout, so "git ignores it" is the whole signal.
///
/// A match is proposed as its containing directory when that directory is
/// itself ignored — copying `database.db` without its `-wal`/`-shm` siblings
/// can hand the app a torn read.
fn detect_copy_paths(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    find_state_files(root, root, &mut files);
    if files.is_empty() {
        return Vec::new();
    }

    let repo = root.display().to_string();
    let parents: Vec<String> = files
        .iter()
        .filter_map(|f| Path::new(f).parent())
        .map(|p| p.display().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let ignored_dirs = git::ignored_paths(&repo, &parents);

    let mut candidates: Vec<String> = Vec::new();
    for file in &files {
        let parent = Path::new(file)
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let candidate = if !parent.is_empty() && ignored_dirs.contains(&parent) {
            parent
        } else {
            file.clone()
        };
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }

    let ignored = git::ignored_paths(&repo, &candidates);
    candidates.retain(|c| ignored.contains(c));
    candidates
}

// Checkbox list. Everything detected starts checked on a first init; once the
// project has a stored list, only stored paths start checked — so a path you
// deselected stays deselected instead of silently coming back.
fn review_copy_paths(root: &str, detected: Vec<String>, stored: &[String]) -> Result<Vec<String>> {
    let mut paths = stored.to_vec();
    for d in detected {
        if !paths.contains(&d) {
            paths.push(d);
        }
    }
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let first_run = stored.is_empty();
    let items: Vec<(String, bool)> = paths
        .iter()
        .map(|p| {
            let (files, bytes) = copy::measure(root, p);
            let label = format!(
                "{p}  ({} file{}, {})",
                files,
                crate::util::plural(files),
                copy::human_size(bytes)
            );
            (label, first_run || stored.contains(p))
        })
        .collect();

    println!();
    if !std::io::stdin().is_terminal() {
        for (label, checked) in &items {
            if *checked {
                println!("    {} {}", green("✓"), dim(label));
            }
        }
        return Ok(paths
            .into_iter()
            .zip(items)
            .filter(|(_, (_, checked))| *checked)
            .map(|(p, _)| p)
            .collect());
    }

    let picked = prompt::multi_select("Copy into new workspaces? (space toggles)", &items)?;
    Ok(picked.into_iter().map(|i| paths[i].clone()).collect())
}

// ---------------------------------------------------------------------------
// Env review
// ---------------------------------------------------------------------------

/// Current on-disk values, file → var → value. Display only; a configured var
/// whose file no longer holds it simply has no entry.
type EnvValues = IndexMap<String, IndexMap<String, String>>;

fn truncate(value: &str, max: usize) -> String {
    let short: String = value.chars().take(max).collect();
    if value.chars().count() > max {
        format!("{short}…")
    } else {
        short
    }
}

fn print_env_table(files: &IndexMap<String, EnvFileVars>, values: &EnvValues) {
    let key_width = files
        .values()
        .flat_map(|vars| vars.keys())
        .map(|k| k.len())
        .max()
        .unwrap_or(0);

    for (file, vars) in files {
        println!("    {}", blue(file));
        for (key, cfg) in vars {
            let value = values
                .get(file)
                .and_then(|v| v.get(key))
                .map(|v| truncate(v, 44))
                .unwrap_or_else(|| "(not present)".to_string());
            println!(
                "      {key:<key_width$}  {}  {}",
                dim(format!("{:<45}", truncate(&value, 45))),
                green(cfg.var_type.label())
            );
        }
    }
}

// Confirm-then-fix: detection proposes, enter accepts, and only the wrong rows
// cost keystrokes. Skipped without a TTY so scripted `ship init` still works.
fn review_env_vars(files: &mut IndexMap<String, EnvFileVars>, values: &EnvValues) -> Result<()> {
    if files.is_empty() || !std::io::stdin().is_terminal() {
        return Ok(());
    }

    loop {
        println!();
        if !prompt::confirm("Change how any of these are handled?", false)? {
            return Ok(());
        }

        // Flat row list so picking a var is one selection, not file-then-var.
        let rows: Vec<(String, String)> = files
            .iter()
            .flat_map(|(file, vars)| vars.keys().map(|k| (file.clone(), k.clone())))
            .collect();
        let mut items: Vec<String> = rows
            .iter()
            .map(|(file, key)| {
                let label = files[file][key].var_type.label();
                format!("{file}  {key}  ({label})")
            })
            .collect();
        items.push("Done".to_string());

        let picked = prompt::select("Which variable?", &items)?;
        let Some((file, key)) = rows.get(picked) else {
            return Ok(());
        };

        let current = files[file][key].var_type;
        // Current handling first so enter keeps it (prompt::select defaults to 0).
        let choices: Vec<EnvVarType> = std::iter::once(current)
            .chain(EnvVarType::ALL.into_iter().filter(|t| *t != current))
            .collect();
        let labels: Vec<String> = choices
            .iter()
            .map(|t| format!("{:<24} {}", t.label(), t.help()))
            .collect();
        let chosen = choices[prompt::select(&format!("Handling for {key}"), &labels)?];

        let path = if chosen == EnvVarType::DevUrl {
            let existing_path = files[file][key].path.clone().unwrap_or_default();
            let entered = prompt::input_optional(
                "Path after the port (e.g. /api/auth/callback):",
                Some(&existing_path),
            )?;
            Some(entered).filter(|p| !p.is_empty())
        } else {
            None
        };

        files[file][key] = EnvVarConfig {
            var_type: chosen,
            path,
        };

        println!();
        print_env_table(files, values);
    }
}

// Collect an ordered command sequence for one scope. When `flag` is non-empty
// it wins outright (skip prompting). Otherwise the first prompt defaults to the
// existing sequence (or `defaults`), and we keep asking for the next command
// until the user submits a blank line.
fn prompt_scope(
    flag: Vec<String>,
    label: &str,
    defaults: &[&str],
    existing: &[String],
) -> Result<Vec<String>> {
    if !flag.is_empty() {
        return Ok(flag);
    }

    // Seed prompts from the stored sequence, falling back to sensible defaults.
    let seed: Vec<String> = if existing.is_empty() {
        defaults.iter().map(|s| s.to_string()).collect()
    } else {
        existing.to_vec()
    };

    let mut cmds = Vec::new();
    let mut i = 0;
    loop {
        let msg = if i == 0 {
            format!("{label} command:")
        } else {
            format!("{label} command #{} (blank to finish):", i + 1)
        };
        // Seed as editable initial text, not a dialoguer default — a default
        // would refill on blank submit and "blank to finish" could never fire.
        let value = prompt::input_optional(&msg, seed.get(i).map(|s| s.as_str()))?;
        if value.trim().is_empty() {
            break;
        }
        cmds.push(value);
        i += 1;
    }
    Ok(cmds)
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

    // Existing registration (matched by cwd) seeds the alias prompt. A config
    // that no longer parses would otherwise dead-loop ("run ship init" → init
    // fails the same way), so init discards it and starts fresh.
    let ship_config = match config::load_config() {
        Ok(c) => c,
        Err(Error::ConfigOutdated { .. }) | Err(Error::ParseConfig { .. }) => {
            println!(
                "  {}",
                dim("Existing config could not be parsed — starting fresh.")
            );
            println!();
            config::delete_config()?;
            ShipConfig::default()
        }
        Err(e) => return Err(e),
    };
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
    let default_path = existing
        .as_ref()
        .map(|e| e.path.clone())
        .unwrap_or_else(|| cwd.clone());
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
    let mut detected_files: IndexMap<String, EnvFileVars> = IndexMap::new();
    let mut env_values: EnvValues = IndexMap::new();

    for env in &detected {
        let mut vars: EnvFileVars = IndexMap::new();
        let mut file_values: IndexMap<String, String> = IndexMap::new();

        for (key, value, var_type) in &env.vars {
            vars.insert(
                key.clone(),
                EnvVarConfig {
                    var_type: *var_type,
                    path: None,
                },
            );
            file_values.insert(key.clone(), value.clone());

            // A sqlite/file: URL parses to None, so a local DATABASE_URL never
            // clobbers the postgres connection details.
            if *var_type == EnvVarType::DatabaseUrl && key == "DATABASE_URL" {
                if let Some(parsed) = parse_database_url(value) {
                    inferred_db_user = parsed.user;
                    inferred_db_host = parsed.host;
                    inferred_db_port = parsed.port;
                    inferred_db_source = parsed.database;
                }
            }
        }

        detected_files.insert(env.file.clone(), vars);
        env_values.insert(env.file.clone(), file_values);
    }

    // Stored choices win over fresh detection — a var you moved to "leave
    // untouched" must not flip back on the next init.
    let mut env_files = detected_files;
    if let Some(e) = &existing {
        for (file, vars) in &e.env.files {
            let entry = env_files.entry(file.clone()).or_default();
            for (key, cfg) in vars {
                entry.insert(key.clone(), cfg.clone());
            }
        }
    }

    if env_files.is_empty() {
        println!("    {}", dim("No .env files with recognized variables."));
    } else {
        print_env_table(&env_files, &env_values);
        review_env_vars(&mut env_files, &env_values)?;
    }

    // 3b. Local state to copy into each worktree.
    println!();
    println!("  Scanning for local state files...");
    let detected_copy = detect_copy_paths(Path::new(&cwd));
    let stored_copy = existing
        .as_ref()
        .map(|e| e.copy.clone())
        .unwrap_or_default();
    let copy_paths = if detected_copy.is_empty() && stored_copy.is_empty() {
        println!("    {}", dim("None found."));
        Vec::new()
    } else {
        review_copy_paths(&cwd, detected_copy, &stored_copy)?
    };

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
    let db_container = resolve(
        opts.db_container,
        "Database container name:",
        &existing_container,
    )?;
    let db_user = resolve(opts.db_user, "Database user:", &inferred_db_user)?;
    let db_source = resolve(
        opts.db_source,
        "Source database to clone from:",
        &inferred_db_source,
    )?;

    // 5. Command scopes — each an ordered sequence, blank line ends the scope.
    let existing_cmds = existing
        .as_ref()
        .map(|e| e.commands.clone())
        .unwrap_or_default();
    println!();
    let install_cmds = prompt_scope(
        opts.install_cmd,
        "Install",
        &["pnpm install", "pnpm db generate"],
        &existing_cmds.install,
    )?;
    let db_cmds = prompt_scope(
        opts.db_cmd,
        "Database setup",
        &["pnpm db migrate:deploy"],
        &existing_cmds.db,
    )?;
    let dev_cmds = prompt_scope(
        opts.dev_cmd,
        "Dev",
        &["pnpm dev -p {port}"],
        &existing_cmds.dev,
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

    // 7. Build the config — keep customized worktree patterns.
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
            install: install_cmds,
            db: db_cmds,
            dev: dev_cmds,
        },
        env: EnvConfig { files: env_files },
        copy: copy_paths,
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
        if existing.is_some() {
            "updated"
        } else {
            "registered"
        }
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
