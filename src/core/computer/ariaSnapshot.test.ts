/**
 * v3 Phase 4·1 — unit tests for `ariaSnapshot.ts`.
 *
 * Tests cover the pure utilities: serializeToYaml, hashTree/hashYaml,
 * findAtPoint, redactNodes, normalizedToFindPoint. The `extractAriaTreeInBrowser`
 * function is integration-tested via Playwright in
 * `playwrightBrowserSession.integration.test.ts`.
 */

import { describe, it, expect } from 'vitest'

import {
  buildSnapshot,
  findAtPoint,
  describeSensitiveSignal,
  hashTree,
  hashYaml,
  isSensitiveFieldType,
  isSensitiveNode,
  normalizedToFindPoint,
  redactNodes,
  serializeToYaml,
  type AriaNode,
  type BoundingBox,
} from './ariaSnapshot.js'

// Helper: minimal node factory for tests
function node(
  role: string,
  partial: Partial<AriaNode> = {},
): AriaNode {
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

function bbox(x: number, y: number, width: number, height: number): BoundingBox {
  return { x, y, width, height }
}

// ---------------------------------------------------------------------------
// serializeToYaml
// ---------------------------------------------------------------------------

describe('serializeToYaml', () => {
  it('renders a simple tree with role + name', () => {
    const tree = node('main', {
      children: [
        node('heading', { name: 'Settings' }),
        node('button', { name: 'Save' }),
      ],
    })
    const yaml = serializeToYaml(tree, { tokenBudget: Infinity })
    expect(yaml).toBe(
      [
        '- main',
        '  - heading "Settings"',
        '  - button "Save"',
      ].join('\n'),
    )
  })

  it('escapes embedded double quotes in names', () => {
    const tree = node('button', { name: 'Click "here"' })
    const yaml = serializeToYaml(tree, { tokenBudget: Infinity })
    expect(yaml).toBe('- button "Click \\"here\\""')
  })

  it('renders fieldType, disabled, focused as bracketed attrs', () => {
    const tree = node('form', {
      children: [
        node('textbox', { name: 'Email', fieldType: 'email' }),
        node('textbox', {
          name: 'Password',
          fieldType: 'password',
          disabled: true,
        }),
        node('button', { name: 'Sign in', focused: true }),
      ],
    })
    const yaml = serializeToYaml(tree, { tokenBudget: Infinity })
    expect(yaml).toContain('- textbox "Email" [type=email]')
    expect(yaml).toContain('- textbox "Password" [type=password, disabled]')
    expect(yaml).toContain('- button "Sign in" [focused]')
  })

  it('omits `type=text` (the default) from the attrs list', () => {
    const tree = node('textbox', { name: 'Search', fieldType: 'text' })
    const yaml = serializeToYaml(tree, { tokenBudget: Infinity })
    expect(yaml).toBe('- textbox "Search"')
  })

  it('truncates output at the token budget', () => {
    const big = node('main', {
      children: Array.from({ length: 100 }, (_, i) =>
        node('button', { name: `Button ${i}` }),
      ),
    })
    const yaml = serializeToYaml(big, { tokenBudget: 30 }) // ~120 chars
    expect(yaml).toContain('truncated for token budget')
    expect(yaml.length).toBeLessThan(200)
  })

  it('handles a node with no name', () => {
    const tree = node('group', {
      children: [node('button', { name: null })],
    })
    const yaml = serializeToYaml(tree, { tokenBudget: Infinity })
    expect(yaml).toBe('- group\n  - button')
  })
})

// ---------------------------------------------------------------------------
// hashYaml / hashTree
// ---------------------------------------------------------------------------

describe('hashYaml / hashTree', () => {
  it('produces a deterministic hash for the same input', () => {
    const tree = node('main', {
      children: [node('button', { name: 'Submit' })],
    })
    expect(hashTree(tree)).toBe(hashTree(tree))
  })

  it('produces different hashes for different trees', () => {
    const a = node('main', { children: [node('button', { name: 'Submit' })] })
    const b = node('main', { children: [node('button', { name: 'Cancel' })] })
    expect(hashTree(a)).not.toBe(hashTree(b))
  })

  it('hash is stable across two captures of structurally-identical trees', () => {
    // Two distinct AriaNode object graphs with identical content should hash
    // the same — the hash is over the YAML, not object identity.
    const a = node('main', { children: [node('button', { name: 'Submit' })] })
    const b = node('main', { children: [node('button', { name: 'Submit' })] })
    expect(hashTree(a)).toBe(hashTree(b))
  })

  it('hashYaml returns a 16-character hex string', () => {
    const h = hashYaml('- button "Submit"')
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })

  it('bbox differences do NOT change the hash (verify.ts wants ARIA-structure diff, not visual diff)', () => {
    const a = node('button', { name: 'Submit', bbox: bbox(0, 0, 100, 30) })
    const b = node('button', { name: 'Submit', bbox: bbox(50, 50, 100, 30) })
    expect(hashTree(a)).toBe(hashTree(b))
  })
})

// ---------------------------------------------------------------------------
// findAtPoint
// ---------------------------------------------------------------------------

describe('findAtPoint', () => {
  it('returns null when no node covers the point', () => {
    const tree = node('main', {
      children: [node('button', { name: 'Save', bbox: bbox(0, 0, 50, 20) })],
    })
    expect(findAtPoint(tree, { x: 200, y: 200 })).toBeNull()
  })

  it('returns the deepest node whose bbox contains the point', () => {
    const tree = node('main', {
      bbox: bbox(0, 0, 1000, 1000),
      children: [
        node('button', { name: 'Save', bbox: bbox(100, 100, 50, 20) }),
        node('button', { name: 'Delete', bbox: bbox(200, 100, 50, 20) }),
      ],
    })
    const hit = findAtPoint(tree, { x: 220, y: 110 })
    expect(hit?.name).toBe('Delete')
    expect(hit?.role).toBe('button')
  })

  it('skips nodes with null bbox even if the parent contains the point', () => {
    const tree = node('main', {
      bbox: bbox(0, 0, 1000, 1000),
      children: [
        node('group', {
          bbox: null,
          children: [node('button', { name: 'Save', bbox: bbox(100, 100, 50, 20) })],
        }),
      ],
    })
    const hit = findAtPoint(tree, { x: 110, y: 110 })
    expect(hit?.name).toBe('Save')
  })

  it('overlapping nodes — later child wins (later renders on top)', () => {
    const tree = node('main', {
      bbox: bbox(0, 0, 1000, 1000),
      children: [
        node('button', { name: 'Underneath', bbox: bbox(100, 100, 200, 50) }),
        node('button', { name: 'OnTop', bbox: bbox(150, 110, 50, 30) }),
      ],
    })
    const hit = findAtPoint(tree, { x: 175, y: 120 })
    expect(hit?.name).toBe('OnTop')
  })

  it('boundary inclusive — point exactly on the edge counts as inside', () => {
    const tree = node('button', { name: 'Edge', bbox: bbox(0, 0, 100, 100) })
    expect(findAtPoint(tree, { x: 100, y: 100 })?.name).toBe('Edge')
    expect(findAtPoint(tree, { x: 0, y: 0 })?.name).toBe('Edge')
  })
})

// ---------------------------------------------------------------------------
// redactNodes
// ---------------------------------------------------------------------------

describe('redactNodes', () => {
  it('redacts password fields', () => {
    const tree = node('form', {
      children: [
        node('textbox', { name: 'Email', fieldType: 'email' }),
        node('textbox', { name: 'hunter2', fieldType: 'password' }),
      ],
    })
    const redacted = redactNodes(tree)
    expect(redacted.children[0]?.name).toBe('Email')
    expect(redacted.children[1]?.name).toBe('[REDACTED]')
  })

  it('redacts tel fields', () => {
    const tree = node('form', {
      children: [node('textbox', { name: '+1 555-0100', fieldType: 'tel' })],
    })
    const redacted = redactNodes(tree)
    expect(redacted.children[0]?.name).toBe('[REDACTED]')
  })

  it('redacts cc-number / cc-csc / one-time-code fields disguised as type="text"', () => {
    // Real HTML: cc-number is `type="text" autocomplete="cc-number"` — no
    // dedicated input.type. Same for MFA codes.
    const tree = node('form', {
      children: [
        node('textbox', {
          name: '4111-1111-1111-1111',
          fieldType: 'text',
          autocomplete: 'cc-number',
        }),
        node('textbox', { name: '123', fieldType: 'text', autocomplete: 'cc-csc' }),
        node('textbox', { name: '484851', fieldType: 'text', autocomplete: 'one-time-code' }),
      ],
    })
    const redacted = redactNodes(tree)
    expect(redacted.children[0]?.name).toBe('[REDACTED]')
    expect(redacted.children[1]?.name).toBe('[REDACTED]')
    expect(redacted.children[2]?.name).toBe('[REDACTED]')
  })

  it('redacts ssn-style fields by name attribute', () => {
    const tree = node('form', {
      children: [
        node('textbox', { name: '123-45-6789', fieldType: 'text', fieldName: 'ssn' }),
        node('textbox', {
          name: '987-65-4321',
          fieldType: 'text',
          fieldName: 'social-security-number',
        }),
        node('textbox', { name: 'public', fieldType: 'text', fieldName: 'username' }),
      ],
    })
    const redacted = redactNodes(tree)
    expect(redacted.children[0]?.name).toBe('[REDACTED]')
    expect(redacted.children[1]?.name).toBe('[REDACTED]')
    expect(redacted.children[2]?.name).toBe('public')
  })

  it('autocomplete may carry multiple tokens — sensitive token in any position triggers redaction', () => {
    const tree = node('form', {
      children: [
        node('textbox', {
          name: '4111-1111-1111-1111',
          fieldType: 'text',
          autocomplete: 'shipping cc-number',
        }),
      ],
    })
    expect(redactNodes(tree).children[0]?.name).toBe('[REDACTED]')
  })

  it('respects extra predicates', () => {
    const tree = node('form', {
      children: [
        node('textbox', { name: 'top-secret', fieldType: 'text' }),
        node('textbox', { name: 'public', fieldType: 'text' }),
      ],
    })
    const redacted = redactNodes(tree, [(n) => n.name === 'top-secret'])
    expect(redacted.children[0]?.name).toBe('[REDACTED]')
    expect(redacted.children[1]?.name).toBe('public')
  })

  it('preserves non-name fields and tree shape', () => {
    const tree = node('form', {
      bbox: bbox(0, 0, 100, 100),
      children: [
        node('textbox', { name: 'secret', fieldType: 'password', bbox: bbox(10, 10, 80, 20) }),
      ],
    })
    const redacted = redactNodes(tree)
    expect(redacted.role).toBe('form')
    expect(redacted.bbox).toEqual(bbox(0, 0, 100, 100))
    expect(redacted.children[0]?.fieldType).toBe('password')
    expect(redacted.children[0]?.bbox).toEqual(bbox(10, 10, 80, 20))
  })
})

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

describe('buildSnapshot', () => {
  it('packages tree + yaml + hash together', () => {
    const tree = node('main', { children: [node('button', { name: 'OK' })] })
    const snap = buildSnapshot(tree, { tokenBudget: 4000 })
    expect(snap.tree).toBe(tree)
    expect(snap.yaml).toContain('button "OK"')
    expect(snap.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('hash reflects the YAML, so token-budget truncation changes the hash', () => {
    const big = node('main', {
      children: Array.from({ length: 50 }, (_, i) =>
        node('button', { name: `B${i}` }),
      ),
    })
    const full = buildSnapshot(big, { tokenBudget: Infinity })
    const tiny = buildSnapshot(big, { tokenBudget: 5 })
    expect(full.hash).not.toBe(tiny.hash)
  })
})

// ---------------------------------------------------------------------------
// normalizedToFindPoint
// ---------------------------------------------------------------------------

describe('normalizedToFindPoint', () => {
  it('maps (0,0) to (0,0)', () => {
    expect(
      normalizedToFindPoint({ x: 0, y: 0 }, { width: 1024, height: 768, deviceScaleFactor: 1 }),
    ).toEqual({ x: 0, y: 0 })
  })

  it('maps (1,1) to (width-1, height-1)', () => {
    expect(
      normalizedToFindPoint({ x: 1, y: 1 }, { width: 1024, height: 768, deviceScaleFactor: 1 }),
    ).toEqual({ x: 1023, y: 767 })
  })

  it('rounds to the nearest pixel', () => {
    expect(
      normalizedToFindPoint({ x: 0.5, y: 0.5 }, { width: 100, height: 100, deviceScaleFactor: 1 }),
    ).toEqual({ x: 50, y: 50 })
  })
})

// ---------------------------------------------------------------------------
// isSensitiveFieldType
// ---------------------------------------------------------------------------

describe('isSensitiveFieldType (deprecated — narrow fieldType-only check)', () => {
  it('returns true for password and tel', () => {
    expect(isSensitiveFieldType('password')).toBe(true)
    expect(isSensitiveFieldType('tel')).toBe(true)
  })

  it('returns false for benign types', () => {
    expect(isSensitiveFieldType('text')).toBe(false)
    expect(isSensitiveFieldType('email')).toBe(false)
    expect(isSensitiveFieldType('search')).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isSensitiveFieldType(undefined)).toBe(false)
  })

  it('returns false for "creditcard" — there is no such input.type in the HTML spec', () => {
    expect(isSensitiveFieldType('creditcard')).toBe(false)
  })
})

describe('isSensitiveNode (richer detector)', () => {
  it('catches password / tel via fieldType', () => {
    expect(isSensitiveNode(node('textbox', { fieldType: 'password' }))).toBe(true)
    expect(isSensitiveNode(node('textbox', { fieldType: 'tel' }))).toBe(true)
  })

  it('catches cc-number / cc-csc / one-time-code via autocomplete (with type=text)', () => {
    expect(
      isSensitiveNode(node('textbox', { fieldType: 'text', autocomplete: 'cc-number' })),
    ).toBe(true)
    expect(
      isSensitiveNode(node('textbox', { fieldType: 'text', autocomplete: 'cc-csc' })),
    ).toBe(true)
    expect(
      isSensitiveNode(
        node('textbox', { fieldType: 'text', autocomplete: 'one-time-code' }),
      ),
    ).toBe(true)
  })

  it('catches current-password / new-password autocomplete', () => {
    expect(
      isSensitiveNode(node('textbox', { fieldType: 'text', autocomplete: 'current-password' })),
    ).toBe(true)
    expect(
      isSensitiveNode(node('textbox', { fieldType: 'text', autocomplete: 'new-password' })),
    ).toBe(true)
  })

  it('catches ssn-style fieldName patterns', () => {
    expect(isSensitiveNode(node('textbox', { fieldType: 'text', fieldName: 'ssn' }))).toBe(true)
    expect(
      isSensitiveNode(node('textbox', { fieldType: 'text', fieldName: 'social_security_number' })),
    ).toBe(true)
    expect(
      isSensitiveNode(node('textbox', { fieldType: 'text', fieldName: 'tax_id' })),
    ).toBe(true)
    expect(
      isSensitiveNode(node('textbox', { fieldType: 'text', fieldName: 'national-id' })),
    ).toBe(true)
  })

  it('returns false for benign fields', () => {
    expect(isSensitiveNode(node('textbox', { fieldType: 'text', fieldName: 'username' }))).toBe(
      false,
    )
    expect(isSensitiveNode(node('textbox', { fieldType: 'email', autocomplete: 'email' }))).toBe(
      false,
    )
  })
})

describe('describeSensitiveSignal', () => {
  it('returns the matching autocomplete token (most specific)', () => {
    expect(
      describeSensitiveSignal(
        node('textbox', { fieldType: 'text', autocomplete: 'cc-number' }),
      ),
    ).toBe('cc-number')
  })

  it('returns name:<value> when matched on fieldName', () => {
    expect(describeSensitiveSignal(node('textbox', { fieldType: 'text', fieldName: 'ssn' }))).toBe(
      'name:ssn',
    )
  })

  it('returns the input.type when matched on fieldType', () => {
    expect(describeSensitiveSignal(node('textbox', { fieldType: 'password' }))).toBe('password')
  })

  it('returns undefined for non-sensitive nodes', () => {
    expect(describeSensitiveSignal(node('textbox', { fieldType: 'text' }))).toBeUndefined()
  })
})
