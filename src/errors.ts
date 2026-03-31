import { Schema } from "effect"

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { alias: Schema.String }
) {
  get message() {
    return `Project '${this.alias}' not found. Run 'ship init' first.`
  }
}

export class InvalidConfigError extends Schema.TaggedError<InvalidConfigError>()(
  "InvalidConfigError",
  { detail: Schema.String }
) {
  get message() {
    return `Invalid config: ${this.detail}`
  }
}

export class RouteExistsError extends Schema.TaggedError<RouteExistsError>()(
  "RouteExistsError",
  { domain: Schema.String }
) {
  get message() {
    return `Route '${this.domain}' already exists.`
  }
}

export class RouteNotFoundError extends Schema.TaggedError<RouteNotFoundError>()(
  "RouteNotFoundError",
  { domain: Schema.String }
) {
  get message() {
    return `Route '${this.domain}' not found.`
  }
}

export class CertNotFoundError extends Schema.TaggedError<CertNotFoundError>()(
  "CertNotFoundError",
  {}
) {
  get message() {
    return "No CA cert yet. Start the proxy and make a request first."
  }
}
