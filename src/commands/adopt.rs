use super::create::{finish_provision, print_ready, provision_and_print_workspace};
use crate::errors::{Error, Result};
use crate::services::workspace::ProvisionInput;
use crate::services::{config, git};
use crate::util::cwd_string;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship adopt
//
// Provision the checkout in the current directory: the project whose main
// checkout this worktree belongs to, HEAD's branch. Never opens an editor —
// another tool made the worktree and owns the window.
// ---------------------------------------------------------------------------

pub fn run() -> ExitCode {
    finish_provision(adopt_checkout(&cwd_string()))
}

fn adopt_checkout(cwd: &str) -> Result<()> {
    let main_checkout = git::main_checkout_path(cwd)?;
    let checkout = git::checkout_root_path(cwd)?;
    let ship_config = config::load_config()?;
    let Some((project, project_config)) = ship_config
        .projects
        .iter()
        .find(|(_, p)| p.path.trim_end_matches('/') == main_checkout)
    else {
        return Err(Error::NotInProjectCheckout { path: checkout });
    };
    if checkout == main_checkout {
        return Err(Error::AdoptMainCheckout { path: checkout });
    }
    let Some(branch) = git::current_branch(cwd)? else {
        return Err(Error::DetachedHead { path: checkout });
    };

    let outcome = provision_and_print_workspace(&ProvisionInput {
        project_alias: project,
        project_config,
        branch: &branch,
        base_branch: None,
        bare: false,
    })?;
    if !outcome.already_complete {
        print_ready();
    }
    Ok(())
}
