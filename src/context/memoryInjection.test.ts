import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildMemoryInjectionParts } from './memoryInjection.js'
import { CHARS_PER_TOKEN } from './tokenEstimator.js'
import { createAuditWriter } from '../audit/auditLog.js'
import { writeEntry } from '../memory/store.js'
import type { MemoryEntry, MemoryType } from '../memory/entry.js'

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-meminj-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    schemaVersion: 1,
    id: 'sample',
    type: 'user',
    name: 'Sample',
    description: 'a sample entry',
    content: 'sample body',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

async function writeFixture(
  baseDir: string,
  auditDir: string,
  entries: readonly MemoryEntry[],
): Promise<void> {
  const writer = createAuditWriter({ dir: auditDir })
  for (const e of entries) {
    await writeEntry(baseDir, e, writer)
  }
  await writer.close()
}

function estimate(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN)
}

describe('buildMemoryInjectionParts', () => {
  it('returns [] for an empty/missing memory dir', async () => {
    await withTmpDir(async (baseDir) => {
      const out = await buildMemoryInjectionParts(baseDir, 1_000_000)
      expect(out).toEqual([])
    })
  })

  it('returns [] when budgetTokens is 0', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        await writeFixture(baseDir, auditDir, [makeEntry()])
        const out = await buildMemoryInjectionParts(baseDir, 0)
        expect(out).toEqual([])
      })
    })
  })

  it('returns [] when budgetTokens is negative', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        await writeFixture(baseDir, auditDir, [makeEntry()])
        const out = await buildMemoryInjectionParts(baseDir, -10)
        expect(out).toEqual([])
      })
    })
  })

  it('returns one org-scoped part for a single entry under ample budget', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        await writeFixture(baseDir, auditDir, [
          makeEntry({ id: 'tabs', name: 'Tabs preference', description: 'prefers tabs', content: 'user prefers tabs over spaces' }),
        ])
        const out = await buildMemoryInjectionParts(baseDir, 100_000)
        expect(out.length).toBe(1)
        expect(out[0]!.cacheHint).toBe('org')
        expect(out[0]!.content).toContain('<system-reminder>')
        expect(out[0]!.content).toContain('</system-reminder>')
        expect(out[0]!.content).toContain('Tabs preference')
        expect(out[0]!.content).toContain('prefers tabs')
        expect(out[0]!.content).toContain('user prefers tabs over spaces')
      })
    })
  })

  it('groups entries by MEMORY_TYPES order and updatedAt-desc within group', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        const t = 1_700_000_000_000
        await writeFixture(baseDir, auditDir, [
          // Out of natural order on purpose to exercise the sort.
          makeEntry({ id: 'r1', type: 'reference', name: 'Ref One',     updatedAt: t + 100 }),
          makeEntry({ id: 'u1', type: 'user',      name: 'User Old',    updatedAt: t + 100 }),
          makeEntry({ id: 'u2', type: 'user',      name: 'User Newest', updatedAt: t + 500 }),
          makeEntry({ id: 'p1', type: 'project',   name: 'Project One', updatedAt: t + 300 }),
          makeEntry({ id: 'f1', type: 'feedback',  name: 'Feedback One',updatedAt: t + 200 }),
        ])
        const out = await buildMemoryInjectionParts(baseDir, 100_000)
        expect(out.length).toBe(1)
        const body = out[0]!.content
        // Type group order: user, feedback, project, reference (per MEMORY_TYPES).
        const idxUser     = body.indexOf('## user')
        const idxFeedback = body.indexOf('## feedback')
        const idxProject  = body.indexOf('## project')
        const idxRef      = body.indexOf('## reference')
        expect(idxUser).toBeGreaterThan(-1)
        expect(idxFeedback).toBeGreaterThan(idxUser)
        expect(idxProject).toBeGreaterThan(idxFeedback)
        expect(idxRef).toBeGreaterThan(idxProject)
        // Within `user`, "User Newest" appears before "User Old".
        const idxNewest = body.indexOf('### User Newest')
        const idxOld    = body.indexOf('### User Old')
        expect(idxNewest).toBeGreaterThan(-1)
        expect(idxOld).toBeGreaterThan(idxNewest)
      })
    })
  })

  it('returns the same bytes across two calls with no store change (cache stability)', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        await writeFixture(baseDir, auditDir, [
          makeEntry({ id: 'a', name: 'A' }),
          makeEntry({ id: 'b', name: 'B', updatedAt: 1_700_000_000_500 }),
        ])
        const a = await buildMemoryInjectionParts(baseDir, 100_000)
        const b = await buildMemoryInjectionParts(baseDir, 100_000)
        expect(a).toEqual(b)
      })
    })
  })

  it('returns [] when budget is too tight for even one entry', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        await writeFixture(baseDir, auditDir, [
          makeEntry({ content: 'x'.repeat(2000) }),
        ])
        // 1 token = ~4 chars, so 2000 chars alone is ~500 tokens; with the
        // <system-reminder> wrapper we need much more. Budget = 10 is too tight.
        const out = await buildMemoryInjectionParts(baseDir, 10)
        expect(out).toEqual([])
      })
    })
  })

  it('emits a part whose estimated tokens are <= budget', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        await writeFixture(baseDir, auditDir, [
          makeEntry({ id: 'a', name: 'A', content: 'a'.repeat(400) }),
          makeEntry({ id: 'b', name: 'B', content: 'b'.repeat(400) }),
        ])
        const budget = 1024
        const out = await buildMemoryInjectionParts(baseDir, budget)
        expect(out.length).toBe(1)
        expect(estimate(out[0]!.content)).toBeLessThanOrEqual(budget)
      })
    })
  })

  it('drops oldest entries (by updatedAt) when over budget', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        const baseT = 1_700_000_000_000
        // Five entries, each ~2000 chars of content. Each contributes ~500
        // tokens of body alone, plus type/name headers. Set budget so ~3 fit.
        const entries: MemoryEntry[] = []
        for (let i = 0; i < 5; i++) {
          entries.push(makeEntry({
            id: `e${i}`,
            name: `Entry ${i}`,
            description: `desc ${i}`,
            content: `${i}`.repeat(2000),
            updatedAt: baseT + i * 1000, // e0 oldest, e4 newest
          }))
        }
        await writeFixture(baseDir, auditDir, entries)

        // Pick a budget that fits roughly the 3 newest (e2, e3, e4) but not all 5.
        // Each entry body = ~500 tokens; 3 entries ≈ 1500 tokens body + header
        // overhead. Budget = 2000 tokens leaves room for headers; 5 entries
        // (~2500 tokens body) would overflow.
        const out = await buildMemoryInjectionParts(baseDir, 2000)
        expect(out.length).toBe(1)
        const body = out[0]!.content

        // Newest entries are present.
        expect(body).toContain('### Entry 4')
        expect(body).toContain('### Entry 3')
        // Oldest entries are absent.
        expect(body).not.toContain('### Entry 0')
        expect(body).not.toContain('### Entry 1')

        // Block fits within the declared budget.
        expect(estimate(body)).toBeLessThanOrEqual(2000)

        // Index lines for dropped entries are also absent.
        expect(body).not.toContain('Entry 0 — desc 0')
        expect(body).not.toContain('Entry 1 — desc 1')
      })
    })
  })

  it('skips a malformed on-disk entry but still injects the rest', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        await writeFixture(baseDir, auditDir, [
          makeEntry({ id: 'good', name: 'Good Entry' }),
        ])
        // Hand-write a malformed entry directly under memory/.
        const memDir = join(baseDir, 'memory')
        mkdirSync(memDir, { recursive: true })
        writeFileSync(join(memDir, 'bad.md'), 'not a valid frontmatter file')

        const out = await buildMemoryInjectionParts(baseDir, 100_000)
        expect(out.length).toBe(1)
        expect(out[0]!.content).toContain('Good Entry')
        expect(out[0]!.content).not.toContain('bad.md')
      })
    })
  })

  it('skips type filter — emits all four MEMORY_TYPES if present', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        const types: MemoryType[] = ['user', 'feedback', 'project', 'reference']
        const entries = types.map((type, i) => makeEntry({
          id: `e-${type}`,
          type,
          name: `Entry ${i}`,
        }))
        await writeFixture(baseDir, auditDir, entries)

        const out = await buildMemoryInjectionParts(baseDir, 100_000)
        expect(out.length).toBe(1)
        const body = out[0]!.content
        for (const type of types) {
          expect(body).toContain(`## ${type}`)
        }
      })
    })
  })
})
