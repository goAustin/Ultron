import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { FileReadTool } from './FileReadTool.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { createStore, getDefaultAppState } from '../core/state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext() {
  return createToolUseContext({
    appState: createStore(getDefaultAppState()),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createToolRegistry(),
  })
}

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-fileread-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const signal = new AbortController().signal

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileReadTool', () => {
  it('has correct properties', () => {
    expect(FileReadTool.name).toBe('FileRead')
    expect(FileReadTool.isMutating).toBe(false)
    expect(FileReadTool.isConcurrencySafe?.({})).toBe(true)
    expect(FileReadTool.getPath?.({ file_path: '/tmp/x.ts' })).toBe('/tmp/x.ts')
  })

  it('reads a file with line numbers', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      writeFileSync(file, 'line one\nline two\nline three')
      const ctx = makeContext()
      const result = await FileReadTool.call({ file_path: file }, ctx, signal)
      expect(result.isError).toBe(false)
      expect(result.content).toContain('1\tline one')
      expect(result.content).toContain('2\tline two')
      expect(result.content).toContain('3\tline three')
    })
  })

  it('respects offset and limit', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      writeFileSync(file, 'a\nb\nc\nd\ne')
      const ctx = makeContext()
      const result = await FileReadTool.call({ file_path: file, offset: 1, limit: 2 }, ctx, signal)
      expect(result.isError).toBe(false)
      // offset=1 means start at index 1 (second line), limit=2 means 2 lines
      expect(result.content).toBe('2\tb\n3\tc')
    })
  })

  it('returns error for nonexistent file', async () => {
    const ctx = makeContext()
    const result = await FileReadTool.call({ file_path: '/nonexistent/file.txt' }, ctx, signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('File not found')
  })

  it('returns error for directory path', async () => {
    await withTmpDir(async (dir) => {
      const ctx = makeContext()
      const result = await FileReadTool.call({ file_path: dir }, ctx, signal)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('directory')
    })
  })

  it('updates readFileState after read', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      writeFileSync(file, 'hello world')
      const ctx = makeContext()
      expect(ctx.readFileState.has(file)).toBe(false)
      await FileReadTool.call({ file_path: file }, ctx, signal)
      expect(ctx.readFileState.has(file)).toBe(true)
      expect(ctx.readFileState.get(file)!.content).toBe('hello world')
    })
  })

  it('caches full content even when offset/limit applied', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      writeFileSync(file, 'a\nb\nc\nd\ne')
      const ctx = makeContext()
      await FileReadTool.call({ file_path: file, offset: 0, limit: 1 }, ctx, signal)
      // Full content should be cached, not just the sliced portion
      expect(ctx.readFileState.get(file)!.content).toBe('a\nb\nc\nd\ne')
    })
  })

  it('rejects empty file_path in validation', async () => {
    const ctx = makeContext()
    const result = await FileReadTool.validateInput({ file_path: '' }, ctx)
    expect(result.valid).toBe(false)
  })

  it('rejects negative offset', async () => {
    const ctx = makeContext()
    const result = await FileReadTool.validateInput({ file_path: '/x', offset: -1 }, ctx)
    expect(result.valid).toBe(false)
  })
})
