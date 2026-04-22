import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { FileEditTool } from './FileEditTool.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'ultron-fileedit-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const signal = new AbortController().signal

/** Write a file and mark it as read in context. */
function writeAndRead(file: string, content: string, ctx: ReturnType<typeof makeContext>) {
  writeFileSync(file, content)
  const { mtimeMs } = statSync(file)
  markRead(ctx.readFileState, file, content, mtimeMs)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileEditTool', () => {
  it('has correct properties', () => {
    expect(FileEditTool.name).toBe('FileEdit')
    expect(FileEditTool.isMutating).toBeUndefined()
    expect(FileEditTool.isConcurrencySafe).toBeUndefined()
  })

  it('performs a single replacement', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      const ctx = makeContext()
      writeAndRead(file, 'hello world', ctx)

      const result = await FileEditTool.call(
        { file_path: file, old_string: 'hello', new_string: 'goodbye' },
        ctx, signal,
      )
      expect(result.isError).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe('goodbye world')
    })
  })

  it('rejects no-op edit (old === new)', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      const ctx = makeContext()
      writeAndRead(file, 'hello', ctx)

      const v = await FileEditTool.validateInput(
        { file_path: file, old_string: 'hello', new_string: 'hello' },
        ctx,
      )
      expect(v.valid).toBe(false)
      expect((v as { message: string }).message).toContain('same')
    })
  })

  it('rejects when old_string not found', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      const ctx = makeContext()
      writeAndRead(file, 'hello world', ctx)

      const v = await FileEditTool.validateInput(
        { file_path: file, old_string: 'xyz', new_string: 'abc' },
        ctx,
      )
      expect(v.valid).toBe(false)
      expect((v as { message: string }).message).toContain('not found')
    })
  })

  it('rejects edit on nonexistent file', async () => {
    const ctx = makeContext()
    const v = await FileEditTool.validateInput(
      { file_path: '/nonexistent/file.txt', old_string: 'a', new_string: 'b' },
      ctx,
    )
    expect(v.valid).toBe(false)
    expect((v as { message: string }).message).toContain('does not exist')
  })

  it('rejects edit without prior read', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      writeFileSync(file, 'hello')
      const ctx = makeContext()

      const v = await FileEditTool.validateInput(
        { file_path: file, old_string: 'hello', new_string: 'world' },
        ctx,
      )
      expect(v.valid).toBe(false)
      expect((v as { message: string }).message).toContain('not been read')
    })
  })

  it('rejects edit when file is stale', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      writeFileSync(file, 'hello')
      const ctx = makeContext()
      // Mark as read with old mtime
      markRead(ctx.readFileState, file, 'hello', 0)

      const v = await FileEditTool.validateInput(
        { file_path: file, old_string: 'hello', new_string: 'world' },
        ctx,
      )
      expect(v.valid).toBe(false)
      expect((v as { message: string }).message).toContain('modified since')
    })
  })

  it('rejects multiple matches without replace_all', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      const ctx = makeContext()
      writeAndRead(file, 'aaa bbb aaa', ctx)

      const v = await FileEditTool.validateInput(
        { file_path: file, old_string: 'aaa', new_string: 'ccc' },
        ctx,
      )
      expect(v.valid).toBe(false)
      expect((v as { message: string }).message).toContain('2 matches')
    })
  })

  it('accepts multiple matches with replace_all=true', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      const ctx = makeContext()
      writeAndRead(file, 'aaa bbb aaa', ctx)

      const v = await FileEditTool.validateInput(
        { file_path: file, old_string: 'aaa', new_string: 'ccc', replace_all: true },
        ctx,
      )
      expect(v.valid).toBe(true)

      const result = await FileEditTool.call(
        { file_path: file, old_string: 'aaa', new_string: 'ccc', replace_all: true },
        ctx, signal,
      )
      expect(result.isError).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe('ccc bbb ccc')
    })
  })

  it('updates readFileState after edit', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'test.txt')
      const ctx = makeContext()
      writeAndRead(file, 'hello world', ctx)

      await FileEditTool.call(
        { file_path: file, old_string: 'hello', new_string: 'goodbye' },
        ctx, signal,
      )
      expect(ctx.readFileState.get(file)!.content).toBe('goodbye world')
    })
  })
})
