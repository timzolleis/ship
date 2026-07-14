use std::fmt::Display;

pub fn bold(s: impl Display) -> String {
    format!("\x1b[1m{s}\x1b[0m")
}

pub fn dim(s: impl Display) -> String {
    format!("\x1b[2m{s}\x1b[0m")
}

pub fn green(s: impl Display) -> String {
    format!("\x1b[32m{s}\x1b[0m")
}

pub fn red(s: impl Display) -> String {
    format!("\x1b[31m{s}\x1b[0m")
}

pub fn blue(s: impl Display) -> String {
    format!("\x1b[34m{s}\x1b[0m")
}

pub fn yellow(s: impl Display) -> String {
    format!("\x1b[33m{s}\x1b[0m")
}
