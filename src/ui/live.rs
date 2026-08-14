use crate::errors::Result;
use crate::ui::table::{Row, Table};
use crate::ui::{FRAMES, TICK};
use console::{truncate_str, Term};
use std::sync::mpsc::{Receiver, RecvTimeoutError};

// ---------------------------------------------------------------------------
// Static table whose cells arrive late: rows draw at once, pending cells spin
// ---------------------------------------------------------------------------

/// A cell a background lookup resolved.
pub struct Cell {
    pub row: usize,
    pub column: usize,
    pub text: String,
}

impl Cell {
    pub fn new(row: usize, column: usize, text: impl Into<String>) -> Self {
        Cell {
            row,
            column,
            text: text.into(),
        }
    }
}

/// Results may land in any order, so every pending cell spins until its own
/// value arrives. Use `Progress` instead when the work is sequential steps.
pub struct Live<T> {
    rows: Vec<Row<T>>,
}

impl<T> Live<T> {
    pub fn new(rows: Vec<Row<T>>) -> Self {
        Live { rows }
    }

    /// Draws until the sender hangs up. `map` places each result on its row:
    /// the widget never learns what the lookup produced.
    pub fn run<U>(mut self, rx: Receiver<U>, map: impl Fn(U) -> Cell) -> Result<()> {
        let term = Term::stdout();
        if !term.is_term() {
            while let Ok(u) = rx.recv() {
                self.apply(map(u));
            }
            return self.paint(&term, "", 0).map(|_| ());
        }

        io(term.hide_cursor())?;
        let mut drawn = 0;
        let mut frame = 0;
        loop {
            drawn = self.paint(&term, FRAMES[frame % FRAMES.len()], drawn)?;
            match rx.recv_timeout(TICK) {
                Ok(u) => self.apply(map(u)),
                Err(RecvTimeoutError::Timeout) => frame += 1,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        // A cell still pending here means its lookup died. Blank beats a
        // spinner frozen mid-frame.
        self.paint(&term, "", drawn)?;
        io(term.show_cursor())
    }

    /// No lookup to wait for — draw the rows once and return.
    pub fn print(self) -> Result<()> {
        let term = Term::stdout();
        self.paint(&term, "", 0).map(|_| ())
    }

    fn apply(&mut self, cell: Cell) {
        if let Some(row) = self.rows.get_mut(cell.row) {
            row.set(cell.column, cell.text);
        }
    }

    fn paint(&self, term: &Term, spinner: &str, drawn: usize) -> Result<usize> {
        let table = Table::measure(&self.rows);
        // A pipe has no width, and cutting a listing there drops data a script
        // needs. Only a live redraw has to fit the terminal.
        let width = term.is_term().then(|| term.size().1 as usize);
        if drawn > 0 {
            io(term.clear_last_lines(drawn))?;
        }
        for row in &self.rows {
            let line = format!("  {}", table.line(row, spinner));
            let line = line.trim_end();
            match width {
                Some(w) => io(term.write_line(&truncate_str(line, w - 1, "…")))?,
                None => io(term.write_line(line))?,
            }
        }
        Ok(self.rows.len())
    }
}

fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| crate::errors::Error::Prompt(e.to_string()))
}
