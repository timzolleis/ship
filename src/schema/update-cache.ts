import { Schema } from "effect"

export class UpdateCache extends Schema.Class<UpdateCache>("UpdateCache")({
  /** ISO 8601 timestamp of the last successful GitHub release check. */
  lastCheckedAt: Schema.String,
  /** Tag of the latest release as reported by GitHub (e.g. a short commit SHA). */
  latestVersion: Schema.String
}) {}
