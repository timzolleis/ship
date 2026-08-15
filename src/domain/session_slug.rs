// Every coding agent stores its transcripts in one directory per project,
// named after the absolute path with the separators flattened to `-`. Only the
// wrapping differs — Claude Code writes `-Users-tim-code-app`, Pi writes
// `--Users-tim-code-app--`.
//
// The flattening is lossy: a `-` in a name is either a literal one or a `/`,
// and the name alone can never say which. Everything here works around that.

/// Letters and digits only. Comparing squashed strings ignores both the
/// wrapping dashes and the separator style, so one rule fits every harness.
pub fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// True when the directory name stands for exactly this absolute path.
pub fn refers_to(name: &str, abs_path: &str) -> bool {
    !abs_path.is_empty() && squash(name) == squash(abs_path)
}

/// The part of `name` past `prefix`, in the name's own spelling — leading
/// separator included, because `resolve` needs it to split on.
///
/// None when the name is not under the prefix, or when nothing but separators
/// follows it: that name is the project checkout itself, never a worktree.
pub fn remainder<'a>(name: &'a str, prefix: &str) -> Option<&'a str> {
    let want = squash(prefix);
    if want.is_empty() {
        return None;
    }

    let mut seen = String::new();
    for (i, c) in name.char_indices() {
        if c.is_alphanumeric() {
            seen.push(c.to_ascii_lowercase());
            if !want.starts_with(&seen) {
                return None;
            }
            if seen.len() == want.len() {
                let tail = &name[i + c.len_utf8()..];
                return (!squash(tail).is_empty()).then_some(tail);
            }
        }
    }
    None
}

/// Probe ceiling. A pathological name must not walk the filesystem forever;
/// giving up reports "no live path", which only ever keeps a session dir.
const MAX_PROBES: usize = 4096;

/// The live path `tail` stands for under `base`, or None when nothing on disk
/// matches. Each `-` is tried as a literal and as a `/`, pruned against
/// `exists` — a partial path that isn't there can't have children.
pub fn resolve(base: &str, tail: &str, exists: &dyn Fn(&str) -> bool) -> Option<String> {
    let segments: Vec<&str> = tail.split('-').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return None;
    }
    walk(base, &segments, exists, &mut 0)
}

fn walk(
    base: &str,
    segments: &[&str],
    exists: &dyn Fn(&str) -> bool,
    probes: &mut usize,
) -> Option<String> {
    for take in 1..=segments.len() {
        if *probes >= MAX_PROBES {
            return None;
        }
        *probes += 1;

        let candidate = format!("{base}/{}", segments[..take].join("-"));
        if !exists(&candidate) {
            continue;
        }
        if take == segments.len() {
            return Some(candidate);
        }
        if let Some(found) = walk(&candidate, &segments[take..], exists, probes) {
            return Some(found);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on_disk<'a>(paths: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |p: &str| paths.contains(&p)
    }

    #[test]
    fn matches_a_path_across_harness_spellings() {
        for name in [
            "-Users-tim-code-app",
            "--Users-tim-code-app--",
            "-Users-tim-code-app-",
        ] {
            assert!(refers_to(name, "/Users/tim/code/app"), "{name}");
        }
        assert!(!refers_to("--Users-tim-code-apps--", "/Users/tim/code/app"));
    }

    #[test]
    fn remainder_keeps_the_separator_and_skips_the_checkout() {
        let prefix = "/Users/tim/code/app-";
        assert_eq!(
            remainder("--Users-tim-code-app-fix-editor--", prefix),
            Some("-fix-editor--")
        );
        // The checkout itself: nothing but wrapping follows.
        assert_eq!(remainder("--Users-tim-code-app--", "/Users/tim/code/app"), None);
        // A different project.
        assert_eq!(remainder("--Users-tim-code-other--", prefix), None);
    }

    #[test]
    fn a_dash_reads_as_a_separator_or_a_literal() {
        let disk = on_disk(&[
            "/Users/tim/code/app",
            "/Users/tim/code/app/apps",
            "/Users/tim/code/app/apps/web",
            "/Users/tim/code/app-fix-editor",
        ]);

        assert_eq!(
            resolve("/Users/tim/code", "app-apps-web", &disk),
            Some("/Users/tim/code/app/apps/web".to_string())
        );
        assert_eq!(
            resolve("/Users/tim/code", "app-fix-editor", &disk),
            Some("/Users/tim/code/app-fix-editor".to_string())
        );
    }

    #[test]
    fn a_path_that_is_gone_resolves_to_nothing() {
        let disk = on_disk(&["/Users/tim/code/app"]);
        assert_eq!(resolve("/Users/tim/code", "-app-old-branch--", &disk), None);
    }
}
