/// What `ship create` does with the editor once the workspace is ready.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EditorLaunch {
    Open,
    Skip,
    /// Ask the human at the terminal.
    Ask,
}

/// `flag` is `--editor` / `--no-editor`, `stored` the `autoOpenEditor`
/// preference. The flag always wins. Without one, only a terminal session
/// opens the editor: agents run ship without a terminal and spawn throwaway
/// workspaces, so a stored `true` must not pop an editor window for each.
pub fn decide(flag: Option<bool>, stored: Option<bool>, interactive: bool) -> EditorLaunch {
    match (flag, interactive, stored) {
        (Some(true), _, _) => EditorLaunch::Open,
        (Some(false), _, _) => EditorLaunch::Skip,
        (None, false, _) => EditorLaunch::Skip,
        (None, true, Some(true)) => EditorLaunch::Open,
        (None, true, Some(false)) => EditorLaunch::Skip,
        (None, true, None) => EditorLaunch::Ask,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_wins_over_terminal_and_preference() {
        for interactive in [true, false] {
            for stored in [None, Some(true), Some(false)] {
                assert_eq!(decide(Some(true), stored, interactive), EditorLaunch::Open);
                assert_eq!(decide(Some(false), stored, interactive), EditorLaunch::Skip);
            }
        }
    }

    #[test]
    fn without_a_terminal_the_editor_stays_closed() {
        for stored in [None, Some(true), Some(false)] {
            assert_eq!(decide(None, stored, false), EditorLaunch::Skip);
        }
    }

    #[test]
    fn at_a_terminal_the_preference_decides_and_a_missing_one_asks() {
        assert_eq!(decide(None, Some(true), true), EditorLaunch::Open);
        assert_eq!(decide(None, Some(false), true), EditorLaunch::Skip);
        assert_eq!(decide(None, None, true), EditorLaunch::Ask);
    }
}
