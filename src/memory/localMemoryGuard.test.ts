import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  checkTranscriptSize,
  enforceBaseDirectoryPermissions,
  MAX_TRANSCRIPT_BYTES,
} from './localMemoryGuard.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-guard-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

// ---------------------------------------------------------------------------
// checkTranscriptSize
// ---------------------------------------------------------------------------

describe('checkTranscriptSize', () => {
  it('returns ok for small files', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'transcript.jsonl')
      writeFileSync(path, '{"role":"user"}\n')
      const result = checkTranscriptSize(path)
      expect(result.ok).toBe(true)
      expect(result.bytes).toBeGreaterThan(0)
    })
  })

  it('returns not ok for files over cap', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'transcript.jsonl')
      // Write a file larger than the cap
      const bigContent = 'x'.repeat(MAX_TRANSCRIPT_BYTES + 1)
      writeFileSync(path, bigContent)
      const result = checkTranscriptSize(path)
      expect(result.ok).toBe(false)
      expect(result.bytes).toBeGreaterThan(MAX_TRANSCRIPT_BYTES)
    })
  })

  it('returns ok for nonexistent files', () => {
    const result = checkTranscriptSize('/nonexistent/transcript.jsonl')
    expect(result.ok).toBe(true)
    expect(result.bytes).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// enforceBaseDirectoryPermissions
// ---------------------------------------------------------------------------

describe('enforceBaseDirectoryPermissions', () => {
  it('sets mode 0o700 on directory', async () => {
    await withTmpDir(async (dir) => {
      const baseDir = join(dir, 'ultron-test')
      await enforceBaseDirectoryPermissions(baseDir)

      const baseStat = statSync(baseDir)
      expect(baseStat.mode & 0o777).toBe(0o700)

      const sessionsStat = statSync(join(baseDir, 'sessions'))
      expect(sessionsStat.mode & 0o777).toBe(0o700)
    })
  })

  it('creates directories if they do not exist', async () => {
    await withTmpDir(async (dir) => {
      const baseDir = join(dir, 'new-ultron')
      await enforceBaseDirectoryPermissions(baseDir)

      const baseStat = statSync(baseDir)
      expect(baseStat.isDirectory()).toBe(true)

      const sessionsStat = statSync(join(baseDir, 'sessions'))
      expect(sessionsStat.isDirectory()).toBe(true)
    })
  })

  it('swallows errors gracefully', async () => {
    // Use a path that will fail (file instead of directory)
    await withTmpDir(async (dir) => {
      const blockingFile = join(dir, 'blocker')
      writeFileSync(blockingFile, 'not a dir')

      // Should not throw — warns to stderr
      await enforceBaseDirectoryPermissions(join(blockingFile, 'impossible'))
    })
  })
})
