/**
 * v3 Phase 6 — `getSessionMetrics` + `recordScreenshot` + two-map storage.
 *
 * Covers:
 * - Live counters for an open session (closedAt/durationMs/closeReason null).
 * - Frozen snapshot for a closed session (populated lifetime markers, snapshot
 *   survives the `_sessions.delete(id)` inside `closeOnce`).
 * - Distinct close reasons map cleanly through stop/abort/timeout/requestClose.
 * - `recordScreenshot` increments live counters; no-op for unknown / closed
 *   sessions; the byte total accumulates exactly what's passed in.
 * - `getSessionMetrics(unknown)` returns null.
 */

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

class FakeSession implements BrowserSession {
  readonly id: ComputerSessionId
  readonly viewport = { width: 1024, height: 768, deviceScaleFactor: 1 }
  readonly displaySize = { width: 1024, height: 768 }
  readonly headless = true
  private _closed = false

  constructor(id: ComputerSessionId) {
    this.id = id
  }

  async navigate(_url: string, _signal: AbortSignal): Promise<void> {}
  async screenshot(_signal: AbortSignal): Promise<ScreenshotResult> {
    throw new Error('not exercised')
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
    this._closed = true
  }
  async click(_p: NormalizedPoint, _b: MouseButton, _s: AbortSignal): Promise<void> {}
  async doubleClick(_p: NormalizedPoint, _b: MouseButton, _s: AbortSignal): Promise<void> {}
  async typeText(_t: string, _s: AbortSignal): Promise<void> {}
  async pressKey(_k: string, _s: AbortSignal): Promise<void> {}
  async scroll(_p: NormalizedPoint | null, _dx: number, _dy: number, _s: AbortSignal): Promise<void> {}
  async drag(_f: NormalizedPoint, _t: NormalizedPoint, _s: AbortSignal): Promise<void> {}
  async ariaSnapshot(_s: AbortSignal): Promise<AriaTreeSnapshot> {
    throw new Error('not exercised')
  }
  lastAriaSnapshot(): AriaTreeSnapshot | null {
    return null
  }
  async getSensitiveRegions(
    _e: readonly string[],
    _s: AbortSignal,
  ): Promise<readonly BoundingBox[]> {
    return []
  }
  async exportStorageState(_s: AbortSignal): Promise<unknown> {
    return {}
  }
  async actOnAtom(_l: AtomLocator, _a: AtomAction, _s: AbortSignal): Promise<void> {}
  setAtomCache(_c: SessionAtomCache): void {}
  lookupAtom(_id: string): AtomEntry | null {
    return null
  }
  currentAtomCache(): SessionAtomCache | null {
    return null
  }
  refreshSettings(_next: ComputerUseSettings): void {}
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

function makeFactory(): BrowserSessionFactory {
  return async ({ id }) => new FakeSession(id)
}

describe('getSessionMetrics — live session', () => {
  it('returns zeroed counters and null lifetime markers immediately after start', async () => {
    const mgr = new SessionManager({ settings: makeSettings(), factory: makeFactory() })
    const session = await mgr.start({}, new AbortController().signal)
    const metrics = mgr.getSessionMetrics(session.id)
    expect(metrics).not.toBeNull()
    expect(metrics!.stepCount).toBe(0)
    expect(metrics!.screenshotCount).toBe(0)
    expect(metrics!.screenshotBytesTotal).toBe(0)
    expect(metrics!.closedAt).toBeNull()
    expect(metrics!.durationMs).toBeNull()
    expect(metrics!.closeReason).toBeNull()
    expect(metrics!.startedAt).toBeGreaterThan(0)
    await mgr.stop(session.id)
  })

  it('reflects recordStep + recordScreenshot on the live session', async () => {
    const mgr = new SessionManager({
      settings: makeSettings({ maxSteps: 100 }),
      factory: makeFactory(),
    })
    const session = await mgr.start({}, new AbortController().signal)

    mgr.recordStep(session.id, { ariaHash: 'a', phash: 'b', verified: true })
    mgr.recordStep(session.id, { ariaHash: 'c', phash: 'd', verified: true })
    mgr.recordScreenshot(session.id, 1024)
    mgr.recordScreenshot(session.id, 2048)

    const metrics = mgr.getSessionMetrics(session.id)
    expect(metrics).not.toBeNull()
    expect(metrics!.stepCount).toBe(2)
    expect(metrics!.screenshotCount).toBe(2)
    expect(metrics!.screenshotBytesTotal).toBe(3072)
    expect(metrics!.closeReason).toBeNull()

    await mgr.stop(session.id)
  })
})

describe('getSessionMetrics — closed session (snapshot survives close)', () => {
  it('snapshots on stop with closeReason = "stop"', async () => {
    const mgr = new SessionManager({ settings: makeSettings(), factory: makeFactory() })
    const session = await mgr.start({}, new AbortController().signal)
    mgr.recordScreenshot(session.id, 500)
    await mgr.stop(session.id)
    const metrics = mgr.getSessionMetrics(session.id)
    expect(metrics).not.toBeNull()
    expect(metrics!.closeReason).toBe('stop')
    expect(metrics!.closedAt).not.toBeNull()
    expect(metrics!.durationMs).not.toBeNull()
    expect(metrics!.durationMs!).toBeGreaterThanOrEqual(0)
    expect(metrics!.screenshotCount).toBe(1)
    expect(metrics!.screenshotBytesTotal).toBe(500)
  })

  it('snapshots on abort with closeReason = "aborted"', async () => {
    const mgr = new SessionManager({ settings: makeSettings(), factory: makeFactory() })
    const ac = new AbortController()
    const session = await mgr.start({}, ac.signal)
    ac.abort()
    // Allow microtask scheduling.
    await new Promise((r) => setTimeout(r, 5))
    const metrics = mgr.getSessionMetrics(session.id)
    expect(metrics).not.toBeNull()
    expect(metrics!.closeReason).toBe('aborted')
  })

  it('snapshots on timeout with closeReason = "timeout"', async () => {
    const mgr = new SessionManager({
      settings: makeSettings({ maxDurationMs: 30 }),
      factory: makeFactory(),
    })
    const session = await mgr.start({}, new AbortController().signal)
    await new Promise((r) => setTimeout(r, 60))
    const metrics = mgr.getSessionMetrics(session.id)
    expect(metrics).not.toBeNull()
    expect(metrics!.closeReason).toBe('timeout')
  })

  it('snapshots on requestClose("error") with closeReason = "error"', async () => {
    const mgr = new SessionManager({ settings: makeSettings(), factory: makeFactory() })
    const session = await mgr.start({}, new AbortController().signal)
    await mgr.requestClose(session.id, 'error')
    const metrics = mgr.getSessionMetrics(session.id)
    expect(metrics).not.toBeNull()
    expect(metrics!.closeReason).toBe('error')
  })

  it('frozen snapshot persists after the entry is deleted from _sessions', async () => {
    const mgr = new SessionManager({ settings: makeSettings(), factory: makeFactory() })
    const session = await mgr.start({}, new AbortController().signal)
    mgr.recordScreenshot(session.id, 1234)
    mgr.recordStep(session.id, { ariaHash: 'a', phash: 'b', verified: true })
    await mgr.stop(session.id)
    // The live session is gone…
    expect(mgr.get(session.id)).toBeUndefined()
    // …but metrics still resolve.
    const metrics = mgr.getSessionMetrics(session.id)
    expect(metrics).not.toBeNull()
    expect(metrics!.stepCount).toBe(1)
    expect(metrics!.screenshotBytesTotal).toBe(1234)
  })
})

describe('recordScreenshot edge cases', () => {
  it('is a no-op for an unknown sessionId', async () => {
    const mgr = new SessionManager({ settings: makeSettings(), factory: makeFactory() })
    expect(() =>
      mgr.recordScreenshot('does-not-exist' as ComputerSessionId, 100),
    ).not.toThrow()
    expect(mgr.getSessionMetrics('does-not-exist' as ComputerSessionId)).toBeNull()
  })

  it('is a no-op for a closed session (counters frozen at snapshot time)', async () => {
    const mgr = new SessionManager({ settings: makeSettings(), factory: makeFactory() })
    const session = await mgr.start({}, new AbortController().signal)
    mgr.recordScreenshot(session.id, 100)
    await mgr.stop(session.id)
    // Post-close call must not mutate the frozen snapshot.
    mgr.recordScreenshot(session.id, 9999)
    const metrics = mgr.getSessionMetrics(session.id)
    expect(metrics).not.toBeNull()
    expect(metrics!.screenshotCount).toBe(1)
    expect(metrics!.screenshotBytesTotal).toBe(100)
  })
})

describe('getSessionMetrics — unknown id', () => {
  it('returns null for an id that was never started', () => {
    const mgr = new SessionManager({ settings: makeSettings(), factory: makeFactory() })
    expect(mgr.getSessionMetrics('never-existed' as ComputerSessionId)).toBeNull()
  })
})

describe('factory receives recordScreenshot callback', () => {
  it('the factory params include a fire-and-forget recordScreenshot bound to the session id', async () => {
    let captured: ((bytes: number) => void) | null = null
    const factory: BrowserSessionFactory = async ({ id, recordScreenshot }) => {
      captured = recordScreenshot
      return new FakeSession(id)
    }
    const mgr = new SessionManager({ settings: makeSettings(), factory })
    const session = await mgr.start({}, new AbortController().signal)
    expect(captured).not.toBeNull()
    // The callback is pre-bound to the session id; calling it accumulates on
    // the live session.
    captured!(777)
    captured!(223)
    const metrics = mgr.getSessionMetrics(session.id)
    expect(metrics!.screenshotCount).toBe(2)
    expect(metrics!.screenshotBytesTotal).toBe(1000)
    await mgr.stop(session.id)
  })
})

// Silence unused-import warnings from the BrowserSessionError type even when
// no test exercises it directly — keeps the file's import surface stable as
// the suite grows.
void BrowserSessionError
