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
}
