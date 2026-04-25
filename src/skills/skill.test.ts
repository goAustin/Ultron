import { describe, it, expect } from 'vitest'

import {
  canRoundTrip,
  ID_PATTERN,
  parseSkillFile,
  parseStringArray,
  quoteScalar,
  serializeSkill,
  unquoteScalar,
  validateId,
  type Skill,
} from './skill.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-04-24T12:00:00.000Z')
const T1 = Date.parse('2026-04-24T13:00:00.000Z')

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    schemaVersion: 1,
    id: 'sample',
    name: 'sample',
    description: 'a sample skill',
    content: 'Skill instructions go here.',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// validateId / ID_PATTERN
// ---------------------------------------------------------------------------

describe('validateId', () => {
  it('accepts lowercase slugs with digits, hyphens, underscores', () => {
    expect(validateId('review-pr')).toBe(true)
    expect(validateId('skill_1')).toBe(true)
    expect(validateId('a')).toBe(true)
    expect(validateId('0abc')).toBe(true)
  })

  it('rejects uppercase, leading hyphen, empty, too long', () => {
    expect(validateId('Review-PR')).toBe(false)
    expect(validateId('-leading')).toBe(false)
    expect(validateId('_leading')).toBe(false)
    expect(validateId('')).toBe(false)
    expect(validateId('a'.repeat(65))).toBe(false)
  })

  it('is bound to ID_PATTERN', () => {
    expect(ID_PATTERN.test('review-pr')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Quote / unquote / round-trip
// ---------------------------------------------------------------------------

describe('quoteScalar / unquoteScalar', () => {
  const cases: { name: string; value: string }[] = [
    { name: 'empty', value: '' },
    { name: 'ascii', value: 'hello world' },
    { name: 'backslash', value: 'a\\b' },
    { name: 'quote', value: 'a"b' },
    { name: 'newline', value: 'a\nb' },
    { name: 'cr', value: 'a\rb' },
    { name: 'tab', value: 'a\tb' },
    { name: 'control u0001', value: 'a\u0001b' },
    { name: 'unicode', value: 'café' },
  ]

  for (const c of cases) {
    it(`round-trips: ${c.name}`, () => {
      expect(unquoteScalar(quoteScalar(c.value))).toBe(c.value)
    })
  }

  it('returns null on unquoted input', () => {
    expect(unquoteScalar('no quotes')).toBe(null)
  })

  it('returns null on mismatched closing quote', () => {
    expect(unquoteScalar('"unterminated')).toBe(null)
  })

  it('returns null on embedded raw newline', () => {
    expect(unquoteScalar('"a\nb"')).toBe(null)
  })

  it('returns null on malformed \\u escape', () => {
    expect(unquoteScalar('"\\uZZZZ"')).toBe(null)
  })
})

describe('canRoundTrip', () => {
  it('true for encodable strings', () => {
    expect(canRoundTrip('hello')).toBe(true)
    expect(canRoundTrip('')).toBe(true)
    expect(canRoundTrip('with "quotes"')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseStringArray
// ---------------------------------------------------------------------------

describe('parseStringArray', () => {
  it('parses empty array variants', () => {
    expect(parseStringArray('[]')).toEqual([])
    expect(parseStringArray('[ ]')).toEqual([])
    expect(parseStringArray('  []  ')).toEqual([])
  })

  it('parses single-element', () => {
    expect(parseStringArray('["a"]')).toEqual(['a'])
  })

  it('parses multi-element with varying whitespace', () => {
    expect(parseStringArray('["a", "b"]')).toEqual(['a', 'b'])
    expect(parseStringArray('["a","b"]')).toEqual(['a', 'b'])
    expect(parseStringArray('[ "a" , "b" ]')).toEqual(['a', 'b'])
  })

  it('preserves escapes inside array elements', () => {
    expect(parseStringArray('["a\\nb"]')).toEqual(['a\nb'])
  })

  it('returns null on non-array inputs', () => {
    expect(parseStringArray('"a"')).toBe(null)
    expect(parseStringArray('[')).toBe(null)
    expect(parseStringArray('')).toBe(null)
  })

  it('returns null on unquoted elements', () => {
    expect(parseStringArray('[a]')).toBe(null)
    expect(parseStringArray('["a", b]')).toBe(null)
  })

  it('returns null on embedded raw newline', () => {
    expect(parseStringArray('["a\nb"]')).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// serializeSkill / parseSkillFile round-trip
// ---------------------------------------------------------------------------

describe('serialize + parse round-trip', () => {
  it('required-only fields', () => {
    const s = makeSkill()
    const raw = serializeSkill(s)
    const parsed = parseSkillFile(s.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill).toEqual(s)
    }
  })

  it('with allowed-tools set (non-empty)', () => {
    const s = makeSkill({ allowedTools: ['FileRead', 'Bash'] })
    const raw = serializeSkill(s)
    expect(raw).toContain('allowed-tools: ["FileRead", "Bash"]')
    const parsed = parseSkillFile(s.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.allowedTools).toEqual(['FileRead', 'Bash'])
    }
  })

  it('with allowed-tools set empty (distinct from undefined)', () => {
    const s = makeSkill({ allowedTools: [] })
    const raw = serializeSkill(s)
    expect(raw).toContain('allowed-tools: []')
    const parsed = parseSkillFile(s.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.allowedTools).toEqual([])
      expect(parsed.skill.allowedTools).not.toBeUndefined()
    }
  })

  it('without allowed-tools (omitted from output)', () => {
    const s = makeSkill()
    const raw = serializeSkill(s)
    expect(raw).not.toContain('allowed-tools')
    const parsed = parseSkillFile(s.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.allowedTools).toBeUndefined()
    }
  })

  it('with argument-hint', () => {
    const s = makeSkill({ argumentHint: '<pr-url>' })
    const raw = serializeSkill(s)
    const parsed = parseSkillFile(s.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.argumentHint).toBe('<pr-url>')
    }
  })

  it('emits bare scalar for simple names', () => {
    const s = makeSkill({ name: 'review-pr' })
    const raw = serializeSkill(s)
    expect(raw).toMatch(/^---\nname: review-pr\n/)
  })

  it('emits quoted scalar for strings with special chars', () => {
    const s = makeSkill({ description: 'has: colons, "quotes", and newlines\nhere' })
    const raw = serializeSkill(s)
    const parsed = parseSkillFile(s.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.description).toBe(s.description)
    }
  })

  it('preserves body bytes verbatim (including backticks, colons)', () => {
    const body = '# Heading\n\n```ts\nconst x: number = 1\n```\n'
    const s = makeSkill({ content: body })
    const raw = serializeSkill(s)
    const parsed = parseSkillFile(s.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.content).toBe(body)
    }
  })
})

// ---------------------------------------------------------------------------
// Hand-authored tolerance — missing optionals + stat fallback
// ---------------------------------------------------------------------------

describe('hand-authored tolerance', () => {
  it('parses with only name + description', () => {
    const raw =
      '---\n' +
      'name: hand-made\n' +
      'description: authored in $EDITOR\n' +
      '---\n\n' +
      'Body content.\n'
    const parsed = parseSkillFile('hand-made', raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.name).toBe('hand-made')
      expect(parsed.skill.description).toBe('authored in $EDITOR')
      expect(parsed.skill.schemaVersion).toBe(1)
      expect(parsed.skill.createdAt).toBe(0)
      expect(parsed.skill.updatedAt).toBe(0)
      expect(parsed.skill.content).toBe('Body content.\n')
    }
  })

  it('falls back to stat.mtimeMs when updatedAt is absent', () => {
    const raw =
      '---\nname: x\ndescription: y\n---\n\nbody\n'
    const parsed = parseSkillFile('x', raw, {
      birthtimeMs: 1000,
      mtimeMs: 2000,
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.createdAt).toBe(1000)
      expect(parsed.skill.updatedAt).toBe(2000)
    }
  })

  it('falls back to mtime for created when birthtime missing', () => {
    const raw =
      '---\nname: x\ndescription: y\n---\n\nbody\n'
    const parsed = parseSkillFile('x', raw, { mtimeMs: 2000 })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.createdAt).toBe(2000)
      expect(parsed.skill.updatedAt).toBe(2000)
    }
  })

  it('defaults schemaVersion to 1 when absent', () => {
    const raw =
      '---\nname: x\ndescription: y\n---\n\nbody\n'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.schemaVersion).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Parser failure modes
// ---------------------------------------------------------------------------

describe('parser failure modes', () => {
  it('missing opening --- → bad_frontmatter', () => {
    const parsed = parseSkillFile('x', 'name: foo\n---\nbody')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_frontmatter')
  })

  it('missing closing --- → bad_frontmatter', () => {
    const parsed = parseSkillFile('x', '---\nname: foo\ndescription: bar\n')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_frontmatter')
  })

  it('line without colon → bad_frontmatter', () => {
    const raw = '---\nname foo\ndescription: bar\n---\nbody'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_frontmatter')
  })

  it('missing name → missing_field', () => {
    const raw = '---\ndescription: only\n---\nbody'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('missing_field')
  })

  it('missing description → missing_field', () => {
    const raw = '---\nname: only\n---\nbody'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('missing_field')
  })

  it('schemaVersion: 2 → bad_type', () => {
    const raw =
      '---\nname: x\ndescription: y\nschemaVersion: 2\n---\nbody'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_type')
  })

  it('bad timestamp → bad_escape', () => {
    const raw =
      '---\nname: x\ndescription: y\nupdatedAt: "not-a-date"\n---\nbody'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_escape')
  })

  it('allowed-tools not an array → bad_allowed_tools', () => {
    const raw =
      '---\nname: x\ndescription: y\nallowed-tools: "FileRead"\n---\nbody'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_allowed_tools')
  })

  it('allowed-tools with non-string element → bad_allowed_tools', () => {
    const raw =
      '---\nname: x\ndescription: y\nallowed-tools: [1, 2]\n---\nbody'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_allowed_tools')
  })

  it('allowed-tools with empty string element → bad_allowed_tools', () => {
    const raw =
      '---\nname: x\ndescription: y\nallowed-tools: [""]\n---\nbody'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_allowed_tools')
  })

  it('allowed-tools element too long → bad_allowed_tools', () => {
    const long = 'a'.repeat(129)
    const raw =
      `---\nname: x\ndescription: y\nallowed-tools: ["${long}"]\n---\nbody`
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_allowed_tools')
  })

  it('argument-hint with embedded newline → bad_argument_hint', () => {
    const raw =
      '---\nname: x\ndescription: y\nargument-hint: "a\\nb"\n---\nbody'
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_argument_hint')
  })

  it('argument-hint too long → bad_argument_hint', () => {
    const long = 'a'.repeat(257)
    const raw =
      `---\nname: x\ndescription: y\nargument-hint: "${long}"\n---\nbody`
    const parsed = parseSkillFile('x', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_argument_hint')
  })
})

// ---------------------------------------------------------------------------
// Timestamp tracking on updates
// ---------------------------------------------------------------------------

describe('timestamp handling', () => {
  it('preserves distinct createdAt and updatedAt', () => {
    const s = makeSkill({ createdAt: T0, updatedAt: T1 })
    const raw = serializeSkill(s)
    const parsed = parseSkillFile(s.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.createdAt).toBe(T0)
      expect(parsed.skill.updatedAt).toBe(T1)
    }
  })
})
