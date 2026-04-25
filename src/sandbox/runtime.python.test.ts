/**
 * Python sandbox tests. Most are gated on Pyodide being installed via the
 * optional peer dep — if it's absent, the bulk of these skip and only the
 * "friendly error on missing dep" test runs.
 */
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'
import { runSandbox } from './runtime.js'

const requireFromHere = createRequire(import.meta.url)
let pyodidePresent = false
try {
  requireFromHere.resolve('pyodide')
  pyodidePresent = true
} catch (_) {
  pyodidePresent = false
}

const DEFAULT_CAP = 64 * 1024
const PYODIDE_TIMEOUT = 60_000

const callPy = (
  code: string,
  opts?: Partial<{ timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }>,
) =>
  runSandbox({
    language: 'python',
    code,
    timeoutMs: opts?.timeoutMs ?? PYODIDE_TIMEOUT,
    signal: opts?.signal ?? new AbortController().signal,
    maxOutputBytes: opts?.maxOutputBytes ?? DEFAULT_CAP,
  })

describe('runSandbox Python — missing-dep path', () => {
  it.skipIf(pyodidePresent)('returns friendly install hint when pyodide is absent', async () => {
    const r = await callPy(`print('hi')`, { timeoutMs: 5_000 })
    expect(r.exitError).toMatch(/Python sandbox unavailable.*pyodide/)
    expect(r.timedOut).toBe(false)
  })
})

describe.skipIf(!pyodidePresent)('runSandbox Python — pyodide present', () => {
  it('runs hello-world via print()', async () => {
    const r = await callPy(`print(2 ** 100)`)
    expect(r.exitError).toBeUndefined()
    expect(r.stdout.trim()).toBe('1267650600228229401496703205376')
  }, PYODIDE_TIMEOUT + 5_000)

  it('asserts no host paths leak through Pyodide MEMFS', async () => {
    const r = await callPy(`
      import os
      try:
        entries = os.listdir('/Users')
        print('ENTRIES', len(entries))
      except FileNotFoundError:
        print('NO_USERS_DIR')
      except PermissionError:
        print('PERMISSION_DENIED')
    `)
    expect(r.exitError).toBeUndefined()
    // Pyodide's MEMFS does not contain a host '/Users' directory.
    expect(r.stdout.trim()).toMatch(/NO_USERS_DIR|PERMISSION_DENIED/)
  }, PYODIDE_TIMEOUT + 5_000)

  it('kills tight Python loop at wall-clock timeout', async () => {
    const start = Date.now()
    const r = await callPy(`while True: pass`, { timeoutMs: 2_000 })
    const elapsed = Date.now() - start
    expect(r.timedOut).toBe(true)
    expect(elapsed).toBeLessThan(PYODIDE_TIMEOUT)
  }, PYODIDE_TIMEOUT + 5_000)

  it('reports Python exceptions via exitError', async () => {
    const r = await callPy(`raise ValueError('nope')`)
    expect(r.exitError).toContain('nope')
  }, PYODIDE_TIMEOUT + 5_000)

  it('refuses `from js import process` (jsglobals locked down)', async () => {
    const r = await callPy(`
      try:
        from js import process
        print('LEAKED', type(process).__name__)
      except ImportError as e:
        print('BLOCKED')
      except Exception as e:
        print('BLOCKED', type(e).__name__)
    `)
    expect(r.exitError).toBeUndefined()
    expect(r.stdout.trim()).toMatch(/^BLOCKED/)
  }, PYODIDE_TIMEOUT + 5_000)

  it('refuses `from js import fetch` and other host bindings', async () => {
    const r = await callPy(`
      blocked = []
      for name in ('fetch', 'require', 'Buffer', 'globalThis'):
        try:
          exec(f'from js import {name}')
          print('LEAKED', name)
          break
        except Exception:
          blocked.append(name)
      else:
        print('ALL_BLOCKED')
    `)
    expect(r.exitError).toBeUndefined()
    expect(r.stdout.trim()).toBe('ALL_BLOCKED')
  }, PYODIDE_TIMEOUT + 5_000)

  // Memory cap test omitted: Pyodide's runPythonAsync runs through Promise
  // microtasks, starving setInterval (macrotask) — so the in-Pyodide memory
  // poll cannot reliably catch overrun during a tight Python loop. The
  // wall-clock kill remains the rock-solid defense; for true per-call
  // memory enforcement see the deferred-work note in workerBootstrap.ts.

  it('caps total stdout+stderr bytes (shared budget)', async () => {
    const r = await callPy(
      `
import sys
for _ in range(1000): print('x' * 50)
for _ in range(1000): print('y' * 50, file=sys.stderr)
      `,
      { maxOutputBytes: 1024 },
    )
    const total =
      Buffer.byteLength(r.stdout, 'utf8') + Buffer.byteLength(r.stderr, 'utf8')
    expect(total).toBeLessThanOrEqual(1024)
    expect(r.truncated).toBe(true)
  }, PYODIDE_TIMEOUT + 5_000)
})
