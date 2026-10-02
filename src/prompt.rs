use crate::errors::{Error, Result};
use crate::ui::{Picker, Row};

// dialoguer's theme appends ": " itself, so trailing colons in ported
// prompt messages are stripped to avoid "Branch name:: ".
fn clean(msg: &str) -> String {
    msg.trim_end_matches(':').trim_end().to_string()
}

pub fn input(msg: &str, default: Option<&str>) -> Result<String> {
    let mut p = dialoguer::Input::<String>::new().with_prompt(clean(msg));
    if let Some(d) = default {
        p = p.default(d.to_string());
    }
    Ok(p.interact_text()?)
}

// Blank submissions are allowed (dialoguer rejects them by default). The seed
// is editable initial text rather than a default so the user can clear it and
// submit blank — a default would win over an empty line.
pub fn input_optional(msg: &str, initial: Option<&str>) -> Result<String> {
    let mut p = dialoguer::Input::<String>::new()
        .with_prompt(clean(msg))
        .allow_empty(true);
    if let Some(text) = initial {
        p = p.with_initial_text(text.to_string());
    }
    Ok(p.interact_text()?)
}

pub fn confirm(msg: &str, default: bool) -> Result<bool> {
    Ok(dialoguer::Confirm::new()
        .with_prompt(clean(msg))
        .default(default)
        .interact()?)
}

/// Checkbox list. `items` carries each label with its initial checked state;
/// the result is the indices left checked.
pub fn multi_select(msg: &str, items: &[(String, bool)]) -> Result<Vec<usize>> {
    let rows = items
        .iter()
        .enumerate()
        .map(|(i, (label, checked))| Row::new(i, [label.clone()]).checked(*checked))
        .collect();
    let picked = Picker::new(msg, rows).multi().interact()?;
    Ok(picked.into_iter().map(|r| r.value).collect())
}

/// Single choice over rows of columns, titled by `header`. Returns the picked
/// row's value, so callers never map an index back to their data.
pub fn pick<T>(msg: &str, header: &[&str], rows: Vec<Row<T>>) -> Result<T> {
    Picker::new(msg, rows)
        .header(header)
        .interact()?
        .into_iter()
        .next()
        .map(|r| r.value)
        .ok_or_else(|| Error::Prompt("Cancelled.".to_string()))
}
