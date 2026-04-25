import { describe, it, expect } from 'vitest'
import { spawnStdioTransport } from './transportStdio.js'

/**
 * These tests spawn real Node subprocesses because that's the unit we're
 * testing. We keep the scripts inline and minimal.
 */

describe('spawnStdioTransport', () => {
  it('echoes a line written to stdin back on stdout', async () => {
    const script = `
process.stdin.on('data', d => process.stdout.write(d));
    `.trim()
    const t = spawnStdioTransport({
      command: process.execPath,
      args: ['-e', script],
    })
    const lines: string[] = []
    t.onLine(l => lines.push(l))
    const exited = new Promise<void>(resolve => t.onExit(() => resolve()))
    t.send('hello\n')
    await new Promise(r => setTimeout(r, 80))
    await t.close()
    await exited
    expect(lines).toEqual(['hello'])
  })

  it('splits multiple lines from one chunk', async () => {
    const script = `process.stdout.write("a\\nb\\nc\\n"); setTimeout(() => process.exit(0), 50);`
    const t = spawnStdioTransport({ command: process.execPath, args: ['-e', script] })
    const lines: string[] = []
    t.onLine(l => lines.push(l))
    await new Promise<void>(resolve => t.onExit(() => resolve()))
    expect(lines).toEqual(['a', 'b', 'c'])
  })

  it('onExit fires with the exit code', async () => {
    const script = `process.exit(42)`
    const t = spawnStdioTransport({ command: process.execPath, args: ['-e', script] })
    const code = await new Promise<number | null>(resolve =>
      t.onExit(c => resolve(c)),
    )
    expect(code).toBe(42)
  })

  it('close() SIGKILLs a hung child within the grace window', async () => {
    // Trap SIGTERM so the child ignores graceful shutdown and forces SIGKILL.
    // Print 'ready' first so the test only calls close() after the handler
    // is definitely installed.
    const script = `
process.on('SIGTERM', () => {});
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
    `.trim()
    const t = spawnStdioTransport({ command: process.execPath, args: ['-e', script] })
    await new Promise<void>(resolve => {
      t.onLine(l => {
        if (l === 'ready') resolve()
      })
    })
    const start = Date.now()
    await t.close(200)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(1500)
  })

  it('double close is a no-op', async () => {
    const script = `setInterval(() => {}, 1000);`
    const t = spawnStdioTransport({ command: process.execPath, args: ['-e', script] })
    await t.close(200)
    await t.close(200) // should not hang or throw
  })
})
