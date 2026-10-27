use crate::domain::remote_branch::PullRequestBranchState;

/// What teardown does with the local branch once its worktree is gone.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LocalBranchAction {
    Delete,
    /// Deleting would lose this many commits that no other ref holds.
    KeepUnpushed(usize),
}

/// `only_here` counts the commits no other branch, tag, or remote ref holds.
/// A closed or merged PR counts as landed even then: a squash merge leaves
/// the original commits on the branch alone, and a pruned fetch drops
/// `origin/<branch>`.
pub fn decide(only_here: usize, pull_request: PullRequestBranchState) -> LocalBranchAction {
    match (only_here, pull_request) {
        (0, _) | (_, PullRequestBranchState::Closed) => LocalBranchAction::Delete,
        (n, _) => LocalBranchAction::KeepUnpushed(n),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_branch_whose_commits_exist_nowhere_else() {
        assert_eq!(
            decide(3, PullRequestBranchState::NoPullRequest),
            LocalBranchAction::KeepUnpushed(3)
        );
        assert_eq!(
            decide(1, PullRequestBranchState::Open(42)),
            LocalBranchAction::KeepUnpushed(1)
        );
    }

    #[test]
    fn deletes_a_branch_that_loses_nothing() {
        assert_eq!(
            decide(0, PullRequestBranchState::NoPullRequest),
            LocalBranchAction::Delete
        );
    }

    #[test]
    fn deletes_a_squash_merged_branch() {
        assert_eq!(
            decide(5, PullRequestBranchState::Closed),
            LocalBranchAction::Delete
        );
    }
}
