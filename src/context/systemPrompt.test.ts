import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './systemPrompt.js'

describe('buildSystemPrompt', () => {
  const sections = buildSystemPrompt()
  const joined = sections
    .filter((s) => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .join('\n\n')

  it('returns a non-empty string array', () => {
    expect(Array.isArray(sections)).toBe(true)
    expect(sections.length).toBeGreaterThan(0)
    for (const s of sections) {
      expect(typeof s).toBe('string')
    }
  })

  it('contains the boundary marker', () => {
    expect(sections).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  })

  it('boundary marker is the last element (static only)', () => {
    expect(sections.at(-1)).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    // Not the first
    expect(sections[0]).not.toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
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
