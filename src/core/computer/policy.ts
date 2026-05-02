/**
 * v3 Phase 2: Computer-Use policy primitives (slice 1 of 2).
 *
 * Phase 2 ships:
 * - `isDomainAllowed`: routing-time domain check, used both at the navigate()
 *   pre-flight stage and at the page.route() interceptor stage.
 * - `isUrlSchemeAllowed`: URL-scheme check (HTTPS-only with a test-only http
 *   escape; data:/file:/javascript:/etc. always rejected).
 *
 * Phase 4 will extend this module with the risk classifier (level 0..4 actions,
 * dangerous-label detection, sensitive-field detection).
 *
 * Reuses `extractHost` and `matchDomain` from `src/web/domainPolicy.ts` so the
 * domain pattern syntax is identical to webPolicy: exact host or `*.host`.
 */

import { extractHost, matchDomain } from '../../web/domainPolicy.js'

export type DomainCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly reason: 'denied' | 'not_in_allowlist' | 'malformed_url'
    }

/**
 * Decide whether a URL's host is allowed under this session's domain policy.
 *
 * Rules:
 * 1. Malformed URL (cannot extract host) -> `malformed_url`.
 * 2. Denylist hit beats everything -> `denied`.
 * 3. If `requireAllowlist` and allowlist is non-empty: host must match at least
 *    one entry, else `not_in_allowlist`.
 * 4. If `requireAllowlist` is false (test-only): allow.
 * 5. Otherwise: allow.
 *
 * The empty-allowlist case with `requireAllowlist: true` is intentionally NOT
 * handled here — `navigate()` rejects with `allowlist_empty` before reaching
 * this function.
 */
export function isDomainAllowed(
  url: string,
  settings: { allowedDomains: readonly string[]; deniedDomains: readonly string[] },
  opts: { requireAllowlist: boolean },
): DomainCheck {
  const host = extractHost(url)
  if (host === null) {
    return { allowed: false, reason: 'malformed_url' }
  }
  for (const pattern of settings.deniedDomains) {
    if (matchDomain(pattern, host)) {
      return { allowed: false, reason: 'denied' }
    }
  }
  if (opts.requireAllowlist) {
    if (settings.allowedDomains.length === 0) {
      // Caller should have rejected earlier with allowlist_empty.
      // Treat as not_in_allowlist defensively.
      return { allowed: false, reason: 'not_in_allowlist' }
    }
    for (const pattern of settings.allowedDomains) {
      if (matchDomain(pattern, host)) {
        return { allowed: true }
      }
    }
    return { allowed: false, reason: 'not_in_allowlist' }
  }
  return { allowed: true }
}

export type SchemeCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly reason: 'unsupported_scheme' | 'malformed_url'
    }

/**
 * Decide whether a URL's scheme is allowed.
 *
 * - `https:` always allowed.
 * - `http:` allowed only when `allowHttpForTest === true` (integration tests).
 * - All other schemes (`data:`, `file:`, `javascript:`, `chrome:`, `blob:`,
 *   `ws:`, `wss:`, `ftp:`, ...) always rejected.
 */
export function isUrlSchemeAllowed(
  url: string,
  opts: { allowHttpForTest: boolean },
): SchemeCheck {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: 'malformed_url' }
  }
  if (parsed.protocol === 'https:') return { allowed: true }
  if (parsed.protocol === 'http:' && opts.allowHttpForTest) return { allowed: true }
  return { allowed: false, reason: 'unsupported_scheme' }
}
