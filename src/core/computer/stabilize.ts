/**
 * v3 Phase 2: page stabilization after a navigation/action.
 *
 * Implements steps 1-4 of the v3 plan stabilization stack
 * (docs/ultron_v3/v3-computer-use-plan.md:299-304):
 *   1. Wait for the immediate action promise (caller does this).
 *   2. Wait for committed navigation if applicable (`domcontentloaded`).
 *   3. Wait `'load'` opportunistically with a short cap.
 *   4. setTimeout debounce for animation tail.
 *
 * Step 5 (sample two ARIA snapshots ~250ms apart) is deferred to Phase 4
 * alongside `ariaSnapshot.ts`. The signature stays stable so Phase 4 can layer
 * the ARIA sampling in without changing callers.
 *
 * `networkidle` is intentionally NOT used — Playwright's docs flag it as
 * discouraged for readiness signaling.
 */

import { BrowserSessionError } from './types.js'

// Minimal Page surface so this module stays unit-testable without importing
// playwright. Production code passes a real Playwright Page.
export interface StabilizePage {
  waitForLoadState(
    state: 'domcontentloaded' | 'load',
    options?: { timeout?: number },
  ): Promise<void>
}

export type StabilizeOptions = {
  readonly animationDebounceMs?: number
  readonly loadStateTimeoutMs?: number
  readonly loadOpportunisticTimeoutMs?: number
}

const DEFAULT_ANIMATION_DEBOUNCE_MS = 150
const DEFAULT_LOAD_STATE_TIMEOUT_MS = 10_000
const DEFAULT_LOAD_OPPORTUNISTIC_TIMEOUT_MS = 1_000

export async function stabilize(
  page: StabilizePage,
  signal: AbortSignal,
  opts?: StabilizeOptions,
): Promise<void> {
  const animationDebounceMs = opts?.animationDebounceMs ?? DEFAULT_ANIMATION_DEBOUNCE_MS
  const loadStateTimeoutMs = opts?.loadStateTimeoutMs ?? DEFAULT_LOAD_STATE_TIMEOUT_MS
  const loadOpportunisticMs =
    opts?.loadOpportunisticTimeoutMs ?? DEFAULT_LOAD_OPPORTUNISTIC_TIMEOUT_MS

  if (signal.aborted) {
    throw new BrowserSessionError('aborted', 'Stabilize aborted before start')
  }

  // Step 2: wait for committed navigation / DOMContentLoaded.
  await raceAbort(
    page.waitForLoadState('domcontentloaded', { timeout: loadStateTimeoutMs }),
    signal,
  )

  // Step 3: wait for `'load'` opportunistically. A short cap avoids hanging
  // on never-firing load events (long-poll iframes etc.).
  try {
    await raceAbort(
      page.waitForLoadState('load', { timeout: loadOpportunisticMs }),
      signal,
    )
  } catch (err) {
    if (err instanceof BrowserSessionError && err.kind === 'aborted') throw err
    // Other errors (timeout) are intentionally swallowed — `load` is best-effort.
  }

  // Step 4: animation debounce.
  await sleepAbortable(animationDebounceMs, signal)
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new BrowserSessionError('aborted', 'Stabilize aborted'),
    )
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new BrowserSessionError('aborted', 'Stabilize aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      new BrowserSessionError('aborted', 'Stabilize aborted'),
    )
  }
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new BrowserSessionError('aborted', 'Stabilize aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
