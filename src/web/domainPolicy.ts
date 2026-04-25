/**
 * Domain policy primitives for web tools.
 *
 * Pure functions, no I/O. Used by:
 * - WebFetchTool (host extraction, checkPolicy closure)
 * - permissions.ts findMatchingRules (rule.domain match)
 * - runToolUse.ts allow_by_rule construction (defensive validation)
 *
 * Pattern syntax:
 * - Exact host: `github.com` matches `github.com` only.
 * - Suffix wildcard: `*.github.com` matches `a.github.com`,
 *   `a.b.github.com`; does NOT match the apex `github.com`.
 * - Bare `*` is rejected (fail-closed).
 */

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i

/**
 * Extract the host from a URL string. Returns lowercased hostname (no
 * port, no userinfo). Returns null when:
 * - the string isn't a parseable URL
 * - the URL carries userinfo (`https://user:pass@host`) — refused so
 *   credentials don't leak into audit logs and so per-host policy
 *   keys remain stable
 */
export function extractHost(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.username !== '' || parsed.password !== '') return null
  return parsed.hostname.toLowerCase()
}

/**
 * Validate a domain pattern. Accepts:
 *   - exact: `github.com`
 *   - suffix wildcard: `*.github.com` (one wildcard, leftmost label only)
 * Rejects:
 *   - bare `*`
 *   - multiple wildcards (`*.*.example.com`)
 *   - empty string
 *   - patterns with whitespace
 *   - any pattern whose labels fail HOST_LABEL
 */
export function isValidDomainPattern(pattern: string): boolean {
  if (pattern.length === 0) return false
  if (/\s/.test(pattern)) return false

  const labels = pattern.split('.')
  if (labels.length < 2) return false

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]
    if (label === undefined || label.length === 0) return false
    if (i === 0 && label === '*') continue // wildcard allowed only as leftmost label
    if (!HOST_LABEL.test(label)) return false
  }

  return true
}

/**
 * Match a host against a domain pattern. Both pattern and host are
 * compared case-insensitively. The `*.suffix` form matches subdomains
 * only — the apex requires its own rule.
 *
 *   matchDomain('github.com', 'github.com')          → true
 *   matchDomain('github.com', 'gist.github.com')     → false
 *   matchDomain('*.github.com', 'gist.github.com')   → true
 *   matchDomain('*.github.com', 'a.b.github.com')    → true
 *   matchDomain('*.github.com', 'github.com')        → false
 *   matchDomain('*.github.com', 'evilgithub.com')    → false
 */
export function matchDomain(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()

  if (p.startsWith('*.')) {
    const suffix = p.slice(2)
    if (suffix.length === 0) return false
    if (h === suffix) return false // apex excluded
    return h.endsWith('.' + suffix)
  }

  return p === h
}
