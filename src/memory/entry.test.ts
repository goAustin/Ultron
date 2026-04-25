import { describe, it, expect } from 'vitest'

import {
  canRoundTrip,
  MEMORY_TYPES,
  parseEntryFile,
  quoteScalar,
  serializeEntry,
  unquoteScalar,
  validateId,
  type MemoryEntry,
} from './entry.js'

// ---------------------------------------------------------------------------
// validateId
// ---------------------------------------------------------------------------

describe('validateId', () => {
  it('accepts simple slugs', () => {
    expect(validateId('foo')).toBe(true)
    expect(validateId('foo-bar')).toBe(true)
    expect(validateId('foo_bar_42')).toBe(true)
    expect(validateId('a')).toBe(true)
    expect(validateId('0')).toBe(true)
  })

  it('rejects uppercase, dots, slashes, and traversal', () => {
    expect(validateId('Foo')).toBe(false)
    expect(validateId('foo.md')).toBe(false)
    expect(validateId('../foo')).toBe(false)
    expect(validateId('foo/bar')).toBe(false)
    expect(validateId('foo bar')).toBe(false)
  })

  it('rejects empty and over-long ids', () => {
    expect(validateId('')).toBe(false)
    expect(validateId('a'.repeat(65))).toBe(false)
    expect(validateId('a'.repeat(64))).toBe(true)
  })

  it('rejects leading hyphen or underscore', () => {
    expect(validateId('-foo')).toBe(false)
    expect(validateId('_foo')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// quoteScalar / unquoteScalar roundtrip
// ---------------------------------------------------------------------------

describe('quoteScalar + unquoteScalar', () => {
  const cases = [
    'plain',
    'has spaces',
    'colon: inside',
    'quote " inside',
    'backslash \\ inside',
    'newline\ninside',
    'tab\tinside',
    'cr\rinside',
    'unicode ✓',
    '',
    '---',
    '"leading quote',
    'trailing quote"',
  ]

  for (const s of cases) {
    it(`roundtrips ${JSON.stringify(s)}`, () => {
      const quoted = quoteScalar(s)
      expect(unquoteScalar(quoted)).toBe(s)
      expect(canRoundTrip(s)).toBe(true)
    })
  }

  it('quoted output is always single-line', () => {
    expect(quoteScalar('line1\nline2')).not.toContain('\n'[0])
    // The above is trivially true (quoteScalar replaces \n with \\n); assert
    // explicitly:
    expect(quoteScalar('line1\nline2')).toBe('"line1\\nline2"')
  })

  it('rejects unquoted strings', () => {
    expect(unquoteScalar('bare')).toBeNull()
    expect(unquoteScalar('"dangling')).toBeNull()
    expect(unquoteScalar('dangling"')).toBeNull()
    expect(unquoteScalar('')).toBeNull()
  })

  it('rejects raw newline inside quoted scalar', () => {
    expect(unquoteScalar('"line\nbreak"')).toBeNull()
  })

  it('rejects bad escape sequences', () => {
    expect(unquoteScalar('"\\x"')).toBeNull()
    expect(unquoteScalar('"\\u00"')).toBeNull() // short hex
    expect(unquoteScalar('"\\"')).toBeNull() // dangling backslash
  })

  it('accepts \\uXXXX escapes', () => {
    expect(unquoteScalar('"\\u0041"')).toBe('A')
    expect(unquoteScalar('"hi \\u263A"')).toBe('hi ☺')
  })
})

// ---------------------------------------------------------------------------
// serializeEntry + parseEntryFile
// ---------------------------------------------------------------------------

function sampleEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    schemaVersion: 1,
    id: 'sample',
    type: 'user',
    name: 'Sample',
    description: 'A sample entry',
    content: 'Body content here.',
    createdAt: Date.parse('2026-04-24T00:00:00.000Z'),
    updatedAt: Date.parse('2026-04-24T00:00:00.000Z'),
    ...overrides,
  }
}

describe('serializeEntry + parseEntryFile', () => {
  it('roundtrips every MemoryType', () => {
    for (const t of MEMORY_TYPES) {
      const entry = sampleEntry({ type: t, id: `id-${t}` })
      const raw = serializeEntry(entry)
      const parsed = parseEntryFile(entry.id, raw)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.entry).toEqual(entry)
    }
  })

  it('preserves content body verbatim including special chars', () => {
    const entry = sampleEntry({
      content: 'Line 1\nLine 2 with : colon\n---\nAnd a backtick: `x`',
    })
    const raw = serializeEntry(entry)
    const parsed = parseEntryFile(entry.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.entry.content).toBe(entry.content)
  })

  it('escapes name + description with special chars', () => {
    const entry = sampleEntry({
      name: 'Has "quotes" and : colon',
      description: 'Multi-\nline description',
    })
    const raw = serializeEntry(entry)
    // Frontmatter must not contain a literal newline inside the scalars.
    const frontmatter = raw.split('\n---\n')[0]
    expect(frontmatter.split('\n').length).toBe(7) // ---, 6 keys
    const parsed = parseEntryFile(entry.id, raw)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.entry.name).toBe(entry.name)
      expect(parsed.entry.description).toBe(entry.description)
    }
  })

  it('accepts CRLF line endings', () => {
    const entry = sampleEntry()
    const raw = serializeEntry(entry).replace(/\n/g, '\r\n')
    const parsed = parseEntryFile(entry.id, raw)
    expect(parsed.ok).toBe(true)
  })

  it('rejects missing required field', () => {
    const raw = [
      '---',
      'name: "x"',
      'description: "y"',
      'type: user',
      'schemaVersion: 1',
      'createdAt: "2026-04-24T00:00:00.000Z"',
      // updatedAt missing
      '---',
      '',
      'body',
    ].join('\n')
    const parsed = parseEntryFile('foo', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('missing_field')
  })

  it('rejects unknown type', () => {
    const raw = [
      '---',
      'name: "x"',
      'description: "y"',
      'type: bogus',
      'schemaVersion: 1',
      'createdAt: "2026-04-24T00:00:00.000Z"',
      'updatedAt: "2026-04-24T00:00:00.000Z"',
      '---',
      '',
      'body',
    ].join('\n')
    const parsed = parseEntryFile('foo', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_type')
  })

  it('rejects wrong schemaVersion', () => {
    const raw = [
      '---',
      'name: "x"',
      'description: "y"',
      'type: user',
      'schemaVersion: 2',
      'createdAt: "2026-04-24T00:00:00.000Z"',
      'updatedAt: "2026-04-24T00:00:00.000Z"',
      '---',
      '',
      'body',
    ].join('\n')
    const parsed = parseEntryFile('foo', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_type')
  })

  it('rejects missing opening fence', () => {
    const raw = 'name: "x"\n---\nbody'
    const parsed = parseEntryFile('foo', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_frontmatter')
  })

  it('rejects missing closing fence', () => {
    const raw = '---\nname: "x"\ndescription: "y"\n'
    const parsed = parseEntryFile('foo', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_frontmatter')
  })

  it('rejects unquoted string scalar in name', () => {
    const raw = [
      '---',
      'name: bare',
      'description: "y"',
      'type: user',
      'schemaVersion: 1',
      'createdAt: "2026-04-24T00:00:00.000Z"',
      'updatedAt: "2026-04-24T00:00:00.000Z"',
      '---',
      '',
      'body',
    ].join('\n')
    const parsed = parseEntryFile('foo', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_escape')
  })

  it('rejects invalid ISO date', () => {
    const raw = [
      '---',
      'name: "x"',
      'description: "y"',
      'type: user',
      'schemaVersion: 1',
      'createdAt: "not-a-date"',
      'updatedAt: "2026-04-24T00:00:00.000Z"',
      '---',
      '',
      'body',
    ].join('\n')
    const parsed = parseEntryFile('foo', raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('bad_escape')
  })

  it('ignores unknown extra keys', () => {
    const raw = [
      '---',
      'name: "x"',
      'description: "y"',
      'type: user',
      'schemaVersion: 1',
      'createdAt: "2026-04-24T00:00:00.000Z"',
      'updatedAt: "2026-04-24T00:00:00.000Z"',
      'extraneous: "whatever"',
      '---',
      '',
      'body',
    ].join('\n')
    const parsed = parseEntryFile('foo', raw)
    expect(parsed.ok).toBe(true)
  })
})
