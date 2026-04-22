import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { FileWriteTool } from './FileWriteTool.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import { markRead } from '../core/tools/fileStateCache.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'ultron-filewrite-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const signal = new AbortController().signal

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileWriteTool', () => {
  it('has correct properties', () => {
    expect(FileWriteTool.name).toBe('FileWrite')
    expect(FileWriteTool.isMutating).toBeUndefined() // defaults to true
    expect(FileWriteTool.isConcurrencySafe).toBeUndefined()
  })

  it('creates a new file', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'new.txt')
      const ctx = makeContext()
      const result = await FileWriteTool.call({ file_path: file, content: 'hello' }, ctx, signal)
      expect(result.isError).toBe(false)
      expect(result.content).toContain('File created')
      expect(readFileSync(file, 'utf8')).toBe('hello')
    })
  })

  it('creates parent directories', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'sub', 'deep', 'file.txt')
      const ctx = makeContext()
      const result = await FileWriteTool.call({ file_path: file, content: 'nested' }, ctx, signal)
      expect(result.isError).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe('nested')
    })
  })

  it('overwrites after prior read', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'existing.txt')
      writeFileSync(file, 'old content')
      const ctx = makeContext()

      // Simulate prior read
      const { mtimeMs } = require('fs').statSync(file)
      markRead(ctx.readFileState, file, 'old content', mtimeMs)

      const result = await FileWriteTool.call({ file_path: file, content: 'new content' }, ctx, signal)
      expect(result.isError).toBe(false)
      expect(result.content).toContain('File updated')
      expect(readFileSync(file, 'utf8')).toBe('new content')
    })
  })

  it('blocks overwrite without prior read', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'existing.txt')
      writeFileSync(file, 'original')
      const ctx = makeContext()

      const validation = await FileWriteTool.validateInput(
        { file_path: file, content: 'overwrite' },
        ctx,
      )
      expect(validation.valid).toBe(false)
      expect((validation as { message: string }).message).toContain('not been read')
    })
  })

  it('blocks overwrite when file is stale', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'stale.txt')
      writeFileSync(file, 'v1')
      const ctx = makeContext()

      // Cache with old mtime
      markRead(ctx.readFileState, file, 'v1', 0)

      const validation = await FileWriteTool.validateInput(
        { file_path: file, content: 'v2' },
        ctx,
      )
      expect(validation.valid).toBe(false)
      expect((validation as { message: string }).message).toContain('modified since')
    })
  })

  it('updates readFileState after write', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'track.txt')
      const ctx = makeContext()
      await FileWriteTool.call({ file_path: file, content: 'tracked' }, ctx, signal)
      expect(ctx.readFileState.has(file)).toBe(true)
      expect(ctx.readFileState.get(file)!.content).toBe('tracked')
    })
  })

  it('rejects empty file_path', async () => {
    const ctx = makeContext()
    const result = await FileWriteTool.validateInput({ file_path: '', content: 'x' }, ctx)
    expect(result.valid).toBe(false)
  })

  it('rejects non-string content', async () => {
    const ctx = makeContext()
    const result = await FileWriteTool.validateInput({ file_path: '/x', content: 123 }, ctx)
    expect(result.valid).toBe(false)
  })
})
