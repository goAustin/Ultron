/**
 * Integration test: memory store end-to-end.
 *
 * Drives `writeEntry` / `deleteEntry` against a real `createAuditWriter`,
 * asserts on-disk layout (entry files + MEMORY.md + perms), asserts the
 * audit JSONL contains metadata-only memory events, and verifies that the
 * extended `enforceBaseDirectoryPermissions` creates the memory directory
 * when a session's `appendMessage` path fires.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createAuditWriter } from '../../src/audit/auditLog.js'
import { enforceBaseDirectoryPermissions } from '../../src/memory/localMemoryGuard.js'
import {
  deleteEntry,
  readEntry,
  writeEntry,
} from '../../src/memory/store.js'
import type { MemoryEntry } from '../../src/memory/entry.js'
import { parseEntryFile } from '../../src/memory/entry.js'

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-mem-integ-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const t = Date.parse('2026-04-24T00:00:00.000Z')
  return {
    schemaVersion: 1,
    id: 'integ-entry',
    type: 'project',
    name: 'Integration sample',
    description: 'An entry exercised by the integration test',
    content: 'Body with : colons and\nmulti-line content.',
    createdAt: t,
    updatedAt: t,
    ...overrides,
  }
}

function readAuditLines(auditDir: string): Record<string, unknown>[] {
  const file = join(auditDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('memory store integration', () => {
  it('writes an entry, builds MEMORY.md, and emits a metadata-only audit event', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        const writer = createAuditWriter({ dir: auditDir })
        const entry = makeEntry()

        await writeEntry(baseDir, entry, writer)
        await writer.close()

        // Dir created + perms applied by initMemoryDir.
        const memDir = join(baseDir, 'memory')
        expect(existsSync(memDir)).toBe(true)
        expect(statSync(memDir).mode & 0o777).toBe(0o700)

        // Entry file on disk with 0o600.
        const entryFile = join(memDir, `${entry.id}.md`)
        const entryStat = statSync(entryFile)
        expect(entryStat.mode & 0o777).toBe(0o600)

        // Entry roundtrips.
        const raw = readFileSync(entryFile, 'utf8')
        const parsed = parseEntryFile(entry.id, raw)
        expect(parsed.ok).toBe(true)
        if (parsed.ok) expect(parsed.entry).toEqual(entry)

        // Index lists the entry.
        const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf8')
        expect(index).toBe(
          `- [Integration sample](integ-entry.md) — An entry exercised by the integration test\n`,
        )

        // Audit has exactly one memory_entry_written with metadata only.
        const lines = readAuditLines(auditDir)
        const mem = lines.filter((l) => l.type === 'memory_entry_written')
        expect(mem).toHaveLength(1)
        const event = mem[0]
        expect(event.id).toBe(entry.id)
        expect(event.entryType).toBe('project')
        expect(event.name).toBe(entry.name)
        expect(event.isNew).toBe(true)
        expect(typeof event.bytes).toBe('number')
        // No payload content leaks — body text and description body are
        // absent from the serialized row.
        const flat = JSON.stringify(event)
        expect(flat).not.toContain(entry.content)
      })
    })
  })

  it('delete path removes file, updates index, and emits a metadata audit event', async () => {
    await withTmpDir(async (baseDir) => {
      await withTmpDir(async (auditDir) => {
        const writer = createAuditWriter({ dir: auditDir })
        const entry = makeEntry({ id: 'to-delete' })

        await writeEntry(baseDir, entry, writer)
        await deleteEntry(baseDir, entry.id, writer)
        await writer.close()

        expect(await readEntry(baseDir, entry.id)).toBeNull()
        const index = readFileSync(
          join(baseDir, 'memory', 'MEMORY.md'),
          'utf8',
        )
        expect(index).toBe('')

        const lines = readAuditLines(auditDir)
        const written = lines.filter((l) => l.type === 'memory_entry_written')
        const deleted = lines.filter((l) => l.type === 'memory_entry_deleted')
        expect(written).toHaveLength(1)
        expect(deleted).toHaveLength(1)
        expect(deleted[0].id).toBe(entry.id)
        expect(deleted[0].entryType).toBe('project')
      })
    })
  })

  it('enforceBaseDirectoryPermissions covers memory/ alongside sessions/', async () => {
    await withTmpDir(async (dir) => {
      // Simulate the call site at src/session/transcript.ts:151 with an
      // explicit baseDir so we do not mutate $HOME for other tests.
      const baseDir = join(dir, '.ultron')
      await enforceBaseDirectoryPermissions(baseDir)

      const memDir = join(baseDir, 'memory')
      const sessionsDir = join(baseDir, 'sessions')
      expect(statSync(baseDir).isDirectory()).toBe(true)
      expect(statSync(memDir).isDirectory()).toBe(true)
      expect(statSync(sessionsDir).isDirectory()).toBe(true)
      expect(statSync(memDir).mode & 0o777).toBe(0o700)
    })
  })
})
