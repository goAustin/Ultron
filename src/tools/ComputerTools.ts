/**
 * v3 Phase 3: Computer-Use tool surface.
 *
 * `createComputerUseTools(deps)` returns the 11 model-facing Computer tools.
 * Each tool captures `sessionManager` and `settings` in a closure (mirroring
 * `src/tools/MemoryTools.ts::createMemoryTools`). Tools depend on the
 * `BrowserSession` interface, never on Playwright directly — Profile B/C
 * plug in under the same shape.
 *
 * Permission posture (Phase 3): every tool except `ComputerHandoffToUser`
 * returns `'allow'` from `checkPermissions`. The cascade falls through to
 * step 6 (per-host allow rules) and step 7 (fallback ask). Returning `'ask'`
 * from `checkPermissions` would short-circuit the cascade at step 3 and
 * prevent allow rules from ever running — the WebFetch posture, mirrored
 * here. Phase 4's risk classifier lives at cascade step 4 (safety checks)
 * which runs BEFORE allow rules and therefore stays non-bypassable.
 *
 * Action tools auto-observe: every mutating tool calls `stabilize()` then
 * `screenshot()` and returns the post-action PNG as a `ToolResultAttachment`
 * (Phase 1 substrate). The model never has to emit a separate Observe call.
 *
 * Error mapping: `BrowserSessionError(kind: 'aborted')` would otherwise be
 * wrapped as `errorKind: 'execution_error'` by `runToolUse.ts:265`. The
 * shared `mapBrowserSessionError` helper catches every BrowserSessionError
 * shape and maps it to the right `ToolErrorKind` so acceptance criterion 2
 * ("Each tool returns `aborted` when the query signal aborts") holds.
 *
 * See `docs/ultron_v3/v3-phase3-design.md`.
 */

import type { ComputerUseSettings } from '../config/computerUseSettings.js'
import { extractHost } from '../web/domainPolicy.js'
import {
  buildLocator,
  type AtomAction,
} from '../core/computer/atomResolver.js'
import {
  normalizedToCssPx as _normalizedToCssPx, // imported only to keep the import
  validateNormalizedPoint,
} from '../core/computer/coordinates.js'
import { aHash8x8 } from '../core/computer/pHash.js'
import { isDomainAllowed, isUrlSchemeAllowed } from '../core/computer/policy.js'
import { buildAtomCache } from '../core/computer/selectorCache.js'
import { serializeAtoms } from '../core/computer/atomResolver.js'
import { loadStorageState, writeStorageState } from '../core/computer/storageStateStore.js'
import {
  BrowserSessionError,
  type BrowserSession,
  type ComputerSessionId,
  type ComputerSessionManager,
  type MouseButton,
  type NormalizedPoint,
  type ScreenshotResult,
} from '../core/computer/types.js'
import { verify, type VerifyResult } from '../core/computer/verify.js'
import {
  buildTool,
  type Tool,
  type ToolResult,
  type ToolResultAttachment,
} from '../core/tools/types.js'

// Re-export to silence "unused import" without dropping the documented
// boundary. `normalizedToCssPx` lives in the session implementation; tools
// only need `validateNormalizedPoint`.
void _normalizedToCssPx

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export type ComputerUseToolsDeps = {
  readonly sessionManager: ComputerSessionManager
  readonly settings: ComputerUseSettings
}

export type ComputerUseTools = {
  start: Tool
  observe: Tool
  navigate: Tool
  click: Tool
  type: Tool
  key: Tool
  scroll: Tool
  drag: Tool
  wait: Tool
  handoffToUser: Tool
  stop: Tool
  // Phase 4b — DOM-first action path.
  observeActions: Tool
  actAtom: Tool
}

export function createComputerUseTools(deps: ComputerUseToolsDeps): ComputerUseTools {
  return {
    start: buildStartTool(deps),
    observe: buildObserveTool(deps),
    navigate: buildNavigateTool(deps),
    click: buildClickTool(deps),
    type: buildTypeTool(deps),
    key: buildKeyTool(deps),
    scroll: buildScrollTool(deps),
    drag: buildDragTool(deps),
    wait: buildWaitTool(deps),
    handoffToUser: buildHandoffToUserTool(deps),
    stop: buildStopTool(deps),
    observeActions: buildObserveActionsTool(deps),
    actAtom: buildActAtomTool(deps),
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_TYPE_BYTES = 1024
const MAX_WAIT_MS = 10_000
// Closed allowlist of bare keys. Chord prefixes can wrap any of these (or a
// single alphanumeric character) — see `validateKey`.
const ALLOWED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])
const ALLOWED_CHORD_PREFIXES = ['ControlOrMeta+', 'Control+', 'Meta+', 'Alt+', 'Shift+'] as const

function isValidKey(key: string): boolean {
  if (ALLOWED_KEYS.has(key)) return true
  // Strip any number of chord prefixes from the front, then validate the suffix.
  let suffix = key
  let stripped = false
  // Limit iterations to avoid pathological inputs.
  for (let i = 0; i < 8; i++) {
    let consumed = false
    for (const prefix of ALLOWED_CHORD_PREFIXES) {
      if (suffix.startsWith(prefix)) {
        suffix = suffix.slice(prefix.length)
        consumed = true
        stripped = true
        break
      }
    }
    if (!consumed) break
  }
  if (!stripped) return false
  return /^[A-Za-z0-9]$/.test(suffix) || ALLOWED_KEYS.has(suffix)
}

function hasDisallowedControlChars(text: string): boolean {
  // Allow \t (0x09), \n (0x0A), \r (0x0D); reject other control chars including DEL.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

function errorResult(
  errorKind: ToolResult['errorKind'],
  content: string,
): ToolResult {
  return { content, isError: true, errorKind }
}

/**
 * Map a `BrowserSessionError` (and any other thrown value) into a `ToolResult`
 * with the right `errorKind`. Without this helper, `runToolUse.ts:265` wraps
 * every throw as `'execution_error'`, including the `'aborted'` kind that
 * acceptance criterion 2 requires to surface as `errorKind: 'aborted'`.
 */
export function mapBrowserSessionError(err: unknown): ToolResult {
  if (err instanceof BrowserSessionError) {
    switch (err.kind) {
      case 'aborted':
        return errorResult('aborted', '[aborted]')
      case 'session_closed':
        return errorResult(
          'execution_error',
          'Session is closed; create a new one with ComputerStart',
        )
      case 'domain_denied':
      case 'scheme_denied':
      case 'allowlist_empty':
        return errorResult('permission_denied', err.message)
      case 'chromium_not_installed':
      case 'navigation_failed':
      case 'screenshot_failed':
      case 'screenshot_oversized':
      case 'interaction_failed':
      case 'timeout':
      case 'viewport_mismatch':
        return errorResult('execution_error', err.message)
      case 'atom_locator_failed':
        // Phase 4b — both locator-preflight failures (zero-match AND
        // bbox-drift) converge here. We deliberately do NOT echo `err.message`
        // (which contains internal diagnostics; the call-site keeps it
        // generic, but the policy is mapper-side: never surface the raw
        // locator/name into model-visible output). The recovery message is
        // self-composed and identical to the cache-miss path's message so
        // the model sees one consistent retry signal.
        return errorResult(
          'atom_resolution_failed',
          'The atom is no longer resolvable on the current page (it may have been removed or the page changed). ' +
            'Re-observe with ComputerObserveActions, or fall back to ComputerClick / ComputerType.',
        )
    }
  }
  return errorResult(
    'execution_error',
    err instanceof Error ? err.message : String(err),
  )
}

/**
 * Validate that `sessionIdInput` resolves to a live session. Used in
 * `validateInput` so the cascade never prompts/asks/denies on an impossible
 * tool call (which would happen if the existence check only ran in `call()`,
 * AFTER the permission cascade).
 *
 * Returns ValidationResult so it can be returned verbatim from validateInput.
 * `call()` still re-checks via `resolveSession` as defense-in-depth: a
 * session may close between validate-time and call-time (timeout, abort).
 */
function validateSessionId(
  deps: ComputerUseToolsDeps,
  sessionIdInput: unknown,
): { valid: true } | { valid: false; message: string } {
  if (typeof sessionIdInput !== 'string' || sessionIdInput.length === 0) {
    return { valid: false, message: 'sessionId must be a non-empty string' }
  }
  const session = deps.sessionManager.get(sessionIdInput as ComputerSessionId)
  if (!session) {
    return { valid: false, message: `unknown sessionId: ${sessionIdInput}` }
  }
  if (session.isClosed()) {
    return { valid: false, message: `session is closed: ${sessionIdInput}` }
  }
  return { valid: true }
}

/**
 * Look up a session by id. Returns either the live session or a `ToolResult`
 * the caller should return verbatim. Phase 3 chooses `validation_failed` for
 * unknown ids (the model gave us bad input) and `execution_error` for
 * already-closed sessions (input was good but the world moved on between
 * validateInput and call()).
 */
function resolveSession(
  deps: ComputerUseToolsDeps,
  sessionIdInput: unknown,
): { ok: true; session: BrowserSession } | { ok: false; result: ToolResult } {
  if (typeof sessionIdInput !== 'string' || sessionIdInput.length === 0) {
    return { ok: false, result: errorResult('validation_failed', 'sessionId must be a non-empty string') }
  }
  const session = deps.sessionManager.get(sessionIdInput as ComputerSessionId)
  if (!session) {
    return {
      ok: false,
      result: errorResult('validation_failed', `unknown sessionId: ${sessionIdInput}`),
    }
  }
  if (session.isClosed()) {
    return {
      ok: false,
      result: errorResult(
        'execution_error',
        'Session is closed; create a new one with ComputerStart',
      ),
    }
  }
  return { ok: true, session }
}

/**
 * `getDomain` for session-bound action tools. Resolves the session's current
 * URL host so that:
 *
 * 1. `findMatchingRules` matches existing per-host rules (e.g., the user
 *    previously approved `{tool: 'ComputerClick', domain: 'github.com',
 *    behavior: 'allow'}`).
 * 2. `buildAllowByRule` SCOPES new rules to the current host instead of
 *    creating a tool-name-only rule that would allow the action on every
 *    future page in every future session. When `currentUrl()` is null or
 *    unparseable, returning `undefined` makes `buildAllowByRule` REFUSE to
 *    create any rule (see `runToolUse.ts:198`) — safer than a broad rule.
 *
 * This applies to every mutating action tool (click/type/key/scroll/drag/
 * handoffToUser). `ComputerNavigate` uses its own `getDomain` keyed on the
 * input URL since that's the domain the action is changing TO. `ComputerStop`
 * has no per-host scope and intentionally omits `getDomain`.
 */
function makeSessionGetDomain(
  deps: ComputerUseToolsDeps,
): (input: Record<string, unknown>) => string | undefined {
  return (input) => {
    if (typeof input.sessionId !== 'string') return undefined
    const session = deps.sessionManager.get(input.sessionId as ComputerSessionId)
    if (!session) return undefined
    const url = session.currentUrl()
    if (url === null) return undefined
    return extractHost(url) ?? undefined
  }
}

/**
 * v3 Phase 4·2 — `runActionAndObserve` is the central post-action seam used
 * by every mutating Computer tool.
 *
 * Flow when verification is enabled:
 *   1. Capture pre-action ARIA snapshot + screenshot (best-effort; failures
 *      are swallowed — verification is informational, never blocking).
 *   2. Run the caller-supplied action lambda.
 *   3. `stabilize()` + post-action `screenshot()` (real errors here ARE
 *      surfaced — that's the action's actual outcome).
 *   4. Capture post-action ARIA snapshot (best-effort; primes the cache for
 *      the next SafetyCheck regardless of verification state).
 *   5. Run `verify({ before, after })`. If `verified === false` AND at least
 *      one signal was available, append a WARNING to the result text so the
 *      model re-observes instead of advancing.
 *
 * When `opts.verify === false` (engine-disabled or read-only `ComputerObserve`),
 * we still capture the post-action ARIA snapshot opportunistically — this
 * is what primes `lastAriaSnapshot()` for the next click's SafetyCheck.
 * Without this, disabling verification would silently break the dangerous-
 * click prompt path, which is much worse than the small cost of one extra
 * ARIA capture.
 */
async function runActionAndObserve(
  session: BrowserSession,
  signal: AbortSignal,
  prefix: string,
  action: () => Promise<void>,
  opts: {
    readonly verify: boolean
    readonly attachScreenshot?: boolean
    /**
     * v3 Phase 5 — when `true`, calls `sessionManager.recordStep(...)` after
     * the action so the step counter and no-progress detector observe this
     * turn. MUST be `true` for mutating tools (Navigate/Click/Type/Key/Scroll/
     * Drag/ActAtom) and MUST be `false` (or omitted) for read-only paths
     * (Observe, handoff-resume observation, ObserveActions) — the counter
     * measures mutating page interactions only.
     */
    readonly countStep?: boolean
  },
  // Review fix #3 — required (not optional). TS now enforces what the
  // doc-comment promised: every caller must provide the manager, so the
  // `countStep: true` branch can never silently no-op due to a missing arg.
  sessionManager: ComputerSessionManager,
): Promise<ToolResult> {
  let preAria: string | null = null
  let prePng: Uint8Array | null = null
  if (opts.verify) {
    preAria = await safelyAriaHash(session, signal)
    prePng = await safelyScreenshotBytes(session, signal)
  }

  await action()

  await session.stabilize(signal)
  const result = await session.screenshot(signal)

  // Always opportunistically refresh the ARIA cache so the next action's
  // SafetyCheck sees the current page state. The Phase 4·1 fix #1 ensured
  // observeAndPack does this; runActionAndObserve preserves the same
  // contract regardless of `opts.verify`.
  //
  // Phase 4·2 fix #8 — non-abort errors are best-effort (verification is
  // informational), but `BrowserSessionError(kind: 'aborted')` MUST
  // propagate so user-initiated cancels aren't silently eaten.
  let postAria: string | null = null
  try {
    const snap = await session.ariaSnapshot(signal)
    postAria = snap.hash
  } catch (err) {
    if (isAbortError(err)) throw err
    /* swallow — verification is best-effort */
  }

  // Decode post-action PNG once: verify needs it for pHash, and the Phase 5
  // step-counter reuses the same hash to feed `recordStep`. No extra
  // round-trip — `result.attachment.data` is already in hand.
  const postPng = decodeAttachmentToBytes(result.attachment.data)

  let warning = ''
  let verdict: VerifyResult | null = null
  if (opts.verify) {
    verdict = verify(
      { ariaHash: preAria, pngBuffer: prePng },
      { ariaHash: postAria, pngBuffer: postPng },
    )
    if (
      !verdict.verified &&
      (verdict.signals.aria.availability === 'available' ||
        verdict.signals.pHash.availability === 'available')
    ) {
      warning =
        '\nWARNING: post-action verification did not detect a page change. ' +
        'Re-observe before assuming success.'
    }
  }

  // v3 Phase 5 — step counting + no-progress detection. Opt-in per call so
  // observation paths don't mis-count. `sessionManager` is required at the
  // signature (review fix #3), so the only knob is the boolean.
  if (opts.countStep === true) {
    let phashHex: string | null = null
    try {
      phashHex = aHash8x8(postPng).toString(16)
    } catch {
      // pHash decode failure isn't an action failure — leave null and let
      // the no-progress detector treat it as a missing signal.
    }
    const decision = sessionManager.recordStep(session.id, {
      ariaHash: postAria,
      phash: phashHex,
      verified: opts.verify ? (verdict?.verified ?? null) : null,
    })
    if (decision.abort) {
      return errorResult(
        'execution_error',
        `Computer-Use aborted: ${decision.reason}. Re-plan or hand off to the user.`,
      )
    }
  }

  // Phase 4b — `ComputerActAtom` passes `attachScreenshot: false` so the
  // model receives no image input on the atom-action turn (acceptance:
  // "without the model receiving a screenshot for that turn"). Internal
  // capture above still ran — verify needs the bytes for pHash and the
  // ARIA refresh primes `lastAriaSnapshot()` for the next safety check.
  // Coordinate tools default to `attachScreenshot: true` so their post-
  // action observation continues unchanged.
  const attachScreenshot = opts.attachScreenshot ?? true
  return {
    content: formatObservationText(prefix, result) + warning,
    isError: false,
    ...(attachScreenshot ? { attachments: [result.attachment] } : {}),
  }
}

/**
 * Backward-compatible wrapper used by the read-only `ComputerObserve` path.
 * Just runs `runActionAndObserve` with a no-op action, verification off (no
 * pre-state to compare against on a pure observation), and `countStep`
 * defaulted off (read-only paths must not advance the step counter).
 *
 * `sessionManager` is required by `runActionAndObserve` (review fix #3) but
 * never invoked here because `countStep` stays at the default. We thread it
 * through for type compliance — the manager is always available in the
 * factory closure of every caller.
 */
async function observeAndPack(
  session: BrowserSession,
  signal: AbortSignal,
  prefix: string,
  sessionManager: ComputerSessionManager,
): Promise<ToolResult> {
  return runActionAndObserve(session, signal, prefix, async () => {}, { verify: false }, sessionManager)
}

async function safelyAriaHash(
  session: BrowserSession,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const snap = await session.ariaSnapshot(signal)
    return snap.hash
  } catch (err) {
    if (isAbortError(err)) throw err
    return null
  }
}

async function safelyScreenshotBytes(
  session: BrowserSession,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  try {
    const shot = await session.screenshot(signal)
    return decodeAttachmentToBytes(shot.attachment.data)
  } catch (err) {
    if (isAbortError(err)) throw err
    return null
  }
}

function decodeAttachmentToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

/**
 * Phase 4·2 fix #8 — best-effort verification paths must NOT swallow
 * user aborts. Identify the abort case so callers can rethrow.
 */
function isAbortError(err: unknown): boolean {
  return err instanceof BrowserSessionError && err.kind === 'aborted'
}

// v3 Phase 5 — page-derived text (`url`, `title`, atom catalog YAML) is
// wrapped in `<untrusted-page-text>` delimiters so the model treats it as
// data, not instructions. The delimiter rule lives in
// `systemPrompt.computerUseSection`; the wrapping must stay on every
// observation surface that emits page text. The trusted-prefix and any
// post-verification WARNING text are written by us and stay outside the
// delimiter.
//
// **Escape vector** (review fix): if a page emits `</untrusted-page-text>`
// inside its title or an atom's accessible name, naive interpolation would
// close the wrapper early and let hostile text appear in trusted-prefix
// territory. `wrapUntrustedPageText` neutralizes the literal closing-tag
// substring (case-insensitive — HTML attribute names are case-insensitive
// and we want the same defensive posture for our delimiter) before
// concatenation. We replace the leading `<` with the HTML-style
// `&lt;`-equivalent for tags only — the visible mangle keeps the model's
// audit trail honest while breaking the literal match.
const UNTRUSTED_CLOSE_TAG_RE = /<\s*\/\s*untrusted-page-text\s*>/gi
const UNTRUSTED_OPEN_TAG_RE = /<\s*untrusted-page-text\s*>/gi

function escapeUntrustedText(s: string): string {
  return s
    .replace(UNTRUSTED_CLOSE_TAG_RE, '<\\/untrusted-page-text>')
    .replace(UNTRUSTED_OPEN_TAG_RE, '<\\untrusted-page-text>')
}

function wrapUntrustedPageText(content: string): string {
  return `<untrusted-page-text>\n${escapeUntrustedText(content)}\n</untrusted-page-text>`
}

function formatObservationText(prefix: string, result: ScreenshotResult): string {
  const pageLines = [`url: ${result.observation.url}`]
  if (result.observation.title !== null) {
    pageLines.push(`title: ${result.observation.title}`)
  }
  return `${prefix}\n${wrapUntrustedPageText(pageLines.join('\n'))}`
}

// ---------------------------------------------------------------------------
// ComputerStart
// ---------------------------------------------------------------------------

function buildStartTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerStart',
    description:
      'Start an isolated browser session for interactive browser operation. ' +
      'For ordinary information gathering, source discovery, factual lookup, ' +
      'and reading public pages, use WebSearch / WebFetch first — Computer-Use ' +
      'is for live-page interaction (login, forms, client-side UI, visual ' +
      'inspection) only. Returns a sessionId that subsequent Computer* tools ' +
      'must reference. Sessions are bounded by the configured maxDurationMs. ' +
      'Headless by default.',
    inputSchema: {
      type: 'object',
      properties: {
        headless: {
          type: 'boolean',
          description: 'When false, launches a visible browser window. Required by ComputerHandoffToUser.',
        },
        initialUrl: {
          type: 'string',
          description:
            'Optional HTTPS URL identifying the site you intend to use. When the host ' +
            'is on the allowlist AND persistProfiles is enabled, any previously-snapshotted ' +
            'cookies/localStorage for that host are rehydrated into the new session. Does ' +
            'NOT auto-navigate — call ComputerNavigate yourself.',
        },
      },
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,

    async validateInput(input) {
      if (input.headless !== undefined && typeof input.headless !== 'boolean') {
        return { valid: false, message: 'headless must be a boolean' }
      }
      if (input.initialUrl !== undefined) {
        if (typeof input.initialUrl !== 'string' || input.initialUrl.length === 0) {
          return { valid: false, message: 'initialUrl must be a non-empty string when provided' }
        }
        let parsed: URL
        try {
          parsed = new URL(input.initialUrl)
        } catch {
          return { valid: false, message: 'initialUrl is not a valid URL' }
        }
        if (parsed.protocol !== 'https:') {
          return {
            valid: false,
            message: `initialUrl must be HTTPS (got ${parsed.protocol.replace(':', '')})`,
          }
        }
        // Reject userinfo (https://user:pass@host) — `extractHost` returns
        // null in that case, which would silently fall through to the
        // misleading "not on allowlist" warn at call time. Rejecting here
        // gives the model a clear actionable error AND keeps credentials out
        // of audit/error surfaces.
        if (extractHost(input.initialUrl) === null) {
          return {
            valid: false,
            message: 'initialUrl must not contain userinfo (https://user:pass@host); use the bare host',
          }
        }
      }
      return { valid: true }
    },

    async call(input, context, signal) {
      try {
        // Phase 4·3 — when `initialUrl` names a policy-allowed host AND the
        // user opted into `persistProfiles`, rehydrate any previously-saved
        // storageState into the new context. Three independent gates so the
        // model can pass `initialUrl` for unrelated reasons (e.g., tagging
        // the session) without leaking credentials to a denied host.
        let storageState: unknown | undefined
        const initialUrl = typeof input.initialUrl === 'string' ? input.initialUrl : null
        if (initialUrl !== null && deps.settings.persistProfiles) {
          const schemeCheck = isUrlSchemeAllowed(initialUrl, { allowHttpForTest: false })
          const domainCheck = isDomainAllowed(
            initialUrl,
            {
              allowedDomains: deps.settings.allowedDomains,
              deniedDomains: deps.settings.deniedDomains,
            },
            { requireAllowlist: true },
          )
          if (schemeCheck.allowed && domainCheck.allowed) {
            const host = extractHost(initialUrl)
            if (host !== null) {
              const loaded = await loadStorageState(host)
              if (loaded !== null) {
                storageState = loaded
              }
            }
          } else {
            // Don't load credentials for a denied host. Warn so the user
            // notices the policy/setting mismatch — silent skip would mask
            // misconfiguration.
            process.stderr.write(
              `[ultron] warning: ComputerStart.initialUrl host is not on the allowlist; skipping storageState rehydration.\n`,
            )
          }
        }

        const session = await deps.sessionManager.start(
          {
            headless: typeof input.headless === 'boolean' ? input.headless : true,
            ...(storageState !== undefined ? { storageState } : {}),
          },
          signal,
        )
        return {
          content: `sessionId: ${session.id}`,
          isError: false,
        }
      } catch (err) {
        if (signal.aborted) {
          return errorResult('aborted', '[aborted]')
        }
        return mapBrowserSessionError(err)
      } finally {
        void context
      }
    },
  })
}

// ---------------------------------------------------------------------------
// ComputerObserve
// ---------------------------------------------------------------------------

function buildObserveTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerObserve',
    description:
      'Capture a redacted screenshot and metadata for the given Computer-Use session. ' +
      'Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id from ComputerStart' },
      },
      required: ['sessionId'],
    },
    isMutating: false,
    isReadOnly: true,
    isConcurrencySafe: () => false,

    async validateInput(input) {
      return validateSessionId(deps, input.sessionId)
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      try {
        // Route through observeAndPack so the same opportunistic ARIA capture
        // that primes the cache for action-tool SafetyChecks also runs after
        // explicit Observe calls (Phase 4·1 fix #1). Observe is the most
        // common path between ComputerStart and the model's first risky click,
        // so this is where ARIA priming pays off most.
        return await observeAndPack(lookup.session, signal, 'observe', deps.sessionManager)
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// ComputerNavigate
// ---------------------------------------------------------------------------

function buildNavigateTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerNavigate',
    description:
      'Navigate the Computer-Use session to a URL. URL must be HTTPS and pass ' +
      'the configured allowedDomains check. Returns a post-navigation observation.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string', description: 'Full URL to navigate to' },
      },
      required: ['sessionId', 'url'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    getDomain: (input) => {
      const url = typeof input.url === 'string' ? input.url : ''
      return extractHost(url) ?? undefined
    },

    async validateInput(input) {
      const sv = validateSessionId(deps, input.sessionId)
      if (!sv.valid) return sv
      if (typeof input.url !== 'string' || input.url.length === 0) {
        return { valid: false, message: 'url must be a non-empty string' }
      }
      let parsed: URL
      try {
        parsed = new URL(input.url)
      } catch {
        return { valid: false, message: 'url is not a valid URL' }
      }
      // HTTPS-only at the tool boundary (defense in depth — `BrowserSession.navigate`
      // also enforces this via `isUrlSchemeAllowed`). Reject `http:`, `file:`,
      // `data:`, `javascript:`, etc. up front so the cascade never prompts on
      // an impossible navigation.
      if (parsed.protocol !== 'https:') {
        return {
          valid: false,
          message: `url must be HTTPS (got ${parsed.protocol.replace(':', '')})`,
        }
      }
      return { valid: true }
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      try {
        return await runActionAndObserve(
          lookup.session,
          signal,
          `navigate: ${input.url as string}`,
          async () => {
            await lookup.session.navigate(input.url as string, signal)
          },
          { verify: deps.settings.verifyActions, countStep: true },
          deps.sessionManager,
        )
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// ComputerClick
// ---------------------------------------------------------------------------

function validatePoint(input: Record<string, unknown>, xKey: string, yKey: string):
  | { ok: true; point: NormalizedPoint }
  | { ok: false; message: string } {
  const result = validateNormalizedPoint({ x: input[xKey], y: input[yKey] })
  if (!result.ok) {
    return { ok: false, message: `${xKey}/${yKey}: ${result.message}` }
  }
  return { ok: true, point: result.point }
}

function buildClickTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerClick',
    description:
      'Click at a normalized [0,1] point in the Computer-Use session. button defaults to "left". ' +
      'Optionally pass double=true for a double-click. Returns a post-action observation.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        x: { type: 'number', description: 'Normalized x in [0, 1]' },
        y: { type: 'number', description: 'Normalized y in [0, 1]' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        double: { type: 'boolean' },
      },
      required: ['sessionId', 'x', 'y'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    getDomain: makeSessionGetDomain(deps),

    async validateInput(input) {
      const sv = validateSessionId(deps, input.sessionId)
      if (!sv.valid) return sv
      const pt = validatePoint(input, 'x', 'y')
      if (!pt.ok) return { valid: false, message: pt.message }
      if (
        input.button !== undefined &&
        input.button !== 'left' &&
        input.button !== 'middle' &&
        input.button !== 'right'
      ) {
        return { valid: false, message: 'button must be "left", "middle", or "right"' }
      }
      if (input.double !== undefined && typeof input.double !== 'boolean') {
        return { valid: false, message: 'double must be a boolean' }
      }
      return { valid: true }
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      const pt = validatePoint(input, 'x', 'y')
      if (!pt.ok) return errorResult('validation_failed', pt.message)
      const button: MouseButton = (input.button as MouseButton | undefined) ?? 'left'
      const isDouble = input.double === true
      const action = isDouble ? `double_click(${pt.point.x},${pt.point.y},${button})` : `click(${pt.point.x},${pt.point.y},${button})`
      try {
        return await runActionAndObserve(
          lookup.session,
          signal,
          action,
          async () => {
            if (isDouble) {
              await lookup.session.doubleClick(pt.point, button, signal)
            } else {
              await lookup.session.click(pt.point, button, signal)
            }
          },
          { verify: deps.settings.verifyActions, countStep: true },
          deps.sessionManager,
        )
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// ComputerType
// ---------------------------------------------------------------------------

function buildTypeTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerType',
    description:
      'Type text into the focused element. Text must be <= 1024 bytes and contain ' +
      'no control characters except tab/newline/carriage return. The "sensitive" flag ' +
      'is advisory in Phase 3 (enforced by Phase 4 redaction).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
        sensitive: { type: 'boolean' },
      },
      required: ['sessionId', 'text'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    getDomain: makeSessionGetDomain(deps),

    async validateInput(input) {
      const sv = validateSessionId(deps, input.sessionId)
      if (!sv.valid) return sv
      if (typeof input.text !== 'string') {
        return { valid: false, message: 'text must be a string' }
      }
      const bytes = Buffer.byteLength(input.text, 'utf8')
      if (bytes > MAX_TYPE_BYTES) {
        return {
          valid: false,
          message: `text exceeds ${MAX_TYPE_BYTES} byte cap (got ${bytes})`,
        }
      }
      if (hasDisallowedControlChars(input.text)) {
        return {
          valid: false,
          message: 'text contains disallowed control characters',
        }
      }
      if (input.sensitive !== undefined && typeof input.sensitive !== 'boolean') {
        return { valid: false, message: 'sensitive must be a boolean' }
      }
      return { valid: true }
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      const text = input.text as string
      const summary = input.sensitive === true ? `type(<redacted ${text.length} chars>)` : `type(${text.length} chars)`
      try {
        return await runActionAndObserve(
          lookup.session,
          signal,
          summary,
          async () => {
            await lookup.session.typeText(text, signal)
          },
          { verify: deps.settings.verifyActions, countStep: true },
          deps.sessionManager,
        )
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// ComputerKey
// ---------------------------------------------------------------------------

function buildKeyTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerKey',
    description:
      'Press a key or chord. Allowed: Enter, Tab, Escape, Backspace, Delete, Space, ' +
      'arrow keys, Home, End, PageUp, PageDown, plus chords like "Control+A", ' +
      '"ControlOrMeta+C", "Shift+Tab".',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['sessionId', 'key'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    getDomain: makeSessionGetDomain(deps),

    async validateInput(input) {
      const sv = validateSessionId(deps, input.sessionId)
      if (!sv.valid) return sv
      if (typeof input.key !== 'string' || input.key.length === 0) {
        return { valid: false, message: 'key must be a non-empty string' }
      }
      if (!isValidKey(input.key)) {
        return {
          valid: false,
          message: `key "${input.key}" is not in the allowed set`,
        }
      }
      return { valid: true }
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      const key = input.key as string
      try {
        return await runActionAndObserve(
          lookup.session,
          signal,
          `key(${key})`,
          async () => {
            await lookup.session.pressKey(key, signal)
          },
          { verify: deps.settings.verifyActions, countStep: true },
          deps.sessionManager,
        )
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// ComputerScroll
// ---------------------------------------------------------------------------

function buildScrollTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerScroll',
    description:
      'Scroll by deltaX/deltaY pixels. Optionally anchor the scroll at a ' +
      'normalized [0,1] point (provide both x and y, or neither for page-level scroll). ' +
      'Returns a post-action observation.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
      },
      required: ['sessionId', 'deltaX', 'deltaY'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    getDomain: makeSessionGetDomain(deps),

    async validateInput(input) {
      const sv = validateSessionId(deps, input.sessionId)
      if (!sv.valid) return sv
      if (typeof input.deltaX !== 'number' || !Number.isFinite(input.deltaX)) {
        return { valid: false, message: 'deltaX must be a finite number' }
      }
      if (typeof input.deltaY !== 'number' || !Number.isFinite(input.deltaY)) {
        return { valid: false, message: 'deltaY must be a finite number' }
      }
      const hasX = input.x !== undefined
      const hasY = input.y !== undefined
      if (hasX !== hasY) {
        return { valid: false, message: 'x and y must be provided together (or neither)' }
      }
      if (hasX) {
        const pt = validatePoint(input, 'x', 'y')
        if (!pt.ok) return { valid: false, message: pt.message }
      }
      return { valid: true }
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      let point: NormalizedPoint | null = null
      if (input.x !== undefined && input.y !== undefined) {
        const pt = validatePoint(input, 'x', 'y')
        if (!pt.ok) return errorResult('validation_failed', pt.message)
        point = pt.point
      }
      const dx = input.deltaX as number
      const dy = input.deltaY as number
      try {
        return await runActionAndObserve(
          lookup.session,
          signal,
          `scroll(dx=${dx}, dy=${dy})`,
          async () => {
            await lookup.session.scroll(point, dx, dy, signal)
          },
          { verify: deps.settings.verifyActions, countStep: true },
          deps.sessionManager,
        )
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// ComputerDrag
// ---------------------------------------------------------------------------

function buildDragTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerDrag',
    description:
      'Drag from one normalized [0,1] point to another. Returns a post-action observation.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
      },
      required: ['sessionId', 'fromX', 'fromY', 'toX', 'toY'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    getDomain: makeSessionGetDomain(deps),

    async validateInput(input) {
      const sv = validateSessionId(deps, input.sessionId)
      if (!sv.valid) return sv
      const from = validatePoint(input, 'fromX', 'fromY')
      if (!from.ok) return { valid: false, message: from.message }
      const to = validatePoint(input, 'toX', 'toY')
      if (!to.ok) return { valid: false, message: to.message }
      return { valid: true }
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      const from = validatePoint(input, 'fromX', 'fromY')
      if (!from.ok) return errorResult('validation_failed', from.message)
      const to = validatePoint(input, 'toX', 'toY')
      if (!to.ok) return errorResult('validation_failed', to.message)
      try {
        return await runActionAndObserve(
          lookup.session,
          signal,
          `drag(${from.point.x},${from.point.y} -> ${to.point.x},${to.point.y})`,
          async () => {
            await lookup.session.drag(from.point, to.point, signal)
          },
          { verify: deps.settings.verifyActions, countStep: true },
          deps.sessionManager,
        )
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// ComputerWait
// ---------------------------------------------------------------------------

function buildWaitTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerWait',
    description: 'Wait for `ms` milliseconds (max 10000). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        ms: { type: 'number', description: 'Milliseconds to wait, 1..10000' },
      },
      required: ['sessionId', 'ms'],
    },
    isMutating: false,
    isReadOnly: true,
    isConcurrencySafe: () => false,

    async validateInput(input) {
      const sv = validateSessionId(deps, input.sessionId)
      if (!sv.valid) return sv
      if (
        typeof input.ms !== 'number' ||
        !Number.isFinite(input.ms) ||
        input.ms < 1 ||
        input.ms > MAX_WAIT_MS
      ) {
        return {
          valid: false,
          message: `ms must be a number in [1, ${MAX_WAIT_MS}]`,
        }
      }
      return { valid: true }
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      const ms = input.ms as number
      try {
        await abortableSleep(ms, signal)
        return { content: `wait(${ms}ms)`, isError: false }
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new BrowserSessionError('aborted', 'wait aborted before start'))
  }
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new BrowserSessionError('aborted', 'wait aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// ComputerHandoffToUser
// ---------------------------------------------------------------------------

function buildHandoffToUserTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerHandoffToUser',
    description:
      'Pause the agent loop and surface a message to the user, who interacts with the ' +
      'visible browser (e.g., to complete a login). On user resume, returns a fresh ' +
      'observation. Requires headed mode and computerUse.allowAuthHandoff=true.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        message: { type: 'string', description: 'Message shown to the user during the handoff' },
      },
      required: ['sessionId', 'message'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    getDomain: makeSessionGetDomain(deps),

    async validateInput(input) {
      const sv = validateSessionId(deps, input.sessionId)
      if (!sv.valid) return sv
      if (typeof input.message !== 'string' || input.message.length === 0) {
        return { valid: false, message: 'message must be a non-empty string' }
      }
      return { valid: true }
    },

    async checkPermissions(input) {
      // Defense in depth: deny when handoff is disabled in settings, or when
      // the resolved session is invisible (headless), or when no session exists.
      if (deps.settings.allowAuthHandoff !== true) {
        return {
          behavior: 'deny',
          message: 'Handoff disabled (set computerUse.allowAuthHandoff=true)',
        }
      }
      if (typeof input.sessionId !== 'string') {
        return { behavior: 'deny', message: 'sessionId must be a string' }
      }
      const session = deps.sessionManager.get(input.sessionId as ComputerSessionId)
      if (!session || session.isClosed()) {
        return { behavior: 'deny', message: 'Session not found or already closed' }
      }
      if (session.headless) {
        return {
          behavior: 'deny',
          message: 'Handoff requires a headed (visible) browser session',
        }
      }
      const message = typeof input.message === 'string' ? input.message : 'Handoff'
      return { behavior: 'ask', message }
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      try {
        // The user has approved the cascade prompt — that's the resume signal.
        // Capture a fresh observation so the model sees post-handoff state.
        // observeAndPack already passes `verify: false` (resume is a no-op
        // mutation; running pre/post diff would falsely report no-change).
        const result = await observeAndPack(lookup.session, signal, 'handoff resumed', deps.sessionManager)

        // Phase 4·3 — snapshot storageState for cross-run rehydration. Two
        // independent gates:
        //   - allowAuthHandoff: the model is permitted to invoke this tool
        //     (already enforced in checkPermissions; re-check defensively).
        //   - persistProfiles: the user opted into credentials surviving
        //     across runs. Defaults to false — explicit opt-in.
        if (deps.settings.persistProfiles && deps.settings.allowAuthHandoff) {
          const currentUrl = lookup.session.currentUrl()
          const host = currentUrl !== null ? extractHost(currentUrl) : null
          if (host !== null) {
            try {
              const state = await lookup.session.exportStorageState(signal)
              await writeStorageState(host, state)
            } catch (err) {
              // Aborts MUST propagate (Batch 4·2 fix #8 rule); other I/O
              // failures warn-and-swallow so a disk hiccup doesn't poison
              // the otherwise-successful handoff result.
              if (isAbortError(err)) throw err
              const msg = err instanceof Error ? err.message : String(err)
              process.stderr.write(
                `[ultron] warning: storageState persistence failed for ${host}: ${msg}\n`,
              )
            }
          }
        }

        return result
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Phase 4b — ComputerObserveActions
// ---------------------------------------------------------------------------

function buildObserveActionsTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerObserveActions',
    description:
      'List the interactive elements on the current page as ' +
      '{atomId, role, name, hint?}. Pass an atomId to ComputerActAtom instead of ' +
      'pixel coordinates when available. Returns text only — no screenshot ' +
      'attachment, since the model only needs the atom catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id from ComputerStart' },
      },
      required: ['sessionId'],
    },
    isMutating: false,
    isReadOnly: true,
    isConcurrencySafe: () => false,

    async validateInput(input) {
      return validateSessionId(deps, input.sessionId)
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result
      try {
        const snap = await lookup.session.ariaSnapshot(signal)
        // User redactionSelectors flow into the atom catalog the same way
        // they flow into screenshot redaction (`getSensitiveRegions` is
        // implementation-shared with `playwrightBrowserSession.screenshot`).
        // Region collection is best-effort: if Playwright errors during
        // selector resolution, we proceed with no extra regions and the
        // baseline `isSensitiveNode` predicate still redacts password / MFA
        // / cc-* fields.
        let sensitiveRegions: readonly { x: number; y: number; width: number; height: number }[] = []
        try {
          sensitiveRegions = await lookup.session.getSensitiveRegions(
            deps.settings.redactionSelectors,
            signal,
          )
        } catch (err) {
          if (isAbortError(err)) throw err
          /* swallow — region collection is best-effort */
        }
        const url = lookup.session.currentUrl() ?? ''
        const cache = buildAtomCache(snap, url, { sensitiveRegions })
        lookup.session.setAtomCache(cache)
        // v3 Phase 5 — wrap the page-derived YAML in `<untrusted-page-text>`
        // delimiters via `wrapUntrustedPageText`, which also neutralizes any
        // `</untrusted-page-text>` substring inside atom names/hints
        // (otherwise an atom name carrying the closing tag would escape the
        // wrapper). Wrapping happens at the call site to keep
        // `serializeAtoms` pure for tests.
        return {
          content: wrapUntrustedPageText(serializeAtoms([...cache.entries.values()])),
          isError: false,
          // NO `attachments` — the load-bearing acceptance criterion. Model
          // gets the atom catalog as text, no image input on this turn.
        }
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Phase 4b — ComputerActAtom
// ---------------------------------------------------------------------------

function validateAtomAction(value: unknown):
  | { ok: true; action: AtomAction }
  | { ok: false; message: string } {
  if (value === null || typeof value !== 'object') {
    return { ok: false, message: 'action must be an object' }
  }
  const a = value as Record<string, unknown>
  if (a.type === 'click') {
    if (
      a.button !== undefined &&
      a.button !== 'left' &&
      a.button !== 'middle' &&
      a.button !== 'right'
    ) {
      return { ok: false, message: 'action.button must be "left", "middle", or "right"' }
    }
    if (a.double !== undefined && typeof a.double !== 'boolean') {
      return { ok: false, message: 'action.double must be a boolean' }
    }
    return {
      ok: true,
      action: {
        type: 'click',
        ...(a.button !== undefined && { button: a.button as 'left' | 'middle' | 'right' }),
        ...(a.double !== undefined && { double: a.double as boolean }),
      },
    }
  }
  if (a.type === 'fill') {
    if (typeof a.text !== 'string') {
      return { ok: false, message: 'action.text must be a string for fill' }
    }
    const bytes = Buffer.byteLength(a.text, 'utf8')
    if (bytes > MAX_TYPE_BYTES) {
      return { ok: false, message: `action.text exceeds ${MAX_TYPE_BYTES} byte cap (got ${bytes})` }
    }
    if (hasDisallowedControlChars(a.text)) {
      return { ok: false, message: 'action.text contains disallowed control characters' }
    }
    if (a.sensitive !== undefined && typeof a.sensitive !== 'boolean') {
      return { ok: false, message: 'action.sensitive must be a boolean' }
    }
    return {
      ok: true,
      action: {
        type: 'fill',
        text: a.text,
        ...(a.sensitive !== undefined && { sensitive: a.sensitive as boolean }),
      },
    }
  }
  if (a.type === 'select') {
    if (typeof a.value !== 'string') {
      return { ok: false, message: 'action.value must be a string for select' }
    }
    return { ok: true, action: { type: 'select', value: a.value } }
  }
  return { ok: false, message: 'action.type must be "click", "fill", or "select"' }
}

// v3 Phase 5 — the summary becomes the trusted prefix on the ActAtom result
// text (lives OUTSIDE the `<untrusted-page-text>` delimiter that
// `formatObservationText` wraps url/title in). Embedding `entry.displayName`
// — which is page-derived, even though redacted for sensitive nodes — would
// expose an injection vector for atoms whose accessible name carries
// adversarial text. The model already saw the displayName one turn earlier
// inside the wrapped atom catalog (`ComputerObserveActions`), so the summary
// only needs `atomId` + `role` for the audit/watch-mode trail.
function formatAtomSummary(
  atomId: string,
  entry: { role: string },
  action: AtomAction,
): string {
  const target = `${atomId}: ${entry.role}`
  switch (action.type) {
    case 'click':
      return action.double === true
        ? `actAtom(${target} → double_click ${action.button ?? 'left'})`
        : `actAtom(${target} → click ${action.button ?? 'left'})`
    case 'fill':
      return action.sensitive === true
        ? `actAtom(${target} → fill <redacted ${action.text.length} chars>)`
        : `actAtom(${target} → fill ${action.text.length} chars)`
    case 'select':
      return `actAtom(${target} → select "${action.value}")`
  }
}

function buildActAtomTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerActAtom',
    description:
      'Perform a click/fill/select on the element identified by atomId. Call ' +
      'ComputerObserveActions first to discover atomIds. On atom_resolution_failed, ' +
      're-observe or fall back to ComputerClick / ComputerType. Returns post-action ' +
      'observation as text only (no screenshot attachment).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        atomId: { type: 'string' },
        action: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['click', 'fill', 'select'] },
            button: { type: 'string', enum: ['left', 'middle', 'right'] },
            double: { type: 'boolean' },
            text: { type: 'string' },
            sensitive: { type: 'boolean' },
            value: { type: 'string' },
          },
          required: ['type'],
        },
      },
      required: ['sessionId', 'atomId', 'action'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    getDomain: makeSessionGetDomain(deps),

    async validateInput(input) {
      const sv = validateSessionId(deps, input.sessionId)
      if (!sv.valid) return sv
      if (typeof input.atomId !== 'string' || input.atomId.length === 0) {
        return { valid: false, message: 'atomId must be a non-empty string' }
      }
      const av = validateAtomAction(input.action)
      if (!av.ok) return { valid: false, message: av.message }
      return { valid: true }
    },

    async call(input, _context, signal) {
      const lookup = resolveSession(deps, input.sessionId)
      if (!lookup.ok) return lookup.result

      // Validate inputs first — defense in depth so direct `call` invocations
      // (e.g., SDK callers that bypass the harness's `validateInput` pass)
      // still surface validation_failed before reaching atom resolution.
      // Mirrors the ComputerClick pattern (re-validate point in call body).
      if (typeof input.atomId !== 'string' || input.atomId.length === 0) {
        return errorResult('validation_failed', 'atomId must be a non-empty string')
      }
      const av = validateAtomAction(input.action)
      if (!av.ok) return errorResult('validation_failed', av.message)
      const atomId = input.atomId
      const action = av.action

      const entry = lookup.session.lookupAtom(atomId)
      if (entry === null) {
        return errorResult(
          'atom_resolution_failed',
          `atom '${atomId}' is not resolvable in this session. ` +
            'Call ComputerObserveActions to refresh the catalog, or fall back to ComputerClick / ComputerType.',
        )
      }

      const locator = buildLocator(entry)
      const summary = formatAtomSummary(atomId, entry, action)

      try {
        return await runActionAndObserve(
          lookup.session,
          signal,
          summary,
          async () => {
            await lookup.session.actOnAtom(locator, action, signal)
          },
          { verify: deps.settings.verifyActions, attachScreenshot: false, countStep: true },
          deps.sessionManager,
        )
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// ComputerStop
// ---------------------------------------------------------------------------

function buildStopTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerStop',
    description: 'Close a Computer-Use session and release its browser resources.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
      },
      required: ['sessionId'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,

    async validateInput(input) {
      // Validate that the sessionId resolves to a live session — refuses
      // unknown ids so `ComputerStop({sessionId: "bogus"})` returns
      // `validation_failed` instead of a misleading "stopped: bogus".
      return validateSessionId(deps, input.sessionId)
    },

    async call(input, _context, signal) {
      if (signal.aborted) {
        return errorResult('aborted', '[aborted]')
      }
      const sessionId = input.sessionId as string
      try {
        await deps.sessionManager.stop(sessionId as ComputerSessionId)
        return { content: `stopped: ${sessionId}`, isError: false }
      } catch (err) {
        return mapBrowserSessionError(err)
      }
    },
  })
}
