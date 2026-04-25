import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  validateAndNormalizeRules,
  compileWebPolicy,
  dedupeRules,
} from './rulesSeed.js'

describe('validateAndNormalizeRules', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('keeps valid entries', () => {
    const out = validateAndNormalizeRules([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'userSettings' },
    ])
    expect(out).toEqual([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'userSettings' },
    ])
  })

  it('lowercases the domain', () => {
    const out = validateAndNormalizeRules([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'GITHUB.COM' },
    ])
    expect(out[0].domain).toBe('github.com')
  })

  it('defaults missing source to userSettings', () => {
    const out = validateAndNormalizeRules([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'a.com' },
    ])
    expect(out[0].source).toBe('userSettings')
  })

  it('skips entry with invalid behavior', () => {
    const out = validateAndNormalizeRules([
      { toolName: 'WebFetch', behavior: 'maybe', domain: 'a.com' },
    ])
    expect(out).toHaveLength(0)
  })

  it('skips entry with invalid domain', () => {
    const out = validateAndNormalizeRules([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'not a host' },
    ])
    expect(out).toHaveLength(0)
  })

  it('skips entry missing toolName', () => {
    const out = validateAndNormalizeRules([{ behavior: 'allow', domain: 'a.com' }])
    expect(out).toHaveLength(0)
  })

  it('skips non-object entries', () => {
    const out = validateAndNormalizeRules([null, 42, 'string', { toolName: 'X', behavior: 'allow' }])
    expect(out).toHaveLength(1)
    expect(out[0].toolName).toBe('X')
  })

  it('one bad entry does not poison the rest', () => {
    const out = validateAndNormalizeRules([
      { toolName: 'WebFetch', behavior: 'BOGUS' },
      { toolName: 'WebFetch', behavior: 'allow', domain: 'good.com' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].domain).toBe('good.com')
  })
})

describe('compileWebPolicy', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('returns empty array for undefined policy', () => {
    expect(compileWebPolicy(undefined)).toEqual([])
  })

  it('compiles allowlist into WebFetch allow rules', () => {
    const out = compileWebPolicy({ allowlist: ['github.com', '*.docs.com'] })
    expect(out).toEqual([
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'userSettings' },
      { toolName: 'WebFetch', behavior: 'allow', domain: '*.docs.com', source: 'userSettings' },
    ])
  })

  it('compiles denylist into WebFetch deny rules', () => {
    const out = compileWebPolicy({ denylist: ['evil.com'] })
    expect(out).toEqual([
      { toolName: 'WebFetch', behavior: 'deny', domain: 'evil.com', source: 'userSettings' },
    ])
  })

  it('lowercases hosts', () => {
    const out = compileWebPolicy({ allowlist: ['GITHUB.COM'] })
    expect(out[0].domain).toBe('github.com')
  })

  it('skips invalid patterns', () => {
    const out = compileWebPolicy({ allowlist: ['valid.com', 'not a host'] })
    expect(out).toHaveLength(1)
    expect(out[0].domain).toBe('valid.com')
  })
})

describe('dedupeRules', () => {
  it('removes duplicates by (toolName, behavior, path, domain)', () => {
    const dup = { toolName: 'WebFetch', behavior: 'allow' as const, domain: 'a.com', source: 'userSettings' as const }
    const out = dedupeRules([dup, dup, { ...dup, domain: 'b.com' }])
    expect(out).toHaveLength(2)
  })

  it('keeps rules differing only by source if everything else matches', () => {
    // (toolName, behavior, path, domain) match → still considered dup.
    const a = { toolName: 'WebFetch', behavior: 'allow' as const, domain: 'a.com', source: 'session' as const }
    const b = { toolName: 'WebFetch', behavior: 'allow' as const, domain: 'a.com', source: 'userSettings' as const }
    const out = dedupeRules([a, b])
    // Source intentionally NOT part of the dedup key; first wins.
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('session')
  })

  it('treats path-only and domain-only rules as distinct', () => {
    const out = dedupeRules([
      { toolName: 'FileRead', behavior: 'allow', path: '/x', source: 'session' },
      { toolName: 'FileRead', behavior: 'allow', domain: 'x', source: 'session' },
    ])
    expect(out).toHaveLength(2)
  })
})
