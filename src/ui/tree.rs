use crate::errors::Result;
use crate::fmt::{bold, dim, green, yellow};
use crate::ui::table::{Row, Table};
use crate::ui::{FRAMES, TICK};
use console::{truncate_str, Term};
use std::sync::mpsc::{Receiver, RecvTimeoutError};

// ---------------------------------------------------------------------------
// Live tree: headings with rows hanging off them, each row finishing on its own
// ---------------------------------------------------------------------------

/// How a row ended.
#[derive(Clone, Copy)]
pub enum Outcome {
    Done,
    Skipped,
    Warning,
}

/// Whether a section's rows run one after another or all at once. It decides
/// which rows may spin: with `Sequential` only the first unfinished row is
/// working, with `Concurrent` every unfinished row is.
#[derive(Clone, Copy)]
pub enum Pace {
    Sequential,
    Concurrent,
}

pub struct Section<T> {
    heading: String,
    rows: Vec<Row<T>>,
    pace: Pace,
}

impl<T> Section<T> {
    pub fn new(heading: impl Into<String>, rows: Vec<Row<T>>, pace: Pace) -> Self {
        Section {
            heading: heading.into(),
            rows,
            pace,
        }
    }
}

/// New state for one row: its outcome once it has one, plus the text beside it.
pub struct Mark {
    pub section: usize,
    pub row: usize,
    pub outcome: Option<Outcome>,
    pub detail: Option<String>,
}

impl Mark {
    /// Still working — replaces the row's text without stopping its spinner.
    pub fn running(section: usize, row: usize, detail: impl Into<String>) -> Self {
        Mark {
            section,
            row,
            outcome: None,
            detail: Some(detail.into()),
        }
    }

    pub fn finished(section: usize, row: usize, outcome: Outcome, detail: Option<String>) -> Self {
        Mark {
            section,
            row,
            outcome: Some(outcome),
            detail,
        }
    }
}

pub struct Tree<T> {
    sections: Vec<Section<T>>,
    outcomes: Vec<Vec<Option<Outcome>>>,
    details: Vec<Vec<String>>,
}

impl<T> Tree<T> {
    pub fn new(sections: Vec<Section<T>>) -> Self {
        let outcomes = sections.iter().map(|s| vec![None; s.rows.len()]).collect();
        let details = sections
            .iter()
            .map(|s| vec![String::new(); s.rows.len()])
            .collect();
        Tree {
            sections,
            outcomes,
            details,
        }
    }

    /// Draws until the sender hangs up. `map` places each result on its row: the
    /// widget never learns what the work was.
    pub fn run<U>(mut self, rx: Receiver<U>, map: impl Fn(U) -> Mark) -> Result<()> {
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
        // A row still unfinished here means its work died mid-step. Leave it dim
        // rather than spinning forever.
        self.paint(&term, &dim("·"), drawn)?;
        io(term.show_cursor())
    }

    /// Places one update. Call it before `run` to give rows their opening text.
    pub fn apply(&mut self, m: Mark) {
        let Some(outcomes) = self.outcomes.get_mut(m.section) else {
            return;
        };
        if m.row >= outcomes.len() {
            return;
        }
        if let Some(outcome) = m.outcome {
            outcomes[m.row] = Some(outcome);
        }
        if let Some(detail) = m.detail {
            self.details[m.section][m.row] = detail;
        }
    }

    fn marker(&self, section: usize, row: usize, spinner: &str) -> String {
        match self.outcomes[section][row] {
            Some(Outcome::Done) => green("✓"),
            Some(Outcome::Warning) => yellow("⚠"),
            Some(Outcome::Skipped) => dim("·"),
            None if self.is_running(section, row) => spinner.to_string(),
            None => dim("·"),
        }
    }

    fn is_running(&self, section: usize, row: usize) -> bool {
        match self.sections[section].pace {
            Pace::Concurrent => true,
            Pace::Sequential => {
                self.outcomes[section].iter().position(Option::is_none) == Some(row)
            }
        }
    }

    /// Every line of the tree, headings included. Columns are measured across
    /// all sections so rows under different headings still line up.
    fn lines(&self, spinner: &str) -> Vec<String> {
        let mut display: Vec<Row<()>> = Vec::new();
        for (s, section) in self.sections.iter().enumerate() {
            let last = section.rows.len().saturating_sub(1);
            for (r, row) in section.rows.iter().enumerate() {
                let branch = if r == last { "└─" } else { "├─" };
                let detail = match self.details[s][r].as_str() {
                    // An empty detail must stay empty: dimming it would emit
                    // bare escape codes and defeat the trailing trim.
                    "" => String::new(),
                    text => dim(text),
                };
                let cells = [format!("{} {}", dim(branch), self.marker(s, r, spinner))]
                    .into_iter()
                    .chain(row.cells.iter().map(|c| c.clone().unwrap_or_default()))
                    .chain(std::iter::once(detail));
                display.push(Row::new((), cells));
            }
        }

        let table = Table::measure(&display);
        let mut lines = Vec::new();
        let mut next = 0;
        for section in &self.sections {
            lines.push(format!("  {}", bold(&section.heading)));
            for _ in 0..section.rows.len() {
                lines.push(format!("  {}", table.line(&display[next], spinner)));
                next += 1;
            }
        }
        lines
    }

    fn paint(&self, term: &Term, spinner: &str, drawn: usize) -> Result<usize> {
        let lines = self.lines(spinner);
        let width = term.is_term().then(|| term.size().1 as usize);
        if drawn > 0 {
            io(term.clear_last_lines(drawn))?;
        }
        for line in &lines {
            let line = line.trim_end();
            match width {
                Some(w) => io(term.write_line(&truncate_str(line, w - 1, "…")))?,
                None => io(term.write_line(line))?,
            }
        }
        Ok(lines.len())
    }
}

fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| crate::errors::Error::Prompt(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(heading: &str, labels: &[&str], pace: Pace) -> Section<usize> {
        let rows = labels
            .iter()
            .enumerate()
            .map(|(i, l)| Row::new(i, [l.to_string()]))
            .collect();
        Section::new(heading, rows, pace)
    }

    #[test]
    fn last_row_of_a_section_closes_the_branch() {
        let tree = Tree::new(vec![section(
            "ship",
            &["Proxy route", "Database"],
            Pace::Sequential,
        )]);
        let lines = tree.lines("*");
        assert_eq!(lines[0], "  ship");
        assert!(lines[1].starts_with("  ├─"));
        assert!(lines[2].starts_with("  └─"));
    }

    #[test]
    fn sequential_spins_only_the_first_unfinished_row() {
        let mut tree = Tree::new(vec![section("ship", &["a", "b", "c"], Pace::Sequential)]);
        tree.apply(Mark::finished(0, 0, Outcome::Done, None));
        let lines = tree.lines("*");
        assert!(lines[1].contains('✓'));
        assert!(lines[2].contains('*'));
        assert!(lines[3].contains('·'));
    }

    #[test]
    fn concurrent_spins_every_unfinished_row() {
        let mut tree = Tree::new(vec![section("ship", &["a", "b", "c"], Pace::Concurrent)]);
        tree.apply(Mark::finished(
            0,
            1,
            Outcome::Warning,
            Some("boom".to_string()),
        ));
        let lines = tree.lines("*");
        assert!(lines[1].contains('*'));
        assert!(lines[2].contains('⚠'));
        assert!(lines[2].contains("boom"));
        assert!(lines[3].contains('*'));
    }

    #[test]
    fn columns_align_across_sections() {
        let mut tree = Tree::new(vec![
            section("api", &["short"], Pace::Concurrent),
            section("web", &["a much longer label"], Pace::Concurrent),
        ]);
        tree.apply(Mark::running(0, 0, "here"));
        tree.apply(Mark::running(1, 0, "here"));
        let lines = tree.lines("*");
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[1].find("here"), lines[3].find("here"));
    }

    #[test]
    fn a_row_outside_the_tree_is_ignored() {
        let mut tree = Tree::new(vec![section("ship", &["a"], Pace::Sequential)]);
        tree.apply(Mark::finished(9, 9, Outcome::Done, None));
        tree.apply(Mark::finished(0, 4, Outcome::Done, None));
        assert!(tree.lines("*")[1].contains('*'));
    }

    #[test]
    fn a_running_mark_keeps_the_spinner_and_swaps_the_text() {
        let mut tree = Tree::new(vec![section("ship", &["a"], Pace::Concurrent)]);
        tree.apply(Mark::running(0, 0, "database"));
        let line = tree.lines("*")[1].clone();
        assert!(line.contains('*'));
        assert!(line.contains("database"));
    }
}
