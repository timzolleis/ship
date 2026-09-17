use std::time::Duration;

pub mod live;
pub mod picker;
pub mod table;
pub mod tree;

pub use live::{Cell, Live};
pub use picker::{Picker, Update};
pub use table::{Row, Table};
pub use tree::{Mark, Outcome, Pace, Section, Tree};

pub(crate) const FRAMES: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
pub(crate) const TICK: Duration = Duration::from_millis(80);
