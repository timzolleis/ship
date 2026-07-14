use crate::domain::env_patch::{patch_env_content, EnvChange, EnvPatchContext};
use crate::errors::{Error, Result};
use crate::schema::EnvConfig;
use std::fs;
use std::path::Path;

pub struct PatchResult {
    pub file: String,
    pub changes: Vec<EnvChange>,
}

/// Iterates the configured files, reads each source, delegates ALL line
/// transformation to `patch_env_content`, and writes the patched content to
/// the target. Missing source files are skipped.
pub fn patch_env_files(
    source_dir: &str,
    target_dir: &str,
    env: &EnvConfig,
    ctx: &EnvPatchContext,
) -> Result<Vec<PatchResult>> {
    let mut results = Vec::new();

    for file in &env.files {
        let source_path = Path::new(source_dir).join(file);
        let target_path = Path::new(target_dir).join(file);

        if !source_path.exists() {
            continue;
        }

        let content = fs::read_to_string(&source_path).map_err(|e| Error::ReadFile {
            path: source_path.display().to_string(),
            detail: e.to_string(),
        })?;

        let patched = patch_env_content(&content, env, ctx);

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::CreateDirectory {
                path: parent.display().to_string(),
                detail: e.to_string(),
            })?;
        }
        fs::write(&target_path, &patched.content).map_err(|e| Error::WriteFile {
            path: target_path.display().to_string(),
            detail: e.to_string(),
        })?;

        results.push(PatchResult {
            file: file.clone(),
            changes: patched.changes,
        });
    }

    Ok(results)
}
