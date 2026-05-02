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

export interface BrowserSession {
  readonly id: ComputerSessionId
  readonly viewport: ComputerViewport
  readonly displaySize: ComputerDisplaySize
  navigate(url: string, signal: AbortSignal): Promise<void>
  screenshot(signal: AbortSignal): Promise<ScreenshotResult>
  stabilize(signal: AbortSignal): Promise<void>
  currentUrl(): string | null
  currentTitle(): Promise<string | null>
  isClosed(): boolean
  close(): Promise<void>
}
