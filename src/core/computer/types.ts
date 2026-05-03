/**
 * v3 Phase 2: Computer-Use runtime types.
 *
 * Defines the abstract `BrowserSession` contract that decouples the runtime
 * from Playwright. Phase 2 ships one concrete implementation
 * (`playwrightBrowserSession.ts`); Profiles B (managed stealth) and C
 * (container desktop) plug in later under the same interface.
 *
 * See `docs/ultron_v3/v3-phase2-design.md`.
 */

import type { ToolResultAttachment } from '../tools/imageAttachment.js'
import type { AriaTreeSnapshot, BoundingBox } from './ariaSnapshot.js'
import type { AtomEntry, AtomAction, AtomLocator } from './atomResolver.js'
import type { SessionAtomCache } from './selectorCache.js'

export type { BoundingBox }

export type ComputerSessionId = string & { readonly __brand: 'ComputerSessionId' }

export type ComputerEnvironmentKind = 'browser' | 'desktop'

export type ComputerViewport = {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
}

export type ComputerDisplaySize = {
  readonly width: number
  readonly height: number
}

export type NormalizedPoint = {
  readonly x: number
  readonly y: number
}

export type ScreenshotResult = {
  readonly attachment: ToolResultAttachment
  readonly observation: { readonly url: string; readonly title: string | null }
}

export type StartSessionOptions = {
  readonly headless?: boolean
  // TEST-ONLY: skip the "non-empty allowedDomains required" check.
  // Production callers never set this.
  readonly requireAllowlist?: boolean
  // TEST-ONLY: permit `http:` URLs (default: HTTPS-only).
  // Production callers never set this.
  readonly allowHttpForTest?: boolean
  // TEST-ONLY: forwarded to chromium as --host-resolver-rules so the integration
  // test can MAP fixture.local:80 -> 127.0.0.1:<fixturePort>.
  readonly hostResolverRules?: string
  // Phase 4·3 — pre-validated Playwright `storageState` to seed the new
  // browser context with cookies/localStorage. The validation pass lives
  // in `storageStateStore.loadStorageState`; we accept the validated object
  // (not a path) so there's exactly one validation seam.
  readonly storageState?: unknown
  // v3 Phase 6 — per-session DSF override. Defaults to 1 (production path);
  // the model-facing `ComputerStart` schema does not expose this. Tests and
  // explicit SDK callers may set it (e.g. to 2) to exercise the bridge
  // translation contract under DSF≠1. Threaded through to Playwright's
  // `context.newContext({ deviceScaleFactor })` AND mirrored on
  // `BrowserSession.viewport.deviceScaleFactor`.
  readonly deviceScaleFactor?: number
}

export type BrowserSessionErrorKind =
  | 'domain_denied'
  | 'scheme_denied'
  | 'allowlist_empty'
  | 'viewport_mismatch'
  | 'chromium_not_installed'
  | 'navigation_failed'
  | 'screenshot_oversized'
  | 'screenshot_failed'
  | 'session_closed'
  | 'aborted'
  | 'timeout'
  | 'interaction_failed'
  | 'atom_locator_failed'

export class BrowserSessionError extends Error {
  readonly kind: BrowserSessionErrorKind
  readonly host?: string

  constructor(kind: BrowserSessionErrorKind, message: string, host?: string) {
    super(message)
    this.name = 'BrowserSessionError'
    this.kind = kind
    if (host !== undefined) this.host = host
  }
}

export type MouseButton = 'left' | 'middle' | 'right'

export interface BrowserSession {
  readonly id: ComputerSessionId
  readonly viewport: ComputerViewport
  readonly displaySize: ComputerDisplaySize
  /**
   * True iff the underlying browser was launched headless. Phase 3:
   * `ComputerHandoffToUser.checkPermissions` reads this to refuse handoff
   * for invisible browser sessions. The engine's `permissionOpts.headless`
   * is the CLI being non-interactive — orthogonal to this field.
   */
  readonly headless: boolean
  navigate(url: string, signal: AbortSignal): Promise<void>
  screenshot(signal: AbortSignal): Promise<ScreenshotResult>
  stabilize(signal: AbortSignal): Promise<void>
  currentUrl(): string | null
  currentTitle(): Promise<string | null>
  isClosed(): boolean
  close(): Promise<void>

  // Phase 3 action primitives. Coordinate inputs are pre-validated
  // NormalizedPoints; the implementation converts to CSS px against
  // `viewport`. Each method routes through the same abort-tracking helper
  // and surfaces `BrowserSessionError(kind: 'aborted')` on signal abort,
  // `BrowserSessionError(kind: 'interaction_failed')` on Playwright errors.
  click(point: NormalizedPoint, button: MouseButton, signal: AbortSignal): Promise<void>
  doubleClick(point: NormalizedPoint, button: MouseButton, signal: AbortSignal): Promise<void>
  typeText(text: string, signal: AbortSignal): Promise<void>
  pressKey(key: string, signal: AbortSignal): Promise<void>
  scroll(point: NormalizedPoint | null, deltaX: number, deltaY: number, signal: AbortSignal): Promise<void>
  drag(from: NormalizedPoint, to: NormalizedPoint, signal: AbortSignal): Promise<void>

  // Phase 4·1 — structured ARIA snapshot.
  //
  // `ariaSnapshot` walks the page DOM and returns an `AriaTreeSnapshot`
  // (tree + YAML serialization + content hash). The implementation must
  // populate the cache so `lastAriaSnapshot()` returns the same snapshot
  // until the next successful capture.
  //
  // `lastAriaSnapshot` is the SYNCHRONOUS accessor the safety check uses
  // — `permissions.ts:112-117` calls each `SafetyCheck` synchronously, so
  // a Promise return would defeat the cascade contract. Returns `null`
  // when no snapshot has been captured yet OR when the last attempt failed.
  ariaSnapshot(signal: AbortSignal): Promise<AriaTreeSnapshot>
  lastAriaSnapshot(): AriaTreeSnapshot | null

  // Phase 4·2 — sensitive-region detection.
  //
  // Returns CSS-pixel bounding boxes for elements matching the union of
  // `redaction.SENSITIVE_SELECTORS` and the caller-supplied `extraSelectors`
  // (typically `computerUseSettings.redactionSelectors`). Used by
  // `screenshot()` internally to apply blackouts before encoding the PNG.
  //
  // Implementations should return an empty array (never throw) when no
  // matching elements are found; selector-syntax errors should also be
  // swallowed so the screenshot path never fails on a malformed user
  // selector. Off-screen / hidden elements should be skipped.
  getSensitiveRegions(
    extraSelectors: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly BoundingBox[]>

  // Phase 4·3 — snapshot the browser context's cookies/localStorage so the
  // next `ComputerStart` for the same host can rehydrate the session
  // without re-prompting via `ComputerHandoffToUser`. Returns Playwright's
  // raw `storageState` shape (`{cookies, origins}`); the caller persists
  // it via `storageStateStore.writeStorageState`. Aborted signal →
  // `BrowserSessionError(kind: 'aborted')` consistent with sibling methods.
  exportStorageState(signal: AbortSignal): Promise<unknown>

  // Phase 4b — DOM-first action path.
  //
  // `actOnAtom` resolves a Playwright locator from the cached `AtomLocator`
  // (role + locatorName + nth), runs two preflight checks, then performs the
  // requested action:
  //   1. `getByRole(...).nth(nth).count() === 0` → `BrowserSessionError(kind:
  //      'atom_locator_failed', message: 'locator resolved zero elements')`.
  //      The page mutated and the cached element is gone.
  //   2. When `expectedBbox !== null`, post-resolution `boundingBox()` must
  //      match within `BBOX_TOLERANCE_PX` (`atomResolver.ts`). Otherwise
  //      `'atom_locator_failed', 'locator bbox drift exceeds tolerance'` —
  //      catches the silent-retarget case where a duplicate-name shuffle
  //      moved `nth` to a different element.
  // Both error messages stay generic — `mapBrowserSessionError` composes the
  // model-visible recovery message so `locatorName` never leaks.
  //
  // `setAtomCache` / `lookupAtom` / `currentAtomCache` are the storage
  // surface for `ComputerObserveActions` (write) and the safety check (sync
  // read). Cache is cleared in `close()` and `navigate()` — atomIds are only
  // valid for the snapshot they were assigned in.
  actOnAtom(locator: AtomLocator, action: AtomAction, signal: AbortSignal): Promise<void>
  setAtomCache(cache: SessionAtomCache): void
  lookupAtom(atomId: string): AtomEntry | null
  currentAtomCache(): SessionAtomCache | null
}

/**
 * v3 Phase 5 — signals captured after a mutating action, fed into
 * `recordStep` for step-limit + no-progress detection.
 *
 * `ariaHash` and `phash` come from the post-action observation already
 * computed inside `runActionAndObserve` — capturing them is free.
 * `verified` is the `VerifyResult.verified` boolean from `verify.ts`,
 * available only when the action ran with `verifyActions: true`.
 */
export type StepSignals = {
  /** SHA-256 hex prefix of the post-action ARIA YAML; null if capture failed. */
  readonly ariaHash: string | null
  /** Hex string of `aHash8x8(post-action PNG)`; null if capture failed. */
  readonly phash: string | null
  /** `verify.ts` verdict for this action; null when verification is disabled. */
  readonly verified: boolean | null
}

/**
 * v3 Phase 5 — `recordStep` decision. `reason` is model-visible (it lands in
 * the tool's `errorResult` content).
 */
export type StepDecision =
  | { readonly abort: false }
  | { readonly abort: true; readonly reason: string }

/**
 * v3 Phase 6 — per-session metrics surface. Returned from
 * `ComputerSessionManager.getSessionMetrics(id)`. Live sessions expose
 * `closedAt: null` / `durationMs: null` / `closeReason: null`; closed sessions
 * have all three populated. Counters mirror the SessionEntry's mutable state
 * for live sessions, and the frozen snapshot taken inside `closeOnce` for
 * closed ones.
 */
export type SessionMetrics = {
  readonly stepCount: number
  readonly screenshotCount: number
  readonly screenshotBytesTotal: number
  /** epoch ms when SessionManager.start() returned. */
  readonly startedAt: number
  /** epoch ms when closeOnce ran; null while still open. */
  readonly closedAt: number | null
  /** closedAt - startedAt; null while still open. */
  readonly durationMs: number | null
  readonly closeReason: 'aborted' | 'timeout' | 'error' | 'stop' | null
}

/**
 * Public-shape contract for `SessionManager`. The class implements it; test
 * fakes implement it directly (without inheriting the class's private brand,
 * so structural fakes type-cleanly satisfy the QueryEngineConfig seam).
 */
export interface ComputerSessionManager {
  start(opts: StartSessionOptions, signal: AbortSignal): Promise<BrowserSession>
  get(id: ComputerSessionId): BrowserSession | undefined
  stop(id: ComputerSessionId): Promise<void>
  stopAll(): Promise<void>
  requestClose(id: ComputerSessionId, reason: 'aborted' | 'timeout' | 'error'): Promise<void>
  /**
   * v3 Phase 5 — record a mutating-action step. Increments per-session step
   * counter, pushes signals onto the no-progress rings, returns `{abort: true}`
   * when (a) `stepCount > settings.maxSteps`, or (b) the no-progress rule
   * fires. The rule has two modes:
   *   - When `verifyActions === true`: abort on three consecutive
   *     `verified: false` results (verify already encodes "no available
   *     signal moved" — primary path).
   *   - When `verifyActions === false`: abort when every fully-available
   *     signal (ARIA hash and/or screenshot pHash) is stalled and at least
   *     one is available. Matches the v3 acceptance "repeated identical
   *     screenshots OR repeated identical ARIA snapshots" while preserving
   *     the canvas / DOM-only false-positive guard (a single moving signal
   *     resets its ring).
   * On abort, schedules `requestClose(id, 'error')` via `setImmediate` so
   * the tool's response ships first.
   *
   * Synchronous — only mutates the entry. No-op for unknown / closed sessions.
   * Read-only tools (`ComputerObserve`, `ComputerWait`, handoff-resume
   * observation, `ComputerObserveActions`) MUST NOT call this; the counter
   * measures mutating page interactions.
   */
  recordStep(id: ComputerSessionId, signals: StepSignals): StepDecision
  /**
   * v3 Phase 6 — read-only metrics inspector. Returns live counters for an
   * open session, a frozen snapshot for a closed one, or `null` for genuinely
   * unknown ids. Used by tests + future SDK callers; not surfaced to the model.
   */
  getSessionMetrics(id: ComputerSessionId): SessionMetrics | null
  /**
   * v3 Phase 6 — fire-and-forget screenshot accounting. Called by the runtime
   * (`PlaywrightBrowserSession.screenshot()`) via a pre-bound callback after
   * each successful capture. No-op for unknown / closed sessions; closed
   * sessions cannot take more screenshots, and if they somehow did the metrics
   * snapshot is already frozen.
   *
   * Test fakes that supply a custom `BrowserSession` but want to assert on
   * screenshot metrics must call this themselves; the manager has no way to
   * intercept screenshot bytes from a third-party session.
   */
  recordScreenshot(id: ComputerSessionId, bytes: number): void
}
