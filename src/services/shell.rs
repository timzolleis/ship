use crate::errors::{Error, Result};
use std::process::Command;

// Lifecycle commands (install/generate/migrate/seed) run without a controlling
// prompt loop — CI=true makes tools like pnpm 11 skip interactive
// confirmations instead of hanging or erroring.
pub const NON_INTERACTIVE_ENV: &[(&str, &str)] = &[("CI", "true")];

pub struct ExecResult {
    pub stdout: String,
}

fn label(command: &str, args: &[&str]) -> String {
    format!("{command} {}", args.join(" "))
}

fn exec_opt(command: &str, args: &[&str], cwd: Option<&str>) -> Result<ExecResult> {
    let lbl = label(command, args);
    let mut cmd = Command::new(command);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd.output().map_err(|e| Error::ShellExec {
        command: lbl.clone(),
        stderr: e.to_string(),
    })?;
    if !out.status.success() {
        let code = out.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let trimmed = stderr.trim();
        return Err(Error::ShellExec {
            command: lbl,
            stderr: if trimmed.is_empty() {
                format!("Process exited with code {code}")
            } else {
                trimmed.to_string()
            },
        });
    }
    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
    })
}

pub fn exec(command: &str, args: &[&str]) -> Result<ExecResult> {
    exec_opt(command, args, None)
}

pub fn exec_in(cwd: &str, command: &str, args: &[&str]) -> Result<ExecResult> {
    exec_opt(command, args, Some(cwd))
}

/// Inherits stdio. A nonzero exit is deliberately NOT an error (parity with
/// the TS version, which surfaced only spawn failures for streamed commands).
pub fn exec_interactive(command: &str, args: &[&str]) -> Result<()> {
    Command::new(command)
        .args(args)
        .status()
        .map_err(|e| Error::ShellExec {
            command: label(command, args),
            stderr: e.to_string(),
        })?;
    Ok(())
}

/// Runs `sh -c <script>` in `cwd` with inherited stdio. Nonzero exit is not an
/// error — see exec_interactive.
pub fn exec_in_dir(cwd: &str, script: &str, env: &[(&str, &str)]) -> Result<()> {
    let mut cmd = Command::new("sh");
    cmd.args(["-c", script]).current_dir(cwd);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.status().map_err(|e| Error::ShellExec {
        command: script.to_string(),
        stderr: e.to_string(),
    })?;
    Ok(())
}
