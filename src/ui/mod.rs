use std::time::Duration;

pub mod picker;
pub mod progress;
pub mod table;

pub use picker::{Picker, Update};
pub use progress::{Finished, Outcome, Progress};
pub use table::{Row, Table};

pub(crate) const FRAMES: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
pub(crate) const TICK: Duration = Duration::from_millis(80);
