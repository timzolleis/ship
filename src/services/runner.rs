use crate::errors::Result;
use crate::schema::ExecutionRuntime;
use crate::services::shell::{self, ExecResult};

// Resolves an ExecutionRuntime (per-call data) onto the shell.
// local → passthrough; docker → `docker exec <container> ...`.

pub fn run(rt: &ExecutionRuntime, command: &str, args: &[&str]) -> Result<ExecResult> {
    match rt {
        ExecutionRuntime::Docker { container } => {
            let mut full: Vec<&str> = vec!["exec", container, command];
            full.extend_from_slice(args);
            shell::exec("docker", &full)
        }
        ExecutionRuntime::Local => shell::exec(command, args),
    }
}

pub fn run_script(rt: &ExecutionRuntime, script: &str) -> Result<ExecResult> {
    match rt {
        ExecutionRuntime::Docker { container } => {
            shell::exec("docker", &["exec", container, "bash", "-c", script])
        }
        ExecutionRuntime::Local => shell::exec("sh", &["-c", script]),
    }
}

pub fn run_interactive(rt: &ExecutionRuntime, command: &str, args: &[&str]) -> Result<()> {
    match rt {
        ExecutionRuntime::Docker { container } => {
            let mut full: Vec<&str> = vec!["exec", "-it", container, command];
            full.extend_from_slice(args);
            shell::exec_interactive("docker", &full)
        }
        ExecutionRuntime::Local => shell::exec_interactive(command, args),
    }
}
