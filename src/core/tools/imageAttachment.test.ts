import { describe, it, expect } from 'vitest'

import { validateImageAttachment } from './imageAttachment.js'
import type { ImageCaps } from './imageAttachment.js'

const CAPS: ImageCaps = {
  maxBytes: 1_000_000,
  maxWidth: 1024,
  maxHeight: 768,
}

// Build a minimal valid PNG: 8-byte signature + IHDR chunk (length, type,
// width, height, bit depth, colour type, compression, filter, interlace, CRC).
// CRC is not validated by the parser — any bytes work.
function makePng(width: number, height: number, padBytes = 0): string {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)                // IHDR data length
  ihdr.write('IHDR', 4, 'ascii')           // chunk type
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr.writeUInt8(8, 16)                   // bit depth
  ihdr.writeUInt8(6, 17)                   // colour type (RGBA)
  ihdr.writeUInt8(0, 18)                   // compression
  ihdr.writeUInt8(0, 19)                   // filter
  ihdr.writeUInt8(0, 20)                   // interlace
  // CRC bytes 21..24 left as zeros — parser does not check them.
  const padding = Buffer.alloc(padBytes)
  return Buffer.concat([sig, ihdr, padding]).toString('base64')
}

describe('validateImageAttachment', () => {
  it('accepts a well-formed PNG within caps', () => {
    const data = makePng(800, 600)
    const result = validateImageAttachment(data, 'image/png', CAPS)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.attachment.width).toBe(800)
      expect(result.attachment.height).toBe(600)
      expect(result.attachment.mediaType).toBe('image/png')
      expect(result.attachment.data).toBe(data)
      expect(result.attachment.byteSize).toBeGreaterThan(0)
    }
  })

  it('rejects JPEG (Phase 1 PNG-only)', () => {
    const data = makePng(100, 100)
    const result = validateImageAttachment(data, 'image/jpeg', CAPS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported_media_type')
  })

  it('rejects unknown media types', () => {
    const data = makePng(100, 100)
    const result = validateImageAttachment(data, 'image/webp', CAPS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported_media_type')
  })

  it('rejects oversized bytes', () => {
    const data = makePng(100, 100, 2_000_000)
    const result = validateImageAttachment(data, 'image/png', {
      maxBytes: 100_000,
      maxWidth: 1024,
      maxHeight: 768,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('oversized_bytes')
  })

  it('rejects oversized width', () => {
    const data = makePng(2000, 100)
    const result = validateImageAttachment(data, 'image/png', CAPS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('oversized_dimensions')
  })

  it('rejects oversized height', () => {
    const data = makePng(100, 2000)
    const result = validateImageAttachment(data, 'image/png', CAPS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('oversized_dimensions')
  })

  it('rejects zero dimensions', () => {
    const data = makePng(0, 0)
    const result = validateImageAttachment(data, 'image/png', CAPS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed_png')
  })

  it('rejects truncated payloads (too short for IHDR)', () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const result = validateImageAttachment(data, 'image/png', CAPS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed_png')
  })

  it('rejects payloads with wrong magic bytes', () => {
    const wrong = Buffer.alloc(32) // all zeros
    const data = wrong.toString('base64')
    const result = validateImageAttachment(data, 'image/png', CAPS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed_png')
  })

  it('rejects payloads with valid signature but wrong IHDR chunk length', () => {
    // Valid signature, then chunk length 99 (not 13), then "IHDR" then garbage.
    const buf = Buffer.alloc(33)
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    buf.writeUInt32BE(99, 8)
    buf.write('IHDR', 12, 'ascii')
    buf.writeUInt32BE(800, 16)
    buf.writeUInt32BE(600, 20)
    const result = validateImageAttachment(buf.toString('base64'), 'image/png', CAPS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed_png')
  })

  it('rejects payloads with valid signature but wrong chunk type', () => {
    // Valid signature, length 13, but chunk type "FAKE" instead of "IHDR".
    const buf = Buffer.alloc(33)
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    buf.writeUInt32BE(13, 8)
    buf.write('FAKE', 12, 'ascii')
    buf.writeUInt32BE(800, 16)
    buf.writeUInt32BE(600, 20)
    const result = validateImageAttachment(buf.toString('base64'), 'image/png', CAPS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed_png')
  })

  it('byte size matches base64 payload size, not character length', () => {
    // 4 base64 chars = 3 bytes (no padding). makePng output is base64.
    const data = makePng(10, 10)
    const expectedBytes = Buffer.from(data, 'base64').byteLength
    const result = validateImageAttachment(data, 'image/png', CAPS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.attachment.byteSize).toBe(expectedBytes)
  })
})
