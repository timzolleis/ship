use console::measure_text_width;

// ---------------------------------------------------------------------------
// Rows of cells with shared column widths
// ---------------------------------------------------------------------------

/// One line of a list: the value it stands for, plus the cells shown for it.
/// A `None` cell is still loading and draws as a spinner.
pub struct Row<T> {
    pub value: T,
    pub cells: Vec<Option<String>>,
    pub checked: bool,
}

impl<T> Row<T> {
    pub fn new(value: T, cells: impl IntoIterator<Item = String>) -> Self {
        Row {
            value,
            cells: cells.into_iter().map(Some).collect(),
            checked: false,
        }
    }

    /// Adds a column that a background lookup fills in later.
    pub fn pending(mut self) -> Self {
        self.cells.push(None);
        self
    }

    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub fn cell(&self, column: usize) -> Option<&str> {
        self.cells.get(column).and_then(|c| c.as_deref())
    }

    pub fn set(&mut self, column: usize, text: String) {
        if column >= self.cells.len() {
            self.cells.resize_with(column + 1, || None);
        }
        self.cells[column] = Some(text);
    }
}

/// Column widths shared by every row. Widths ignore ANSI codes, so cells that
/// arrive pre-colored still line up.
pub struct Table {
    widths: Vec<usize>,
}

impl Table {
    pub fn measure<T>(rows: &[Row<T>]) -> Self {
        let columns = rows.iter().map(|r| r.cells.len()).max().unwrap_or(0);
        let widths = (0..columns)
            .map(|c| {
                rows.iter()
                    .filter_map(|r| r.cell(c))
                    .map(measure_text_width)
                    .max()
                    .unwrap_or(0)
            })
            .collect();
        Table { widths }
    }

    /// The trailing cell is never padded — nothing follows it to line up with.
    pub fn line<T>(&self, row: &Row<T>, spinner: &str) -> String {
        let last = row.cells.len().saturating_sub(1);
        let mut out = String::new();
        for (i, cell) in row.cells.iter().enumerate() {
            if i > 0 {
                out.push_str("  ");
            }
            let text = cell.as_deref().unwrap_or(spinner);
            out.push_str(text);
            if i != last {
                let width = self.widths.get(i).copied().unwrap_or(0);
                out.push_str(&" ".repeat(width.saturating_sub(measure_text_width(text))));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(cells: &[&str]) -> Row<()> {
        Row::new((), cells.iter().map(|c| c.to_string()))
    }

    #[test]
    fn pads_to_the_widest_cell() {
        let rows = vec![row(&["api", "main", "x"]), row(&["frontend", "fix", "y"])];
        let table = Table::measure(&rows);
        assert_eq!(table.line(&rows[0], "·"), "api       main  x");
        assert_eq!(table.line(&rows[1], "·"), "frontend  fix   y");
    }

    #[test]
    fn ansi_codes_do_not_count_toward_width() {
        let rows = vec![
            row(&["\x1b[1mapi\x1b[0m", "main"]),
            row(&["frontend", "fix"]),
        ];
        let table = Table::measure(&rows);
        assert_eq!(table.line(&rows[0], "·"), "\x1b[1mapi\x1b[0m       main");
    }

    #[test]
    fn trailing_cell_stays_unpadded() {
        let rows = vec![row(&["api", "short"]), row(&["api", "much longer"])];
        let table = Table::measure(&rows);
        assert_eq!(table.line(&rows[0], "·"), "api  short");
    }

    #[test]
    fn pending_cell_draws_the_spinner_and_still_pads() {
        let rows = vec![
            Row::new((), ["api".to_string()]).pending(),
            row(&["api", "resolved"]),
        ];
        let table = Table::measure(&rows);
        assert_eq!(table.line(&rows[0], "⠋"), "api  ⠋");

        let mut pending = Row::new((), ["api".to_string()]).pending();
        pending.set(1, "later".to_string());
        assert_eq!(pending.cell(1), Some("later"));
    }
}
