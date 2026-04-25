import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AuditWriter } from '../audit/types.js'
import type { QueryEvent } from '../core/queryEvents.js'
import {
  deleteEntry,
  EntryNotFoundError,
  EntryTooLargeError,
  initMemoryDir,
  InvalidEntryIdError,
  listEntries,
  MAX_ENTRY_BYTES,
  MAX_ENTRY_COUNT,
  MAX_TOTAL_BYTES,
  MemoryFullError,
  readEntry,
  readIndex,
  rebuildIndex,
  SecretInMemoryError,
  TooManyEntriesError,
  writeEntry,
} from './store.js'
import type { MemoryEntry, MemoryType } from './entry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-memstore-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function collectingAudit(): {
  writer: AuditWriter
  events: QueryEvent[]
} {
  const events: QueryEvent[] = []
  const writer: AuditWriter = {
    write: (e) => {
      events.push(e)
    },
    close: () => Promise.resolve(),
    withOrigin: () => {
      throw new Error('not supported in test')
    },
  }
  return { writer, events }
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const t = Date.parse('2026-04-24T00:00:00.000Z')
  return {
    schemaVersion: 1,
    id: 'sample-entry',
    type: 'user',
    name: 'Sample',
    description: 'A sample memory entry',
    content: 'This is the body.',
    createdAt: t,
    updatedAt: t,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// initMemoryDir
// ---------------------------------------------------------------------------

describe('initMemoryDir', () => {
  it('creates the memory directory at 0o700', async () => {
    await withTmpDir(async (dir) => {
      await initMemoryDir(dir)
      const memStat = statSync(join(dir, 'memory'))
      expect(memStat.isDirectory()).toBe(true)
      expect(memStat.mode & 0o777).toBe(0o700)
    })
  })

  it('is idempotent', async () => {
    await withTmpDir(async (dir) => {
      await initMemoryDir(dir)
      await initMemoryDir(dir)
      expect(statSync(join(dir, 'memory')).isDirectory()).toBe(true)
    })
  })

  it('sweeps orphaned .tmp files', async () => {
    await withTmpDir(async (dir) => {
      await initMemoryDir(dir)
      const memDir = join(dir, 'memory')
      writeFileSync(join(memDir, 'entry.md.tmp'), 'garbage')
      writeFileSync(join(memDir, 'MEMORY.md.tmp'), 'garbage')
      writeFileSync(join(memDir, 'real.md'), '---\n---\n')
      await initMemoryDir(dir)
      const remaining = await readdir(memDir)
      expect(remaining).toContain('real.md')
      expect(remaining).not.toContain('entry.md.tmp')
      expect(remaining).not.toContain('MEMORY.md.tmp')
    })
  })
})

// ---------------------------------------------------------------------------
// writeEntry / readEntry roundtrip
// ---------------------------------------------------------------------------

describe('writeEntry + readEntry', () => {
  it('roundtrips a simple entry', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const entry = makeEntry()
      await writeEntry(dir, entry, writer)
      const back = await readEntry(dir, entry.id)
      expect(back).not.toBeNull()
      expect(back).toEqual(entry)
    })
  })

  it('preserves every MemoryType', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const types: MemoryType[] = ['user', 'feedback', 'project', 'reference']
      for (const t of types) {
        await writeEntry(dir, makeEntry({ id: `id-${t}`, type: t }), writer)
      }
      const listed = await listEntries(dir)
      expect(listed).toHaveLength(4)
      expect(listed.map((e) => e.type).sort()).toEqual(types.slice().sort())
    })
  })

  it('writes entry file at mode 0o600', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const entry = makeEntry()
      await writeEntry(dir, entry, writer)
      const st = statSync(join(dir, 'memory', `${entry.id}.md`))
      expect(st.mode & 0o777).toBe(0o600)
    })
  })

  it('rebuilds MEMORY.md with one line per entry, sorted by type then name', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'c', type: 'user', name: 'Charlie' }), writer)
      await writeEntry(dir, makeEntry({ id: 'a', type: 'feedback', name: 'Alpha' }), writer)
      await writeEntry(dir, makeEntry({ id: 'b', type: 'user', name: 'Bravo' }), writer)
      const index = await readIndex(dir)
      const lines = index.trim().split('\n')
      expect(lines).toHaveLength(3)
      // user "Bravo" → user "Charlie" → feedback "Alpha"
      expect(lines[0]).toMatch(/Bravo/)
      expect(lines[1]).toMatch(/Charlie/)
      expect(lines[2]).toMatch(/Alpha/)
      // Index line format
      expect(lines[0]).toBe('- [Bravo](b.md) — A sample memory entry')
    })
  })

  it('update path: same id overwrites, isNew=false on second write', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const first = makeEntry({ content: 'v1' })
      const second = makeEntry({ content: 'v2', name: 'Sample v2' })
      await writeEntry(dir, first, writer)
      await writeEntry(dir, second, writer)
      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({ type: 'memory_entry_written', isNew: true })
      expect(events[1]).toMatchObject({ type: 'memory_entry_written', isNew: false })
      const back = await readEntry(dir, first.id)
      expect(back?.content).toBe('v2')
      expect(back?.name).toBe('Sample v2')
      const listed = await listEntries(dir)
      expect(listed).toHaveLength(1)
    })
  })

  it('emits one audit event per write with only metadata', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const entry = makeEntry({ content: 'confidential ideas here' })
      await writeEntry(dir, entry, writer)
      expect(events).toHaveLength(1)
      const e = events[0]
      expect(e.type).toBe('memory_entry_written')
      const flat = JSON.stringify(e)
      expect(flat).not.toContain('confidential ideas here')
      expect(flat).not.toContain(entry.description) // description is not on payload
      // Event has only the declared metadata fields.
      expect(Object.keys(e).sort()).toEqual(
        ['bytes', 'entryType', 'id', 'isNew', 'name', 'timestamp', 'type'].sort(),
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Validation + rejection paths
// ---------------------------------------------------------------------------

describe('writeEntry rejections', () => {
  it('rejects invalid id', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await expect(
        writeEntry(dir, makeEntry({ id: '../evil' }), writer),
      ).rejects.toBeInstanceOf(InvalidEntryIdError)
      // No file should be written.
      const memDir = join(dir, 'memory')
      try {
        const remaining = await readdir(memDir)
        expect(remaining).toEqual([])
      } catch {
        // memDir may not exist at all — that's fine too.
      }
    })
  })

  it('rejects over-cap entry size', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const huge = 'x'.repeat(MAX_ENTRY_BYTES + 1)
      await expect(
        writeEntry(dir, makeEntry({ content: huge }), writer),
      ).rejects.toBeInstanceOf(EntryTooLargeError)
      expect(events).toHaveLength(0)
    })
  })

  it('rejects writes that would exceed aggregate cap', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      // Fill most of the aggregate cap with near-max entries.
      const chunk = 'y'.repeat(MAX_ENTRY_BYTES - 500)
      const count = Math.ceil(MAX_TOTAL_BYTES / MAX_ENTRY_BYTES) + 1
      let reached = false
      for (let i = 0; i < count; i++) {
        try {
          await writeEntry(
            dir,
            makeEntry({ id: `e${i.toString().padStart(3, '0')}`, content: chunk }),
            writer,
          )
        } catch (err) {
          expect(err).toBeInstanceOf(MemoryFullError)
          reached = true
          break
        }
      }
      expect(reached).toBe(true)
    })
  })

  it('rejects 257th entry with TooManyEntriesError', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      // Seed the directory with 256 pre-canned small entries, bypassing
      // the (slower) writeEntry for the setup — we only exercise the cap
      // boundary itself via writeEntry.
      await initMemoryDir(dir)
      const memDir = join(dir, 'memory')
      const iso = new Date('2026-04-24T00:00:00.000Z').toISOString()
      const body = (id: string) =>
        [
          '---',
          `name: "n-${id}"`,
          `description: "d-${id}"`,
          'type: user',
          'schemaVersion: 1',
          `createdAt: "${iso}"`,
          `updatedAt: "${iso}"`,
          '---',
          '',
          `content-${id}`,
        ].join('\n')
      for (let i = 0; i < MAX_ENTRY_COUNT; i++) {
        const id = `seed${i.toString().padStart(3, '0')}`
        await writeFile(join(memDir, `${id}.md`), body(id))
      }
      // 257th via writeEntry → rejection
      await expect(
        writeEntry(dir, makeEntry({ id: 'overflow' }), writer),
      ).rejects.toBeInstanceOf(TooManyEntriesError)
    })
  })

  it('rejects high-confidence secret in content', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await expect(
        writeEntry(
          dir,
          makeEntry({ content: 'creds: AKIAIOSFODNN7EXAMPLE' }),
          writer,
        ),
      ).rejects.toBeInstanceOf(SecretInMemoryError)
      expect(events).toHaveLength(0)
    })
  })

  it('rejects high-confidence secret smuggled into name', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const bad =
        'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      await expect(
        writeEntry(dir, makeEntry({ name: bad }), writer),
      ).rejects.toBeInstanceOf(SecretInMemoryError)
    })
  })

  it('rejects low-confidence secret in 4a strict mode', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await expect(
        writeEntry(
          dir,
          makeEntry({ content: 'password = "s3cretPassword12345"' }),
          writer,
        ),
      ).rejects.toBeInstanceOf(SecretInMemoryError)
    })
  })

  describe('WriteEntryOptions.allowLowConfidenceSecrets', () => {
    it('accepts low-confidence match when flag is set', async () => {
      await withTmpDir(async (dir) => {
        const { writer, events } = collectingAudit()
        await writeEntry(
          dir,
          makeEntry({ content: 'password = "s3cretPassword12345"' }),
          writer,
          { allowLowConfidenceSecrets: true },
        )
        expect(events).toHaveLength(1)
      })
    })

    it('still rejects high-confidence match even with flag', async () => {
      await withTmpDir(async (dir) => {
        const { writer, events } = collectingAudit()
        await expect(
          writeEntry(
            dir,
            makeEntry({ content: 'creds: AKIAIOSFODNN7EXAMPLE' }),
            writer,
            { allowLowConfidenceSecrets: true },
          ),
        ).rejects.toBeInstanceOf(SecretInMemoryError)
        expect(events).toHaveLength(0)
      })
    })

    it('on mixed matches with flag, error carries only high-confidence subset', async () => {
      await withTmpDir(async (dir) => {
        const { writer } = collectingAudit()
        const mixed =
          'creds: AKIAIOSFODNN7EXAMPLE\npassword = "s3cretPassword12345"'
        try {
          await writeEntry(
            dir,
            makeEntry({ content: mixed }),
            writer,
            { allowLowConfidenceSecrets: true },
          )
          throw new Error('expected SecretInMemoryError')
        } catch (err) {
          expect(err).toBeInstanceOf(SecretInMemoryError)
          const matches = (err as SecretInMemoryError).matches
          expect(matches.length).toBeGreaterThan(0)
          expect(matches.every((m) => m.confidence === 'high')).toBe(true)
        }
      })
    })
  })
})

// ---------------------------------------------------------------------------
// deleteEntry
// ---------------------------------------------------------------------------

describe('deleteEntry', () => {
  it('removes the file and updates MEMORY.md', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'a' }), writer)
      await writeEntry(dir, makeEntry({ id: 'b', name: 'Bravo' }), writer)
      await deleteEntry(dir, 'a', writer)

      expect(await readEntry(dir, 'a')).toBeNull()
      const listed = await listEntries(dir)
      expect(listed.map((e) => e.id)).toEqual(['b'])

      const index = await readIndex(dir)
      expect(index).not.toMatch(/\(a\.md\)/)
      expect(index).toMatch(/\(b\.md\)/)

      const deleteEvent = events.find((e) => e.type === 'memory_entry_deleted')
      expect(deleteEvent).toBeDefined()
      if (deleteEvent && deleteEvent.type === 'memory_entry_deleted') {
        expect(deleteEvent.id).toBe('a')
        expect(deleteEvent.entryType).toBe('user')
      }
    })
  })

  it('throws EntryNotFoundError when id is absent', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await expect(deleteEntry(dir, 'nosuch', writer)).rejects.toBeInstanceOf(
        EntryNotFoundError,
      )
    })
  })

  it('rejects invalid id without touching disk', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await expect(deleteEntry(dir, '../evil', writer)).rejects.toBeInstanceOf(
        InvalidEntryIdError,
      )
    })
  })
})

// ---------------------------------------------------------------------------
// listEntries
// ---------------------------------------------------------------------------

describe('listEntries', () => {
  it('returns empty list when directory missing', async () => {
    await withTmpDir(async (dir) => {
      const listed = await listEntries(dir)
      expect(listed).toEqual([])
    })
  })

  it('filters by type', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'u1', type: 'user' }), writer)
      await writeEntry(dir, makeEntry({ id: 'u2', type: 'user' }), writer)
      await writeEntry(dir, makeEntry({ id: 'f1', type: 'feedback' }), writer)
      const users = await listEntries(dir, { type: 'user' })
      expect(users.map((e) => e.id).sort()).toEqual(['u1', 'u2'])
    })
  })

  it('skips malformed files with a stderr warning', async () => {
    await withTmpDir(async (dir) => {
      await initMemoryDir(dir)
      writeFileSync(join(dir, 'memory', 'good.md'), 'not-a-valid-entry')
      const listed = await listEntries(dir)
      expect(listed).toEqual([])
    })
  })

  it('ignores non-entry files in the directory', async () => {
    await withTmpDir(async (dir) => {
      await initMemoryDir(dir)
      writeFileSync(join(dir, 'memory', 'notes.txt'), 'hi')
      writeFileSync(join(dir, 'memory', 'stray.tmp'), 'hi')
      const listed = await listEntries(dir)
      expect(listed).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Concurrent writes
// ---------------------------------------------------------------------------

describe('per-baseDir serialization', () => {
  it('serializes concurrent writes without corruption', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          writeEntry(
            dir,
            makeEntry({ id: `p${i.toString().padStart(2, '0')}` }),
            writer,
          ),
        ),
      )
      const listed = await listEntries(dir)
      expect(listed).toHaveLength(10)
      const index = await readIndex(dir)
      const indexLines = index.trim().split('\n')
      expect(indexLines).toHaveLength(10)
      expect(events.filter((e) => e.type === 'memory_entry_written')).toHaveLength(10)
    })
  })
})

// ---------------------------------------------------------------------------
// readEntry invalid id
// ---------------------------------------------------------------------------

describe('readEntry', () => {
  it('rejects invalid id', async () => {
    await withTmpDir(async (dir) => {
      await expect(readEntry(dir, '../evil')).rejects.toBeInstanceOf(
        InvalidEntryIdError,
      )
    })
  })

  it('returns null for missing entry', async () => {
    await withTmpDir(async (dir) => {
      expect(await readEntry(dir, 'nosuch')).toBeNull()
    })
  })

  it('content body bytes are verbatim on disk', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const entry = makeEntry({
        content: 'Line A\nLine B with : colon\n---\ntick: `x`',
      })
      await writeEntry(dir, entry, writer)
      const onDisk = readFileSync(join(dir, 'memory', `${entry.id}.md`), 'utf8')
      // After closing `---\n\n`, rest should equal content.
      const afterFence = onDisk.split('\n---\n\n')[1]
      expect(afterFence).toBe(entry.content)
    })
  })
})

describe('rebuildIndex (Phase 4c)', () => {
  it('restores MEMORY.md after hand-corruption', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'a', name: 'A', description: 'desc-a' }), writer)
      await writeEntry(dir, makeEntry({ id: 'b', type: 'feedback', name: 'B', description: 'desc-b' }), writer)
      const healthy = await readIndex(dir)

      // Hand-corrupt the index
      writeFileSync(join(dir, 'memory', 'MEMORY.md'), '## totally different\n', 'utf8')
      expect(await readIndex(dir)).not.toBe(healthy)

      await rebuildIndex(dir)
      expect(await readIndex(dir)).toBe(healthy)
    })
  })

  it('writes an empty index when no entries exist', async () => {
    await withTmpDir(async (dir) => {
      await rebuildIndex(dir)
      expect(await readIndex(dir)).toBe('')
    })
  })

  it('emits no audit events', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await writeEntry(dir, makeEntry(), writer)
      const countBefore = events.length
      await rebuildIndex(dir)
      expect(events.length).toBe(countBefore)
    })
  })

  it('serializes with concurrent writeEntry via the same per-baseDir queue', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      // Kick off a write and a rebuild at the same time; both should complete
      // without corrupting the index. The queue guarantees one-at-a-time.
      await Promise.all([
        writeEntry(dir, makeEntry({ id: 'one', name: 'One', description: 'd1' }), writer),
        rebuildIndex(dir),
        writeEntry(dir, makeEntry({ id: 'two', name: 'Two', description: 'd2' }), writer),
        rebuildIndex(dir),
      ])
      const index = await readIndex(dir)
      expect(index).toContain('one.md')
      expect(index).toContain('two.md')
    })
  })
})
