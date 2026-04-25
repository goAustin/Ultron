import { describe, it, expect } from 'vitest'

import {
  filterToolDefs,
  makeActiveSkill,
  scanForActivation,
  summarizeMatches,
} from './router.js'
import type { Skill } from './skill.js'
import type { ApiToolDefinition } from '../core/tools/registry.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  const t = Date.parse('2026-04-24T00:00:00.000Z')
  return {
    schemaVersion: 1,
    id: 'sk',
    name: 'sk',
    description: 'd',
    content: 'plain body',
    createdAt: t,
    updatedAt: t,
    ...overrides,
  }
}

function makeDef(name: string): ApiToolDefinition {
  return {
    name,
    description: `${name} description`,
    input_schema: { type: 'object', properties: {}, required: [] },
  }
}

// ---------------------------------------------------------------------------
// scanForActivation
// ---------------------------------------------------------------------------

describe('scanForActivation', () => {
  it('clean body → ok', () => {
    const r = scanForActivation(makeSkill())
    expect(r).toEqual({ ok: true })
  })

  it('high-confidence pattern in body → kind=high', () => {
    const r = scanForActivation(
      makeSkill({ content: 'use AKIAABCDEFGHIJKLMNOP for s3 access' }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.kind).toBe('high')
    expect(r.matches.length).toBeGreaterThan(0)
    expect(r.matches[0]!.type).toBe('aws_access_key_id')
  })

  it('low-confidence pattern only → kind=low', () => {
    const r = scanForActivation(
      makeSkill({ content: 'config: api_key = "abcdef1234567890"' }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.kind).toBe('low')
    expect(r.matches.length).toBeGreaterThan(0)
  })

  it('mixed high + low → kind=high, matches contain only highs', () => {
    const r = scanForActivation(
      makeSkill({
        content:
          'aws AKIAABCDEFGHIJKLMNOP\npassword: "abcdef1234567890"',
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.kind).toBe('high')
    for (const m of r.matches) expect(m.confidence).toBe('high')
  })

  it('parity with write gate: same string scanned both places', () => {
    // serializeSkill includes frontmatter — a secret in a frontmatter
    // value (e.g. argumentHint) would be caught by the activation scan
    // even though `content` alone is clean.
    const r = scanForActivation(
      makeSkill({
        content: 'plain body',
        argumentHint: 'AKIAABCDEFGHIJKLMNOP',
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.kind).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// summarizeMatches
// ---------------------------------------------------------------------------

describe('summarizeMatches', () => {
  it('joins distinct types with comma + space', () => {
    expect(
      summarizeMatches([
        { type: 'aws_access_key_id', confidence: 'high', index: 0, length: 20 },
        { type: 'aws_access_key_id', confidence: 'high', index: 30, length: 20 },
        { type: 'anthropic_api_key', confidence: 'high', index: 60, length: 50 },
      ]),
    ).toBe('aws_access_key_id, anthropic_api_key')
  })

  it('empty list → empty string', () => {
    expect(summarizeMatches([])).toBe('')
  })
})

// ---------------------------------------------------------------------------
// filterToolDefs
// ---------------------------------------------------------------------------

describe('filterToolDefs', () => {
  const defs = [makeDef('FileRead'), makeDef('FileWrite'), makeDef('Bash')]

  it('preserves source order', () => {
    expect(filterToolDefs(defs, ['Bash', 'FileRead']).map((d) => d.name)).toEqual([
      'FileRead',
      'Bash',
    ])
  })

  it('empty allowed → empty result (instruction-only)', () => {
    expect(filterToolDefs(defs, [])).toEqual([])
  })

  it('unknown tool name → not in result', () => {
    expect(filterToolDefs(defs, ['Nonexistent']).map((d) => d.name)).toEqual([])
  })

  it('empty defs → empty result', () => {
    expect(filterToolDefs([], ['FileRead'])).toEqual([])
  })

  it('returns a fresh array (does not mutate input)', () => {
    const filtered = filterToolDefs(defs, ['FileRead'])
    expect(filtered).not.toBe(defs)
    expect(defs).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// makeActiveSkill
// ---------------------------------------------------------------------------

describe('makeActiveSkill', () => {
  it('with allowedTools → snapshot includes the field', () => {
    const skill = makeSkill({ allowedTools: ['FileRead'] })
    const active = makeActiveSkill(skill, '<args>')
    expect(active.id).toBe('sk')
    expect(active.name).toBe('sk')
    expect(active.body).toBe('plain body')
    expect(active.allowedTools).toEqual(['FileRead'])
    expect(active.args).toBe('<args>')
    expect(active.activatedAt).toBeGreaterThan(0)
  })

  it('without allowedTools → snapshot omits the field (not [])', () => {
    const skill = makeSkill()
    const active = makeActiveSkill(skill, '')
    expect(active.allowedTools).toBeUndefined()
    expect('allowedTools' in active).toBe(false)
  })

  it('empty args is preserved', () => {
    const active = makeActiveSkill(makeSkill(), '')
    expect(active.args).toBe('')
  })

  it('captures content snapshot (independent of later skill mutation)', () => {
    const skill = makeSkill({ content: 'first' })
    const active = makeActiveSkill(skill, '')
    // ActiveSkill is readonly; the snapshot is a value copy of skill.content.
    expect(active.body).toBe('first')
  })

  it('snapshot is frozen — runtime mutation throws in strict mode', () => {
    const active = makeActiveSkill(makeSkill({ allowedTools: ['FileRead'] }), '')
    expect(Object.isFrozen(active)).toBe(true)
    expect(() => {
      ;(active as { args: string }).args = 'mutated'
    }).toThrow()
  })

  it('allowedTools array is frozen — push throws', () => {
    const active = makeActiveSkill(
      makeSkill({ allowedTools: ['FileRead'] }),
      '',
    )
    expect(active.allowedTools).toBeDefined()
    expect(Object.isFrozen(active.allowedTools)).toBe(true)
    expect(() => {
      ;(active.allowedTools as string[]).push('Bash')
    }).toThrow()
  })

  it('allowedTools is a defensive copy (not the original reference)', () => {
    const original = ['FileRead', 'Grep']
    const active = makeActiveSkill(
      makeSkill({ allowedTools: original }),
      '',
    )
    expect(active.allowedTools).toEqual(['FileRead', 'Grep'])
    expect(active.allowedTools).not.toBe(original)
  })
})
