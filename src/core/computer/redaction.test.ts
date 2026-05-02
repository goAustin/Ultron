/**
 * v3 Phase 4·2 — unit tests for redaction helpers.
 */

import { describe, it, expect } from 'vitest'

import { blackoutRegions, buildSelectorList, SENSITIVE_SELECTORS } from './redaction.js'
import { decodePng, encodePng } from './pngCodec.js'
import type { BoundingBox } from './ariaSnapshot.js'

function whitePng(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 255
    rgba[i * 4 + 1] = 255
    rgba[i * 4 + 2] = 255
    rgba[i * 4 + 3] = 255
  }
  return encodePng(w, h, rgba)
}

function isBlack(rgba: Uint8Array, x: number, y: number, w: number): boolean {
  const off = (y * w + x) * 4
  return rgba[off] === 0 && rgba[off + 1] === 0 && rgba[off + 2] === 0 && rgba[off + 3] === 255
}

function isWhite(rgba: Uint8Array, x: number, y: number, w: number): boolean {
  const off = (y * w + x) * 4
  return rgba[off] === 255 && rgba[off + 1] === 255 && rgba[off + 2] === 255 && rgba[off + 3] === 255
}

describe('SENSITIVE_SELECTORS', () => {
  it('includes the password / tel / autocomplete / name patterns mirrored from ariaSnapshot.isSensitiveNode', () => {
    expect(SENSITIVE_SELECTORS).toContain('input[type="password"]')
    expect(SENSITIVE_SELECTORS).toContain('input[type="tel"]')
    expect(SENSITIVE_SELECTORS).toContain('input[autocomplete~="cc-number" i]')
    expect(SENSITIVE_SELECTORS).toContain('input[autocomplete~="one-time-code" i]')
    expect(SENSITIVE_SELECTORS).toContain('input[name*="ssn" i]')
  })
})

describe('buildSelectorList', () => {
  it('returns the built-ins when no extras are provided', () => {
    expect(buildSelectorList([])).toEqual(SENSITIVE_SELECTORS)
  })

  it('appends valid extras', () => {
    const list = buildSelectorList(['.my-secret-input', '#card-number-internal'])
    expect(list).toContain('.my-secret-input')
    expect(list).toContain('#card-number-internal')
    expect(list.length).toBe(SENSITIVE_SELECTORS.length + 2)
  })

  it('skips empty / whitespace-only extras', () => {
    const list = buildSelectorList(['', '   ', '.real'])
    expect(list).toContain('.real')
    expect(list.length).toBe(SENSITIVE_SELECTORS.length + 1)
  })

  it('trims surrounding whitespace from extras', () => {
    const list = buildSelectorList(['  .padded  '])
    expect(list).toContain('.padded')
  })
})

describe('blackoutRegions', () => {
  it('blacks out a single bbox; pixels outside stay unchanged', () => {
    const png = whitePng(32, 32)
    const bbox: BoundingBox = { x: 10, y: 10, width: 12, height: 8 }
    const out = blackoutRegions(png, [bbox])
    const decoded = decodePng(out)
    expect(decoded.width).toBe(32)
    expect(decoded.height).toBe(32)
    // Inside the bbox: black
    expect(isBlack(decoded.rgba, 10, 10, 32)).toBe(true)
    expect(isBlack(decoded.rgba, 21, 17, 32)).toBe(true)
    // Outside the bbox: still white
    expect(isWhite(decoded.rgba, 0, 0, 32)).toBe(true)
    expect(isWhite(decoded.rgba, 31, 31, 32)).toBe(true)
    expect(isWhite(decoded.rgba, 9, 10, 32)).toBe(true) // 1px to the left
    expect(isWhite(decoded.rgba, 22, 10, 32)).toBe(true) // 1px to the right
  })

  it('blacks out multiple bboxes', () => {
    const png = whitePng(32, 32)
    const bboxes: BoundingBox[] = [
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 28, y: 28, width: 4, height: 4 },
    ]
    const out = blackoutRegions(png, bboxes)
    const decoded = decodePng(out)
    expect(isBlack(decoded.rgba, 0, 0, 32)).toBe(true)
    expect(isBlack(decoded.rgba, 31, 31, 32)).toBe(true)
    expect(isWhite(decoded.rgba, 16, 16, 32)).toBe(true)
  })

  it('clips out-of-bounds bboxes to the image — no crash', () => {
    const png = whitePng(16, 16)
    const bbox: BoundingBox = { x: 12, y: 12, width: 100, height: 100 }
    const out = blackoutRegions(png, [bbox])
    const decoded = decodePng(out)
    // Bottom-right region clipped — pixels in [12,16) × [12,16) are black.
    expect(isBlack(decoded.rgba, 12, 12, 16)).toBe(true)
    expect(isBlack(decoded.rgba, 15, 15, 16)).toBe(true)
  })

  it('handles a bbox entirely outside the image — no-op', () => {
    const png = whitePng(16, 16)
    const bbox: BoundingBox = { x: 100, y: 100, width: 50, height: 50 }
    const out = blackoutRegions(png, [bbox])
    const decoded = decodePng(out)
    // Every pixel still white
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        expect(isWhite(decoded.rgba, x, y, 16)).toBe(true)
      }
    }
  })

  it('handles a bbox with negative origin — clipped', () => {
    const png = whitePng(16, 16)
    const bbox: BoundingBox = { x: -10, y: -10, width: 15, height: 15 }
    const out = blackoutRegions(png, [bbox])
    const decoded = decodePng(out)
    // Visible portion (x ∈ 0..5, y ∈ 0..5) should be black
    expect(isBlack(decoded.rgba, 0, 0, 16)).toBe(true)
    expect(isBlack(decoded.rgba, 4, 4, 16)).toBe(true)
    expect(isWhite(decoded.rgba, 5, 5, 16)).toBe(true)
  })

  it('handles a degenerate (zero-width or zero-height) bbox — no-op', () => {
    const png = whitePng(16, 16)
    const out = blackoutRegions(png, [{ x: 5, y: 5, width: 0, height: 8 }])
    const decoded = decodePng(out)
    expect(isWhite(decoded.rgba, 5, 5, 16)).toBe(true)
  })

  it('handles non-finite bbox values gracefully — clipped to (0,0)-(0,0), no-op', () => {
    const png = whitePng(16, 16)
    const out = blackoutRegions(png, [
      { x: NaN, y: NaN, width: NaN, height: NaN },
    ])
    const decoded = decodePng(out)
    expect(isWhite(decoded.rgba, 0, 0, 16)).toBe(true)
  })

  it('empty bbox list — returns a re-encoded PNG with all pixels intact', () => {
    const png = whitePng(8, 8)
    const out = blackoutRegions(png, [])
    const decoded = decodePng(out)
    for (let i = 0; i < 8 * 8; i++) {
      expect(decoded.rgba[i * 4]).toBe(255)
      expect(decoded.rgba[i * 4 + 3]).toBe(255)
    }
  })
})
