import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'

import { confirmYesNo } from './confirmPrompt.js'

/**
 * Run `confirmYesNo` with `typed` as the user's input line. Returns the
 * promise along with a sink that captured stdout.
 */
function runPrompt(typed: string, opts: { defaultNo?: boolean } = {}): Promise<boolean> {
  const input = new PassThrough()
  const output = new PassThrough()
  // Drain output so readline's question() write doesn't block.
  output.resume()
  const answerPromise = confirmYesNo('Continue?', {
    defaultNo: opts.defaultNo,
    input,
    output,
  })
  // Send the typed line + newline after a tick so readline is listening.
  queueMicrotask(() => {
    input.write(typed)
    input.end()
  })
  return answerPromise
}

describe('confirmYesNo', () => {
  it('returns true on "y"', async () => {
    expect(await runPrompt('y\n')).toBe(true)
  })

  it('returns false on "n"', async () => {
    expect(await runPrompt('n\n')).toBe(false)
  })

  it('empty input with defaultNo=true returns false', async () => {
    expect(await runPrompt('\n', { defaultNo: true })).toBe(false)
  })

  it('empty input with defaultNo=false returns true', async () => {
    expect(await runPrompt('\n', { defaultNo: false })).toBe(true)
  })

  it('is case-insensitive ("YES" → true)', async () => {
    expect(await runPrompt('YES\n')).toBe(true)
  })

  it('accepts full "no" as false', async () => {
    expect(await runPrompt('no\n')).toBe(false)
  })

  it('unrecognized input falls back to false (no, by default)', async () => {
    expect(await runPrompt('maybe\n')).toBe(false)
  })
})
