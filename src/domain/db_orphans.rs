use crate::domain::workspace_name::pattern_matches;

// Which databases on a server belong to a project but to no workspace.
//
// The inverse of provisioning: `workspace::provision` turns a branch into a
// db name, this turns a server's db list back into the ones nothing claims.
// A name can only ever prove shape, so callers must confirm before dropping.

/// Postgres' own databases. Never candidates, whatever the pattern says.
const SYSTEM_DBS: [&str; 3] = ["postgres", "template0", "template1"];

pub struct OrphanQuery<'a> {
    /// `{project}` already resolved — only slug placeholders may remain.
    pub db_name_pattern: &'a str,
    /// The project's template database, cloned from on every create.
    pub source: &'a str,
    /// Every registered `db_name`, across all projects — two projects can
    /// share one server, and a neighbour's database is not an orphan.
    pub claimed: &'a [String],
}

/// Names in `listed` that match the pattern and nothing claims.
/// Order follows `listed`, so output tracks the server's own ordering.
pub fn find(q: OrphanQuery, listed: &[String]) -> Vec<String> {
    listed
        .iter()
        .filter(|db| {
            !SYSTEM_DBS.contains(&db.as_str())
                && *db != q.source
                && !q.claimed.contains(db)
                && pattern_matches(q.db_name_pattern, db)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn query<'a>(claimed: &'a [String]) -> OrphanQuery<'a> {
        OrphanQuery {
            db_name_pattern: "znb_{branch_slug_safe}",
            source: "znb_dev",
            claimed,
        }
    }

    #[test]
    fn finds_unclaimed_matches() {
        let claimed = names(&["znb_tim_feature"]);
        let listed = names(&["znb_tim_feature", "znb_old_spike", "znb_dead"]);
        assert_eq!(
            find(query(&claimed), &listed),
            names(&["znb_old_spike", "znb_dead"])
        );
    }

    #[test]
    fn keeps_source_and_system_dbs() {
        let listed = names(&["postgres", "template0", "template1", "znb_dev", "znb_x"]);
        assert_eq!(find(query(&[]), &listed), names(&["znb_x"]));
    }

    #[test]
    fn ignores_other_projects() {
        let listed = names(&["acme_thing", "znb_x"]);
        assert_eq!(find(query(&[]), &listed), names(&["znb_x"]));
    }

    /// A neighbouring project's workspace shares the server. Its database is
    /// registered, so it must survive even if the patterns overlap.
    #[test]
    fn respects_claims_from_other_projects() {
        let claimed = names(&["znb_shared"]);
        let listed = names(&["znb_shared", "znb_x"]);
        assert_eq!(find(query(&claimed), &listed), names(&["znb_x"]));
    }
}
