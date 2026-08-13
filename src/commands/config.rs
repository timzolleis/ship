use crate::errors::{Error, Result};
use crate::fmt::{blue, bold, dim, green, red, yellow};
use crate::schema::{EnvVarType, ProjectConfig};
use crate::services::config;
use crate::util::cwd_string;

#[derive(clap::Subcommand)]
pub enum ConfigCmd {
    /// Show a project's config with the file path and line numbers
    Show {
        alias: Option<String>,
        /// Show every registered project
        #[arg(long, short = 'a')]
        all: bool,
    },
}

// ---------------------------------------------------------------------------
// JSON line map
//
// Character scan (not line-based) so hand-edited files with several keys on one
// line still report every key. Skipping string contents keeps braces inside
// values — worktree patterns like "{branch_slug}" — from looking like nesting.
// ---------------------------------------------------------------------------

struct LineMap(Vec<(Vec<String>, usize)>);

impl LineMap {
    fn build(json: &str) -> Self {
        let mut out: Vec<(Vec<String>, usize)> = Vec::new();
        let mut path: Vec<String> = Vec::new();
        let mut last_key: Option<String> = None;
        let mut line = 1usize;

        let chars: Vec<char> = json.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '\n' => line += 1,
                '"' => {
                    let start_line = line;
                    let mut text = String::new();
                    i += 1;
                    while i < chars.len() && chars[i] != '"' {
                        if chars[i] == '\\' && i + 1 < chars.len() {
                            i += 1;
                        } else if chars[i] == '\n' {
                            line += 1;
                        }
                        text.push(chars[i]);
                        i += 1;
                    }
                    // A string is a key when a colon follows it.
                    let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
                    if next == Some(&':') {
                        // The root object contributes a leading empty segment.
                        let full: Vec<String> = path
                            .iter()
                            .skip_while(|s| s.is_empty())
                            .cloned()
                            .chain(std::iter::once(text.clone()))
                            .collect();
                        out.push((full, start_line));
                        last_key = Some(text);
                    }
                }
                '{' | '[' => path.push(last_key.take().unwrap_or_default()),
                '}' | ']' => {
                    path.pop();
                    last_key = None;
                }
                ',' => last_key = None,
                _ => {}
            }
            i += 1;
        }
        Self(out)
    }

    fn line_of(&self, path: &[&str]) -> Option<usize> {
        self.0
            .iter()
            .find(|(p, _)| p.len() == path.len() && p.iter().zip(path).all(|(a, b)| a == b))
            .map(|(_, line)| *line)
    }
}

// ---------------------------------------------------------------------------
// ship config show
// ---------------------------------------------------------------------------

pub fn run(cmd: Option<ConfigCmd>) {
    let result = match cmd {
        Some(ConfigCmd::Show { alias, all }) => show(alias, all),
        None => show(None, false),
    };
    if let Err(e) = result {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
}

fn show(alias: Option<String>, all: bool) -> Result<()> {
    let path = config::config_path();
    println!();
    println!("  {}  {}", bold("Config"), blue(path.display()));

    let Some(raw) = config::read_config_raw()? else {
        println!();
        println!(
            "  {}",
            dim("No config yet. Register a project with: ship init")
        );
        println!();
        return Ok(());
    };
    let lines = LineMap::build(&raw);

    // A config too old to parse still gets the path printed above — that is the
    // one thing you need to go fix it by hand.
    let ship_config = config::load_config()?;
    if ship_config.projects.is_empty() {
        println!();
        println!(
            "  {}",
            dim("No projects registered. Add one with: ship init")
        );
        println!();
        return Ok(());
    }

    let cwd = cwd_string();
    let selected: Vec<(String, ProjectConfig)> =
        if all {
            ship_config.projects.into_iter().collect()
        } else {
            let resolved = match alias {
                Some(a) => Some(a),
                None => ship_config
                    .projects
                    .iter()
                    .find(|(_, p)| cwd == p.path || cwd.starts_with(&format!("{}/", p.path)))
                    .map(|(a, _)| a.clone()),
            };
            let Some(alias) = resolved else {
                let aliases: Vec<&str> = ship_config.projects.keys().map(|a| a.as_str()).collect();
                println!();
                println!(
                    "  {}",
                    dim("Not inside a registered project. Name one, or use --all:")
                );
                println!("    {}", aliases.join(", "));
                println!();
                return Ok(());
            };
            let project = ship_config.projects.get(&alias).cloned().ok_or_else(|| {
                Error::ProjectNotFound {
                    alias: alias.clone(),
                }
            })?;
            vec![(alias, project)]
        };

    for (alias, project) in &selected {
        print_project(alias, project, &lines);
    }
    print_legend();
    Ok(())
}

fn print_project(alias: &str, project: &ProjectConfig, lines: &LineMap) {
    let project_line = lines
        .line_of(&["projects", alias])
        .map(|l| format!("line {l}"))
        .unwrap_or_default();

    println!();
    println!(
        "  {}  {}  {}",
        bold(alias),
        blue(&project.path),
        dim(project_line)
    );

    if project.env.files.is_empty() {
        println!("  {}", dim("No .env files configured."));
        return;
    }

    // A config still on the flat `autoDetected` shape has no per-file keys to
    // point at, so line numbers fall back to the shared entry — which is why
    // every file repeats it.
    let mut flat_shape = false;

    let file_width = project
        .env
        .files
        .keys()
        .map(|f| f.len())
        .max()
        .unwrap_or(0)
        .max(8);
    let key_width = project
        .env
        .files
        .values()
        .flat_map(|vars| vars.keys())
        .map(|k| k.len())
        .max()
        .unwrap_or(0)
        .max(3);
    let handling_width = EnvVarType::ALL
        .iter()
        .map(|t| t.label().len())
        .max()
        .unwrap_or(0);

    println!();
    println!(
        "  {:<file_width$}  {:<key_width$}  {:<handling_width$}  LINE",
        "ENV FILE", "VAR", "HANDLING"
    );
    println!(
        "  {}  {}  {}  {}",
        dim("─".repeat(file_width)),
        dim("─".repeat(key_width)),
        dim("─".repeat(handling_width)),
        dim("────")
    );

    for (file, vars) in &project.env.files {
        if vars.is_empty() {
            let line = lines
                .line_of(&["projects", alias, "env", "files", file])
                .map(|l| l.to_string())
                .unwrap_or_default();
            println!(
                "  {}  {:<key_width$}  {:<handling_width$}  {}",
                blue(format!("{file:<file_width$}")),
                "—",
                dim("copied, nothing rewritten"),
                dim(line)
            );
            continue;
        }

        let mut first = true;
        for (key, cfg) in vars {
            let file_cell = if first { file.as_str() } else { "" };
            first = false;
            let line = match lines.line_of(&["projects", alias, "env", "files", file, key]) {
                Some(l) => l.to_string(),
                None => match lines.line_of(&["projects", alias, "env", "autoDetected", key]) {
                    Some(l) => {
                        flat_shape = true;
                        l.to_string()
                    }
                    None => String::new(),
                },
            };
            let handling = match (&cfg.var_type, &cfg.path) {
                (EnvVarType::DevUrl, Some(p)) => format!("{} {p}", cfg.var_type.label()),
                _ => cfg.var_type.label().to_string(),
            };
            println!(
                "  {}  {:<key_width$}  {:<handling_width$}  {}",
                blue(format!("{file_cell:<file_width$}")),
                key,
                handling,
                dim(line)
            );
        }
    }

    if flat_shape {
        println!();
        println!(
            "  {}",
            yellow("This project shares one entry across all files (old format).")
        );
        println!(
            "  {}",
            dim("Run 'ship init' in the project to split it per file and set them apart.")
        );
    }

    print_copy_paths(alias, project, lines);
}

fn print_copy_paths(alias: &str, project: &ProjectConfig, lines: &LineMap) {
    println!();
    if project.copy.is_empty() {
        println!(
            "  {}",
            dim("COPIED INTO EACH WORKSPACE  none — add paths to \"copy\", or re-run ship init")
        );
        return;
    }

    let line = lines
        .line_of(&["projects", alias, "copy"])
        .map(|l| format!("line {l}"))
        .unwrap_or_default();
    println!("  COPIED INTO EACH WORKSPACE  {}", dim(line));
    for path in &project.copy {
        println!("    {}", blue(path));
    }
}

fn print_legend() {
    println!();
    println!(
        "  {}",
        dim("Handling — the JSON \"type\" field on each var:")
    );
    for t in EnvVarType::ALL {
        println!(
            "    {}  {}",
            green(format!("{:<13}", t.json_value())),
            dim(t.help())
        );
    }
    println!();
    println!(
        "  {}",
        dim("Edit the file directly to change these, or re-run: ship init")
    );
    println!();
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMPACT: &str = r#"{
  "projects": {
    "znb": {
      "env": { "files": {
        "apps/console/.env": { "BETTER_AUTH_URL": { "type": "proxy_url" }, "DATABASE_URL": { "type": "plain" } }
      } },
      "worktree": { "dirPattern": "../znb-{branch_slug}/" }
    }
  }
}"#;

    #[test]
    fn finds_keys_sharing_a_line() {
        let map = LineMap::build(COMPACT);
        let at = |p: &[&str]| map.line_of(p);

        assert_eq!(at(&["projects", "znb"]), Some(3));
        assert_eq!(
            at(&[
                "projects",
                "znb",
                "env",
                "files",
                "apps/console/.env",
                "BETTER_AUTH_URL"
            ]),
            Some(5)
        );
        assert_eq!(
            at(&[
                "projects",
                "znb",
                "env",
                "files",
                "apps/console/.env",
                "DATABASE_URL"
            ]),
            Some(5)
        );
    }

    // Braces inside worktree patterns must not be read as nesting.
    #[test]
    fn braces_in_values_do_not_shift_the_path() {
        let map = LineMap::build(COMPACT);
        assert_eq!(
            map.line_of(&["projects", "znb", "worktree", "dirPattern"]),
            Some(7)
        );
    }

    #[test]
    fn pretty_printed_keys_resolve() {
        let pretty = serde_json::to_string_pretty(
            &serde_json::from_str::<serde_json::Value>(COMPACT).unwrap(),
        )
        .unwrap();
        let map = LineMap::build(&pretty);
        let line = map
            .line_of(&[
                "projects",
                "znb",
                "env",
                "files",
                "apps/console/.env",
                "DATABASE_URL",
            ])
            .unwrap();
        assert!(pretty
            .lines()
            .nth(line - 1)
            .unwrap()
            .contains("DATABASE_URL"));
    }
}
