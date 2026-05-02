/**
 * v3 Phase 3 unit tests for `createComputerUseTools`.
 *
 * Strategy: a `FakeBrowserSession` records every method invocation; a
 * `FakeSessionManager` returns it from `start`/`get`. No Playwright import on
 * the test path (the QueryEngine seam in Phase 3 keeps real Playwright lazy
 * behind dynamic import).
 */

import { describe, expect, it, vi } from 'vitest'

import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from '../config/computerUseSettings.js'
import type { AriaTreeSnapshot, BoundingBox } from '../core/computer/ariaSnapshot.js'
import {
  BrowserSessionError,
  type BrowserSession,
  type ComputerSessionId,
  type ComputerSessionManager,
  type MouseButton,
  type NormalizedPoint,
  type ScreenshotResult,
  type StartSessionOptions,
} from '../core/computer/types.js'
import type { ToolUseContext } from '../core/tools/context.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import { createToolRegistry } from '../core/tools/registry.js'
import type { ToolResultAttachment } from '../core/tools/types.js'

import {
  createComputerUseTools,
  mapBrowserSessionError,
  type ComputerUseTools,
} from './ComputerTools.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const SAMPLE_PNG_BASE64 =
  // 1x1 transparent PNG, valid IHDR — Phase 1's validateImageAttachment
  // accepts this so we can use it in attachment fixtures.
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='

const SAMPLE_ATTACHMENT: ToolResultAttachment = {
  type: 'image',
  mediaType: 'image/png',
  data: SAMPLE_PNG_BASE64,
  width: 1024,
  height: 768,
  byteSize: 200,
}

class FakeBrowserSession implements BrowserSession {
  readonly id: ComputerSessionId
  readonly viewport = { width: 1024, height: 768, deviceScaleFactor: 1 }
  readonly displaySize = { width: 1024, height: 768 }
  readonly headless: boolean
  closeCalls = 0
  navCalls: string[] = []
  clickCalls: Array<{ point: NormalizedPoint; button: MouseButton }> = []
  doubleClickCalls: Array<{ point: NormalizedPoint; button: MouseButton }> = []
  typeCalls: string[] = []
  pressCalls: string[] = []
  scrollCalls: Array<{ point: NormalizedPoint | null; deltaX: number; deltaY: number }> = []
  dragCalls: Array<{ from: NormalizedPoint; to: NormalizedPoint }> = []
  screenshotCalls = 0
  stabilizeCalls = 0
  private _closed = false
  // Optional override hooks for error-injection tests.
  screenshotImpl: ((signal: AbortSignal) => Promise<ScreenshotResult>) | null = null
  navigateImpl: ((url: string, signal: AbortSignal) => Promise<void>) | null = null
  clickImpl: ((point: NormalizedPoint, button: MouseButton, signal: AbortSignal) => Promise<void>) | null = null

  constructor(id: ComputerSessionId, headless = true) {
    this.id = id
    this.headless = headless
  }

  isClosed(): boolean {
    return this._closed
  }

  async close(): Promise<void> {
    this.closeCalls++
    this._closed = true
  }

  private _currentUrl: string | null = 'https://example.com/'
  currentUrl(): string | null {
    return this._currentUrl
  }
  setCurrentUrl(url: string | null): void {
    this._currentUrl = url
  }

  async currentTitle(): Promise<string | null> {
    return 'Example'
  }

  async navigate(url: string, signal: AbortSignal): Promise<void> {
    if (this.navigateImpl) {
      await this.navigateImpl(url, signal)
      return
    }
    if (signal.aborted) throw new BrowserSessionError('aborted', 'navigate aborted')
    this.navCalls.push(url)
  }

  async screenshot(signal: AbortSignal): Promise<ScreenshotResult> {
    if (this.screenshotImpl) return this.screenshotImpl(signal)
    if (signal.aborted) throw new BrowserSessionError('aborted', 'screenshot aborted')
    this.screenshotCalls++
    return {
      attachment: SAMPLE_ATTACHMENT,
      observation: { url: 'https://example.com/', title: 'Example' },
    }
  }

  async stabilize(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new BrowserSessionError('aborted', 'stabilize aborted')
    this.stabilizeCalls++
  }

  async click(point: NormalizedPoint, button: MouseButton, signal: AbortSignal): Promise<void> {
    if (this.clickImpl) {
      await this.clickImpl(point, button, signal)
      return
    }
    if (signal.aborted) throw new BrowserSessionError('aborted', 'click aborted')
    this.clickCalls.push({ point, button })
  }

  async doubleClick(point: NormalizedPoint, button: MouseButton, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new BrowserSessionError('aborted', 'doubleClick aborted')
    this.doubleClickCalls.push({ point, button })
  }

  async typeText(text: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new BrowserSessionError('aborted', 'typeText aborted')
    this.typeCalls.push(text)
  }

  async pressKey(key: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new BrowserSessionError('aborted', 'pressKey aborted')
    this.pressCalls.push(key)
  }

  async scroll(point: NormalizedPoint | null, deltaX: number, deltaY: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new BrowserSessionError('aborted', 'scroll aborted')
    this.scrollCalls.push({ point, deltaX, deltaY })
  }

  async drag(from: NormalizedPoint, to: NormalizedPoint, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new BrowserSessionError('aborted', 'drag aborted')
    this.dragCalls.push({ from, to })
  }

  // Phase 4·1 — minimal ARIA stubs so the fake satisfies the interface. Tests
  // that exercise ARIA inject a richer snapshot via `setLastAriaSnapshot` or
  // queue per-call snapshots via `queueAriaSnapshot` (Phase 4·2 verify tests).
  ariaSnapshotCalls = 0
  private _lastAriaSnapshot: AriaTreeSnapshot | null = null
  private _queuedAriaSnapshots: AriaTreeSnapshot[] = []

  async ariaSnapshot(signal: AbortSignal): Promise<AriaTreeSnapshot> {
    if (signal.aborted) throw new BrowserSessionError('aborted', 'ariaSnapshot aborted')
    this.ariaSnapshotCalls++
    const queued = this._queuedAriaSnapshots.shift()
    const snap: AriaTreeSnapshot =
      queued ??
      this._lastAriaSnapshot ?? {
        tree: { role: 'group', name: null, bbox: null, focused: false, disabled: false, children: [] },
        yaml: '- group',
        hash: '0000000000000000',
      }
    this._lastAriaSnapshot = snap
    return snap
  }

  lastAriaSnapshot(): AriaTreeSnapshot | null {
    return this._lastAriaSnapshot
  }

  setLastAriaSnapshot(snap: AriaTreeSnapshot | null): void {
    this._lastAriaSnapshot = snap
  }

  /**
   * Queue snapshots to be returned by successive `ariaSnapshot()` calls.
   * Phase 4·2 verify tests use this to simulate "page changed (or didn't)"
   * between pre-action and post-action captures.
   */
  queueAriaSnapshot(snap: AriaTreeSnapshot): void {
    this._queuedAriaSnapshots.push(snap)
  }

  // Phase 4·2 — sensitive-region detection. Tests inject regions via
  // `setSensitiveRegions`; default is an empty list so no redaction fires.
  getSensitiveRegionsCalls = 0
  private _sensitiveRegions: readonly BoundingBox[] = []
  async getSensitiveRegions(
    _extraSelectors: readonly string[],
    _signal: AbortSignal,
  ): Promise<readonly BoundingBox[]> {
    this.getSensitiveRegionsCalls++
    return this._sensitiveRegions
  }
  setSensitiveRegions(regions: readonly BoundingBox[]): void {
    this._sensitiveRegions = regions
  }

  // Phase 4·3 — storage-state snapshot. Tests configure via
  // `setExportedStorageState`; default is an empty object so the handoff
  // tool's persistence path can run without crashing in unit tests.
  exportStorageStateCalls = 0
  private _exportedStorageState: unknown = {}
  async exportStorageState(_signal: AbortSignal): Promise<unknown> {
    this.exportStorageStateCalls++
    return this._exportedStorageState
  }
  setExportedStorageState(state: unknown): void {
    this._exportedStorageState = state
  }
}

class FakeSessionManager implements ComputerSessionManager {
  readonly sessions = new Map<ComputerSessionId, FakeBrowserSession>()
  startCalls: StartSessionOptions[] = []
  stopCalls: ComputerSessionId[] = []
  stopAllCalls = 0
  startImpl: ((opts: StartSessionOptions, signal: AbortSignal) => Promise<BrowserSession>) | null = null

  async start(opts: StartSessionOptions, signal: AbortSignal): Promise<BrowserSession> {
    this.startCalls.push(opts)
    if (this.startImpl) return this.startImpl(opts, signal)
    if (signal.aborted) throw new BrowserSessionError('aborted', 'start aborted')
    const id = `sess-${this.sessions.size + 1}` as ComputerSessionId
    const headless = opts.headless ?? true
    const s = new FakeBrowserSession(id, headless)
    this.sessions.set(id, s)
    return s
  }

  get(id: ComputerSessionId): BrowserSession | undefined {
    return this.sessions.get(id)
  }

  async stop(id: ComputerSessionId): Promise<void> {
    this.stopCalls.push(id)
    const s = this.sessions.get(id)
    if (s) {
      await s.close()
      this.sessions.delete(id)
    }
  }

  async stopAll(): Promise<void> {
    this.stopAllCalls++
    for (const s of this.sessions.values()) await s.close()
    this.sessions.clear()
  }

  async requestClose(id: ComputerSessionId, _reason: 'aborted' | 'timeout' | 'error'): Promise<void> {
    await this.stop(id)
  }
}

function makeSettings(partial: Partial<ComputerUseSettings> = {}): ComputerUseSettings {
  return {
    ...defaultComputerUseSettings,
    viewport: { ...defaultComputerUseSettings.viewport },
    displaySize: { ...defaultComputerUseSettings.displaySize },
    maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
    allowedDomains: ['example.com'],
    deniedDomains: [],
    enabled: true,
    ...partial,
  }
}

function makeContext(): ToolUseContext {
  const appState = createStore(getDefaultAppState())
  const abortController = new AbortController()
  return {
    appState,
    abortController,
    messages: [],
    readFileState: new Map(),
    toolRegistry: createToolRegistry(),
  }
}

async function setupWithStartedSession(
  settingsPartial: Partial<ComputerUseSettings> = {},
): Promise<{
  tools: ComputerUseTools
  manager: FakeSessionManager
  session: FakeBrowserSession
  context: ToolUseContext
}> {
  const manager = new FakeSessionManager()
  const settings = makeSettings(settingsPartial)
  const tools = createComputerUseTools({ sessionManager: manager, settings })
  const ctx = makeContext()
  const startResult = await tools.start.call({}, ctx, ctx.abortController.signal)
  expect(startResult.isError).toBe(false)
  const sessionId = startResult.content.replace('sessionId: ', '') as ComputerSessionId
  const session = manager.sessions.get(sessionId)
  expect(session).toBeDefined()
  return { tools, manager, session: session!, context: ctx }
}

// ---------------------------------------------------------------------------
// Factory shape
// ---------------------------------------------------------------------------

describe('createComputerUseTools — factory shape', () => {
  it('returns 11 tools with the expected names', () => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings(),
    })
    const names = [
      tools.start.name,
      tools.observe.name,
      tools.navigate.name,
      tools.click.name,
      tools.type.name,
      tools.key.name,
      tools.scroll.name,
      tools.drag.name,
      tools.wait.name,
      tools.handoffToUser.name,
      tools.stop.name,
    ]
    expect(names).toEqual([
      'ComputerStart',
      'ComputerObserve',
      'ComputerNavigate',
      'ComputerClick',
      'ComputerType',
      'ComputerKey',
      'ComputerScroll',
      'ComputerDrag',
      'ComputerWait',
      'ComputerHandoffToUser',
      'ComputerStop',
    ])
  })

  it('every tool is non-concurrency-safe', () => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings(),
    })
    const all: import('../core/tools/types.js').Tool[] = [
      tools.start, tools.observe, tools.navigate, tools.click, tools.type,
      tools.key, tools.scroll, tools.drag, tools.wait, tools.handoffToUser,
      tools.stop,
    ]
    for (const t of all) {
      expect(t.isConcurrencySafe?.({})).toBe(false)
    }
  })

  it('mutation flags match the design table', () => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings(),
    })
    // Read-only: Observe, Wait. Mutating: everything else, including Stop and Scroll.
    expect(tools.observe.isReadOnly).toBe(true)
    expect(tools.wait.isReadOnly).toBe(true)
    expect(tools.observe.isMutating).toBe(false)
    expect(tools.wait.isMutating).toBe(false)
    for (const t of [tools.start, tools.navigate, tools.click, tools.type, tools.key, tools.scroll, tools.drag, tools.handoffToUser, tools.stop]) {
      expect(t.isReadOnly).toBe(false)
      expect(t.isMutating).toBe(true)
    }
  })

  it('ComputerNavigate exposes getDomain', () => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings(),
    })
    expect(tools.navigate.getDomain?.({ url: 'https://example.com/path' })).toBe('example.com')
    expect(tools.navigate.getDomain?.({ url: 'not a url' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// mapBrowserSessionError
// ---------------------------------------------------------------------------

describe('mapBrowserSessionError', () => {
  const cases: Array<{ kind: string; expected: string }> = [
    { kind: 'aborted', expected: 'aborted' },
    { kind: 'session_closed', expected: 'execution_error' },
    { kind: 'domain_denied', expected: 'permission_denied' },
    { kind: 'scheme_denied', expected: 'permission_denied' },
    { kind: 'allowlist_empty', expected: 'permission_denied' },
    { kind: 'chromium_not_installed', expected: 'execution_error' },
    { kind: 'navigation_failed', expected: 'execution_error' },
    { kind: 'screenshot_failed', expected: 'execution_error' },
    { kind: 'screenshot_oversized', expected: 'execution_error' },
    { kind: 'interaction_failed', expected: 'execution_error' },
    { kind: 'timeout', expected: 'execution_error' },
    { kind: 'viewport_mismatch', expected: 'execution_error' },
  ]
  it.each(cases)('maps kind=$kind to errorKind=$expected', ({ kind, expected }) => {
    const err = new BrowserSessionError(kind as 'aborted', `${kind} message`)
    const r = mapBrowserSessionError(err)
    expect(r.isError).toBe(true)
    expect(r.errorKind).toBe(expected)
  })

  it('maps unknown errors to execution_error', () => {
    const r = mapBrowserSessionError(new Error('boom'))
    expect(r.errorKind).toBe('execution_error')
  })
})

// ---------------------------------------------------------------------------
// ComputerStart
// ---------------------------------------------------------------------------

describe('ComputerStart', () => {
  it('start with default options returns a sessionId and forwards headless=true', async () => {
    const manager = new FakeSessionManager()
    const tools = createComputerUseTools({ sessionManager: manager, settings: makeSettings() })
    const ctx = makeContext()
    const r = await tools.start.call({}, ctx, ctx.abortController.signal)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/^sessionId: sess-/)
    expect(manager.startCalls).toEqual([{ headless: true }])
  })

  it('rejects non-boolean headless via validateInput', async () => {
    const manager = new FakeSessionManager()
    const tools = createComputerUseTools({ sessionManager: manager, settings: makeSettings() })
    const ctx = makeContext()
    const v = await tools.start.validateInput({ headless: 'yes' }, ctx)
    expect(v.valid).toBe(false)
  })

  it('does not accept allowedDomainsOverride in input schema', () => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings(),
    })
    expect(tools.start.inputSchema.properties).toBeDefined()
    expect(tools.start.inputSchema.properties?.allowedDomainsOverride).toBeUndefined()
  })

  it('returns aborted when start throws BrowserSessionError(aborted)', async () => {
    const manager = new FakeSessionManager()
    manager.startImpl = async () => {
      throw new BrowserSessionError('aborted', 'start aborted')
    }
    const tools = createComputerUseTools({ sessionManager: manager, settings: makeSettings() })
    const ctx = makeContext()
    const r = await tools.start.call({}, ctx, ctx.abortController.signal)
    expect(r.errorKind).toBe('aborted')
  })

  it('maps chromium_not_installed to execution_error', async () => {
    const manager = new FakeSessionManager()
    manager.startImpl = async () => {
      throw new BrowserSessionError(
        'chromium_not_installed',
        'Chromium is not installed. Run: npx playwright install chromium',
      )
    }
    const tools = createComputerUseTools({ sessionManager: manager, settings: makeSettings() })
    const ctx = makeContext()
    const r = await tools.start.call({}, ctx, ctx.abortController.signal)
    expect(r.errorKind).toBe('execution_error')
    expect(r.content).toContain('npx playwright install chromium')
  })

  // -------------------------------------------------------------------------
  // Phase 4·3 — initialUrl + storageState rehydration
  // -------------------------------------------------------------------------
  describe('initialUrl rehydration (Phase 4·3)', () => {
    it('rejects non-HTTPS initialUrl via validateInput', async () => {
      const manager = new FakeSessionManager()
      const tools = createComputerUseTools({ sessionManager: manager, settings: makeSettings() })
      const ctx = makeContext()
      const v = await tools.start.validateInput(
        { initialUrl: 'http://example.com' },
        ctx,
      )
      expect(v.valid).toBe(false)
      expect(v.valid === false && v.message).toMatch(/HTTPS/)
    })

    it('rejects non-string initialUrl via validateInput', async () => {
      const manager = new FakeSessionManager()
      const tools = createComputerUseTools({ sessionManager: manager, settings: makeSettings() })
      const ctx = makeContext()
      const v = await tools.start.validateInput({ initialUrl: 42 }, ctx)
      expect(v.valid).toBe(false)
    })

    it('rejects unparseable initialUrl via validateInput', async () => {
      const manager = new FakeSessionManager()
      const tools = createComputerUseTools({ sessionManager: manager, settings: makeSettings() })
      const ctx = makeContext()
      const v = await tools.start.validateInput({ initialUrl: 'not a url' }, ctx)
      expect(v.valid).toBe(false)
    })

    it('rejects initialUrl with userinfo via validateInput (review fix #2)', async () => {
      const manager = new FakeSessionManager()
      const tools = createComputerUseTools({ sessionManager: manager, settings: makeSettings() })
      const ctx = makeContext()
      const v = await tools.start.validateInput(
        { initialUrl: 'https://user:pass@example.com/' },
        ctx,
      )
      expect(v.valid).toBe(false)
      expect(v.valid === false && v.message).toMatch(/userinfo/i)
    })

    it('does NOT load storageState when persistProfiles is false', async () => {
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { __setStoragePathForTest, writeStorageState } = await import(
        '../core/computer/storageStateStore.js'
      )
      const dir = mkdtempSync(join(tmpdir(), 'ultron-ct-test-'))
      __setStoragePathForTest(dir)
      try {
        await writeStorageState('example.com', { cookies: [{ name: 'c', value: 'v' }] })

        const manager = new FakeSessionManager()
        const tools = createComputerUseTools({
          sessionManager: manager,
          settings: makeSettings({ persistProfiles: false }),
        })
        const ctx = makeContext()
        const r = await tools.start.call(
          { initialUrl: 'https://example.com/' },
          ctx,
          ctx.abortController.signal,
        )
        expect(r.isError).toBe(false)
        expect(manager.startCalls[0]).toEqual({ headless: true })
        expect(manager.startCalls[0]?.storageState).toBeUndefined()
      } finally {
        __setStoragePathForTest(null)
      }
    })

    it('loads storageState when persistProfiles=true and host is on allowlist', async () => {
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { __setStoragePathForTest, writeStorageState } = await import(
        '../core/computer/storageStateStore.js'
      )
      const dir = mkdtempSync(join(tmpdir(), 'ultron-ct-test-'))
      __setStoragePathForTest(dir)
      try {
        const stored = { cookies: [{ name: 'session', value: 'abc' }], origins: [] }
        await writeStorageState('example.com', stored)

        const manager = new FakeSessionManager()
        const tools = createComputerUseTools({
          sessionManager: manager,
          settings: makeSettings({ persistProfiles: true, allowedDomains: ['example.com'] }),
        })
        const ctx = makeContext()
        const r = await tools.start.call(
          { initialUrl: 'https://example.com/' },
          ctx,
          ctx.abortController.signal,
        )
        expect(r.isError).toBe(false)
        expect(manager.startCalls[0]?.storageState).toEqual(stored)
      } finally {
        __setStoragePathForTest(null)
      }
    })

    it('skips rehydration + warns when initialUrl host is NOT on allowlist', async () => {
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { __setStoragePathForTest, writeStorageState } = await import(
        '../core/computer/storageStateStore.js'
      )
      const dir = mkdtempSync(join(tmpdir(), 'ultron-ct-test-'))
      __setStoragePathForTest(dir)
      try {
        await writeStorageState('blocked.example.com', { cookies: [{ name: 'leaked', value: 'x' }] })

        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        const manager = new FakeSessionManager()
        const tools = createComputerUseTools({
          sessionManager: manager,
          settings: makeSettings({
            persistProfiles: true,
            allowedDomains: ['example.com'], // does NOT include blocked.example.com
          }),
        })
        const ctx = makeContext()
        const r = await tools.start.call(
          { initialUrl: 'https://blocked.example.com/' },
          ctx,
          ctx.abortController.signal,
        )
        expect(r.isError).toBe(false)
        expect(manager.startCalls[0]?.storageState).toBeUndefined()
        // Warn line emitted so the user notices the policy/setting mismatch.
        const warnings = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((s) => s.includes('not on the allowlist'))
        expect(warnings.length).toBeGreaterThan(0)
        stderrSpy.mockRestore()
      } finally {
        __setStoragePathForTest(null)
      }
    })

    it('passes no storageState when no snapshot exists for the host', async () => {
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { __setStoragePathForTest } = await import(
        '../core/computer/storageStateStore.js'
      )
      const dir = mkdtempSync(join(tmpdir(), 'ultron-ct-test-'))
      __setStoragePathForTest(dir)
      try {
        const manager = new FakeSessionManager()
        const tools = createComputerUseTools({
          sessionManager: manager,
          settings: makeSettings({ persistProfiles: true, allowedDomains: ['example.com'] }),
        })
        const ctx = makeContext()
        const r = await tools.start.call(
          { initialUrl: 'https://example.com/' },
          ctx,
          ctx.abortController.signal,
        )
        expect(r.isError).toBe(false)
        expect(manager.startCalls[0]?.storageState).toBeUndefined()
      } finally {
        __setStoragePathForTest(null)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// ComputerObserve
// ---------------------------------------------------------------------------

describe('ComputerObserve', () => {
  it('returns text + image attachment', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const r = await tools.observe.call(
      { sessionId: session.id },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(r.attachments?.length).toBe(1)
    expect(r.attachments?.[0]?.type).toBe('image')
    expect(r.content).toContain('observe')
    expect(r.content).toContain('https://example.com/')
  })

  it('opportunistically captures ARIA so the next SafetyCheck has cached structure (Phase 4·1 fix #1)', async () => {
    // Without this, the synchronous safety check on a later ComputerClick would
    // see lastAriaSnapshot() === null and fall back to level 1 — i.e., the
    // dangerous-click prompt would never fire end-to-end. observeAndPack
    // calls session.ariaSnapshot() best-effort precisely to prime the cache.
    const { tools, session, context } = await setupWithStartedSession()
    expect(session.ariaSnapshotCalls).toBe(0)
    await tools.observe.call(
      { sessionId: session.id },
      context,
      context.abortController.signal,
    )
    expect(session.ariaSnapshotCalls).toBeGreaterThan(0)
  })

  it('still succeeds when ariaSnapshot throws — capture is best-effort', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    // Override ariaSnapshot to throw; observe must still return the screenshot.
    const origAriaSnapshot = session.ariaSnapshot.bind(session)
    void origAriaSnapshot
    session.ariaSnapshot = async (_signal: AbortSignal) => {
      throw new BrowserSessionError('interaction_failed', 'aria broke')
    }
    const r = await tools.observe.call(
      { sessionId: session.id },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(r.attachments?.length).toBe(1)
  })

  it('rejects missing sessionId via validateInput', async () => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings(),
    })
    const ctx = makeContext()
    const v = await tools.observe.validateInput({}, ctx)
    expect(v.valid).toBe(false)
  })

  it('returns validation_failed for unknown sessionId', async () => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings(),
    })
    const ctx = makeContext()
    const r = await tools.observe.call(
      { sessionId: 'no-such-session' },
      ctx,
      ctx.abortController.signal,
    )
    expect(r.errorKind).toBe('validation_failed')
  })

  it('returns execution_error when session is closed', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    await session.close()
    const r = await tools.observe.call(
      { sessionId: session.id },
      context,
      context.abortController.signal,
    )
    expect(r.errorKind).toBe('execution_error')
  })

  it('returns aborted when screenshot throws BrowserSessionError(aborted)', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    session.screenshotImpl = async () => {
      throw new BrowserSessionError('aborted', 'mid-call abort')
    }
    const r = await tools.observe.call(
      { sessionId: session.id },
      context,
      context.abortController.signal,
    )
    expect(r.errorKind).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// ComputerNavigate
// ---------------------------------------------------------------------------

describe('ComputerNavigate', () => {
  it('navigates and returns post-action observation with image attachment', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const r = await tools.navigate.call(
      { sessionId: session.id, url: 'https://example.com/page' },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(session.navCalls).toEqual(['https://example.com/page'])
    expect(session.stabilizeCalls).toBe(1)
    expect(r.attachments?.length).toBe(1)
  })

  it('rejects malformed URL via validateInput', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.navigate.validateInput(
      { sessionId: session.id, url: 'not a url' },
      context,
    )
    expect(v.valid).toBe(false)
  })

  it('returns permission_denied when navigate throws domain_denied', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    session.navigateImpl = async () => {
      throw new BrowserSessionError('domain_denied', 'denied', 'denied.com')
    }
    const r = await tools.navigate.call(
      { sessionId: session.id, url: 'https://denied.com/' },
      context,
      context.abortController.signal,
    )
    expect(r.errorKind).toBe('permission_denied')
  })

  it('checkPermissions returns allow (lets allow rules + safety checks at later cascade steps run)', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const decision = await tools.navigate.checkPermissions(
      { sessionId: session.id, url: 'https://example.com/' },
      context,
    )
    expect(decision.behavior).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// ComputerClick
// ---------------------------------------------------------------------------

describe('ComputerClick', () => {
  it('clicks at the right point with default left button', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const r = await tools.click.call(
      { sessionId: session.id, x: 0.5, y: 0.5 },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(session.clickCalls).toEqual([{ point: { x: 0.5, y: 0.5 }, button: 'left' }])
    expect(r.attachments?.length).toBe(1)
  })

  it('forwards button=middle', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    await tools.click.call(
      { sessionId: session.id, x: 0.25, y: 0.75, button: 'middle' },
      context,
      context.abortController.signal,
    )
    expect(session.clickCalls[0]?.button).toBe('middle')
  })

  it('routes to doubleClick when double=true', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    await tools.click.call(
      { sessionId: session.id, x: 0.5, y: 0.5, double: true },
      context,
      context.abortController.signal,
    )
    expect(session.clickCalls).toEqual([])
    expect(session.doubleClickCalls.length).toBe(1)
  })

  it.each([
    { in: { x: -0.1, y: 0.5 }, why: 'x < 0' },
    { in: { x: 1.1, y: 0.5 }, why: 'x > 1' },
    { in: { x: NaN, y: 0.5 }, why: 'NaN' },
    { in: { x: 0.5, y: 'a' as unknown }, why: 'wrong type' },
  ])('rejects malformed point: $why', async ({ in: pt }) => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.click.validateInput(
      { sessionId: session.id, ...pt },
      context,
    )
    expect(v.valid).toBe(false)
  })

  it('rejects bad button', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.click.validateInput(
      { sessionId: session.id, x: 0.5, y: 0.5, button: 'fourth' },
      context,
    )
    expect(v.valid).toBe(false)
  })

  it('returns aborted when click throws BrowserSessionError(aborted)', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    session.clickImpl = async () => {
      throw new BrowserSessionError('aborted', 'mid-call abort')
    }
    const r = await tools.click.call(
      { sessionId: session.id, x: 0.5, y: 0.5 },
      context,
      context.abortController.signal,
    )
    expect(r.errorKind).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// ComputerType
// ---------------------------------------------------------------------------

describe('ComputerType', () => {
  it('types text into focused element', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const r = await tools.type.call(
      { sessionId: session.id, text: 'hello' },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(session.typeCalls).toEqual(['hello'])
  })

  it('rejects text > 1024 bytes', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.type.validateInput(
      { sessionId: session.id, text: 'a'.repeat(1025) },
      context,
    )
    expect(v.valid).toBe(false)
  })

  it('rejects disallowed control chars (NUL)', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.type.validateInput(
      { sessionId: session.id, text: 'foo\x00bar' },
      context,
    )
    expect(v.valid).toBe(false)
  })

  it('allows tab/newline/CR', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.type.validateInput(
      { sessionId: session.id, text: 'line1\nline2\tcol\r' },
      context,
    )
    expect(v.valid).toBe(true)
  })

  it('annotates summary as <redacted ...> when sensitive=true', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const r = await tools.type.call(
      { sessionId: session.id, text: 'p4ss', sensitive: true },
      context,
      context.abortController.signal,
    )
    expect(r.content).toContain('redacted')
    expect(r.content).not.toContain('p4ss')
  })
})

// ---------------------------------------------------------------------------
// ComputerKey
// ---------------------------------------------------------------------------

describe('ComputerKey', () => {
  it.each(['Enter', 'Tab', 'Escape', 'ArrowLeft', 'PageDown'])('accepts %s', async (key) => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.key.validateInput({ sessionId: session.id, key }, context)
    expect(v.valid).toBe(true)
  })

  it.each(['Control+A', 'ControlOrMeta+C', 'Shift+Tab', 'Alt+ArrowLeft', 'Control+Shift+T'])(
    'accepts chord %s',
    async (key) => {
      const { tools, session, context } = await setupWithStartedSession()
      const v = await tools.key.validateInput({ sessionId: session.id, key }, context)
      expect(v.valid).toBe(true)
    },
  )

  it.each(['F1', 'CapsLock', 'Insert', 'a', 'Control+Insert'])('rejects %s', async (key) => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.key.validateInput({ sessionId: session.id, key }, context)
    expect(v.valid).toBe(false)
  })

  it('forwards the key to pressKey and returns observation', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const r = await tools.key.call(
      { sessionId: session.id, key: 'Enter' },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(session.pressCalls).toEqual(['Enter'])
  })
})

// ---------------------------------------------------------------------------
// ComputerScroll
// ---------------------------------------------------------------------------

describe('ComputerScroll', () => {
  it('page-level scroll passes null point', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    await tools.scroll.call(
      { sessionId: session.id, deltaX: 0, deltaY: 250 },
      context,
      context.abortController.signal,
    )
    expect(session.scrollCalls).toEqual([{ point: null, deltaX: 0, deltaY: 250 }])
  })

  it('point-anchored scroll forwards the point', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    await tools.scroll.call(
      { sessionId: session.id, x: 0.5, y: 0.5, deltaX: 100, deltaY: 0 },
      context,
      context.abortController.signal,
    )
    expect(session.scrollCalls[0]?.point).toEqual({ x: 0.5, y: 0.5 })
  })

  it('rejects mismatched x/y (one without the other)', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.scroll.validateInput(
      { sessionId: session.id, x: 0.5, deltaX: 0, deltaY: 100 },
      context,
    )
    expect(v.valid).toBe(false)
  })

  it('rejects non-finite deltaX/deltaY', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.scroll.validateInput(
      { sessionId: session.id, deltaX: 0, deltaY: Infinity },
      context,
    )
    expect(v.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ComputerDrag
// ---------------------------------------------------------------------------

describe('ComputerDrag', () => {
  it('drags from -> to with both points', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    await tools.drag.call(
      { sessionId: session.id, fromX: 0.1, fromY: 0.2, toX: 0.8, toY: 0.9 },
      context,
      context.abortController.signal,
    )
    expect(session.dragCalls).toEqual([
      { from: { x: 0.1, y: 0.2 }, to: { x: 0.8, y: 0.9 } },
    ])
  })

  it('rejects out-of-range fromX', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.drag.validateInput(
      { sessionId: session.id, fromX: 2, fromY: 0, toX: 1, toY: 1 },
      context,
    )
    expect(v.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ComputerWait
// ---------------------------------------------------------------------------

describe('ComputerWait', () => {
  it('waits for the requested ms', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const start = Date.now()
    const r = await tools.wait.call(
      { sessionId: session.id, ms: 50 },
      context,
      context.abortController.signal,
    )
    const elapsed = Date.now() - start
    expect(r.isError).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })

  it('returns aborted when the signal flips during wait', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const ac = new AbortController()
    const p = tools.wait.call({ sessionId: session.id, ms: 5000 }, context, ac.signal)
    setTimeout(() => ac.abort(), 20)
    const r = await p
    expect(r.errorKind).toBe('aborted')
  })

  it('rejects ms > 10000', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.wait.validateInput(
      { sessionId: session.id, ms: 10_001 },
      context,
    )
    expect(v.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ComputerHandoffToUser
// ---------------------------------------------------------------------------

describe('ComputerHandoffToUser', () => {
  it('denies when allowAuthHandoff is false (default)', async () => {
    const { tools, session, context } = await setupWithStartedSession({
      allowAuthHandoff: false,
    })
    const decision = await tools.handoffToUser.checkPermissions(
      { sessionId: session.id, message: 'log in please' },
      context,
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.behavior === 'deny' && decision.message).toMatch(/Handoff disabled/)
  })

  it('denies when session is headless even if allowAuthHandoff=true', async () => {
    // Default FakeSessionManager creates a headless session.
    const { tools, session, context } = await setupWithStartedSession({
      allowAuthHandoff: true,
    })
    expect(session.headless).toBe(true)
    const decision = await tools.handoffToUser.checkPermissions(
      { sessionId: session.id, message: 'log in please' },
      context,
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.behavior === 'deny' && decision.message).toMatch(/headed/)
  })

  it('asks via cascade when allowAuthHandoff=true and session is headed', async () => {
    const manager = new FakeSessionManager()
    const settings = makeSettings({ allowAuthHandoff: true })
    const tools = createComputerUseTools({ sessionManager: manager, settings })
    const ctx = makeContext()
    // Manually start a HEADED session.
    const startResult = await tools.start.call(
      { headless: false },
      ctx,
      ctx.abortController.signal,
    )
    const sessionId = startResult.content.replace('sessionId: ', '') as ComputerSessionId
    const session = manager.sessions.get(sessionId)!
    expect(session.headless).toBe(false)
    const decision = await tools.handoffToUser.checkPermissions(
      { sessionId, message: 'finish login' },
      ctx,
    )
    expect(decision.behavior).toBe('ask')
    expect(decision.behavior === 'ask' && decision.message).toBe('finish login')
  })

  it('denies when session is unknown', async () => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings({ allowAuthHandoff: true }),
    })
    const ctx = makeContext()
    const decision = await tools.handoffToUser.checkPermissions(
      { sessionId: 'no-session', message: 'hi' },
      ctx,
    )
    expect(decision.behavior).toBe('deny')
  })

  it('call() returns post-handoff observation (assumes prompt was approved)', async () => {
    const manager = new FakeSessionManager()
    const settings = makeSettings({ allowAuthHandoff: true })
    const tools = createComputerUseTools({ sessionManager: manager, settings })
    const ctx = makeContext()
    const startResult = await tools.start.call(
      { headless: false },
      ctx,
      ctx.abortController.signal,
    )
    const sessionId = startResult.content.replace('sessionId: ', '') as ComputerSessionId
    const r = await tools.handoffToUser.call(
      { sessionId, message: 'done' },
      ctx,
      ctx.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(r.attachments?.length).toBe(1)
    expect(r.content).toContain('handoff resumed')
  })

  // -------------------------------------------------------------------------
  // Phase 4·3 — storageState snapshot on resume
  // -------------------------------------------------------------------------
  describe('storageState snapshot on resume (Phase 4·3)', () => {
    it('writes storageState when persistProfiles=true AND allowAuthHandoff=true', async () => {
      const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { __setStoragePathForTest } = await import(
        '../core/computer/storageStateStore.js'
      )
      const dir = mkdtempSync(join(tmpdir(), 'ultron-handoff-test-'))
      __setStoragePathForTest(dir)
      try {
        const manager = new FakeSessionManager()
        const tools = createComputerUseTools({
          sessionManager: manager,
          settings: makeSettings({ allowAuthHandoff: true, persistProfiles: true }),
        })
        const ctx = makeContext()
        const startResult = await tools.start.call(
          { headless: false },
          ctx,
          ctx.abortController.signal,
        )
        const sessionId = startResult.content.replace('sessionId: ', '') as ComputerSessionId
        const session = manager.sessions.get(sessionId)!
        // Configure the fake to return a recognizable storageState payload.
        const stateToWrite = { cookies: [{ name: 'login', value: 'yes' }], origins: [] }
        session.setExportedStorageState(stateToWrite)

        const before = session.exportStorageStateCalls
        const r = await tools.handoffToUser.call(
          { sessionId, message: 'done' },
          ctx,
          ctx.abortController.signal,
        )
        expect(r.isError).toBe(false)
        expect(session.exportStorageStateCalls).toBe(before + 1)

        // Confirm a file was actually written under the test storage dir.
        const files = readdirSync(dir)
        expect(files.length).toBe(1)
        const written = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'))
        expect(written).toEqual(stateToWrite)
      } finally {
        __setStoragePathForTest(null)
      }
    })

    it('does NOT write storageState when persistProfiles=false', async () => {
      const { mkdtempSync, readdirSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { __setStoragePathForTest } = await import(
        '../core/computer/storageStateStore.js'
      )
      const dir = mkdtempSync(join(tmpdir(), 'ultron-handoff-test-'))
      __setStoragePathForTest(dir)
      try {
        const manager = new FakeSessionManager()
        const tools = createComputerUseTools({
          sessionManager: manager,
          settings: makeSettings({ allowAuthHandoff: true, persistProfiles: false }),
        })
        const ctx = makeContext()
        const startResult = await tools.start.call(
          { headless: false },
          ctx,
          ctx.abortController.signal,
        )
        const sessionId = startResult.content.replace('sessionId: ', '') as ComputerSessionId
        const session = manager.sessions.get(sessionId)!

        const r = await tools.handoffToUser.call(
          { sessionId, message: 'done' },
          ctx,
          ctx.abortController.signal,
        )
        expect(r.isError).toBe(false)
        expect(session.exportStorageStateCalls).toBe(0)
        expect(readdirSync(dir).length).toBe(0)
      } finally {
        __setStoragePathForTest(null)
      }
    })

    it('skips snapshot when session.currentUrl() returns null (no host to key on)', async () => {
      const { mkdtempSync, readdirSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { __setStoragePathForTest } = await import(
        '../core/computer/storageStateStore.js'
      )
      const dir = mkdtempSync(join(tmpdir(), 'ultron-handoff-test-'))
      __setStoragePathForTest(dir)
      try {
        const manager = new FakeSessionManager()
        const tools = createComputerUseTools({
          sessionManager: manager,
          settings: makeSettings({ allowAuthHandoff: true, persistProfiles: true }),
        })
        const ctx = makeContext()
        const startResult = await tools.start.call(
          { headless: false },
          ctx,
          ctx.abortController.signal,
        )
        const sessionId = startResult.content.replace('sessionId: ', '') as ComputerSessionId
        const session = manager.sessions.get(sessionId)!
        // Override currentUrl to return null (e.g., session never navigated).
        session.setCurrentUrl(null)

        const r = await tools.handoffToUser.call(
          { sessionId, message: 'done' },
          ctx,
          ctx.abortController.signal,
        )
        expect(r.isError).toBe(false)
        expect(session.exportStorageStateCalls).toBe(0)
        expect(readdirSync(dir).length).toBe(0)
      } finally {
        __setStoragePathForTest(null)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// ComputerStop
// ---------------------------------------------------------------------------

describe('ComputerStop', () => {
  it('stops a session and returns confirmation', async () => {
    const { tools, manager, session, context } = await setupWithStartedSession()
    const r = await tools.stop.call(
      { sessionId: session.id },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(manager.stopCalls).toEqual([session.id])
    expect(session.closeCalls).toBe(1)
  })

  it('rejects empty sessionId via validateInput', async () => {
    const { tools, context } = await setupWithStartedSession()
    const v = await tools.stop.validateInput({ sessionId: '' }, context)
    expect(v.valid).toBe(false)
  })

  it('rejects unknown sessionId via validateInput (truthful — not a misleading "stopped: bogus" success)', async () => {
    const { tools, context } = await setupWithStartedSession()
    const v = await tools.stop.validateInput({ sessionId: 'no-such-session' }, context)
    expect(v.valid).toBe(false)
  })

  it('returns aborted when the signal is already aborted', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const ac = new AbortController()
    ac.abort()
    const r = await tools.stop.call({ sessionId: session.id }, context, ac.signal)
    expect(r.errorKind).toBe('aborted')
  })

  it('does NOT define getDomain (cleanup, no per-host scope)', () => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings(),
    })
    expect(tools.stop.getDomain).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Phase 3 review fixes — validation-time existence checks + getDomain scoping
// ---------------------------------------------------------------------------

describe('Phase 3 review fixes — validateInput rejects unknown/closed sessions', () => {
  const sessionBoundToolNames = [
    'observe', 'navigate', 'click', 'type', 'key', 'scroll', 'drag', 'wait', 'handoffToUser', 'stop',
  ] as const

  it.each(sessionBoundToolNames)('%s rejects an unknown sessionId via validateInput', async (toolKey) => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings({ allowAuthHandoff: true }),
    })
    const ctx = makeContext()
    // Build minimum-viable input for each tool so the unknown-session check is
    // the only rejection reason left.
    const baseInput: Record<string, Record<string, unknown>> = {
      observe: { sessionId: 'unknown' },
      navigate: { sessionId: 'unknown', url: 'https://example.com/' },
      click: { sessionId: 'unknown', x: 0.5, y: 0.5 },
      type: { sessionId: 'unknown', text: 'x' },
      key: { sessionId: 'unknown', key: 'Enter' },
      scroll: { sessionId: 'unknown', deltaX: 0, deltaY: 100 },
      drag: { sessionId: 'unknown', fromX: 0, fromY: 0, toX: 1, toY: 1 },
      wait: { sessionId: 'unknown', ms: 10 },
      handoffToUser: { sessionId: 'unknown', message: 'hi' },
      stop: { sessionId: 'unknown' },
    }
    const v = await tools[toolKey].validateInput(baseInput[toolKey]!, ctx)
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.message).toMatch(/unknown sessionId/)
  })

  it.each(sessionBoundToolNames)('%s rejects a closed sessionId via validateInput', async (toolKey) => {
    const { tools, session, context } = await setupWithStartedSession({ allowAuthHandoff: true })
    await session.close()
    const baseInput: Record<string, Record<string, unknown>> = {
      observe: { sessionId: session.id },
      navigate: { sessionId: session.id, url: 'https://example.com/' },
      click: { sessionId: session.id, x: 0.5, y: 0.5 },
      type: { sessionId: session.id, text: 'x' },
      key: { sessionId: session.id, key: 'Enter' },
      scroll: { sessionId: session.id, deltaX: 0, deltaY: 100 },
      drag: { sessionId: session.id, fromX: 0, fromY: 0, toX: 1, toY: 1 },
      wait: { sessionId: session.id, ms: 10 },
      handoffToUser: { sessionId: session.id, message: 'hi' },
      stop: { sessionId: session.id },
    }
    const v = await tools[toolKey].validateInput(baseInput[toolKey]!, context)
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.message).toMatch(/closed/)
  })
})

describe('Phase 3 review fixes — session-bound getDomain', () => {
  const actionToolNames = ['click', 'type', 'key', 'scroll', 'drag', 'handoffToUser'] as const

  it.each(actionToolNames)('%s defines getDomain (so allow_by_rule scopes to current host)', (toolKey) => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings({ allowAuthHandoff: true }),
    })
    expect(tools[toolKey].getDomain).toBeDefined()
  })

  it.each(actionToolNames)('%s.getDomain resolves the session\'s current URL host', async (toolKey) => {
    const { tools, session } = await setupWithStartedSession({ allowAuthHandoff: true })
    // FakeBrowserSession.currentUrl() returns 'https://example.com/'
    expect(session.currentUrl()).toBe('https://example.com/')
    expect(tools[toolKey].getDomain?.({ sessionId: session.id })).toBe('example.com')
  })

  it.each(actionToolNames)('%s.getDomain returns undefined for unknown session (forces buildAllowByRule to refuse over-broad rule)', (toolKey) => {
    const tools = createComputerUseTools({
      sessionManager: new FakeSessionManager(),
      settings: makeSettings({ allowAuthHandoff: true }),
    })
    expect(tools[toolKey].getDomain?.({ sessionId: 'no-such' })).toBeUndefined()
  })
})

describe('Phase 3 review fixes — ComputerNavigate HTTPS-only validation', () => {
  it.each([
    'http://example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'ftp://example.com/',
  ])('rejects non-https URL %s', async (url) => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.navigate.validateInput(
      { sessionId: session.id, url },
      context,
    )
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.message).toMatch(/HTTPS/i)
  })

  it('accepts https: URL', async () => {
    const { tools, session, context } = await setupWithStartedSession()
    const v = await tools.navigate.validateInput(
      { sessionId: session.id, url: 'https://example.com/path' },
      context,
    )
    expect(v.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Phase 4·2 — runActionAndObserve verify wiring
// ---------------------------------------------------------------------------

describe('runActionAndObserve — verify wiring (Phase 4·2)', () => {
  function makeSnap(hash: string): AriaTreeSnapshot {
    return {
      tree: { role: 'group', name: null, bbox: null, focused: false, disabled: false, children: [] },
      yaml: '- group',
      hash,
    }
  }

  it('appends WARNING when both ARIA and screenshot agree the page did not change', async () => {
    const { tools, session, context } = await setupWithStartedSession({
      verifyActions: true,
    })
    // Force every ariaSnapshot() call to return the same hash so the verify
    // signal reports "unchanged."
    session.queueAriaSnapshot(makeSnap('aaaa'))
    session.queueAriaSnapshot(makeSnap('aaaa'))

    const r = await tools.click.call(
      { sessionId: session.id, x: 0.5, y: 0.5 },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(r.content).toContain('WARNING')
    expect(r.content).toContain('verification did not detect a page change')
  })

  it('does NOT append WARNING when ARIA hash changes between pre and post', async () => {
    const { tools, session, context } = await setupWithStartedSession({
      verifyActions: true,
    })
    session.queueAriaSnapshot(makeSnap('before-hash'))
    session.queueAriaSnapshot(makeSnap('after-hash')) // different — verify says changed

    const r = await tools.click.call(
      { sessionId: session.id, x: 0.5, y: 0.5 },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(r.content).not.toContain('WARNING')
  })

  it('verifyActions=false skips pre-action capture but STILL primes the cache for the next SafetyCheck', async () => {
    const { tools, session, context } = await setupWithStartedSession({
      verifyActions: false,
    })
    expect(session.ariaSnapshotCalls).toBe(0)
    const r = await tools.click.call(
      { sessionId: session.id, x: 0.5, y: 0.5 },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(r.content).not.toContain('WARNING')
    // Exactly one ariaSnapshot call: the post-action cache prime. No pre-action capture.
    expect(session.ariaSnapshotCalls).toBe(1)
  })

  it('verifyActions=true makes at least 2 ariaSnapshot calls (pre + post)', async () => {
    const { tools, session, context } = await setupWithStartedSession({
      verifyActions: true,
    })
    expect(session.ariaSnapshotCalls).toBe(0)
    await tools.click.call(
      { sessionId: session.id, x: 0.5, y: 0.5 },
      context,
      context.abortController.signal,
    )
    // Pre-action ARIA + post-action ARIA = 2 (the default ComputerObserve
    // doesn't run on this path).
    expect(session.ariaSnapshotCalls).toBeGreaterThanOrEqual(2)
  })

  it('still ships the screenshot attachment even when WARNING is appended', async () => {
    const { tools, session, context } = await setupWithStartedSession({
      verifyActions: true,
    })
    session.queueAriaSnapshot(makeSnap('same'))
    session.queueAriaSnapshot(makeSnap('same'))
    const r = await tools.click.call(
      { sessionId: session.id, x: 0.5, y: 0.5 },
      context,
      context.abortController.signal,
    )
    expect(r.attachments?.length).toBe(1)
    expect(r.attachments?.[0]?.type).toBe('image')
  })

  it('verifyActions wiring works for ComputerType too (regression: not just clicks)', async () => {
    const { tools, session, context } = await setupWithStartedSession({
      verifyActions: true,
    })
    session.queueAriaSnapshot(makeSnap('same'))
    session.queueAriaSnapshot(makeSnap('same'))
    const r = await tools.type.call(
      { sessionId: session.id, text: 'hello' },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(r.content).toContain('WARNING')
  })

  it('aborts in post-action ARIA capture propagate (fix #8 — never silently swallowed)', async () => {
    // Without fix #8, a user-initiated abort during the post-action ARIA
    // capture would be eaten and the action would appear successful.
    const { tools, session, context } = await setupWithStartedSession({
      verifyActions: false, // disable pre-action capture so only post-action ARIA fires
    })
    // Override ariaSnapshot to simulate an abort mid-capture. We can't use
    // the test seam because the real post-ARIA path runs AFTER the action.
    let calls = 0
    session.ariaSnapshot = async () => {
      calls++
      throw new BrowserSessionError('aborted', 'simulated user abort')
    }
    await expect(
      tools.click.call(
        { sessionId: session.id, x: 0.5, y: 0.5 },
        context,
        context.abortController.signal,
      ),
    ).resolves.toMatchObject({ errorKind: 'aborted' })
    // mapBrowserSessionError wraps the propagated abort as errorKind 'aborted'.
    expect(calls).toBe(1)
  })

  it('non-abort ARIA failures are still swallowed (best-effort verification preserved)', async () => {
    const { tools, session, context } = await setupWithStartedSession({
      verifyActions: false,
    })
    session.ariaSnapshot = async () => {
      throw new BrowserSessionError('interaction_failed', 'evaluate broke')
    }
    // Action still succeeds — non-abort ARIA failure is best-effort.
    const r = await tools.click.call(
      { sessionId: session.id, x: 0.5, y: 0.5 },
      context,
      context.abortController.signal,
    )
    expect(r.isError).toBe(false)
    expect(r.content).not.toContain('WARNING')
  })
})
