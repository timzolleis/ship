import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Workspace entry — one per active worktree
// ---------------------------------------------------------------------------

export class Workspace extends Schema.Class<Workspace>("Workspace")({
  project: Schema.String,
  branch: Schema.String,
  path: Schema.String,
  port: Schema.Number,
  dbName: Schema.String,
  proxyDomain: Schema.String,
  created: Schema.String
}) {}

export const Workspaces = Schema.Array(Workspace)
export type Workspaces = typeof Workspaces.Type
