import { describe, expect, it } from 'vitest'
import {
  createByteBudget,
  createCappedAppender,
  createHeadCap,
  utf8SafeBoundary,
} from './outputCap.js'

describe('createHeadCap (single-stream sugar)', () => {
  it('preserves the head when total bytes fit under cap', () => {
    const cap = createHeadCap(100)
    cap.append('hello ')
    cap.append('world')
    expect(cap.value()).toBe('hello world')
    expect(cap.truncated).toBe(false)
  })

  it('truncates at the byte boundary on first overflow', () => {
    const cap = createHeadCap(5)
    cap.append('hello')
    expect(cap.truncated).toBe(false)
    cap.append('!!!')
    expect(cap.value()).toBe('hello')
    expect(cap.truncated).toBe(true)
  })

  it('truncates mid-append at the exact byte limit', () => {
    const cap = createHeadCap(8)
    cap.append('1234567890')
    expect(cap.value()).toBe('12345678')
    expect(cap.truncated).toBe(true)
  })

  it('drops further appends silently after truncation', () => {
    const cap = createHeadCap(3)
    cap.append('abcde')
    expect(cap.value()).toBe('abc')
    cap.append('XYZ')
    expect(cap.value()).toBe('abc')
    expect(cap.truncated).toBe(true)
  })

  it('handles empty appends', () => {
    const cap = createHeadCap(10)
    cap.append('')
    cap.append('')
    expect(cap.value()).toBe('')
    expect(cap.truncated).toBe(false)
  })

  it('rejects negative maxBytes', () => {
    expect(() => createHeadCap(-1)).toThrow(/non-negative/)
  })

  it('treats zero cap as immediately truncated on non-empty append', () => {
    const cap = createHeadCap(0)
    cap.append('x')
    expect(cap.value()).toBe('')
    expect(cap.truncated).toBe(true)
  })

  it('zero cap stays untruncated when only empty appends arrive', () => {
    const cap = createHeadCap(0)
    cap.append('')
    expect(cap.truncated).toBe(false)
  })
})

describe('UTF-8 safety on truncation', () => {
  it('does not produce U+FFFD when slicing through é (2-byte char)', () => {
    const cap = createHeadCap(1)
    cap.append('é')
    // 'é' is 0xC3 0xA9. A naive slice at byte 1 would leave 0xC3, decoded
    // as U+FFFD (3 bytes), exceeding the cap. We drop the partial sequence.
    expect(Buffer.byteLength(cap.value(), 'utf8')).toBeLessThanOrEqual(1)
    expect(cap.value()).toBe('')
    expect(cap.truncated).toBe(true)
  })

  it('keeps the ASCII prefix when the trailing char would split', () => {
    const cap = createHeadCap(2)
    cap.append('aé')
    // Want 'a' (1 byte) + room for one more, but 'é' is 2 bytes — won't fit.
    expect(cap.value()).toBe('a')
    expect(Buffer.byteLength(cap.value(), 'utf8')).toBeLessThanOrEqual(2)
    expect(cap.truncated).toBe(true)
  })

  it('keeps a full multibyte char when it fits exactly', () => {
    const cap = createHeadCap(3)
    cap.append('aé')
    expect(cap.value()).toBe('aé')
    expect(cap.truncated).toBe(false)
  })

  it('walks back across multiple continuation bytes (4-byte emoji)', () => {
    const cap = createHeadCap(2)
    // 🙂 is 4 bytes (0xF0 0x9F 0x99 0x82). 2 bytes can't contain it.
    cap.append('🙂')
    expect(cap.value()).toBe('')
    expect(Buffer.byteLength(cap.value(), 'utf8')).toBeLessThanOrEqual(2)
    expect(cap.truncated).toBe(true)
  })

  it('utf8SafeBoundary returns max when next byte starts a fresh char', () => {
    const buf = Buffer.from('abc')
    expect(utf8SafeBoundary(buf, 2)).toBe(2)
  })

  it('utf8SafeBoundary returns buf.length when max exceeds it', () => {
    const buf = Buffer.from('ab')
    expect(utf8SafeBoundary(buf, 10)).toBe(2)
  })

  it('utf8SafeBoundary returns 0 for max <= 0', () => {
    expect(utf8SafeBoundary(Buffer.from('abc'), 0)).toBe(0)
    expect(utf8SafeBoundary(Buffer.from('abc'), -5)).toBe(0)
  })
})

describe('shared ByteBudget across stdout+stderr', () => {
  it('caps total bytes across two appenders', () => {
    const budget = createByteBudget(10)
    const out = createCappedAppender(budget)
    const err = createCappedAppender(budget)
    out.append('aaaaa') // 5 bytes — budget remaining 5
    err.append('bbbbb') // 5 bytes — budget remaining 0
    out.append('XXX')   // dropped — budget exhausted
    err.append('YYY')   // dropped
    expect(out.value()).toBe('aaaaa')
    expect(err.value()).toBe('bbbbb')
    expect(budget.truncated).toBe(true)
    expect(budget.remaining).toBe(0)
  })

  it('truncated flag set even if neither appender alone exceeded', () => {
    const budget = createByteBudget(8)
    const out = createCappedAppender(budget)
    const err = createCappedAppender(budget)
    out.append('hello') // 5 — remaining 3
    err.append('world') // 5 — only 3 fit
    expect(out.value()).toBe('hello')
    expect(err.value()).toBe('wor')
    expect(budget.truncated).toBe(true)
  })

  it('a single budget exhausted by stderr blocks subsequent stdout', () => {
    const budget = createByteBudget(4)
    const out = createCappedAppender(budget)
    const err = createCappedAppender(budget)
    err.append('xxxx') // exhausts
    out.append('y')
    expect(err.value()).toBe('xxxx')
    expect(out.value()).toBe('')
    expect(budget.truncated).toBe(true)
  })
})
