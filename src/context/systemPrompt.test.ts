import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './systemPrompt.js'

describe('buildSystemPrompt', () => {
  const sections = buildSystemPrompt()
  const joined = sections.join('\n\n')

  it('returns a non-empty string array', () => {
    expect(Array.isArray(sections)).toBe(true)
    expect(sections.length).toBeGreaterThan(0)
    for (const s of sections) {
      expect(typeof s).toBe('string')
      expect(s.length).toBeGreaterThan(0)
    }
  })

  it('mentions Ultron', () => {
    expect(joined).toContain('Ultron')
  })

  it('does not mention Claude Code', () => {
    expect(joined).not.toContain('Claude Code')
  })

  it('mentions the 6 tools in usage guidance', () => {
    expect(joined).toContain('FileRead')
    expect(joined).toContain('FileEdit')
    expect(joined).toContain('FileWrite')
    expect(joined).toContain('Glob')
    expect(joined).toContain('Grep')
    expect(joined).toContain('Bash')
  })

  it('does not reference unbuilt features', () => {
    expect(joined).not.toContain('MCP')
    expect(joined).not.toContain('subagent')
    expect(joined).not.toContain('skill')
    expect(joined).not.toContain('memory')
    expect(joined).not.toContain('scratchpad')
    expect(joined).not.toContain('hooks')
  })

  // ---------------------------------------------------------------------------
  // v3 Phase 5 — Computer-Use guidance gating
  // ---------------------------------------------------------------------------

  describe('Computer-Use section gating', () => {
    it('omits the Computer-Use section by default', () => {
      const def = buildSystemPrompt()
      const text = def.join('\n\n')
      expect(text).not.toContain('# Computer-Use')
      expect(text).not.toContain('ComputerObserveActions')
      expect(text).not.toContain('<untrusted-page-text>')
    })

    it('omits the Computer-Use section when computerUseEnabled is false', () => {
      const off = buildSystemPrompt({ computerUseEnabled: false })
      const def = buildSystemPrompt()
      // Byte-identical to the no-arg default — the falsey path must not
      // perturb the preamble for users who never opt in.
      expect(off).toEqual(def)
    })

    it('appends exactly one extra section when computerUseEnabled is true', () => {
      const off = buildSystemPrompt()
      const on = buildSystemPrompt({ computerUseEnabled: true })
      expect(on.length).toBe(off.length + 1)
      // Extra section is appended at the end (preamble order preserved).
      expect(on.slice(0, off.length)).toEqual(off)
      expect(on[on.length - 1]).toContain('# Computer-Use')
    })

    it('Computer-Use section steers the model to WebSearch / WebFetch first', () => {
      const cu = buildSystemPrompt({ computerUseEnabled: true })[7]!
      expect(cu).toContain('WebSearch')
      expect(cu).toContain('WebFetch')
      // Routing intent — accept either "information gathering" or "research"-class wording.
      expect(/information gathering|reading public pages|factual lookup/i.test(cu)).toBe(true)
    })

    it('Computer-Use section names the DOM-first atom path tools', () => {
      const cu = buildSystemPrompt({ computerUseEnabled: true })[7]!
      expect(cu).toContain('ComputerObserveActions')
      expect(cu).toContain('ComputerActAtom')
      expect(cu).toContain('atom_resolution_failed')
    })

    it('Computer-Use section pins the normalized [0, 1] coordinate contract', () => {
      const cu = buildSystemPrompt({ computerUseEnabled: true })[7]!
      expect(cu).toContain('[0, 1]')
      expect(cu.toLowerCase()).toContain('never emit pixel')
    })

    it('Computer-Use section ships the untrusted-page-text rule for both text AND screenshots', () => {
      const cu = buildSystemPrompt({ computerUseEnabled: true })[7]!
      expect(cu).toContain('<untrusted-page-text>')
      // Screenshots are equally untrusted — vision models read text out of pixels.
      expect(cu.toLowerCase()).toContain('screenshot')
      expect(/inside (a )?screenshot/i.test(cu)).toBe(true)
    })

    it('Computer-Use section instructs stop-and-ask before irreversible actions', () => {
      const cu = buildSystemPrompt({ computerUseEnabled: true })[7]!
      expect(cu.toLowerCase()).toContain('stop and ask')
      // Mentions canonical irreversible-action verbs.
      expect(cu).toContain('Submit')
      expect(cu).toContain('Pay')
      expect(cu).toContain('Delete')
    })

    it('Computer-Use section instructs final-observation completion verification', () => {
      const cu = buildSystemPrompt({ computerUseEnabled: true })[7]!
      expect(cu.toLowerCase()).toContain('verify completion')
      expect(/final observation/i.test(cu)).toBe(true)
    })

    it('Computer-Use section warns to honor post-action verification WARNINGs', () => {
      const cu = buildSystemPrompt({ computerUseEnabled: true })[7]!
      expect(cu).toContain('WARNING')
      expect(cu.toLowerCase()).toContain('re-observe')
    })
  })
})
