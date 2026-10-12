use crate::domain::detect::{DatabaseFound, Field, LeftEmpty};
use crate::errors::{Error, Result};
use crate::fmt::{blue, bold, dim, green, yellow};
use crate::prompt::{self, Unattended};
use crate::schema::{
    CommandsConfig, DatabaseConfig, EnvConfig, EnvFileVars, EnvVarConfig, EnvVarType,
    ExecutionRuntime, ProjectConfig, ShipConfig, WorktreeConfig,
};
use crate::services::detect::{self, EnvValues};
use crate::services::{config, copy, proxy};
use crate::ui::{self, Row, Table};
use crate::util::cwd_string;
use indexmap::IndexMap;
use std::path::Path;
use std::process::ExitCode;

#[derive(clap::Args)]
pub struct InitArgs {
    /// Short project name used in commands, domains, and database names (default: first 3 letters of the directory)
    #[arg(long)]
    alias: Option<String>,
    /// Repo root to register (default: the current directory)
    #[arg(long)]
    path: Option<String>,
    /// Docker container running postgres (default: the container publishing DATABASE_URL's port)
    #[arg(long)]
    db_container: Option<String>,
    /// Postgres user (default: from DATABASE_URL)
    #[arg(long)]
    db_user: Option<String>,
    /// Database each workspace clones from (default: from DATABASE_URL)
    #[arg(long)]
    db_source: Option<String>,
    /// Install command; repeat for a sequence (default: detected from the lockfile)
    #[arg(long)]
    install_cmd: Vec<String>,
    /// Database setup command, e.g. migrations; repeat for a sequence (default: detected prisma/drizzle)
    #[arg(long)]
    db_cmd: Vec<String>,
    /// Dev server command; repeat for a sequence. ship sets PORT, and {port} is substituted (default: the package.json dev script)
    #[arg(long)]
    dev_cmd: Vec<String>,
}

fn resolve(opt: Option<String>, msg: &str, default: &str, hint: &str) -> Result<String> {
    match opt {
        Some(v) => Ok(v),
        None => prompt::input(msg, Some(default), hint),
    }
}

// ---------------------------------------------------------------------------
// Copy paths
// ---------------------------------------------------------------------------

// Checkbox list. Everything detected starts checked on a first init; once the
// project has a stored list, only stored paths start checked — so a path you
// deselected stays deselected instead of silently coming back. Unattended
// runs keep what starts checked.
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
    let picked = prompt::multi_select("Copy into new workspaces? (space toggles)", &items)?;
    if !ui::interactive() {
        for i in &picked {
            println!("    {} {}", green("✓"), dim(&items[*i].0));
        }
    }
    Ok(picked.into_iter().map(|i| paths[i].clone()).collect())
}

// ---------------------------------------------------------------------------
// Env review
// ---------------------------------------------------------------------------

fn truncate(value: &str, max: usize) -> String {
    let short: String = value.chars().take(max).collect();
    if value.chars().count() > max {
        format!("{short}…")
    } else {
        short
    }
}

fn print_env_table(files: &IndexMap<String, EnvFileVars>, values: &EnvValues) {
    let groups: Vec<(&String, Vec<Row<()>>)> = files
        .iter()
        .map(|(file, vars)| {
            let rows = if vars.is_empty() {
                vec![Row::new(
                    (),
                    [
                        "—".to_string(),
                        String::new(),
                        dim("copied, nothing rewritten"),
                    ],
                )]
            } else {
                vars.iter()
                    .map(|(key, cfg)| {
                        let value = values
                            .get(file)
                            .and_then(|v| v.get(key))
                            .map(|v| truncate(v, 44))
                            .unwrap_or_else(|| "(not present)".to_string());
                        Row::new((), [key.clone(), dim(value), green(cfg.var_type.label())])
                    })
                    .collect()
            };
            (file, rows)
        })
        .collect();

    // One width across every file, so the columns line up under each heading.
    let table = groups
        .iter()
        .flat_map(|(_, rows)| rows)
        .fold(Table::measure::<()>(&[]), |table, row| table.widen(row));
    for (file, rows) in &groups {
        println!("    {}", blue(file));
        for row in rows {
            println!("      {}", table.line(row, ""));
        }
    }
}

// Confirm-then-fix: detection proposes, enter accepts, and only the wrong rows
// cost keystrokes. Unattended runs accept detection.
fn review_env_vars(files: &mut IndexMap<String, EnvFileVars>, values: &EnvValues) -> Result<()> {
    if files.values().all(|vars| vars.is_empty()) {
        return Ok(());
    }

    loop {
        println!();
        if !prompt::confirm(
            "Change how any of these are handled?",
            false,
            Unattended::Answer(false),
        )? {
            return Ok(());
        }

        // Flat row list so picking a var is one selection, not file-then-var.
        // `None` is the trailing "Done" row.
        let mut rows: Vec<Row<Option<(String, String)>>> = files
            .iter()
            .flat_map(|(file, vars)| {
                vars.iter().map(move |(key, cfg)| {
                    Row::new(
                        Some((file.clone(), key.clone())),
                        [blue(file), bold(key), green(cfg.var_type.label())],
                    )
                })
            })
            .collect();
        rows.push(Row::new(None, [dim("Done")]));

        // Only reached interactively: the confirm above answers no otherwise.
        let picked = prompt::pick("Which variable?", &["FILE", "VAR", "HANDLING"], rows, "")?;
        let Some((file, key)) = picked.as_ref() else {
            return Ok(());
        };

        let current = files[file][key].var_type;
        // Current handling first so enter keeps it (the picker starts on row 0).
        let choices: Vec<EnvVarType> = std::iter::once(current)
            .chain(EnvVarType::ALL.into_iter().filter(|t| *t != current))
            .collect();
        let rows = choices
            .into_iter()
            .map(|t| Row::new(t, [green(t.label()), dim(t.help())]))
            .collect();
        let chosen = prompt::pick(
            &format!("Handling for {key}"),
            &["HANDLING", "DETAIL"],
            rows,
            "",
        )?;

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
// it wins outright (skip prompting). Otherwise the prompts start from `seed` —
// the stored or detected sequence — and keep asking for the next command until
// a blank line. Unattended runs take the seed as is.
fn prompt_scope(flag: Vec<String>, label: &str, seed: &[String]) -> Result<Vec<String>> {
    if !flag.is_empty() {
        return Ok(flag);
    }

    let mut cmds = Vec::new();
    let mut i = 0;
    loop {
        let msg = if i == 0 {
            format!("{label} command (blank for none):")
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
// Database
// ---------------------------------------------------------------------------

/// Confirm or override the database: stored config on re-init, else what
/// detection found. Flags win; no database means no prompts.
fn resolve_database(
    alias: &str,
    stored: Option<DatabaseConfig>,
    found: Option<DatabaseFound>,
    opts: &mut InitArgs,
) -> Result<Option<DatabaseConfig>> {
    let base = stored.or_else(|| {
        found.map(|found| DatabaseConfig {
            runtime: found.runtime,
            user: found.user,
            source: found.source,
            host: found.host,
            port: found.port,
            name_pattern: format!("{alias}_{{branch_slug_safe}}"),
        })
    });
    let Some(mut db) = base else {
        return Ok(None);
    };

    println!();
    println!("  Database:");
    println!(
        "    Server           {}:{} {}",
        blue(&db.host),
        blue(db.port),
        dim(match &db.runtime {
            ExecutionRuntime::Docker { container } => format!("(docker: {container})"),
            ExecutionRuntime::Local => "(local)".to_string(),
        })
    );
    println!("    User             {}", blue(&db.user));
    println!("    Source database  {}", blue(&db.source));
    println!();

    if let ExecutionRuntime::Docker { container } = &db.runtime {
        let container = resolve(
            opts.db_container.take(),
            "Database container name:",
            container,
            "--db-container",
        )?;
        db.runtime = ExecutionRuntime::Docker { container };
    } else if let Some(container) = opts.db_container.take() {
        db.runtime = ExecutionRuntime::Docker { container };
    }
    db.user = resolve(opts.db_user.take(), "Database user:", &db.user, "--db-user")?;
    db.source = resolve(
        opts.db_source.take(),
        "Source database to clone from:",
        &db.source,
        "--db-source",
    )?;
    Ok(Some(db))
}

// ---------------------------------------------------------------------------
// Left empty
// ---------------------------------------------------------------------------

/// What detection could not fill and nothing else (stored config, flags,
/// prompts) filled either.
fn still_empty(left: Vec<LeftEmpty>, project: &ProjectConfig) -> Vec<LeftEmpty> {
    left.into_iter()
        .filter(|l| match l.field {
            Field::Install => project.commands.install.is_empty(),
            Field::Db => project.commands.db.is_empty(),
            Field::Dev => project.commands.dev.is_empty(),
            Field::Database => project.database.is_none(),
        })
        .collect()
}

fn print_left_empty(left: &[LeftEmpty]) {
    if left.is_empty() {
        return;
    }
    let rows: Vec<Row<()>> = left
        .iter()
        .map(|l| Row::new((), [l.field.key().to_string(), dim(&l.reason)]))
        .collect();
    let table = Table::measure(&rows);
    println!(
        "  {} Left empty \u{2014} no evidence in the repo:",
        yellow("⚠")
    );
    for row in &rows {
        println!("    {}", table.line(row, ""));
    }
    println!(
        "  {}",
        dim(format!(
            "Fill these in {} if the project needs them, then check: ship config show --json",
            config::config_path().display()
        ))
    );
    println!();
}

// ---------------------------------------------------------------------------
// ship init
// ---------------------------------------------------------------------------

pub fn run(args: InitArgs) -> ExitCode {
    match run_inner(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run_inner(mut opts: InitArgs) -> Result<()> {
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
    let alias = resolve(
        opts.alias.take(),
        "Project alias:",
        &default_alias,
        "--alias",
    )?;

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
    let project_path = resolve(opts.path.take(), "Project path:", &default_path, "--path")?;

    // 3. Read the repo.
    println!();
    println!("  Scanning the repo...");
    let mut detected = detect::scan(Path::new(&cwd), opts.db_container.as_deref());
    let left_empty = std::mem::take(&mut detected.left_empty);

    // Stored choices win over fresh detection — a var you moved to "leave
    // untouched" must not flip back on the next init.
    let mut env_files = std::mem::take(&mut detected.env);
    if let Some(e) = &existing {
        for (file, vars) in &e.env.files {
            let entry = env_files.entry(file.clone()).or_default();
            for (key, cfg) in vars {
                entry.insert(key.clone(), cfg.clone());
            }
        }
    }

    if env_files.is_empty() {
        println!("    {}", dim("No .env files."));
    } else {
        print_env_table(&env_files, &detected.env_values);
        review_env_vars(&mut env_files, &detected.env_values)?;
    }

    // 3b. Local state to copy into each worktree.
    let detected_copy = std::mem::take(&mut detected.copy);
    let stored_copy = existing
        .as_ref()
        .map(|e| e.copy.clone())
        .unwrap_or_default();
    let copy_paths = if detected_copy.is_empty() && stored_copy.is_empty() {
        Vec::new()
    } else {
        review_copy_paths(&cwd, detected_copy, &stored_copy)?
    };

    // 4. Database: stored, else detected, else none.
    let detected_commands = std::mem::take(&mut detected.commands);
    let database = resolve_database(
        &alias,
        existing.as_ref().and_then(|e| e.database.clone()),
        detected.database.take(),
        &mut opts,
    )?;

    // 5. Command scopes — each an ordered sequence, blank line ends the scope.
    // A stored sequence wins over detection.
    let stored_cmds = existing
        .as_ref()
        .map(|e| e.commands.clone())
        .unwrap_or_default();
    let seed = |stored: &[String], found: &[String]| -> Vec<String> {
        if stored.is_empty() { found } else { stored }.to_vec()
    };
    println!();
    let install_cmds = prompt_scope(
        std::mem::take(&mut opts.install_cmd),
        "Install",
        &seed(&stored_cmds.install, &detected_commands.install),
    )?;
    let db_cmds = prompt_scope(
        std::mem::take(&mut opts.db_cmd),
        "Database setup",
        &seed(&stored_cmds.db, &detected_commands.db),
    )?;
    let dev_cmds = prompt_scope(
        std::mem::take(&mut opts.dev_cmd),
        "Dev",
        &seed(&stored_cmds.dev, &detected_commands.dev),
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
        database,
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
            }),
    };
    let left_empty = still_empty(left_empty, &project);

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
    print_left_empty(&left_empty);
    Ok(())
}
