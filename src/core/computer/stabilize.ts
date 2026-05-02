/**
 * v3 Phase 2 + 4·2: page stabilization after a navigation/action.
 *
 * Implements all 5 steps of the v3 plan stabilization stack
 * (docs/ultron_v3/v3-computer-use-plan.md:299-304):
 *   1. Wait for the immediate action promise (caller does this).
 *   2. Wait for committed navigation if applicable (`domcontentloaded`).
 *   3. Wait `'load'` opportunistically with a short cap.
 *   4. setTimeout debounce for animation tail.
 *   5. (Phase 4·2) Sample two ARIA snapshots ~250ms apart and require equal
 *      hashes — catches "DOM still mutating" cases where the layout has
 *      stabilized visually but JS is still re-rendering. Skipped when the
 *      page doesn't expose an ARIA capability (preserves Phase 2 callers
 *      that pass a minimal `StabilizePage`).
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

/**
 * Optional capability-extension contract for step 5. The Playwright session
 * passes a function that runs the in-browser ARIA walker and returns its
 * hash; tests can pass a stub. When this hook is absent, step 5 is skipped.
 */
export interface StabilizePageWithAria extends StabilizePage {
  ariaSnapshotHash?: (signal: AbortSignal) => Promise<string>
}

export type StabilizeOptions = {
  readonly animationDebounceMs?: number
  readonly loadStateTimeoutMs?: number
  readonly loadOpportunisticTimeoutMs?: number
  /**
   * Phase 4·2 — gap between the two ARIA snapshots in step 5. Default
   * 250ms matches the v3 plan; tests pass a small value to keep them fast.
   */
  readonly ariaSampleGapMs?: number
  /**
   * Phase 4·2 — max retries when the two ARIA snapshots disagree. After
   * `ariaSampleMaxRetries` mismatches we give up and proceed (the page may
   * be inherently dynamic; verify.ts will catch that downstream).
   */
  readonly ariaSampleMaxRetries?: number
}

const DEFAULT_ANIMATION_DEBOUNCE_MS = 150
const DEFAULT_LOAD_STATE_TIMEOUT_MS = 10_000
const DEFAULT_LOAD_OPPORTUNISTIC_TIMEOUT_MS = 1_000
const DEFAULT_ARIA_SAMPLE_GAP_MS = 250
const DEFAULT_ARIA_SAMPLE_MAX_RETRIES = 2

export async function stabilize(
  page: StabilizePageWithAria,
  signal: AbortSignal,
  opts?: StabilizeOptions,
): Promise<void> {
  const animationDebounceMs = opts?.animationDebounceMs ?? DEFAULT_ANIMATION_DEBOUNCE_MS
  const loadStateTimeoutMs = opts?.loadStateTimeoutMs ?? DEFAULT_LOAD_STATE_TIMEOUT_MS
  const loadOpportunisticMs =
    opts?.loadOpportunisticTimeoutMs ?? DEFAULT_LOAD_OPPORTUNISTIC_TIMEOUT_MS
  const ariaSampleGapMs = opts?.ariaSampleGapMs ?? DEFAULT_ARIA_SAMPLE_GAP_MS
  const ariaSampleMaxRetries = opts?.ariaSampleMaxRetries ?? DEFAULT_ARIA_SAMPLE_MAX_RETRIES

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

  // Step 5 (Phase 4·2): ARIA convergence check. Skip when the page doesn't
  // expose the capability — preserves the Phase 2 contract for callers that
  // pass a minimal StabilizePage.
  if (typeof page.ariaSnapshotHash === 'function') {
    await waitForAriaConvergence(
      page.ariaSnapshotHash.bind(page),
      signal,
      ariaSampleGapMs,
      ariaSampleMaxRetries,
    )
  }
}

async function waitForAriaConvergence(
  capture: (signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  gapMs: number,
  maxRetries: number,
): Promise<void> {
  let prev: string
  try {
    prev = await capture(signal)
  } catch (err) {
    // Phase 4·2 fix #8 — abort must propagate; non-abort ARIA capture
    // failures are best-effort (the rest of stabilize already covered
    // load/animation, so we can give up on convergence quietly).
    if (isAbortBrowserError(err)) throw err
    return
  }
  // `maxRetries` follow-up samples after the initial. Total ARIA captures
  // is at most `1 + maxRetries`. After that we give up — the page is
  // inherently dynamic and verify.ts will catch any false-success downstream.
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await sleepAbortable(gapMs, signal)
    let next: string
    try {
      next = await capture(signal)
    } catch (err) {
      if (isAbortBrowserError(err)) throw err
      return
    }
    if (next === prev) return
    prev = next
  }
}

function isAbortBrowserError(err: unknown): boolean {
  return err instanceof BrowserSessionError && err.kind === 'aborted'
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
