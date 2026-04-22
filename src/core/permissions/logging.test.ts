import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { summarizeInput, createPermissionLogger } from './logging.js'
import type { PermissionLogEntry } from './logging.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-perm-log-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

// ---------------------------------------------------------------------------
// summarizeInput
// ---------------------------------------------------------------------------

describe('summarizeInput', () => {
  it('returns file_path for file tools', () => {
    expect(summarizeInput('FileWrite', { file_path: '/tmp/foo.ts' })).toBe('/tmp/foo.ts')
    expect(summarizeInput('FileEdit', { file_path: '/tmp/bar.ts' })).toBe('/tmp/bar.ts')
    expect(summarizeInput('FileRead', { file_path: '/tmp/baz.ts' })).toBe('/tmp/baz.ts')
  })

  it('returns command prefix for Bash', () => {
    expect(summarizeInput('Bash', { command: 'ls -la' })).toBe('ls -la')
  })

  it('returns pattern for Grep', () => {
    expect(summarizeInput('Grep', { pattern: 'foo.*bar', path: '/src' })).toBe('foo.*bar in /src')
  })

  it('returns pattern without path for Glob', () => {
    expect(summarizeInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  it('truncates long values', () => {
    const longCommand = 'x'.repeat(200)
    const result = summarizeInput('Bash', { command: longCommand })
    expect(result.length).toBeLessThanOrEqual(120)
    expect(result.endsWith('...')).toBe(true)
  })

  it('returns truncated JSON for unknown tools', () => {
    const result = summarizeInput('CustomTool', { foo: 'bar', baz: 123 })
    expect(result).toContain('foo')
    expect(result).toContain('bar')
  })
})

// ---------------------------------------------------------------------------
// createPermissionLogger
// ---------------------------------------------------------------------------

describe('createPermissionLogger', () => {
  it('writes valid JSONL to the log directory', async () => {
    await withTmpDir(async (dir) => {
      const logger = createPermissionLogger(dir)
      const entry: PermissionLogEntry = {
        timestamp: 1000,
        toolName: 'FileWrite',
        inputSummary: '/tmp/foo.ts',
        decision: 'ask',
        reason: 'no matching rule',
        userResponse: 'allow_once',
      }

      await logger(entry)

      const content = readFileSync(join(dir, 'permissions.jsonl'), 'utf-8')
      const parsed = JSON.parse(content.trim())
      expect(parsed.toolName).toBe('FileWrite')
      expect(parsed.userResponse).toBe('allow_once')
    })
  })

  it('creates directory if missing', async () => {
    await withTmpDir(async (dir) => {
      const nested = join(dir, 'sub', 'deep')
      const logger = createPermissionLogger(nested)

      await logger({
        timestamp: 1000,
        toolName: 'Bash',
        inputSummary: 'echo hi',
        decision: 'ask',
        reason: 'fallback',
      })

      const content = readFileSync(join(nested, 'permissions.jsonl'), 'utf-8')
      expect(content.trim()).toContain('Bash')
    })
  })

  it('swallows write errors gracefully', async () => {
    // Use a path that will fail (file as directory)
    await withTmpDir(async (dir) => {
      const filePath = join(dir, 'not-a-dir')
      // Create a file where the logger expects a directory
      const { writeFileSync } = await import('fs')
      writeFileSync(filePath, 'block')

      const logger = createPermissionLogger(join(filePath, 'impossible'))

      // Should not throw
      await logger({
        timestamp: 1000,
        toolName: 'Test',
        inputSummary: 'test',
        decision: 'ask',
        reason: 'test',
      })
    })
  })

  it('appends multiple entries', async () => {
    await withTmpDir(async (dir) => {
      const logger = createPermissionLogger(dir)

      await logger({
        timestamp: 1000,
        toolName: 'FileWrite',
        inputSummary: '/tmp/a.ts',
        decision: 'ask',
        reason: 'first',
        userResponse: 'allow_once',
      })

      await logger({
        timestamp: 2000,
        toolName: 'Bash',
        inputSummary: 'rm -rf /',
        decision: 'ask',
        reason: 'second',
        userResponse: 'deny_once',
      })

      const content = readFileSync(join(dir, 'permissions.jsonl'), 'utf-8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!).toolName).toBe('FileWrite')
      expect(JSON.parse(lines[1]!).toolName).toBe('Bash')
    })
  })
})
