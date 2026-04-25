import { describe, it, expect } from 'vitest'

import { memorySecretSafetyCheck } from './memorySecretCheck.js'
import type { Tool } from '../core/tools/types.js'
import type { ToolUseContext } from '../core/tools/context.js'

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

function makeContext(): ToolUseContext {
  return { readFileState: new Map() } as ToolUseContext
}

const validWriteInput = {
  id: 'profile',
  type: 'user',
  name: 'Profile',
  description: 'user prefs',
  content: 'hello world',
}

describe('memorySecretSafetyCheck', () => {
  describe('MemoryWrite', () => {
    it('denies high-confidence AWS key in content', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryWrite'),
        { ...validWriteInput, content: 'creds: AKIAIOSFODNN7EXAMPLE' },
        makeContext(),
      )
      expect(result).not.toBeNull()
      expect(result!.behavior).toBe('deny')
      expect((result!.reason as { message: string }).message).toContain('aws_access_key_id')
    })

    it('denies high-confidence Anthropic key smuggled into name', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryWrite'),
        {
          ...validWriteInput,
          name: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
        makeContext(),
      )
      expect(result).not.toBeNull()
      expect(result!.behavior).toBe('deny')
    })

    it('asks for low-confidence match only', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryWrite'),
        { ...validWriteInput, content: 'password = "s3cretPassword12345"' },
        makeContext(),
      )
      expect(result).not.toBeNull()
      expect(result!.behavior).toBe('ask')
      expect((result!.reason as { message: string }).message).toContain('generic_secret_assignment')
    })

    it('returns null for clean content', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryWrite'),
        validWriteInput,
        makeContext(),
      )
      expect(result).toBeNull()
    })

    it('returns null when input shape is malformed (validateInput will catch)', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryWrite'),
        { id: '../evil', type: 'user' },
        makeContext(),
      )
      expect(result).toBeNull()
    })

    it('returns null for unknown type', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryWrite'),
        { ...validWriteInput, type: 'notARealType' },
        makeContext(),
      )
      expect(result).toBeNull()
    })
  })

  describe('MemoryEdit', () => {
    it('returns null for clean content', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryEdit'),
        { id: 'profile', content: 'hello' },
        makeContext(),
      )
      expect(result).toBeNull()
    })

    it('denies high-confidence match in new_string', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryEdit'),
        {
          id: 'profile',
          old_string: 'placeholder',
          new_string: 'AKIAIOSFODNN7EXAMPLE',
        },
        makeContext(),
      )
      expect(result).not.toBeNull()
      expect(result!.behavior).toBe('deny')
    })

    it('asks for low-confidence match in content', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryEdit'),
        { id: 'profile', content: 'password = "s3cretPassword12345"' },
        makeContext(),
      )
      expect(result).not.toBeNull()
      expect(result!.behavior).toBe('ask')
    })

    it('returns null when no scannable text fields present', () => {
      const result = memorySecretSafetyCheck(
        makeTool('MemoryEdit'),
        { id: 'profile' },
        makeContext(),
      )
      expect(result).toBeNull()
    })
  })

  describe('non-memory tools', () => {
    it('returns null for FileRead', () => {
      const result = memorySecretSafetyCheck(
        makeTool('FileRead'),
        { file_path: '/tmp/secrets', content: 'AKIAIOSFODNN7EXAMPLE' },
        makeContext(),
      )
      expect(result).toBeNull()
    })

    it('returns null for FileWrite (handled by secretContentSafetyCheck)', () => {
      const result = memorySecretSafetyCheck(
        makeTool('FileWrite'),
        { file_path: '/tmp/x', content: 'AKIAIOSFODNN7EXAMPLE' },
        makeContext(),
      )
      expect(result).toBeNull()
    })
  })
})
