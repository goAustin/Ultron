import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

import { buildFullSystemPromptParts } from './queryContext.js'
import { clearUserContextCache } from './userContext.js'
import { clearSystemContextCache } from './systemContext.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-qctx-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'file.txt'), 'hello')
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
}

afterEach(() => {
  clearUserContextCache()
  clearSystemContextCache()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildFullSystemPromptParts', () => {
  it('returns an array of parts', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildFullSystemPromptParts(dir)
      expect(Array.isArray(parts)).toBe(true)
      expect(parts.length).toBeGreaterThan(0)
    })
  })

  it('contains at least one global part with non-empty content', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildFullSystemPromptParts(dir)
      const globalParts = parts.filter(p => p.cacheHint === 'global' && p.content.length > 0)
      expect(globalParts.length).toBeGreaterThan(0)
    })
  })

  it('global parts precede all volatile parts (global-then-volatile invariant)', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildFullSystemPromptParts(dir)
      let seenVolatile = false
      for (const p of parts) {
        if (p.cacheHint === 'volatile') seenVolatile = true
        if (seenVolatile && p.cacheHint === 'global') {
          throw new Error('Global part appeared after volatile part')
        }
      }
    })
  })

  it('joined content contains Ultron from static prompt', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildFullSystemPromptParts(dir)
      const joined = parts.map(p => p.content).join('\n\n')
      expect(joined).toContain('Ultron')
    })
  })

  it('joined content contains a date matching YYYY-MM-DD', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildFullSystemPromptParts(dir)
      const joined = parts.map(p => p.content).join('\n\n')
      expect(joined).toMatch(/Today's date is \d{4}-\d{2}-\d{2}/)
    })
  })

  it('joined content contains working directory from env info', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildFullSystemPromptParts(dir)
      const joined = parts.map(p => p.content).join('\n\n')
      expect(joined).toContain(`Working directory: ${dir}`)
    })
  })

  it('does not include Project Instructions (moved to attachments)', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'CLAUDE.md'), 'My project rules')
      const parts = await buildFullSystemPromptParts(dir)
      const joined = parts.map(p => p.content).join('\n\n')
      expect(joined).not.toContain('# Project Instructions')
      expect(joined).not.toContain('My project rules')
    })
  })

  it('does not include Git Status (moved to attachments)', async () => {
    await withTmpDir(async (dir) => {
      initGitRepo(dir)
      const parts = await buildFullSystemPromptParts(dir)
      const joined = parts.map(p => p.content).join('\n\n')
      expect(joined).not.toContain('# Git Status')
      expect(joined).not.toContain('Current branch:')
    })
  })
})
