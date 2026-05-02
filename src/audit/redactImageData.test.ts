import { describe, it, expect } from 'vitest'

import { redactImageData } from './redactImageData.js'

const SMALL_PNG_BASE64 = Buffer.from('hello world').toString('base64')

describe('redactImageData', () => {
  it('replaces a top-level image with metadata', () => {
    const out = redactImageData({
      type: 'image',
      mediaType: 'image/png',
      data: SMALL_PNG_BASE64,
      width: 100,
      height: 50,
    }) as Record<string, unknown>
    expect(out.type).toBe('image')
    expect(out.mediaType).toBe('image/png')
    expect(out.width).toBe(100)
    expect(out.height).toBe(50)
    expect(out.redacted).toBe(true)
    expect(typeof out.byteSize).toBe('number')
    expect(out.byteSize).toBe(Buffer.byteLength(SMALL_PNG_BASE64, 'base64'))
    expect(out.data).toBeUndefined()
  })

  it('walks nested arrays and objects', () => {
    const event = {
      type: 'tool_result',
      message: {
        content: [
          { type: 'tool_result', toolUseId: 'tu-1', content: 'ok' },
          { type: 'image', mediaType: 'image/png', data: SMALL_PNG_BASE64, width: 10, height: 10 },
        ],
      },
    }
    const out = redactImageData(event) as { message: { content: unknown[] } }
    const content = out.message.content as Array<Record<string, unknown>>
    expect(content[0]!.type).toBe('tool_result')
    expect(content[0]!.content).toBe('ok')
    expect(content[1]!.type).toBe('image')
    expect(content[1]!.redacted).toBe(true)
    expect(content[1]!.data).toBeUndefined()
  })

  it('leaves non-image data untouched', () => {
    const event = {
      type: 'tool_call_started',
      toolUseId: 'tu-1',
      args: { path: '/foo' },
      tags: ['a', 'b'],
    }
    const out = redactImageData(event)
    expect(out).toEqual(event)
  })

  it('preserves Errors in place', () => {
    const err = new Error('boom')
    const out = redactImageData(err)
    expect(out).toBe(err)
  })

  it('handles primitives, null, and undefined', () => {
    expect(redactImageData(null)).toBe(null)
    expect(redactImageData(undefined)).toBe(undefined)
    expect(redactImageData(42)).toBe(42)
    expect(redactImageData('hello')).toBe('hello')
    expect(redactImageData(true)).toBe(true)
  })

  it('is idempotent — second pass leaves output unchanged', () => {
    const once = redactImageData({
      type: 'image',
      mediaType: 'image/png',
      data: SMALL_PNG_BASE64,
      width: 10,
      height: 10,
    })
    const twice = redactImageData(once)
    expect(twice).toEqual(once)
  })

  it('preserves dimension metadata if upstream populated it', () => {
    const out = redactImageData({
      type: 'image',
      mediaType: 'image/png',
      data: SMALL_PNG_BASE64,
      width: 1024,
      height: 768,
    }) as Record<string, unknown>
    expect(out.width).toBe(1024)
    expect(out.height).toBe(768)
  })

  it('tolerates images without dimensions', () => {
    const out = redactImageData({
      type: 'image',
      mediaType: 'image/png',
      data: SMALL_PNG_BASE64,
    }) as Record<string, unknown>
    expect(out.redacted).toBe(true)
    expect(out.width).toBeUndefined()
    expect(out.height).toBeUndefined()
  })

  it('walks deeply nested image blocks', () => {
    const event = { a: { b: { c: [{ type: 'image', mediaType: 'image/png', data: SMALL_PNG_BASE64 }] } } }
    const out = redactImageData(event) as { a: { b: { c: Array<Record<string, unknown>> } } }
    expect(out.a.b.c[0]!.redacted).toBe(true)
    expect(out.a.b.c[0]!.data).toBeUndefined()
  })
})
