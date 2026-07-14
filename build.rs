use std::process::Command;

fn main() {
    // CI sets SHIP_VERSION explicitly so the embedded version always matches
    // the release tag; local builds fall back to the git short SHA.
    let sha = std::env::var("SHIP_VERSION")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "--short", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .unwrap_or_else(|| "dev".to_string());
    println!("cargo:rustc-env=SHIP_GIT_SHA={sha}");
    println!("cargo:rerun-if-env-changed=SHIP_VERSION");
    println!("cargo:rerun-if-changed=.git/HEAD");
}
