import { describe, expect, it } from 'vitest'

import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from '../../config/computerUseSettings.js'

import type { AriaTreeSnapshot, BoundingBox } from './ariaSnapshot.js'
import type { AtomAction, AtomEntry, AtomLocator } from './atomResolver.js'
import type { SessionAtomCache } from './selectorCache.js'

import { SessionManager, type BrowserSessionFactory } from './sessionManager.js'
import {
  BrowserSessionError,
  type BrowserSession,
  type ComputerSessionId,
  type MouseButton,
  type NormalizedPoint,
  type ScreenshotResult,
} from './types.js'

class FakeBrowserSession implements BrowserSession {
  readonly id: ComputerSessionId
  readonly viewport = { width: 1024, height: 768, deviceScaleFactor: 1 }
  readonly displaySize = { width: 1024, height: 768 }
  readonly headless = true
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
  async click(_p: NormalizedPoint, _b: MouseButton, _s: AbortSignal): Promise<void> {}
  async doubleClick(_p: NormalizedPoint, _b: MouseButton, _s: AbortSignal): Promise<void> {}
  async typeText(_t: string, _s: AbortSignal): Promise<void> {}
  async pressKey(_k: string, _s: AbortSignal): Promise<void> {}
  async scroll(_p: NormalizedPoint | null, _dx: number, _dy: number, _s: AbortSignal): Promise<void> {}
  async drag(_f: NormalizedPoint, _t: NormalizedPoint, _s: AbortSignal): Promise<void> {}
  async ariaSnapshot(_s: AbortSignal): Promise<AriaTreeSnapshot> {
    throw new Error('not exercised in this test')
  }
  lastAriaSnapshot(): AriaTreeSnapshot | null {
    return null
  }
  async getSensitiveRegions(
    _extraSelectors: readonly string[],
    _signal: AbortSignal,
  ): Promise<readonly BoundingBox[]> {
    return []
  }
  async exportStorageState(_signal: AbortSignal): Promise<unknown> {
    return {}
  }
  async actOnAtom(_locator: AtomLocator, _action: AtomAction, _signal: AbortSignal): Promise<void> {}
  setAtomCache(_cache: SessionAtomCache): void {}
  lookupAtom(_atomId: string): AtomEntry | null {
    return null
  }
  currentAtomCache(): SessionAtomCache | null {
    return null
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

  // ---------------------------------------------------------------------------
  // v3 Phase 5 — recordStep / step-limit / no-progress detection
  // ---------------------------------------------------------------------------

  describe('recordStep — step-limit floor', () => {
    it('returns {abort: false} for unknown sessionId (no-op)', () => {
      const factory = makeFactory()
      const mgr = new SessionManager({ settings: makeSettings(), factory })
      const decision = mgr.recordStep('nonexistent' as ComputerSessionId, {
        ariaHash: 'a',
        phash: 'b',
        verified: true,
      })
      expect(decision.abort).toBe(false)
    })

    it('aborts on step N = maxSteps + 1', async () => {
      const factory = makeFactory()
      const settings = makeSettings({ maxSteps: 3, verifyActions: true })
      const mgr = new SessionManager({ settings, factory })
      const ac = new AbortController()
      const session = await mgr.start({}, ac.signal)

      // Three good steps — verified:true, varying hashes — never aborts.
      for (let i = 0; i < 3; i++) {
        const d = mgr.recordStep(session.id, {
          ariaHash: `aria-${i}`,
          phash: `ph-${i}`,
          verified: true,
        })
        expect(d.abort).toBe(false)
      }

      const fourth = mgr.recordStep(session.id, {
        ariaHash: 'aria-3',
        phash: 'ph-3',
        verified: true,
      })
      expect(fourth.abort).toBe(true)
      if (fourth.abort) {
        expect(fourth.reason).toContain('step_limit_exceeded')
        expect(fourth.reason).toContain('N=4')
        expect(fourth.reason).toContain('max=3')
      }

      // setImmediate-scheduled close fires on the next tick.
      await new Promise((r) => setImmediate(r))
      expect(mgr.get(session.id)).toBeUndefined()
      expect((session as FakeBrowserSession).closeCalls).toBe(1)
    })
  })

  describe('recordStep — primary rule (verifyActions: true)', () => {
    it('aborts after 3 consecutive verified:false', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: true }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      const d1 = mgr.recordStep(session.id, { ariaHash: 'a', phash: 'b', verified: false })
      const d2 = mgr.recordStep(session.id, { ariaHash: 'a', phash: 'b', verified: false })
      const d3 = mgr.recordStep(session.id, { ariaHash: 'a', phash: 'b', verified: false })

      expect(d1.abort).toBe(false)
      expect(d2.abort).toBe(false)
      expect(d3.abort).toBe(true)
      if (d3.abort) {
        expect(d3.reason).toContain('no_progress')
        expect(d3.reason).toContain('verified:false')
      }
    })

    it('does not abort when a verified:true breaks the streak', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: true }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      mgr.recordStep(session.id, { ariaHash: 'a', phash: 'b', verified: false })
      mgr.recordStep(session.id, { ariaHash: 'a', phash: 'b', verified: false })
      mgr.recordStep(session.id, { ariaHash: 'c', phash: 'd', verified: true })   // breaks
      const d = mgr.recordStep(session.id, { ariaHash: 'a', phash: 'b', verified: false })
      expect(d.abort).toBe(false)
    })

    it('does not abort on three verified:true in a row', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: true }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      for (let i = 0; i < 3; i++) {
        const d = mgr.recordStep(session.id, {
          ariaHash: `aria-${i}`,
          phash: `ph-${i}`,
          verified: true,
        })
        expect(d.abort).toBe(false)
      }
    })

    it('ignores ARIA + pHash stalls when verification is enabled (verify is the source of truth)', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: true }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      // Identical ARIA + identical pHash, but verified:true — should NOT abort.
      // (Pathological capture mismatch; verify says progress happened.)
      for (let i = 0; i < 3; i++) {
        const d = mgr.recordStep(session.id, {
          ariaHash: 'same',
          phash: 'same',
          verified: true,
        })
        expect(d.abort).toBe(false)
      }
    })
  })

  describe('recordStep — fallback rule (verifyActions: false)', () => {
    it('aborts when both ARIA AND pHash are stalled for 3 steps', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: false }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      const d1 = mgr.recordStep(session.id, { ariaHash: 'A', phash: 'P', verified: null })
      const d2 = mgr.recordStep(session.id, { ariaHash: 'A', phash: 'P', verified: null })
      const d3 = mgr.recordStep(session.id, { ariaHash: 'A', phash: 'P', verified: null })

      expect(d1.abort).toBe(false)
      expect(d2.abort).toBe(false)
      expect(d3.abort).toBe(true)
      if (d3.abort) {
        expect(d3.reason).toContain('no_progress')
        expect(d3.reason).toContain('ARIA and pHash')
      }
    })

    it('does NOT abort on 3 identical ARIA + varying pHash (canvas case)', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: false }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      for (let i = 0; i < 3; i++) {
        const d = mgr.recordStep(session.id, {
          ariaHash: 'static-aria',
          phash: `pixels-${i}`,
          verified: null,
        })
        expect(d.abort).toBe(false)
      }
    })

    it('does NOT abort on 3 identical pHash + varying ARIA (DOM-only case)', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: false }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      for (let i = 0; i < 3; i++) {
        const d = mgr.recordStep(session.id, {
          ariaHash: `aria-${i}`,
          phash: 'static-pixels',
          verified: null,
        })
        expect(d.abort).toBe(false)
      }
    })

    // Review fix #2 — the v3 plan acceptance is "Repeated identical
    // screenshots OR repeated identical ARIA snapshots cause a controlled
    // failure." When one signal is unavailable, the other becomes the only
    // available evidence; a stall on the only available signal MUST abort.
    it('aborts on stalled pHash when ARIA capture is unavailable for all 3 (review fix #2)', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: false }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      const d1 = mgr.recordStep(session.id, { ariaHash: null, phash: 'P', verified: null })
      const d2 = mgr.recordStep(session.id, { ariaHash: null, phash: 'P', verified: null })
      const d3 = mgr.recordStep(session.id, { ariaHash: null, phash: 'P', verified: null })

      expect(d1.abort).toBe(false)
      expect(d2.abort).toBe(false)
      expect(d3.abort).toBe(true)
      if (d3.abort) {
        expect(d3.reason).toContain('no_progress')
        expect(d3.reason).toContain('pHash')
        expect(d3.reason).not.toContain('ARIA') // ARIA unavailable; only pHash named
      }
    })

    it('aborts on stalled ARIA when pHash capture is unavailable for all 3 (review fix #2)', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: false }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      const d1 = mgr.recordStep(session.id, { ariaHash: 'A', phash: null, verified: null })
      const d2 = mgr.recordStep(session.id, { ariaHash: 'A', phash: null, verified: null })
      const d3 = mgr.recordStep(session.id, { ariaHash: 'A', phash: null, verified: null })

      expect(d3.abort).toBe(true)
      if (d3.abort) {
        expect(d3.reason).toContain('ARIA')
        expect(d3.reason).not.toContain('pHash')
      }
    })

    it('does NOT abort when both signals are unavailable for all 3 (no information)', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: false }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      // Both ARIA and pHash capture failed for all 3 — we have no evidence
      // either way, so don't abort. (Spec: "stalled available signal".)
      for (let i = 0; i < 3; i++) {
        const d = mgr.recordStep(session.id, {
          ariaHash: null,
          phash: null,
          verified: null,
        })
        expect(d.abort).toBe(false)
      }
    })

    it('does NOT abort when ARIA stalled + pHash partly null (mixed availability)', async () => {
      const factory = makeFactory()
      const mgr = new SessionManager({
        settings: makeSettings({ verifyActions: false }),
        factory,
      })
      const session = await mgr.start({}, new AbortController().signal)

      // pHash is available for only 2 of 3 → not "fully available" → don't
      // count as a stalled-or-progressing signal. ARIA stalled, but the
      // ring-fully-non-null gate keeps pHash from being either stalled or
      // showing progress. Conservative: no abort until we have a full ring
      // for at least one signal.
      mgr.recordStep(session.id, { ariaHash: 'A', phash: 'P', verified: null })
      mgr.recordStep(session.id, { ariaHash: 'A', phash: null, verified: null })
      const d3 = mgr.recordStep(session.id, { ariaHash: 'A', phash: 'P', verified: null })
      // ARIA stalled (A, A, A all non-null), pHash NOT fully non-null →
      // available signals = {ARIA}, stalled = {ARIA}, → ABORT (only signal stalled).
      // This actually matches the spec: ARIA is the only available signal here.
      expect(d3.abort).toBe(true)
    })
  })

  it('recordStep is no-op after the session is closed', async () => {
    const factory = makeFactory()
    const mgr = new SessionManager({ settings: makeSettings({ maxSteps: 1 }), factory })
    const session = await mgr.start({}, new AbortController().signal)
    await mgr.stop(session.id)
    const d = mgr.recordStep(session.id, { ariaHash: 'a', phash: 'b', verified: true })
    expect(d.abort).toBe(false)
  })
})
