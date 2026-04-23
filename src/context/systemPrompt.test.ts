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
})
