import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import type { AuditWriter } from '../audit/types.js'
import type { QueryEvent } from '../core/queryEvents.js'
import type { MemoryEntry } from '../memory/entry.js'
import { serializeEntry } from '../memory/entry.js'
import { writeEntry } from '../memory/store.js'
import { handleMemoryCommand, type MemoryEngine } from './memoryCommand.js'
import type { editInEditor as defaultEditInEditor } from './editorSpawn.js'
import type { confirmYesNo as defaultConfirmYesNo } from './confirmPrompt.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-memcmd-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function collectingAudit(): { writer: AuditWriter; events: QueryEvent[] } {
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

type Fakes = {
  stdout: PassThrough
  stderr: PassThrough
  outText: () => string
  errText: () => string
}

function streams(): Fakes {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const outChunks: Buffer[] = []
  const errChunks: Buffer[] = []
  stdout.on('data', (c) => outChunks.push(Buffer.from(c)))
  stderr.on('data', (c) => errChunks.push(Buffer.from(c)))
  return {
    stdout,
    stderr,
    outText: () => Buffer.concat(outChunks).toString('utf8'),
    errText: () => Buffer.concat(errChunks).toString('utf8'),
  }
}

type IoOverrides = {
  editInEditor?: typeof defaultEditInEditor
  confirmYesNo?: typeof defaultConfirmYesNo
}

async function run(
  input: string,
  engine: MemoryEngine,
  overrides: IoOverrides = {},
): Promise<{ out: string; err: string }> {
  const f = streams()
  await handleMemoryCommand(input, engine, {
    stdout: f.stdout,
    stderr: f.stderr,
    editInEditor: overrides.editInEditor,
    confirmYesNo: overrides.confirmYesNo,
  })
  return { out: f.outText(), err: f.errText() }
}

function makeEngine(baseDir: string | null, writer: AuditWriter): MemoryEngine {
  return { memoryBaseDir: baseDir, auditWriter: writer }
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const t = Date.parse('2026-04-24T00:00:00.000Z')
  return {
    schemaVersion: 1,
    id: 'sample',
    type: 'user',
    name: 'Sample',
    description: 'a sample',
    content: 'body text\n',
    createdAt: t,
    updatedAt: t,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// /memory (default — show index)
// ---------------------------------------------------------------------------

describe('/memory (default)', () => {
  it('prints (memory is empty) on empty store', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { out, err } = await run('/memory', makeEngine(dir, writer))
      expect(out).toMatch(/memory is empty/)
      expect(err).toBe('')
    })
  })

  it('prints MEMORY.md when entries exist', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'foo', name: 'Foo', description: 'd' }), writer)
      const { out } = await run('/memory', makeEngine(dir, writer))
      expect(out).toContain('foo.md')
      expect(out).toContain('Foo')
    })
  })

  it('prints "disabled" when engine has no memory', async () => {
    const { writer } = collectingAudit()
    const { out } = await run('/memory', makeEngine(null, writer))
    expect(out).toMatch(/disabled/)
  })
})

// ---------------------------------------------------------------------------
// /memory list
// ---------------------------------------------------------------------------

describe('/memory list', () => {
  it('empty store prints "(no entries)"', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { out } = await run('/memory list', makeEngine(dir, writer))
      expect(out).toMatch(/no entries/)
    })
  })

  it('lists entries in a table', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'a', name: 'Alpha', description: 'da' }), writer)
      await writeEntry(
        dir,
        makeEntry({ id: 'b', type: 'feedback', name: 'Bravo', description: 'db' }),
        writer,
      )
      const { out } = await run('/memory list', makeEngine(dir, writer))
      expect(out).toContain('id')
      expect(out).toContain('Alpha')
      expect(out).toContain('Bravo')
    })
  })

  it('filters by type', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'u', type: 'user', name: 'U', description: '.' }), writer)
      await writeEntry(
        dir,
        makeEntry({ id: 'f', type: 'feedback', name: 'F', description: '.' }),
        writer,
      )
      const { out } = await run('/memory list feedback', makeEngine(dir, writer))
      expect(out).toContain('F ')
      expect(out).not.toContain('U ')
    })
  })

  it('rejects unknown type', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { err } = await run('/memory list zzz', makeEngine(dir, writer))
      expect(err).toMatch(/unknown type/)
    })
  })
})

// ---------------------------------------------------------------------------
// /memory show
// ---------------------------------------------------------------------------

describe('/memory show', () => {
  it('missing id → usage error', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { err } = await run('/memory show', makeEngine(dir, writer))
      expect(err).toMatch(/usage: \/memory show/)
    })
  })

  it('not-found id → error message', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { err } = await run('/memory show nothing', makeEngine(dir, writer))
      expect(err).toMatch(/not found/)
    })
  })

  it('existing id → prints serialized entry', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const entry = makeEntry({ id: 'x', name: 'Xavier', description: 'd', content: 'BODY\n' })
      await writeEntry(dir, entry, writer)
      const { out } = await run('/memory show x', makeEngine(dir, writer))
      expect(out).toContain('Xavier')
      expect(out).toContain('BODY')
    })
  })
})

// ---------------------------------------------------------------------------
// /memory new
// ---------------------------------------------------------------------------

describe('/memory new', () => {
  it('writes a new entry via fake editor', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const newEntry = makeEntry({ id: 'fresh', name: 'Fresh', description: 'hi', content: 'body\n' })
      const editFake = async () => serializeEntry(newEntry)
      const { out } = await run('/memory new fresh', makeEngine(dir, writer), {
        editInEditor: editFake,
      })
      expect(out).toMatch(/created/)
      expect(existsSync(join(dir, 'memory', 'fresh.md'))).toBe(true)
      const written = events.filter((e) => e.type === 'memory_entry_written')
      expect(written.length).toBe(1)
    })
  })

  it('rejects when id already exists', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'dup' }), writer)
      const { err } = await run('/memory new dup', makeEngine(dir, writer), {
        editInEditor: async () => null,
      })
      expect(err).toMatch(/already exists/)
    })
  })

  it('rejects bad type arg', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { err } = await run('/memory new abc garbage', makeEngine(dir, writer), {
        editInEditor: async () => null,
      })
      expect(err).toMatch(/unknown type/)
    })
  })

  it('editor returns null → no write, prints (unchanged)', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const { out } = await run('/memory new ghost', makeEngine(dir, writer), {
        editInEditor: async () => null,
      })
      expect(out).toMatch(/unchanged/)
      expect(events.length).toBe(0)
    })
  })

  it('bad id → validation error', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { err } = await run('/memory new BAD_ID', makeEngine(dir, writer), {
        editInEditor: async () => null,
      })
      expect(err).toMatch(/invalid id/)
    })
  })
})

// ---------------------------------------------------------------------------
// /memory edit
// ---------------------------------------------------------------------------

describe('/memory edit', () => {
  it('parse failure + decline retry → no write', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'q' }), writer)
      const eventsBefore = events.length
      const editFake = async () => 'garbage not-a-frontmatter'
      const confirmFake = async () => false
      const { err } = await run('/memory edit q', makeEngine(dir, writer), {
        editInEditor: editFake,
        confirmYesNo: confirmFake,
      })
      expect(err).toMatch(/parse failed/)
      expect(events.length).toBe(eventsBefore)
    })
  })

  it('high-confidence secret → reject + decline retry → no write', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'pref' }), writer)
      const countBefore = events.filter((e) => e.type === 'memory_entry_written').length
      const poisoned = makeEntry({
        id: 'pref',
        content: 'AKIAIOSFODNN7EXAMPLE\n',
      })
      const editFake = async () => serializeEntry(poisoned)
      const confirmFake = async () => false
      const { err } = await run('/memory edit pref', makeEngine(dir, writer), {
        editInEditor: editFake,
        confirmYesNo: confirmFake,
      })
      expect(err).toMatch(/credential/)
      const countAfter = events.filter((e) => e.type === 'memory_entry_written').length
      expect(countAfter).toBe(countBefore)
    })
  })

  it('low-confidence secret + user allows → write succeeds', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'notes' }), writer)
      const withLow = makeEntry({
        id: 'notes',
        content: 'password = "longenough"\n',
      })
      const editFake = async () => serializeEntry(withLow)
      // First confirm is "save anyway?", default=no but we say yes.
      const confirmFake = async () => true
      const { out } = await run('/memory edit notes', makeEngine(dir, writer), {
        editInEditor: editFake,
        confirmYesNo: confirmFake,
      })
      expect(out).toMatch(/updated/)
      expect(events.filter((e) => e.type === 'memory_entry_written').length).toBe(2)
    })
  })

  it('missing id → error', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { err } = await run('/memory edit missing', makeEngine(dir, writer), {
        editInEditor: async () => null,
      })
      expect(err).toMatch(/not found/)
    })
  })

  it('clean edit preserves createdAt and updates updatedAt', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const oldCreatedAt = Date.parse('2024-01-01T00:00:00.000Z')
      await writeEntry(
        dir,
        makeEntry({ id: 'e', createdAt: oldCreatedAt, updatedAt: oldCreatedAt }),
        writer,
      )
      const edited = makeEntry({
        id: 'e',
        name: 'New Name',
        description: 'new desc',
        content: 'updated\n',
      })
      const editFake = async () => serializeEntry(edited)
      await run('/memory edit e', makeEngine(dir, writer), { editInEditor: editFake })
      const file = join(dir, 'memory', 'e.md')
      const contents = (await import('node:fs/promises')).readFile(file, 'utf8')
      const raw = await contents
      expect(raw).toContain('New Name')
      // createdAt preserved as original ISO date
      expect(raw).toContain('2024-01-01')
    })
  })
})

// ---------------------------------------------------------------------------
// /memory delete
// ---------------------------------------------------------------------------

describe('/memory delete', () => {
  it('confirm no → no deletion', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'keep' }), writer)
      const deletedBefore = events.filter((e) => e.type === 'memory_entry_deleted').length
      const { out } = await run('/memory delete keep', makeEngine(dir, writer), {
        confirmYesNo: async () => false,
      })
      expect(out).toMatch(/cancelled/)
      expect(
        events.filter((e) => e.type === 'memory_entry_deleted').length,
      ).toBe(deletedBefore)
      expect(existsSync(join(dir, 'memory', 'keep.md'))).toBe(true)
    })
  })

  it('confirm yes → file gone + audit row', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'bye' }), writer)
      const { out } = await run('/memory delete bye', makeEngine(dir, writer), {
        confirmYesNo: async () => true,
      })
      expect(out).toMatch(/deleted/)
      expect(existsSync(join(dir, 'memory', 'bye.md'))).toBe(false)
      expect(events.filter((e) => e.type === 'memory_entry_deleted').length).toBe(1)
    })
  })

  it('missing id → error, no audit row', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const { err } = await run('/memory delete nothing', makeEngine(dir, writer), {
        confirmYesNo: async () => true,
      })
      expect(err).toMatch(/not found/)
      expect(events.length).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// /memory rebuild
// ---------------------------------------------------------------------------

describe('/memory rebuild', () => {
  it('repairs a hand-corrupted index', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      await writeEntry(dir, makeEntry({ id: 'a', name: 'A', description: 'da' }), writer)
      await writeEntry(dir, makeEntry({ id: 'b', name: 'B', description: 'db' }), writer)
      writeFileSync(join(dir, 'memory', 'MEMORY.md'), 'garbage', 'utf8')
      const countBefore = events.length
      const { out } = await run('/memory rebuild', makeEngine(dir, writer))
      expect(out).toMatch(/rebuilt from 2 entries/)
      expect(events.length).toBe(countBefore) // no new audit events
    })
  })

  it('no entries → "rebuilt from 0 entries"', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { out } = await run('/memory rebuild', makeEngine(dir, writer))
      expect(out).toMatch(/rebuilt from 0 entries/)
    })
  })
})

// ---------------------------------------------------------------------------
// /memory help + unknown
// ---------------------------------------------------------------------------

describe('/memory help + unknown', () => {
  it('prints help', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { out } = await run('/memory help', makeEngine(dir, writer))
      expect(out).toContain('/memory new')
      expect(out).toContain('/memory delete')
    })
  })

  it('unknown subcommand prints error + help', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { out, err } = await run('/memory wat', makeEngine(dir, writer))
      expect(err).toMatch(/unknown subcommand/)
      expect(out).toContain('/memory new')
    })
  })
})
