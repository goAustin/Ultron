/**
 * Integration test: Computer-Use domain prompt flow through the permission
 * cascade, SessionManager, and ComputerNavigate tool.
 *
 * Uses a policy-enforcing fake BrowserSession instead of Chromium so the test
 * runs in normal CI while still proving the critical end-to-end behavior:
 * empty allowlist starts, unknown host asks, allow_by_rule updates live policy
 * + settings.json, and a sibling subdomain navigates without another prompt.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from '../../src/config/computerUseSettings.js'
import { __setSettingsPathForTest } from '../../src/config/settingsConfig.js'
import { isDomainAllowed, isUrlSchemeAllowed } from '../../src/core/computer/policy.js'
import { SessionManager, type BrowserSessionFactory } from '../../src/core/computer/sessionManager.js'
import {
  BrowserSessionError,
  type BrowserSession,
  type ComputerSessionId,
  type MouseButton,
  type NormalizedPoint,
  type ScreenshotResult,
  type StartSessionOptions,
} from '../../src/core/computer/types.js'
import type { AriaTreeSnapshot, BoundingBox } from '../../src/core/computer/ariaSnapshot.js'
import type { AtomAction, AtomEntry, AtomLocator } from '../../src/core/computer/atomResolver.js'
import type { SessionAtomCache } from '../../src/core/computer/selectorCache.js'
import { makeComputerUseSafetyCheck } from '../../src/core/permissions/computerSafetyChecks.js'
import type { PermissionOptions } from '../../src/core/permissions/types.js'
import { authorizeToolUse, executeToolUse } from '../../src/core/tools/runToolUse.js'
import { createToolUseContext } from '../../src/core/tools/context.js'
import { createToolRegistry } from '../../src/core/tools/registry.js'
import type { ToolResultAttachment } from '../../src/core/tools/types.js'
import { createStore, getDefaultAppState } from '../../src/core/state.js'
import type { ToolUseBlock } from '../../src/core/messages.js'
import { toolUseId } from '../../src/core/messages.js'
import { createComputerUseTools } from '../../src/tools/ComputerTools.js'

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='

const SAMPLE_ATTACHMENT: ToolResultAttachment = {
  type: 'image',
  mediaType: 'image/png',
  data: SAMPLE_PNG_BASE64,
  width: 1,
  height: 1,
  byteSize: Buffer.from(SAMPLE_PNG_BASE64, 'base64').byteLength,
  redacted: true,
}

class PolicyBrowserSession implements BrowserSession {
  readonly viewport = { width: 1024, height: 768, deviceScaleFactor: 1 }
  readonly displaySize = { width: 1024, height: 768 }
  readonly headless: boolean
  private _settings: ComputerUseSettings
  private readonly _options: StartSessionOptions
  private readonly _getSessionAllowedHosts: () => ReadonlySet<string>
  private _currentUrl: string | null = null
  private _closed = false

  constructor(
    readonly id: ComputerSessionId,
    settings: ComputerUseSettings,
    options: StartSessionOptions,
    getSessionAllowedHosts: () => ReadonlySet<string>,
  ) {
    this._settings = settings
    this._options = options
    this._getSessionAllowedHosts = getSessionAllowedHosts
    this.headless = options.headless ?? true
  }

  async navigate(url: string): Promise<void> {
    const scheme = isUrlSchemeAllowed(url, {
      allowHttpForTest: this._options.allowHttpForTest ?? false,
    })
    if (!scheme.allowed) {
      throw new BrowserSessionError('scheme_denied', `URL scheme is not permitted: ${url}`)
    }
    const domain = isDomainAllowed(
      url,
      {
        allowedDomains: this._settings.allowedDomains,
        deniedDomains: this._settings.deniedDomains,
      },
      {
        requireAllowlist: this._options.requireAllowlist ?? true,
        sessionAllowedHosts: this._getSessionAllowedHosts(),
      },
    )
    if (!domain.allowed) {
      throw new BrowserSessionError('domain_denied', `Domain is not permitted by policy: ${url}`)
    }
    this._currentUrl = url
  }

  async screenshot(): Promise<ScreenshotResult> {
    return {
      attachment: SAMPLE_ATTACHMENT,
      observation: { url: this._currentUrl ?? 'about:blank', title: 'test page' },
    }
  }
  async stabilize(): Promise<void> {}
  currentUrl(): string | null { return this._currentUrl }
  async currentTitle(): Promise<string | null> { return 'test page' }
  isClosed(): boolean { return this._closed }
  async close(): Promise<void> { this._closed = true }
  async click(_point: NormalizedPoint, _button: MouseButton): Promise<void> {}
  async doubleClick(_point: NormalizedPoint, _button: MouseButton): Promise<void> {}
  async typeText(_text: string): Promise<void> {}
  async pressKey(_key: string): Promise<void> {}
  async scroll(_point: NormalizedPoint | null, _deltaX: number, _deltaY: number): Promise<void> {}
  async drag(_from: NormalizedPoint, _to: NormalizedPoint): Promise<void> {}
  async ariaSnapshot(): Promise<AriaTreeSnapshot> { throw new Error('not exercised') }
  lastAriaSnapshot(): AriaTreeSnapshot | null { return null }
  async getSensitiveRegions(): Promise<readonly BoundingBox[]> { return [] }
  async exportStorageState(): Promise<unknown> { return {} }
  async actOnAtom(_locator: AtomLocator, _action: AtomAction): Promise<void> {}
  setAtomCache(_cache: SessionAtomCache): void {}
  lookupAtom(_atomId: string): AtomEntry | null { return null }
  currentAtomCache(): SessionAtomCache | null { return null }
  refreshSettings(next: ComputerUseSettings): void {
    this._settings = next
  }
}

function makeSettings(partial: Partial<ComputerUseSettings> = {}): ComputerUseSettings {
  return {
    ...defaultComputerUseSettings,
    enabled: true,
    verifyActions: false,
    viewport: { ...defaultComputerUseSettings.viewport },
    displaySize: { ...defaultComputerUseSettings.displaySize },
    maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
    ...partial,
  }
}

function makeToolUse(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId(`tu-${name}`), name, input }
}

describe('Computer-Use domain prompt integration', () => {
  let tmpDir: string
  let settingsPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ultron-domain-prompt-'))
    settingsPath = join(tmpDir, 'settings.json')
    __setSettingsPathForTest(settingsPath)
  })

  afterEach(() => {
    __setSettingsPathForTest(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('allow_by_rule for unknown navigate persists wildcard policy and later subdomain skips prompt', async () => {
    const settings = makeSettings({ allowedDomains: [] })
    const factory: BrowserSessionFactory = async (params) =>
      new PolicyBrowserSession(
        params.id,
        params.settings,
        params.options,
        params.getSessionAllowedHosts ?? (() => new Set()),
      )
    const sessionManager = new SessionManager({ settings, factory })
    const tools = createComputerUseTools({ sessionManager, settings })

    const registry = createToolRegistry()
    registry.register(tools.navigate)
    const ctx = createToolUseContext({
      appState: createStore(getDefaultAppState()),
      abortController: new AbortController(),
      messages: [],
      toolRegistry: registry,
    })

    const started = await sessionManager.start({}, ctx.abortController.signal)
    expect(started.id).toBeTruthy()

    let askCount = 0
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [makeComputerUseSafetyCheck({ sessionManager })],
      askUser: async (_toolName, _input, reason) => {
        askCount++
        expect(reason).toContain('www.youtube.com')
        expect(reason).toContain('not in computerUse.allowedDomains')
        return 'allow_by_rule'
      },
      approvedDomainHook: async ({ toolName, input, host, response }) => {
        if (toolName !== 'ComputerNavigate') return
        const sessionId = input.sessionId
        if (typeof sessionId !== 'string') return
        sessionManager.allowDomainForSession(sessionId as ComputerSessionId, host)
        if (response === 'allow_by_rule') {
          await sessionManager.persistAllowedDomain(host)
        }
      },
    }

    const first = makeToolUse('ComputerNavigate', {
      sessionId: started.id,
      url: 'https://www.youtube.com/',
    })
    const firstAuth = await authorizeToolUse(first, ctx, ctx.abortController.signal, opts)
    expect(firstAuth.outcome).toBe('authorized')
    expect(askCount).toBe(1)
    const firstResult = await executeToolUse(first, ctx, ctx.abortController.signal)
    expect(firstResult.isError).toBe(false)

    expect(sessionManager.getSettings().allowedDomains).toEqual(
      expect.arrayContaining(['youtube.com', '*.youtube.com']),
    )
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      computerUse?: { allowedDomains?: string[] }
    }
    expect(persisted.computerUse?.allowedDomains).toEqual(
      expect.arrayContaining(['youtube.com', '*.youtube.com']),
    )

    const second = makeToolUse('ComputerNavigate', {
      sessionId: started.id,
      url: 'https://m.youtube.com/',
    })
    const secondAuth = await authorizeToolUse(second, ctx, ctx.abortController.signal, opts)
    expect(secondAuth.outcome).toBe('authorized')
    expect(askCount).toBe(1)
    const secondResult = await executeToolUse(second, ctx, ctx.abortController.signal)
    expect(secondResult.isError).toBe(false)
  })
})
