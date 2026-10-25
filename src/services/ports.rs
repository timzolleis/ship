use crate::domain::ports::{self, PortProblem, BASE_PORT};
use crate::errors::{Error, Result};
use crate::schema::ProjectConfig;
use crate::services::{config, proxy};
use indexmap::IndexMap;
use std::collections::HashSet;

/// Every port ship has handed out: routes, root checkouts' ports and named
/// ports, and each workspace's. A file that can't be read fails: a made-up
/// port could collide.
pub fn used() -> Result<HashSet<u16>> {
    let mut used: HashSet<u16> = proxy::get_routes()?.iter().map(|r| r.port).collect();
    for project in config::load_config()?.projects.values() {
        used.extend(project.port);
        used.extend(project.ports.values());
    }
    for ws in config::load_workspaces()? {
        used.insert(ws.port);
        used.extend(ws.ports.values());
    }
    Ok(used)
}

/// The next free port in the shared pool.
pub fn next_free() -> Result<u16> {
    Ok(ports::next_free(&used()?, BASE_PORT))
}

/// Fails before anything runs when the project's ports can't work.
pub fn check(pc: &ProjectConfig) -> Result<()> {
    match ports::check(&pc.ports, &pc.env) {
        None => Ok(()),
        Some(PortProblem::InvalidName(name)) => Err(Error::InvalidPortName { name }),
        Some(PortProblem::UnknownName { file, var, name }) => Err(Error::UnknownPort {
            name,
            place: format!("{var} in {file}"),
        }),
    }
}

/// A command with its placeholders filled in.
pub fn substitute(command: &str, port: u16, named: &IndexMap<String, u16>) -> Result<String> {
    ports::substitute(command, port, named).map_err(|name| Error::UnknownPort {
        name,
        place: format!("the command '{command}'"),
    })
}
