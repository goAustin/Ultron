import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { buildSystemPromptParts } from './cacheHints.js'
import { clearSystemContextCache } from './systemContext.js'
import { clearUserContextCache } from './userContext.js'
import { createAuditWriter } from '../audit/auditLog.js'
import { writeEntry } from '../memory/store.js'
import type { MemoryEntry } from '../memory/entry.js'

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

  it('emits at least one global part with non-empty content', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      const globalParts = parts.filter(p => p.cacheHint === 'global' && p.content.length > 0)
      expect(globalParts.length).toBeGreaterThan(0)
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

  it('all global parts come before all volatile parts', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      let seenVolatile = false
      for (const p of parts) {
        if (p.cacheHint === 'volatile') seenVolatile = true
        if (seenVolatile) {
          expect(p.cacheHint).not.toBe('global')
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

  it('produces stable global parts across two calls for the same cwd', async () => {
    await withTmpDir(async (dir) => {
      const a = await buildSystemPromptParts(dir)
      const b = await buildSystemPromptParts(dir)
      const globalA = a.filter(p => p.cacheHint === 'global').map(p => p.content)
      const globalB = b.filter(p => p.cacheHint === 'global').map(p => p.content)
      expect(globalA).toEqual(globalB)
    })
  })

  // -------------------------------------------------------------------------
  // Phase 4d — memory injection
  // -------------------------------------------------------------------------

  it('emits no org parts when memoryBaseDir is omitted', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      const orgParts = parts.filter(p => p.cacheHint === 'org')
      expect(orgParts.length).toBe(0)
    })
  })

  it('emits no org parts when memoryBaseDir points at an empty store', async () => {
    await withTmpDir(async (dir) => {
      await withTmpDir(async (memBase) => {
        const parts = await buildSystemPromptParts(dir, { memoryBaseDir: memBase })
        const orgParts = parts.filter(p => p.cacheHint === 'org')
        expect(orgParts.length).toBe(0)
      })
    })
  })

  // -------------------------------------------------------------------------
  // v3 Phase 5 — computerUseEnabled propagation
  // -------------------------------------------------------------------------

  it('emits no Computer-Use global part when computerUseEnabled is omitted', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir)
      const cu = parts.find(p => p.cacheHint === 'global' && p.content.includes('# Computer-Use'))
      expect(cu).toBeUndefined()
    })
  })

  it('preamble bytes are identical whether computerUseEnabled is omitted or false', async () => {
    await withTmpDir(async (dir) => {
      const omitted = await buildSystemPromptParts(dir)
      const off = await buildSystemPromptParts(dir, { computerUseEnabled: false })
      const omittedGlobal = omitted.filter(p => p.cacheHint === 'global').map(p => p.content)
      const offGlobal = off.filter(p => p.cacheHint === 'global').map(p => p.content)
      expect(omittedGlobal).toEqual(offGlobal)
    })
  })

  it('appends one extra global Computer-Use part when computerUseEnabled is true', async () => {
    await withTmpDir(async (dir) => {
      const off = await buildSystemPromptParts(dir)
      const on = await buildSystemPromptParts(dir, { computerUseEnabled: true })
      const offGlobal = off.filter(p => p.cacheHint === 'global')
      const onGlobal = on.filter(p => p.cacheHint === 'global')
      expect(onGlobal.length).toBe(offGlobal.length + 1)
      const cu = onGlobal[onGlobal.length - 1]!
      expect(cu.content).toContain('# Computer-Use')
      expect(cu.content).toContain('<untrusted-page-text>')
      expect(cu.cacheHint).toBe('global')
    })
  })

  it('Computer-Use part precedes any volatile parts (preamble ordering preserved)', async () => {
    await withTmpDir(async (dir) => {
      const parts = await buildSystemPromptParts(dir, { computerUseEnabled: true })
      const idxCu = parts.findIndex(p => p.content.includes('# Computer-Use'))
      const idxFirstVol = parts.findIndex(p => p.cacheHint === 'volatile')
      expect(idxCu).toBeGreaterThanOrEqual(0)
      expect(idxFirstVol).toBeGreaterThan(idxCu)
    })
  })

  it('emits exactly one org part between global and volatile when memory has entries', async () => {
    await withTmpDir(async (dir) => {
      await withTmpDir(async (memBase) => {
        await withTmpDir(async (auditDir) => {
          const writer = createAuditWriter({ dir: auditDir })
          const entry: MemoryEntry = {
            schemaVersion: 1,
            id: 'pref',
            type: 'user',
            name: 'Tabs preference',
            description: 'prefers tabs',
            content: 'user prefers tabs over spaces',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          }
          await writeEntry(memBase, entry, writer)
          await writer.close()

          const parts = await buildSystemPromptParts(dir, { memoryBaseDir: memBase })
          const orgParts = parts.filter(p => p.cacheHint === 'org')
          expect(orgParts.length).toBe(1)
          expect(orgParts[0]!.content).toContain('Tabs preference')

          // Ordering: every global precedes the org, which precedes every volatile.
          const idxOfFirstOrg = parts.findIndex(p => p.cacheHint === 'org')
          const idxOfLastGlobal = parts.map(p => p.cacheHint).lastIndexOf('global')
          const idxOfFirstVol = parts.findIndex(p => p.cacheHint === 'volatile')
          expect(idxOfLastGlobal).toBeLessThan(idxOfFirstOrg)
          expect(idxOfFirstOrg).toBeLessThan(idxOfFirstVol)
        })
      })
    })
  })
})
