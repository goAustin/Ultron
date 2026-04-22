import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir, platform } from 'os'

import { getSystemContext, clearSystemContextCache } from './systemContext.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-sysctx-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'file.txt'), 'hello')
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' })
}

afterEach(() => {
  clearSystemContextCache()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getSystemContext', () => {
  it('returns gitStatus in a git repo', async () => {
    await withTmpDir(async (dir) => {
      initGitRepo(dir)
      const ctx = await getSystemContext(dir)
      expect(ctx.gitStatus).not.toBeNull()
      expect(ctx.gitStatus).toContain('Current branch:')
      expect(ctx.gitStatus).toContain('Recent commits:')
      expect(ctx.gitStatus).toContain('initial')
    })
  })

  it('returns null gitStatus in a non-git directory', async () => {
    await withTmpDir(async (dir) => {
      const ctx = await getSystemContext(dir)
      expect(ctx.gitStatus).toBeNull()
    })
  })

  it('includes git user when configured', async () => {
    await withTmpDir(async (dir) => {
      initGitRepo(dir)
      const ctx = await getSystemContext(dir)
      expect(ctx.gitStatus).toContain('Git user: Test User')
    })
  })

  it('omits default branch when no remote', async () => {
    await withTmpDir(async (dir) => {
      initGitRepo(dir)
      const ctx = await getSystemContext(dir)
      // Temp repos have no remote, so default branch line should be absent
      expect(ctx.gitStatus).not.toContain('Default branch:')
    })
  })

  it('envInfo contains platform and working directory', async () => {
    await withTmpDir(async (dir) => {
      const ctx = await getSystemContext(dir)
      expect(ctx.envInfo).toContain(`Working directory: ${dir}`)
      expect(ctx.envInfo).toContain(`Platform: ${platform()}`)
    })
  })

  it('envInfo reflects git status correctly', async () => {
    await withTmpDir(async (dir) => {
      const nonGit = await getSystemContext(dir)
      expect(nonGit.envInfo).toContain('Is a git repository: false')

      clearSystemContextCache()
      initGitRepo(dir)
      const git = await getSystemContext(dir)
      expect(git.envInfo).toContain('Is a git repository: true')
    })
  })

  it('caches by cwd — different dirs get independent results', async () => {
    await withTmpDir(async (dir1) => {
      await withTmpDir(async (dir2) => {
        initGitRepo(dir1)
        // dir2 is not a git repo

        const r1 = await getSystemContext(dir1)
        const r2 = await getSystemContext(dir2)
        expect(r1.gitStatus).not.toBeNull()
        expect(r2.gitStatus).toBeNull()
      })
    })
  })

  it('clearSystemContextCache forces re-computation', async () => {
    await withTmpDir(async (dir) => {
      const first = await getSystemContext(dir)
      expect(first.gitStatus).toBeNull()

      initGitRepo(dir)
      clearSystemContextCache()
      const second = await getSystemContext(dir)
      expect(second.gitStatus).not.toBeNull()
    })
  })
})
