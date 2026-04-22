import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { GrepTool } from './GrepTool.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'ultron-grep-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const signal = new AbortController().signal

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GrepTool', () => {
  it('has correct properties', () => {
    expect(GrepTool.name).toBe('Grep')
    expect(GrepTool.isMutating).toBe(false)
    expect(GrepTool.isConcurrencySafe?.({})).toBe(true)
  })

  it('finds pattern matches in files', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'a.txt'), 'hello world\ngoodbye world')
      writeFileSync(join(dir, 'b.txt'), 'nothing here')

      const ctx = makeContext()
      const result = await GrepTool.call({ pattern: 'hello', path: dir }, ctx, signal)
      expect(result.isError).toBe(false)
      expect(result.content).toContain('hello world')
      expect(result.content).toContain('a.txt')
    })
  })

  it('returns no matches for unmatched pattern', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'a.txt'), 'hello')

      const ctx = makeContext()
      const result = await GrepTool.call({ pattern: 'zzzzz', path: dir }, ctx, signal)
      expect(result.isError).toBe(false)
      expect(result.content).toContain('No matches')
    })
  })

  it('rejects invalid regex', async () => {
    const ctx = makeContext()
    const v = await GrepTool.validateInput({ pattern: '[invalid' }, ctx)
    expect(v.valid).toBe(false)
    expect((v as { message: string }).message).toContain('Invalid regex')
  })

  it('filters by glob when provided', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'match.ts'), 'target')
      writeFileSync(join(dir, 'skip.js'), 'target')

      const ctx = makeContext()
      const result = await GrepTool.call(
        { pattern: 'target', path: dir, glob: '*.ts' },
        ctx, signal,
      )
      expect(result.isError).toBe(false)
      expect(result.content).toContain('match.ts')
      expect(result.content).not.toContain('skip.js')
    })
  })

  it('rejects empty pattern', async () => {
    const ctx = makeContext()
    const v = await GrepTool.validateInput({ pattern: '' }, ctx)
    expect(v.valid).toBe(false)
  })
})
