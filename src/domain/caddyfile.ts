import type { HostPort, ProxyDomain } from "../schema/ids.js"

// ---------------------------------------------------------------------------
// domain/caddyfile — pure Caddyfile route codec + port allocation.
//
// Semantics extracted verbatim from the original ProxyService:
//   - domain-block regex                   /^([a-z0-9][a-z0-9.\-]*)\s*\{/
//   - reverse_proxy host.docker.internal   /reverse_proxy\s+host\.docker\.internal:(\d+)/
//   - removeRoute: skip block lines, collapse blank runs (\n{3,} → \n\n),
//     trim, then a single trailing newline.
//   - nextPort: BASE_PORT = 5173; lowest free port above the base (hole-filling).
//
// No services, no IO, no Effect — brands imported from src/schema/ids.ts.
// ---------------------------------------------------------------------------

export interface Route {
  readonly domain: ProxyDomain
  readonly port: HostPort
}

export const BASE_PORT = 5173

const DOMAIN_RE = /^([a-z0-9][a-z0-9.\-]*)\s*\{/
const PROXY_RE = /reverse_proxy\s+host\.docker\.internal:(\d+)/

export const parseRoutes = (content: string): ReadonlyArray<Route> => {
  if (content.trim().length === 0) return []
  const routes: Route[] = []
  const lines = content.split("\n")
  let currentDomain: string | null = null
  for (const line of lines) {
    const domainMatch = line.match(DOMAIN_RE)
    if (domainMatch) currentDomain = domainMatch[1]!
    const proxyMatch = line.match(PROXY_RE)
    if (proxyMatch && currentDomain) {
      routes.push({
        domain: currentDomain as ProxyDomain,
        port: parseInt(proxyMatch[1]!, 10) as HostPort,
      })
      currentDomain = null
    }
  }
  return routes
}

export const addRoute = (content: string, route: Route): string => {
  const block = `\n${route.domain} {\n    reverse_proxy host.docker.internal:${route.port}\n}\n`
  return content + block
}

export const removeRoute = (content: string, domain: string): string => {
  const lines = content.split("\n")
  const result: string[] = []
  let skip = false
  for (const line of lines) {
    if (line.startsWith(`${domain} {`)) {
      skip = true
      continue
    }
    if (skip && line.trim() === "}") {
      skip = false
      continue
    }
    if (!skip) result.push(line)
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
}

export const nextPort = (
  routes: ReadonlyArray<Route>,
  base: number = BASE_PORT,
): HostPort => {
  const used = new Set<number>(routes.map((r) => r.port))
  let port = base + 1
  while (used.has(port)) port++
  return port as HostPort
}
