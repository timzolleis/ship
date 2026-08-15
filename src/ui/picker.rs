use crate::errors::{Error, Result};
use crate::fmt::{blue, bold, dim, green};
use crate::ui::table::{Row, Table};
use crate::ui::{FRAMES, TICK};
use console::{truncate_str, Key, Term};
use std::io::IsTerminal;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Interactive list picker with cells that can arrive late
// ---------------------------------------------------------------------------

/// A cell that a background lookup resolved.
pub struct Update {
    pub row: usize,
    pub column: usize,
    pub text: String,
}

impl Update {
    pub fn new(row: usize, column: usize, text: impl Into<String>) -> Self {
        Update {
            row,
            column,
            text: text.into(),
        }
    }
}

enum Pulled {
    Ready(Update),
    Empty,
    Closed,
}

enum Action {
    Redraw,
    Done,
    Cancel,
}

type Pull = Box<dyn FnMut() -> Pulled>;

pub struct Picker<T> {
    msg: String,
    multi: bool,
    rows: Vec<Row<T>>,
    pull: Option<Pull>,
}

impl<T> Picker<T> {
    pub fn new(msg: &str, rows: Vec<Row<T>>) -> Self {
        Picker {
            msg: msg.trim_end_matches(':').trim_end().to_string(),
            multi: false,
            rows,
            pull: None,
        }
    }

    /// Checkboxes instead of a single choice. Enter returns every checked row.
    pub fn multi(mut self) -> Self {
        self.multi = true;
        self
    }

    /// Feeds late cells in from a background lookup. The list draws right away
    /// and each result swaps into its row as it lands. `map` places the value:
    /// the picker never learns what the lookup produced.
    pub fn stream<U: 'static>(
        mut self,
        rx: Receiver<U>,
        map: impl Fn(U) -> Update + 'static,
    ) -> Self {
        self.pull = Some(Box::new(move || match rx.try_recv() {
            Ok(u) => Pulled::Ready(map(u)),
            Err(TryRecvError::Empty) => Pulled::Empty,
            Err(TryRecvError::Disconnected) => Pulled::Closed,
        }));
        self
    }

    /// Returns the picked rows, cells included, so callers can keep what a
    /// background lookup found. Empty means cancelled or nothing checked.
    pub fn interact(self) -> Result<Vec<Row<T>>> {
        let term = Term::stderr();
        if self.rows.is_empty() {
            return Ok(Vec::new());
        }
        if !term.is_term() || !std::io::stdin().is_terminal() {
            self.render_static(&term)?;
            return Ok(Vec::new());
        }
        self.run(&term)
    }

    fn run(mut self, term: &Term) -> Result<Vec<Row<T>>> {
        let (msg, multi) = (self.msg.clone(), self.multi);
        let mut cursor = 0usize;
        let mut offset = 0usize;
        let mut frame = 0usize;
        let mut drawn = 0usize;

        io(term.hide_cursor())?;
        let outcome = loop {
            self.drain();
            drawn = self.draw(
                term,
                cursor,
                &mut offset,
                FRAMES[frame % FRAMES.len()],
                drawn,
            )?;

            // Blocking on a key would freeze the spinner, so only wait for one
            // once every lookup has landed.
            if self.pull.is_some() && !key_ready(TICK) {
                frame += 1;
                continue;
            }
            match self.handle_key(term, &mut cursor)? {
                Action::Redraw => {}
                Action::Done => break true,
                Action::Cancel => break false,
            }
        };

        io(term.clear_last_lines(drawn))?;
        io(term.show_cursor())?;

        let picked: Vec<Row<T>> = match outcome {
            true => self.rows.into_iter().filter(|r| r.checked).collect(),
            false => Vec::new(),
        };
        let summary = match (outcome, multi) {
            (false, _) => "cancelled".to_string(),
            (true, true) => format!("{} selected", picked.len()),
            (true, false) => picked
                .first()
                .and_then(|r| r.cell(0))
                .unwrap_or("cancelled")
                .to_string(),
        };
        io(term.write_line(&format!("  {} {}", bold(&msg), dim(summary))))?;
        Ok(picked)
    }

    fn drain(&mut self) {
        while let Some(pull) = self.pull.as_mut() {
            match pull() {
                Pulled::Ready(u) => {
                    if let Some(row) = self.rows.get_mut(u.row) {
                        row.set(u.column, u.text);
                    }
                }
                Pulled::Empty => break,
                Pulled::Closed => self.pull = None,
            }
        }
    }

    fn handle_key(&mut self, term: &Term, cursor: &mut usize) -> Result<Action> {
        let last = self.rows.len() - 1;
        match io(term.read_key_raw())? {
            Key::ArrowUp | Key::Char('k') => {
                *cursor = if *cursor == 0 { last } else { *cursor - 1 };
            }
            Key::ArrowDown | Key::Char('j') | Key::Tab => {
                *cursor = if *cursor == last { 0 } else { *cursor + 1 };
            }
            Key::Home => *cursor = 0,
            Key::End => *cursor = last,
            Key::Char(' ') if self.multi => {
                self.rows[*cursor].checked = !self.rows[*cursor].checked;
            }
            Key::Char('a') if self.multi => {
                let all = self.rows.iter().all(|r| r.checked);
                for row in &mut self.rows {
                    row.checked = !all;
                }
            }
            Key::Enter => {
                if !self.multi {
                    self.rows[*cursor].checked = true;
                }
                return Ok(Action::Done);
            }
            Key::Escape => return Ok(Action::Cancel),
            // Restore the terminal first, then die the way ^C normally does.
            Key::CtrlC => {
                io(term.show_cursor())?;
                unsafe { libc::raise(libc::SIGINT) };
                return Ok(Action::Cancel);
            }
            _ => {}
        }
        Ok(Action::Redraw)
    }

    fn draw(
        &self,
        term: &Term,
        cursor: usize,
        offset: &mut usize,
        spinner: &str,
        drawn: usize,
    ) -> Result<usize> {
        let (height, width) = term.size();
        // Header, both scroll hints and the help line sit outside the window.
        let window = self
            .rows
            .len()
            .min((height as usize).saturating_sub(4).max(3));
        if cursor < *offset {
            *offset = cursor;
        }
        if cursor >= *offset + window {
            *offset = cursor + 1 - window;
        }

        let table = Table::measure(&self.rows);
        let mut lines = vec![format!("  {}", bold(&self.msg))];
        if *offset > 0 {
            lines.push(format!("  {}", dim(format!("↑ {} more", offset))));
        }
        for (i, row) in self.rows.iter().enumerate().skip(*offset).take(window) {
            let pointer = if i == cursor {
                blue("❯")
            } else {
                " ".to_string()
            };
            lines.push(format!(
                "  {} {}{}",
                pointer,
                self.mark(row.checked),
                table.line(row, spinner)
            ));
        }
        let hidden = self.rows.len() - (*offset + window);
        if hidden > 0 {
            lines.push(format!("  {}", dim(format!("↓ {hidden} more"))));
        }
        lines.push(format!("  {}", dim(self.help())));

        if drawn > 0 {
            io(term.clear_last_lines(drawn))?;
        }
        for line in &lines {
            // A wrapped line breaks clear_last_lines' arithmetic on the next
            // redraw, so nothing may exceed the terminal width.
            io(term.write_line(&truncate_str(line, width as usize - 1, "…")))?;
        }
        Ok(lines.len())
    }

    fn mark(&self, checked: bool) -> String {
        match (self.multi, checked) {
            (false, _) => String::new(),
            (true, true) => green("[x] "),
            (true, false) => dim("[ ] "),
        }
    }

    fn help(&self) -> &'static str {
        if self.multi {
            "↑↓ move · space select · a all · enter confirm · esc cancel"
        } else {
            "↑↓ move · enter confirm · esc cancel"
        }
    }

    /// Piped or scripted: show what would have been offered, pick nothing.
    /// Waiting on a keypress nobody can send would hang the run.
    fn render_static(&self, term: &Term) -> Result<()> {
        let table = Table::measure(&self.rows);
        io(term.write_line(&format!("  {}", bold(&self.msg))))?;
        for row in &self.rows {
            io(term.write_line(&format!(
                "    {}{}",
                self.mark(row.checked),
                table.line(row, "…")
            )))?;
        }
        Ok(())
    }
}

fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| Error::Prompt(e.to_string()))
}

/// True when stdin has a key waiting. macOS ttys cannot be polled — only
/// select works there, the same workaround console uses internally.
#[cfg(target_os = "macos")]
fn key_ready(timeout: Duration) -> bool {
    let fd = libc::STDIN_FILENO;
    unsafe {
        let mut set: libc::fd_set = std::mem::zeroed();
        libc::FD_ZERO(&mut set);
        libc::FD_SET(fd, &mut set);
        let mut tv = libc::timeval {
            tv_sec: timeout.as_secs() as _,
            tv_usec: timeout.subsec_micros() as _,
        };
        libc::select(
            fd + 1,
            &mut set,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut tv,
        ) > 0
    }
}

#[cfg(not(target_os = "macos"))]
fn key_ready(timeout: Duration) -> bool {
    let mut pollfd = libc::pollfd {
        fd: libc::STDIN_FILENO,
        events: libc::POLLIN,
        revents: 0,
    };
    let ready = unsafe { libc::poll(&mut pollfd, 1, timeout.as_millis() as i32) };
    ready > 0 && pollfd.revents & libc::POLLIN != 0
}
