/**
 * Memory store — typed on-disk entries + regenerated index.
 *
 * Layout under `<baseDir>/memory/`:
 *   - `<id>.md`    — one file per entry, mode 0o600
 *   - `MEMORY.md`  — regenerated index, one line per entry
 *
 * All mutations go through `atomicWrite` (tmp + fsync + rename + parent fsync)
 * and serialize on a per-baseDir promise chain so concurrent writes from the
 * same process land deterministically. MEMORY.md is never the source of
 * truth — every `listEntries` call reads the directory directly, and
 * mutations rebuild the index from that listing.
 *
 * Write gate in 4a rejects on ANY secret match (high or low confidence),
 * since 4a has no user-facing ask UX. 4b may loosen this when the
 * tool-seam gains an askUser hook.
 */

import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AuditWriter } from '../audit/types.js'
import {
  makeMemoryEntryDeletedEvent,
  makeMemoryEntryWrittenEvent,
} from '../core/queryEventFactories.js'
import {
  canRoundTrip,
  parseEntryFile,
  serializeEntry,
  validateId,
  type MemoryEntry,
  type MemoryType,
} from './entry.js'
import { detectSecrets, type SecretMatch } from './secretScanner.js'

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export const MAX_ENTRY_BYTES = 32 * 1024
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const MAX_ENTRY_COUNT = 256

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class InvalidEntryIdError extends Error {
  constructor(readonly id: string) {
    super(`Invalid memory entry id: ${JSON.stringify(id)}`)
    this.name = 'InvalidEntryIdError'
  }
}

export class EntryTooLargeError extends Error {
  constructor(readonly bytes: number, readonly cap: number) {
    super(`Entry too large: ${bytes} bytes exceeds cap of ${cap}`)
    this.name = 'EntryTooLargeError'
  }
}

export class MemoryFullError extends Error {
  constructor(readonly totalBytes: number, readonly cap: number) {
    super(`Memory store full: ${totalBytes} bytes would exceed cap of ${cap}`)
    this.name = 'MemoryFullError'
  }
}

export class TooManyEntriesError extends Error {
  constructor(readonly count: number, readonly cap: number) {
    super(`Too many memory entries: ${count} would exceed cap of ${cap}`)
    this.name = 'TooManyEntriesError'
  }
}

export class SecretInMemoryError extends Error {
  constructor(readonly matches: readonly SecretMatch[]) {
    const types = [...new Set(matches.map((m) => m.type))].join(', ')
    super(`Memory entry contains potential secrets: ${types}`)
    this.name = 'SecretInMemoryError'
  }
}

export class EntryNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Memory entry not found: ${id}`)
    this.name = 'EntryNotFoundError'
  }
}

export class MalformedEntryError extends Error {
  constructor(readonly reason: string) {
    super(`Memory entry has unencodable content: ${reason}`)
    this.name = 'MalformedEntryError'
  }
}

// ---------------------------------------------------------------------------
// Per-baseDir mutation queue
// ---------------------------------------------------------------------------

const chains: Map<string, Promise<unknown>> = new Map()

function enqueue<T>(baseDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(baseDir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // Keep the chain alive even if fn rejects; subsequent calls should still run.
  chains.set(
    baseDir,
    next.catch(() => undefined),
  )
  return next as Promise<T>
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const INDEX_NAME = 'MEMORY.md'
const ENTRY_SUFFIX = '.md'
const TMP_SUFFIX = '.tmp'

function memoryDir(baseDir: string): string {
  return join(baseDir, 'memory')
}

function entryPath(baseDir: string, id: string): string {
  return join(memoryDir(baseDir), `${id}${ENTRY_SUFFIX}`)
}

function indexPath(baseDir: string): string {
  return join(memoryDir(baseDir), INDEX_NAME)
}

// ---------------------------------------------------------------------------
// initMemoryDir
// ---------------------------------------------------------------------------

/**
 * Ensure the memory directory exists at 0o700 and sweep any orphaned
 * `*.tmp` files from prior crashes. Idempotent; callers can invoke from
 * any path (write / delete / init).
 */
export async function initMemoryDir(baseDir: string): Promise<void> {
  const dir = memoryDir(baseDir)
  await mkdir(dir, { recursive: true })
  try {
    await chmod(dir, 0o700)
  } catch {
    // Best-effort — some filesystems (Windows, certain mounts) reject chmod.
  }
  try {
    const entries = await readdir(dir)
    for (const name of entries) {
      if (name.endsWith(TMP_SUFFIX)) {
        try {
          await unlink(join(dir, name))
        } catch {
          // Ignore — another process may have swept it.
        }
      }
    }
  } catch {
    // readdir failure is tolerated — the next mutation will retry.
  }
}

// ---------------------------------------------------------------------------
// atomicWrite
// ---------------------------------------------------------------------------

async function atomicWrite(
  finalPath: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const tmpPath = `${finalPath}${TMP_SUFFIX}`
  const fd = await open(tmpPath, 'w', mode)
  try {
    await fd.write(bytes)
    await fd.sync()
  } finally {
    await fd.close()
  }
  await rename(tmpPath, finalPath)

  // fsync the parent directory so the rename is crash-durable. Best-effort:
  // some platforms disallow opening dirs for reading.
  try {
    const dirFd = await open(dirname(finalPath), 'r')
    try {
      await dirFd.sync()
    } finally {
      await dirFd.close()
    }
  } catch {
    // ignore
  }

  try {
    await chmod(finalPath, mode)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/**
 * Read a single entry by id. Returns null if the file does not exist.
 * Throws `MalformedEntryError` if the file exists but cannot be parsed.
 */
export async function readEntry(
  baseDir: string,
  id: string,
): Promise<MemoryEntry | null> {
  if (!validateId(id)) throw new InvalidEntryIdError(id)
  const path = entryPath(baseDir, id)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err: unknown) {
    if (isEnoent(err)) return null
    throw err
  }
  const parsed = parseEntryFile(id, raw)
  if (!parsed.ok) throw new MalformedEntryError(parsed.error)
  return parsed.entry
}

/**
 * List all entries under the memory directory. Malformed files are skipped
 * (a warning is written to stderr). Optional `type` filter runs after
 * parsing.
 */
export async function listEntries(
  baseDir: string,
  opts: { type?: MemoryType } = {},
): Promise<readonly MemoryEntry[]> {
  const dir = memoryDir(baseDir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err: unknown) {
    if (isEnoent(err)) return []
    throw err
  }

  const entries: MemoryEntry[] = []
  for (const name of names) {
    if (!name.endsWith(ENTRY_SUFFIX)) continue
    if (name === INDEX_NAME) continue
    if (name.endsWith(TMP_SUFFIX)) continue
    const id = name.slice(0, -ENTRY_SUFFIX.length)
    if (!validateId(id)) continue

    try {
      const raw = await readFile(join(dir, name), 'utf8')
      const parsed = parseEntryFile(id, raw)
      if (!parsed.ok) {
        process.stderr.write(
          `Warning: memory entry ${name} is malformed (${parsed.error}); skipping\n`,
        )
        continue
      }
      entries.push(parsed.entry)
    } catch (err: unknown) {
      process.stderr.write(
        `Warning: failed to read memory entry ${name}: ${errMsg(err)}\n`,
      )
    }
  }

  const filtered = opts.type
    ? entries.filter((e) => e.type === opts.type)
    : entries
  return filtered.slice().sort(compareEntries)
}

/**
 * Read the MEMORY.md index file. Returns empty string if not present.
 */
export async function readIndex(baseDir: string): Promise<string> {
  try {
    return await readFile(indexPath(baseDir), 'utf8')
  } catch (err: unknown) {
    if (isEnoent(err)) return ''
    throw err
  }
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

/**
 * Options controlling the write gate. In 4a the default is strict (any
 * secret match rejects); 4b callers that have already routed a
 * low-confidence match through the permission cascade's `ask` flow can
 * set `allowLowConfidenceSecrets` so the store rejects only on
 * high-confidence matches. High-confidence matches always throw,
 * regardless of the flag — defense in depth.
 */
export type WriteEntryOptions = {
  readonly allowLowConfidenceSecrets?: boolean
}

/**
 * Upsert an entry. Runs through: id validation → frontmatter round-trip
 * check → serialize → secret scan → caps → atomic write → index rebuild →
 * audit emission. `isNew` in the audit event reflects whether the file
 * existed before this call.
 */
export async function writeEntry(
  baseDir: string,
  entry: MemoryEntry,
  auditWriter: AuditWriter,
  opts: WriteEntryOptions = {},
): Promise<void> {
  return enqueue(baseDir, async () => {
    if (!validateId(entry.id)) throw new InvalidEntryIdError(entry.id)
    if (!canRoundTrip(entry.name) || !canRoundTrip(entry.description)) {
      throw new MalformedEntryError('name or description cannot be encoded')
    }

    await initMemoryDir(baseDir)

    const serialized = serializeEntry(entry)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_ENTRY_BYTES) {
      throw new EntryTooLargeError(bytes, MAX_ENTRY_BYTES)
    }

    const matches = detectSecrets(serialized)
    const relevant = opts.allowLowConfidenceSecrets
      ? matches.filter((m) => m.confidence === 'high')
      : matches
    if (relevant.length > 0) throw new SecretInMemoryError(relevant)

    const existing = await listEntries(baseDir)
    const prior = existing.find((e) => e.id === entry.id)
    const isNew = prior === undefined

    const nextCount = isNew ? existing.length + 1 : existing.length
    if (nextCount > MAX_ENTRY_COUNT) {
      throw new TooManyEntriesError(nextCount, MAX_ENTRY_COUNT)
    }

    const priorBytes = prior
      ? Buffer.byteLength(serializeEntry(prior), 'utf8')
      : 0
    const currentTotal = existing.reduce(
      (sum, e) => sum + Buffer.byteLength(serializeEntry(e), 'utf8'),
      0,
    )
    const nextTotal = currentTotal - priorBytes + bytes
    if (nextTotal > MAX_TOTAL_BYTES) {
      throw new MemoryFullError(nextTotal, MAX_TOTAL_BYTES)
    }

    await atomicWrite(
      entryPath(baseDir, entry.id),
      Buffer.from(serialized, 'utf8'),
      0o600,
    )

    const nextEntries = isNew
      ? [...existing, entry]
      : existing.map((e) => (e.id === entry.id ? entry : e))
    await writeIndex(baseDir, nextEntries)

    auditWriter.write(
      makeMemoryEntryWrittenEvent({
        id: entry.id,
        entryType: entry.type,
        name: entry.name,
        bytes,
        isNew,
      }),
    )
  })
}

/**
 * Delete an entry by id. Emits `memory_entry_deleted` on success.
 * Throws `EntryNotFoundError` if the file is not present.
 */
export async function deleteEntry(
  baseDir: string,
  id: string,
  auditWriter: AuditWriter,
): Promise<void> {
  return enqueue(baseDir, async () => {
    if (!validateId(id)) throw new InvalidEntryIdError(id)

    await initMemoryDir(baseDir)

    const entry = await readEntry(baseDir, id)
    if (entry === null) throw new EntryNotFoundError(id)

    try {
      await unlink(entryPath(baseDir, id))
    } catch (err: unknown) {
      if (isEnoent(err)) throw new EntryNotFoundError(id)
      throw err
    }

    const remaining = (await listEntries(baseDir)).filter((e) => e.id !== id)
    await writeIndex(baseDir, remaining)

    auditWriter.write(
      makeMemoryEntryDeletedEvent({
        id: entry.id,
        entryType: entry.type,
      }),
    )
  })
}

// ---------------------------------------------------------------------------
// Index rebuild
// ---------------------------------------------------------------------------

/**
 * Atomic MEMORY.md write. The caller must already hold the per-`baseDir`
 * mutation slot (i.e. be inside `enqueue`). No enqueue here so `writeEntry`
 * and `deleteEntry` can call this without re-entering the queue.
 */
async function writeIndex(
  baseDir: string,
  entries: readonly MemoryEntry[],
): Promise<void> {
  const sorted = entries.slice().sort(compareEntries)
  const lines = sorted.map(
    (e) => `- [${e.name}](${e.id}${ENTRY_SUFFIX}) — ${e.description}`,
  )
  const body = lines.length === 0 ? '' : lines.join('\n') + '\n'
  await atomicWrite(indexPath(baseDir), Buffer.from(body, 'utf8'), 0o600)
}

/**
 * Phase 4c: regenerate `MEMORY.md` from current on-disk entries. The
 * `/memory rebuild` subcommand calls this to heal a hand-corrupted index
 * without having to trigger a real mutation. Emits no audit event —
 * entry files are unchanged; only the derived index is rewritten.
 *
 * Goes through the same per-`baseDir` mutation queue as `writeEntry` /
 * `deleteEntry` so it cannot interleave with a concurrent mutation.
 */
export async function rebuildIndex(baseDir: string): Promise<void> {
  return enqueue(baseDir, async () => {
    await initMemoryDir(baseDir)
    const entries = await listEntries(baseDir)
    await writeIndex(baseDir, entries)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_ORDER: Record<MemoryType, number> = {
  user: 0,
  feedback: 1,
  project: 2,
  reference: 3,
}

function compareEntries(a: MemoryEntry, b: MemoryEntry): number {
  const t = TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
  if (t !== 0) return t
  const n = a.name.localeCompare(b.name)
  if (n !== 0) return n
  return a.id.localeCompare(b.id)
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  )
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
