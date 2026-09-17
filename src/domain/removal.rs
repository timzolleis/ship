// ---------------------------------------------------------------------------
// Did a teardown step actually remove something?
// ---------------------------------------------------------------------------

/// Teardown must be safe to retry, so a step that finds its target already gone
/// has succeeded. Callers that treat absence as a failure keep the workspace in
/// the registry, and every retry hits the same missing target — the entry never
/// clears.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removal {
    Removed,
    AlreadyGone,
}
