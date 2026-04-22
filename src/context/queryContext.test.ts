import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

import { buildFullSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './queryContext.js'
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

describe('buildFullSystemPrompt', () => {
  it('returns a string', async () => {
    await withTmpDir(async (dir) => {
      const result = await buildFullSystemPrompt(dir)
      expect(typeof result).toBe('string')
    })
  })

  it('contains Ultron from static prompt', async () => {
    await withTmpDir(async (dir) => {
      const result = await buildFullSystemPrompt(dir)
      expect(result).toContain('Ultron')
    })
  })

  it('contains a date matching YYYY-MM-DD', async () => {
    await withTmpDir(async (dir) => {
      const result = await buildFullSystemPrompt(dir)
      expect(result).toMatch(/Today's date is \d{4}-\d{2}-\d{2}/)
    })
  })

  it('contains working directory from env info', async () => {
    await withTmpDir(async (dir) => {
      const result = await buildFullSystemPrompt(dir)
      expect(result).toContain(`Working directory: ${dir}`)
    })
  })

  it('does not contain boundary marker', async () => {
    await withTmpDir(async (dir) => {
      const result = await buildFullSystemPrompt(dir)
      expect(result).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    })
  })

  it('does not include Project Instructions (moved to attachments)', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'CLAUDE.md'), 'My project rules')
      const result = await buildFullSystemPrompt(dir)
      expect(result).not.toContain('# Project Instructions')
      expect(result).not.toContain('My project rules')
    })
  })

  it('does not include Git Status (moved to attachments)', async () => {
    await withTmpDir(async (dir) => {
      initGitRepo(dir)
      const result = await buildFullSystemPrompt(dir)
      expect(result).not.toContain('# Git Status')
      expect(result).not.toContain('Current branch:')
    })
  })
})
