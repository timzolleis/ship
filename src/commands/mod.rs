pub mod config;
pub mod create;
pub mod db;
pub mod down;
pub mod gc;
pub mod index;
pub mod init;
pub mod list;
pub mod open;
pub mod projects;
pub mod proxy;
pub mod reset;
pub mod sync;
pub mod teardown;
pub mod up;
pub mod update;

use crate::errors::{Error, Result};
use crate::fmt::red;
use std::process::ExitCode;

/// `--json` output: pretty JSON on stdout and nothing else, so it pipes into
/// `jq` or an agent as is. Errors still go to stderr with exit 1.
pub fn print_json(value: &impl serde::Serialize) -> Result<()> {
    let json = serde_json::to_string_pretty(value).map_err(|e| Error::EncodeConfig {
        detail: e.to_string(),
    })?;
    println!("{json}");
    Ok(())
}

/// Exit status for a command that prints its error in the shared format.
/// Agents read the status, so an error must never exit 0.
pub fn finish(result: Result<()>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("\n  {} {}\n", red("Error:"), e);
            ExitCode::FAILURE
        }
    }
}

/// `finish` for a command whose `Ok` can still mean "some of it failed" —
/// `down`, `gc`: the summary is printed, the status says whether it all landed.
pub fn finish_with(result: Result<ExitCode>) -> ExitCode {
    match result {
        Ok(code) => code,
        Err(e) => finish(Err(e)),
    }
}
