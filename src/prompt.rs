use crate::errors::Result;

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

pub fn confirm(msg: &str, default: bool) -> Result<bool> {
    Ok(dialoguer::Confirm::new()
        .with_prompt(clean(msg))
        .default(default)
        .interact()?)
}

pub fn select(msg: &str, items: &[String]) -> Result<usize> {
    Ok(dialoguer::Select::new()
        .with_prompt(clean(msg))
        .items(items)
        .default(0)
        .interact()?)
}
