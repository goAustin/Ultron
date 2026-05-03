/**
 * v3 Phase 4b — unit tests for `selectorCache.ts`.
 */

import { describe, it, expect } from 'vitest'

import { buildSnapshot, type AriaNode, type BoundingBox } from './ariaSnapshot.js'
import { buildAtomCache } from './selectorCache.js'

function node(role: string, partial: Partial<AriaNode> = {}): AriaNode {
  return {
    role,
    name: partial.name ?? null,
    bbox: partial.bbox ?? null,
    focused: partial.focused ?? false,
    disabled: partial.disabled ?? false,
    children: partial.children ?? [],
    ...(partial.fieldType !== undefined && { fieldType: partial.fieldType }),
    ...(partial.autocomplete !== undefined && { autocomplete: partial.autocomplete }),
    ...(partial.fieldName !== undefined && { fieldName: partial.fieldName }),
  }
}

function bbox(x: number, y: number, w: number, h: number): BoundingBox {
  return { x, y, width: w, height: h }
}

describe('buildAtomCache', () => {
  it('indexes entries by atomId', () => {
    const tree = node('main', {
      children: [
        node('button', { name: 'A' }),
        node('button', { name: 'B' }),
        node('button', { name: 'C' }),
      ],
    })
    const cache = buildAtomCache(buildSnapshot(tree), 'https://example.com/')
    expect(cache.entries.size).toBe(3)
    expect(cache.entries.get('a-0')?.locatorName).toBe('A')
    expect(cache.entries.get('a-1')?.locatorName).toBe('B')
    expect(cache.entries.get('a-2')?.locatorName).toBe('C')
  })

  it('records url + ariaHash', () => {
    const snap = buildSnapshot(node('main', { children: [node('button', { name: 'OK' })] }))
    const cache = buildAtomCache(snap, 'https://example.com/path')
    expect(cache.url).toBe('https://example.com/path')
    expect(cache.ariaHash).toBe(snap.hash)
  })

  it('returns undefined for unknown atomId', () => {
    const tree = node('main', { children: [node('button', { name: 'OK' })] })
    const cache = buildAtomCache(buildSnapshot(tree), '')
    expect(cache.entries.get('a-99')).toBeUndefined()
  })

  it('produces independent caches for differing snapshots (no implicit sharing)', () => {
    const treeA = node('main', { children: [node('button', { name: 'A' })] })
    const treeB = node('main', { children: [node('button', { name: 'B' })] })
    const cacheA = buildAtomCache(buildSnapshot(treeA), 'https://a.test/')
    const cacheB = buildAtomCache(buildSnapshot(treeB), 'https://b.test/')
    expect(cacheA.ariaHash).not.toBe(cacheB.ariaHash)
    expect(cacheA.entries.get('a-0')?.locatorName).toBe('A')
    expect(cacheB.entries.get('a-0')?.locatorName).toBe('B')
  })

  it('forwards sensitiveRegions to assignAtomIds (displayName redaction)', () => {
    const tree = node('main', {
      children: [
        node('button', { name: 'Card 4242', bbox: bbox(50, 100, 200, 40) }),
        node('button', { name: 'Other', bbox: bbox(0, 500, 50, 30) }),
      ],
    })
    const cache = buildAtomCache(buildSnapshot(tree), '', {
      sensitiveRegions: [bbox(40, 90, 220, 60)],
    })
    expect(cache.entries.get('a-0')?.displayName).toBe('[REDACTED]')
    expect(cache.entries.get('a-0')?.locatorName).toBe('Card 4242')
    expect(cache.entries.get('a-1')?.displayName).toBe('Other')
  })

  it('omits sensitiveRegions when not provided', () => {
    const tree = node('main', {
      children: [node('button', { name: 'Visible', bbox: bbox(0, 0, 100, 30) })],
    })
    const cache = buildAtomCache(buildSnapshot(tree), '')
    expect(cache.entries.get('a-0')?.displayName).toBe('Visible')
  })
})
