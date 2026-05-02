/**
 * Structured audit log writer.
 *
 * Serializes QueryEvents to ~/.ultron/audit.jsonl (or a caller-provided dir)
 * with secret redaction and size-based rotation (check-before-append).
 *
 * Contract:
 * - write() is fire-and-forget and never throws.
 * - Writes are serialized on an internal promise chain to preserve ordering
 *   and to ensure a rotation rename cannot race an append.
 * - close() awaits the chain; intended for graceful shutdown / tests.
 */

import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { QueryEvent } from '../core/queryEvents.js'
import type { ToolUseId } from '../core/messages.js'
import type { AuditWriter, AuditWriterOptions } from './types.js'
import { redactSecrets } from '../memory/redact.js'
import { redactImageData } from './redactImageData.js'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_KEEP = 5
const SCHEMA_VERSION = 1

// Which QueryEvent types are persisted. Everything else (text deltas, thinking
// deltas, streaming tool_use_start) is in-memory only.
const SHOULD_AUDIT: ReadonlySet<QueryEvent['type']> = new Set<QueryEvent['type']>([
  'request_start',
  'turn',
  'error',
  'attachment',
  'permission_decision',
  'tool_call_started',
  'tool_progress',
  'tool_call_finished',
  'tool_result',
  'hook_started',
  'hook_finished',
  'compaction_started',
  'compaction_finished',
  'memory_entry_written',
  'memory_entry_deleted',
  'skill_written',
  'skill_deleted',
  'skill_activated',
  'skill_deactivated',
  'web_backend_resolved',
])

export function createAuditWriter(opts: AuditWriterOptions = {}): AuditWriter {
  const dir = opts.dir ?? join(homedir(), '.ultron')
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const keep = opts.keep ?? DEFAULT_KEEP
  const file = join(dir, 'audit.jsonl')

  // The chain MUST stay resolved so write()'s .then handler always runs.
  // If the initial mkdir rejects, swallow it here (with a one-time warning),
  // and let each write() try its own mkdir inside its try/catch — that way
  // a transient permission issue recovers on its own.
  let dirEnsured = false
  let chain: Promise<void> = Promise.resolve()
  let currentBytes: number | undefined
  let consecutiveFailures = 0

  function write(
    event: QueryEvent,
    origin?: string,
    parentToolUseId?: ToolUseId,
  ): void {
    if (!SHOULD_AUDIT.has(event.type)) return

    chain = chain.then(async () => {
      try {
        if (!dirEnsured) {
          await mkdir(dir, { recursive: true })
          dirEnsured = true
        }

        if (currentBytes === undefined) {
          currentBytes = await statSize(file)
        }

        const line = serialize(event, origin, parentToolUseId)
        const lineBytes = Buffer.byteLength(line, 'utf8')

        // Check BEFORE append. If appending this line would cross the cap,
        // rotate first so the triggering line lands in the fresh file.
        if (currentBytes + lineBytes > maxBytes) {
          await rotate(file, keep)
          currentBytes = 0
        }

        await appendFile(file, line)
        currentBytes += lineBytes
        consecutiveFailures = 0
      } catch (err) {
        consecutiveFailures++
        if (consecutiveFailures <= 3) {
          process.stderr.write(
            `Warning: audit write failed: ${errMsg(err)}\n`,
          )
        }
      }
    })
  }

  function close(): Promise<void> {
    return chain
  }

  function withOrigin(
    origin: string,
    opts?: { readonly parentToolUseId: ToolUseId },
  ): AuditWriter {
    // Returns a handle that shares the same promise chain and byte accounting,
    // but stamps every envelope with the given origin tag (e.g. a subagent id)
    // and optionally a parentToolUseId linking events to the parent-side
    // tool_call_started that spawned the writer's owner (Phase 7c).
    const parentToolUseId = opts?.parentToolUseId
    return {
      write: (event) => write(event, origin, parentToolUseId),
      close,
      withOrigin: () => {
        throw new Error('withOrigin does not support chaining; derive from the root writer')
      },
    }
  }

  return {
    write: (event) => write(event),
    close,
    withOrigin,
  }
}

function serialize(
  event: QueryEvent,
  origin?: string,
  parentToolUseId?: ToolUseId,
): string {
  const timestamp = 'timestamp' in event && typeof (event as { timestamp?: unknown }).timestamp === 'number'
    ? (event as { timestamp: number }).timestamp
    : Date.now()

  // v3 Phase 1: strip raw image bytes before secret redaction so the audit
  // log carries metadata-only image summaries, not 2 MB base64 blobs.
  const stripped = redactImageData(event)
  const envelope: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    tsIso: new Date(timestamp).toISOString(),
    ...(origin !== undefined && { origin }),
    ...(parentToolUseId !== undefined && { parentToolUseId }),
    ...(redactSecrets(stripped) as Record<string, unknown>),
  }

  return JSON.stringify(envelope) + '\n'
}

async function statSize(file: string): Promise<number> {
  try {
    const s = await stat(file)
    return s.size
  } catch {
    return 0
  }
}

async function rotate(file: string, keep: number): Promise<void> {
  // Drop the oldest kept generation if present.
  const oldest = `${file}.${keep}`
  await safeUnlink(oldest)

  // Cascade: file.(n-1) → file.n for n = keep..2
  for (let n = keep; n >= 2; n--) {
    const from = `${file}.${n - 1}`
    const to = `${file}.${n}`
    await safeRename(from, to)
  }

  // file → file.1
  await safeRename(file, `${file}.1`)
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // not found — fine
  }
}

async function safeRename(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    // source doesn't exist yet — fine
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
