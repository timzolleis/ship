use crate::errors::Result;
use crate::fmt::{bold, dim, green};
use crate::services::updater;
use crate::version::VERSION;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship update — download and install the latest release
// ---------------------------------------------------------------------------

pub fn run() -> ExitCode {
    match run_inner() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run_inner() -> Result<()> {
    println!("{} {}", dim("Current:"), VERSION);

    let latest = updater::fetch_latest_version()?;
    if latest == VERSION {
        println!("{} {}  {}", dim("Latest: "), latest, dim("(up to date)"));
        return Ok(());
    }

    println!(
        "{} {}  {}",
        dim("Latest: "),
        bold(&latest),
        dim("(updating…)")
    );
    updater::install_latest(&latest)?;
    println!("{}", green(format!("✓ Updated to {latest}.")));
    println!("{}", dim("Run 'ship --version' to confirm."));
    Ok(())
}
