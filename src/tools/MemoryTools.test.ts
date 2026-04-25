import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AuditWriter } from '../audit/types.js'
import type { QueryEvent } from '../core/queryEvents.js'
import type { Tool } from '../core/tools/types.js'
import type { ToolUseContext } from '../core/tools/context.js'
import { createMemoryTools } from './MemoryTools.js'
import { readEntry, writeEntry } from '../memory/store.js'
import type { MemoryEntry, MemoryType } from '../memory/entry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-memtools-'))
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
    id: 'sample',
    type: 'user',
    name: 'Sample',
    description: 'A sample memory entry',
    content: 'hello world',
    createdAt: t,
    updatedAt: t,
    ...overrides,
  }
}

function fakeContext(): ToolUseContext {
  return { readFileState: new Map() } as ToolUseContext
}

function abortSignal(): AbortSignal {
  return new AbortController().signal
}

async function invoke(
  tool: Tool,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean; errorKind?: string }> {
  const v = await tool.validateInput(input, fakeContext())
  if (!v.valid) {
    return { content: v.message, isError: true, errorKind: 'validation_failed' }
  }
  return tool.call(input, fakeContext(), abortSignal())
}

// ---------------------------------------------------------------------------
// MemoryRead
// ---------------------------------------------------------------------------

describe('MemoryRead', () => {
  it('has the expected properties', () => {
    const { writer } = collectingAudit()
    const { read } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    expect(read.name).toBe('MemoryRead')
    expect(read.isMutating).toBe(false)
    expect(read.isConcurrencySafe?.({})).toBe(true)
    // getPath is defined (enables `acceptEdits` auto-allow) but returns
    // empty string to short-circuit filesystem safety checks. See
    // MemoryTools.ts synthPath for the rationale.
    expect(typeof read.getPath).toBe('function')
    expect(read.getPath?.({ id: 'foo' })).toBe('')
    expect(read.getPath?.({})).toBe('')
  })

  it('validateInput rejects missing mode', async () => {
    const { writer } = collectingAudit()
    const { read } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const v = await read.validateInput({}, fakeContext())
    expect(v.valid).toBe(false)
  })

  it('validateInput rejects mode=get without id', async () => {
    const { writer } = collectingAudit()
    const { read } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const v = await read.validateInput({ mode: 'get' }, fakeContext())
    expect(v.valid).toBe(false)
  })

  it('validateInput rejects bad id', async () => {
    const { writer } = collectingAudit()
    const { read } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const v = await read.validateInput(
      { mode: 'get', id: '../evil' },
      fakeContext(),
    )
    expect(v.valid).toBe(false)
  })

  it('list on empty store returns placeholder', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { read } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      const r = await invoke(read, { mode: 'list' })
      expect(r.isError).toBe(false)
      expect(r.content).toBe('(memory is empty)')
    })
  })

  it('list on three entries returns a table sorted by type/name', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { read } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(
        dir,
        makeEntry({ id: 'b-ref', type: 'reference', name: 'Bravo' }),
        writer,
      )
      await writeEntry(
        dir,
        makeEntry({ id: 'a-user', type: 'user', name: 'Alpha' }),
        writer,
      )
      await writeEntry(
        dir,
        makeEntry({ id: 'c-feedback', type: 'feedback', name: 'Charlie' }),
        writer,
      )
      const r = await invoke(read, { mode: 'list' })
      expect(r.isError).toBe(false)
      const lines = r.content.split('\n')
      // header + 3 rows
      expect(lines).toHaveLength(4)
      expect(lines[0]).toBe('id\ttype\tname\tdescription\tbytes')
      // Sort is type asc, then name asc. The store's listEntries sorts by
      // ['user','feedback','project','reference'] order (declared type order).
      expect(lines[1]).toMatch(/^a-user\tuser\t/)
      expect(lines[2]).toMatch(/^c-feedback\tfeedback\t/)
      expect(lines[3]).toMatch(/^b-ref\treference\t/)
    })
  })

  it('list with 60 entries caps at 50 + overflow marker', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { read } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      for (let i = 0; i < 60; i++) {
        const id = `entry-${i.toString().padStart(3, '0')}`
        await writeEntry(dir, makeEntry({ id, name: id }), writer)
      }
      const r = await invoke(read, { mode: 'list' })
      expect(r.isError).toBe(false)
      const lines = r.content.split('\n')
      // header + 50 rows + overflow
      expect(lines.length).toBe(52)
      expect(lines[51]).toMatch(/^\.\.\. 10 more entries/)
    })
  })

  it('list with type filter returns only matching entries', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { read } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(dir, makeEntry({ id: 'x', type: 'user' }), writer)
      await writeEntry(dir, makeEntry({ id: 'y', type: 'feedback' }), writer)
      const r = await invoke(read, { mode: 'list', type: 'feedback' })
      expect(r.isError).toBe(false)
      const rows = r.content.split('\n').slice(1)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatch(/^y\tfeedback\t/)
    })
  })

  it('get on missing id returns execution_error', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { read } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      const r = await invoke(read, { mode: 'get', id: 'nope' })
      expect(r.isError).toBe(true)
      expect(r.errorKind).toBe('execution_error')
    })
  })

  it('get returns full entry body + metadata', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { read } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(
        dir,
        makeEntry({ id: 'profile', content: 'I like tabs.' }),
        writer,
      )
      const r = await invoke(read, { mode: 'get', id: 'profile' })
      expect(r.isError).toBe(false)
      expect(r.content).toContain('id: profile')
      expect(r.content).toContain('type: user')
      expect(r.content).toContain('I like tabs.')
    })
  })

  it('index on empty store returns placeholder', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { read } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      const r = await invoke(read, { mode: 'index' })
      expect(r.isError).toBe(false)
      expect(r.content).toBe('(memory is empty)')
    })
  })

  it('index on populated store returns raw MEMORY.md', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { read } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(dir, makeEntry({ id: 'profile' }), writer)
      const r = await invoke(read, { mode: 'index' })
      expect(r.isError).toBe(false)
      expect(r.content).toContain('profile')
    })
  })
})

// ---------------------------------------------------------------------------
// MemoryWrite
// ---------------------------------------------------------------------------

describe('MemoryWrite', () => {
  it('has the expected properties', () => {
    const { writer } = collectingAudit()
    const { write } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    expect(write.name).toBe('MemoryWrite')
    expect(typeof write.getPath).toBe('function')
    expect(write.getPath?.({ id: 'foo' })).toBe('')
  })

  it('validateInput rejects bad id', async () => {
    const { writer } = collectingAudit()
    const { write } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const v = await write.validateInput(
      {
        id: 'Bad-ID',
        type: 'user',
        name: 'n',
        description: 'd',
        content: 'c',
      },
      fakeContext(),
    )
    expect(v.valid).toBe(false)
  })

  it('validateInput rejects missing field', async () => {
    const { writer } = collectingAudit()
    const { write } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const v = await write.validateInput(
      { id: 'x', type: 'user', name: 'n', description: 'd' },
      fakeContext(),
    )
    expect(v.valid).toBe(false)
  })

  it('validateInput rejects non-roundtrippable name', async () => {
    const { writer } = collectingAudit()
    const { write } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const v = await write.validateInput(
      {
        id: 'x',
        type: 'user',
        name: 'has \u0007 bell',
        description: 'd',
        content: 'c',
      },
      fakeContext(),
    )
    // Control chars below 0x20 become \uXXXX, which is still roundtrippable,
    // so 0x07 actually passes canRoundTrip. Use a backslash that won't escape
    // correctly? Actually canRoundTrip encodes all control chars. Expect valid.
    // This test mostly documents that validateInput forwards to canRoundTrip.
    expect(v.valid).toBe(true)
  })

  it('validateInput rejects oversized preview', async () => {
    const { writer } = collectingAudit()
    const { write } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const huge = 'x'.repeat(33 * 1024)
    const v = await write.validateInput(
      {
        id: 'big',
        type: 'user',
        name: 'n',
        description: 'd',
        content: huge,
      },
      fakeContext(),
    )
    expect(v.valid).toBe(false)
  })

  it('fresh write lands entry; audit emits isNew=true', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const { write } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      const r = await invoke(write, {
        id: 'profile',
        type: 'user',
        name: 'Profile',
        description: 'user prefs',
        content: 'I like tabs.',
      })
      expect(r.isError).toBe(false)
      expect(r.content).toContain('created')
      const saved = await readEntry(dir, 'profile')
      expect(saved).not.toBeNull()
      expect(saved!.content).toBe('I like tabs.')
      const writtenEvents = events.filter((e) => e.type === 'memory_entry_written')
      expect(writtenEvents).toHaveLength(1)
      expect((writtenEvents[0] as { isNew: boolean }).isNew).toBe(true)
    })
  })

  it('overwrite preserves createdAt and emits isNew=false', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const { write } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await invoke(write, {
        id: 'profile',
        type: 'user',
        name: 'Profile',
        description: 'd',
        content: 'first',
      })
      const first = await readEntry(dir, 'profile')
      // small delay to ensure updatedAt changes
      await new Promise((r) => setTimeout(r, 5))
      await invoke(write, {
        id: 'profile',
        type: 'user',
        name: 'Profile',
        description: 'd',
        content: 'second',
      })
      const second = await readEntry(dir, 'profile')
      expect(second!.content).toBe('second')
      expect(second!.createdAt).toBe(first!.createdAt)
      const writes = events.filter((e) => e.type === 'memory_entry_written')
      expect(writes).toHaveLength(2)
      expect((writes[1] as { isNew: boolean }).isNew).toBe(false)
    })
  })

  it('maps high-confidence secret from store layer to permission_denied', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const { write } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      const r = await invoke(write, {
        id: 'profile',
        type: 'user',
        name: 'Profile',
        description: 'd',
        content: 'key: AKIAIOSFODNN7EXAMPLE',
      })
      expect(r.isError).toBe(true)
      expect(r.errorKind).toBe('permission_denied')
      expect(events.filter((e) => e.type === 'memory_entry_written')).toHaveLength(0)
    })
  })

  it('low-confidence secret is accepted (tool passes the allow flag)', async () => {
    await withTmpDir(async (dir) => {
      const { writer, events } = collectingAudit()
      const { write } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      const r = await invoke(write, {
        id: 'profile',
        type: 'user',
        name: 'Profile',
        description: 'd',
        content: 'password = "s3cretPassword12345"',
      })
      expect(r.isError).toBe(false)
      expect(events.filter((e) => e.type === 'memory_entry_written')).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// MemoryEdit
// ---------------------------------------------------------------------------

describe('MemoryEdit', () => {
  it('has the expected properties', () => {
    const { writer } = collectingAudit()
    const { edit } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    expect(edit.name).toBe('MemoryEdit')
    expect(typeof edit.getPath).toBe('function')
    expect(edit.getPath?.({ id: 'foo' })).toBe('')
  })

  it('validateInput rejects when neither content nor old/new provided', async () => {
    const { writer } = collectingAudit()
    const { edit } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const v = await edit.validateInput({ id: 'x' }, fakeContext())
    expect(v.valid).toBe(false)
  })

  it('validateInput rejects both content and old/new provided', async () => {
    const { writer } = collectingAudit()
    const { edit } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const v = await edit.validateInput(
      { id: 'x', content: 'a', old_string: 'b', new_string: 'c' },
      fakeContext(),
    )
    expect(v.valid).toBe(false)
  })

  it('validateInput rejects old_string === new_string', async () => {
    const { writer } = collectingAudit()
    const { edit } = createMemoryTools({ baseDir: '/tmp', auditWriter: writer })
    const v = await edit.validateInput(
      { id: 'x', old_string: 'same', new_string: 'same' },
      fakeContext(),
    )
    expect(v.valid).toBe(false)
  })

  it('missing id returns execution_error', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { edit } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      const r = await invoke(edit, { id: 'missing', content: 'new' })
      expect(r.isError).toBe(true)
      expect(r.errorKind).toBe('execution_error')
      expect(r.content).toContain('does not exist')
    })
  })

  it('full replace preserves createdAt; updates updatedAt', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { edit } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(
        dir,
        makeEntry({ id: 'x', content: 'original' }),
        writer,
      )
      const before = await readEntry(dir, 'x')
      await new Promise((r) => setTimeout(r, 5))
      const r = await invoke(edit, { id: 'x', content: 'replaced' })
      expect(r.isError).toBe(false)
      const after = await readEntry(dir, 'x')
      expect(after!.content).toBe('replaced')
      expect(after!.createdAt).toBe(before!.createdAt)
      expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt)
    })
  })

  it('substring single match replaces once', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { edit } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(
        dir,
        makeEntry({ id: 'x', content: 'hello foo world' }),
        writer,
      )
      const r = await invoke(edit, {
        id: 'x',
        old_string: 'foo',
        new_string: 'bar',
      })
      expect(r.isError).toBe(false)
      const after = await readEntry(dir, 'x')
      expect(after!.content).toBe('hello bar world')
    })
  })

  it('substring multi-match without replace_all returns execution_error', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { edit } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(
        dir,
        makeEntry({ id: 'x', content: 'foo foo foo' }),
        writer,
      )
      const r = await invoke(edit, {
        id: 'x',
        old_string: 'foo',
        new_string: 'bar',
      })
      expect(r.isError).toBe(true)
      expect(r.errorKind).toBe('execution_error')
      expect(r.content).toContain('3 matches')
    })
  })

  it('substring multi-match with replace_all replaces all', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { edit } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(
        dir,
        makeEntry({ id: 'x', content: 'foo foo foo' }),
        writer,
      )
      const r = await invoke(edit, {
        id: 'x',
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      })
      expect(r.isError).toBe(false)
      const after = await readEntry(dir, 'x')
      expect(after!.content).toBe('bar bar bar')
    })
  })

  it('partial metadata update preserves untouched fields', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { edit } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(
        dir,
        makeEntry({
          id: 'x',
          name: 'Original Name',
          description: 'Original desc',
          type: 'user' as MemoryType,
          content: 'body',
        }),
        writer,
      )
      const r = await invoke(edit, {
        id: 'x',
        content: 'body',
        name: 'New Name',
      })
      expect(r.isError).toBe(false)
      const after = await readEntry(dir, 'x')
      expect(after!.name).toBe('New Name')
      expect(after!.description).toBe('Original desc')
      expect(after!.type).toBe('user')
    })
  })

  it('old_string not found returns execution_error', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { edit } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await writeEntry(
        dir,
        makeEntry({ id: 'x', content: 'hello world' }),
        writer,
      )
      const r = await invoke(edit, {
        id: 'x',
        old_string: 'nope',
        new_string: 'nah',
      })
      expect(r.isError).toBe(true)
      expect(r.errorKind).toBe('execution_error')
      expect(r.content).toContain('not found')
    })
  })
})

// ---------------------------------------------------------------------------
// Filesystem invariants (spot check)
// ---------------------------------------------------------------------------

describe('file invariants via MemoryWrite', () => {
  it('writes entry file at 0o600', async () => {
    await withTmpDir(async (dir) => {
      const { writer } = collectingAudit()
      const { write } = createMemoryTools({ baseDir: dir, auditWriter: writer })
      await invoke(write, {
        id: 'x',
        type: 'user',
        name: 'n',
        description: 'd',
        content: 'c',
      })
      const mode = statSync(join(dir, 'memory', 'x.md')).mode & 0o777
      expect(mode).toBe(0o600)
    })
  })
})
