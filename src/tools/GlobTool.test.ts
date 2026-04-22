import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { GlobTool } from './GlobTool.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'ultron-glob-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const signal = new AbortController().signal

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GlobTool', () => {
  it('has correct properties', () => {
    expect(GlobTool.name).toBe('Glob')
    expect(GlobTool.isMutating).toBe(false)
    expect(GlobTool.isConcurrencySafe?.({})).toBe(true)
  })

  it('finds files matching pattern', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'a.ts'), '')
      writeFileSync(join(dir, 'b.ts'), '')
      writeFileSync(join(dir, 'c.js'), '')

      const ctx = makeContext()
      const result = await GlobTool.call({ pattern: '*.ts', path: dir }, ctx, signal)
      expect(result.isError).toBe(false)
      expect(result.content).toContain('a.ts')
      expect(result.content).toContain('b.ts')
      expect(result.content).not.toContain('c.js')
    })
  })

  it('finds nested files with ** pattern', async () => {
    await withTmpDir(async (dir) => {
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'sub', 'deep.ts'), '')
      writeFileSync(join(dir, 'top.ts'), '')

      const ctx = makeContext()
      const result = await GlobTool.call({ pattern: '**/*.ts', path: dir }, ctx, signal)
      expect(result.isError).toBe(false)
      expect(result.content).toContain('deep.ts')
      expect(result.content).toContain('top.ts')
    })
  })

  it('returns no matches message for no results', async () => {
    await withTmpDir(async (dir) => {
      const ctx = makeContext()
      const result = await GlobTool.call({ pattern: '*.xyz', path: dir }, ctx, signal)
      expect(result.isError).toBe(false)
      expect(result.content).toContain('No matches')
    })
  })

  it('rejects empty pattern', async () => {
    const ctx = makeContext()
    const v = await GlobTool.validateInput({ pattern: '' }, ctx)
    expect(v.valid).toBe(false)
  })
})
