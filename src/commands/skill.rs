use crate::errors::{Error, Result};
use crate::fmt::{dim, green};
use crate::services::config;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship skill [install [--dir <path>]]
// ---------------------------------------------------------------------------

/// Embedded so the skill always matches the binary that runs it.
const SKILL: &str = include_str!("../../skills/ship/SKILL.md");

#[derive(clap::Subcommand)]
pub enum SkillCmd {
    /// Write the skill to <dir>/ship/SKILL.md
    Install {
        /// Skills directory (default: ~/.agents/skills)
        #[arg(long)]
        dir: Option<String>,
    },
}

pub fn run(cmd: Option<SkillCmd>) -> ExitCode {
    match cmd {
        None => {
            print!("{SKILL}");
            ExitCode::SUCCESS
        }
        Some(SkillCmd::Install { dir }) => super::finish(install(dir)),
    }
}

fn install(dir: Option<String>) -> Result<()> {
    let dir = dir
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(config::home_dir())
                .join(".agents")
                .join("skills")
        })
        .join("ship");
    fs::create_dir_all(&dir).map_err(|e| Error::CreateDirectory {
        path: dir.display().to_string(),
        detail: e.to_string(),
    })?;
    let path = dir.join("SKILL.md");
    fs::write(&path, SKILL).map_err(|e| Error::WriteFile {
        path: path.display().to_string(),
        detail: e.to_string(),
    })?;
    println!("  {} Installed {}", green("✓"), path.display());
    println!(
        "  {}",
        dim("Re-run after `ship update` to keep it current.")
    );
    Ok(())
}
