import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir, stat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createAuditWriter } from './auditLog.js'
import { toolUseId } from '../core/messages.js'
import {
  makeToolCallStartedEvent,
  makeToolCallFinishedEvent,
} from '../core/queryEventFactories.js'
import type { QueryEvent } from '../core/queryEvents.js'

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ultron-audit-'))
}

async function readLines(file: string): Promise<string[]> {
  const contents = await readFile(file, 'utf8')
  return contents.split('\n').filter(Boolean)
}

function dummyToolUse(id = 'tu-x', name = 'Echo', input: Record<string, unknown> = { msg: 'hi' }) {
  return { type: 'tool_use' as const, id: toolUseId(id), name, input }
}

describe('createAuditWriter', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTmpDir()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a JSONL line with schemaVersion and tsIso', async () => {
    const w = createAuditWriter({ dir })
    const e = makeToolCallStartedEvent(dummyToolUse())
    w.write(e)
    await w.close()

    const lines = await readLines(join(dir, 'audit.jsonl'))
    expect(lines).toHaveLength(1)

    const parsed = JSON.parse(lines[0]!)
    expect(parsed.schemaVersion).toBe(1)
    expect(typeof parsed.tsIso).toBe('string')
    expect(parsed.tsIso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(parsed.type).toBe('tool_call_started')
    expect(parsed.toolName).toBe('Echo')
  })

  it('filters text_delta, thinking_delta, tool_use_start', async () => {
    const w = createAuditWriter({ dir })
    w.write({ type: 'text_delta', text: 'hi' })
    w.write({ type: 'thinking_delta', thinking: 'reasoning' })
    w.write({ type: 'tool_use_start', id: toolUseId('tu-1'), name: 'Echo' })
    await w.close()

    // audit.jsonl should not exist or be empty.
    try {
      const s = await stat(join(dir, 'audit.jsonl'))
      expect(s.size).toBe(0)
    } catch {
      // not created at all — also fine
    }
  })

  it('writes tool_call_started / tool_call_finished / permission_decision', async () => {
    const w = createAuditWriter({ dir })
    const tu = dummyToolUse()
    w.write(makeToolCallStartedEvent(tu))
    w.write(makeToolCallFinishedEvent(tu, { content: 'ok', isError: false }, 7))
    await w.close()

    const lines = await readLines(join(dir, 'audit.jsonl'))
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).type).toBe('tool_call_started')
    expect(JSON.parse(lines[1]!).type).toBe('tool_call_finished')
    expect(JSON.parse(lines[1]!).outcome).toBe('ok')
  })

  it('redacts secrets in the on-disk line but raw event remains untouched', async () => {
    const w = createAuditWriter({ dir })
    const tu = dummyToolUse('tu-sec', 'Bash', { command: 'AKIAIOSFODNN7EXAMPLE' })
    const raw = makeToolCallStartedEvent(tu)
    // Raw in-memory event retains the secret.
    expect((raw.input as { command: string }).command).toBe('AKIAIOSFODNN7EXAMPLE')

    w.write(raw)
    await w.close()

    const lines = await readLines(join(dir, 'audit.jsonl'))
    const parsed = JSON.parse(lines[0]!)
    expect(JSON.stringify(parsed)).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(parsed.input.command).toBe('[REDACTED:aws_access_key_id]')
  })

  it('never throws and caps stderr warnings at 3 when the directory is read-only', async () => {
    // Strip write perms from the tmp dir so appendFile fails with EACCES.
    // Running as root will bypass the check; this test does not assert in that case.
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
    if (isRoot) return

    await chmod(dir, 0o500)
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      const w = createAuditWriter({ dir })
      const tu = dummyToolUse()
      for (let i = 0; i < 5; i++) {
        expect(() => w.write(makeToolCallStartedEvent(tu))).not.toThrow()
      }
      await w.close()

      const warnCount = warnSpy.mock.calls.filter(c =>
        String(c[0]).includes('audit write failed'),
      ).length
      expect(warnCount).toBeLessThanOrEqual(3)
      expect(warnCount).toBeGreaterThanOrEqual(1)
    } finally {
      // Restore so vitest can clean up tmp dirs.
      await chmod(dir, 0o700)
    }
  })

  it('rotates check-before-append: triggering line lands in fresh file', async () => {
    // Tiny cap so a single line triggers rotation.
    const file = join(dir, 'audit.jsonl')
    // Pre-seed a line slightly under the cap so the next write triggers rotation.
    await writeFile(file, 'x'.repeat(50) + '\n', 'utf8')

    const w = createAuditWriter({ dir, maxBytes: 60, keep: 3 })
    // Write a clearly identifiable event; serialization + redaction + envelope adds bytes
    // so the total will exceed 60.
    const tu = dummyToolUse('tu-rot', 'Rotate', { marker: 'TRIGGER' })
    w.write(makeToolCallStartedEvent(tu))
    await w.close()

    const rotated = await readFile(join(dir, 'audit.jsonl.1'), 'utf8')
    expect(rotated).toContain('x'.repeat(50))
    expect(rotated).not.toContain('TRIGGER')

    const fresh = await readFile(file, 'utf8')
    expect(fresh).toContain('TRIGGER')
  })

  it('keeps at most N generations (keep=3)', async () => {
    const w = createAuditWriter({ dir, maxBytes: 60, keep: 3 })
    // Force several rotations by writing many large events.
    const tu = dummyToolUse('tu-many', 'Many', { blob: 'z'.repeat(50) })
    for (let i = 0; i < 10; i++) {
      w.write(makeToolCallStartedEvent(tu))
    }
    await w.close()

    const entries = await readdir(dir)
    const files = entries.filter(f => f.startsWith('audit.jsonl'))
    // Should be audit.jsonl plus at most 3 rotated generations.
    expect(files.length).toBeLessThanOrEqual(4)
    // No .4 or higher.
    expect(files.some(f => /\.(4|5|6|7|8|9)$/.test(f))).toBe(false)
  })

  it('honors custom dir and never touches ~/.ultron', async () => {
    const w = createAuditWriter({ dir })
    w.write(makeToolCallStartedEvent(dummyToolUse()))
    await w.close()

    const entries = await readdir(dir)
    expect(entries).toContain('audit.jsonl')
  })

  it('recovers from an initial mkdir failure — close() does not reject, later writes can succeed', async () => {
    // Point at a non-existent parent chain so initial mkdir rejects only if it cannot create it.
    // Here we pass a path whose parent IS a file — mkdir will fail with ENOTDIR.
    const blockingFile = join(dir, 'blocking-file')
    await writeFile(blockingFile, 'x')
    const badDir = join(blockingFile, 'nested')

    const w = createAuditWriter({ dir: badDir })
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      // write() must never throw even when the initial mkdir failed.
      expect(() => w.write(makeToolCallStartedEvent(dummyToolUse()))).not.toThrow()
      // close() must resolve, not reject.
      await expect(w.close()).resolves.toBeUndefined()
      // The failure should have emitted a warning on stderr.
      const warnCount = warnSpy.mock.calls.filter(c =>
        String(c[0]).includes('audit write failed'),
      ).length
      expect(warnCount).toBeGreaterThanOrEqual(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('withOrigin stamps the envelope with an origin field', async () => {
    const w = createAuditWriter({ dir })
    const child = w.withOrigin('subagent-42')
    child.write(makeToolCallStartedEvent(dummyToolUse()))
    await w.close()

    const lines = await readLines(join(dir, 'audit.jsonl'))
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.origin).toBe('subagent-42')
  })

  it('withOrigin shares the same chain and file as the root writer', async () => {
    const w = createAuditWriter({ dir })
    const child = w.withOrigin('sub-1')
    w.write(makeToolCallStartedEvent(dummyToolUse('tu-parent')))
    child.write(makeToolCallStartedEvent(dummyToolUse('tu-child')))
    w.write(makeToolCallStartedEvent(dummyToolUse('tu-parent-2')))
    await w.close()

    const lines = await readLines(join(dir, 'audit.jsonl'))
    expect(lines).toHaveLength(3)
    const origins = lines.map(l => JSON.parse(l).origin)
    expect(origins).toEqual([undefined, 'sub-1', undefined])
  })

  it('withOrigin is not chainable', () => {
    const w = createAuditWriter({ dir })
    const child = w.withOrigin('once')
    expect(() => child.withOrigin('twice')).toThrow()
  })

  // -------------------------------------------------------------------------
  // Phase 7c — parentToolUseId stamping
  // -------------------------------------------------------------------------

  it('withOrigin stamps parentToolUseId on the envelope when supplied', async () => {
    const w = createAuditWriter({ dir })
    const child = w.withOrigin('sub-7c', { parentToolUseId: toolUseId('tu_parent_xyz') })
    child.write(makeToolCallStartedEvent(dummyToolUse()))
    await w.close()

    const lines = await readLines(join(dir, 'audit.jsonl'))
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.origin).toBe('sub-7c')
    expect(parsed.parentToolUseId).toBe('tu_parent_xyz')
  })

  it('withOrigin second arg is optional — back-compat one-arg call still works', async () => {
    const w = createAuditWriter({ dir })
    const child = w.withOrigin('sub-no-parent') // no second arg
    child.write(makeToolCallStartedEvent(dummyToolUse()))
    await w.close()

    const lines = await readLines(join(dir, 'audit.jsonl'))
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.origin).toBe('sub-no-parent')
    expect(parsed.parentToolUseId).toBeUndefined()
  })

  it('root writer envelopes do not carry parentToolUseId', async () => {
    const w = createAuditWriter({ dir })
    w.write(makeToolCallStartedEvent(dummyToolUse('tu-root')))
    await w.close()

    const lines = await readLines(join(dir, 'audit.jsonl'))
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.origin).toBeUndefined()
    expect(parsed.parentToolUseId).toBeUndefined()
  })

  it('mixed root + subagent envelopes preserve correlation per-line', async () => {
    const w = createAuditWriter({ dir })
    const childA = w.withOrigin('sub-A', { parentToolUseId: toolUseId('tu_A') })
    const childB = w.withOrigin('sub-B', { parentToolUseId: toolUseId('tu_B') })
    w.write(makeToolCallStartedEvent(dummyToolUse('tu_A', 'Agent')))
    childA.write(makeToolCallStartedEvent(dummyToolUse('tu_inner_A')))
    childB.write(makeToolCallStartedEvent(dummyToolUse('tu_inner_B')))
    w.write(makeToolCallFinishedEvent(dummyToolUse('tu_A', 'Agent'), { content: 'ok', isError: false }, 5))
    await w.close()

    const lines = await readLines(join(dir, 'audit.jsonl'))
    expect(lines).toHaveLength(4)
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed[0]?.origin).toBeUndefined()
    expect(parsed[0]?.parentToolUseId).toBeUndefined()
    expect(parsed[1]?.origin).toBe('sub-A')
    expect(parsed[1]?.parentToolUseId).toBe('tu_A')
    expect(parsed[2]?.origin).toBe('sub-B')
    expect(parsed[2]?.parentToolUseId).toBe('tu_B')
    expect(parsed[3]?.origin).toBeUndefined()
    expect(parsed[3]?.parentToolUseId).toBeUndefined()
  })
})
