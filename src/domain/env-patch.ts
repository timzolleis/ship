import type { EnvConfig } from "../schema/config.js"
import type { DbName, HostPort, ProxyDomain } from "../schema/ids.js"

// ---------------------------------------------------------------------------
// domain/env-patch — pure .env content patching.
//
// Extracted line-rewriting from the legacy EnvService loop body. No services,
// no IO. The FS shell (services/env.ts) reads/writes files and delegates the
// per-line rewriting here.
//
// Rules (unchanged from the original implementation):
//   - Only lines matching /^([A-Z_]+)=(.+)$/ are candidates; everything else
//     (comments, blanks, non KEY=VALUE lines) is preserved verbatim.
//   - Keys absent from `env.autoDetected` are preserved verbatim.
//   - Surrounding single/double quotes are stripped from the value first.
//   - database_url → swap the trailing /<segment> for /<dbName>.
//   - proxy_url    → swap the http(s)://<origin> for https://<proxyDomain>.
//   - dev_url      → http://localhost:<port><configured path suffix>.
//   - plain        → untouched.
//   - A change is recorded (key/from/to) ONLY when the value actually changed.
// ---------------------------------------------------------------------------

export interface EnvPatchContext {
  readonly dbName: DbName
  readonly proxyDomain: ProxyDomain
  readonly port: HostPort
}

export interface EnvChange {
  readonly key: string
  readonly from: string
  readonly to: string
}

export interface EnvPatchResult {
  readonly content: string
  readonly changes: ReadonlyArray<EnvChange>
}

export const patchEnvContent = (
  content: string,
  env: EnvConfig,
  ctx: EnvPatchContext
): EnvPatchResult => {
  const changes: EnvChange[] = []
  const lines: string[] = []

  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.+)$/)
    if (!match) {
      lines.push(line)
      continue
    }
    const [, key, rawValue] = match
    if (!key || !rawValue) {
      lines.push(line)
      continue
    }

    const varConfig = env.autoDetected[key]
    if (!varConfig) {
      lines.push(line)
      continue
    }

    const value = rawValue.replace(/^["']|["']$/g, "")
    let newValue = value

    switch (varConfig.type) {
      case "database_url": {
        newValue = value.replace(/\/([^/]+)$/, `/${ctx.dbName}`)
        break
      }
      case "proxy_url": {
        newValue = value.replace(/https?:\/\/[^/]+/, `https://${ctx.proxyDomain}`)
        break
      }
      case "dev_url": {
        const urlPath = varConfig.path ?? ""
        newValue = `http://localhost:${ctx.port}${urlPath}`
        break
      }
      default:
        break
    }

    if (newValue !== value) {
      changes.push({ key, from: value, to: newValue })
    }
    lines.push(`${key}=${newValue}`)
  }

  return { content: lines.join("\n"), changes }
}
