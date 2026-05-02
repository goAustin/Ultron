import { describe, expect, it } from 'vitest'

import {
  normalizedToCssPx,
  pixelToNormalized,
  validateNormalizedPoint,
} from './coordinates.js'
import type { ComputerDisplaySize, ComputerViewport } from './types.js'

const xga: ComputerViewport = { width: 1024, height: 768, deviceScaleFactor: 1 }
const xgaDsf2: ComputerViewport = { width: 1024, height: 768, deviceScaleFactor: 2 }
const wxga: ComputerViewport = { width: 1280, height: 800, deviceScaleFactor: 1 }
const xgaDisplay: ComputerDisplaySize = { width: 1024, height: 768 }
const wxgaDisplay: ComputerDisplaySize = { width: 1280, height: 800 }

describe('validateNormalizedPoint', () => {
  it('accepts (0, 0)', () => {
    const r = validateNormalizedPoint({ x: 0, y: 0 })
    expect(r).toEqual({ ok: true, point: { x: 0, y: 0 } })
  })

  it('accepts (1, 1)', () => {
    const r = validateNormalizedPoint({ x: 1, y: 1 })
    expect(r).toEqual({ ok: true, point: { x: 1, y: 1 } })
  })

  it('accepts (0.5, 0.5)', () => {
    const r = validateNormalizedPoint({ x: 0.5, y: 0.5 })
    expect(r).toEqual({ ok: true, point: { x: 0.5, y: 0.5 } })
  })

  it('rejects (-0.0001, 0)', () => {
    const r = validateNormalizedPoint({ x: -0.0001, y: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('out_of_range')
  })

  it('rejects (1.0001, 0)', () => {
    const r = validateNormalizedPoint({ x: 1.0001, y: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('out_of_range')
  })

  it('rejects NaN', () => {
    const r = validateNormalizedPoint({ x: NaN, y: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_finite')
  })

  it('rejects Infinity', () => {
    const r = validateNormalizedPoint({ x: Infinity, y: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_finite')
  })

  it('rejects -Infinity', () => {
    const r = validateNormalizedPoint({ x: -Infinity, y: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_finite')
  })

  it('rejects missing x', () => {
    const r = validateNormalizedPoint({ y: 0.5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing_field')
  })

  it('rejects missing y', () => {
    const r = validateNormalizedPoint({ x: 0.5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing_field')
  })

  it('rejects string fields', () => {
    const r = validateNormalizedPoint({ x: '0.5', y: '0.5' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('wrong_type')
  })

  it('rejects null', () => {
    const r = validateNormalizedPoint(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_an_object')
  })

  it('rejects array', () => {
    const r = validateNormalizedPoint([0.5, 0.5])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_an_object')
  })

  it('rejects primitives', () => {
    const r = validateNormalizedPoint(0.5)
    expect(r.ok).toBe(false)
  })
})

describe('normalizedToCssPx', () => {
  it('maps (0, 0) to (0, 0)', () => {
    expect(normalizedToCssPx({ x: 0, y: 0 }, xga)).toEqual({ x: 0, y: 0 })
  })

  it('maps (1, 1) to (W-1, H-1)', () => {
    expect(normalizedToCssPx({ x: 1, y: 1 }, xga)).toEqual({ x: 1023, y: 767 })
  })

  it('maps (0.5, 0.5) to centered coordinates', () => {
    expect(normalizedToCssPx({ x: 0.5, y: 0.5 }, xga)).toEqual({
      x: Math.round(0.5 * 1023),
      y: Math.round(0.5 * 767),
    })
  })

  it('ignores deviceScaleFactor (CSS px is what page.mouse uses)', () => {
    expect(normalizedToCssPx({ x: 0.5, y: 0.5 }, xga)).toEqual(
      normalizedToCssPx({ x: 0.5, y: 0.5 }, xgaDsf2),
    )
  })

  it('uses viewport dimensions, not displaySize', () => {
    // For 1280x800 viewport, x=1 -> 1279, not 1023.
    expect(normalizedToCssPx({ x: 1, y: 1 }, wxga)).toEqual({ x: 1279, y: 799 })
  })
})

describe('pixelToNormalized', () => {
  it('maps (0, 0) to (0, 0)', () => {
    const r = pixelToNormalized({ x: 0, y: 0 }, xgaDisplay)
    expect(r).toEqual({ ok: true, point: { x: 0, y: 0 } })
  })

  it('maps (W-1, H-1) to (1, 1)', () => {
    const r = pixelToNormalized({ x: 1023, y: 767 }, xgaDisplay)
    expect(r).toEqual({ ok: true, point: { x: 1, y: 1 } })
  })

  it('rejects W (off-by-one out of bounds)', () => {
    const r = pixelToNormalized({ x: 1024, y: 0 }, xgaDisplay)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('out_of_range')
  })

  it('rejects negative pixel coords', () => {
    const r = pixelToNormalized({ x: -1, y: 0 }, xgaDisplay)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('out_of_range')
  })

  it('rejects NaN', () => {
    const r = pixelToNormalized({ x: NaN, y: 0 }, xgaDisplay)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_finite')
  })

  it('rejects Infinity', () => {
    const r = pixelToNormalized({ x: Infinity, y: 0 }, xgaDisplay)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_finite')
  })

  it('rejects 1x1 displaySize (would divide by zero)', () => {
    const r = pixelToNormalized({ x: 0, y: 0 }, { width: 1, height: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('out_of_range')
      expect(r.message).toContain('too small')
    }
  })

  it('rejects 1xN displaySize where width is degenerate', () => {
    const r = pixelToNormalized({ x: 0, y: 0 }, { width: 1, height: 768 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('out_of_range')
  })

  it('accepts 2x2 displaySize (smallest non-degenerate)', () => {
    expect(pixelToNormalized({ x: 0, y: 0 }, { width: 2, height: 2 })).toEqual({
      ok: true,
      point: { x: 0, y: 0 },
    })
    expect(pixelToNormalized({ x: 1, y: 1 }, { width: 2, height: 2 })).toEqual({
      ok: true,
      point: { x: 1, y: 1 },
    })
  })
})

describe('round-trip pixel -> normalized -> CSS px', () => {
  // Test grid: combinations of (displaySize, viewport, dsf, sample pixels).
  // This is the test the v3 plan calls out (line 778):
  // "round-trip pixel -> NormalizedPoint -> CSS px under DSF=1, DSF=2,
  //  viewport-resize between observe and act".
  const cases: Array<{
    name: string
    display: ComputerDisplaySize
    viewport: ComputerViewport
  }> = [
    { name: 'XGA, DSF=1, viewport === display', display: xgaDisplay, viewport: xga },
    { name: 'XGA, DSF=2, viewport === display', display: xgaDisplay, viewport: xgaDsf2 },
    {
      name: 'WXGA display, XGA viewport (decoupled)',
      display: wxgaDisplay,
      viewport: xga,
    },
    {
      name: 'XGA display, WXGA viewport (decoupled)',
      display: xgaDisplay,
      viewport: wxga,
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const samplePixels = [
        { x: 0, y: 0 },
        { x: c.display.width - 1, y: c.display.height - 1 },
        { x: Math.floor((c.display.width - 1) / 2), y: Math.floor((c.display.height - 1) / 2) },
        { x: Math.floor((c.display.width - 1) / 4), y: Math.floor((c.display.height - 1) / 3) },
      ]
      for (const px of samplePixels) {
        const norm = pixelToNormalized(px, c.display)
        expect(norm.ok).toBe(true)
        if (!norm.ok) continue
        const css = normalizedToCssPx(norm.point, c.viewport)
        // When viewport === display (modulo DSF), round-trip must be exact.
        if (
          c.viewport.width === c.display.width &&
          c.viewport.height === c.display.height
        ) {
          expect(css.x).toBe(px.x)
          expect(css.y).toBe(px.y)
        } else {
          // Decoupled: must stay within 1 pixel rounding error.
          const expectedX = Math.round((px.x / (c.display.width - 1)) * (c.viewport.width - 1))
          const expectedY = Math.round((px.y / (c.display.height - 1)) * (c.viewport.height - 1))
          expect(Math.abs(css.x - expectedX)).toBeLessThanOrEqual(0)
          expect(Math.abs(css.y - expectedY)).toBeLessThanOrEqual(0)
          expect(css.x).toBeGreaterThanOrEqual(0)
          expect(css.x).toBeLessThanOrEqual(c.viewport.width - 1)
          expect(css.y).toBeGreaterThanOrEqual(0)
          expect(css.y).toBeLessThanOrEqual(c.viewport.height - 1)
        }
      }
    })
  }
})
