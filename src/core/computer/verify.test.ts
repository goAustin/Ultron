/**
 * v3 Phase 4·2 — unit tests for `verify`.
 *
 * Tests the four signal-availability quadrants and the verdict combinator.
 */

import { describe, it, expect } from 'vitest'

import { encodePng } from './pngCodec.js'
import { verify } from './verify.js'

function solidPng(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = 255
  }
  return encodePng(w, h, rgba)
}

function checkerPng(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4
      const dark = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0
      const v = dark ? 0 : 255
      rgba[off] = v
      rgba[off + 1] = v
      rgba[off + 2] = v
      rgba[off + 3] = 255
    }
  }
  return encodePng(w, h, rgba)
}

describe('verify', () => {
  describe('aria signal alone', () => {
    it('aria changed → verified=true', () => {
      const r = verify(
        { ariaHash: 'aaaa', pngBuffer: null },
        { ariaHash: 'bbbb', pngBuffer: null },
      )
      expect(r.verified).toBe(true)
      expect(r.signals.aria).toEqual({
        availability: 'available',
        changed: true,
        evidence: 'aria hash changed (aaaa → bbbb)',
      })
      expect(r.signals.pHash.availability).toBe('unavailable')
    })

    it('aria identical → verified=false', () => {
      const r = verify(
        { ariaHash: 'aaaa', pngBuffer: null },
        { ariaHash: 'aaaa', pngBuffer: null },
      )
      expect(r.verified).toBe(false)
      expect(r.signals.aria.changed).toBe(false)
    })
  })

  describe('pHash signal alone', () => {
    it('different pixels → verified=true', () => {
      const before = solidPng(64, 64, 0, 0, 0)
      const after = checkerPng(64, 64)
      const r = verify(
        { ariaHash: null, pngBuffer: before },
        { ariaHash: null, pngBuffer: after },
      )
      expect(r.verified).toBe(true)
      expect(r.signals.pHash.changed).toBe(true)
    })

    it('identical pixels → verified=false', () => {
      const png = solidPng(64, 64, 100, 100, 100)
      const r = verify(
        { ariaHash: null, pngBuffer: png },
        { ariaHash: null, pngBuffer: png },
      )
      expect(r.verified).toBe(false)
      expect(r.signals.pHash.changed).toBe(false)
    })
  })

  describe('combined signals', () => {
    it('both unchanged → verified=false (the overlay-blocked-click case)', () => {
      const png = checkerPng(64, 64)
      const r = verify(
        { ariaHash: 'h1', pngBuffer: png },
        { ariaHash: 'h1', pngBuffer: png },
      )
      expect(r.verified).toBe(false)
      expect(r.signals.aria.changed).toBe(false)
      expect(r.signals.pHash.changed).toBe(false)
    })

    it('aria same but pixels different (canvas/image swap) → verified=true', () => {
      const r = verify(
        { ariaHash: 'h1', pngBuffer: solidPng(64, 64, 0, 0, 0) },
        { ariaHash: 'h1', pngBuffer: checkerPng(64, 64) },
      )
      expect(r.verified).toBe(true)
      expect(r.signals.aria.changed).toBe(false)
      expect(r.signals.pHash.changed).toBe(true)
    })

    it('aria different but pixels identical (rare but possible) → verified=true', () => {
      const png = checkerPng(64, 64)
      const r = verify(
        { ariaHash: 'h1', pngBuffer: png },
        { ariaHash: 'h2', pngBuffer: png },
      )
      expect(r.verified).toBe(true)
      expect(r.signals.aria.changed).toBe(true)
      expect(r.signals.pHash.changed).toBe(false)
    })
  })

  describe('all signals unavailable', () => {
    it('verified=false; both signals unavailable', () => {
      const r = verify(
        { ariaHash: null, pngBuffer: null },
        { ariaHash: null, pngBuffer: null },
      )
      expect(r.verified).toBe(false)
      expect(r.signals.aria.availability).toBe('unavailable')
      expect(r.signals.pHash.availability).toBe('unavailable')
    })
  })

  describe('pHash threshold tuning', () => {
    it('respects a custom pHashThreshold', () => {
      const before = solidPng(64, 64, 0, 0, 0)
      const after = checkerPng(64, 64)
      // With an absurdly high threshold, even very different images score "unchanged."
      const r = verify(
        { ariaHash: null, pngBuffer: before },
        { ariaHash: null, pngBuffer: after },
        { pHashThreshold: 100 },
      )
      expect(r.signals.pHash.changed).toBe(false)
    })
  })

  describe('malformed pHash input', () => {
    it('marks the signal unavailable when decode fails — verdict still computable', () => {
      const garbage = new Uint8Array([1, 2, 3, 4, 5])
      const r = verify(
        { ariaHash: 'h1', pngBuffer: garbage },
        { ariaHash: 'h2', pngBuffer: garbage },
      )
      // ARIA differed → verdict still verified=true
      expect(r.verified).toBe(true)
      expect(r.signals.pHash.availability).toBe('unavailable')
      expect(r.signals.pHash.evidence).toContain('pHash failed')
    })
  })
})
