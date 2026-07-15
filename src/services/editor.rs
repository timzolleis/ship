use crate::fmt::{bold, dim};
use crate::services::{config, shell};
use std::path::Path;

/// GUI editors: cmd is the CLI binary, app is the macOS .app name.
const GUI_EDITORS: &[(&str, &str)] = &[
    ("zed", "Zed"),
    ("cursor", "Cursor"),
    ("code", "Visual Studio Code"),
    ("subl", "Sublime Text"),
];

const TERMINAL_EDITORS: &[&str] = &["nvim", "vim", "vi"];

fn try_exec(cmd: &str, args: &[&str]) -> bool {
    shell::exec(cmd, args).is_ok()
}

fn app_exists(app: &str) -> bool {
    Path::new(&format!("/Applications/{app}.app")).exists()
}

/// Try to open path: CLI command first, then `open -a` fallback for GUI editors.
/// GUI editors get `-n` so ship opens a new window instead of hijacking the
/// focused one — their default is to reuse the active window.
fn open_with(editor: &str, path: &str) -> bool {
    if let Some((_, app)) = GUI_EDITORS.iter().find(|(cmd, _)| *cmd == editor) {
        return try_exec(editor, &["-n", path]) || try_exec("open", &["-n", "-a", app, path]);
    }
    try_exec(editor, &[path])
}

/// Detect best available editor without opening anything.
fn detect() -> String {
    for var in ["VISUAL", "EDITOR"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                return v;
            }
        }
    }
    for (cmd, app) in GUI_EDITORS {
        if app_exists(app) {
            return cmd.to_string();
        }
    }
    for cmd in TERMINAL_EDITORS {
        if try_exec("which", &[cmd]) {
            return cmd.to_string();
        }
    }
    "vi".to_string()
}

/// Never fails: prints progress and persists the detected editor on success.
pub fn open(path: &str) {
    let mut ship_config = config::load_config().unwrap_or_default();

    if let Some(saved) = ship_config.editor.clone() {
        println!("  Opening in {}...", bold(&saved));
        if open_with(&saved, path) {
            return;
        }
        println!("  {}", dim(format!("{saved} failed, detecting another...")));
    }

    let editor = detect();
    println!("  Opening in {}...", bold(&editor));

    if open_with(&editor, path) {
        ship_config.editor = Some(editor);
        let _ = config::save_config(&ship_config);
    } else {
        println!("  {}", dim("No editor found. Set $EDITOR or $VISUAL."));
    }
}
