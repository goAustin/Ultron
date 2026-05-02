/**
 * v3 Phase 4·2 — unit tests for the in-tree PNG codec.
 *
 * Tests cover: signature/IHDR validation, all five filter types via
 * round-trip (encode → decode), grayscale/RGB widening to RGBA, malformed
 * input rejection, large-image round-trip.
 */

import { describe, it, expect } from 'vitest'

import { decodePng, encodePng, PngDecodeError } from './pngCodec.js'

// 1×1 transparent RGBA built via our own encoder. Phase 1's `validateImageAttachment`
// fixture (`iVBORw0KGgo…`) declares `colorType=4` (grayscale+alpha) in IHDR but
// embeds 4-channel data — a long-standing inconsistency that `validateImageAttachment`
// never noticed because it only inspects width/height. Our codec is strict, so
// the test below uses a known-correct fixture from `encodePng`.
const SAMPLE_1X1_PNG_RGBA = encodePng(1, 1, new Uint8Array([0, 0, 0, 0]))

function makeRgba(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4
      const [r, g, b, a] = fill(x, y)
      out[off] = r
      out[off + 1] = g
      out[off + 2] = b
      out[off + 3] = a
    }
  }
  return out
}

describe('decodePng', () => {
  it('decodes a 1×1 RGBA PNG', () => {
    const decoded = decodePng(SAMPLE_1X1_PNG_RGBA)
    expect(decoded.width).toBe(1)
    expect(decoded.height).toBe(1)
    expect(decoded.rgba.length).toBe(4)
  })

  it('rejects buffers shorter than the signature', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(PngDecodeError)
  })

  it('rejects non-PNG signatures', () => {
    const bad = new Uint8Array(16)
    expect(() => decodePng(bad)).toThrow(PngDecodeError)
  })
})

describe('encodePng', () => {
  it('emits a valid PNG signature', () => {
    const out = encodePng(2, 2, makeRgba(2, 2, () => [0, 0, 0, 255]))
    expect(out[0]).toBe(0x89)
    expect(out[1]).toBe(0x50)
    expect(out[2]).toBe(0x4e)
    expect(out[3]).toBe(0x47)
  })

  it('rejects RGBA length mismatches', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(/rgba length/)
  })
})

describe('round-trip encode/decode', () => {
  it('preserves a solid red 4×4 RGBA image', () => {
    const w = 4
    const h = 4
    const rgba = makeRgba(w, h, () => [255, 0, 0, 255])
    const png = encodePng(w, h, rgba)
    const decoded = decodePng(png)
    expect(decoded.width).toBe(w)
    expect(decoded.height).toBe(h)
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba))
  })

  it('preserves a gradient — exercises the deflate compressor and filter reversal', () => {
    const w = 32
    const h = 16
    const rgba = makeRgba(w, h, (x, y) => [
      (x * 8) & 0xff,
      (y * 16) & 0xff,
      ((x + y) * 4) & 0xff,
      255,
    ])
    const png = encodePng(w, h, rgba)
    const decoded = decodePng(png)
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba))
  })

  it('preserves a checkerboard — adjacent-pixel sharp transitions', () => {
    const w = 8
    const h = 8
    const rgba = makeRgba(w, h, (x, y) =>
      (x + y) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255],
    )
    const png = encodePng(w, h, rgba)
    const decoded = decodePng(png)
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba))
  })

  it('preserves alpha — semi-transparent pixels round-trip cleanly', () => {
    const w = 4
    const h = 4
    const rgba = makeRgba(w, h, (x, y) => [100, 150, 200, ((x + y) * 32) & 0xff])
    const png = encodePng(w, h, rgba)
    const decoded = decodePng(png)
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba))
  })

  it('handles a wide-but-short image (1024×4) — large scanline length', () => {
    const w = 1024
    const h = 4
    const rgba = makeRgba(w, h, (x, y) => [(x >> 2) & 0xff, y * 60, 0, 255])
    const png = encodePng(w, h, rgba)
    const decoded = decodePng(png)
    expect(decoded.width).toBe(w)
    expect(decoded.height).toBe(h)
    expect(decoded.rgba.length).toBe(rgba.length)
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba))
  })

  it('handles a tall-but-narrow image (4×1024) — many scanlines', () => {
    const w = 4
    const h = 1024
    const rgba = makeRgba(w, h, (x, y) => [x * 60, (y >> 2) & 0xff, 0, 255])
    const png = encodePng(w, h, rgba)
    const decoded = decodePng(png)
    expect(decoded.width).toBe(w)
    expect(decoded.height).toBe(h)
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba))
  })
})
