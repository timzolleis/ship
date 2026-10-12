use crate::errors::{Error, Result};
use crate::ui::{self, Picker, Row};

// Every prompt answers itself when there is no terminal (`ui::interactive`):
// it takes its safe default, or fails with `Error::NeedsInput` naming the flag
// or argument that answers it. Agents run without a TTY, and a prompt nobody
// can answer must neither hang nor guess.

// dialoguer's theme appends ": " itself, so trailing colons in ported
// prompt messages are stripped to avoid "Branch name:: ".
fn clean(msg: &str) -> String {
    msg.trim_end_matches(':').trim_end().to_string()
}

fn needs_input(msg: &str, hint: &str) -> Error {
    Error::NeedsInput {
        prompt: clean(msg),
        hint: hint.to_string(),
    }
}

/// How a confirm answers itself without a terminal.
#[derive(Clone, Copy)]
pub enum Unattended<'a> {
    /// A safe answer exists (usually "no").
    Answer(bool),
    /// No safe answer: fail, naming the flag that gives one.
    Require(&'a str),
}

/// Without a terminal: `default`, or `NeedsInput` naming `hint` when there is none.
pub fn input(msg: &str, default: Option<&str>, hint: &str) -> Result<String> {
    if !ui::interactive() {
        return default
            .map(str::to_string)
            .ok_or_else(|| needs_input(msg, hint));
    }
    let mut p = dialoguer::Input::<String>::new().with_prompt(clean(msg));
    if let Some(d) = default {
        p = p.default(d.to_string());
    }
    Ok(p.interact_text()?)
}

// Blank submissions are allowed (dialoguer rejects them by default). The seed
// is editable initial text rather than a default so the user can clear it and
// submit blank — a default would win over an empty line.
/// Without a terminal: `initial`, else blank.
pub fn input_optional(msg: &str, initial: Option<&str>) -> Result<String> {
    if !ui::interactive() {
        return Ok(initial.unwrap_or_default().to_string());
    }
    let mut p = dialoguer::Input::<String>::new()
        .with_prompt(clean(msg))
        .allow_empty(true);
    if let Some(text) = initial {
        p = p.with_initial_text(text.to_string());
    }
    Ok(p.interact_text()?)
}

pub fn confirm(msg: &str, default: bool, unattended: Unattended) -> Result<bool> {
    if !ui::interactive() {
        return match unattended {
            Unattended::Answer(answer) => Ok(answer),
            Unattended::Require(hint) => Err(needs_input(msg, hint)),
        };
    }
    Ok(dialoguer::Confirm::new()
        .with_prompt(clean(msg))
        .default(default)
        .interact()?)
}

/// Checkbox list. `items` carries each label with its initial checked state;
/// the result is the indices left checked. Without a terminal: the initially
/// checked ones.
pub fn multi_select(msg: &str, items: &[(String, bool)]) -> Result<Vec<usize>> {
    if !ui::interactive() {
        return Ok(items
            .iter()
            .enumerate()
            .filter(|(_, (_, checked))| *checked)
            .map(|(i, _)| i)
            .collect());
    }
    let rows = items
        .iter()
        .enumerate()
        .map(|(i, (label, checked))| Row::new(i, [label.clone()]).checked(*checked))
        .collect();
    let picked = Picker::new(msg, rows).multi().interact("")?;
    Ok(picked.into_iter().map(|r| r.value).collect())
}

/// Single choice over rows of columns, titled by `header`. Returns the picked
/// row's value, so callers never map an index back to their data. Without a
/// terminal: `NeedsInput` naming `hint`.
pub fn pick<T>(msg: &str, header: &[&str], rows: Vec<Row<T>>, hint: &str) -> Result<T> {
    Picker::new(msg, rows)
        .header(header)
        .interact(hint)?
        .into_iter()
        .next()
        .map(|r| r.value)
        .ok_or_else(|| Error::Prompt("Cancelled.".to_string()))
}
