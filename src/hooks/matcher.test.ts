import { describe, it, expect } from 'vitest'
import { hookMatches } from './matcher.js'
import type { HookDefinition } from './types.js'

function def(matcher: string): HookDefinition {
  return { matcher, command: 'noop' }
}

describe('hookMatches', () => {
  it('matches exact tool name', () => {
    expect(hookMatches(def('Bash'), 'Bash')).toBe(true)
    expect(hookMatches(def('Bash'), 'Read')).toBe(false)
  })

  it('matches wildcard', () => {
    expect(hookMatches(def('*'), 'Anything')).toBe(true)
    expect(hookMatches(def('*'), 'Bash')).toBe(true)
  })

  it('matches alternation', () => {
    expect(hookMatches(def('Write|Edit'), 'Write')).toBe(true)
    expect(hookMatches(def('Write|Edit'), 'Edit')).toBe(true)
    expect(hookMatches(def('Write|Edit'), 'Read')).toBe(false)
  })

  it('trims whitespace in alternation', () => {
    expect(hookMatches(def('Write | Edit'), 'Write')).toBe(true)
    expect(hookMatches(def('Write | Edit'), 'Edit')).toBe(true)
  })
})
