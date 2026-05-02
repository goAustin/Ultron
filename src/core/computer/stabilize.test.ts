import { describe, expect, it } from 'vitest'

import { stabilize, type StabilizePage } from './stabilize.js'
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
})
