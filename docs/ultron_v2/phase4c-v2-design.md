# Phase 4c Design: `/memory` Slash Command (Direct User Management)

## Context

4a landed the store substrate (`src/memory/entry.ts`, `src/memory/store.ts`):
typed entries, on-disk layout under `~/.ultron/memory/`, caps, write-gate,
atomic rename + index rebuild, audit events. 4b exposed three model-facing
tools (`MemoryRead` / `MemoryWrite` / `MemoryEdit`) registered into the
`QueryEngine` tool registry, with a `memorySecretSafetyCheck` on the
permission cascade.

What's still missing is the *user* surface. A human using Ultron at the
REPL today can't list what memory holds, read one entry, or delete a stale
fact without opening a separate shell and cat-ing files under
`~/.ultron/memory/`. 4c closes that gap with a single `/memory` slash
command dispatched by the existing `src/cli.ts` REPL.

4c is deliberately narrow:
- No system-prompt injection (that's 4d, at
  `src/context/cacheHints.ts:33-36`).
- No tokenizer / budget logic (also 4d).
- No new model-visible tools (4b ships those).
- No new audit event types — 4a's `memory_entry_written` /
  `memory_entry_deleted` cover every mutation 4c performs.

The central architectural questions are:

1. **How does the slash handler reach `baseDir` and the `auditWriter`?**
   Both are private to `QueryEngine` today. 4b wires them into memory
   tools' closures (`src/sdk/QueryEngine.ts:184–194`) but does not expose
   them. Answer: add two getters (`memoryBaseDir`, `auditWriter`) so the
   CLI shares the same instances the model tools capture.
2. **How does the user write entries without hand-rolling YAML frontmatter?**
   Answer: spawn `$EDITOR` on a template (for `new`) or on the existing
   entry file (for `edit`). The store already parses markdown+frontmatter
   on the round-trip back.
3. **How do we enforce the same secret policy as 4b when the safety-check
   cascade isn't in play?** Answer: call `detectSecrets` directly at the
   slash layer. High-confidence rejects; low-confidence asks; clean passes
   and calls `writeEntry` with `allowLowConfidenceSecrets: true`.

---

## Architecture

```
  src/cli.ts                             (EDIT, +~6 LOC)
    └─ after the '/model' branch, dispatch to handleMemoryCommand

  src/cli/memoryCommand.ts               (NEW, ~280 LOC)
    ├─ handleMemoryCommand(input, engine, io)
    ├─ subcommand dispatch: index | list | show | edit | new | delete | rebuild | help
    └─ error rendering (maps 4a error classes to one-line messages)

  src/cli/editorSpawn.ts                 (NEW, ~50 LOC)
    └─ editInEditor(initialText, suggestedExt) → Promise<string | null>

  src/cli/confirmPrompt.ts               (NEW, ~25 LOC)
    └─ confirmYesNo(question, defaultNo) → Promise<boolean>

  src/sdk/QueryEngine.ts                 (EDIT, ~15 LOC)
    ├─ promote inline memoryBaseDir to a private field
    ├─ get memoryBaseDir(): string | null
    └─ get auditWriter(): AuditWriter

  src/memory/store.ts                    (EDIT, ~20 LOC)
    ├─ rename existing private rebuildIndex(baseDir, entries)
    │   → writeIndex(baseDir, entries) — atomic MEMORY.md write only
    └─ export new rebuildIndex(baseDir): Promise<void>
        = enqueue(baseDir, () => writeIndex(baseDir, await listEntries(baseDir)))
       (no audit event; re-entry safe)

  src/cli/memoryCommand.test.ts          (NEW)
  src/cli/editorSpawn.test.ts            (NEW)
  tests/integration/memory-slash.test.ts (NEW)
```

No changes to: provider adapters, query loop, hooks spine, MCP layer,
permission engine, tool registry, default tool factory, memory tools,
`memorySecretSafetyCheck`, or the `cacheHints.ts` injection seam.

---

## Scope

### In (locked)

1. Seven subcommands, dispatched in `src/cli/memoryCommand.ts`:
   - `/memory` → print `MEMORY.md` (or `(memory is empty)` if missing/empty).
   - `/memory list [type]` → table of entries, optional type filter.
   - `/memory show <id>` → full entry rendered via `serializeEntry` (same bytes `/memory edit` would open in `$EDITOR`).
   - `/memory edit <id>` → open `~/.ultron/memory/<id>.md` in `$EDITOR`; on save, parse, scan for secrets, write through `writeEntry`.
   - `/memory new <id> [type]` → open a template in `$EDITOR`; on save, parse, scan, write. `type` defaults to `user`.
   - `/memory delete <id>` → `confirmYesNo` (default No); on yes, `deleteEntry`.
   - `/memory rebuild` → `rebuildIndex(baseDir)` — regenerate `MEMORY.md` from on-disk entries. No audit event.
   - `/memory help` → list subcommands + usage.
2. Two new `QueryEngine` getters: `memoryBaseDir` (string or null if `disableMemory: true`) and `auditWriter`. Both are minimal — just expose existing fields.
3. New helper `src/cli/editorSpawn.ts`:
   - Pick editor: `process.env.VISUAL ?? process.env.EDITOR ?? 'vi'`.
   - Temp file under `mkdtemp(join(tmpdir(), 'ultron-memedit-'))` with suggested extension (`.md`).
   - `child_process.spawn(editor, [tmpPath], { stdio: 'inherit' })` — editor owns the terminal.
   - Await exit. If exit code ≠ 0 or file unchanged from the initial text, return `null` (caller treats as "user cancelled").
   - Otherwise return the new file contents. Temp dir cleaned up in `finally`.
4. New helper `src/cli/confirmPrompt.ts`:
   - Re-opens a readline interface (caller closes theirs, mirrors the `/model` pattern at `src/cli.ts:202–219`).
   - Prompts `"{question} [y/N] "`; empty / n / N / no → false; y / Y / yes → true.
5. Secret handling at the slash layer (mirrors 4b policy, but no cascade):
   - `serializeEntry(entry)` → `detectSecrets(serialized)`.
   - Any high-confidence match → reject with "contains credential-shaped content: `<types>`"; reopen editor unless user exits.
   - Low-confidence only → `confirmYesNo("Content matches credential-like patterns (…). Save anyway?", defaultNo=true)`. On yes, `writeEntry(..., { allowLowConfidenceSecrets: true })`. On no, reopen editor.
   - Clean → write directly.
6. `writeEntry` is called with `allowLowConfidenceSecrets: true` for both `edit` and `new`, because the slash-layer ask already ran. High-confidence matches still reject at the store layer as defense in depth (4b already guarantees this).
7. Audit events: all `/memory` writes / deletes emit exactly 4a's `memory_entry_written` / `memory_entry_deleted` via the captured `auditWriter`. No origin tag needed — `/memory` is a top-level CLI action (not subagent-driven).
8. Command discovery: update the startup banner at `src/cli.ts:307` to include `/memory`.
9. `rebuildIndex(baseDir)` in `src/memory/store.ts`:
   - Goes through the existing per-`baseDir` mutation queue.
   - `listEntries(baseDir)` → serialize index block → atomic write `MEMORY.md`.
   - No audit event (rebuild is observability-free — the entry files haven't changed).
   - Idempotent.

### Out (deferred)

- System-prompt injection at the cacheHints seam (4d).
- Token-budget-aware trimming of what gets injected (4d).
- `MemoryDelete` as a model-facing tool. Intentional — destructive primitives stay user-only until a richer ask UX lands.
- Non-interactive write (`/memory write <id> <type> <name> <desc> <content>`) — too many positional args, and the escape-hell UX is the reason `$EDITOR` exists. Can land later if a headless-mode need appears.
- Memory export / import (`/memory export`, `/memory import`) — a v2.x concern once a stable disk format is promised to users.
- Remote editors (`code --wait` etc. work via `$EDITOR` today, nothing special needed).
- Cross-process concurrency — single-CLI posture inherited from 4a.

---

## Data flow

### `/memory` (default)

1. `await engine.memoryBaseDir` — if null, print "memory disabled in this engine" and return.
2. `await readIndex(baseDir)` → string.
3. If empty, print `(memory is empty)`; else `process.stdout.write(indexText)`.

### `/memory list [type]`

1. Parse optional type arg; reject with a hint if not in `MEMORY_TYPES`.
2. `await listEntries(baseDir, type ? { type } : undefined)`.
3. Render a fixed-width table: `id`, `type`, `name`, `bytes`. Slice to first 50 rows with an overflow marker if longer (same cap as `MemoryRead.list`, keeps output scannable).
4. If zero rows, print `(no entries${type ? ` of type "${type}"` : ''})`.

### `/memory show <id>`

1. `validateId(id)` — reject with `usage: /memory show <id>` if malformed.
2. `await readEntry(baseDir, id)` → null → `entry "<id>" not found`.
3. Print `serializeEntry(entry)` — the same bytes `/memory edit` would
   hand to `$EDITOR`. Keeps `show` and `edit` visually identical so
   round-tripping is predictable; no second renderer to maintain.

### `/memory edit <id>`

1. `validateId(id)`.
2. `await readEntry(baseDir, id)` → null → `entry "<id>" not found; use /memory new <id>`.
3. Serialize current entry via `serializeEntry(entry)`. This is the initial text we hand to the editor — frontmatter plus body, same bytes that live on disk.
4. `rl.close()` (editor takes over stdin) → `editInEditor(initial, '.md')` → `saved`.
5. If `saved === null` (no change or non-zero exit), print `(unchanged)`, reopen `rl`, return.
6. `parseEntryFile(id, saved)`:
   - `{ok: false, error}` → print `failed to parse entry: <error>`; offer retry via `confirmYesNo("re-open editor?", defaultNo=false)`. On yes, loop with `saved` as the new initial text; on no, bail without writing.
7. `detectSecrets(saved)`:
   - High-confidence → reject, offer retry-in-editor.
   - Low-confidence only → `confirmYesNo` with a type-listing message. On yes, continue.
8. Build next entry: preserve `createdAt` from the prior, overwrite `updatedAt = Date.now()`, everything else from parse result.
9. `await writeEntry(baseDir, next, auditWriter, { allowLowConfidenceSecrets: true })`.
10. Map any store error via `mapStoreError`; on recoverable errors (EntryTooLarge, MalformedEntry) offer retry-in-editor; on hard errors (TooManyEntries, MemoryFull) print and bail.
11. Print `memory entry "<id>" updated (<bytes> bytes)`.

### `/memory new <id> [type]`

1. `validateId(id)`.
2. `readEntry(baseDir, id)` → non-null → reject `entry "<id>" already exists; use /memory edit <id>`.
3. `type = args[1] ?? 'user'`; reject if outside `MEMORY_TYPES`.
4. Build template string:
   ```
   ---
   name: "<replace with short title>"
   description: "<one-line hook>"
   type: <type>
   schemaVersion: 1
   createdAt: "<ISO>"
   updatedAt: "<ISO>"
   ---

   <entry body — what you want remembered>
   ```
5. Same edit pipeline as `/memory edit`, starting at step 4.
6. `createdAt = updatedAt = Date.now()`.

### `/memory delete <id>`

1. `validateId(id)`.
2. `readEntry(baseDir, id)` → null → `entry "<id>" not found`.
3. `confirmYesNo("Delete memory entry \"<id>\" (<type>, <bytes> bytes)?", defaultNo=true)`.
4. If false → print `(cancelled)`, return.
5. `await deleteEntry(baseDir, id, auditWriter)` — 4a fires `memory_entry_deleted`.
6. Print `memory entry "<id>" deleted`.

### `/memory rebuild`

1. `await rebuildIndex(baseDir)`.
2. Print `MEMORY.md rebuilt from <N> entries`, where `N` comes from a post-rebuild `listEntries` count.

### `/memory help`

Static text listing the seven subcommands with one-line usage.

---

## Module breakdown

### `src/sdk/QueryEngine.ts` (edit)

Promote the current inline resolution (line 185–186) to a field:

```ts
private readonly _memoryBaseDir: string | null  // null when disableMemory

constructor(config: QueryEngineConfig) {
  // ...
  this.auditWriter = config.auditWriter ?? createAuditWriter()
  this.toolRegistry = createDefaultRegistry()
  if (!config.disableMemory) {
    this._memoryBaseDir =
      config.memoryBaseDir ?? join(homedir(), '.ultron')
    const memoryTools = createMemoryTools({
      baseDir: this._memoryBaseDir,
      auditWriter: this.auditWriter,
    })
    this.toolRegistry.register(memoryTools.read)
    this.toolRegistry.register(memoryTools.write)
    this.toolRegistry.register(memoryTools.edit)
  } else {
    this._memoryBaseDir = null
  }
  // ...
}

/** Resolved memory baseDir, or null when memory is disabled. */
get memoryBaseDir(): string | null {
  return this._memoryBaseDir
}

/** Audit writer shared with tools; exposed for slash-command callers. */
get auditWriter(): AuditWriter {
  return this.auditWriter_  // rename private to _auditWriter to avoid name collision
}
```

Note: existing private field is `private readonly auditWriter: AuditWriter`
at line 159. To expose a getter with the same name, rename the private
field to `_auditWriter` and adjust the three internal references
(`src/sdk/QueryEngine.ts:180, 189, 459` per the Phase 4b survey) in a single
mechanical pass. Trivial and contained.

### `src/memory/store.ts` (edit)

The store already has a private `rebuildIndex(baseDir, entries)` at
`src/memory/store.ts:435`, called from inside `writeEntry` and
`deleteEntry`'s `enqueue` blocks (lines 381, 420). We can't add a public
function with the same name, and a public wrapper that re-entered
`enqueue` from inside `writeEntry` would deadlock the per-`baseDir`
chain.

Factoring:

1. Rename the existing private `rebuildIndex(baseDir, entries)` →
   `writeIndex(baseDir, entries)`. Pure atomic write, does not enqueue,
   assumes the caller already holds the mutation slot.
2. Update the two call sites inside `writeEntry` / `deleteEntry` to
   `writeIndex(...)`. Mechanical rename.
3. Add a new exported `rebuildIndex(baseDir)`:

```ts
export async function rebuildIndex(baseDir: string): Promise<void> {
  return enqueue(baseDir, async () => {
    await initMemoryDir(baseDir)
    const entries = await listEntries(baseDir)
    await writeIndex(baseDir, entries)
  })
}
```

The public `rebuildIndex` enqueues once; `writeIndex` never enqueues.
Re-entry is impossible because neither `writeEntry` nor `deleteEntry`
calls `rebuildIndex` — they call `writeIndex` directly from inside their
own slot.

No audit event for rebuild. The entry files haven't changed; only
`MEMORY.md` was regenerated. Observability-free by design.

### `src/cli/memoryCommand.ts` (new)

Shape:

```ts
import type { QueryEngine } from '@/sdk/QueryEngine.js'

export type MemoryCommandIo = {
  readonly stdout: NodeJS.WritableStream  // default: process.stdout
  readonly stderr: NodeJS.WritableStream  // default: process.stderr
  readonly editInEditor?: typeof defaultEditInEditor  // test override
  readonly confirmYesNo?: typeof defaultConfirmYesNo
}

export async function handleMemoryCommand(
  input: string,
  engine: QueryEngine,
  io: MemoryCommandIo,
): Promise<void>
```

No `rl` in `MemoryCommandIo` — subcommands that need stdin
(`editInEditor`, `confirmYesNo`) own it briefly themselves and release
before returning, same as `/model`'s `promptForModel`.

Subcommand handlers are private functions in the same file; each takes
`(args, baseDir, auditWriter, io)` and returns `void`. All errors are
caught at the top level and rendered through `mapStoreError` → one-line
message to `io.stderr`.

`mapStoreError` handles exactly the 4a error classes:

| Error | Message |
|---|---|
| `InvalidEntryIdError` | `invalid id "<id>" — must match [a-z0-9][a-z0-9_-]{0,63}` |
| `EntryTooLargeError` | `entry too large: <bytes> bytes (cap <cap>)` |
| `MemoryFullError` | `memory store full: <total> bytes (cap <cap>)` |
| `TooManyEntriesError` | `memory store has <count> entries (cap <cap>) — delete one first` |
| `SecretInMemoryError` | `content contains credential-shaped patterns; refusing to write` |
| `EntryNotFoundError` | `entry "<id>" not found` |
| `MalformedEntryError` | `entry file on disk is malformed — edit ~/.ultron/memory/<id>.md by hand` |

### `src/cli/editorSpawn.ts` (new)

```ts
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Parse `$EDITOR` into [command, ...args]. Whitespace-split only — no
 * shell quoting. Supports `code --wait` and `vim -n`; does NOT support
 * arguments containing spaces. If you need that, set `VISUAL` / `EDITOR`
 * to point at a wrapper script. */
function parseEditor(spec: string): readonly [string, readonly string[]] {
  const tokens = spec.trim().split(/\s+/)
  const [cmd, ...args] = tokens
  return [cmd ?? 'vi', args]
}

export async function editInEditor(
  initialText: string,
  suggestedExt = '.md',
): Promise<string | null> {
  const spec = process.env.VISUAL ?? process.env.EDITOR ?? 'vi'
  const [cmd, editorArgs] = parseEditor(spec)
  const dir = await mkdtemp(join(tmpdir(), 'ultron-memedit-'))
  const file = join(dir, `entry${suggestedExt}`)
  try {
    await writeFile(file, initialText, { encoding: 'utf8', mode: 0o600 })
    const code: number = await new Promise((resolve, reject) => {
      const child = spawn(cmd, [...editorArgs, file], { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (c) => resolve(c ?? 1))
    })
    if (code !== 0) return null
    const next = await readFile(file, 'utf8')
    return next === initialText ? null : next
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
```

- Editor spec is whitespace-tokenized so `EDITOR="code --wait"` and
  `EDITOR="vim -n"` both work. Quoted / escaped arguments are NOT
  supported — users who need them should point `$EDITOR` at a wrapper
  script (documented in `/memory help`).
- Editor owns stdin/stdout/stderr (`stdio: 'inherit'`). Caller closes
  readline first and re-opens after.
- Non-zero exit (e.g. `vim :cq`) is treated as cancel.
- Unchanged file also treated as cancel (user exited with `:q` without
  saving, but the tmp file had timestamp-dirty fields — so we compare
  bytes, not mtimes).
- Tmp dir cleaned up even on throw.

### `src/cli/confirmPrompt.ts` (new)

```ts
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export type ConfirmYesNoOptions = {
  readonly defaultNo?: boolean
  readonly input?: Readable   // default: process.stdin
  readonly output?: Writable  // default: process.stdout
}

export async function confirmYesNo(
  question: string,
  opts: ConfirmYesNoOptions = {},
): Promise<boolean> {
  const defaultNo = opts.defaultNo ?? true
  const rl = createInterface({
    input: opts.input ?? process.stdin,
    output: opts.output ?? process.stdout,
  })
  const hint = defaultNo ? '[y/N]' : '[Y/n]'
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${question} ${hint} `, resolve)
  })
  rl.close()
  const trimmed = answer.trim().toLowerCase()
  if (trimmed === '') return !defaultNo
  return trimmed === 'y' || trimmed === 'yes'
}
```

Streams are injected so unit tests hand in `PassThrough` pairs; no
Vitest module mocking needed. Production callers pass nothing and get
`process.stdin` / `process.stdout`. Caller closes its own top-level
readline first; this helper owns stdin briefly; caller recreates its
readline after (mirrors `/model` at `src/cli.ts:218`).

### `src/cli.ts` (edit)

Insert after the `/model` block (after line 222), before the
`rl.close()` at line 225, mirroring the `/model` close-own-stdin-reopen
pattern at `src/cli.ts:201–222`:

```ts
if (trimmed === '/memory' || trimmed.startsWith('/memory ')) {
  rl.close()
  try {
    await handleMemoryCommand(trimmed, engine, {
      stdout: process.stdout,
      stderr: process.stderr,
    })
  } catch (err) {
    process.stderr.write(
      `\n\x1b[31m[memory: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\n`,
    )
  } finally {
    rl = createInterface({ input: process.stdin, output: process.stdout })
  }
  prompt()
  return
}
```

The top-level `rl` is passed nothing — it's already closed — and the
handler doesn't need it. Subcommands that need stdin (confirm, editor)
own it briefly and release before returning.

Also update the banner at line 307:
```ts
console.log('Type /quit to exit, /session, /model, /memory, /mcp status, /mcp reload, /mcp list-tools.\n')
```

---

## Secret policy (the subtle part)

The slash command runs **outside** the tool-execution permission cascade.
`memorySecretSafetyCheck` from 4b is not in this code path. We replicate
its policy at the slash layer:

```
saved text (after editor exit)
  → parseEntryFile (structural check)
  → re-serialize via serializeEntry (canonical form)
  → detectSecrets(serialized)
      if any high-confidence match → reject, offer editor retry
      if only low-confidence matches → confirmYesNo("Save anyway?") default N
        yes → writeEntry with { allowLowConfidenceSecrets: true }
        no  → reject, offer editor retry
      no match → writeEntry with { allowLowConfidenceSecrets: true }
```

`writeEntry` still runs `detectSecrets` inside the store; the flag is only
there to skip low-confidence rejection. High-confidence matches still
throw `SecretInMemoryError` from the store — a second layer that cannot be
bypassed by a future caller misconfiguration.

`parseEntryFile` is called on the saved bytes (raw editor output) to catch
structural errors. Once parsed, we re-serialize via `serializeEntry` so
the bytes we scan for secrets are the canonical form that will land on
disk — identical semantics to 4a's write path.

---

## Critical invariants

1. **The slash command never bypasses audit.** Every `writeEntry` /
   `deleteEntry` goes through the injected `auditWriter`. Same instance
   the memory tools capture; events land in the same `audit.jsonl`.
2. **`MEMORY.md` regenerates on every mutation.** Delete, new, edit, and
   rebuild all write it via the same atomic path. Hand-editing
   `MEMORY.md` and then running any mutation is safe — the next write
   overwrites.
3. **Editor cancel is a first-class state.** If the editor exits
   non-zero or the user saved no changes, we print `(unchanged)` and do
   not write. No retry loop, no zombie temp files.
4. **Default answer for destructive prompts is No.** `/memory delete`
   and the "save file with low-confidence secrets" prompt both default
   to N. Typing Enter is safe.
5. **Secret scan runs on bytes that will land on disk.** We parse the
   editor output, re-serialize through `serializeEntry`, and scan the
   canonical form. No bypass via weird frontmatter whitespace.
6. **`/memory` does nothing in headless / no-terminal mode.** It's
   REPL-only. Not added to the programmatic SDK surface. Running
   `node dist/cli.js < script.txt` with `/memory edit foo` as a line
   will spawn `$EDITOR` with an attached-but-piped stdin and behave
   unpredictably — this is the same posture as `/model`, and we don't
   fix it here.
7. **`engine.memoryBaseDir` returns null when `disableMemory: true`.**
   The slash handler prints `memory disabled in this engine` and bails.
   No filesystem access attempted.
8. **Subagents don't affect `/memory`.** It's a top-level CLI command,
   never fired from inside a `submitPrompt`. The auditWriter is the
   engine's root writer with no origin tag — correct.

---

## Sharp edges

- **`$EDITOR` not installed.** Spawn fails on `'error'`; we print the
  error and bail. User can re-invoke after setting `EDITOR`.
- **`$EDITOR` is GUI-only (e.g. `code` without `--wait`).** Editor exits
  immediately; `stdio: 'inherit'` means we return instantly with the
  initial bytes — treated as "no change", same as cancel. Documented in
  `/memory help`.
- **User edits the frontmatter `type` to something invalid.**
  `parseEntryFile` returns `bad_type` — we print the parse error and
  offer editor retry. No disk write.
- **User edits `createdAt` / `updatedAt` to nonsense.** `parseEntryFile`
  uses `Date.parse`, which is lenient (accepts a lot more than strict
  ISO-8601). Truly unparseable input surfaces as `bad_frontmatter` via
  the existing parser; anything `Date.parse` accepts round-trips. For
  `edit` we explicitly ignore the user's `updatedAt` and set
  `Date.now()`; the file they see reflects this on the next `show`.
  Tests must not assume stricter validation than `Date.parse` —
  tightening the parser is a separate change to `src/memory/entry.ts`.
- **User renames the entry id by editing the file.** We don't look at a
  frontmatter `id` — the id comes from the filename. Renaming by editing
  is not supported; user should `/memory delete <old>; /memory new <new>`.
  (Frontmatter has no `id` field in 4a's schema anyway.)
- **Two slash commands run interleaved via a scripted stdin.** The
  per-`baseDir` mutation queue in 4a serializes the writes; index stays
  consistent. Real REPL input is naturally sequential.
- **`listEntries` skips malformed entries with a stderr warning.** If a
  single entry on disk is corrupt, `/memory list` still works for the
  rest. Matches 4a's `listEntries` posture.
- **Racy abort mid-edit.** `$EDITOR` spawn is not wired to
  `AbortController`. `Ctrl-C` at the REPL kills the whole Ultron
  process — the editor process is detached from ours only by `spawn`
  semantics; in practice terminal editors catch SIGINT themselves. Good
  enough.
- **Temp file contains unencrypted entry body.** `~/.ultron/memory/` is
  0o700; the temp dir under `/tmp` is 0o700 via `mkdtemp` default; we
  set 0o600 on the tmp file; we delete on exit. Best-effort against
  swap / power-loss — acceptable for single-user local-first posture.
- **`/memory rebuild` on a directory with a malformed entry.**
  `listEntries` silently skips it (warning on stderr). Rebuilt
  `MEMORY.md` excludes the bad row. Intentional — the index should
  reflect what the store can load.
- **Duplicate subcommand typo.** `/memory lst` falls through to
  `/memory help`'s "unknown subcommand" branch, which prints the usage.
  No fuzzy matching.

---

## Tests

### Unit — `src/cli/memoryCommand.test.ts` (new)

Each test constructs:
- a tmp `baseDir` via `mkdtempSync`
- a `createAuditWriter({ dir: <separate tmp> })`
- a fake `engine`-shaped object exposing `memoryBaseDir` and
  `auditWriter` getters (no full `QueryEngine` needed)
- fake `editInEditor` / `confirmYesNo` injected via `io`
- captured `stdout` / `stderr` via `Writable` sinks

Cases:
- `/memory` on empty store → prints `(memory is empty)`.
- `/memory` populated → prints `MEMORY.md` verbatim.
- `/memory list` → table with correct headers + rows.
- `/memory list user` → filters by type.
- `/memory list zzz` → rejects with hint (invalid type).
- `/memory show <id>` missing → `entry "<id>" not found`.
- `/memory show <id>` present → prints metadata + body.
- `/memory new <id>` with fake editor returning clean template → entry
  lands, audit row with `isNew: true`.
- `/memory new <id>` when id exists → rejects with "already exists" hint.
- `/memory new <id>` with bad type arg → rejects.
- `/memory new <id>` editor cancels (returns null) → no write,
  `(unchanged)` printed.
- `/memory edit <id>` missing → error.
- `/memory edit <id>` with fake editor injecting high-confidence secret
  → `SecretInMemoryError` surfaces as `permission_denied`-style
  message; confirmYesNo called (retry prompt); mock returns false → no
  write, no audit row.
- `/memory edit <id>` with low-confidence secret + confirm yes → write
  succeeds, audit row emitted.
- `/memory edit <id>` with low-confidence secret + confirm no → no
  write.
- `/memory edit <id>` with parse failure + retry declined → no write.
- `/memory delete <id>` + confirm no → no delete, `(cancelled)` printed.
- `/memory delete <id>` + confirm yes → file gone, one
  `memory_entry_deleted` audit row.
- `/memory delete <id>` missing → error, no audit row.
- `/memory rebuild` on populated store → `MEMORY.md` regenerated
  (content assertion); no audit event.
- `/memory rebuild` after hand-corrupting `MEMORY.md` → repaired.
- `/memory help` → prints usage for all subcommands.
- `/memory foo` → unknown subcommand, prints usage.
- Engine with `memoryBaseDir === null` → `/memory` prints "memory
  disabled in this engine"; no filesystem access.

### Unit — `src/cli/editorSpawn.test.ts` (new)

- `EDITOR=cat` smoke test: initial text echoes back unchanged → returns
  `null` (no change).
- Shell-script fake that appends one line to the file → returns new
  text.
- Shell-script fake that exits non-zero → returns null.
- Missing `$EDITOR` binary → `'error'` event → throws, caller catches.
- Temp dir cleanup: tmp dir absent after call.

### Unit — `src/cli/confirmPrompt.test.ts` (new, tiny)

Tests hand in `PassThrough` streams via the `input` / `output` options —
no module mocking.

- Input writes `'y\n'` → resolves true.
- Input writes `'n\n'` → resolves false.
- Empty input (`'\n'`), `defaultNo: true` → false.
- Empty input (`'\n'`), `defaultNo: false` → true.
- Input writes `'YES\n'` → true (case-insensitive).

### Unit — `src/memory/store.test.ts` (edit existing)

Add cases for the extracted `rebuildIndex`:
- After `writeEntry` x3, corrupt `MEMORY.md`, call `rebuildIndex`, assert
  content matches what the post-write index had.
- `rebuildIndex` on empty directory → writes an empty index (not
  absent).
- `rebuildIndex` emits no audit events.
- `rebuildIndex` goes through the same per-`baseDir` mutation queue
  (two concurrent rebuilds serialize cleanly).

### Integration — `tests/integration/memory-slash.test.ts` (new)

End-to-end through a real `QueryEngine` (not a fake) and real
`createAuditWriter`. Drive `handleMemoryCommand` directly (skip the
readline layer — not what's under test).

1. **New entry happy path.** Engine with tmp `memoryBaseDir`. Fake
   editor returns a clean template. Assert `<id>.md` exists at 0o600,
   audit JSONL has one `memory_entry_written` row, `MEMORY.md` updated.
2. **New entry with high-confidence secret.** Editor returns content
   containing `AKIA<16>`. Assert no file, no audit row, retry prompt
   invoked once.
3. **Edit with low-confidence secret → confirm yes.** Entry exists.
   Editor injects `password = "foobarbaz"`. Confirm returns yes. Assert
   write succeeds, audit row emitted.
4. **Delete happy path.** Entry exists. Confirm yes. Assert file gone,
   `MEMORY.md` empty, audit row `memory_entry_deleted`.
5. **Rebuild after hand-corrupting index.** Write two entries via
   `writeEntry` directly, overwrite `MEMORY.md` with garbage, call
   `/memory rebuild`, assert content restored.
6. **Engine with `disableMemory: true`.** Any `/memory` command prints
   the disabled message; no filesystem access.

### Manual smoke

```
node dist/cli.js
> /memory                         → (memory is empty)
> /memory new pref user           → $EDITOR opens on template
   (fill in name/description/content, save, exit)
> /memory list                    → 1 row
> /memory show pref               → full body
> /memory edit pref               → editor opens on current body
   (inject AKIA<16>, save)
                                  → rejected, retry prompt
                                  (decline retry)
> /memory delete pref             → confirm? [y/N]
  (y)                             → deleted
> /memory                         → (memory is empty)
```

And check `~/.ultron/audit.jsonl` — two rows, both metadata-only,
neither with `content` or `description`.

`npm run typecheck && npm run test` green at every implementation step.

---

## Verification / acceptance

- `src/cli/memoryCommand.ts` is the only source of the slash dispatcher.
  `src/cli.ts` adds exactly one new branch that delegates to it.
- `engine.memoryBaseDir` returns the resolved path (or null when
  `disableMemory: true`). `engine.auditWriter` returns the same
  `AuditWriter` instance memory tools captured.
- `/memory new` writes through `writeEntry` with
  `allowLowConfidenceSecrets: true`. High-confidence secrets still
  reject at the store. Audit event present on success, absent on
  rejection.
- `/memory delete` asks for confirmation, defaults to No, emits
  `memory_entry_deleted` only on success.
- `/memory rebuild` regenerates `MEMORY.md` from current disk state; no
  audit row emitted.
- `src/memory/store.ts` exports a new `rebuildIndex(baseDir)` function
  that goes through the per-`baseDir` mutation queue.
- All 4a / 4b tests remain green. Existing file:line citations in 4a /
  4b designs remain valid (only the `_auditWriter` rename is mechanical
  and contained).
- `npm run typecheck && npm run test` green with all new tests.

---

## Implementation order

Each step keeps the build green.

1. **Expose state from `QueryEngine`.** Rename private `auditWriter` to
   `_auditWriter` (three call sites), promote inline `memoryBaseDir` to
   `_memoryBaseDir` field, add two getters. Update
   `src/sdk/QueryEngine.test.ts` with two tiny assertions.
2. **Add public `rebuildIndex`.** Rename the existing private
   `rebuildIndex(baseDir, entries)` at `src/memory/store.ts:435` to
   `writeIndex(baseDir, entries)`; update its two call sites inside
   `writeEntry` (line 381) and `deleteEntry` (line 420). Add the new
   exported `rebuildIndex(baseDir)` that enqueues and calls `writeIndex`
   inside. Extend `src/memory/store.test.ts` with four cases covering
   the new public function and the absence of re-entry deadlock.
3. **Helpers.** New `src/cli/editorSpawn.ts` + `src/cli/confirmPrompt.ts`
   with their unit tests.
4. **Dispatcher skeleton.** New `src/cli/memoryCommand.ts` with
   subcommand dispatch, `/memory` (index), `/memory list`,
   `/memory show`, `/memory rebuild`, `/memory help`. Unit tests for
   read-only paths first.
5. **Mutations.** Add `/memory delete`, `/memory edit`, `/memory new`
   handlers with editor / confirm plumbing; secret policy + retry loop.
   Unit tests covering all mutation branches.
6. **Wire into REPL.** Edit `src/cli.ts` — one dispatch branch, banner
   update.
7. **Integration test.** `tests/integration/memory-slash.test.ts`
   covering the six scenarios end-to-end.
8. **Green + manual smoke.** `npm run typecheck && npm run test`, then
   the manual flow above.

4d can start against frozen 4c once step 7 lands.

---

## Critical files to modify or create

- `src/sdk/QueryEngine.ts` (EDIT — rename `auditWriter` → `_auditWriter`,
  promote `memoryBaseDir` to a field, add two getters)
- `src/memory/store.ts` (EDIT — extract + export `rebuildIndex`)
- `src/cli.ts` (EDIT — one new dispatch branch + banner)
- `src/cli/memoryCommand.ts` (NEW)
- `src/cli/editorSpawn.ts` (NEW)
- `src/cli/confirmPrompt.ts` (NEW)
- `src/cli/memoryCommand.test.ts` (NEW)
- `src/cli/editorSpawn.test.ts` (NEW)
- `src/cli/confirmPrompt.test.ts` (NEW)
- `tests/integration/memory-slash.test.ts` (NEW)

## Reused existing utilities (do not re-implement)

- `src/memory/entry.ts`: `MemoryEntry`, `MemoryType`, `MEMORY_TYPES`,
  `validateId`, `serializeEntry`, `parseEntryFile`, `canRoundTrip`.
- `src/memory/store.ts`: `initMemoryDir`, `readEntry`, `listEntries`,
  `readIndex`, `writeEntry` (with `allowLowConfidenceSecrets`),
  `deleteEntry`, all error classes, cap constants.
- `src/memory/secretScanner.ts`: `detectSecrets`, `SecretMatch`,
  `SecretConfidence`.
- `src/audit/auditLog.ts`: `createAuditWriter`, `AuditWriter` type —
  captured via the new `engine.auditWriter` getter, not reconstructed.
- `src/sdk/QueryEngine.ts`: `QueryEngine` — read via the two new
  getters, no other API changes.
- Structural template: `/model` handler at `src/cli.ts:201–222`
  (close-readline / own-stdin / reopen-readline pattern).

## Verification end-to-end

After implementing all steps:

```bash
npm run typecheck
npm run test
npx vitest run src/cli/memoryCommand.test.ts
npx vitest run src/cli/editorSpawn.test.ts
npx vitest run src/cli/confirmPrompt.test.ts
npx vitest run src/memory/store.test.ts
npx vitest run tests/integration/memory-slash.test.ts
```

Manual smoke: run the REPL flow under "Manual smoke" above. Confirm
`~/.ultron/audit.jsonl` carries only metadata rows (no `content`,
no `description`).
