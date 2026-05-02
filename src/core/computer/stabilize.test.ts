import { describe, expect, it, vi } from 'vitest'

import {
  stabilize,
  type StabilizePage,
  type StabilizePageWithAria,
} from './stabilize.js'
import { BrowserSessionError } from './types.js'

function createFakePage(behavior: {
  domContentLoaded: () => Promise<void>
  load: () => Promise<void>
}): StabilizePage {
  return {
    async waitForLoadState(state, _opts) {
      if (state === 'domcontentloaded') return behavior.domContentLoaded()
      return behavior.load()
    },
  }
}

describe('stabilize', () => {
  it('resolves after domcontentloaded + animation debounce when load also resolves', async () => {
    const page = createFakePage({
      domContentLoaded: async () => {},
      load: async () => {},
    })
    const ac = new AbortController()
    const start = Date.now()
    await stabilize(page, ac.signal, { animationDebounceMs: 50 })
    const elapsed = Date.now() - start
    // Allow a small margin; debounce should be at least 50ms.
    expect(elapsed).toBeGreaterThanOrEqual(45)
  })

  it('continues even if `load` times out (best-effort)', async () => {
    const page = createFakePage({
      domContentLoaded: async () => {},
      load: () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('TimeoutError: page.waitForLoadState load')), 30)
        }),
    })
    const ac = new AbortController()
    await stabilize(page, ac.signal, {
      animationDebounceMs: 20,
      loadOpportunisticTimeoutMs: 30,
    })
  })

  it('rejects with aborted if signal already aborted at entry', async () => {
    const page = createFakePage({
      domContentLoaded: async () => {},
      load: async () => {},
    })
    const ac = new AbortController()
    ac.abort()
    await expect(stabilize(page, ac.signal)).rejects.toBeInstanceOf(BrowserSessionError)
  })

  it('rejects with aborted if signal aborts during domcontentloaded wait', async () => {
    const page = createFakePage({
      domContentLoaded: () => new Promise(() => {}), // never resolves
      load: async () => {},
    })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    await expect(stabilize(page, ac.signal)).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('rejects with aborted if signal aborts during animation debounce', async () => {
    const page = createFakePage({
      domContentLoaded: async () => {},
      load: async () => {},
    })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    await expect(
      stabilize(page, ac.signal, { animationDebounceMs: 1000 }),
    ).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('propagates non-abort errors from waitForLoadState(domcontentloaded)', async () => {
    const page = createFakePage({
      domContentLoaded: async () => {
        throw new Error('navigation interrupted')
      },
      load: async () => {},
    })
    const ac = new AbortController()
    await expect(stabilize(page, ac.signal)).rejects.toThrow(/navigation interrupted/)
  })

  it('removes abort listener when domcontentloaded resolves successfully', async () => {
    // Spy on add/removeEventListener to confirm listener accounting is balanced.
    const ac = new AbortController()
    const realSignal = ac.signal
    let added = 0
    let removed = 0
    const spy = new Proxy(realSignal, {
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
    const page = createFakePage({
      domContentLoaded: async () => {},
      load: async () => {},
    })
    await stabilize(page, spy, { animationDebounceMs: 1 })
    // 3 raceAbort/sleepAbortable calls each register and remove a listener.
    expect(added).toBeGreaterThanOrEqual(2)
    expect(added).toBe(removed)
  })

  // -------------------------------------------------------------------------
  // Phase 4·2 — step 5 (ARIA convergence)
  // -------------------------------------------------------------------------

  describe('step 5: ARIA convergence (Phase 4·2)', () => {
    function withAria(
      hashes: string[],
    ): StabilizePageWithAria & { getHashCalls: () => number } {
      let i = 0
      let calls = 0
      const hashFn = async (_signal: AbortSignal): Promise<string> => {
        const h = hashes[Math.min(i, hashes.length - 1)]!
        i++
        calls++
        return h
      }
      return {
        async waitForLoadState() {},
        ariaSnapshotHash: hashFn,
        getHashCalls: () => calls,
      }
    }

    it('exits after two equal ARIA samples', async () => {
      const page = withAria(['h1', 'h1'])
      const ac = new AbortController()
      await stabilize(page, ac.signal, { animationDebounceMs: 1, ariaSampleGapMs: 5 })
      // 2 hash calls: initial + 1 follow-up that matched.
      expect(page.getHashCalls()).toBe(2)
    })

    it('retries up to ariaSampleMaxRetries when ARIA is still mutating', async () => {
      // Hash sequence: 'a', 'b' (mismatch → retry), 'c' (mismatch → retry), 'd' (give up)
      const page = withAria(['a', 'b', 'c', 'd'])
      const ac = new AbortController()
      await stabilize(page, ac.signal, {
        animationDebounceMs: 1,
        ariaSampleGapMs: 1,
        ariaSampleMaxRetries: 2,
      })
      // initial + 2 retries = 3 calls; gives up after.
      expect(page.getHashCalls()).toBe(3)
    })

    it('skipped when ariaSnapshotHash is absent (preserves Phase 2 contract)', async () => {
      const page: StabilizePage = { async waitForLoadState() {} }
      const ac = new AbortController()
      // Should resolve without throwing — no ARIA hook to call.
      await expect(
        stabilize(page, ac.signal, { animationDebounceMs: 1 }),
      ).resolves.toBeUndefined()
    })

    it('proceeds silently if ariaSnapshotHash throws (best-effort)', async () => {
      const page: StabilizePageWithAria = {
        async waitForLoadState() {},
        ariaSnapshotHash: async () => {
          throw new Error('aria walker broke')
        },
      }
      const ac = new AbortController()
      await expect(
        stabilize(page, ac.signal, { animationDebounceMs: 1, ariaSampleGapMs: 1 }),
      ).resolves.toBeUndefined()
    })

    it('respects abort during ARIA sampling', async () => {
      const ac = new AbortController()
      const page: StabilizePageWithAria = {
        async waitForLoadState() {},
        ariaSnapshotHash: async (signal: AbortSignal) => {
          if (signal.aborted) throw new BrowserSessionError('aborted', 'aria sample aborted')
          return 'h'
        },
      }
      // Abort BEFORE stabilize starts — abort propagates from the early gate.
      ac.abort()
      await expect(stabilize(page, ac.signal, { animationDebounceMs: 1 })).rejects.toBeInstanceOf(
        BrowserSessionError,
      )
    })

    it('aborts during ariaSnapshotHash propagate (fix #8) — never silently swallowed', async () => {
      // Even though ARIA convergence is "best-effort," a user abort must
      // propagate so cancels aren't eaten. Non-abort errors stay swallowed
      // (covered by "proceeds silently if ariaSnapshotHash throws" above).
      const page: StabilizePageWithAria = {
        async waitForLoadState() {},
        ariaSnapshotHash: async () => {
          throw new BrowserSessionError('aborted', 'simulated abort mid-sample')
        },
      }
      const ac = new AbortController()
      await expect(
        stabilize(page, ac.signal, { animationDebounceMs: 1, ariaSampleGapMs: 1 }),
      ).rejects.toMatchObject({ kind: 'aborted' })
    })

    it('aborts during a follow-up ARIA sample (after the initial succeeded) propagate', async () => {
      let calls = 0
      const page: StabilizePageWithAria = {
        async waitForLoadState() {},
        ariaSnapshotHash: async () => {
          calls++
          if (calls === 1) return 'first-hash'
          throw new BrowserSessionError('aborted', 'abort on follow-up sample')
        },
      }
      const ac = new AbortController()
      await expect(
        stabilize(page, ac.signal, {
          animationDebounceMs: 1,
          ariaSampleGapMs: 1,
          ariaSampleMaxRetries: 2,
        }),
      ).rejects.toMatchObject({ kind: 'aborted' })
    })
  })
})
