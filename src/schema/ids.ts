import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Branded scalars — full branding (D11)
//
// Convention: brands are constructed at the edges only — CLI arg/prompt
// decoding (`Schema.decodeSync(BranchName)(input)`) and config-file schema
// decode. Internals pass brands through; no re-validation inside services.
// ---------------------------------------------------------------------------

export const ProjectAlias = Schema.String.pipe(Schema.brand("ProjectAlias"))
export type ProjectAlias = typeof ProjectAlias.Type

export const BranchName = Schema.String.pipe(Schema.brand("BranchName"))
export type BranchName = typeof BranchName.Type

/** Project root checkout. */
export const RepoPath = Schema.String.pipe(Schema.brand("RepoPath"))
export type RepoPath = typeof RepoPath.Type

/** Absolute worktree directory. */
export const WorktreePath = Schema.String.pipe(Schema.brand("WorktreePath"))
export type WorktreePath = typeof WorktreePath.Type

export const DbName = Schema.String.pipe(Schema.brand("DbName"))
export type DbName = typeof DbName.Type

export const ProxyDomain = Schema.String.pipe(Schema.brand("ProxyDomain"))
export type ProxyDomain = typeof ProxyDomain.Type

export const ContainerName = Schema.String.pipe(Schema.brand("ContainerName"))
export type ContainerName = typeof ContainerName.Type

export const HostPort = Schema.Number.pipe(Schema.int(), Schema.brand("HostPort"))
export type HostPort = typeof HostPort.Type
