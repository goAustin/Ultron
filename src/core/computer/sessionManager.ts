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

import type { ComputerUseSettings } from '../../config/computerUseSettings.js'

import {
  BrowserSessionError,
  type BrowserSession,
  type ComputerSessionId,
  type StartSessionOptions,
} from './types.js'

/**
 * Factory injected into SessionManager so unit tests can run without Playwright.
 *
 * `id`, `viewport`, and `displaySize` are owned by the manager and passed in;
 * the factory only constructs the runtime-specific implementation (Playwright
 * browser+context+page).
 */
export type BrowserSessionFactory = (params: {
  readonly id: ComputerSessionId
  readonly settings: ComputerUseSettings
  readonly options: StartSessionOptions
  readonly requestClose: (reason: 'aborted' | 'timeout' | 'error') => Promise<void>
}) => Promise<BrowserSession>

type SessionEntry = {
  readonly id: ComputerSessionId
  readonly session: BrowserSession
  readonly timeoutTimer: NodeJS.Timeout | null
  readonly abortListener: (() => void) | null
  readonly abortSignal: AbortSignal | null
  closed: boolean
}

export class SessionManager {
  private readonly _settings: ComputerUseSettings
  private readonly _factory: BrowserSessionFactory
  private readonly _sessions = new Map<ComputerSessionId, SessionEntry>()

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
    if (requireAllowlist && settings.allowedDomains.length === 0) {
      throw new BrowserSessionError(
        'allowlist_empty',
        'allowedDomains must be non-empty for non-test sessions; configure computerUse.allowedDomains',
      )
    }
    if (signal.aborted) {
      throw new BrowserSessionError('aborted', 'start aborted before session creation')
    }

    const id = randomUUID() as ComputerSessionId

    // Construct the entry first (with placeholders) so requestClose can find it
    // even if the factory's onCreate hooks fire callbacks during construction.
    const entry: SessionEntry = {
      id,
      session: null as unknown as BrowserSession, // backfilled below
      timeoutTimer: null,
      abortListener: null,
      abortSignal: signal,
      closed: false,
    }

    // Build the runtime session.
    let session: BrowserSession
    try {
      session = await this._factory({
        id,
        settings,
        options: opts,
        requestClose: (reason) => this.requestClose(id, reason),
      })
    } catch (err) {
      // Nothing to register; propagate.
      throw err
    }
    ;(entry as { session: BrowserSession }).session = session

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
    await this.closeOnce(id)
  }

  /**
   * Internal route used by BrowserSession instances when they need to close
   * due to abort/timeout/error. Guarantees one close path through `closeOnce`.
   */
  async requestClose(id: ComputerSessionId, _reason: 'aborted' | 'timeout' | 'error'): Promise<void> {
    await this.closeOnce(id)
  }

  /** Close every live session. Used during QueryEngine teardown. */
  async stopAll(): Promise<void> {
    const ids = [...this._sessions.keys()]
    await Promise.all(ids.map((id) => this.closeOnce(id)))
  }

  /**
   * Single cleanup path. Ensures `BrowserSession.close()` runs at most once per
   * session even under concurrent stop / timeout / abort / stopAll.
   */
  private async closeOnce(id: ComputerSessionId): Promise<void> {
    const entry = this._sessions.get(id)
    if (!entry) return
    if (entry.closed) return
    entry.closed = true
    if (entry.timeoutTimer !== null) clearTimeout(entry.timeoutTimer)
    if (entry.abortListener !== null && entry.abortSignal !== null) {
      entry.abortSignal.removeEventListener('abort', entry.abortListener)
    }
    try {
      await entry.session.close()
    } finally {
      this._sessions.delete(id)
    }
  }
}
