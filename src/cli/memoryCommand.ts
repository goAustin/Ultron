/**
 * Phase 4c: `/memory` slash command.
 *
 * Dispatches the user-facing memory management subcommands. Lives here
 * rather than inline in `src/cli.ts` so the REPL dispatch stays scannable
 * and this unit is testable.
 *
 * Subcommands:
 *   /memory                    — print MEMORY.md
 *   /memory list [type]        — list entries, optionally filtered by type
 *   /memory show <id>          — render one entry via serializeEntry
 *   /memory edit <id>          — open existing entry in $EDITOR; save + write
 *   /memory new <id> [type]    — open a template in $EDITOR; save + write
 *   /memory delete <id>        — confirm (default No) then deleteEntry
 *   /memory rebuild            — regenerate MEMORY.md from disk
 *   /memory help               — usage
 */

import type { AuditWriter } from '../audit/types.js'
import {
  MEMORY_TYPES,
  parseEntryFile,
  serializeEntry,
  validateId,
  type MemoryEntry,
  type MemoryType,
} from '../memory/entry.js'
import { detectSecrets, type SecretMatch } from '../memory/secretScanner.js'
import {
  deleteEntry,
  EntryNotFoundError,
  EntryTooLargeError,
  InvalidEntryIdError,
  listEntries,
  MalformedEntryError,
  MemoryFullError,
  readEntry,
  readIndex,
  rebuildIndex,
  SecretInMemoryError,
  TooManyEntriesError,
  writeEntry,
} from '../memory/store.js'
import { editInEditor as defaultEditInEditor } from './editorSpawn.js'
import { confirmYesNo as defaultConfirmYesNo } from './confirmPrompt.js'

// ---------------------------------------------------------------------------
// Engine-facing surface: only the getters we need. Declared as a structural
// type so tests can hand in a fake without constructing a full QueryEngine.
// ---------------------------------------------------------------------------

export type MemoryEngine = {
  readonly memoryBaseDir: string | null
  readonly auditWriter: AuditWriter
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export type MemoryCommandIo = {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly editInEditor?: typeof defaultEditInEditor
  readonly confirmYesNo?: typeof defaultConfirmYesNo
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleMemoryCommand(
  input: string,
  engine: MemoryEngine,
  io: MemoryCommandIo,
): Promise<void> {
  const baseDir = engine.memoryBaseDir
  if (baseDir === null) {
    io.stdout.write('[memory] disabled in this engine\n')
    return
  }

  const trimmed = input.trim()
  // Everything after "/memory" is the subcommand + args.
  const rest = trimmed === '/memory' ? '' : trimmed.slice('/memory '.length)
  const tokens = rest.trim().length === 0 ? [] : rest.trim().split(/\s+/)
  const subcommand = tokens[0] ?? ''
  const args = tokens.slice(1)

  const editFn = io.editInEditor ?? defaultEditInEditor
  const confirmFn = io.confirmYesNo ?? defaultConfirmYesNo
  const ctx: SubCtx = {
    baseDir,
    auditWriter: engine.auditWriter,
    stdout: io.stdout,
    stderr: io.stderr,
    editInEditor: editFn,
    confirmYesNo: confirmFn,
  }

  try {
    switch (subcommand) {
      case '':
        await showIndex(ctx)
        return
      case 'list':
        await listCmd(ctx, args)
        return
      case 'show':
        await showCmd(ctx, args)
        return
      case 'edit':
        await editCmd(ctx, args)
        return
      case 'new':
        await newCmd(ctx, args)
        return
      case 'delete':
        await deleteCmd(ctx, args)
        return
      case 'rebuild':
        await rebuildCmd(ctx)
        return
      case 'help':
        writeHelp(ctx)
        return
      default:
        io.stderr.write(`[memory] unknown subcommand "${subcommand}"\n`)
        writeHelp(ctx)
        return
    }
  } catch (err: unknown) {
    io.stderr.write(`[memory] ${mapStoreError(err)}\n`)
  }
}

// ---------------------------------------------------------------------------
// Subcommand context + shared helpers
// ---------------------------------------------------------------------------

type SubCtx = {
  readonly baseDir: string
  readonly auditWriter: AuditWriter
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly editInEditor: typeof defaultEditInEditor
  readonly confirmYesNo: typeof defaultConfirmYesNo
}

function isMemoryType(s: string): s is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(s)
}

function summarizeMatches(matches: readonly SecretMatch[]): string {
  const types = [...new Set(matches.map((m) => m.type))]
  return types.join(', ')
}

function mapStoreError(err: unknown): string {
  if (err instanceof InvalidEntryIdError) {
    return `invalid id: ${err.message}`
  }
  if (err instanceof EntryNotFoundError) {
    return err.message
  }
  if (err instanceof EntryTooLargeError) {
    return `entry too large (${err.message})`
  }
  if (err instanceof MemoryFullError) {
    return `memory store full (${err.message})`
  }
  if (err instanceof TooManyEntriesError) {
    return `too many entries — delete one first (${err.message})`
  }
  if (err instanceof SecretInMemoryError) {
    return `content contains credential-shaped patterns; refusing to write`
  }
  if (err instanceof MalformedEntryError) {
    return `entry on disk is malformed — edit ~/.ultron/memory/ by hand`
  }
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}

// ---------------------------------------------------------------------------
// /memory (default) — show the index
// ---------------------------------------------------------------------------

async function showIndex(ctx: SubCtx): Promise<void> {
  const raw = await readIndex(ctx.baseDir)
  if (raw.trim().length === 0) {
    ctx.stdout.write('(memory is empty)\n')
    return
  }
  ctx.stdout.write(raw.endsWith('\n') ? raw : `${raw}\n`)
}

// ---------------------------------------------------------------------------
// /memory list [type]
// ---------------------------------------------------------------------------

const LIST_CAP = 50

async function listCmd(ctx: SubCtx, args: readonly string[]): Promise<void> {
  let filter: MemoryType | undefined
  if (args.length > 0) {
    if (!isMemoryType(args[0]!)) {
      ctx.stderr.write(
        `[memory] unknown type "${args[0]}" — expected one of ${MEMORY_TYPES.join(', ')}\n`,
      )
      return
    }
    filter = args[0] as MemoryType
  }

  const entries = await listEntries(ctx.baseDir, filter ? { type: filter } : undefined)
  if (entries.length === 0) {
    const suffix = filter ? ` of type "${filter}"` : ''
    ctx.stdout.write(`(no entries${suffix})\n`)
    return
  }

  const shown = entries.slice(0, LIST_CAP)
  const idWidth = Math.max(2, ...shown.map((e) => e.id.length))
  const typeWidth = Math.max(4, ...shown.map((e) => e.type.length))
  const nameWidth = Math.max(4, ...shown.map((e) => e.name.length))

  const pad = (s: string, n: number): string =>
    s.length >= n ? s : s + ' '.repeat(n - s.length)

  ctx.stdout.write(
    `${pad('id', idWidth)}  ${pad('type', typeWidth)}  ${pad('name', nameWidth)}  bytes\n`,
  )
  for (const e of shown) {
    const bytes = serializeEntry(e).length.toString()
    ctx.stdout.write(
      `${pad(e.id, idWidth)}  ${pad(e.type, typeWidth)}  ${pad(e.name, nameWidth)}  ${bytes}\n`,
    )
  }
  if (entries.length > LIST_CAP) {
    ctx.stdout.write(
      `… (${entries.length - LIST_CAP} more; use /memory list <type> to narrow)\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// /memory show <id>
// ---------------------------------------------------------------------------

async function showCmd(ctx: SubCtx, args: readonly string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    ctx.stderr.write('[memory] usage: /memory show <id>\n')
    return
  }
  if (!validateId(id)) {
    ctx.stderr.write(`[memory] invalid id "${id}"\n`)
    return
  }
  const entry = await readEntry(ctx.baseDir, id)
  if (entry === null) {
    ctx.stderr.write(`[memory] entry "${id}" not found\n`)
    return
  }
  ctx.stdout.write(serializeEntry(entry))
}

// ---------------------------------------------------------------------------
// /memory edit <id>
// ---------------------------------------------------------------------------

async function editCmd(ctx: SubCtx, args: readonly string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    ctx.stderr.write('[memory] usage: /memory edit <id>\n')
    return
  }
  if (!validateId(id)) {
    ctx.stderr.write(`[memory] invalid id "${id}"\n`)
    return
  }
  const existing = await readEntry(ctx.baseDir, id)
  if (existing === null) {
    ctx.stderr.write(`[memory] entry "${id}" not found; use /memory new ${id}\n`)
    return
  }
  await editLoop(ctx, id, serializeEntry(existing), existing.createdAt, 'updated')
}

// ---------------------------------------------------------------------------
// /memory new <id> [type]
// ---------------------------------------------------------------------------

async function newCmd(ctx: SubCtx, args: readonly string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    ctx.stderr.write('[memory] usage: /memory new <id> [type]\n')
    return
  }
  if (!validateId(id)) {
    ctx.stderr.write(`[memory] invalid id "${id}"\n`)
    return
  }
  const typeArg = args[1] ?? 'user'
  if (!isMemoryType(typeArg)) {
    ctx.stderr.write(
      `[memory] unknown type "${typeArg}" — expected one of ${MEMORY_TYPES.join(', ')}\n`,
    )
    return
  }

  const existing = await readEntry(ctx.baseDir, id)
  if (existing !== null) {
    ctx.stderr.write(`[memory] entry "${id}" already exists; use /memory edit ${id}\n`)
    return
  }

  const now = Date.now()
  const template: MemoryEntry = {
    schemaVersion: 1,
    id,
    type: typeArg,
    name: '<replace with a short title>',
    description: '<one-line hook for this entry>',
    content: '<entry body — what you want remembered>\n',
    createdAt: now,
    updatedAt: now,
  }
  await editLoop(ctx, id, serializeEntry(template), now, 'created')
}

// ---------------------------------------------------------------------------
// Shared editor loop
// ---------------------------------------------------------------------------

/**
 * Open `$EDITOR` on `initialText`, parse what comes back, run the secret
 * scan, and write through `writeEntry` on success. Offers a retry-in-editor
 * prompt on parse / secret / store failures.
 */
async function editLoop(
  ctx: SubCtx,
  id: string,
  initialText: string,
  createdAt: number,
  verb: 'created' | 'updated',
): Promise<void> {
  let draft = initialText
  // Cap retries so a stuck loop can't hang the REPL.
  for (let attempt = 0; attempt < 5; attempt++) {
    const saved = await ctx.editInEditor(draft, '.md')
    if (saved === null) {
      ctx.stdout.write('(unchanged)\n')
      return
    }
    draft = saved

    const parsed = parseEntryFile(id, saved)
    if (!parsed.ok) {
      ctx.stderr.write(`[memory] parse failed: ${parsed.error}\n`)
      if (!(await ctx.confirmYesNo('Re-open editor?', { defaultNo: false }))) return
      continue
    }
    const next: MemoryEntry = {
      ...parsed.entry,
      id,
      createdAt,
      updatedAt: Date.now(),
    }

    const serialized = serializeEntry(next)
    const matches = detectSecrets(serialized)
    const highs = matches.filter((m) => m.confidence === 'high')
    if (highs.length > 0) {
      ctx.stderr.write(
        `[memory] content matches high-confidence credential patterns: ${summarizeMatches(highs)}\n`,
      )
      if (!(await ctx.confirmYesNo('Re-open editor?', { defaultNo: false }))) return
      continue
    }
    const lows = matches.filter((m) => m.confidence === 'low')
    if (lows.length > 0) {
      ctx.stderr.write(
        `[memory] content matches credential-like patterns: ${summarizeMatches(lows)}\n`,
      )
      const save = await ctx.confirmYesNo('Save anyway?', { defaultNo: true })
      if (!save) {
        if (!(await ctx.confirmYesNo('Re-open editor?', { defaultNo: false }))) return
        continue
      }
    }

    try {
      await writeEntry(ctx.baseDir, next, ctx.auditWriter, {
        allowLowConfidenceSecrets: true,
      })
      ctx.stdout.write(
        `memory entry "${id}" ${verb} (${serialized.length} bytes)\n`,
      )
      return
    } catch (err: unknown) {
      ctx.stderr.write(`[memory] ${mapStoreError(err)}\n`)
      if (err instanceof EntryTooLargeError || err instanceof MalformedEntryError) {
        if (!(await ctx.confirmYesNo('Re-open editor?', { defaultNo: false }))) return
        continue
      }
      return
    }
  }
  ctx.stderr.write('[memory] too many retries; aborting\n')
}

// ---------------------------------------------------------------------------
// /memory delete <id>
// ---------------------------------------------------------------------------

async function deleteCmd(ctx: SubCtx, args: readonly string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    ctx.stderr.write('[memory] usage: /memory delete <id>\n')
    return
  }
  if (!validateId(id)) {
    ctx.stderr.write(`[memory] invalid id "${id}"\n`)
    return
  }
  const entry = await readEntry(ctx.baseDir, id)
  if (entry === null) {
    ctx.stderr.write(`[memory] entry "${id}" not found\n`)
    return
  }

  const bytes = serializeEntry(entry).length
  const ok = await ctx.confirmYesNo(
    `Delete memory entry "${id}" (${entry.type}, ${bytes} bytes)?`,
    { defaultNo: true },
  )
  if (!ok) {
    ctx.stdout.write('(cancelled)\n')
    return
  }

  await deleteEntry(ctx.baseDir, id, ctx.auditWriter)
  ctx.stdout.write(`memory entry "${id}" deleted\n`)
}

// ---------------------------------------------------------------------------
// /memory rebuild
// ---------------------------------------------------------------------------

async function rebuildCmd(ctx: SubCtx): Promise<void> {
  await rebuildIndex(ctx.baseDir)
  const entries = await listEntries(ctx.baseDir)
  ctx.stdout.write(`MEMORY.md rebuilt from ${entries.length} entries\n`)
}

// ---------------------------------------------------------------------------
// /memory help
// ---------------------------------------------------------------------------

function writeHelp(ctx: SubCtx): void {
  const lines = [
    'Memory management:',
    '  /memory                       — print MEMORY.md',
    '  /memory list [type]           — list entries (type ∈ user|feedback|project|reference)',
    '  /memory show <id>             — print one entry',
    '  /memory new <id> [type]       — create a new entry via $EDITOR',
    '  /memory edit <id>             — edit an existing entry via $EDITOR',
    '  /memory delete <id>           — delete an entry (asks for confirmation)',
    '  /memory rebuild               — regenerate MEMORY.md from on-disk entries',
    '  /memory help                  — this message',
    '',
    '$EDITOR must be a single executable; args like "code --wait" work via',
    'whitespace split. Use a wrapper script for quoted arguments.',
  ]
  for (const line of lines) ctx.stdout.write(`${line}\n`)
}
