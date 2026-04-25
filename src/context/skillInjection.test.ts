import { describe, it, expect } from 'vitest'

import { buildSkillInjectionParts } from './skillInjection.js'
import type { ActiveSkill } from '../skills/router.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeActive(overrides: Partial<ActiveSkill> = {}): ActiveSkill {
  return {
    id: 'review-pr',
    name: 'review-pr',
    body: 'You are reviewing a pull request.',
    args: '',
    activatedAt: Date.parse('2026-04-24T00:00:00.000Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// null
// ---------------------------------------------------------------------------

describe('buildSkillInjectionParts', () => {
  it('null active → []', () => {
    expect(buildSkillInjectionParts(null)).toEqual([])
  })

  it('returns one org part', () => {
    const parts = buildSkillInjectionParts(makeActive())
    expect(parts).toHaveLength(1)
    expect(parts[0]!.cacheHint).toBe('org')
  })

  it('content is wrapped in <system-reminder>', () => {
    const [part] = buildSkillInjectionParts(makeActive())
    expect(part!.content.startsWith('<system-reminder>')).toBe(true)
    expect(part!.content.endsWith('</system-reminder>')).toBe(true)
  })

  it('content includes skill name + id', () => {
    const [part] = buildSkillInjectionParts(
      makeActive({ id: 'foo', name: 'Foo Skill' }),
    )
    expect(part!.content).toContain('Active skill: Foo Skill (id: foo)')
  })

  it('content includes the body verbatim under ## Instructions', () => {
    const [part] = buildSkillInjectionParts(
      makeActive({ body: 'do the thing\nthen verify' }),
    )
    expect(part!.content).toContain('## Instructions')
    expect(part!.content).toContain('do the thing\nthen verify')
  })

  it('trims trailing whitespace from body', () => {
    const [part] = buildSkillInjectionParts(
      makeActive({ body: 'body line\n\n\n' }),
    )
    // Body shows up exactly once, no trailing newlines bleeding into the
    // following section header.
    expect(part!.content).toContain('body line\n\n')
    expect(part!.content).not.toContain('body line\n\n\n')
  })
})

// ---------------------------------------------------------------------------
// args branch
// ---------------------------------------------------------------------------

describe('args block', () => {
  it('omitted when args is empty', () => {
    const [part] = buildSkillInjectionParts(makeActive({ args: '' }))
    expect(part!.content).not.toContain('## Activation arguments')
    expect(part!.content).not.toContain('<skill-args>')
  })

  it('present when args is non-empty', () => {
    const [part] = buildSkillInjectionParts(
      makeActive({ args: 'https://github.com/foo/bar/pull/1' }),
    )
    expect(part!.content).toContain('## Activation arguments')
    expect(part!.content).toContain(
      '<skill-args>\nhttps://github.com/foo/bar/pull/1\n</skill-args>',
    )
  })
})

// ---------------------------------------------------------------------------
// allowedTools branch
// ---------------------------------------------------------------------------

describe('tool scope block', () => {
  it('omitted when allowedTools is undefined', () => {
    const [part] = buildSkillInjectionParts(makeActive())
    expect(part!.content).not.toContain('## Tool scope')
    expect(part!.content).not.toContain('<allowed-tools>')
  })

  it('non-empty allowedTools renders allow list', () => {
    const [part] = buildSkillInjectionParts(
      makeActive({ allowedTools: ['FileRead', 'Grep', 'Glob'] }),
    )
    expect(part!.content).toContain('## Tool scope')
    expect(part!.content).toContain(
      'You may only call the following tools while this skill is active:',
    )
    expect(part!.content).toContain(
      '<allowed-tools>\n- FileRead\n- Grep\n- Glob\n</allowed-tools>',
    )
    expect(part!.content).toContain(
      'Calls to any other tool will be denied at the permission boundary.',
    )
  })

  it('empty allowedTools renders instruction-only language', () => {
    const [part] = buildSkillInjectionParts(
      makeActive({ allowedTools: [] }),
    )
    expect(part!.content).toContain('## Tool scope')
    expect(part!.content).toContain('instruction-only')
    expect(part!.content).toContain('You may not invoke any tools')
    // No <allowed-tools> tags in instruction-only mode.
    expect(part!.content).not.toContain('<allowed-tools>')
  })
})

// ---------------------------------------------------------------------------
// Branch combinations + stability
// ---------------------------------------------------------------------------

describe('combinations and stability', () => {
  it('args + allowedTools → both sections, args FIRST then tool scope', () => {
    const [part] = buildSkillInjectionParts(
      makeActive({
        args: '<arg>',
        allowedTools: ['FileRead'],
      }),
    )
    const argsIdx = part!.content.indexOf('## Activation arguments')
    const scopeIdx = part!.content.indexOf('## Tool scope')
    expect(argsIdx).toBeGreaterThan(0)
    expect(scopeIdx).toBeGreaterThan(0)
    expect(argsIdx).toBeLessThan(scopeIdx)
  })

  it('byte-identical output for identical input (cache stability)', () => {
    const a = makeActive({
      args: '<arg>',
      allowedTools: ['FileRead'],
    })
    const b = makeActive({
      args: '<arg>',
      allowedTools: ['FileRead'],
    })
    const [pa] = buildSkillInjectionParts(a)
    const [pb] = buildSkillInjectionParts(b)
    expect(pa!.content).toBe(pb!.content)
  })

  it('different active skills produce different content', () => {
    const [p1] = buildSkillInjectionParts(makeActive({ id: 'a', name: 'a' }))
    const [p2] = buildSkillInjectionParts(makeActive({ id: 'b', name: 'b' }))
    expect(p1!.content).not.toBe(p2!.content)
  })
})
