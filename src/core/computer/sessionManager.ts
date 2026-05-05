/**
 * v3 Phase 2: Computer-Use session lifecycle.
 *
 * Owns:
 * - id minting (branded ComputerSessionId).
 * - session registry (start / get / stop / stopAll).
 * - timeout enforcement via setTimeout(maxDurationMs).
 * - abort propagation via AbortSignal subscription.
 * - cleanup-once invariant: every close path (explicit stop, timeout, abort,
 *   stopAll, error) routes through `closeOnce(id)` so context.close() AND
 *   browser.close() each run exactly once.
 *
 * The implementation is Playwright-agnostic — it talks to the runtime through
 * `BrowserSessionFactory`, which the unit tests can swap for a fake.
 *
 * See `docs/ultron_v3/v3-phase2-design.md`.
 */

import { randomUUID } from 'node:crypto'

import {
  derivePersistencePatterns,
  type ComputerUseSettings,
} from '../../config/computerUseSettings.js'
import { writeSettingsConfig } from '../../config/settingsConfig.js'

import {
  BrowserSessionError,
  type BrowserSession,
  type ComputerSessionId,
  type ComputerSessionManager,
  type SessionMetrics,
  type StartSessionOptions,
  type StepDecision,
  type StepSignals,
} from './types.js'

type CloseReason = 'aborted' | 'timeout' | 'error' | 'stop'

/**
 * v3 Phase 5 — ring length for the no-progress detector. Hardcoded for v3;
 * Phase 6 evals decide whether to lift it into `ComputerUseSettings`.
 */
export const NO_PROGRESS_WINDOW = 3

function pushRing<T>(ring: T[], value: T, cap: number): void {
  ring.push(value)
  while (ring.length > cap) ring.shift()
}

/**
 * True iff the ring has reached `cap` entries AND every entry is non-null.
 * "Non-null" means the underlying capture (ARIA or pHash) succeeded; a
 * `null` entry is a missing-signal hole, not a stall.
 */
function ringFullyNonNull<T>(ring: (T | null)[], cap: number): boolean {
  if (ring.length !== cap) return false
  for (const v of ring) {
    if (v === null) return false
  }
  return true
}

/** True iff every entry in the ring equals the first entry. Empty rings → false. */
function ringAllEqual<T>(ring: T[]): boolean {
  if (ring.length === 0) return false
  const first = ring[0]
  for (let i = 1; i < ring.length; i++) {
    if (ring[i] !== first) return false
  }
  return true
}

/**
 * Factory injected into SessionManager so unit tests can run without Playwright.
 *
 * `id`, `viewport`, and `displaySize` are owned by the manager and passed in;
 * the factory only constructs the runtime-specific implementation (Playwright
 * browser+context+page).
 *
 * v3 Phase 6 — `recordScreenshot` is a pre-bound (id-closed) callback the
 * concrete session calls after each successful screenshot capture. The manager
 * uses it to accumulate per-session byte/count metrics; fire-and-forget,
 * never throws.
 */
export type BrowserSessionFactory = (params: {
  readonly id: ComputerSessionId
  readonly settings: ComputerUseSettings
  readonly options: StartSessionOptions
  readonly requestClose: (reason: 'aborted' | 'timeout' | 'error') => Promise<void>
  readonly recordScreenshot: (bytes: number) => void
  /**
   * Domain-prompt UX — closure that returns the live per-session allow
   * overlay (populated by `allow_once` approvals). The BrowserSession reads
   * it on every domain check; the closure semantics let the BrowserSession
   * see overlay changes without needing a back-pointer to the SessionManager.
   * Optional in the type so direct-construct test paths can omit it; the
   * SessionManager always supplies it. When omitted the BrowserSession
   * falls back to an always-empty overlay.
   */
  readonly getSessionAllowedHosts?: () => ReadonlySet<string>
}) => Promise<BrowserSession>

/**
 * v3 Phase 5 — per-session step counter + no-progress signal rings.
 * Mutated in place by `recordStep`. Bag is part of the entry to keep state
 * lifecycle tied to the session (clears with `closeOnce`).
 */
type StepHistory = {
  stepCount: number
  recentAriaHashes: (string | null)[]
  recentPhashes: (string | null)[]
  recentVerifyOk: (boolean | null)[]
}

type SessionEntry = {
  readonly id: ComputerSessionId
  readonly session: BrowserSession
  readonly timeoutTimer: NodeJS.Timeout | null
  readonly abortListener: (() => void) | null
  readonly abortSignal: AbortSignal | null
  closed: boolean
  readonly history: StepHistory
  // v3 Phase 6 — screenshot accounting + lifetime markers. `startedAt` is
  // frozen at session-create time; counters are mutated by `recordScreenshot`.
  readonly startedAt: number
  screenshotCount: number
  screenshotBytesTotal: number
}

export class SessionManager implements ComputerSessionManager {
  // Domain-prompt UX — `_settings` is mutable so `persistAllowedDomain` can
  // swap in an extended `allowedDomains`. The reference is replaced
  // atomically; live sessions are notified via `BrowserSession.refreshSettings`.
  private _settings: ComputerUseSettings
  private readonly _factory: BrowserSessionFactory
  private readonly _sessions = new Map<ComputerSessionId, SessionEntry>()
  // v3 Phase 6 — frozen post-close metrics, snapshotted by `closeOnce` BEFORE
  // the entry is deleted from `_sessions`. Lookup falls through to this map
  // so callers (tests, audit) can read metrics for closed sessions.
  private readonly _metrics = new Map<ComputerSessionId, SessionMetrics>()
  // Domain-prompt UX — per-session allow overlay populated by `allow_once`
  // approvals. Cleared in `closeOnce`; merged with `_settings.allowedDomains`
  // at the navigate / route-interceptor layer.
  private readonly _sessionAllowedHosts = new Map<ComputerSessionId, Set<string>>()

  constructor(deps: {
    readonly settings: ComputerUseSettings
    readonly factory: BrowserSessionFactory
  }) {
    this._settings = deps.settings
    this._factory = deps.factory
  }

  /**
   * Create a new browser session.
   *
   * Phase 2 invariants enforced here:
   * - viewport.width === displaySize.width && viewport.height === displaySize.height,
   *   else `viewport_mismatch`. Phase 4 may relax this when a real downscaler ships.
   * - If `requireAllowlist` (default true) AND `allowedDomains` is empty,
   *   reject with `allowlist_empty`.
   *
   * Schedules:
   * - Timeout after `settings.maxDurationMs` -> closeOnce.
   * - Abort listener on `signal` -> closeOnce.
   */
  async start(opts: StartSessionOptions, signal: AbortSignal): Promise<BrowserSession> {
    const settings = this._settings
    if (
      settings.viewport.width !== settings.displaySize.width ||
      settings.viewport.height !== settings.displaySize.height
    ) {
      throw new BrowserSessionError(
        'viewport_mismatch',
        `Phase 2 requires viewport === displaySize; got viewport ${settings.viewport.width}x${settings.viewport.height}, displaySize ${settings.displaySize.width}x${settings.displaySize.height}`,
      )
    }
    const requireAllowlist = opts.requireAllowlist ?? true
    // Domain-prompt UX — empty allowlist at start is now permitted by default
    // (the per-navigate prompt handles the gate). SDK callers that want the
    // old fail-fast behavior set `computerUse.requireAllowlistAtStart: true`.
    if (
      settings.requireAllowlistAtStart &&
      requireAllowlist &&
      settings.allowedDomains.length === 0
    ) {
      throw new BrowserSessionError(
        'allowlist_empty',
        'allowedDomains must be non-empty when computerUse.requireAllowlistAtStart is true; configure computerUse.allowedDomains',
      )
    }
    if (signal.aborted) {
      throw new BrowserSessionError('aborted', 'start aborted before session creation')
    }

    const id = randomUUID() as ComputerSessionId

    // Construct the entry first (with placeholders) so requestClose can find it
    // even if the factory's onCreate hooks fire callbacks during construction.
    // `startedAt` is backfilled after the factory succeeds so it reflects
    // session-usable time, not launch-attempt time — a slow Chromium boot
    // would otherwise inflate `durationMs` and decouple it from the timeout
    // timer (which also starts after factory completion).
    const entry: SessionEntry = {
      id,
      session: null as unknown as BrowserSession, // backfilled below
      timeoutTimer: null,
      abortListener: null,
      abortSignal: signal,
      closed: false,
      history: {
        stepCount: 0,
        recentAriaHashes: [],
        recentPhashes: [],
        recentVerifyOk: [],
      },
      startedAt: 0, // backfilled below, after factory returns
      screenshotCount: 0,
      screenshotBytesTotal: 0,
    }

    // Build the runtime session.
    let session: BrowserSession
    try {
      session = await this._factory({
        id,
        settings,
        options: opts,
        requestClose: (reason) => this.requestClose(id, reason),
        recordScreenshot: (bytes) => this.recordScreenshot(id, bytes),
        getSessionAllowedHosts: () => this.getSessionAllowedHosts(id),
      })
    } catch (err) {
      // Nothing to register; propagate.
      throw err
    }
    ;(entry as { session: BrowserSession }).session = session
    ;(entry as { startedAt: number }).startedAt = Date.now()

    // Wire abort listener.
    const abortListener = (): void => {
      void this.requestClose(id, 'aborted')
    }
    signal.addEventListener('abort', abortListener, { once: true })
    ;(entry as { abortListener: () => void }).abortListener = abortListener

    // Wire timeout.
    const timeoutTimer = setTimeout(() => {
      void this.requestClose(id, 'timeout')
    }, settings.maxDurationMs)
    // setTimeout returns Timeout in node; .unref() lets the process exit cleanly.
    if (typeof (timeoutTimer as { unref?: () => void }).unref === 'function') {
      ;(timeoutTimer as { unref: () => void }).unref()
    }
    ;(entry as { timeoutTimer: NodeJS.Timeout }).timeoutTimer = timeoutTimer

    this._sessions.set(id, entry)

    // Edge: signal aborted between the `if (signal.aborted)` check above and
    // listener registration. Handle by checking again and triggering close.
    if (signal.aborted) {
      void this.requestClose(id, 'aborted')
      throw new BrowserSessionError('aborted', 'start aborted during session creation')
    }

    return session
  }

  get(id: ComputerSessionId): BrowserSession | undefined {
    const entry = this._sessions.get(id)
    if (!entry || entry.closed) return undefined
    return entry.session
  }

  /** Explicit user-initiated close. Idempotent. */
  async stop(id: ComputerSessionId): Promise<void> {
    await this.closeOnce(id, 'stop')
  }

  /**
   * Internal route used by BrowserSession instances when they need to close
   * due to abort/timeout/error. Guarantees one close path through `closeOnce`.
   */
  async requestClose(id: ComputerSessionId, reason: 'aborted' | 'timeout' | 'error'): Promise<void> {
    await this.closeOnce(id, reason)
  }

  /** Close every live session. Used during QueryEngine teardown. */
  async stopAll(): Promise<void> {
    const ids = [...this._sessions.keys()]
    await Promise.all(ids.map((id) => this.closeOnce(id, 'stop')))
  }

  /**
   * v3 Phase 5 — record a mutating-action step. See the `ComputerSessionManager`
   * interface JSDoc for the full contract.
   *
   * Behavior:
   * 1. No-op (`{abort: false}`) for unknown / closed sessions.
   * 2. Increment `stepCount`. If `> settings.maxSteps`, return abort with a
   *    `step_limit_exceeded` reason and schedule `requestClose(id, 'error')`
   *    via `setImmediate` so the tool's response ships first.
   * 3. Push signals onto the no-progress rings (capped at `NO_PROGRESS_WINDOW`).
   * 4. Evaluate no-progress with the false-positive guard:
   *    - **Primary** (`verifyActions === true`): abort iff `recentVerifyOk`
   *      length === 3 AND every entry is strictly `false`. `verified === false`
   *      already means "no available signal detected change", so this single
   *      check covers both the canvas case (pHash moved → `verified: true` →
   *      ring resets) and the DOM-only case (ARIA changed → `verified: true`
   *      → ring resets).
   *    - **Fallback** (`verifyActions === false`): abort iff at least one
   *      signal has a fully non-null ring AND every fully non-null ring is
   *      stalled (all entries equal). This matches the v3 plan acceptance
   *      ("repeated identical screenshots OR repeated identical ARIA
   *      snapshots") — a stall on the only available signal aborts; a stall
   *      on one signal while the other shows progress does not (canvas /
   *      DOM-only false-positive guard); both signals unavailable means no
   *      evidence and no abort.
   */
  recordStep(id: ComputerSessionId, signals: StepSignals): StepDecision {
    const entry = this._sessions.get(id)
    if (!entry || entry.closed) return { abort: false }

    const h = entry.history
    h.stepCount += 1

    if (h.stepCount > this._settings.maxSteps) {
      this._scheduleClose(id)
      return {
        abort: true,
        reason: `step_limit_exceeded (N=${h.stepCount}, max=${this._settings.maxSteps})`,
      }
    }

    pushRing(h.recentAriaHashes, signals.ariaHash, NO_PROGRESS_WINDOW)
    pushRing(h.recentPhashes, signals.phash, NO_PROGRESS_WINDOW)
    pushRing(h.recentVerifyOk, signals.verified, NO_PROGRESS_WINDOW)

    if (this._settings.verifyActions) {
      // Primary rule — verify-driven.
      if (
        h.recentVerifyOk.length === NO_PROGRESS_WINDOW &&
        h.recentVerifyOk.every((v) => v === false)
      ) {
        this._scheduleClose(id)
        return {
          abort: true,
          reason: `no_progress: ${NO_PROGRESS_WINDOW} consecutive verified:false steps`,
        }
      }
    } else {
      // Fallback rule (review fix #2) — abort iff every AVAILABLE signal is
      // stalled AND at least one signal is available. The previous version
      // required BOTH signals stalled simultaneously, which silently let
      // through "3 identical pHashes with ARIA capture failed for all 3"
      // (a real spinning case the v3 plan calls out: "duplicate screenshot
      // pHash" alone counts as no-progress) and the symmetric ARIA case.
      //
      // The canvas / DOM-only false-positive guard is preserved: when both
      // signals are AVAILABLE and one shows progress, that signal's ring is
      // not "stalled" (it has varying entries), so `stalledCount` will not
      // equal `availableCount` and we don't abort.
      const ariaAvail = ringFullyNonNull(h.recentAriaHashes, NO_PROGRESS_WINDOW)
      const phashAvail = ringFullyNonNull(h.recentPhashes, NO_PROGRESS_WINDOW)
      const ariaStalled = ariaAvail && ringAllEqual(h.recentAriaHashes)
      const phashStalled = phashAvail && ringAllEqual(h.recentPhashes)
      const availableCount = (ariaAvail ? 1 : 0) + (phashAvail ? 1 : 0)
      const stalledCount = (ariaStalled ? 1 : 0) + (phashStalled ? 1 : 0)
      if (availableCount > 0 && stalledCount === availableCount) {
        const which: string[] = []
        if (ariaStalled) which.push('ARIA')
        if (phashStalled) which.push('pHash')
        this._scheduleClose(id)
        return {
          abort: true,
          reason: `no_progress: ${which.join(' and ')} unchanged for ${NO_PROGRESS_WINDOW} consecutive steps`,
        }
      }
    }

    return { abort: false }
  }

  /**
   * Fire-and-forget close scheduled to run after the current microtask so the
   * tool's `errorResult` returns to the model before the session tears down.
   * Mirrors the abort-listener pattern at line 131-133.
   */
  private _scheduleClose(id: ComputerSessionId): void {
    setImmediate(() => {
      void this.requestClose(id, 'error')
    })
  }

  /**
   * v3 Phase 6 — read-only metrics inspector. Returns live counters for an
   * open session, the frozen post-close snapshot for a closed one, or `null`
   * for genuinely unknown ids.
   */
  getSessionMetrics(id: ComputerSessionId): SessionMetrics | null {
    const live = this._sessions.get(id)
    if (live !== undefined && !live.closed) {
      return {
        stepCount: live.history.stepCount,
        screenshotCount: live.screenshotCount,
        screenshotBytesTotal: live.screenshotBytesTotal,
        startedAt: live.startedAt,
        closedAt: null,
        durationMs: null,
        closeReason: null,
      }
    }
    return this._metrics.get(id) ?? null
  }

  /**
   * v3 Phase 6 — fire-and-forget screenshot accounting. Called by
   * `PlaywrightBrowserSession.screenshot()` via the pre-bound callback in
   * the factory params. No-op for unknown / closed sessions.
   */
  recordScreenshot(id: ComputerSessionId, bytes: number): void {
    const entry = this._sessions.get(id)
    if (!entry || entry.closed) return
    entry.screenshotCount += 1
    entry.screenshotBytesTotal += bytes
  }

  /**
   * Single cleanup path. Ensures `BrowserSession.close()` runs at most once per
   * session even under concurrent stop / timeout / abort / stopAll.
   *
   * v3 Phase 6 — snapshots a frozen `SessionMetrics` into `_metrics` BEFORE
   * deleting from `_sessions`, so post-close callers can still read counters.
   */
  private async closeOnce(id: ComputerSessionId, reason: CloseReason): Promise<void> {
    const entry = this._sessions.get(id)
    if (!entry) return
    if (entry.closed) return
    entry.closed = true
    if (entry.timeoutTimer !== null) clearTimeout(entry.timeoutTimer)
    if (entry.abortListener !== null && entry.abortSignal !== null) {
      entry.abortSignal.removeEventListener('abort', entry.abortListener)
    }
    const closedAt = Date.now()
    this._metrics.set(id, {
      stepCount: entry.history.stepCount,
      screenshotCount: entry.screenshotCount,
      screenshotBytesTotal: entry.screenshotBytesTotal,
      startedAt: entry.startedAt,
      closedAt,
      durationMs: closedAt - entry.startedAt,
      closeReason: reason,
    })
    try {
      await entry.session.close()
    } finally {
      this._sessions.delete(id)
      // Domain-prompt UX — overlay lifetime is tied to the session; drop it
      // here so a fresh session never inherits a prior session's approvals.
      this._sessionAllowedHosts.delete(id)
    }
  }

  // ---------------------------------------------------------------------------
  // Domain-prompt UX — settings + per-session overlay accessors / mutators.
  // ---------------------------------------------------------------------------

  getSettings(): ComputerUseSettings {
    return this._settings
  }

  getSessionAllowedHosts(id: ComputerSessionId): ReadonlySet<string> {
    return this._sessionAllowedHosts.get(id) ?? EMPTY_HOST_SET
  }

  allowDomainForSession(id: ComputerSessionId, host: string): void {
    if (typeof host !== 'string' || host.length === 0) return
    const entry = this._sessions.get(id)
    if (!entry || entry.closed) return
    const lowered = host.toLowerCase()
    let set = this._sessionAllowedHosts.get(id)
    if (set === undefined) {
      set = new Set<string>()
      this._sessionAllowedHosts.set(id, set)
    }
    set.add(lowered)
  }

  async persistAllowedDomain(host: string): Promise<void> {
    const patterns = derivePersistencePatterns(host)
    if (patterns.length === 0) return
    const existing = new Set(this._settings.allowedDomains)
    let added = false
    for (const p of patterns) {
      if (!existing.has(p)) {
        existing.add(p)
        added = true
      }
    }
    if (!added) return
    const nextAllowed: readonly string[] = [...existing]
    const next: ComputerUseSettings = {
      ...this._settings,
      allowedDomains: nextAllowed,
    }
    this._settings = next
    // Notify every live session so the route interceptor and navigate
    // pre-flight pick up the new list on their next read. Closed sessions
    // are skipped — they will not navigate again.
    for (const entry of this._sessions.values()) {
      if (!entry.closed) {
        entry.session.refreshSettings(next)
      }
    }
    // Atomic write to ~/.ultron/settings.json. `writeSettingsConfig` swallows
    // I/O errors and warns to stderr, so a transient disk failure degrades
    // to "session has it, restart loses it" rather than throwing.
    writeSettingsConfig({ computerUse: { allowedDomains: nextAllowed as string[] } })
  }
}

const EMPTY_HOST_SET: ReadonlySet<string> = new Set<string>()
