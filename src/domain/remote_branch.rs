/// The pull-request evidence available when deciding whether a remote branch
/// is safe to delete. `Closed` includes merged pull requests.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PullRequestBranchState {
    NoPullRequest,
    Open(i64),
    Closed,
}

/// The command's policy for deleting a remote branch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RemoteBranchPolicy {
    ClosedPullRequestsOnly,
    AlwaysDelete,
}

/// What teardown does with `origin/<branch>`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RemoteBranchAction {
    KeepNoPullRequest,
    KeepOpenPullRequest(i64),
    Delete,
}

pub fn decide(state: PullRequestBranchState, policy: RemoteBranchPolicy) -> RemoteBranchAction {
    match (policy, state) {
        (RemoteBranchPolicy::AlwaysDelete, _) => RemoteBranchAction::Delete,
        (RemoteBranchPolicy::ClosedPullRequestsOnly, PullRequestBranchState::NoPullRequest) => {
            RemoteBranchAction::KeepNoPullRequest
        }
        (RemoteBranchPolicy::ClosedPullRequestsOnly, PullRequestBranchState::Open(number)) => {
            RemoteBranchAction::KeepOpenPullRequest(number)
        }
        (RemoteBranchPolicy::ClosedPullRequestsOnly, PullRequestBranchState::Closed) => {
            RemoteBranchAction::Delete
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_branch_decision_protects_open_and_unverified_branches_by_default() {
        let cases = [
            (
                PullRequestBranchState::NoPullRequest,
                RemoteBranchPolicy::ClosedPullRequestsOnly,
                RemoteBranchAction::KeepNoPullRequest,
            ),
            (
                PullRequestBranchState::Open(42),
                RemoteBranchPolicy::ClosedPullRequestsOnly,
                RemoteBranchAction::KeepOpenPullRequest(42),
            ),
            (
                PullRequestBranchState::Closed,
                RemoteBranchPolicy::ClosedPullRequestsOnly,
                RemoteBranchAction::Delete,
            ),
            (
                PullRequestBranchState::NoPullRequest,
                RemoteBranchPolicy::AlwaysDelete,
                RemoteBranchAction::Delete,
            ),
            (
                PullRequestBranchState::Open(42),
                RemoteBranchPolicy::AlwaysDelete,
                RemoteBranchAction::Delete,
            ),
            (
                PullRequestBranchState::Closed,
                RemoteBranchPolicy::AlwaysDelete,
                RemoteBranchAction::Delete,
            ),
        ];

        for (state, policy, expected) in cases {
            assert_eq!(decide(state, policy), expected);
        }
    }
}
