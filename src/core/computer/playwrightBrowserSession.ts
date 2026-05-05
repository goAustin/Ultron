/**
 * v3 Phase 2: Profile A (local Playwright) implementation of BrowserSession.
 *
 * Owns:
 * - Playwright Browser + BrowserContext + Page lifecycle (one of each per session).
 * - The `context.route('**\/*')` interceptor that enforces domain + scheme policy
 *   on every request (top-level and subresource).
 * - Navigation pre-flight: scheme check then domain check against
 *   `computerUseSettings.{allowedDomains,deniedDomains}`.
 * - Screenshot capture into base64 PNG, validated through Phase 1's
 *   `validateImageAttachment`.
 * - Abort plumbing: every public method registers a `{ once: true }` abort
 *   listener that calls `requestClose(reason: 'aborted')`. The
 *   SessionManager's cleanup-once path then closes both context AND browser,
 *   so abort cannot leak the chromium subprocess.
 *
 * The chromium-launch is split out behind `LaunchChromiumFn` so the unit test
 * can pass a stub. The default launcher imports playwright; a future
 * Profile B/C backend can plug in a different launcher under the same factory.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

import {
  validateImageAttachment,
  type ToolResultAttachment,
} from '../tools/imageAttachment.js'
import type { ComputerUseSettings } from '../../config/computerUseSettings.js'
import { extractHost } from '../../web/domainPolicy.js'

import {
  buildSnapshot,
  extractAriaTreeInBrowser,
  type AriaNode,
  type AriaTreeSnapshot,
  type BoundingBox,
} from './ariaSnapshot.js'
import {
  bboxesMatch,
  BBOX_TOLERANCE_PX,
  type AtomAction,
  type AtomEntry,
  type AtomLocator,
} from './atomResolver.js'
import { normalizedToCssPx } from './coordinates.js'
import { isDomainAllowed, isUrlSchemeAllowed } from './policy.js'
import { blackoutRegions, buildSelectorList } from './redaction.js'
import type { SessionAtomCache } from './selectorCache.js'
import { stabilize } from './stabilize.js'
import type { BrowserSessionFactory } from './sessionManager.js'
import {
  BrowserSessionError,
  type BrowserSession,
  type ComputerSessionId,
  type ComputerDisplaySize,
  type ComputerViewport,
  type MouseButton,
  type NormalizedPoint,
  type ScreenshotResult,
  type StartSessionOptions,
} from './types.js'

export type LaunchedBrowser = {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
}

export type LaunchChromiumFn = (params: {
  readonly headless: boolean
  readonly args: readonly string[]
  readonly viewport: { readonly width: number; readonly height: number }
  // Phase 4·3 — pre-validated Playwright `storageState` object. Forwarded to
  // `browser.newContext({ storageState })` when present; ignored otherwise.
  readonly storageState?: unknown
  // v3 Phase 6 — per-session DSF override forwarded to
  // `browser.newContext({ deviceScaleFactor })`. Defaults to 1 when omitted.
  readonly deviceScaleFactor?: number
}) => Promise<LaunchedBrowser>

const NAVIGATION_TIMEOUT_MS = 30_000

const defaultLaunchChromium: LaunchChromiumFn = async (params) => {
  const browser = await chromium.launch({
    headless: params.headless,
    args: [...params.args],
  })
  // Build context options once; storageState is layered on conditionally so
  // we can fall back to the bare options if Playwright rejects the state.
  const baseContextOptions: NonNullable<Parameters<typeof browser.newContext>[0]> = {
    viewport: { width: params.viewport.width, height: params.viewport.height },
    acceptDownloads: false,
    permissions: [],
    bypassCSP: false,
    javaScriptEnabled: true,
    serviceWorkers: 'block',
    // v3 Phase 6 — per-session DSF override; only forwarded when caller set
    // it. Default `undefined` lets Playwright pick its own default (1 for
    // headless chromium), matching pre-Phase-6 behavior.
    ...(params.deviceScaleFactor !== undefined
      ? { deviceScaleFactor: params.deviceScaleFactor }
      : {}),
  }
  let context: BrowserContext
  try {
    if (params.storageState !== undefined) {
      const withStorage: typeof baseContextOptions = {
        ...baseContextOptions,
        // Cast: `storageStateStore.loadStorageState` already normalized the
        // shape. Playwright may still reject specifics (cookie domain rules,
        // unknown fields in newer schema versions) — handled by the catch.
        storageState: params.storageState as typeof baseContextOptions.storageState,
      }
      try {
        context = await browser.newContext(withStorage)
      } catch (storageErr) {
        // Phase 4·3 fix — design contract: "session start must never throw on
        // rehydration." Bad storageState (post-validation, post-normalize)
        // → warn + retry cookie-less. Browser stays alive.
        const msg = storageErr instanceof Error ? storageErr.message : String(storageErr)
        process.stderr.write(
          `[ultron] warning: stored credentials rejected by Playwright; starting cookie-less. ${msg}\n`,
        )
        context = await browser.newContext(baseContextOptions)
      }
    } else {
      context = await browser.newContext(baseContextOptions)
    }
  } catch (err) {
    // Any newContext failure that isn't recoverable: close the launched
    // browser to avoid a leaked process, then propagate. Without this the
    // browser kept running headlessly even after the factory threw.
    await browser.close().catch(() => undefined)
    throw err
  }
  const page = await context.newPage()
  return { browser, context, page }
}

/**
 * CDP backend launcher. Connects via `chromium.connectOverCDP(endpoint)`,
 * then creates an isolated `BrowserContext` inside the user's Chrome with
 * the same options `defaultLaunchChromium` uses for storageState, viewport,
 * DSF, and the route interceptor — so every downstream code path is
 * launch-mode-agnostic. Per Playwright's type doc
 * (`playwright-core/types/types.d.ts:9820-9826`), `browser.close()` on a
 * connected browser closes Playwright-created contexts and disconnects the
 * WebSocket without terminating the user's Chrome — so the existing
 * `close()` path is safe to reuse without gating.
 *
 * `params.headless` is intentionally ignored: visibility is controlled by
 * the user's Chrome launch flags. `ComputerStart.validateInput` rejects
 * `backend: 'cdp' + headless: true` upstream, and `createPlaywrightSessionFactory`
 * forces the constructed session's `headless` to `false`.
 */
export const connectChromiumOverCdp =
  (endpoint: string): LaunchChromiumFn =>
  async (params) => {
    let browser: Browser
    try {
      browser = await chromium.connectOverCDP(endpoint)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserSessionError(
        'cdp_connect_failed',
        `connectOverCDP(${endpoint}) failed: ${msg}. ` +
          'Start Chrome with --remote-debugging-port=… and verify the port is reachable on 127.0.0.1.',
      )
    }
    const baseContextOptions: NonNullable<Parameters<typeof browser.newContext>[0]> = {
      viewport: { width: params.viewport.width, height: params.viewport.height },
      acceptDownloads: false,
      permissions: [],
      bypassCSP: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      ...(params.deviceScaleFactor !== undefined
        ? { deviceScaleFactor: params.deviceScaleFactor }
        : {}),
    }
    let context: BrowserContext
    try {
      if (params.storageState !== undefined) {
        const withStorage: typeof baseContextOptions = {
          ...baseContextOptions,
          storageState: params.storageState as typeof baseContextOptions.storageState,
        }
        try {
          context = await browser.newContext(withStorage)
        } catch (storageErr) {
          // Mirror `defaultLaunchChromium`'s "rehydration must never throw"
          // posture — bad storageState falls back to cookie-less.
          const msg = storageErr instanceof Error ? storageErr.message : String(storageErr)
          process.stderr.write(
            `[ultron] warning: stored credentials rejected by Playwright; starting cookie-less. ${msg}\n`,
          )
          context = await browser.newContext(baseContextOptions)
        }
      } else {
        context = await browser.newContext(baseContextOptions)
      }
    } catch (err) {
      // newContext failed for non-storage reasons: clean up the WebSocket
      // before propagating so a leaked CDP connection doesn't dangle.
      await browser.close().catch(() => undefined)
      throw err
    }
    const page = await context.newPage()
    return { browser, context, page }
  }

/**
 * Match shapes Playwright surfaces when the chromium binary is missing.
 * Playwright doesn't expose a typed error class, so we substring-match — but
 * only on patterns specific to a missing executable. The previous version
 * matched any `browserType.launch:`-prefixed error, which mislabeled
 * unrelated launch failures (timeouts, sandbox errors, etc.) as missing
 * chromium. Pinned by `playwrightBrowserSession.test.ts` so a future
 * Playwright bump surfaces a failing test if the format drifts.
 */
function isMissingChromiumError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message
  if (/Executable doesn't exist/i.test(msg)) return true
  // Some Node spawns surface ENOENT on the error itself.
  if ((err as { code?: string }).code === 'ENOENT') return true
  // Playwright also worded it as "Failed to launch ... no such file or directory".
  if (/no such file or directory/i.test(msg) && /chromium|playwright/i.test(msg)) return true
  return false
}

export function createPlaywrightSessionFactory(deps?: {
  readonly launchChromium?: LaunchChromiumFn
}): BrowserSessionFactory {
  return async ({
    id,
    settings,
    options,
    requestClose,
    recordScreenshot,
    getSessionAllowedHosts,
  }) => {
    // Backend selection. CDP fail-closes synchronously when an endpoint is
    // missing — SDK callers that bypass `ComputerStart.validateInput` get the
    // same surface as model-driven calls. `deps?.launchChromium` is honored
    // for both modes (tests inject stubs); the real `connectChromiumOverCdp`
    // is exercised by `playwrightBrowserSession.cdp.integration.test.ts`.
    const useCdp = options.backend === 'cdp'
    if (useCdp && options.cdpEndpoint === undefined) {
      throw new BrowserSessionError(
        'cdp_connect_failed',
        "backend: 'cdp' requires a cdpEndpoint; configure computerUse.cdpEndpoint or pass cdpEndpoint in StartSessionOptions",
      )
    }
    const launch: LaunchChromiumFn = deps?.launchChromium
      ?? (useCdp
        ? connectChromiumOverCdp(options.cdpEndpoint as string)
        : defaultLaunchChromium)

    let launched: LaunchedBrowser
    try {
      launched = await launch({
        // CDP ignores headless (visibility is controlled by the user's
        // Chrome flags), but we still pass a value so the launcher signature
        // stays stable. Local-launch defaults to true (Phase 0 posture).
        headless: useCdp ? false : (options.headless ?? true),
        args: options.hostResolverRules
          ? [`--host-resolver-rules=${options.hostResolverRules}`]
          : [],
        viewport: {
          width: settings.viewport.width,
          height: settings.viewport.height,
        },
        // v3 Phase 6 — DSF override (default 1). Forwarded to the launcher so
        // `context.newContext({ deviceScaleFactor })` matches the value
        // mirrored on `BrowserSession.viewport.deviceScaleFactor`.
        ...(options.deviceScaleFactor !== undefined
          ? { deviceScaleFactor: options.deviceScaleFactor }
          : {}),
        ...(options.storageState !== undefined ? { storageState: options.storageState } : {}),
      })
    } catch (err) {
      if (err instanceof BrowserSessionError) throw err
      if (isMissingChromiumError(err)) {
        throw new BrowserSessionError(
          'chromium_not_installed',
          'Chromium is not installed. Run: npx playwright install chromium',
        )
      }
      // storageState rejection is now handled inside `defaultLaunchChromium`
      // (warn + retry cookie-less, no throw). Anything that reaches here is
      // a non-recoverable launch failure — `defaultLaunchChromium` already
      // closed the launched browser if applicable.
      throw err
    }

    // CDP sessions: `BrowserSession.headless` reflects whether the
    // CDP-attached Chrome is operator-visible. We can't introspect Chrome's
    // `--headless` flag from a CDP connection, so the value comes from
    // `computerUse.cdpAssumeVisible` (default false → treat as invisible →
    // refuse handoff). `input.headless` is meaningless under CDP — already
    // rejected when explicitly true by `ComputerStart.validateInput`.
    const sessionOptions: StartSessionOptions = useCdp
      ? { ...options, headless: !settings.cdpAssumeVisible }
      : options
    const session = new PlaywrightBrowserSession({
      id,
      settings,
      options: sessionOptions,
      requestClose,
      recordScreenshot,
      // Domain-prompt UX — forward the SessionManager's per-session overlay
      // closure. Without this, `allow_once` for an unknown host gets the
      // cascade approval but `BrowserSession.navigate()` still rejects with
      // `domain_denied` because the live overlay is invisible to the session.
      ...(getSessionAllowedHosts !== undefined && { getSessionAllowedHosts }),
      launched,
    })
    await session._installRouteInterceptor()
    session._installPopupBlocker()
    session._installDisconnectHandler()
    return session
  }
}

type PopupErrorNotifier = (err: unknown) => void

const noopPopupNotifier: PopupErrorNotifier = () => {}

const noopRecordScreenshot = (_bytes: number): void => {}

const EMPTY_HOST_SET: ReadonlySet<string> = new Set<string>()
const noopHostSet = (): ReadonlySet<string> => EMPTY_HOST_SET

export class PlaywrightBrowserSession implements BrowserSession {
  readonly id: ComputerSessionId
  readonly viewport: ComputerViewport
  readonly displaySize: ComputerDisplaySize
  readonly headless: boolean

  // Domain-prompt UX — `_settings` is mutable so `refreshSettings` can swap
  // in an extended `allowedDomains` after a `persistAllowedDomain` call from
  // the SessionManager. Both the route interceptor and navigate pre-flight
  // dereference `this._settings.allowedDomains` per request, so the swap is
  // atomic for any subsequent request.
  private _settings: ComputerUseSettings
  private readonly _options: StartSessionOptions
  private readonly _requestClose: (reason: 'aborted' | 'timeout' | 'error') => Promise<void>
  // Domain-prompt UX — closure over the SessionManager's per-session overlay
  // for this session id. Read on every domain check so an `allow_once`
  // approval propagates before the navigate or subresource fetch fires.
  // Defaults to an always-empty closure for direct-construct test paths.
  private readonly _getSessionAllowedHosts: () => ReadonlySet<string>
  // v3 Phase 6 — pre-bound metrics callback supplied by the manager. Called
  // after each successful `screenshot()` capture. Fire-and-forget; the manager
  // no-ops on closed/unknown sessions. `() => {}` is a safe default for
  // direct-construct test paths that don't care about metrics.
  private readonly _recordScreenshot: (bytes: number) => void
  private readonly _browser: Browser
  private readonly _context: BrowserContext
  private readonly _page: Page
  private readonly _onPopupError: PopupErrorNotifier
  private _closed = false
  // Phase 4·1: cache of the most recent successful ARIA capture. Read
  // synchronously by the safety check via `lastAriaSnapshot()`. Cleared on
  // close so a closed session can never serve stale ARIA.
  private _lastAriaSnapshot: AriaTreeSnapshot | null = null
  // Phase 4b: per-session atom catalog. Populated by `ComputerObserveActions`
  // via `setAtomCache`; read synchronously by the safety check via
  // `lookupAtom` (so it can pass `targetNode` to the classifier without an
  // async hop). Cleared on `close()` and `navigate()` — atomIds are only
  // valid for the snapshot they were assigned in.
  private _atomCache: SessionAtomCache | null = null

  constructor(params: {
    readonly id: ComputerSessionId
    readonly settings: ComputerUseSettings
    readonly options: StartSessionOptions
    readonly requestClose: (reason: 'aborted' | 'timeout' | 'error') => Promise<void>
    /**
     * v3 Phase 6 — pre-bound metrics callback supplied by the manager. The
     * factory plumbs it through; direct-construct test paths that don't care
     * about metrics can pass `() => {}`.
     */
    readonly recordScreenshot?: (bytes: number) => void
    /**
     * Domain-prompt UX — closure over the SessionManager's per-session allow
     * overlay. Optional: tests that direct-construct without a manager can
     * omit it (defaults to always-empty).
     */
    readonly getSessionAllowedHosts?: () => ReadonlySet<string>
    readonly launched: LaunchedBrowser
    readonly onPopupError?: PopupErrorNotifier
  }) {
    this.id = params.id
    this.viewport = {
      width: params.settings.viewport.width,
      height: params.settings.viewport.height,
      // v3 Phase 6 — DSF mirrors the per-session override (default 1).
      // Coordinate math (`normalizedToCssPx`) intentionally ignores DSF
      // because Playwright's mouse/keyboard APIs take CSS px, not device px.
      // The mirror is for callers that read `session.viewport.deviceScaleFactor`
      // (e.g. native-bridge translation) so they see the value the launch
      // path actually applied.
      deviceScaleFactor: params.options.deviceScaleFactor ?? 1,
    }
    this.displaySize = {
      width: params.settings.displaySize.width,
      height: params.settings.displaySize.height,
    }
    this.headless = params.options.headless ?? true
    this._settings = params.settings
    this._options = params.options
    this._requestClose = params.requestClose
    this._recordScreenshot = params.recordScreenshot ?? noopRecordScreenshot
    this._getSessionAllowedHosts = params.getSessionAllowedHosts ?? noopHostSet
    this._browser = params.launched.browser
    this._context = params.launched.context
    this._page = params.launched.page
    this._onPopupError = params.onPopupError ?? noopPopupNotifier
  }

  /**
   * Domain-prompt UX — atomic settings swap. Called by the SessionManager
   * after `persistAllowedDomain` extends the persistent allowlist. Both the
   * route interceptor and navigate pre-flight read `this._settings.*` per
   * request, so the swap is observed by the next request without restart.
   */
  refreshSettings(next: ComputerUseSettings): void {
    this._settings = next
  }

  async _installRouteInterceptor(): Promise<void> {
    await this._context.route('**/*', (route, request) => {
      const url = request.url()
      const schemeCheck = isUrlSchemeAllowed(url, {
        allowHttpForTest: this._options.allowHttpForTest ?? false,
      })
      if (!schemeCheck.allowed) {
        void route.abort('blockedbyclient')
        return
      }
      const requireAllowlist = this._options.requireAllowlist ?? true
      const domainCheck = isDomainAllowed(
        url,
        {
          allowedDomains: this._settings.allowedDomains,
          deniedDomains: this._settings.deniedDomains,
        },
        { requireAllowlist, sessionAllowedHosts: this._getSessionAllowedHosts() },
      )
      if (!domainCheck.allowed) {
        void route.abort('blockedbyclient')
        return
      }
      void route.continue()
    })
  }

  _installPopupBlocker(): void {
    this._context.on('page', (popup) => {
      // Popups are converted into close events. The `close().catch()` swallows
      // any teardown race so an exotic popup can't crash the session.
      popup.close().catch((err) => this._onPopupError(err))
    })
  }

  /**
   * v3 Phase 6 — surface unexpected browser disconnects (Chromium SIGKILL,
   * crash, daemon kill) to the SessionManager so the registry doesn't keep
   * thinking the session is alive. The `_closed` guard suppresses the event
   * when an intentional close path (`close()` / `requestClose`) already set
   * the flag — without it every clean teardown would also fire `requestClose`.
   * `requestClose → closeOnce` is idempotent, so a residual race in either
   * direction is at worst a redundant no-op call.
   */
  _installDisconnectHandler(): void {
    this._browser.on('disconnected', () => {
      if (this._closed) return
      void this._requestClose('error')
    })
  }

  async navigate(url: string, signal: AbortSignal): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')

    // Phase 4b — atomIds are scoped to the URL they were observed on.
    // A navigation invalidates the catalog; locator-name strings might still
    // match elements on the new page, but they wouldn't be the same elements.
    // Clear eagerly so a `Observe → Navigate → ActAtom` sequence reaches the
    // cache-miss path instead of acting on a stale entry.
    this._atomCache = null

    // Pre-flight checks (synchronous; reject before opening any socket).
    const schemeCheck = isUrlSchemeAllowed(url, {
      allowHttpForTest: this._options.allowHttpForTest ?? false,
    })
    if (!schemeCheck.allowed) {
      const host = extractHost(url) ?? undefined
      throw new BrowserSessionError(
        'scheme_denied',
        `URL scheme is not permitted: ${url}`,
        host,
      )
    }
    const requireAllowlist = this._options.requireAllowlist ?? true
    const domainCheck = isDomainAllowed(
      url,
      {
        allowedDomains: this._settings.allowedDomains,
        deniedDomains: this._settings.deniedDomains,
      },
      { requireAllowlist, sessionAllowedHosts: this._getSessionAllowedHosts() },
    )
    if (!domainCheck.allowed) {
      const host = extractHost(url) ?? undefined
      throw new BrowserSessionError(
        'domain_denied',
        `Domain is not permitted by policy: ${host ?? url}`,
        host,
      )
    }

    return this._withAbort(signal, async () => {
      try {
        await this._page.goto(url, {
          waitUntil: 'commit',
          timeout: NAVIGATION_TIMEOUT_MS,
        })
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'navigate aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('navigation_failed', `navigate failed: ${msg}`)
      }
    })
  }

  async screenshot(signal: AbortSignal): Promise<ScreenshotResult> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')

    return this._withAbort(signal, async () => {
      let buf: Buffer
      try {
        buf = await this._page.screenshot({
          type: 'png',
          fullPage: false,
          animations: 'disabled',
          // v3 Phase 6 — `scale: 'css'` keeps screenshot dimensions equal to
          // the CSS-px viewport regardless of `deviceScaleFactor`. Without
          // this, a DSF=2 session captures at 2× pixel size (e.g. 2048×1536
          // for a 1024×768 viewport) and immediately fails
          // `validateImageAttachment` against the default
          // `maxScreenshotDimensions: 1024×768`. The model-facing contract is
          // CSS-px throughout (normalized coords map to CSS px in
          // `normalizedToCssPx`), so capturing at CSS scale also keeps the
          // bridge translation contract round-trippable.
          scale: 'css',
        })
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'screenshot aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('screenshot_failed', `screenshot failed: ${msg}`)
      }

      // Phase 4·2: apply blackouts to sensitive regions BEFORE encoding the
      // base64 attachment. The two phases — region detection and pixel
      // blackout — have DIFFERENT failure semantics by design:
      //
      // - Region collection failure (Playwright selector error, malformed
      //   user selector, page crashed mid-query) is best-effort: we don't
      //   know what was sensitive, so we ship the unredacted PNG.
      // - Blackout failure AFTER regions were detected is a safety
      //   regression: we KNOW what's sensitive but couldn't redact it.
      //   Failing open here would leak the raw screenshot containing the
      //   exact fields we just identified as sensitive. Fail closed instead
      //   (Phase 4·2 fix #9 — the previous single-try/catch lumped these
      //   together and leaked on PNG-codec errors).
      let pngBytes: Uint8Array = buf
      let redacted = false
      let regions: readonly { x: number; y: number; width: number; height: number }[] = []
      try {
        regions = await this._collectSensitiveRegions(this._settings.redactionSelectors)
      } catch {
        // Region collection failed — ship the unredacted PNG. We don't know
        // what's sensitive, so there's nothing to fail-closed on.
      }
      if (regions.length > 0) {
        try {
          pngBytes = blackoutRegions(buf, regions)
          redacted = true
        } catch (err) {
          // Fail closed: we identified sensitive regions but the blackout
          // codec failed. Surfacing as `screenshot_failed` matches how the
          // Playwright capture itself fails out, and the tool error mapper
          // turns it into `errorKind: 'execution_error'` for the model —
          // the model gets a clear "screenshot failed" rather than a leaked
          // password field.
          const msg = err instanceof Error ? err.message : String(err)
          throw new BrowserSessionError(
            'screenshot_failed',
            `screenshot redaction failed (${regions.length} sensitive regions detected; blackout error: ${msg})`,
          )
        }
      }

      const base64 = Buffer.from(pngBytes).toString('base64')
      const validated = validateImageAttachment(base64, 'image/png', {
        maxBytes: this._settings.maxScreenshotBytes,
        maxWidth: this._settings.maxScreenshotDimensions.width,
        maxHeight: this._settings.maxScreenshotDimensions.height,
      })
      if (!validated.ok) {
        throw new BrowserSessionError(
          'screenshot_oversized',
          `screenshot rejected by validateImageAttachment: ${validated.reason} - ${validated.message}`,
        )
      }
      // Phase 4·2: stamp `redacted` so audit can tell whether blackouts were
      // applied without re-decoding the PNG. Phase 1 reserved the field for
      // exactly this case.
      const attachment: ToolResultAttachment = redacted
        ? { ...validated.attachment, redacted: true }
        : validated.attachment
      // v3 Phase 6 — accumulate screenshot byte/count metrics. Fire-and-forget;
      // the manager handles unknown/closed sessions. Use the on-the-wire byte
      // count (post-redaction encoded size) so the total reflects what was
      // actually shipped to the model.
      this._recordScreenshot(attachment.byteSize)
      const url = this._page.url()
      let title: string | null = null
      try {
        title = await this._page.title()
      } catch {
        title = null
      }
      return {
        attachment,
        observation: { url, title },
      }
    })
  }

  async getSensitiveRegions(
    extraSelectors: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly BoundingBox[]> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    return this._withAbort(signal, async () => this._collectSensitiveRegions(extraSelectors))
  }

  async exportStorageState(signal: AbortSignal): Promise<unknown> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    return this._withAbort(signal, async () => {
      try {
        return await this._context.storageState()
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'session closed during storageState export')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('interaction_failed', `storageState export failed: ${msg}`)
      }
    })
  }

  /**
   * Internal — query the page for sensitive elements and collect their
   * bounding boxes in CSS pixels. Selector errors and per-element failures
   * are swallowed individually so one broken user selector doesn't drop the
   * whole list. Off-screen / hidden elements (boundingBox === null) are
   * filtered out.
   */
  private async _collectSensitiveRegions(
    extraSelectors: readonly string[],
  ): Promise<readonly BoundingBox[]> {
    const selectors = buildSelectorList(extraSelectors)
    const out: BoundingBox[] = []
    for (const selector of selectors) {
      try {
        const locator = this._page.locator(selector)
        const handles = await locator.elementHandles()
        for (const handle of handles) {
          try {
            const box = await handle.boundingBox()
            if (box !== null && box.width > 0 && box.height > 0) {
              out.push({ x: box.x, y: box.y, width: box.width, height: box.height })
            }
          } catch {
            /* per-element bbox failure — skip this element */
          } finally {
            await handle.dispose().catch(() => undefined)
          }
        }
      } catch {
        /* malformed selector or DOM-evaluation error — skip this selector */
      }
    }
    return out
  }

  async stabilize(signal: AbortSignal): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    return this._withAbort(signal, async () => {
      // Phase 4·2: pass the ariaSnapshotHash hook so step 5 (ARIA convergence)
      // can run. The page object already implements waitForLoadState; we
      // augment it with a bound hash function. The hook captures via
      // `extractAriaTreeInBrowser` directly so it doesn't recurse into
      // `_withAbort` (we're already inside one).
      const pageWithAria = Object.assign(this._page, {
        ariaSnapshotHash: async (s: AbortSignal): Promise<string> => {
          if (s.aborted) throw new BrowserSessionError('aborted', 'aria sample aborted')
          const tree = await this._page.evaluate(extractAriaTreeInBrowser)
          return buildSnapshot(tree, {
            tokenBudget: this._settings.ariaSnapshotMaxTokens,
          }).hash
        },
      })
      await stabilize(pageWithAria, signal)
    })
  }

  currentUrl(): string | null {
    if (this._closed) return null
    try {
      return this._page.url()
    } catch {
      return null
    }
  }

  async currentTitle(): Promise<string | null> {
    if (this._closed) return null
    try {
      return await this._page.title()
    } catch {
      return null
    }
  }

  isClosed(): boolean {
    return this._closed
  }

  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this._lastAriaSnapshot = null
    this._atomCache = null
    // Close context first, then browser. Either may throw if Playwright already
    // tore them down due to a crash; we swallow but do not re-throw because
    // close() must be idempotent and best-effort.
    try {
      await this._context.close()
    } catch {
      /* swallow */
    }
    try {
      await this._browser.close()
    } catch {
      /* swallow */
    }
  }

  /**
   * Run `op` with an abort listener that triggers `requestClose('aborted')`.
   * The listener is removed in the success and failure paths so listener count
   * stays bounded across many calls in one session.
   *
   * v3 Phase 3 hardening: post-op abort check. Fast Playwright calls
   * (mouse.click, keyboard.press) can resolve in microseconds — before the
   * abort listener's requestClose has a chance to interrupt. Without the
   * post-op check, a mid-call abort silently returns the success value and
   * the Phase 3 acceptance criterion ("Each tool returns `aborted` when the
   * query signal aborts") gets violated.
   */
  private async _withAbort<T>(
    signal: AbortSignal,
    op: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) {
      throw new BrowserSessionError('aborted', 'operation aborted before start')
    }
    let onAbort: (() => void) | null = null
    try {
      onAbort = (): void => {
        void this._requestClose('aborted')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const result = await op()
      if (signal.aborted) {
        throw new BrowserSessionError('aborted', 'operation aborted mid-call')
      }
      return result
    } finally {
      if (onAbort !== null) signal.removeEventListener('abort', onAbort)
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3 action primitives
  //
  // Coordinate inputs are pre-validated NormalizedPoints; the implementation
  // converts to CSS px against `this.viewport` via Phase 2's
  // `normalizedToCssPx`. Playwright's `page.mouse` API takes CSS px, not
  // device px — so DSF is intentionally NOT multiplied in.
  //
  // Every method:
  //   1. Refuses on `_closed`.
  //   2. Routes through `_withAbort` so the abort listener is wired and the
  //      post-op abort check runs.
  //   3. Catches Playwright errors and surfaces them as
  //      `BrowserSessionError(kind: 'interaction_failed')` UNLESS the session
  //      is closing, in which case `'aborted'` wins.
  // -------------------------------------------------------------------------

  async click(point: NormalizedPoint, button: MouseButton, signal: AbortSignal): Promise<void> {
    await this._mouseAction(point, signal, async (cssX, cssY) => {
      await this._page.mouse.click(cssX, cssY, { button })
    })
  }

  async doubleClick(point: NormalizedPoint, button: MouseButton, signal: AbortSignal): Promise<void> {
    await this._mouseAction(point, signal, async (cssX, cssY) => {
      await this._page.mouse.dblclick(cssX, cssY, { button })
    })
  }

  async typeText(text: string, signal: AbortSignal): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    await this._withAbort(signal, async () => {
      try {
        await this._page.keyboard.type(text)
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'typeText aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('interaction_failed', `typeText failed: ${msg}`)
      }
    })
  }

  async pressKey(key: string, signal: AbortSignal): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    await this._withAbort(signal, async () => {
      try {
        await this._page.keyboard.press(key)
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'pressKey aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('interaction_failed', `pressKey failed: ${msg}`)
      }
    })
  }

  async scroll(
    point: NormalizedPoint | null,
    deltaX: number,
    deltaY: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    await this._withAbort(signal, async () => {
      try {
        if (point !== null) {
          const css = normalizedToCssPx(point, this.viewport)
          await this._page.mouse.move(css.x, css.y)
        }
        await this._page.mouse.wheel(deltaX, deltaY)
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'scroll aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('interaction_failed', `scroll failed: ${msg}`)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Phase 4·1 — ARIA snapshot
  // -------------------------------------------------------------------------

  async ariaSnapshot(signal: AbortSignal): Promise<AriaTreeSnapshot> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    return this._withAbort(signal, async () => {
      let tree: AriaNode
      try {
        // `extractAriaTreeInBrowser` is serialized to a string and runs inside
        // the page. Playwright will inject it as a function expression; the
        // function is self-contained (no closure) by construction.
        tree = await this._page.evaluate(extractAriaTreeInBrowser)
      } catch (err) {
        // Phase 4·1 fix #7 — clear the cache BEFORE rethrowing so the next
        // synchronous safety check can't classify against a stale snapshot
        // from before the page mutated. With the cache stale, a post-action
        // recapture that fails (network glitch, page errored) would leave
        // the next dangerous-click classifier reading the OLD page's tree,
        // missing a Delete/Pay button on the NEW page.
        this._lastAriaSnapshot = null
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'ariaSnapshot aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('interaction_failed', `ariaSnapshot failed: ${msg}`)
      }
      const snap = buildSnapshot(tree, {
        tokenBudget: this._settings.ariaSnapshotMaxTokens,
      })
      this._lastAriaSnapshot = snap
      return snap
    })
  }

  lastAriaSnapshot(): AriaTreeSnapshot | null {
    if (this._closed) return null
    return this._lastAriaSnapshot
  }

  async drag(from: NormalizedPoint, to: NormalizedPoint, signal: AbortSignal): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    await this._withAbort(signal, async () => {
      const fromCss = normalizedToCssPx(from, this.viewport)
      const toCss = normalizedToCssPx(to, this.viewport)
      // Track whether mouse.down() succeeded so a partial-failure path can
      // best-effort release the button. Without this, a throw between down()
      // and up() leaves the Playwright mouse logically pressed and bleeds
      // state into subsequent operations on the same session.
      let mouseDown = false
      try {
        await this._page.mouse.move(fromCss.x, fromCss.y)
        await this._page.mouse.down()
        mouseDown = true
        await this._page.mouse.move(toCss.x, toCss.y)
        await this._page.mouse.up()
        mouseDown = false
      } catch (err) {
        if (mouseDown) {
          // Best-effort release. Swallow the cleanup error — we want to
          // surface the original failure, not the cleanup's noise.
          try {
            await this._page.mouse.up()
          } catch {
            /* swallow */
          }
        }
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'drag aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('interaction_failed', `drag failed: ${msg}`)
      }
    })
  }

  private async _mouseAction(
    point: NormalizedPoint,
    signal: AbortSignal,
    op: (cssX: number, cssY: number) => Promise<void>,
  ): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    await this._withAbort(signal, async () => {
      const css = normalizedToCssPx(point, this.viewport)
      try {
        await op(css.x, css.y)
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'mouse action aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('interaction_failed', `mouse action failed: ${msg}`)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Phase 4b — DOM-first action path
  // -------------------------------------------------------------------------

  async actOnAtom(
    locator: AtomLocator,
    action: AtomAction,
    signal: AbortSignal,
  ): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    await this._withAbort(signal, async () => {
      const base = this._page.getByRole(
        locator.role as Parameters<Page['getByRole']>[0],
        locator.locatorName !== null ? { name: locator.locatorName, exact: true } : {},
      )
      const target = base.nth(locator.nth)

      // Preflight 1 — count > 0 (the cached element is still in the DOM).
      // Generic messages — `mapBrowserSessionError` writes the model-visible
      // recovery text so `locatorName` never leaks downstream.
      let matches: number
      try {
        matches = await target.count()
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'actOnAtom aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('interaction_failed', `actOnAtom count failed: ${msg}`)
      }
      if (matches === 0) {
        throw new BrowserSessionError('atom_locator_failed', 'locator resolved zero elements')
      }

      // Preflight 2 — bbox-drift (page didn't silently retarget `nth` to a
      // different element via duplicate-name shuffle). Only meaningful when
      // we have a cached bbox; entries without one fall back to count-only.
      if (locator.expectedBbox !== null) {
        let live: BoundingBox | null
        try {
          live = await target.boundingBox()
        } catch (err) {
          if (this._closed) {
            throw new BrowserSessionError('aborted', 'actOnAtom aborted (session closing)')
          }
          const msg = err instanceof Error ? err.message : String(err)
          throw new BrowserSessionError('interaction_failed', `actOnAtom boundingBox failed: ${msg}`)
        }
        if (live === null || !bboxesMatch(live, locator.expectedBbox, BBOX_TOLERANCE_PX)) {
          throw new BrowserSessionError(
            'atom_locator_failed',
            'locator bbox drift exceeds tolerance',
          )
        }
      }

      // Action.
      try {
        switch (action.type) {
          case 'click':
            if (action.double === true) {
              await target.dblclick({ button: action.button ?? 'left' })
            } else {
              await target.click({ button: action.button ?? 'left' })
            }
            return
          case 'fill':
            await target.fill(action.text)
            return
          case 'select':
            await target.selectOption(action.value)
            return
        }
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'actOnAtom aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('interaction_failed', `actOnAtom ${action.type} failed: ${msg}`)
      }
    })
  }

  setAtomCache(cache: SessionAtomCache): void {
    this._atomCache = cache
  }

  lookupAtom(atomId: string): AtomEntry | null {
    if (this._closed) return null
    if (this._atomCache === null) return null
    // Phase 4b stale-cache guard: the safety check classifies the cached
    // `AriaNode`, but `actOnAtom` resolves the LIVE Playwright locator. If
    // the page mutated since observation (e.g., a disabled `Delete account`
    // button became enabled), the cached node misrepresents reality and the
    // classifier could approve a now-dangerous click.
    //
    // `runActionAndObserve` refreshes `_lastAriaSnapshot` after every action;
    // when its hash diverges from the cache's hash, the cache is stale.
    // Returning null pushes the safety check to `targetNode === null`
    // (classifier defers to level 1) AND the tool body returns
    // `'atom_resolution_failed'` so the model re-observes.
    //
    // When `_lastAriaSnapshot` is null (post-action recapture failed —
    // network glitch, page errored), we also refuse: matching Phase 4·1
    // fix #7's defensive posture for `lastAriaSnapshot` clearing.
    const liveHash = this._lastAriaSnapshot?.hash
    if (liveHash === undefined || liveHash !== this._atomCache.ariaHash) return null
    return this._atomCache.entries.get(atomId) ?? null
  }

  currentAtomCache(): SessionAtomCache | null {
    if (this._closed) return null
    return this._atomCache
  }
}
