import { describe, expect, it } from 'vitest'

import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from '../../config/computerUseSettings.js'

import { SessionManager, type BrowserSessionFactory } from './sessionManager.js'
import {
  BrowserSessionError,
  type BrowserSession,
  type ComputerSessionId,
  type ScreenshotResult,
} from './types.js'

class FakeBrowserSession implements BrowserSession {
  readonly id: ComputerSessionId
  readonly viewport = { width: 1024, height: 768, deviceScaleFactor: 1 }
  readonly displaySize = { width: 1024, height: 768 }
  closeCalls = 0
  navCalls = 0
  private _closed = false

  constructor(id: ComputerSessionId) {
    this.id = id
  }

  async navigate(_url: string, _signal: AbortSignal): Promise<void> {
    this.navCalls++
  }
  async screenshot(_signal: AbortSignal): Promise<ScreenshotResult> {
    throw new Error('not exercised in this test')
  }
  async stabilize(_signal: AbortSignal): Promise<void> {}
  currentUrl(): string | null {
    return null
  }
  async currentTitle(): Promise<string | null> {
    return null
  }
  isClosed(): boolean {
    return this._closed
  }
  async close(): Promise<void> {
    this.closeCalls++
    this._closed = true
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
    ...partial,
  }
}

function makeFactory(): BrowserSessionFactory & { sessions: FakeBrowserSession[] } {
  const sessions: FakeBrowserSession[] = []
  const factory: BrowserSessionFactory = async ({ id }) => {
    const s = new FakeBrowserSession(id)
    sessions.push(s)
    return s
  }
  return Object.assign(factory, { sessions })
}

describe('SessionManager', () => {
  it('start returns a session retrievable via get', async () => {
    const factory = makeFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    const session = await mgr.start({}, ac.signal)
    expect(mgr.get(session.id)).toBe(session)
  })

  it('stop closes the session and removes from registry', async () => {
    const factory = makeFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    const session = await mgr.start({}, ac.signal)
    await mgr.stop(session.id)
    expect((session as FakeBrowserSession).closeCalls).toBe(1)
    expect(mgr.get(session.id)).toBeUndefined()
  })

  it('rejects start when viewport !== displaySize', async () => {
    const factory = makeFactory()
    const settings = makeSettings({
      viewport: { width: 1280, height: 800 },
      displaySize: { width: 1024, height: 768 },
    })
    const mgr = new SessionManager({ settings, factory })
    const ac = new AbortController()
    await expect(mgr.start({}, ac.signal)).rejects.toMatchObject({
      kind: 'viewport_mismatch',
    })
  })

  it('rejects start with empty allowlist when requireAllowlist=true', async () => {
    const factory = makeFactory()
    const settings = makeSettings({ allowedDomains: [] })
    const mgr = new SessionManager({ settings, factory })
    const ac = new AbortController()
    await expect(mgr.start({}, ac.signal)).rejects.toMatchObject({
      kind: 'allowlist_empty',
    })
  })

  it('allows start with empty allowlist when requireAllowlist=false (test mode)', async () => {
    const factory = makeFactory()
    const settings = makeSettings({ allowedDomains: [] })
    const mgr = new SessionManager({ settings, factory })
    const ac = new AbortController()
    const session = await mgr.start({ requireAllowlist: false }, ac.signal)
    expect(session).toBeDefined()
    await mgr.stop(session.id)
  })

  it('rejects start when signal already aborted', async () => {
    const factory = makeFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    ac.abort()
    await expect(mgr.start({}, ac.signal)).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('signal abort triggers close', async () => {
    const factory = makeFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const ac = new AbortController()
    const session = await mgr.start({}, ac.signal)
    expect((session as FakeBrowserSession).closeCalls).toBe(0)
    ac.abort()
    // Allow the microtask to run.
    await new Promise((r) => setTimeout(r, 5))
    expect((session as FakeBrowserSession).closeCalls).toBe(1)
    expect(mgr.get(session.id)).toBeUndefined()
  })

  it('timeout triggers close', async () => {
    const factory = makeFactory()
    const mgr = new SessionManager({
      settings: makeSettings({ maxDurationMs: 50 }),
      factory,
    })
    const ac = new AbortController()
    const session = await mgr.start({}, ac.signal)
    await new Promise((r) => setTimeout(r, 80))
    expect((session as FakeBrowserSession).closeCalls).toBe(1)
    expect(mgr.get(session.id)).toBeUndefined()
  })

  it('concurrent stop + abort + timeout calls close exactly once', async () => {
    const factory = makeFactory()
    const mgr = new SessionManager({
      settings: makeSettings({ maxDurationMs: 30 }),
      factory,
    })
    const ac = new AbortController()
    const session = await mgr.start({}, ac.signal)
    const fakeSession = session as FakeBrowserSession
    // Fire all three close paths concurrently.
    const stopPromise = mgr.stop(session.id)
    ac.abort()
    await new Promise((r) => setTimeout(r, 50)) // let timeout fire
    await stopPromise
    expect(fakeSession.closeCalls).toBe(1)
    expect(mgr.get(session.id)).toBeUndefined()
  })

  it('stop after timeout is a no-op (close still 1)', async () => {
    const factory = makeFactory()
    const mgr = new SessionManager({
      settings: makeSettings({ maxDurationMs: 30 }),
      factory,
    })
    const ac = new AbortController()
    const session = await mgr.start({}, ac.signal)
    await new Promise((r) => setTimeout(r, 50))
    await mgr.stop(session.id) // should be no-op
    expect((session as FakeBrowserSession).closeCalls).toBe(1)
  })

  it('stopAll closes every live session', async () => {
    const factory = makeFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const a = await mgr.start({}, new AbortController().signal)
    const b = await mgr.start({}, new AbortController().signal)
    const c = await mgr.start({}, new AbortController().signal)
    await mgr.stopAll()
    expect((a as FakeBrowserSession).closeCalls).toBe(1)
    expect((b as FakeBrowserSession).closeCalls).toBe(1)
    expect((c as FakeBrowserSession).closeCalls).toBe(1)
    expect(mgr.get(a.id)).toBeUndefined()
    expect(mgr.get(b.id)).toBeUndefined()
    expect(mgr.get(c.id)).toBeUndefined()
  })

  it('factory error during start propagates', async () => {
    const failingFactory: BrowserSessionFactory = async () => {
      throw new BrowserSessionError('chromium_not_installed', 'install chromium')
    }
    const mgr = new SessionManager({ settings: makeSettings(), factory: failingFactory })
    const ac = new AbortController()
    await expect(mgr.start({}, ac.signal)).rejects.toMatchObject({
      kind: 'chromium_not_installed',
    })
  })

  it('listener accounting balances after stop', async () => {
    // Wrap signal.addEventListener / removeEventListener via Proxy to count.
    const ac = new AbortController()
    let added = 0
    let removed = 0
    const proxiedSignal = new Proxy(ac.signal, {
      get(target, prop) {
        if (prop === 'addEventListener') {
          return (...args: Parameters<typeof target.addEventListener>) => {
            added++
            return target.addEventListener(...args)
          }
        }
        if (prop === 'removeEventListener') {
          return (...args: Parameters<typeof target.removeEventListener>) => {
            removed++
            return target.removeEventListener(...args)
          }
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop as string | symbol]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }) as AbortSignal
    const factory = makeFactory()
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const session = await mgr.start({}, proxiedSignal)
    await mgr.stop(session.id)
    expect(added).toBeGreaterThanOrEqual(1)
    expect(added).toBe(removed)
  })
})
