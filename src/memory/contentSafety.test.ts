import { describe, it, expect } from 'vitest'

import { secretContentSafetyCheck } from './contentSafety.js'
import type { Tool } from '../core/tools/types.js'
import type { ToolUseContext } from '../core/tools/context.js'
import type { ReadFileState } from '../core/tools/context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string): Tool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object', properties: {}, required: [] },
    validateInput: async () => ({ valid: true }),
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async () => ({ content: '', isError: false }),
  }
}

function makeContext(readFileState?: ReadFileState): ToolUseContext {
  return {
    readFileState: readFileState ?? new Map(),
  } as ToolUseContext
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('secretContentSafetyCheck', () => {
  it('denies FileWrite containing a high-confidence secret (API key)', () => {
    const result = secretContentSafetyCheck(
      makeTool('FileWrite'),
      { content: 'API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz', file_path: '/tmp/env' },
      makeContext(),
    )
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('deny')
    expect(result!.reason.type).toBe('safetyCheck')
    expect((result!.reason as { message: string }).message).toContain('openai_api_key')
  })

  it('denies FileEdit when post-edit content contains a secret', () => {
    const readFileState: ReadFileState = new Map([
      ['/tmp/config.ts', { content: 'const key = "placeholder"', mtime: 1000 }],
    ])

    const result = secretContentSafetyCheck(
      makeTool('FileEdit'),
      {
        file_path: '/tmp/config.ts',
        old_string: 'placeholder',
        new_string: 'AKIAIOSFODNN7EXAMPLE',
      },
      makeContext(readFileState),
    )
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('deny')
    expect((result!.reason as { message: string }).message).toContain('aws_access_key_id')
  })

  it('asks for FileWrite containing only low-confidence secrets', () => {
    const result = secretContentSafetyCheck(
      makeTool('FileWrite'),
      { content: 'password = "my-super-secret-password"', file_path: '/tmp/config' },
      makeContext(),
    )
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('ask')
    expect((result!.reason as { message: string }).message).toContain('generic_secret_assignment')
  })

  it('returns null for FileWrite with normal content', () => {
    const result = secretContentSafetyCheck(
      makeTool('FileWrite'),
      { content: 'Hello, world!', file_path: '/tmp/hello.txt' },
      makeContext(),
    )
    expect(result).toBeNull()
  })

  it('returns null for FileRead (not a mutating tool)', () => {
    const result = secretContentSafetyCheck(
      makeTool('FileRead'),
      { file_path: '/tmp/secrets.env' },
      makeContext(),
    )
    expect(result).toBeNull()
  })

  it('falls back to scanning new_string when file not in readFileState', () => {
    const result = secretContentSafetyCheck(
      makeTool('FileEdit'),
      {
        file_path: '/tmp/unknown.ts',
        old_string: 'old',
        new_string: 'AKIAIOSFODNN7EXAMPLE',
      },
      makeContext(), // empty readFileState
    )
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('deny')
  })

  it('returns null for Bash tool', () => {
    const result = secretContentSafetyCheck(
      makeTool('Bash'),
      { command: 'echo AKIAIOSFODNN7EXAMPLE' },
      makeContext(),
    )
    expect(result).toBeNull()
  })

  it('denies when private key header is in content', () => {
    const result = secretContentSafetyCheck(
      makeTool('FileWrite'),
      {
        content: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
        file_path: '/tmp/key.pem',
      },
      makeContext(),
    )
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('deny')
    expect((result!.reason as { message: string }).message).toContain('private_key')
  })
})
