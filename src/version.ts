// SHIP_VERSION_CONST is injected at build time via Bun's --define flag.
// Source default is "dev" so `bun run dev` shows "dev" and the compiled binary
// shows the short commit SHA (e.g. "1583048"). Update checks treat "dev" as
// always-up-to-date (no notice while developing from source).
declare const SHIP_VERSION_CONST: string | undefined
export const VERSION: string =
  typeof SHIP_VERSION_CONST !== "undefined" ? SHIP_VERSION_CONST : "dev"
