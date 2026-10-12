use std::time::Duration;

pub mod live;
pub mod picker;
pub mod table;
pub mod tree;

pub use live::{Cell, Live};
pub use picker::{Picker, Update};
pub use table::{Row, Table};
pub use tree::{Mark, Outcome, Pace, Section, Tree};

/// Someone can answer a prompt: stdin and stderr are both terminals. Agents
/// run without a TTY, so this is the one switch for unattended mode.
pub fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

pub(crate) const FRAMES: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
pub(crate) const TICK: Duration = Duration::from_millis(80);
