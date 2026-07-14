// Debug builds report "dev" (mirrors `bun run dev`): update checks treat "dev"
// as always-up-to-date, so local builds never nag about releases.
#[cfg(debug_assertions)]
pub const VERSION: &str = "dev";
#[cfg(not(debug_assertions))]
pub const VERSION: &str = env!("SHIP_GIT_SHA");
