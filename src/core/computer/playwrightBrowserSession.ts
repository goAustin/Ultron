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

import { isDomainAllowed, isUrlSchemeAllowed } from './policy.js'
import { stabilize } from './stabilize.js'
import type { BrowserSessionFactory } from './sessionManager.js'
import {
  BrowserSessionError,
  type BrowserSession,
  type ComputerSessionId,
  type ComputerDisplaySize,
  type ComputerViewport,
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
}) => Promise<LaunchedBrowser>

const NAVIGATION_TIMEOUT_MS = 30_000

const defaultLaunchChromium: LaunchChromiumFn = async (params) => {
  const browser = await chromium.launch({
    headless: params.headless,
    args: [...params.args],
  })
  const context = await browser.newContext({
    viewport: { width: params.viewport.width, height: params.viewport.height },
    acceptDownloads: false,
    permissions: [],
    bypassCSP: false,
    javaScriptEnabled: true,
    serviceWorkers: 'block',
  })
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
  const launch = deps?.launchChromium ?? defaultLaunchChromium
  return async ({ id, settings, options, requestClose }) => {
    let launched: LaunchedBrowser
    try {
      launched = await launch({
        headless: options.headless ?? true,
        args: options.hostResolverRules
          ? [`--host-resolver-rules=${options.hostResolverRules}`]
          : [],
        viewport: {
          width: settings.viewport.width,
          height: settings.viewport.height,
        },
      })
    } catch (err) {
      if (isMissingChromiumError(err)) {
        throw new BrowserSessionError(
          'chromium_not_installed',
          'Chromium is not installed. Run: npx playwright install chromium',
        )
      }
      throw err
    }

    const session = new PlaywrightBrowserSession({
      id,
      settings,
      options,
      requestClose,
      launched,
    })
    await session._installRouteInterceptor()
    session._installPopupBlocker()
    return session
  }
}

type PopupErrorNotifier = (err: unknown) => void

const noopPopupNotifier: PopupErrorNotifier = () => {}

export class PlaywrightBrowserSession implements BrowserSession {
  readonly id: ComputerSessionId
  readonly viewport: ComputerViewport
  readonly displaySize: ComputerDisplaySize

  private readonly _settings: ComputerUseSettings
  private readonly _options: StartSessionOptions
  private readonly _requestClose: (reason: 'aborted' | 'timeout' | 'error') => Promise<void>
  private readonly _browser: Browser
  private readonly _context: BrowserContext
  private readonly _page: Page
  private readonly _onPopupError: PopupErrorNotifier
  private _closed = false

  constructor(params: {
    readonly id: ComputerSessionId
    readonly settings: ComputerUseSettings
    readonly options: StartSessionOptions
    readonly requestClose: (reason: 'aborted' | 'timeout' | 'error') => Promise<void>
    readonly launched: LaunchedBrowser
    readonly onPopupError?: PopupErrorNotifier
  }) {
    this.id = params.id
    this.viewport = {
      width: params.settings.viewport.width,
      height: params.settings.viewport.height,
      // DSF=1 is pinned for v3 (see Open Question 1 in the design doc).
      deviceScaleFactor: 1,
    }
    this.displaySize = {
      width: params.settings.displaySize.width,
      height: params.settings.displaySize.height,
    }
    this._settings = params.settings
    this._options = params.options
    this._requestClose = params.requestClose
    this._browser = params.launched.browser
    this._context = params.launched.context
    this._page = params.launched.page
    this._onPopupError = params.onPopupError ?? noopPopupNotifier
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
        { requireAllowlist },
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

  async navigate(url: string, signal: AbortSignal): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')

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
      { requireAllowlist },
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
        })
      } catch (err) {
        if (this._closed) {
          throw new BrowserSessionError('aborted', 'screenshot aborted (session closing)')
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new BrowserSessionError('screenshot_failed', `screenshot failed: ${msg}`)
      }
      const base64 = buf.toString('base64')
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
      const attachment: ToolResultAttachment = validated.attachment
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

  async stabilize(signal: AbortSignal): Promise<void> {
    if (this._closed) throw new BrowserSessionError('session_closed', 'session is closed')
    return this._withAbort(signal, async () => {
      await stabilize(this._page, signal)
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
      return await op()
    } finally {
      if (onAbort !== null) signal.removeEventListener('abort', onAbort)
    }
  }
}
