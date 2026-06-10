import { Schema } from "effect"
import { BranchName, DbName, HostPort, ProjectAlias, ProxyDomain, WorktreePath } from "./ids.js"

// ---------------------------------------------------------------------------
// Workspace entry — one per active worktree
// ---------------------------------------------------------------------------

export class Workspace extends Schema.Class<Workspace>("Workspace")({
  project: ProjectAlias,
  branch: BranchName,
  path: WorktreePath,
  port: HostPort,
  dbName: DbName,
  proxyDomain: ProxyDomain,
  created: Schema.String
}) {}

export const Workspaces = Schema.Array(Workspace)
export type Workspaces = typeof Workspaces.Type
