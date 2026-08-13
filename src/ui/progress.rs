use crate::errors::Result;
use crate::fmt::{dim, green, yellow};
use crate::ui::table::{Row, Table};
use crate::ui::{FRAMES, TICK};
use console::{truncate_str, Term};
use std::sync::mpsc::{Receiver, RecvTimeoutError};

// ---------------------------------------------------------------------------
// Live checklist: rows draw up front, the running one spins, results land in place
// ---------------------------------------------------------------------------

/// How a step ended.
#[derive(Clone, Copy)]
pub enum Outcome {
    Done,
    Skipped,
    Warning,
}

/// A step that finished, ready to replace its spinner.
pub struct Finished {
    pub row: usize,
    pub outcome: Outcome,
    pub detail: Option<String>,
}

impl Finished {
    pub fn new(row: usize, outcome: Outcome, detail: Option<String>) -> Self {
        Finished {
            row,
            outcome,
            detail,
        }
    }
}

/// Work must be sequential: the first unfinished row is the one running, and
/// everything below it is still waiting.
pub struct Progress<T> {
    rows: Vec<Row<T>>,
    outcomes: Vec<Option<Outcome>>,
    details: Vec<String>,
}

impl<T> Progress<T> {
    pub fn new(rows: Vec<Row<T>>) -> Self {
        let count = rows.len();
        Progress {
            rows,
            outcomes: vec![None; count],
            details: vec![String::new(); count],
        }
    }

    /// Draws until the sender hangs up. `map` places each result on its row:
    /// the widget never learns what the work was.
    pub fn run<U>(mut self, rx: Receiver<U>, map: impl Fn(U) -> Finished) -> Result<()> {
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
        // A row still unfinished here means the work died mid-step. Leave it
        // dim rather than spinning forever.
        self.paint(&term, &dim("·"), drawn)?;
        io(term.show_cursor())
    }

    fn apply(&mut self, f: Finished) {
        if f.row >= self.rows.len() {
            return;
        }
        self.outcomes[f.row] = Some(f.outcome);
        self.details[f.row] = f.detail.unwrap_or_default();
    }

    fn marker(&self, row: usize, spinner: &str) -> String {
        match self.outcomes[row] {
            Some(Outcome::Done) => green("✓"),
            Some(Outcome::Warning) => yellow("⚠"),
            Some(Outcome::Skipped) => dim("·"),
            None if self.running() == Some(row) => spinner.to_string(),
            None => dim("·"),
        }
    }

    fn running(&self) -> Option<usize> {
        self.outcomes.iter().position(Option::is_none)
    }

    fn paint(&self, term: &Term, spinner: &str, drawn: usize) -> Result<usize> {
        // The marker and the detail are the widget's columns, so callers hand
        // over content cells only.
        let display: Vec<Row<()>> = self
            .rows
            .iter()
            .enumerate()
            .map(|(i, row)| {
                // An empty detail must stay empty: dimming it would emit bare
                // escape codes and defeat the trailing trim.
                let detail = match self.details[i].as_str() {
                    "" => String::new(),
                    text => dim(text),
                };
                let cells = std::iter::once(self.marker(i, spinner))
                    .chain(row.cells.iter().map(|c| c.clone().unwrap_or_default()))
                    .chain(std::iter::once(detail));
                Row::new((), cells)
            })
            .collect();

        let table = Table::measure(&display);
        let width = term.size().1 as usize;
        if drawn > 0 {
            io(term.clear_last_lines(drawn))?;
        }
        for row in &display {
            let line = format!("    {}", table.line(row, spinner));
            io(term.write_line(&truncate_str(line.trim_end(), width - 1, "…")))?;
        }
        Ok(display.len())
    }
}

fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| crate::errors::Error::Prompt(e.to_string()))
}
