import { describe, it, expect } from 'vitest'
import {
  MCP_TOOL_PREFIX,
  isValidServerName,
  qualifyToolName,
  parseQualifiedName,
  sanitizeToolName,
} from './namespacing.js'

describe('isValidServerName', () => {
  it.each(['github', 'fs', 'a', 'server-1', 'my-cool-server'])('accepts %s', (n) => {
    expect(isValidServerName(n)).toBe(true)
  })

  it.each([
    '',
    'Github',
    'my_server',
    'my.server',
    'my:server',
    '-leading',
    'a'.repeat(65),
    '1abc', // must start with letter/digit — digit is fine actually
  ])('rejects %s', (n) => {
    // '1abc' is actually valid per the regex ([a-z0-9] starts); keep the test
    // honest: reconfirm the expected shape.
    if (n === '1abc') {
      expect(isValidServerName(n)).toBe(true)
      return
    }
    expect(isValidServerName(n)).toBe(false)
  })
})

describe('qualifyToolName', () => {
  it('builds the mcp__<server>__<tool> shape', () => {
    expect(qualifyToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
  })
})

describe('parseQualifiedName', () => {
  it('round-trips a qualified name', () => {
    const q = qualifyToolName('github', 'create_issue')
    expect(parseQualifiedName(q)).toEqual({ serverName: 'github', toolName: 'create_issue' })
  })

  it('handles tool names with underscores', () => {
    const q = qualifyToolName('fs', 'read_file__v2')
    expect(parseQualifiedName(q)).toEqual({ serverName: 'fs', toolName: 'read_file__v2' })
  })

  it('returns null without the mcp__ prefix', () => {
    expect(parseQualifiedName('github__create_issue')).toBeNull()
  })

  it('returns null with only the prefix', () => {
    expect(parseQualifiedName(MCP_TOOL_PREFIX)).toBeNull()
  })

  it('returns null when the server segment is empty', () => {
    expect(parseQualifiedName('mcp____foo')).toBeNull()
  })

  it('returns null when the tool segment is empty', () => {
    expect(parseQualifiedName('mcp__github__')).toBeNull()
  })

  it('returns null when the server segment is invalid', () => {
    expect(parseQualifiedName('mcp__My_Server__foo')).toBeNull()
  })
})

describe('sanitizeToolName', () => {
  it('passes through valid names', () => {
    expect(sanitizeToolName('create_issue', 0)).toBe('create_issue')
  })

  it('replaces non-alphanumeric runs with a single underscore', () => {
    expect(sanitizeToolName('read-file', 0)).toBe('read_file')
    expect(sanitizeToolName('list.files', 0)).toBe('list_files')
  })

  it('collapses repeated underscores', () => {
    expect(sanitizeToolName('a___b', 0)).toBe('a_b')
  })

  it('strips leading and trailing underscores', () => {
    expect(sanitizeToolName('__foo__', 0)).toBe('foo')
  })

  it('falls back to tool_<index> on empty result', () => {
    expect(sanitizeToolName('', 3)).toBe('tool_3')
    expect(sanitizeToolName('---', 7)).toBe('tool_7')
  })
})
