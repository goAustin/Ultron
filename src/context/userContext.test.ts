import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { getProjectInstructions, clearUserContextCache } from './userContext.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-userctx-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

afterEach(() => {
  clearUserContextCache()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getProjectInstructions', () => {
  it('returns file content when ULTRON.md exists', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'ULTRON.md'), 'Build instructions here')
      const result = await getProjectInstructions(dir)
      expect(result).toBe('Build instructions here')
    })
  })

  it('returns null when ULTRON.md does not exist', async () => {
    await withTmpDir(async (dir) => {
      const result = await getProjectInstructions(dir)
      expect(result).toBeNull()
    })
  })

  it('returns null for empty ULTRON.md', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'ULTRON.md'), '   \n  ')
      const result = await getProjectInstructions(dir)
      expect(result).toBeNull()
    })
  })

  it('caches by cwd — different dirs get independent results', async () => {
    await withTmpDir(async (dir1) => {
      await withTmpDir(async (dir2) => {
        writeFileSync(join(dir1, 'ULTRON.md'), 'project-one')
        // dir2 has no ULTRON.md

        const r1 = await getProjectInstructions(dir1)
        const r2 = await getProjectInstructions(dir2)
        expect(r1).toBe('project-one')
        expect(r2).toBeNull()
      })
    })
  })

  it('clearUserContextCache forces re-read', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'ULTRON.md'), 'original')
      const first = await getProjectInstructions(dir)
      expect(first).toBe('original')

      writeFileSync(join(dir, 'ULTRON.md'), 'updated')
      clearUserContextCache()
      const second = await getProjectInstructions(dir)
      expect(second).toBe('updated')
    })
  })
})
