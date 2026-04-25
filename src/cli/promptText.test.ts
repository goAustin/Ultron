import { describe, it, expect } from 'vitest'
import { Readable, Writable } from 'node:stream'

import { promptText } from './promptText.js'

class StringWritable extends Writable {
  buf = ''
  override _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.buf += chunk.toString('utf8')
    cb()
  }
}

describe('promptText', () => {
  it('returns the typed line (unmasked)', async () => {
    const input = Readable.from(['hello\n'])
    const output = new StringWritable()
    const got = await promptText('Q? ', { input, output })
    expect(got).toBe('hello')
    expect(output.buf).toContain('Q?')
  })

  it('preserves leading/trailing whitespace (caller decides)', async () => {
    const input = Readable.from(['  spaced  \n'])
    const output = new StringWritable()
    const got = await promptText('?', { input, output })
    expect(got).toBe('  spaced  ')
  })

  it('with mask:true, the typed key is NOT echoed to output (fix #2)', async () => {
    const input = Readable.from(['secret-key\n'])
    const output = new StringWritable()
    const got = await promptText('Paste: ', { input, output, mask: true })
    expect(got).toBe('secret-key')
    // Output should contain the prompt label but NOT the typed key.
    expect(output.buf).toContain('Paste:')
    expect(output.buf).not.toContain('secret-key')
  })

  it('mask:true returns empty string on empty input', async () => {
    const input = Readable.from(['\n'])
    const output = new StringWritable()
    const got = await promptText('Paste: ', { input, output, mask: true })
    expect(got).toBe('')
  })
})
