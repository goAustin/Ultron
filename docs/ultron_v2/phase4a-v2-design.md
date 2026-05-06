# Phase 4a Design: Memory Substrate (Typed Entries + Index + Audit)

## Context

v2 §4 promises a "persistent memory layer modelled on the auto-memory pattern
(typed entries — user / feedback / project / reference — indexed by a
`MEMORY.md`), gated by the v1 secret scanner and byte/token caps."

The safety spine is already in place. v1 Phase 14 landed in v2:
- `src/memory/secretScanner.ts` — `detectSecrets` with high/low confidence
- `src/memory/contentSafety.ts` — `secretContentSafetyCheck` for filesystem writes
- `src/memory/localMemoryGuard.ts` — `enforceBaseDirectoryPermissions` chmods `~/.ultron/` to 0o700
- `src/memory/redact.ts` — deep secret redaction at the audit boundary

The injection seam is already stubbed in `src/context/cacheHints.ts:33-36`:

```ts
// Memory/skills injection seam — phases 4d / 5b insert static parts here.
```

What's missing is the **store itself** — a typed, on-disk, gated representation
of memory entries, plus audit plumbing for memory mutations. That's 4a.

Phase 4 splits into:
- **4a (this phase)** — store substrate: entry schema, disk layout, index, caps, write-gate, audit events.
- **4b** — `MemoryWrite` / `MemoryRead` / `MemoryEdit` tools exposed to the model.
- **4c** — `/memory` slash-command for direct user management.
- **4d** — system-prompt injection at the cacheHints seam + token budget.

4a has no model or user surface. Its only callers in this phase are tests and
(in the next phase) the 4b tool implementations. The deliberate narrowness is
the point: the substrate has to be boring before the UX can be interesting.

---

## Architecture

```
  src/memory/entry.ts          (NEW)
    ├─ MemoryEntry type
    ├─ MemoryType = 'user' | 'feedback' | 'project' | 'reference'
    ├─ parseEntryFile(raw) → MemoryEntry | ParseError
    ├─ serializeEntry(entry) → string (frontmatter + body)
    └─ validateId(slug) → boolean

  src/memory/store.ts          (NEW)
    ├─ initMemoryDir(baseDir)                     — idempotent, 0o700
    ├─ readEntry(baseDir, id)    → MemoryEntry | null
    ├─ listEntries(baseDir, opts?)→ readonly MemoryEntry[]
    ├─ readIndex(baseDir)        → string (raw MEMORY.md text)
    ├─ writeEntry(baseDir, entry, auditWriter)    — gated, atomic, rebuilds index
    ├─ deleteEntry(baseDir, id,    auditWriter)   — atomic, rebuilds index
    └─ Errors: EntryTooLargeError, MemoryFullError,
              TooManyEntriesError, SecretInMemoryError,
              InvalidEntryIdError, EntryNotFoundError

  src/memory/localMemoryGuard.ts (EDIT)
    └─ enforceBaseDirectoryPermissions — add 'memory/' to the dirs array

  src/core/queryEvents.ts        (EDIT)
    ├─ MemoryEntryWrittenEvent { id, type, name, bytes, isNew }
    └─ MemoryEntryDeletedEvent { id, type }

  src/core/queryEventFactories.ts (EDIT)
    ├─ makeMemoryEntryWrittenEvent(...)
    └─ makeMemoryEntryDeletedEvent(...)

  src/audit/auditLog.ts          (EDIT)
    └─ SHOULD_AUDIT gains 'memory_entry_written', 'memory_entry_deleted'
```

Everything below the store is existing plumbing. The Anthropic/OpenAI/MiniMax
adapters, registry, permissions, query loop, hooks spine, and MCP layer are
all untouched — memory is orthogonal substrate.

---

## Scope

### In (locked)

1. `MemoryEntry` type with `type: 'user' | 'feedback' | 'project' | 'reference'`,
   `id`, `name`, `description`, `content`, `createdAt`, `updatedAt`,
   `schemaVersion: 1`.
2. Wire format: Markdown + YAML frontmatter, matching the auto-memory
   convention (`name`, `description`, `type` in frontmatter; body is `content`).
3. On-disk layout:
   - `~/.ultron/memory/<id>.md` — one file per entry
   - `~/.ultron/memory/MEMORY.md` — regenerated index, one line per entry
4. Store API as above. All mutations are **atomic** (write-tmp + fsync +
   rename); MEMORY.md is always consistent with the filesystem.
5. Caps (enforced on `writeEntry`):
   - 32 KB per entry (full serialized bytes, frontmatter + body)
   - 2 MB aggregate across all entries
   - 256 entries max
6. Write gate: `writeEntry` runs `detectSecrets` on the full serialized form.
   **Any match — high or low confidence — rejects with `SecretInMemoryError`.**
   Stricter than filesystem permissions (which ask on low confidence) because
   4a has no user-facing ask UX yet. 4b loosens this to match filesystem
   semantics when the tool seam ships with an `askUser` hook.
7. Directory perms: extend `enforceBaseDirectoryPermissions` in
   `src/memory/localMemoryGuard.ts` to include `memory/` alongside
   `sessions/`. **Dir creation is lazy, not eager**: `createSession()` in
   `src/session/resume.ts:45` deliberately does **not** create directories
   (see its comment at line 42), and `enforceBaseDirectoryPermissions` runs
   only inside `appendMessage()` at `src/session/transcript.ts:151` — i.e.
   on first-message write, not engine construction. To keep the memory
   substrate self-sufficient, `writeEntry` / `deleteEntry` call
   `initMemoryDir` at the top of each mutation (idempotent, cheap). No
   constructor-time wiring required; memory is available whenever the first
   write fires. See "Integration test wiring" below for the test-setup
   implication.
8. Entry-file perms: 0o600 (owner rw only). Set on every rename.
9. Audit events:
   - `memory_entry_written { id, type, name, bytes, isNew }`
   - `memory_entry_deleted { id, type }`
   Neither carries `content` or `description` — metadata only. `redactSecrets`
   at the audit boundary still runs, as a defence-in-depth layer against a
   bug that would introduce content to a future payload.
10. Entry IDs are caller-supplied slugs validated against `/^[a-z0-9][a-z0-9_-]{0,63}$/`.
    No auto-generation in 4a — keeps the API dumb.

### Out (deferred to 4b / 4c / 4d)

- Any `MemoryWrite` / `MemoryRead` / `MemoryEdit` tool callable by the model (4b).
- `/memory` slash-command in `src/cli.ts` (4c).
- System-prompt injection at the `cacheHints.ts` seam (4d).
- Token caps / tokenizer integration (4d — shares policy with attachments).
- Auto-inference of "what should be saved" from user messages (may never land).
- Per-type subdirectories — type stays in frontmatter; flat layout.
- Skill-file loading (Phase 5).
- Cross-session de-duplication, conflict resolution, or merge — caller's
  responsibility; 4a just enforces that the same `id` overwrites deterministically.

---

## Data flow

### Write path (happy)

1. Caller (test in 4a; tool in 4b) constructs a `MemoryEntry`, calls
   `writeEntry(baseDir, entry, auditWriter)`.
2. Store validates `id` → slug regex; reject with `InvalidEntryIdError` on miss.
3. Store serializes `{frontmatter, content}` to a string; checks `bytes <= 32 KB`.
4. Store runs `detectSecrets(serialized)`; any match → `SecretInMemoryError`.
5. Store `listEntries()` to compute aggregate bytes and entry count; rejects
   if adding this entry pushes past 2 MB or past 256 entries (update path
   accounts for the existing entry's size).
6. Store writes `~/.ultron/memory/<id>.md.tmp`, fsyncs, renames to `.md`,
   chmods 0o600.
7. Store rebuilds `MEMORY.md` from the full entry set (sorted by `type` then
   `name`), writes via the same tmp+rename dance.
8. Store emits `memory_entry_written { id, type, name, bytes, isNew }` via
   the injected `AuditWriter`. `isNew` = `true` when no prior file existed.
9. `auditWriter` drops the event into `SHOULD_AUDIT`-filtered JSONL at
   `~/.ultron/audit.jsonl`, with `redactSecrets` applied to the whole payload.

### Delete path

1. `deleteEntry(baseDir, id, auditWriter)`.
2. Validate id; read entry first to capture `type` for the audit event.
3. `unlink(<id>.md)`; if file missing, throw `EntryNotFoundError`.
4. Rebuild MEMORY.md via tmp+rename.
5. Emit `memory_entry_deleted { id, type }`.

### Crash recovery

If the process dies between entry-file rename and MEMORY.md rewrite,
MEMORY.md is stale but the filesystem is truth. The next `listEntries` call
reads directory entries directly — it does not trust MEMORY.md for state,
only regenerates it on write. A background `reconcileIndex` helper is
**not** needed in 4a; it comes for free on the next mutation.

If the crash is between `*.tmp` write and rename, the tmp file is orphaned.
`initMemoryDir` on next boot sweeps `*.tmp` files in `~/.ultron/memory/`.

### Concurrent writes

Two concurrent `writeEntry` calls to the same `id` race on the final
rename; rename is atomic at the POSIX level, so one wins cleanly — no
corruption. MEMORY.md rewrites are also rename-atomic, but two
simultaneous rewrites can interleave: A reads the directory, B reads, A
writes index, B writes index with A's new entry missing.

4a serializes mutations through a per-`baseDir` promise chain (same pattern
as `src/audit/auditLog.ts`'s write queue). A single module-level
`Map<string, Promise<void>>` keyed by `baseDir` is sufficient; tests use
distinct tmp dirs so there's no real sharing.

---

## Module breakdown

### `src/memory/entry.ts` (new, ~120 LOC)

```ts
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export type MemoryEntry = {
  readonly schemaVersion: 1
  readonly id: string
  readonly type: MemoryType
  readonly name: string
  readonly description: string
  readonly content: string
  readonly createdAt: number  // ms since epoch
  readonly updatedAt: number  // ms since epoch
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function validateId(id: string): boolean

export function serializeEntry(entry: MemoryEntry): string
// Format (every frontmatter string value is a quoted scalar — no raw
// interpolation, no multi-line YAML):
//
// ---
// name: "{{escaped-name}}"
// description: "{{escaped-description}}"
// type: user|feedback|project|reference
// schemaVersion: 1
// createdAt: "{{iso-8601}}"
// updatedAt: "{{iso-8601}}"
// ---
//
// {{content verbatim}}

export type ParsedEntry =
  | { ok: true; entry: MemoryEntry }
  | { ok: false; error: 'bad_frontmatter' | 'missing_field' | 'bad_type' | 'bad_escape' }

export function parseEntryFile(id: string, raw: string): ParsedEntry
```

**Frontmatter escaping rules (locked — avoids the YAML footgun).**

4a does not parse general YAML. The frontmatter shape is fixed: six known
keys, all scalar. All string values are serialized as **double-quoted
JSON-escaped scalars** — a strict subset of YAML that is also valid JSON
for string literals. Specifically:

- `\` → `\\`
- `"` → `\"`
- `\n` → `\n` (backslash-n, not a literal newline)
- `\r` → `\r`
- `\t` → `\t`
- All other control chars (`\x00`–`\x1f`) → `\uXXXX`
- The value is wrapped in `"..."` on a single line.

`type` is an unquoted identifier (known-closed enum). `schemaVersion` is an
unquoted integer literal. `createdAt` / `updatedAt` are quoted ISO-8601
strings (surfaced as ms-epoch on the type for consumer convenience, but
stored as ISO-8601 so human edits of MEMORY.md's neighbours are readable).

The parser accepts only this exact shape. Multi-line scalars, block scalars
(`|`, `>`), flow collections (`{}`, `[]`), anchors, tags, or unquoted
strings with special characters all trigger `bad_frontmatter`. Any
`name`/`description` input that cannot be round-tripped through
quote-escape-parse triggers `bad_escape` on write (not a silent
replacement). This keeps the "hand-rolled" promise honest: we know what
parses, and we reject everything else up front.

The content body below the closing `---` is verbatim bytes — it does not
go through YAML at all, so newlines, colons, and backticks are fine there.

### `src/memory/store.ts` (new, ~280 LOC)

Public surface (all errors extend `Error`):

```ts
export class InvalidEntryIdError extends Error
export class EntryTooLargeError extends Error        // carries { bytes, cap }
export class MemoryFullError extends Error           // carries { totalBytes, cap }
export class TooManyEntriesError extends Error       // carries { count, cap }
export class SecretInMemoryError extends Error       // carries { matches }
export class EntryNotFoundError extends Error

export const MAX_ENTRY_BYTES = 32 * 1024
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const MAX_ENTRY_COUNT = 256

export async function initMemoryDir(baseDir: string): Promise<void>
export async function readEntry(baseDir: string, id: string): Promise<MemoryEntry | null>
export async function listEntries(
  baseDir: string,
  opts?: { type?: MemoryType },
): Promise<readonly MemoryEntry[]>
export async function readIndex(baseDir: string): Promise<string>
export async function writeEntry(
  baseDir: string,
  entry: MemoryEntry,
  auditWriter: AuditWriter,
): Promise<void>
export async function deleteEntry(
  baseDir: string,
  id: string,
  auditWriter: AuditWriter,
): Promise<void>
```

`initMemoryDir`:
- `mkdir(join(baseDir, 'memory'), { recursive: true })`
- `chmod(..., 0o700)`
- Sweep orphaned `*.tmp` files (single `readdir` + `unlink` loop; errors logged, not thrown).
- Idempotent. Called at the top of every `writeEntry` / `deleteEntry` so
  callers never need a separate boot step.

**Atomic write helper** (shared by entry files and MEMORY.md — lives in
`src/memory/store.ts` as a private helper):

```ts
async function atomicWrite(finalPath: string, bytes: Buffer, mode: number): Promise<void> {
  const tmpPath = `${finalPath}.tmp`
  const fd = await open(tmpPath, 'w', mode)
  try {
    await fd.write(bytes)
    await fd.sync()              // fsync the tmp file contents to disk
  } finally {
    await fd.close()
  }
  await rename(tmpPath, finalPath)

  // fsync the parent directory so the rename itself is crash-durable.
  // Best-effort on platforms that disallow opening dirs for O_RDONLY (none
  // on Linux/macOS); swallow EISDIR/EPERM quietly.
  try {
    const dirFd = await open(dirname(finalPath), 'r')
    try { await dirFd.sync() } finally { await dirFd.close() }
  } catch { /* non-fatal on exotic filesystems */ }

  await chmod(finalPath, mode) // re-assert mode (open() respects umask)
}
```

Both `<id>.md` writes and the MEMORY.md rebuild go through this helper.
Crash between tmp-write and rename: the tmp file is swept on next
`initMemoryDir`. Crash between rename and directory-fsync: the rename is
visible to the running process but may not survive a power-loss reboot —
acceptable for a local-first single-user tool, and the next mutation heals
both the file and the index.

`writeEntry` calls order (critical for the constraint chain):
```
validateId → serialize → checkEntrySize
  → detectSecrets (reject on ANY match)
  → listEntries (to compute aggregate + count, minus prior entry if exists)
  → enforce aggregate + count caps
  → atomicWrite(<id>.md.tmp → <id>.md, mode 0o600)
  → rebuildIndex()
  → emit memory_entry_written
```

Serialization produces the same bytes we scan for secrets, so a secret in
`name`, `description`, or `content` all fail equally.

### `src/memory/localMemoryGuard.ts` (edit, +2 LOC)

```ts
// before:
const dirs = [baseDir, join(baseDir, 'sessions')]
// after:
const dirs = [baseDir, join(baseDir, 'sessions'), join(baseDir, 'memory')]
```

Existing call from `src/session/transcript.ts:151` now also sets up `memory/`.

### `src/core/queryEvents.ts` (edit, +20 LOC)

Add:

```ts
export type MemoryEntryWrittenEvent = {
  readonly type: 'memory_entry_written'
  readonly id: string
  readonly entryType: MemoryType
  readonly name: string
  readonly bytes: number
  readonly isNew: boolean
  readonly timestamp: number
}

export type MemoryEntryDeletedEvent = {
  readonly type: 'memory_entry_deleted'
  readonly id: string
  readonly entryType: MemoryType
  readonly timestamp: number
}

export type QueryEvent =
  | ...existing...
  | MemoryEntryWrittenEvent
  | MemoryEntryDeletedEvent
```

`entryType` (not `type`) to avoid shadowing the discriminator.

### `src/core/queryEventFactories.ts` (edit, +24 LOC)

```ts
export function makeMemoryEntryWrittenEvent(args: {
  id: string
  entryType: MemoryType
  name: string
  bytes: number
  isNew: boolean
}): MemoryEntryWrittenEvent

export function makeMemoryEntryDeletedEvent(args: {
  id: string
  entryType: MemoryType
}): MemoryEntryDeletedEvent
```

Both set `timestamp: Date.now()`.

### `src/audit/auditLog.ts` (edit, +2 LOC)

Add to `SHOULD_AUDIT`:
```
'memory_entry_written',
'memory_entry_deleted',
```

Events flow through existing `redactSecrets` at the write boundary unchanged.

---

## Critical invariants

### 1. MEMORY.md is never the source of truth

Every `listEntries` reads the directory. MEMORY.md is an artifact. A
corrupted or stale MEMORY.md never poisons state — it's rewritten on the
next mutation.

### 2. Atomic writes on every path

Both entry files and MEMORY.md use `write-tmp → fsync → rename → chmod`.
Partial writes are always rolled back by the next `initMemoryDir` tmp sweep.

### 3. Secret scan runs on serialized bytes, not just content

A secret planted in `name` or `description` fails equally. Prevents bypass
by smuggling a credential into a frontmatter field.

### 4. Audit payload carries no content

Only `{id, type, name, bytes, isNew}` / `{id, type}`. A bug that accidentally
inlined content would still be redacted by the existing audit-boundary
`redactSecrets`, but the type system already forbids it.

### 5. Caps are enforced before disk write

Size, aggregate, and count caps all check before the rename. A rejected
write leaves the filesystem untouched.

### 6. Entry-count cap prevents index DoS

Without `MAX_ENTRY_COUNT = 256`, an adversary (or a bug) could create
thousands of tiny entries under the byte caps. 256 keeps MEMORY.md
scannable and keeps `listEntries` O(small).

### 7. Caller-supplied IDs are slugs, not paths

`validateId` rejects `/`, `.`, `..`, and anything outside `[a-z0-9_-]`.
No caller can escape the memory directory; `path.join` + validation is
belt-and-suspenders.

### 8. 4a adds no model-visible surface

No tool registered, no system-prompt text injected, no slash-command. The
cacheHints seam stays empty. A user running Ultron with zero 4b/4c/4d code
sees exactly today's behavior.

### 9. Event naming is disambiguated

The `QueryEvent` discriminator is `type` (unchanged across the union).
The memory entry's category is `entryType` on every memory event payload.
No memory event ever puts the entry category under a field named `type`
— that would shadow the discriminator on downstream consumers that
switch on `event.type`. Applies to factories, audit JSONL, and any future
SDK surface.

---

## Sharp edges

- **Entry update vs. create**: `writeEntry` is upsert. `isNew` in the event
  is determined by `fs.access` on `<id>.md` before the rename. Races are
  acceptable — the event is observability, not state.
- **Large `description`**: description is part of MEMORY.md (one-line hook);
  we cap the serialized entry but not the description field specifically.
  Long descriptions make MEMORY.md ugly but not broken. Trim is 4c/4d's
  concern.
- **Symlinks in `~/.ultron/memory/`**: `listEntries` uses `readdir` +
  `stat`, follows symlinks. A user who symlinks in a 10 MB file fools the
  aggregate cap. Acceptable: this is `chmod 0o700`, single-user, and the
  user is attacking themselves.
- **Clock skew on timestamps**: `createdAt` and `updatedAt` use
  `Date.now()`. Non-monotonic. If a test mocks the clock, it must set it
  consistently between writes; store does not inject a clock (keeps the API
  boring). 4b/4c tests that care can freeze `Date.now` at the boundary.
- **Concurrent writes across processes**: two Ultron CLIs running against
  the same `$HOME` can corrupt MEMORY.md (entry files are rename-safe, but
  index rebuilds can interleave at the `readdir` boundary). 4a ignores
  this — single-user, single-CLI is the documented v1/v2 posture. Flag in
  the sharp-edges section of the doc, not a code concern.
- **Secret scanner false positives**: the low-confidence
  `password|secret|token|api_key` pattern will reject well-meaning notes
  like `- api_key: set via env`. 4a accepts this; 4b's tool seam will
  expose an override when the ask-UX lands.
- **No reconcileIndex public API**: writing a tool that deliberately
  corrupts MEMORY.md (e.g. editing it by hand in a broken state) doesn't
  have a user-facing "fix me" command in 4a. The next `writeEntry` /
  `deleteEntry` heals it. A `/memory rebuild` subcommand can land in 4c.
- **Module-level homedir constants**: `src/session/resume.ts:34` caches
  `SESSIONS_BASE_DIR = join(homedir(), '.ultron', 'sessions')` at module
  load, making `HOME` reroutes after import useless. Memory must not
  repeat this. `src/memory/store.ts` exports no such constant: every
  function takes `baseDir` as an explicit argument, and integration tests
  pass a tmp dir directly rather than rerouting `$HOME`.

---

## Verification

### Unit — `src/memory/entry.test.ts` (new)

- `serializeEntry` + `parseEntryFile` roundtrip on every `MemoryType`.
- Frontmatter with CRLF, trailing whitespace, or unknown extra keys → parse succeeds (extra keys ignored).
- Missing required key → `parseEntryFile` returns `{ok:false, error:'missing_field'}`.
- Unknown `type` → `{ok:false, error:'bad_type'}`.
- `validateId` accepts `foo`, `foo-bar`, `foo_bar_42`; rejects `Foo`, `foo.md`, `../foo`, `foo/bar`, `""`, 65-char string.

### Unit — `src/memory/store.test.ts` (new)

Each test uses a fresh tmp dir; `auditWriter` is a collecting fake.

- Write + read roundtrip returns an equal entry (ignoring `updatedAt`).
- Index after two writes contains both entries, sorted by type then name.
- Update path: write same id twice; `isNew: true` then `isNew: false`; aggregate cap counts only once.
- Delete removes `<id>.md` AND updates MEMORY.md.
- Delete on missing id → `EntryNotFoundError`.
- Entry > 32 KB → `EntryTooLargeError`.
- Aggregate > 2 MB → `MemoryFullError`.
- 257th entry → `TooManyEntriesError`.
- Secret in `content` (AKIA...) → `SecretInMemoryError`.
- Secret in `name` (sk-ant-...) → `SecretInMemoryError`.
- Low-confidence `password = "foobarbaz"` → `SecretInMemoryError` (4a-strict).
- Bad id (`../evil`) → `InvalidEntryIdError`, no filesystem write.
- `initMemoryDir` sweeps orphaned `*.tmp` files.
- Directory mode 0o700; entry file mode 0o600.
- Concurrent `writeEntry` of two different ids → both land, index lists both.
- `AuditWriter` received exactly one `memory_entry_written` per successful write, zero on rejected writes.

### Integration — `tests/integration/memory-store.test.ts` (new)

**Wiring note (important).** `SESSIONS_BASE_DIR` is computed at module
load in `src/session/resume.ts:34` — `process.env.HOME = tmpDir` set
*after* import has no effect. Memory avoids the same trap by never
exporting a homedir-derived module constant: `baseDir` is always a
function argument, and `writeEntry` / `deleteEntry` call `initMemoryDir`
themselves. So the integration test doesn't need to reroute `$HOME` — it
drives the store directly with a tmp `baseDir`.

1. Make a tmp `baseDir`. Construct a `QueryEngine` with an explicit
   `baseDir`-aware `auditWriter` (spy). Do **not** rely on boot-time dir
   creation — there is none (per `resume.ts:42` comment). Instead:
2. Call `writeEntry(baseDir, entry, auditWriter)` directly. Assert
   `~/.ultron/memory/` (under the tmp dir) now exists at 0o700.
3. Read `<id>.md` back from disk; assert frontmatter and body match
   (round-trip through `parseEntryFile`).
4. Read `MEMORY.md`; assert exactly one entry line with correct name +
   description.
5. Assert the spy `auditWriter` saw exactly one `memory_entry_written`
   event with `{id, entryType, name, bytes, isNew: true}` and **no**
   `content` / `description` keys.
6. `deleteEntry`; assert file gone, `MEMORY.md` empty, spy saw a
   `memory_entry_deleted` event.
7. Separately, drive a full `engine.submitPrompt()` turn that triggers
   `appendMessage` (which hits `enforceBaseDirectoryPermissions`); assert
   the permission enforcement also covers `~/.ultron/memory/` now that
   `'memory'` is in the dirs array. This is the one place the transcript
   path is exercised — it confirms the localMemoryGuard edit works
   end-to-end.

### Manual smoke

- `node dist/cli.js` boots → `ls -la ~/.ultron/memory/` shows an empty
  directory at 0o700.
- From a scratch REPL (`node --input-type=module -e "..."`), import the
  store, write an entry, inspect `~/.ultron/memory/<id>.md` and
  `~/.ultron/audit.jsonl`. The audit row contains no secret strings (try
  planting one in `description` and confirming the write is rejected).

`npm run typecheck && npm run test`.

---

## Acceptance criteria

- `src/memory/entry.ts` and `src/memory/store.ts` exist with the API above;
  no other `src/` file imports Node's `fs` for memory paths.
- The cacheHints injection seam at `src/context/cacheHints.ts:33-36` is
  unchanged — 4a deliberately does not inject.
- A `writeEntry` of 32,769 bytes throws `EntryTooLargeError` with no
  partial disk state.
- A `writeEntry` carrying any pattern in `SECRET_PATTERNS` anywhere in the
  serialized output throws `SecretInMemoryError`.
- Directory `~/.ultron/memory/` exists at 0o700 after either (a) the
  first `writeEntry` call on any `baseDir` (store self-initializes) or
  (b) the first `appendMessage` of any session (transcript path runs the
  extended `enforceBaseDirectoryPermissions`). No constructor-time dir
  creation is introduced, consistent with the existing lazy pattern at
  `src/session/resume.ts:42`.
- Every successful mutation produces exactly one audit event. The event
  payload contains `{id, entryType, name, bytes, isNew}` or `{id,
  entryType}` and no content or description fields.
- A recorded audit file from a run that performed a write contains no
  entry `content` when parsed — neither directly nor via redaction.
- `npm run typecheck && npm run test` are green.

---

## Implementation order

1. **Materialize this design doc** at `docs/ultron_v2/phase4a-v2-design.md` (done
   via the plan file).
2. **Type-only seam**: `src/memory/entry.ts` with `MemoryEntry` type,
   `MemoryType`, `ID_PATTERN`, `validateId` (stub), `serializeEntry` (stub),
   `parseEntryFile` (stub). Build + typecheck green, no behavior.
3. **Entry codec**: implement `serializeEntry` and `parseEntryFile`, add
   `entry.test.ts`. Pure; no I/O.
4. **Store skeleton**: `src/memory/store.ts` with typed errors, caps
   constants, `initMemoryDir` only. `store.test.ts` for directory setup +
   tmp sweep.
5. **Read paths**: `readEntry`, `listEntries`, `readIndex`. Tests for
   reading a hand-crafted directory; no write path yet.
6. **Write paths**: `writeEntry`, `deleteEntry` with atomic rename + index
   rebuild + audit emission. Serialization order matches the data-flow
   section. Full `store.test.ts` suite.
7. **Audit glue**: add `MemoryEntryWrittenEvent` /
   `MemoryEntryDeletedEvent` to `queryEvents.ts`; factories in
   `queryEventFactories.ts`; extend `SHOULD_AUDIT` in `auditLog.ts`.
8. **Dir permission extension**: add `'memory'` to the dirs array in
   `enforceBaseDirectoryPermissions`. Extend `localMemoryGuard.test.ts`
   to assert the new directory is covered.
9. **Integration**: `tests/integration/memory-store.test.ts` — engine
   boot + write + disk inspect + audit spy.
10. **Green**: `npm run typecheck && npm run test`. Manual smoke.

Each step keeps the build green. 4b can start against a frozen 4a the
moment step 9 lands.
