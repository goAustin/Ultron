/**
 * v3 Phase 0: validator and defaults for the `computerUse` settings section.
 *
 * Pure module — no I/O. Contract is the same as `src/web/rulesSeed.ts`:
 * "boot must never throw". Invalid leaves warn to stderr and fall back to
 * the per-field default. Sibling leaves are independent: one bad value does
 * not poison the rest.
 *
 * Input is `unknown` (not `ComputerUseSettingsInput | undefined`) because
 * `readSettingsConfig()` casts parsed JSON without runtime validation —
 * `settings.computerUse` may be a string, null, array, or any JSON value.
 *
 * Phase 0 only ships the validator + boot-time invocation in `QueryEngine`.
 * The result is discarded today; Phase 3 will store it where the conditional
 * registry can read it for tool gating. See `docs/ultron_v3/v3-phase0-design.md`.
 */

import { extractHost, isValidDomainPattern } from '../web/domainPolicy.js'

export type ComputerUseSettings = {
  enabled: boolean
  defaultEnvironment: 'browser' | 'desktop'
  viewport: { width: number; height: number }
  displaySize: { width: number; height: number }
  maxSteps: number
  maxDurationMs: number
  maxScreenshotBytes: number
  maxScreenshotDimensions: { width: number; height: number }
  ariaSnapshotMaxTokens: number
  allowedDomains: readonly string[]
  deniedDomains: readonly string[]
  persistProfiles: boolean
  allowDownloads: boolean
  allowUploads: boolean
  allowAuthHandoff: boolean
  debugPersistScreenshots: boolean
  /**
   * Phase 4·2 — extra CSS selectors for sensitive-region detection. Appended
   * to the built-in list (`SENSITIVE_SELECTORS` in `redaction.ts`) when the
   * BrowserSession queries the page for elements whose pixels should be
   * blacked out before the screenshot leaves the runtime.
   *
   * Empty array (default) means "use built-ins only." Invalid entries are
   * skipped with a warn at boot — bad selectors never throw at runtime.
   */
  redactionSelectors: readonly string[]
  /**
   * Phase 4·2 — toggle for the post-action verify pipeline. When `true`
   * (default) every action tool captures pre/post ARIA + screenshots and
   * appends a WARNING to the result text when neither signal detected
   * change. Set `false` to skip pre-state capture and verification — saves
   * one ARIA snapshot per action, at the cost of losing the
   * "claimed-clicked-but-didn't" guard.
   */
  verifyActions: boolean
  /**
   * Phase 4·3 — opt-in CLI watch-mode renderer. When `true` AND the CLI's
   * stderr is a TTY, every Computer-tool event (start, ask, allow/deny,
   * finish) renders one line to stderr so the user can follow what the
   * model is doing in the browser. Defaults to `false` (silent — stderr is
   * left alone). No-op on piped stderr regardless of this setting.
   */
  watchMode: boolean
  /**
   * SDK strict mode. When `true`, `SessionManager.start` throws
   * `BrowserSessionError(kind: 'allowlist_empty')` if `allowedDomains` is
   * empty — preserving the old fail-fast behavior for headless callers that
   * have no operator to answer a runtime prompt. CLI defaults to `false`:
   * an empty allowlist starts cleanly, and per-navigate prompts handle the
   * gate. SDK consumers wanting strict pre-flight set this to `true`.
   */
  requireAllowlistAtStart: boolean
  /**
   * CDP backend endpoint. When set, `ComputerStart` defaults to attaching to
   * a Chrome the user has already started with `--remote-debugging-port=…`
   * via `chromium.connectOverCDP()`, instead of launching Playwright's
   * bundled Chromium-for-Testing binary. The agent runs in an **isolated new
   * BrowserContext** inside that Chrome process; the user's existing tabs
   * are untouched. Bind the port to `127.0.0.1` only — anyone with network
   * access to the port can drive that Chrome.
   *
   * Accepted schemes: `http://`, `https://`, `ws://`, `wss://`. Invalid URLs
   * warn at boot and fall back to undefined (bundled-Chromium launch).
   * See `docs/computer-use.md` § "Driving your real Chrome via CDP" and
   * `docs/ultron_v3/v3-cdp-backend-design.md`.
   */
  cdpEndpoint?: string
  /**
   * Whether the CDP-attached Chrome is operator-visible. Used as the value
   * of `BrowserSession.headless` for CDP sessions, which `ComputerHandoffToUser`
   * keys on to refuse handoff against an invisible browser.
   *
   * Defaults to `false` (fail-safe): we cannot introspect the connected
   * Chrome's `--headless` flag, so by default a CDP session reports
   * `headless: true` (= invisible) and handoff is refused. Set this to
   * `true` only when you are running a visible Chrome with
   * `--remote-debugging-port` and want to allow `ComputerHandoffToUser`.
   */
  cdpAssumeVisible: boolean
}

export const defaultComputerUseSettings: ComputerUseSettings = {
  enabled: false,
  defaultEnvironment: 'browser',
  viewport: { width: 1024, height: 768 },
  displaySize: { width: 1024, height: 768 },
  maxSteps: 30,
  maxDurationMs: 300_000,
  maxScreenshotBytes: 2_000_000,
  maxScreenshotDimensions: { width: 1024, height: 768 },
  ariaSnapshotMaxTokens: 4000,
  allowedDomains: [],
  deniedDomains: [],
  persistProfiles: false,
  allowDownloads: false,
  allowUploads: false,
  allowAuthHandoff: false,
  debugPersistScreenshots: false,
  redactionSelectors: [],
  verifyActions: true,
  watchMode: false,
  requireAllowlistAtStart: false,
  cdpAssumeVisible: false,
}

const VIEWPORT_MAX = 4096
// Hard cap from the v3 plan (Anthropic accuracy guidance, XGA-class).
const SCREENSHOT_DIM_CAP_W = 1280
const SCREENSHOT_DIM_CAP_H = 800

function warn(msg: string): void {
  process.stderr.write(`[ultron] settings.json: ${msg}\n`)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function describeKind(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function validateBoolean(v: unknown, field: string, dflt: boolean): boolean {
  if (v === undefined) return dflt
  if (typeof v !== 'boolean') {
    warn(`computerUse.${field} must be boolean; got ${describeKind(v)}; using default`)
    return dflt
  }
  return v
}

function validateInteger(
  v: unknown,
  field: string,
  dflt: number,
  min: number,
  max: number,
): number {
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    warn(`computerUse.${field} must be an integer; got ${describeKind(v)}; using default`)
    return dflt
  }
  if (v < min || v > max) {
    warn(`computerUse.${field} = ${v} out of range [${min}, ${max}]; using default`)
    return dflt
  }
  return v
}

function validateDimensions(
  v: unknown,
  field: string,
  dflt: { width: number; height: number },
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  if (v === undefined) return { ...dflt }
  if (!isPlainObject(v)) {
    warn(`computerUse.${field} must be an object; got ${describeKind(v)}; using default`)
    return { ...dflt }
  }
  return {
    width: validateInteger(v.width, `${field}.width`, dflt.width, 1, maxW),
    height: validateInteger(v.height, `${field}.height`, dflt.height, 1, maxH),
  }
}

function validateEnvironment(v: unknown): 'browser' | 'desktop' {
  if (v === undefined) return defaultComputerUseSettings.defaultEnvironment
  if (v === 'browser' || v === 'desktop') return v
  warn(
    `computerUse.defaultEnvironment must be "browser" or "desktop"; got ${JSON.stringify(v)}; using default`,
  )
  return defaultComputerUseSettings.defaultEnvironment
}

function validateDomainList(v: unknown, field: string): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    warn(`computerUse.${field} must be an array; got ${describeKind(v)}; using empty list`)
    return []
  }
  const out: string[] = []
  for (let i = 0; i < v.length; i++) {
    const entry = v[i]
    if (typeof entry !== 'string') {
      warn(`computerUse.${field}[${i}] is not a string; skipping`)
      continue
    }
    const lowered = entry.toLowerCase()
    if (!isValidDomainPattern(lowered)) {
      warn(`computerUse.${field}[${i}] = ${JSON.stringify(entry)} is not a valid host pattern; skipping`)
      continue
    }
    out.push(lowered)
  }
  return out
}

/**
 * CDP backend — validate the optional `cdpEndpoint` URL. Returns the
 * canonical `URL.toString()` form on success, `undefined` (with a warn) on
 * any failure. Accepted schemes: `http(s):` for HTTP-served CDP discovery
 * (`http://127.0.0.1:9222`) and `ws(s):` for direct browser-WS endpoints
 * (`ws://127.0.0.1:9222/devtools/browser/<uuid>`). All other schemes —
 * `javascript:`, `file:`, `data:`, etc. — are rejected.
 */
function validateCdpEndpoint(v: unknown): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    warn(`computerUse.cdpEndpoint must be a string; got ${describeKind(v)}; using default (unset)`)
    return undefined
  }
  if (v.length === 0) {
    warn('computerUse.cdpEndpoint must be a non-empty string; using default (unset)')
    return undefined
  }
  let parsed: URL
  try {
    parsed = new URL(v)
  } catch {
    warn(`computerUse.cdpEndpoint = ${JSON.stringify(v)} is not a valid URL; using default (unset)`)
    return undefined
  }
  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'ws:' &&
    parsed.protocol !== 'wss:'
  ) {
    warn(
      `computerUse.cdpEndpoint scheme must be http(s): or ws(s):; got ${parsed.protocol.replace(':', '')}; using default (unset)`,
    )
    return undefined
  }
  return parsed.toString()
}

/**
 * Phase 4·2 — validate `redactionSelectors`. Each entry must be a non-empty
 * string. We can't fully syntax-check arbitrary CSS selectors here without
 * pulling in a parser, so we just trim + dedupe; the BrowserSession's
 * `page.locator(...)` will surface a Playwright error at runtime if a
 * selector is malformed (and the redaction layer swallows that into a
 * "no regions found" result, never blocking the screenshot).
 */
function validateSelectorList(v: unknown, field: string): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    warn(`computerUse.${field} must be an array; got ${describeKind(v)}; using empty list`)
    return []
  }
  const out: string[] = []
  for (let i = 0; i < v.length; i++) {
    const entry = v[i]
    if (typeof entry !== 'string') {
      warn(`computerUse.${field}[${i}] is not a string; skipping`)
      continue
    }
    const trimmed = entry.trim()
    if (trimmed.length === 0) {
      warn(`computerUse.${field}[${i}] is empty; skipping`)
      continue
    }
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

export function validateComputerUseSettings(raw: unknown): ComputerUseSettings {
  if (raw === undefined) {
    return {
      ...defaultComputerUseSettings,
      viewport: { ...defaultComputerUseSettings.viewport },
      displaySize: { ...defaultComputerUseSettings.displaySize },
      maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
      allowedDomains: [],
      deniedDomains: [],
    }
  }
  if (!isPlainObject(raw)) {
    warn(`computerUse must be an object; got ${describeKind(raw)}; using defaults`)
    return {
      ...defaultComputerUseSettings,
      viewport: { ...defaultComputerUseSettings.viewport },
      displaySize: { ...defaultComputerUseSettings.displaySize },
      maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
      allowedDomains: [],
      deniedDomains: [],
    }
  }

  const cdpEndpoint = validateCdpEndpoint(raw.cdpEndpoint)

  return {
    enabled: validateBoolean(raw.enabled, 'enabled', defaultComputerUseSettings.enabled),
    defaultEnvironment: validateEnvironment(raw.defaultEnvironment),
    viewport: validateDimensions(
      raw.viewport,
      'viewport',
      defaultComputerUseSettings.viewport,
      VIEWPORT_MAX,
      VIEWPORT_MAX,
    ),
    displaySize: validateDimensions(
      raw.displaySize,
      'displaySize',
      defaultComputerUseSettings.displaySize,
      VIEWPORT_MAX,
      VIEWPORT_MAX,
    ),
    maxSteps: validateInteger(
      raw.maxSteps,
      'maxSteps',
      defaultComputerUseSettings.maxSteps,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxDurationMs: validateInteger(
      raw.maxDurationMs,
      'maxDurationMs',
      defaultComputerUseSettings.maxDurationMs,
      1000,
      Number.MAX_SAFE_INTEGER,
    ),
    maxScreenshotBytes: validateInteger(
      raw.maxScreenshotBytes,
      'maxScreenshotBytes',
      defaultComputerUseSettings.maxScreenshotBytes,
      1024,
      Number.MAX_SAFE_INTEGER,
    ),
    maxScreenshotDimensions: validateDimensions(
      raw.maxScreenshotDimensions,
      'maxScreenshotDimensions',
      defaultComputerUseSettings.maxScreenshotDimensions,
      SCREENSHOT_DIM_CAP_W,
      SCREENSHOT_DIM_CAP_H,
    ),
    ariaSnapshotMaxTokens: validateInteger(
      raw.ariaSnapshotMaxTokens,
      'ariaSnapshotMaxTokens',
      defaultComputerUseSettings.ariaSnapshotMaxTokens,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    allowedDomains: validateDomainList(raw.allowedDomains, 'allowedDomains'),
    deniedDomains: validateDomainList(raw.deniedDomains, 'deniedDomains'),
    persistProfiles: validateBoolean(
      raw.persistProfiles,
      'persistProfiles',
      defaultComputerUseSettings.persistProfiles,
    ),
    allowDownloads: validateBoolean(
      raw.allowDownloads,
      'allowDownloads',
      defaultComputerUseSettings.allowDownloads,
    ),
    allowUploads: validateBoolean(
      raw.allowUploads,
      'allowUploads',
      defaultComputerUseSettings.allowUploads,
    ),
    allowAuthHandoff: validateBoolean(
      raw.allowAuthHandoff,
      'allowAuthHandoff',
      defaultComputerUseSettings.allowAuthHandoff,
    ),
    debugPersistScreenshots: validateBoolean(
      raw.debugPersistScreenshots,
      'debugPersistScreenshots',
      defaultComputerUseSettings.debugPersistScreenshots,
    ),
    redactionSelectors: validateSelectorList(raw.redactionSelectors, 'redactionSelectors'),
    verifyActions: validateBoolean(
      raw.verifyActions,
      'verifyActions',
      defaultComputerUseSettings.verifyActions,
    ),
    watchMode: validateBoolean(
      raw.watchMode,
      'watchMode',
      defaultComputerUseSettings.watchMode,
    ),
    requireAllowlistAtStart: validateBoolean(
      raw.requireAllowlistAtStart,
      'requireAllowlistAtStart',
      defaultComputerUseSettings.requireAllowlistAtStart,
    ),
    ...(cdpEndpoint !== undefined ? { cdpEndpoint } : {}),
    cdpAssumeVisible: validateBoolean(
      raw.cdpAssumeVisible,
      'cdpAssumeVisible',
      defaultComputerUseSettings.cdpAssumeVisible,
    ),
  }
}

/**
 * Derive the persistence patterns to write into `computerUse.allowedDomains`
 * when the user picks "Allow by rule" for a host.
 *
 * Strips a leading `www.` (if present) and returns `[apex, *.apex]` so that
 * both the apex and any subdomain of the apex match. The wildcard form does
 * NOT match the apex by itself (`domainPolicy.ts:84`), so persisting both
 * patterns is required to cover `youtube.com` AND `m.youtube.com` after a
 * single approval of `www.youtube.com`.
 *
 * Examples:
 *   www.youtube.com    → [youtube.com, *.youtube.com]
 *   youtube.com        → [youtube.com, *.youtube.com]
 *   studio.youtube.com → [studio.youtube.com, *.studio.youtube.com]
 *   github.io          → [github.io, *.github.io]   (over-broad for eTLDs;
 *                       no PSL dependency, documented limitation)
 *
 * Returns an empty array when the input is unusable (empty, malformed, or
 * produces patterns that fail `isValidDomainPattern`). Caller treats the
 * empty case as "skip persistence" — the in-memory overlay still applies.
 */
export function derivePersistencePatterns(host: string): readonly string[] {
  if (typeof host !== 'string' || host.length === 0) return []
  const lowered = host.toLowerCase()
  const apex = lowered.startsWith('www.') && lowered.length > 4
    ? lowered.slice(4)
    : lowered
  const wildcard = `*.${apex}`
  const out: string[] = []
  if (isValidDomainPattern(apex)) out.push(apex)
  if (isValidDomainPattern(wildcard)) out.push(wildcard)
  return out
}

// Keep `extractHost` re-exported for callers that derive a pattern from a URL
// in one step. The persistence helper above stays host-only so it's
// straightforward to unit-test without URL parsing in the inputs.
export { extractHost as extractHostForPersistence }
