import { describe, it, expect } from 'vitest'
import { encodeRequest, encodeNotification, parseFrame } from './jsonrpc.js'

describe('encodeRequest', () => {
  it('emits a JSON-RPC 2.0 request with trailing newline', () => {
    const line = encodeRequest(1, 'tools/list')
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line.trim())).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })

  it('includes params when provided', () => {
    const line = encodeRequest(2, 'tools/call', { name: 'x', arguments: { a: 1 } })
    expect(JSON.parse(line.trim())).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'x', arguments: { a: 1 } },
    })
  })

  it('omits params when undefined', () => {
    const line = encodeRequest(3, 'initialize')
    const parsed = JSON.parse(line.trim())
    expect('params' in parsed).toBe(false)
  })
})

describe('encodeNotification', () => {
  it('emits a notification with no id', () => {
    const line = encodeNotification('notifications/initialized')
    const parsed = JSON.parse(line.trim())
    expect(parsed).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect('id' in parsed).toBe(false)
  })
})

describe('parseFrame', () => {
  it('parses a success response', () => {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    expect(parseFrame(frame)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
  })

  it('parses an error response', () => {
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      error: { code: -32601, message: 'Method not found' },
    })
    expect(parseFrame(frame)).toEqual({
      jsonrpc: '2.0',
      id: 5,
      error: { code: -32601, message: 'Method not found' },
    })
  })

  it('preserves error.data when present', () => {
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      id: 6,
      error: { code: -32000, message: 'oops', data: { hint: 'retry' } },
    })
    const parsed = parseFrame(frame)
    expect(parsed).toEqual({
      jsonrpc: '2.0',
      id: 6,
      error: { code: -32000, message: 'oops', data: { hint: 'retry' } },
    })
  })

  it('parses a notification', () => {
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info' },
    })
    expect(parseFrame(frame)).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info' },
    })
  })

  it('returns null on malformed JSON', () => {
    expect(parseFrame('not json')).toBeNull()
  })

  it('returns null on wrong jsonrpc version', () => {
    const frame = JSON.stringify({ jsonrpc: '1.0', id: 1, result: {} })
    expect(parseFrame(frame)).toBeNull()
  })

  it('returns null on response without result or error', () => {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1 })
    expect(parseFrame(frame)).toBeNull()
  })

  it('returns null on error response with malformed error object', () => {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'no code' } })
    expect(parseFrame(frame)).toBeNull()
  })

  it('returns null on a frame that is neither response nor notification', () => {
    const frame = JSON.stringify({ jsonrpc: '2.0' })
    expect(parseFrame(frame)).toBeNull()
  })
})
