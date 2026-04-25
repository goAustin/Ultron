import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'

import { runHook } from './runHook.js'
import type { HookDefinition } from './types.js'

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/hooks')
const script = (name: string): string => resolve(FIXTURES, name)

function def(cmd: string, timeout?: number): HookDefinition {
  return timeout === undefined
    ? { matcher: '*', command: cmd }
    : { matcher: '*', command: cmd, timeout }
}

const SIGNAL_NEVER = new AbortController().signal

describe('runHook', () => {
  it('exit 0, no stdout → outcome ok', async () => {
    const res = await runHook(def(script('exit-0.sh')), { t: 1 }, SIGNAL_NEVER)
    expect(res.outcome).toBe('ok')
    if (res.outcome === 'ok') expect(res.exitCode).toBe(0)
  })

  it('exit 2 → outcome block, reason from stderr', async () => {
    const res = await runHook(def(script('exit-2.sh')), {}, SIGNAL_NEVER)
    expect(res.outcome).toBe('block')
    if (res.outcome === 'block') {
      expect(res.reason).toBe('denied')
      expect(res.exitCode).toBe(2)
    }
  })

  it('non-zero non-two exit → outcome error, does NOT block', async () => {
    const res = await runHook(def(script('exit-nonzero.sh')), {}, SIGNAL_NEVER)
    expect(res.outcome).toBe('error')
    if (res.outcome === 'error') expect(res.exitCode).toBe(17)
  })

  it('timeout → outcome timeout', async () => {
    const res = await runHook(def(script('sleep-long.sh'), 100), {}, SIGNAL_NEVER)
    expect(res.outcome).toBe('timeout')
  })

  it('stdout updatedInput → outcome ok with updatedInput', async () => {
    const res = await runHook(def(script('mutate-input.sh')), {}, SIGNAL_NEVER)
    expect(res.outcome).toBe('ok')
    if (res.outcome === 'ok') {
      expect(res.updatedInput).toEqual({ foo: 'bar' })
    }
  })

  it('exit 0 + stdout {decision:"block"} → outcome block (not ok)', async () => {
    const res = await runHook(def(script('exit-0-stdout-block.sh')), {}, SIGNAL_NEVER)
    expect(res.outcome).toBe('block')
    if (res.outcome === 'block') {
      expect(res.reason).toBe('policy')
      expect(res.exitCode).toBe(0)
    }
  })

  it('garbage stdout on exit 0 → outcome ok (tolerated), no updatedInput', async () => {
    const res = await runHook(def(script('garbage-stdout.sh')), {}, SIGNAL_NEVER)
    expect(res.outcome).toBe('ok')
    if (res.outcome === 'ok') expect(res.updatedInput).toBeUndefined()
  })

  it('runaway stdout is capped, outputTruncated=true, completes cleanly', async () => {
    const res = await runHook(def(script('runaway-stdout.sh')), {}, SIGNAL_NEVER)
    expect(res.outcome).toBe('ok')
    expect(res.outputTruncated).toBe(true)
  }, 10_000)

  it('ENOENT command → outcome error (never throws)', async () => {
    const res = await runHook(def('/this/path/does/not/exist.sh'), {}, SIGNAL_NEVER)
    // spawn with shell:true + ENOENT emits exit code 127 from the shell,
    // so outcome is 'error'. Either way, no throw.
    expect(['error', 'timeout']).toContain(res.outcome)
  })

  it('aborted signal mid-run → outcome error', async () => {
    const ac = new AbortController()
    const resP = runHook(def(script('sleep-long.sh'), 10_000), {}, ac.signal)
    // Abort almost immediately
    setTimeout(() => ac.abort(), 50)
    const res = await resP
    expect(res.outcome).toBe('error')
  })
})
