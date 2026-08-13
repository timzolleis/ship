use std::fmt::Display;
use std::io::IsTerminal;
use std::sync::LazyLock;

// Piped output (agents, `| grep`, CI logs) gets plain text. Callers still pad
// columns before colorizing, so widths hold either way.
static COLOR: LazyLock<bool> =
    LazyLock::new(|| std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal());

fn paint(code: &str, s: impl Display) -> String {
    if *COLOR {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

pub fn bold(s: impl Display) -> String {
    paint("1", s)
}

pub fn dim(s: impl Display) -> String {
    paint("2", s)
}

pub fn green(s: impl Display) -> String {
    paint("32", s)
}

pub fn red(s: impl Display) -> String {
    paint("31", s)
}

pub fn blue(s: impl Display) -> String {
    paint("34", s)
}

pub fn yellow(s: impl Display) -> String {
    paint("33", s)
}
