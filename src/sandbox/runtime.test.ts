import { describe, expect, it } from 'vitest'
import { runSandbox } from './runtime.js'

const DEFAULT_CAP = 64 * 1024
const DEFAULT_TIMEOUT = 5_000

const callJs = (
  code: string,
  opts?: Partial<{ timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }>,
) =>
  runSandbox({
    language: 'javascript',
    code,
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT,
    signal: opts?.signal ?? new AbortController().signal,
    maxOutputBytes: opts?.maxOutputBytes ?? DEFAULT_CAP,
  })

describe('runSandbox JS', () => {
  it('runs hello-world via console.log (strings printed bare, like Node)', async () => {
    const r = await callJs(`console.log('hello world')`)
    expect(r.stdout).toBe('hello world\n')
    expect(r.stderr).toBe('')
    expect(r.exitError).toBeUndefined()
    expect(r.timedOut).toBe(false)
  })

  it('routes console.error to stderr', async () => {
    const r = await callJs(`console.error('boom')`)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('boom\n')
    expect(r.exitError).toBeUndefined()
  })

  it('JSON-encodes non-string args (like Node util.inspect minimal)', async () => {
    const r = await callJs(`console.log({a: 1, b: [2, 3]})`)
    expect(JSON.parse(r.stdout.trim())).toEqual({ a: 1, b: [2, 3] })
  })

  it('asserts no Node globals leak into the QuickJS runtime', async () => {
    const r = await callJs(`
      const out = {
        require: typeof require,
        process: typeof process,
        Buffer: typeof Buffer,
        fs: typeof globalThis.fs,
        global: typeof global,
        __dirname: typeof __dirname,
      }
      console.log(JSON.stringify(out))
    `)
    expect(r.exitError).toBeUndefined()
    const parsed = JSON.parse(r.stdout.trim()) as Record<string, string>
    expect(parsed.require).toBe('undefined')
    expect(parsed.process).toBe('undefined')
    expect(parsed.Buffer).toBe('undefined')
    expect(parsed.fs).toBe('undefined')
    expect(parsed.global).toBe('undefined')
    expect(parsed.__dirname).toBe('undefined')
  })

  it('kills wall-clock-runaway code via worker.terminate', async () => {
    const start = Date.now()
    const r = await callJs(`while(true){}`, { timeoutMs: 200 })
    const elapsed = Date.now() - start
    expect(r.timedOut).toBe(true)
    expect(r.exitError).toMatch(/timeout/)
    expect(elapsed).toBeLessThan(2000)
  })

  it('rejects memory-bomb with QuickJS OOM, not host OOM', async () => {
    const r = await callJs(
      `
      const big = []
      for (let i = 0; i < 1e7; i++) big.push('x'.repeat(1024))
      console.log('should not reach here')
      `,
      { timeoutMs: 10_000 },
    )
    expect(r.timedOut).toBe(false)
    expect(r.exitError).toBeDefined()
    expect(r.stdout).not.toContain('should not reach here')
  }, 15_000)

  it('caps stdout at maxOutputBytes (head-preserving)', async () => {
    const r = await callJs(
      `for (let i = 0; i < 5000; i++) console.log('x'.repeat(20))`,
      { maxOutputBytes: 1024 },
    )
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(1024)
    expect(r.stdout.startsWith('xxxxxxxxxxxxxxxxxxxx')).toBe(true)
  })

  it('caps the SUM of stdout+stderr at maxOutputBytes (shared budget)', async () => {
    const r = await callJs(
      `
        for (let i = 0; i < 1000; i++) console.log('x'.repeat(50))
        for (let i = 0; i < 1000; i++) console.error('y'.repeat(50))
      `,
      { maxOutputBytes: 1024 },
    )
    expect(r.truncated).toBe(true)
    const totalBytes =
      Buffer.byteLength(r.stdout, 'utf8') + Buffer.byteLength(r.stderr, 'utf8')
    expect(totalBytes).toBeLessThanOrEqual(1024)
  })

  it('REPL-style: prints the final expression value when not undefined', async () => {
    const r = await callJs(`[...Array(5)].map((_, i) => i * i)`)
    expect(r.exitError).toBeUndefined()
    expect(JSON.parse(r.stdout.trim())).toEqual([0, 1, 4, 9, 16])
  })

  it('REPL-style: console.log returns undefined, no extra REPL print', async () => {
    const r = await callJs(`console.log('once')`)
    expect(r.stdout).toBe('once\n')
  })

  it('REPL-style: variable declarations evaluate to undefined and print nothing', async () => {
    const r = await callJs(`let x = 5`)
    expect(r.stdout).toBe('')
    expect(r.exitError).toBeUndefined()
  })

  it('hides __sandboxPostLine after console shim setup', async () => {
    const r = await callJs(`console.log(typeof globalThis.__sandboxPostLine)`)
    expect(r.stdout.trim()).toBe('undefined')
  })

  it('returns aborted when signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await callJs(`console.log(1)`, { signal: ctrl.signal })
    expect(r.aborted).toBe(true)
    expect(r.exitError).toBe('[aborted]')
  })

  it('returns aborted when signal aborts mid-run', async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    const r = await callJs(`while(true){}`, { timeoutMs: 5_000, signal: ctrl.signal })
    expect(r.aborted).toBe(true)
    expect(r.timedOut).toBe(false)
  })

  it('reports thrown JS errors via exitError', async () => {
    const r = await callJs(`throw new Error('nope')`)
    expect(r.exitError).toContain('nope')
    expect(r.timedOut).toBe(false)
  })

  it('reports syntax errors via exitError', async () => {
    const r = await callJs(`function ( {`)
    expect(r.exitError).toBeDefined()
  })

  it('does not leak globals between calls', async () => {
    await callJs(`globalThis.leaked = 'first call'`)
    const r2 = await callJs(`console.log(typeof globalThis.leaked)`)
    expect(r2.stdout.trim()).toBe('undefined')
  })

  it('rejects unknown language values', async () => {
    const r = await runSandbox({
      // @ts-expect-error — testing the runtime guard
      language: 'ruby',
      code: 'puts 1',
      timeoutMs: 1000,
      signal: new AbortController().signal,
      maxOutputBytes: DEFAULT_CAP,
    })
    expect(r.exitError).toMatch(/unknown language/)
  })
})
