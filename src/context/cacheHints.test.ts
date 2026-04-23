import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { buildSystemPromptParts } from './cacheHints.js'
import { clearSystemContextCache } from './systemContext.js'
import { clearUserContextCache } from './userContext.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-chints-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

afterEach(() => {
  clearSystemContextCache()
  clearUserContextCache()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSystemPromptParts', () => {
  it('returns a non-empty array', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      expect(parts.length).toBeGreaterThan(0)
    })
  })

  it('emits at least one static part with non-empty content', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      const staticParts = parts.filter(p => p.cacheHint === 'static' && p.content.length > 0)
      expect(staticParts.length).toBeGreaterThan(0)
    })
  })

  it('does not emit empty parts (bad cache_control target)', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      for (const p of parts) {
        expect(p.content.length).toBeGreaterThan(0)
      }
    })
  })

  it('all static parts come before all volatile parts', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      let seenVolatile = false
      for (const p of parts) {
        if (p.cacheHint === 'volatile') seenVolatile = true
        if (seenVolatile) {
          expect(p.cacheHint).not.toBe('static')
        }
      }
    })
  })

  it('dynamic tail contains the current date part', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      const datePart = parts.find(p => /Today's date is \d{4}-\d{2}-\d{2}/.test(p.content))
      expect(datePart).toBeDefined()
      expect(datePart!.cacheHint).toBe('volatile')
    })
  })

  it('dynamic tail contains the env-info part', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      const envPart = parts.find(p => p.content.includes('Working directory:'))
      expect(envPart).toBeDefined()
      expect(envPart!.cacheHint).toBe('volatile')
    })
  })

  it('produces stable static parts across two calls for the same cwd', async () => {
    await withTmpDir(async (dir) => {
      const a = await buildSystemPromptParts(dir)
      const b = await buildSystemPromptParts(dir)
      const staticA = a.filter(p => p.cacheHint === 'static').map(p => p.content)
      const staticB = b.filter(p => p.cacheHint === 'static').map(p => p.content)
      expect(staticA).toEqual(staticB)
    })
  })
})
