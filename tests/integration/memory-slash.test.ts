/**
 * Integration test: `/memory` slash command end-to-end.
 *
 * Drives `handleMemoryCommand` against a real `QueryEngine` + real
 * `createAuditWriter`, with only the editor and confirm prompt stubbed.
 * Asserts on-disk entry files, `MEMORY.md` regeneration, and metadata-only
 * audit rows.
 */

import { describe, it, expect } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { createAuditWriter } from '../../src/audit/auditLog.js'
import { QueryEngine } from '../../src/sdk/QueryEngine.js'
import type { QueryEngineConfig } from '../../src/sdk/QueryEngine.js'
import { handleMemoryCommand } from '../../src/cli/memoryCommand.js'
import { serializeEntry, type MemoryEntry } from '../../src/memory/entry.js'
import { writeEntry } from '../../src/memory/store.js'

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-memslash-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function streams(): {
  stdout: PassThrough
  stderr: PassThrough
  outText: () => string
  errText: () => string
} {
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

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const t = Date.parse('2026-04-24T00:00:00.000Z')
  return {
    schemaVersion: 1,
    id: 'sample',
    type: 'user',
    name: 'Sample',
    description: 'a sample',
    content: 'body\n',
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

function makeEngine(
  cwd: string,
  memoryBaseDir: string,
  auditDir: string,
  disableMemory = false,
): { engine: QueryEngine; auditFile: string } {
  const auditWriter = createAuditWriter({ dir: auditDir })
  const config: QueryEngineConfig = {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    cwd,
    memoryBaseDir,
    auditWriter,
    disableMemory,
  }
  const engine = new QueryEngine(config)
  return { engine, auditFile: join(auditDir, 'audit.jsonl') }
}

describe('/memory integration', () => {
  it('new entry happy path → file + audit row + index', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (memDir) => {
        await withTmpDir(async (auditDir) => {
          const { engine } = makeEngine(cwd, memDir, auditDir)
          const fresh = makeEntry({ id: 'pref', name: 'Pref', description: 'd', content: 'v\n' })
          const f = streams()
          await handleMemoryCommand('/memory new pref', engine, {
            stdout: f.stdout,
            stderr: f.stderr,
            editInEditor: async () => serializeEntry(fresh),
          })
          await engine.auditWriter.close()
          await engine.dispose()

          expect(f.outText()).toMatch(/created/)
          expect(existsSync(join(memDir, 'memory', 'pref.md'))).toBe(true)

          const events = readAuditLines(auditDir)
          const written = events.filter((e) => e.type === 'memory_entry_written')
          expect(written.length).toBe(1)
          // Metadata only — no content, no description
          expect(written[0]).not.toHaveProperty('content')
          expect(written[0]).not.toHaveProperty('description')
        })
      })
    })
  })

  it('new entry with high-confidence secret → rejected, no audit row', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (memDir) => {
        await withTmpDir(async (auditDir) => {
          const { engine } = makeEngine(cwd, memDir, auditDir)
          const poisoned = makeEntry({
            id: 'bad',
            content: 'AKIAIOSFODNN7EXAMPLE\n',
          })
          const f = streams()
          await handleMemoryCommand('/memory new bad', engine, {
            stdout: f.stdout,
            stderr: f.stderr,
            editInEditor: async () => serializeEntry(poisoned),
            confirmYesNo: async () => false, // decline retry
          })
          await engine.auditWriter.close()
          await engine.dispose()

          expect(f.errText()).toMatch(/credential/)
          expect(existsSync(join(memDir, 'memory', 'bad.md'))).toBe(false)
          const events = readAuditLines(auditDir)
          expect(events.filter((e) => e.type === 'memory_entry_written').length).toBe(0)
        })
      })
    })
  })

  it('edit with low-confidence secret + user allows → write succeeds', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (memDir) => {
        await withTmpDir(async (auditDir) => {
          const { engine } = makeEngine(cwd, memDir, auditDir)
          // Seed a clean entry first
          await writeEntry(memDir, makeEntry({ id: 'notes' }), engine.auditWriter)

          const withLow = makeEntry({
            id: 'notes',
            content: 'password = "longenough"\n',
          })
          const f = streams()
          await handleMemoryCommand('/memory edit notes', engine, {
            stdout: f.stdout,
            stderr: f.stderr,
            editInEditor: async () => serializeEntry(withLow),
            confirmYesNo: async () => true, // save anyway
          })
          await engine.auditWriter.close()
          await engine.dispose()

          expect(f.outText()).toMatch(/updated/)
          const events = readAuditLines(auditDir)
          const written = events.filter((e) => e.type === 'memory_entry_written')
          expect(written.length).toBe(2) // initial seed + edit
        })
      })
    })
  })

  it('delete happy path → file gone + audit row', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (memDir) => {
        await withTmpDir(async (auditDir) => {
          const { engine } = makeEngine(cwd, memDir, auditDir)
          await writeEntry(memDir, makeEntry({ id: 'doomed' }), engine.auditWriter)

          const f = streams()
          await handleMemoryCommand('/memory delete doomed', engine, {
            stdout: f.stdout,
            stderr: f.stderr,
            confirmYesNo: async () => true,
          })
          await engine.auditWriter.close()
          await engine.dispose()

          expect(f.outText()).toMatch(/deleted/)
          expect(existsSync(join(memDir, 'memory', 'doomed.md'))).toBe(false)
          const events = readAuditLines(auditDir)
          expect(events.filter((e) => e.type === 'memory_entry_deleted').length).toBe(1)
        })
      })
    })
  })

  it('rebuild restores MEMORY.md after hand-corruption', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (memDir) => {
        await withTmpDir(async (auditDir) => {
          const { engine } = makeEngine(cwd, memDir, auditDir)
          await writeEntry(
            memDir,
            makeEntry({ id: 'a', name: 'A', description: 'da' }),
            engine.auditWriter,
          )
          await writeEntry(
            memDir,
            makeEntry({ id: 'b', name: 'B', description: 'db' }),
            engine.auditWriter,
          )
          const healthy = readFileSync(join(memDir, 'memory', 'MEMORY.md'), 'utf8')
          writeFileSync(join(memDir, 'memory', 'MEMORY.md'), 'GARBAGE\n', 'utf8')

          const f = streams()
          await handleMemoryCommand('/memory rebuild', engine, {
            stdout: f.stdout,
            stderr: f.stderr,
          })
          await engine.auditWriter.close()
          await engine.dispose()

          expect(f.outText()).toMatch(/rebuilt from 2 entries/)
          expect(readFileSync(join(memDir, 'memory', 'MEMORY.md'), 'utf8')).toBe(healthy)
        })
      })
    })
  })

  it('engine with disableMemory:true → prints disabled, no filesystem access', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        // No memDir — we don't care; memoryBaseDir is ignored when disabled
        const { engine } = makeEngine(cwd, cwd, auditDir, true)
        const f = streams()
        await handleMemoryCommand('/memory', engine, {
          stdout: f.stdout,
          stderr: f.stderr,
        })
        await engine.dispose()
        expect(f.outText()).toMatch(/disabled/)
      })
    })
  })
})
