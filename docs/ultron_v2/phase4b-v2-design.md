# Phase 4b Design: Memory Tools (`MemoryRead` / `MemoryWrite` / `MemoryEdit`)

## Context

4a landed the substrate: `src/memory/entry.ts` + `src/memory/store.ts` hold the
typed-entry codec, on-disk layout under `~/.ultron/memory/`, caps, secret
write-gate, audit events, and the per-`baseDir` mutation queue. The code's
only callers today are tests. No slash command, no tool, no system-prompt
injection — deliberate narrowness.

4b picks up the second of four pieces from v2 §4: expose the store to the
model via three tools on the default registry. `/memory` (4c) and
system-prompt injection at `src/context/cacheHints.ts:33-36` (4d) stay out.

The central architectural question is how these tools reach `baseDir` and
an `AuditWriter` — two capabilities the existing `ToolUseContext`
(`src/core/tools/context.ts:36`) deliberately does not carry. Answer:
**closure factory** at `src/tools/MemoryTools.ts` wired by `QueryEngine` at
construction. `ToolUseContext` is untouched.

Secondary decision: **low-confidence secret handling** moves from 4a's hard
reject to a safety-check `ask`, reusing the existing permission cascade
rather than adding a second askUser hook inside `tool.call()`.

---

## Architecture

```
  src/tools/MemoryTools.ts         (NEW, ~320 LOC)
    ├─ createMemoryTools({ baseDir, auditWriter })
    │   returns { read: Tool, write: Tool, edit: Tool }
    ├─ buildMemoryReadTool(baseDir)             — no auditWriter needed
    ├─ buildMemoryWriteTool(baseDir, auditWriter)
    └─ buildMemoryEditTool(baseDir, auditWriter)

  src/memory/store.ts              (EDIT, +~15 LOC)
    └─ writeEntry gains a fourth arg:
         opts?: { allowLowConfidenceSecrets?: boolean }
       High-confidence matches still reject unconditionally;
       low-confidence matches are skipped only when the flag is true.

  src/memory/memorySecretCheck.ts  (NEW, ~50 LOC)
    └─ memorySecretSafetyCheck: SafetyCheck
       Fires only for MemoryWrite / MemoryEdit.
       High-confidence → deny; low-confidence → ask.
       Mirrors secretContentSafetyCheck in src/memory/contentSafety.ts.

  src/core/permissions/filesystem.ts (EDIT, +2 LOC @ line 232)
    └─ filesystemSafetyChecks gains memorySecretSafetyCheck.

  src/sdk/QueryEngine.ts           (EDIT, ~20 LOC)
    ├─ Reorder constructor so `this.auditWriter` is built before
    │   `getToolDefinitions` / `resolveCallModel` run.
    ├─ After auditWriter, call createMemoryTools({ baseDir, auditWriter });
    │   register the three returned tools on this.toolRegistry.
    ├─ Add config fields: memoryBaseDir?: string, disableMemory?: boolean.
    └─ Default baseDir = join(homedir(), '.ultron'), matching
       createAuditWriter's default.

  src/tools/MemoryTools.test.ts          (NEW)
  src/memory/memorySecretCheck.test.ts   (NEW)
  tests/integration/memory-tools.test.ts (NEW)
```

No changes to: provider adapters, query loop, hooks spine, MCP, permission
cascade core, audit spine, default registry factory. Memory tools are NOT
added to `createDefaultRegistry` — they need per-instance deps, so they're
registered by `QueryEngine` only.

---

## Scope

### In (locked)

1. Three tools registered into the engine's tool registry: `MemoryRead`,
   `MemoryWrite`, `MemoryEdit`. Names mirror `FileRead` / `FileWrite` /
   `FileEdit` shape.
2. Factory `createMemoryTools({ baseDir, auditWriter })` in
   `src/tools/MemoryTools.ts`. Both fields captured in closures; no
   `ToolUseContext` changes.
3. `QueryEngine` constructor wires the factory after `this.auditWriter` is
   built and before the first `getToolDefinitions(this.toolRegistry)` call
   so the memory tools reach `callModel`.
4. Permission policy — each memory tool mirrors the filesystem analogue
   with **no custom `checkPermissions` override** on any of the three. The
   cascade in `src/core/permissions/permissions.ts:53-124` behaves:
   - `MemoryRead.isMutating = false`. `memorySecretSafetyCheck`
     short-circuits on tool name; other safety checks short-circuit on
     `isMutating === false` (see `dangerousPathSafetyCheck` /
     `workingDirectorySafetyCheck` at `src/core/permissions/filesystem.ts`).
     So the cascade falls through step 4 cleanly and reaches step 7 →
     `ask` in `default` mode. `acceptEdits` auto-allows (MemoryRead has
     `getPath`), `bypassPermissions` auto-allows, and a session
     `allow`-by-rule silences future prompts. This is exactly
     `FileReadTool`'s posture — `FileReadTool` also has no
     `checkPermissions` override and also asks in pure default mode.
   - `MemoryWrite` / `MemoryEdit`: same cascade, but
     `memorySecretSafetyCheck` can intercept with `deny` (high-confidence
     secret) or `ask` (low-confidence) at step 4. Otherwise falls
     through to `ask` at step 7. Matches `FileWriteTool` /
     `FileEditTool` (which also have no `checkPermissions`).

   **Explicit non-goal:** 4b does NOT change the cascade so that
   `checkPermissions: allow` terminates. That would flip every tool's
   behavior (including FileRead) and is out of scope here.
5. Secret flow: a new `memorySecretSafetyCheck` slots into
   `filesystemSafetyChecks` alongside `secretContentSafetyCheck`. Fires
   only for `MemoryWrite` / `MemoryEdit`. High-confidence → `deny`,
   low-confidence → `ask`. Uses the existing permission cascade's askUser.
6. Small 4a API addition: `writeEntry` accepts optional
   `opts?: { allowLowConfidenceSecrets?: boolean }`. When true, only
   high-confidence matches throw `SecretInMemoryError`. Default behavior
   unchanged — existing 4a tests stay green.
7. Tool `call()` always passes `allowLowConfidenceSecrets: true`. The
   safety check already handled the low-confidence decision before we got
   here; the store layer is defense-in-depth for high-confidence only.
8. `MemoryEdit` accepts `(id, content)` full-replace OR `(id, old_string,
   new_string, replace_all?)` substring replace. Optional `name` /
   `description` / `type` overwrite metadata when provided. No mtime
   staleness check — 4a's per-`baseDir` mutation queue serializes writes,
   and memory entries don't flow through `readFileState`.
9. `MemoryRead` list mode caps at 50 entries + overflow marker. `get`
   returns a full entry body (≤32 KB). `index` returns raw MEMORY.md.
10. Audit: reuses 4a's `memory_entry_written` / `memory_entry_deleted`
    unchanged. No new event types.

### Out (deferred)

- `/memory` slash-command (4c).
- System-prompt injection (4d).
- Token caps / tokenizer for the injected block (4d).
- `MemoryDelete` tool — deletion is a 4c slash-command concern. Giving
  the model a delete primitive before the UX lands is a foot-gun.
- Per-tool permission rules keyed on entry id (schema supports it via
  `getPath: 'memory:<id>'` but no UX in 4b).
- Cross-process concurrency (single-CLI posture, inherited from 4a).

---

## Data flow

### `MemoryWrite` happy path

1. Model emits `tool_use` with `{id, type, name, description, content}`.
2. `authorizeToolUse` (`src/core/tools/runToolUse.ts:43`):
   - `validateInput` → schema + `validateId` + `canRoundTrip` + size
     preview.
   - `tool.checkPermissions` → not overridden, falls through.
   - Safety checks: `memorySecretSafetyCheck` serializes a preview entry,
     runs `detectSecrets`. No match → pass. High-confidence → `deny`
     (synthetic `permission_denied` result). Low-confidence only →
     `ask` → cascade invokes `permissionOpts.askUser`.
   - Mode step: `bypassPermissions` → allow; `acceptEdits` → allow
     (MemoryWrite has `getPath`); else continue.
   - Fallthrough → `ask`. User picks
     `allow_once` / `allow_by_rule` / `deny_once` / `abort`.
3. `executeToolUse` dispatches `tool.call`. Tool builds the full
   `MemoryEntry` (`createdAt` from prior or now; `updatedAt = Date.now()`)
   and calls
   `writeEntry(baseDir, entry, auditWriter, { allowLowConfidenceSecrets: true })`.
4. 4a's pipeline fires unchanged: id → serialize → byte cap →
   `detectSecrets` (high-confidence only, due to flag) → aggregate/count
   caps → atomic write → index rebuild → emit `memory_entry_written`.
5. Tool returns
   `{content: 'memory entry "<id>" ${prior?'updated':'created'} (<bytes> bytes)', isError: false}`.

### Why the tool unconditionally sets `allowLowConfidenceSecrets: true`

By the time `call()` runs, one of three states holds:
- **No match** — both safety layer and store layer pass.
- **High-confidence match** — safety check already denied; `call()`
  never reached.
- **Low-confidence only** — safety check asked, user answered allow;
  tool runs now.

So the tool doesn't need to "know" the user approved — it always sets
the flag. High-confidence matches are still rejected at the store as a
last line of defense (e.g. if a future caller bypassed the safety check
by misconfiguration).

### `MemoryRead`

1. `tool_use` `{mode: 'list' | 'get' | 'index', id?, type?}`.
2. `authorizeToolUse`: `checkPermissions` not overridden → falls through.
   All safety checks return null (`memorySecretSafetyCheck` matches on
   name only; `workingDirectorySafetyCheck` / `dangerousPathSafetyCheck`
   short-circuit on `isMutating === false`). Mode step auto-allows under
   `acceptEdits` / `bypassPermissions`; otherwise fallthrough → `ask`.
3. `call`:
   - `list`: `listEntries(baseDir, {type})`, slice to 50, render table
     `{id, type, name, description, bytes}`. Append overflow marker if
     truncated.
   - `get`: `readEntry(baseDir, id)`; null → `execution_error`. Otherwise
     render entry with metadata + body.
   - `index`: `readIndex(baseDir)`; empty → "(memory is empty)".

### `MemoryEdit` happy path

1. `tool_use` `{id, content? XOR (old_string, new_string, replace_all?),
   name?, description?, type?}`.
2. Same authorize flow as `MemoryWrite`, using the MemoryEdit-shaped
   preview in `memorySecretSafetyCheck`.
3. `call`:
   - `readEntry(baseDir, id)` → null → `execution_error` "use MemoryWrite
     to create it".
   - Compute new body:
     - Full replace → `content`.
     - Substring: if `!prior.content.includes(old_string)` →
       `execution_error`. If multiple matches and `replace_all !== true`
       → `execution_error` with hint. Else `replace` / `replaceAll`.
   - Build next entry preserving `createdAt`, overwriting `updatedAt`,
     merging any metadata fields on top of prior.
   - `writeEntry(baseDir, next, auditWriter, { allowLowConfidenceSecrets: true })`.
4. Returns `{content: 'memory entry "<id>" edited (<bytes> bytes)', isError: false}`.

---

## Tool surfaces

### `MemoryRead`

```ts
name: 'MemoryRead'
description:
  'Inspect the user-scoped memory store. mode="list" shows all entries ' +
  '(up to 50), mode="get" with id returns one entry in full, mode="index" ' +
  'returns MEMORY.md. Memory persists across sessions under ~/.ultron/memory/.'
inputSchema: {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['list', 'get', 'index'] },
    id:   { type: 'string', description: 'Required when mode="get".' },
    type: { type: 'string', enum: ['user','feedback','project','reference'] },
  },
  required: ['mode'],
}
isMutating: false
isConcurrencySafe: () => true
getPath: (input) => (typeof input.id === 'string' ? `memory:${input.id}` : 'memory:')
// No checkPermissions override. Mirrors FileReadTool — falls through the
// cascade to step 7 `ask` in default mode; `acceptEdits`/`bypassPermissions`
// modes auto-allow; a session allow-by-rule silences future prompts.
```

Error mapping: `InvalidEntryIdError` → `validation_failed`;
`MalformedEntryError` → `execution_error` with "ask the user to inspect
`~/.ultron/memory/<id>.md`".

### `MemoryWrite`

```ts
name: 'MemoryWrite'
description:
  'Create or overwrite a memory entry. Entries are typed (user/feedback/' +
  'project/reference) and persist across sessions. Use for stable facts ' +
  'the user wants remembered; prefer MemoryEdit for incremental changes. ' +
  'Entry <32 KB; total store <2 MB; max 256 entries. Credentials rejected.'
inputSchema: {
  type: 'object',
  properties: {
    id:          { type: 'string', description: 'Slug: [a-z0-9][a-z0-9_-]{0,63}' },
    type:        { type: 'string', enum: ['user','feedback','project','reference'] },
    name:        { type: 'string' },
    description: { type: 'string' },
    content:     { type: 'string' },
  },
  required: ['id', 'type', 'name', 'description', 'content'],
}
// isMutating: undefined → treated as mutating (conservative)
getPath: (input) => (typeof input.id === 'string' ? `memory:${input.id}` : 'memory:')
```

`validateInput`:
- all five fields present with correct types
- `validateId(id)`
- `MEMORY_TYPES.includes(type)`
- `canRoundTrip(name) && canRoundTrip(description)` (surfaces bad_escape early)
- preview serialization byte length ≤ `MAX_ENTRY_BYTES`

`checkPermissions`: no override (cascade fallthrough → ask, or safety-check
intercept, or mode auto-allow).

`call`:
- `readEntry(baseDir, id)` for prior
- build `MemoryEntry` with `createdAt = prior?.createdAt ?? now`, `updatedAt = now`
- `writeEntry(baseDir, entry, auditWriter, { allowLowConfidenceSecrets: true })`
- map 4a errors (table below)

Error mapping (`mapStoreError`):
- `InvalidEntryIdError` → `validation_failed`
- `EntryTooLargeError` → `execution_error` (carries bytes vs cap)
- `MemoryFullError` → `execution_error`
- `TooManyEntriesError` → `execution_error` ("delete an entry first")
- `SecretInMemoryError` → `permission_denied` (high-confidence only
  can reach here with the flag set)
- `MalformedEntryError` → `execution_error`

### `MemoryEdit`

```ts
name: 'MemoryEdit'
description:
  'Edit an existing memory entry. Either full-body replace (content) or ' +
  'exact substring replace (old_string/new_string, optional replace_all). ' +
  'Optional name/description/type overwrite metadata. Fails if entry absent.'
inputSchema: {
  type: 'object',
  properties: {
    id:          { type: 'string' },
    content:     { type: 'string' },
    old_string:  { type: 'string' },
    new_string:  { type: 'string' },
    replace_all: { type: 'boolean' },
    name:        { type: 'string' },
    description: { type: 'string' },
    type:        { type: 'string', enum: ['user','feedback','project','reference'] },
  },
  required: ['id'],
}
getPath: (input) => (typeof input.id === 'string' ? `memory:${input.id}` : 'memory:')
```

`validateInput`:
- `validateId(id)`
- exactly one of: (`content`) XOR (`old_string` && `new_string`)
- reject if `old_string === new_string`
- `canRoundTrip` on supplied `name` / `description`

`checkPermissions`: no override (same as MemoryWrite).

`call`: see data-flow section; errors via `mapStoreError`.

---

## Wiring

`createMemoryTools` is a pure factory — no I/O, no side effects:

```ts
// src/tools/MemoryTools.ts
export type MemoryToolsDeps = {
  readonly baseDir: string
  readonly auditWriter: AuditWriter
}

export function createMemoryTools(deps: MemoryToolsDeps): {
  read: Tool
  write: Tool
  edit: Tool
} {
  return {
    read: buildMemoryReadTool(deps.baseDir),
    write: buildMemoryWriteTool(deps.baseDir, deps.auditWriter),
    edit: buildMemoryEditTool(deps.baseDir, deps.auditWriter),
  }
}
```

### `QueryEngine` constructor changes (`src/sdk/QueryEngine.ts`)

`QueryEngineConfig` has **no** `toolRegistry` seam today. The constructor
hard-codes `createDefaultRegistry()` at line 167, computes `toolDefs` at
line 168, and resolves callModel at line 171 — all BEFORE
`this.auditWriter` is created at line 190. We need to reorder so the
auditWriter exists before we register memory tools, which must exist
before we compute toolDefs for the model.

Minimal reorder (pseudo-diff against lines 166–191):

```ts
// OLD:
this.toolRegistry = createDefaultRegistry()
const toolDefs = getToolDefinitions(this.toolRegistry)
this._model = config.model
this.callModel = this.resolveCallModel(config.model, toolDefs)
this.compactCallModel = config.compactModel
  ? this.resolveCallModel(config.compactModel, toolDefs) : this.callModel
// ...appState, permissionOpts...
this.auditWriter = config.auditWriter ?? createAuditWriter()

// NEW:
this.auditWriter = config.auditWriter ?? createAuditWriter()
this.toolRegistry = createDefaultRegistry()
if (!config.disableMemory) {
  const memoryBaseDir = config.memoryBaseDir ?? join(homedir(), '.ultron')
  const memoryTools = createMemoryTools({
    baseDir: memoryBaseDir,
    auditWriter: this.auditWriter,
  })
  this.toolRegistry.register(memoryTools.read)
  this.toolRegistry.register(memoryTools.write)
  this.toolRegistry.register(memoryTools.edit)
}
const toolDefs = getToolDefinitions(this.toolRegistry)
this._model = config.model
this.callModel = this.resolveCallModel(config.model, toolDefs)
this.compactCallModel = config.compactModel
  ? this.resolveCallModel(config.compactModel, toolDefs) : this.callModel
// ...appState, permissionOpts unchanged...
```

Intermediate state (appState, permissionOpts, etc.) that didn't depend
on the registry or auditWriter stays where it is; we only move the
auditWriter up and insert the memory-tool registration between the
registry and the toolDefs computation.

**No new `config.toolRegistry` seam is introduced** — that would be a
broader API change that 4b doesn't need. Tests that want to assert on
the default registry's contents continue to use `createDefaultRegistry`
directly (which still excludes memory tools).

### `QueryEngineConfig` additions

```ts
/** Override the default ~/.ultron base dir for memory I/O. Tests only. */
readonly memoryBaseDir?: string
/** Disable memory tools — the three tools are not registered. */
readonly disableMemory?: boolean
```

### Why closure factory (Option A) over context extension (Option B)

- **Minimal API surface.** `ToolUseContext`'s comment at `context.ts:3`
  explicitly says "add fields when required, not speculatively." Memory
  is one tool family — extending the shared context for it widens the
  "carried, unused" surface for every other tool.
- **Matches precedent.** Tools in `src/tools/*.ts` are self-contained and
  reach I/O via `fs` directly or via context fields they actually use
  (`readFileState`). Memory tools follow the FileWrite shape, just with
  a store API and a pinned audit writer.
- **Subagent story.** `createForkSubagent` forks the audit writer for
  origin-tagging (`src/sdk/QueryEngine.ts:434`). With closure capture,
  memory tools inherit the parent's auditWriter by design — which is
  correct for memory events (per-user, not per-agent-layer).
- **4c fit.** `/memory` invokes the store directly from `src/cli.ts`,
  not via the tool seam. No need to plumb `baseDir` through context for
  non-tool callers.

---

## Secret flow (the subtle part)

### Layer 1 — safety check (policy)

`src/memory/memorySecretCheck.ts`:

```ts
export const memorySecretSafetyCheck: SafetyCheck = (tool, input, _context) => {
  if (tool.name !== 'MemoryWrite' && tool.name !== 'MemoryEdit') return null

  const preview = buildPreviewForScan(tool.name, input)
  if (preview === null) return null  // validateInput will handle shape issues

  const matches = detectSecrets(preview)
  if (matches.length === 0) return null

  const hasHigh = matches.some((m) => m.confidence === 'high')
  const types = [...new Set(matches.map((m) => m.type))].join(', ')

  return {
    behavior: hasHigh ? 'deny' : 'ask',
    reason: {
      type: 'safetyCheck',
      message: `Memory entry contains potential secrets: ${types}`,
    },
  }
}
```

`buildPreviewForScan`:
- `MemoryWrite`: construct a synthetic `MemoryEntry` from input, run
  `serializeEntry`, return the serialized bytes. If id/type are invalid,
  return null and let `validateInput` handle it.
- `MemoryEdit`: scan `name` + `description` + `content` + `new_string`
  (whichever are present). We can't scan the merged body here without
  I/O, and safety checks are synchronous — the partial scan mirrors
  `secretContentSafetyCheck`'s fallback for FileEdit.

Plug into `filesystemSafetyChecks` in `src/core/permissions/filesystem.ts:232`
right after `secretContentSafetyCheck`.

### Layer 2 — store enforcement (defense in depth)

Modify `writeEntry` in `src/memory/store.ts`:

```ts
export type WriteEntryOptions = {
  readonly allowLowConfidenceSecrets?: boolean
}

export async function writeEntry(
  baseDir: string,
  entry: MemoryEntry,
  auditWriter: AuditWriter,
  opts: WriteEntryOptions = {},
): Promise<void> {
  // ...existing up to detectSecrets...
  const matches = detectSecrets(serialized)
  const relevant = opts.allowLowConfidenceSecrets
    ? matches.filter((m) => m.confidence === 'high')
    : matches
  if (relevant.length > 0) throw new SecretInMemoryError(relevant)
  // ...rest unchanged...
}
```

Backward compatible: callers without `opts` get 4a's strict behavior.

---

## Audit events

4a's `memory_entry_written` and `memory_entry_deleted` are reused
verbatim — `writeEntry` already fires them. No new event types in 4b.
No `memory_entry_read` (read tools don't produce audit rows, consistent
with `FileRead`). Standard `tool_call_started` / `tool_call_finished`
events already cover model-driven invocations.

---

## Tests

### Unit — `src/tools/MemoryTools.test.ts` (new)

Each test uses a fresh tmp `baseDir` and a collecting `AuditWriter` fake.

**`MemoryRead`:**
- Properties: `name === 'MemoryRead'`, `isMutating === false`, `isConcurrencySafe()` true.
- `validateInput`: missing mode → fail; mode='get' without id → fail;
  bad id → fail.
- `checkPermissions` is not overridden (absence test — no custom function
  beyond `buildTool`'s default).
- `list` on empty → helpful text.
- `list` on 3 entries → 3-row table sorted by type then name.
- `list` on 100 entries → 50 rows + overflow marker.
- `list` with `type` filter → filtered rows only.
- `get` missing id → `execution_error`.
- `get` present id → full body + metadata.
- `index` empty → `"(memory is empty)"`.
- `index` populated → raw MEMORY.md.

**`MemoryWrite`:**
- Properties: `name === 'MemoryWrite'`, `getPath` returns `memory:<id>`.
- `validateInput`: bad id, missing required, non-roundtrippable name,
  oversized preview.
- Fresh write: entry lands, audit event has `isNew: true`.
- Overwrite: audit has `isNew: false`, `createdAt` preserved.
- Error mapping covers all six 4a error types.
- High-confidence secret content → `writeEntry` throws (even with flag)
  → tool returns `permission_denied`.
- Low-confidence-only secret with flag=true → succeeds (proves the flag
  is passed).

**`MemoryEdit`:**
- Properties: `getPath` returns `memory:<id>`.
- `validateInput`: neither content nor (old_string+new_string) → fail;
  both present → fail; `old_string === new_string` → fail.
- Missing id → `execution_error`.
- Full replace preserves `createdAt`, updates `updatedAt`.
- Substring single match → replaces once.
- Substring multi-match without `replace_all` → `execution_error`.
- Substring multi-match with `replace_all` → all replaced.
- Partial metadata update preserves untouched fields.
- `old_string` not found → `execution_error`.

### Unit — `src/memory/memorySecretCheck.test.ts` (new)

- MemoryWrite with high-confidence match (AKIA...) → `deny`.
- MemoryWrite with low-confidence only (`password = "foobarbaz"`) → `ask`.
- MemoryWrite with clean content → null.
- MemoryEdit with clean `content` → null.
- MemoryEdit with high-confidence in `new_string` → `deny`.
- Non-memory tool (e.g. FileRead) → null.
- MemoryWrite with malformed id/shape → null (defer to validateInput).

### Unit — `src/memory/store.test.ts` (edit existing)

- `writeEntry` with `{allowLowConfidenceSecrets: true}` and
  low-confidence match → succeeds.
- `writeEntry` with `{allowLowConfidenceSecrets: true}` and
  high-confidence match → still `SecretInMemoryError`.
- Mixed matches with flag → `SecretInMemoryError` carrying only the
  high-confidence subset.
- Default behavior unchanged — 4a's existing tests untouched.

### Integration — `tests/integration/memory-tools.test.ts` (new)

Mirrors `tests/integration/memory-store.test.ts` style: `withTmpDir`
wrapper, real `createAuditWriter`, parse audit JSONL for assertions.

**Permission-mode note.** Because the cascade falls through to `ask` by
default (for every tool that hits step 7), all tool-call cases below
either (a) provide an `askUser` mock that returns `allow_once`, or
(b) construct the engine with `permissionMode: 'acceptEdits'`. Default
choice: `permissionMode: 'acceptEdits'` for cases 1, 4, 5, 6 (pure
plumbing tests); an explicit `askUser` mock for cases 2 and 3 (which
exercise the safety-check decision shape).

1. **MemoryWrite happy path.** `permissionMode: 'acceptEdits'`. Mock
   `callModel` emits one tool_use → text_delta → end_turn. Assert file
   at `<tmp>/memory/<id>.md` (0o600), one `memory_entry_written` row
   (metadata only, no content field), `tool_call_started` +
   `tool_call_finished` for `MemoryWrite`.
2. **MemoryWrite high-confidence secret → denied by safety check.**
   `permissionMode: 'default'`, `askUser` mock would return `allow_once`
   (proves the deny came from the safety check, not the user). Input
   content contains `AKIA<16>`. Assert NO file written, NO
   `memory_entry_written` event, synthetic `permission_denied`
   tool_result, and that `askUser` was NOT invoked.
3. **MemoryWrite low-confidence → ask → allow_once → store succeeds.**
   `permissionMode: 'default'`, `askUser` mock returns `allow_once`.
   Content has `password = "foobarbaz"`. Assert file written, audit
   event emitted, `permission_decision` event has
   `userResponse: 'allow_once'`, and `askUser` was invoked exactly once
   with the safety-check reason message.
4. **MemoryRead list after write.** `permissionMode: 'acceptEdits'`.
   Emit tool_use for `MemoryRead(mode='list')`. Assert tool_result
   contains the written entry's name.
5. **MemoryEdit round-trip.** `permissionMode: 'acceptEdits'`. Write
   entry, then edit via `old_string`/`new_string`. Assert disk matches
   replacement, audit has 2× `memory_entry_written` (first `isNew:true`,
   second `isNew:false`).
6. **MemoryEdit on missing id → `execution_error`, no audit row.**
   `permissionMode: 'acceptEdits'`.

### Manual smoke

`node dist/cli.js`, prompt "Please save this preference using MemoryWrite:
I like tabs." Verify `~/.ultron/memory/<id>.md` + audit JSONL row with no
body payload.

`npm run typecheck && npm run test` green at every implementation step.

---

## Sharp edges

- **`MemoryRead` list cap prevents context blow-up.** 50 rows + overflow
  marker ≈ 10 KB even at 256 entries.
- **`MemoryRead get` returns ≤32 KB.** Well under `FileRead`'s 10 MB cap.
- **Permission cascade for MemoryWrite/MemoryEdit:**
  1. No rule → pass.
  2. `tool.checkPermissions` not overridden → fall through.
  3. Safety checks: `memorySecretSafetyCheck` may deny/ask.
  4. `dangerousPathSafetyCheck` + `workingDirectorySafetyCheck` both
     guard with `if (!filePath) return null`. Memory tools' `getPath`
     returns an empty string (see `synthPath` in MemoryTools.ts) so
     both checks short-circuit cleanly. We tried returning a synthetic
     `memory:<id>` path but that routes through `path.resolve`, which
     uses `process.cwd()` — not the engine's configured `cwd` — so the
     pseudo-path could resolve outside allowed working directories and
     ask spuriously. Empty string keeps `acceptEdits` auto-allow working
     (that check tests `tool.getPath !== undefined`, not the return
     value) while defusing the collision. Per-id rule matching is
     deferred to 4c via a separate tool-metadata channel.
  5. `acceptEdits` mode auto-accepts tools with `getPath` defined —
     memory tools qualify. Consistent with `FileWrite`/`FileEdit`.
  6. `bypassPermissions` allows everything.
  7. Fallback → ask.
- **Abort mid-write.** 4a's mutation queue doesn't check the signal. If
  abort fires between safety-check-passed and `writeEntry` completing,
  the write finishes. Mirrors `FileWrite` behavior. Audit event fires
  independently.
- **Safety checks must stay sync.** `detectSecrets` is pure/sync;
  `serializeEntry` is pure/sync. Don't refactor toward async.
- **`filesystemSafetyChecks` naming.** Already a misnomer after
  `secretContentSafetyCheck` landed there; 4b worsens it. Defer a
  rename to a separate low-risk cleanup PR.
- **Subagent audit origin.** Memory tools capture the parent's
  auditWriter at engine construction, so subagent-driven
  `memory_entry_written` rows carry the parent's origin (empty string).
  This is correct — memory is per-user, not per-agent-layer.
- **Low-confidence false positives.** Pattern
  `(password|secret|token|api_key)\s*[:=]\s*['"][^'"]{8,}['"]` fires on
  well-meaning notes. 4b's ask path is a strict improvement over 4a's
  hard reject — user can allow-once.
- **256-entry cap prevents allow-by-rule buildup.** Session rules die
  with the process anyway; no long-term accumulation.
- **`MemoryEdit` without a read-first.** Unlike `FileEdit`, no staleness
  model applies; read-before-edit would waste tokens.
- **No MemoryDelete tool in 4b.** 4c slash handles deletion.
- **Schema footprint.** Three new tool defs ≈ 800 bytes, negligible.

---

## Verification / acceptance

- `src/tools/MemoryTools.ts` is the only source of the three tool objects.
- `QueryEngine` registers memory tools after `auditWriter` construction
  and before the first `getToolDefinitions` / `resolveCallModel` call.
- `createDefaultRegistry` does NOT register memory tools (they need
  per-instance deps).
- `disableMemory: true` excludes all three from the registry.
- Engine-driven `MemoryWrite` lands at `<memoryBaseDir>/memory/<id>.md`
  (0o600), updates MEMORY.md, produces one `memory_entry_written` audit
  row (metadata only).
- Input with high-confidence secret → safety-check deny before
  `tool.call()`; no file, no audit row.
- Input with low-confidence secret → ask flow; allow_once proceeds,
  deny_once does nothing.
- `MemoryEdit` on nonexistent id → `execution_error`, no I/O.
- `MemoryRead` `list` never returns > 50 rows.
- 4a's existing test suite stays green with the optional `opts` arg.
- `npm run typecheck && npm run test` green with all new tests.

---

## Implementation order

Each step keeps the build green.

1. **4a API addition.** Add `WriteEntryOptions` + `opts` param to
   `writeEntry` in `src/memory/store.ts`. Default behavior unchanged.
   Extend `src/memory/store.test.ts` with three new cases.
2. **Memory secret safety check.** New
   `src/memory/memorySecretCheck.ts` + `.test.ts`. Append
   `memorySecretSafetyCheck` to `filesystemSafetyChecks` at
   `src/core/permissions/filesystem.ts:232`. No behavior change yet (the
   memory tools don't exist).
3. **Tool factory skeleton.** New `src/tools/MemoryTools.ts` exporting
   `createMemoryTools` + three `buildMemory*Tool` helpers with the full
   surface but stub `call`s. Typecheck green.
4. **`MemoryRead` implementation + tests.**
5. **`MemoryWrite` implementation + tests.**
6. **`MemoryEdit` implementation + tests.**
7. **`QueryEngine` wiring.** Reorder constructor, add
   `memoryBaseDir` + `disableMemory` config fields, register tools.
   Update `QueryEngine.test.ts` and `registry.test.ts` as needed
   (memory tools should NOT appear in `createDefaultRegistry` output).
8. **Integration test.** `tests/integration/memory-tools.test.ts`
   covering the six scenarios.
9. **Green + manual smoke.** `npm run typecheck && npm run test`.

4c can start against frozen 4b once step 8 lands.

---

## Critical files to modify or create

- `src/tools/MemoryTools.ts` (NEW)
- `src/memory/memorySecretCheck.ts` (NEW)
- `src/memory/store.ts` (EDIT)
- `src/core/permissions/filesystem.ts` (EDIT line 232)
- `src/sdk/QueryEngine.ts` (EDIT constructor + config type)
- `src/tools/MemoryTools.test.ts` (NEW)
- `src/memory/memorySecretCheck.test.ts` (NEW)
- `tests/integration/memory-tools.test.ts` (NEW)

## Reused existing utilities (do not re-implement)

- `src/memory/entry.ts`: `MemoryEntry`, `MemoryType`, `MEMORY_TYPES`,
  `validateId`, `ID_PATTERN`, `serializeEntry`, `parseEntryFile`,
  `canRoundTrip`.
- `src/memory/store.ts`: `initMemoryDir`, `readEntry`, `listEntries`,
  `readIndex`, `writeEntry` (extended), `deleteEntry`, all error classes,
  `MAX_ENTRY_BYTES`, `MAX_TOTAL_BYTES`, `MAX_ENTRY_COUNT`.
- `src/memory/secretScanner.ts`: `detectSecrets`, `SecretMatch`,
  `SecretConfidence`.
- `src/memory/contentSafety.ts::secretContentSafetyCheck` as a structural
  template for `memorySecretSafetyCheck`.
- `src/core/tools/types.ts::buildTool` as the factory for each tool.
- `src/core/tools/runToolUse.ts`: unchanged — memory tools flow through
  the standard authorize/execute pipeline.
- `src/core/permissions/types.ts`: `SafetyCheck`, `PermissionDecision`,
  `AskUserFn` — unchanged.
- `src/core/queryEventFactories.ts`:
  `makeMemoryEntryWrittenEvent` / `makeMemoryEntryDeletedEvent` already
  exist from 4a.
- `src/audit/types.ts::AuditWriter` — captured by closure.

## Verification end-to-end

After implementing all steps:

```bash
npm run typecheck
npm run test
npx vitest run src/tools/MemoryTools.test.ts
npx vitest run src/memory/memorySecretCheck.test.ts
npx vitest run src/memory/store.test.ts
npx vitest run tests/integration/memory-tools.test.ts
```

Manual smoke: `node dist/cli.js`, prompt the model to save a preference
via `MemoryWrite`. Verify entry file and audit row.
