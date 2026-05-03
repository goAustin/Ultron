/**
 * v3 Phase 4b — unit tests for `atomResolver.ts`.
 *
 * Pure module — no Playwright, no JSDOM. Fixture trees are constructed
 * directly via the `node()` factory.
 */

import { describe, it, expect } from 'vitest'

import {
  ACTIONABLE_ROLES,
  BBOX_TOLERANCE_PX,
  assignAtomIds,
  bboxesMatch,
  buildLocator,
  serializeAtoms,
  type AtomEntry,
} from './atomResolver.js'
import { buildSnapshot, type AriaNode, type BoundingBox } from './ariaSnapshot.js'

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

// ---------------------------------------------------------------------------
// ACTIONABLE_ROLES
// ---------------------------------------------------------------------------

describe('ACTIONABLE_ROLES', () => {
  it('includes typical interactive roles', () => {
    expect(ACTIONABLE_ROLES.has('button')).toBe(true)
    expect(ACTIONABLE_ROLES.has('link')).toBe(true)
    expect(ACTIONABLE_ROLES.has('textbox')).toBe(true)
    expect(ACTIONABLE_ROLES.has('combobox')).toBe(true)
    expect(ACTIONABLE_ROLES.has('checkbox')).toBe(true)
  })

  it('excludes observation-only roles from INTERESTING_ROLES', () => {
    expect(ACTIONABLE_ROLES.has('heading')).toBe(false)
    expect(ACTIONABLE_ROLES.has('main')).toBe(false)
    expect(ACTIONABLE_ROLES.has('navigation')).toBe(false)
    expect(ACTIONABLE_ROLES.has('list')).toBe(false)
    expect(ACTIONABLE_ROLES.has('listitem')).toBe(false)
    expect(ACTIONABLE_ROLES.has('img')).toBe(false)
    expect(ACTIONABLE_ROLES.has('form')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// assignAtomIds — DFS order + ACTIONABLE_ROLES filter
// ---------------------------------------------------------------------------

describe('assignAtomIds', () => {
  it('returns no entries on an empty tree', () => {
    const tree = node('group')
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries).toEqual([])
  })

  it('emits one entry per actionable node in DFS order', () => {
    const tree = node('main', {
      children: [
        node('heading', { name: 'Settings' }), // skipped — not actionable
        node('form', {
          name: 'Account',
          children: [
            node('textbox', { name: 'Email', bbox: bbox(0, 0, 100, 30) }),
            node('textbox', { name: 'Password', bbox: bbox(0, 40, 100, 30), fieldType: 'password' }),
            node('button', { name: 'Sign in', bbox: bbox(0, 80, 80, 30) }),
          ],
        }),
        node('link', { name: 'Forgot password?', bbox: bbox(0, 120, 100, 20) }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries.map((e) => `${e.atomId}:${e.role}:${e.locatorName}`)).toEqual([
      'a-0:textbox:Email',
      'a-1:textbox:Password',
      'a-2:button:Sign in',
      'a-3:link:Forgot password?',
    ])
  })

  it('skips heading / list / img — they are interesting but not actionable', () => {
    const tree = node('main', {
      children: [
        node('heading', { name: 'h1' }),
        node('list', {
          children: [node('listitem', { children: [node('img', { name: 'pic' })] })],
        }),
        node('button', { name: 'OK' }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.role).toBe('button')
  })

  it('assigns monotonic nth to duplicate (role, locatorName) pairs', () => {
    const tree = node('main', {
      children: [
        node('button', { name: 'Save' }),
        node('button', { name: 'Save' }),
        node('button', { name: 'Save' }),
        node('button', { name: 'Cancel' }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries.map((e) => `${e.locatorName}:${e.nth}`)).toEqual([
      'Save:0',
      'Save:1',
      'Save:2',
      'Cancel:0',
    ])
  })

  it('does not collide nth across distinct roles with the same name', () => {
    const tree = node('main', {
      children: [node('button', { name: 'Search' }), node('searchbox', { name: 'Search' })],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries).toHaveLength(2)
    expect(entries[0]?.nth).toBe(0)
    expect(entries[1]?.nth).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// hint computation
// ---------------------------------------------------------------------------

describe('hint computation', () => {
  it('uses the nearest named ancestor', () => {
    const tree = node('main', {
      children: [
        node('form', {
          name: 'Sign in',
          children: [node('textbox', { name: 'Email' })],
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries[0]?.hint).toBe('form: Sign in')
  })

  it('walks past unnamed ancestors to find a named one', () => {
    const tree = node('main', {
      children: [
        node('dialog', {
          name: 'Confirm delete',
          children: [
            node('group', {
              children: [node('button', { name: 'Delete' })],
            }),
          ],
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries[0]?.hint).toBe('dialog: Confirm delete')
  })

  it('returns no hint when no named ancestor exists', () => {
    const tree = node('main', {
      children: [node('button', { name: 'Click' })],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries[0]?.hint).toBeUndefined()
  })

  it('omits hint when the source ancestor matches a user sensitiveRegion', () => {
    // Form bbox is covered by a user region — child atom's hint must be omitted
    // rather than emit `hint: "form: <sensitive name>"`.
    const tree = node('main', {
      children: [
        node('form', {
          name: 'Payment details',
          bbox: bbox(0, 0, 400, 300),
          children: [node('button', { name: 'Confirm', bbox: bbox(50, 200, 100, 30) })],
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree), {
      sensitiveRegions: [bbox(0, 0, 400, 300)],
    })
    expect(entries[0]?.hint).toBeUndefined()
  })

  it('omits hint when the source ancestor matches isSensitiveNode (HTML semantic)', () => {
    // Synthetic ancestor that hits isSensitiveNode via fieldType=password.
    // (Real-world this would be unusual since password is normally on inputs,
    // but the symmetry is the point: any predicate that flags an ancestor
    // must propagate to hint omission.)
    const tree = node('main', {
      children: [
        node('group', {
          name: 'Outer',
          children: [
            node('form', {
              name: 'Card',
              fieldType: 'password',
              bbox: bbox(0, 0, 100, 100),
              children: [node('button', { name: 'Pay', bbox: bbox(0, 50, 80, 30) })],
            }),
          ],
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    // Hint would have been "form: Card" — must be omitted.
    expect(entries[0]?.hint).toBeUndefined()
  })

  it('keeps hint when ancestors are non-sensitive even with regions configured elsewhere', () => {
    // Region covers a different part of the page. Ancestor "form: Sign in"
    // is benign and outside the region → hint is preserved.
    const tree = node('main', {
      children: [
        node('form', {
          name: 'Sign in',
          bbox: bbox(0, 0, 400, 300),
          children: [node('button', { name: 'Submit', bbox: bbox(50, 200, 100, 30) })],
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree), {
      sensitiveRegions: [bbox(800, 800, 100, 100)],
    })
    expect(entries[0]?.hint).toBe('form: Sign in')
  })

  it('fail-closed: omits hint when source ancestor has null bbox AND user supplied any regions', () => {
    const tree = node('main', {
      children: [
        node('form', {
          name: 'NoBboxForm', // bbox unset
          children: [node('button', { name: 'X', bbox: bbox(0, 0, 30, 30) })],
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree), {
      sensitiveRegions: [bbox(0, 0, 10, 10)],
    })
    expect(entries[0]?.hint).toBeUndefined()
  })

  it('fail-closed off when user supplies no regions: ancestor with null bbox keeps its hint', () => {
    const tree = node('main', {
      children: [
        node('form', {
          name: 'NoBboxForm',
          children: [node('button', { name: 'X' })],
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries[0]?.hint).toBe('form: NoBboxForm')
  })
})

// ---------------------------------------------------------------------------
// displayName redaction
// ---------------------------------------------------------------------------

describe('displayName redaction', () => {
  it('redacts password fields via isSensitiveNode (HTML-semantic)', () => {
    const tree = node('main', {
      children: [
        node('textbox', { name: 'Password', fieldType: 'password' }),
        node('textbox', { name: 'Email', fieldType: 'text' }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries[0]?.displayName).toBe('[REDACTED]')
    expect(entries[1]?.displayName).toBe('Email')
  })

  it('redacts cc-number fields via autocomplete', () => {
    const tree = node('main', {
      children: [
        node('textbox', {
          name: 'Card number',
          fieldType: 'text',
          autocomplete: 'cc-number',
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries[0]?.displayName).toBe('[REDACTED]')
  })

  it('keeps locatorName raw regardless of redaction', () => {
    const tree = node('main', {
      children: [node('textbox', { name: 'Password', fieldType: 'password' })],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries[0]?.displayName).toBe('[REDACTED]')
    expect(entries[0]?.locatorName).toBe('Password')
  })

  it('redacts when the node bbox intersects a user sensitiveRegion', () => {
    const tree = node('main', {
      children: [
        node('button', { name: 'Card 4242 ending 4242', bbox: bbox(50, 100, 200, 40) }),
        node('button', { name: 'Other', bbox: bbox(0, 0, 50, 30) }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree), {
      sensitiveRegions: [bbox(40, 90, 220, 60)],
    })
    expect(entries[0]?.displayName).toBe('[REDACTED]')
    expect(entries[0]?.locatorName).toBe('Card 4242 ending 4242')
    expect(entries[1]?.displayName).toBe('Other')
  })

  it('does not redact when sensitiveRegions are empty', () => {
    const tree = node('main', {
      children: [node('button', { name: 'Visible', bbox: bbox(0, 0, 100, 30) })],
    })
    const entries = assignAtomIds(buildSnapshot(tree), { sensitiveRegions: [] })
    expect(entries[0]?.displayName).toBe('Visible')
  })

  it('fail-closed: redacts when bbox is null AND user supplied any regions', () => {
    const tree = node('main', {
      children: [node('button', { name: 'NoBbox' })],
    })
    const entries = assignAtomIds(buildSnapshot(tree), {
      sensitiveRegions: [bbox(0, 0, 10, 10)],
    })
    expect(entries[0]?.displayName).toBe('[REDACTED]')
  })

  it('keeps name when bbox is null and no user regions exist', () => {
    const tree = node('main', {
      children: [node('button', { name: 'NoBbox' })],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(entries[0]?.displayName).toBe('NoBbox')
  })
})

// ---------------------------------------------------------------------------
// buildLocator + bbox
// ---------------------------------------------------------------------------

describe('buildLocator', () => {
  it('round-trips role / locatorName / nth / expectedBbox', () => {
    const entry: AtomEntry = {
      atomId: 'a-7',
      role: 'button',
      displayName: 'Sign in',
      locatorName: 'Sign in',
      bbox: bbox(10, 20, 80, 30),
      node: node('button', { name: 'Sign in' }),
      ancestorPath: ['form:"Sign in"'],
      nth: 2,
    }
    const locator = buildLocator(entry)
    expect(locator).toEqual({
      role: 'button',
      locatorName: 'Sign in',
      nth: 2,
      expectedBbox: { x: 10, y: 20, width: 80, height: 30 },
    })
  })

  it('expectedBbox is null when entry has no bbox', () => {
    const entry: AtomEntry = {
      atomId: 'a-0',
      role: 'button',
      displayName: 'X',
      locatorName: 'X',
      node: node('button', { name: 'X' }),
      ancestorPath: [],
      nth: 0,
    }
    expect(buildLocator(entry).expectedBbox).toBeNull()
  })

  it('passes redacted display name through buildLocator unchanged for locatorName', () => {
    const entry: AtomEntry = {
      atomId: 'a-0',
      role: 'textbox',
      displayName: '[REDACTED]',
      locatorName: 'Password',
      node: node('textbox', { name: 'Password', fieldType: 'password' }),
      ancestorPath: [],
      nth: 0,
    }
    const locator = buildLocator(entry)
    expect(locator.locatorName).toBe('Password')
  })
})

// ---------------------------------------------------------------------------
// serializeAtoms
// ---------------------------------------------------------------------------

describe('serializeAtoms', () => {
  it('emits displayName, never locatorName', () => {
    const tree = node('main', {
      children: [
        node('form', {
          name: 'Sign in',
          children: [node('textbox', { name: 'Password', fieldType: 'password' })],
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    const yaml = serializeAtoms(entries)
    expect(yaml).toContain('name: "[REDACTED]"')
    expect(yaml).not.toContain('Password')
    expect(yaml).toContain('hint: "form: Sign in"')
  })

  it('includes id, role, name, hint fields per atom', () => {
    const tree = node('main', {
      children: [
        node('form', {
          name: 'F',
          children: [node('button', { name: 'OK' })],
        }),
      ],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(serializeAtoms(entries)).toBe(
      [
        '- id: a-0',
        '  role: button',
        '  name: "OK"',
        '  hint: "form: F"',
      ].join('\n'),
    )
  })

  it('uses null literal when displayName is null', () => {
    const tree = node('main', {
      children: [node('button', { name: null, bbox: bbox(0, 0, 30, 30) })],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(serializeAtoms(entries)).toContain('  name: null')
  })

  it('omits hint line when no named ancestor', () => {
    const tree = node('main', {
      children: [node('button', { name: 'X' })],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(serializeAtoms(entries)).not.toContain('hint:')
  })

  it('escapes embedded double-quotes', () => {
    const tree = node('main', {
      children: [node('button', { name: 'Click "here"' })],
    })
    const entries = assignAtomIds(buildSnapshot(tree))
    expect(serializeAtoms(entries)).toContain('name: "Click \\"here\\""')
  })

  it('falls back to a friendly message when no atoms', () => {
    expect(serializeAtoms([])).toBe('(no actionable atoms on this page)')
  })
})

// ---------------------------------------------------------------------------
// bboxesMatch
// ---------------------------------------------------------------------------

describe('bboxesMatch', () => {
  const ref = { x: 100, y: 200, width: 80, height: 30 }

  it('matches identical bboxes', () => {
    expect(bboxesMatch(ref, ref, BBOX_TOLERANCE_PX)).toBe(true)
  })

  it('matches within tolerance on each axis', () => {
    expect(bboxesMatch({ ...ref, x: ref.x + BBOX_TOLERANCE_PX }, ref, BBOX_TOLERANCE_PX)).toBe(true)
    expect(bboxesMatch({ ...ref, y: ref.y - BBOX_TOLERANCE_PX }, ref, BBOX_TOLERANCE_PX)).toBe(true)
    expect(bboxesMatch({ ...ref, width: ref.width + BBOX_TOLERANCE_PX }, ref, BBOX_TOLERANCE_PX)).toBe(true)
    expect(bboxesMatch({ ...ref, height: ref.height - BBOX_TOLERANCE_PX }, ref, BBOX_TOLERANCE_PX)).toBe(true)
  })

  it('rejects past tolerance on x', () => {
    expect(bboxesMatch({ ...ref, x: ref.x + BBOX_TOLERANCE_PX + 1 }, ref, BBOX_TOLERANCE_PX)).toBe(false)
  })

  it('rejects past tolerance on y', () => {
    expect(bboxesMatch({ ...ref, y: ref.y + BBOX_TOLERANCE_PX + 1 }, ref, BBOX_TOLERANCE_PX)).toBe(false)
  })

  it('rejects past tolerance on width', () => {
    expect(bboxesMatch({ ...ref, width: ref.width + BBOX_TOLERANCE_PX + 1 }, ref, BBOX_TOLERANCE_PX)).toBe(false)
  })

  it('rejects past tolerance on height', () => {
    expect(bboxesMatch({ ...ref, height: ref.height + BBOX_TOLERANCE_PX + 1 }, ref, BBOX_TOLERANCE_PX)).toBe(false)
  })

  it('rejects a wholly different bbox', () => {
    expect(bboxesMatch({ x: 500, y: 500, width: 50, height: 50 }, ref, BBOX_TOLERANCE_PX)).toBe(false)
  })
})
