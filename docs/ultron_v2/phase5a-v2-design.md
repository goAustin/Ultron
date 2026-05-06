# Phase 5a Design: Skills Substrate (Typed Bundles + Index + Audit)

## Context

v2 §4 promises a **skills primitive**: "reusable instruction/capability
bundles the user can invoke by name. Skills are plain files on disk,
loaded lazily, and obey the same tool-permission rules when they
trigger tools."

Phase 4 (Memory) split into four steps (4a substrate, 4b model-facing
tools, 4c `/memory` slash, 4d always-on injection) because it had
three distinct surfaces: the model writes memory, the user manages
memory, and every turn injects memory. **Phase 5 (Skills) does not
need that decomposition.** Skills are user-authored — the model never
writes them — and body injection is tied to activation, not always-on.
The v2 roadmap splits Pillar 5 into just two:

- **5a** (this phase) — on-disk store, codec, caps, write gate,
  audit events, directory-permission guard. Substrate only; no
  activation, no injection, no slash, no enforcement.
- **5b** — `/skill` slash command (list / show / activate /
  deactivate), body injection at the `cacheHints.ts` `'org'` seam
  during active turns, `allowed-tools` enforcement, activation
  audit events, and secret re-scan at activation.

The central architectural questions and their answers:

1. **On-disk layout: flat or directory-per-skill?**
   **Directory-per-skill.** The ecosystem convention (Codex skills:
   `developers.openai.com/codex/skills`, Claude Code skills:
   `code.claude.com/docs/en/skills`) is a directory containing
   `SKILL.md` plus optional `assets/`, `references/`, `scripts/`,
   `agents/`. A flat `<id>.md` layout costs a migration the first
   time a skill wants bundled resources. Taking the directory shape
   now is cheap — 5a only manages `SKILL.md`; sibling dirs are
   preserved but untouched.
2. **Wire format: Ultron-specific or ecosystem standard?**
   **Ecosystem standard on disk, camelCase internally.** Frontmatter
   keys use kebab-case (`allowed-tools`, `argument-hint`) so
   hand-authored skills from other tools drop in without
   translation. The TypeScript `Skill` type keeps idiomatic
   camelCase (`allowedTools`, `argumentHint`); the parser maps.
3. **What fields are mandatory vs optional?**
   **Only `name` and `description` are mandatory.** `allowed-tools`,
   `argument-hint`, `schemaVersion`, `createdAt`, `updatedAt` are
   all optional on read so hand-authored skills parse. Ultron-managed
   writes always emit the timestamps + `schemaVersion` for
   deterministic sort order (5b's activation flow picks the
   most-recently-touched skill when two share a name). When a
   hand-authored skill is read without timestamps, the store falls
   back to `fs.stat().mtime` — good enough for display and initial
   sort, with the caveat that mtime drifts under rsync/backup.
   Subsequent `writeSkill` calls (tests / future tooling) heal the
   drift by emitting fresh frontmatter timestamps.
4. **Where on disk?**
   `<baseDir>/skills/<id>/SKILL.md` plus `<baseDir>/skills/SKILLS.md`
   index, alongside the memory layout. Same baseDir root as memory
   (`QueryEngine._memoryBaseDir` at `src/sdk/QueryEngine.ts:186`); 5a
   does NOT introduce a separate `_skillsBaseDir`.
5. **Caps?**
   Skills are meatier than memory entries. **64 KB per
   `SKILL.md`, 4 MB aggregate across all `SKILL.md` files, 128
   skills max.** The cap counts `SKILL.md` bytes only — sibling
   assets/references/scripts are not metered in 5a (they're invisible
   to the store).
6. **Secret-write gate semantics?**
   Match 4a exactly: any `detectSecrets` hit — high or low
   confidence — rejects with `SecretInSkillError`. 5a has no askUser
   hook, so the strict posture is correct. 5b loosens to
   ask-on-low-confidence once the activation surface exists.
7. **`allowedTools` enforcement?**
   Stored and shape-validated in 5a (each entry is a non-empty
   string ≤128 chars, no newlines). **Not enforced.** The invocation
   layer (5b) will intersect `skill.allowedTools` with the existing
   permission rule set; 5a is substrate.
8. **Codec reuse vs copy?**
   Copy the frontmatter helpers (`quoteScalar`, `unquoteScalar`,
   `canRoundTrip`) from `src/memory/entry.ts` into
   `src/skills/skill.ts`. 5a stays strictly additive — no refactor
   of the memory codec (which 4b/4c/4d depend on). Cross-module
   dedup is a separate cleanup PR once both stores are stable.

---

## Architecture

```
  src/skills/skill.ts              (NEW, ~220 LOC)
    ├─ Skill type
    ├─ parseSkillFile(id, raw, stat?) → ParsedSkill
    ├─ serializeSkill(skill) → string      (kebab-case frontmatter)
    ├─ validateId(slug) → boolean          (regex: same as memory)
    ├─ canRoundTrip(s) → boolean
    └─ helpers: quoteScalar, unquoteScalar, parseStringArray

  src/skills/store.ts              (NEW, ~380 LOC)
    ├─ initSkillsDir(baseDir)              — idempotent, 0o700, sweeps *.tmp
    ├─ readSkill(baseDir, id)   → Skill | null
    ├─ listSkills(baseDir)      → readonly Skill[]
    ├─ readIndex(baseDir)       → string   (raw SKILLS.md text)
    ├─ writeSkill(baseDir, skill, auditWriter, opts?) — gated, atomic
    ├─ deleteSkill(baseDir, id, auditWriter)          — atomic
    ├─ rebuildIndex(baseDir)               — for future /skill rebuild
    └─ Errors: InvalidSkillIdError, SkillTooLargeError,
              SkillsFullError, TooManySkillsError,
              SecretInSkillError, SkillNotFoundError,
              MalformedSkillError

  src/memory/localMemoryGuard.ts   (EDIT — +1 line, docstring refresh)
    └─ enforceBaseDirectoryPermissions: add 'skills/' to dirs array

  src/core/queryEvents.ts          (EDIT — +2 events)
    ├─ SkillWrittenEvent { id, name, bytes, hasAllowedTools, isNew, timestamp }
    ├─ SkillDeletedEvent { id, name, timestamp }
    └─ Add to QueryEvent union

  src/core/queryEventFactories.ts  (EDIT — +2 factories)
    ├─ makeSkillWrittenEvent(...)
    └─ makeSkillDeletedEvent(...)

  src/audit/auditLog.ts            (EDIT — +2 entries)
    └─ SHOULD_AUDIT gains 'skill_written', 'skill_deleted'

  src/skills/skill.test.ts         (NEW)
  src/skills/store.test.ts         (NEW)
  tests/integration/skill-store.test.ts (NEW)
```

Untouched: provider adapters, query loop, normalizeMessages, hooks
spine, MCP layer, permission cascade, default tool registry,
`QueryEngine` (activation state + tool-set intersection come in 5b),
`cacheHints.ts` injection seam (activated skill bodies join the `'org'`
bucket in 5b).

`localMemoryGuard.ts` keeps its name despite owning skills/ now —
renaming would touch every importer and doesn't belong in a substrate
phase. Docstring updates to "Local guard for `~/.ultron/` —
transcript size + base directory permissions for sessions, memory, and
skills."

---

## Scope

### In (locked)

1. `Skill` type (internal, camelCase):
   ```ts
   type Skill = {
     readonly schemaVersion: 1
     readonly id: string                 // slug, ID_PATTERN
     readonly name: string               // display name
     readonly description: string        // one-liner
     readonly content: string            // body — instructions
     readonly allowedTools?: readonly string[]
     readonly argumentHint?: string
     readonly createdAt: number
     readonly updatedAt: number
   }
   ```
   No `type` field — skills are flat. `content` matches the memory
   field name on purpose, so parse/serialize symmetry stays obvious.

2. On-disk wire format — **ecosystem-standard, kebab-case**:
   ```
   ---
   name: review-pr
   description: Review pull requests for correctness, regression risk, and missing tests.
   allowed-tools: ["FileRead", "Grep", "Glob"]
   argument-hint: <pr-url>
   schemaVersion: 1
   createdAt: "2026-04-24T12:00:00.000Z"
   updatedAt: "2026-04-24T12:00:00.000Z"
   ---

   Skill instructions go here.
   ```
   - `name` and `description` are the only **required** frontmatter
     keys.
   - `allowed-tools` is optional, serialized as a one-line JSON-style
     array of quoted strings. Omit the key entirely when `undefined`;
     emit `[]` when explicitly present-and-empty (the two are
     semantically distinct — see §11).
   - `argument-hint` is optional, a single `quoteScalar` string.
   - `schemaVersion`, `createdAt`, `updatedAt` are optional on read.
     Ultron-managed writes always emit them for deterministic sort.
     See §6 for the mtime fallback on read.
   - Scalars that don't need escaping (plain ASCII, no colons, no
     leading spaces, no lookalike YAML syntax) MAY be emitted
     unquoted — `name: review-pr` is cleaner than `name: "review-pr"`
     and still round-trips. Formal rule: emit unquoted iff the
     string matches `/^[A-Za-z0-9][A-Za-z0-9 _\-./]*[A-Za-z0-9]$/`
     and has length ≥ 1, otherwise `quoteScalar`. The parser accepts
     both — unquoted values are taken verbatim (whitespace-trimmed),
     quoted values go through `unquoteScalar`.

3. On-disk layout under `<baseDir>/skills/`:
   ```
   <baseDir>/skills/
     review-pr/
       SKILL.md
       assets/            ← preserved; not managed by 5a
       scripts/           ← preserved; not managed by 5a
     write-tests/
       SKILL.md
     SKILLS.md            ← derived index
   ```
   - `<id>/` directories at 0o700.
   - `SKILL.md` + `SKILLS.md` at 0o600.
   - 5a never reads, writes, or enumerates anything under `<id>/`
     other than `SKILL.md` and `SKILL.md.tmp`. Sibling files and
     directories survive writes and deletes.

4. `SKILLS.md` index format:
   ```
   - [review-pr](review-pr/SKILL.md) — Review pull requests for correctness, regression risk, and missing tests.
   - [write-tests](write-tests/SKILL.md) — …
   ```
   Sorted by `name` then `id`. Trailing newline only when there's at
   least one entry. Link target is `<id>/SKILL.md` (directory-aware).

5. Store API:
   ```ts
   initSkillsDir(baseDir: string): Promise<void>
   readSkill(baseDir: string, id: string): Promise<Skill | null>
   listSkills(baseDir: string): Promise<readonly Skill[]>
   readIndex(baseDir: string): Promise<string>
   writeSkill(baseDir, skill, auditWriter, opts?): Promise<void>
   deleteSkill(baseDir, id, auditWriter): Promise<void>
   rebuildIndex(baseDir: string): Promise<void>
   ```
   All mutations are atomic (tmp + fsync + rename + parent-dir fsync)
   and serialized through a **separate** per-`baseDir` promise chain
   from memory's — memory and skill mutations don't block each
   other (different subdirectories, no cross-contention).

6. Timestamp fallback on read:
   - `parseSkillFile(id, raw, stat?)`. When `createdAt`/`updatedAt`
     are absent from frontmatter, the store passes `stat` (from a
     `fs.stat(SKILL.md)` call the reader already makes) and the
     parser falls back to `stat.birthtimeMs` / `stat.mtimeMs`. When
     `stat` isn't provided (pure codec tests), absent timestamps
     default to `0` so round-trip stays deterministic.
   - Ultron-managed writes always include frontmatter timestamps;
     the fallback is for skills Ultron hasn't written to. Subsequent
     `writeSkill` calls (tests / future tooling) emit fresh
     frontmatter timestamps, healing the fallback state.

7. Caps (enforced on `writeSkill`, counts `SKILL.md` bytes only):
   - **`MAX_SKILL_BYTES = 64 * 1024`** (64 KB per SKILL.md)
   - **`MAX_TOTAL_SKILL_BYTES = 4 * 1024 * 1024`** (4 MB aggregate)
   - **`MAX_SKILL_COUNT = 128`**
   Distinct names from memory's constants so imports stay
   unambiguous.

8. Write gate: `writeSkill` runs `detectSecrets` on the full
   serialized `SKILL.md` string (frontmatter + body). Any match —
   high or low confidence — rejects with `SecretInSkillError` in 5a.
   `WriteSkillOptions.allowLowConfidenceSecrets` exists for 5b's
   activation-time callers to set, identical shape to
   `WriteEntryOptions`.

9. Directory perms: extend `enforceBaseDirectoryPermissions` in
   `src/memory/localMemoryGuard.ts:50-54` to include
   `join(baseDir, 'skills')`. Same lazy-create posture: `writeSkill`
   / `deleteSkill` call `initSkillsDir` at the top; no
   constructor-time wiring.

10. Audit events:
    ```ts
    type SkillWrittenEvent = {
      readonly type: 'skill_written'
      readonly id: string
      readonly name: string
      readonly bytes: number               // SKILL.md only
      readonly hasAllowedTools: boolean    // boolean only
      readonly isNew: boolean
      readonly timestamp: number
    }
    type SkillDeletedEvent = {
      readonly type: 'skill_deleted'
      readonly id: string
      readonly name: string
      readonly timestamp: number
    }
    ```
    Name is included on both (skills lack a `type` to anchor the
    row). `hasAllowedTools` is a boolean — confirms presence without
    leaking which tools. No `content`, `description`,
    `argumentHint`, or the `allowedTools` array on either event.
    `redactSecrets` at the audit boundary runs as defense-in-depth.

11. `allowedTools` semantics:
    - Optional. Absent (`undefined`) means "no restriction — subject
      only to the parent context's permission rules."
    - Empty array `[]` means "skill is permitted to invoke zero
      tools" — instruction-only. Distinct from absent, preserved
      round-trip.
    - If present, array of strings. Each string: non-empty, length ≤
      128, no embedded `\n` or `\r`. No pattern parsing in 5a.
    - 5a stores the bytes intact and never enforces. 5b will
      intersect this with the parent permission rule set.

12. `argumentHint`: optional, non-empty string ≤ 256 chars, no
    embedded newlines.

13. Skill IDs: same regex as memory,
    `/^[a-z0-9][a-z0-9_-]{0,63}$/`, exported as `ID_PATTERN` from
    `src/skills/skill.ts`.

14. `deleteSkill` semantics (directory safety):
    - `unlink(<id>/SKILL.md)`.
    - After unlink, `readdir(<id>/)`:
      - If the directory is empty → `rmdir(<id>/)`.
      - If only `SKILL.md.tmp` remains → unlink it, then `rmdir`.
      - Otherwise (sibling dirs or files present) → leave the
        directory in place. The skill is "deleted" from Ultron's
        perspective (SKILL.md gone, not in the index, not in
        `listSkills`), but the user's assets aren't.
    - Rebuild `SKILLS.md`.
    - Emit `skill_deleted`.

15. `listSkills` directory scan:
    - `readdir(<baseDir>/skills/)` entries, filter to directories
      whose name passes `validateId`.
    - For each, check for `<name>/SKILL.md`. Missing → skip silently
      (a skill in-progress with only `assets/` is not yet a skill).
    - Parse each found `SKILL.md`. Malformed → warn to stderr, skip.
    - `stat` is captured per file and passed to `parseSkillFile` for
      the timestamp fallback.
    - Ignore `SKILLS.md`, `*.tmp`, loose `.md` files at the
      `skills/` root (warn on loose files, since they suggest a
      pre-5a flat layout the user may want to migrate).

16. `initSkillsDir`:
    - `mkdir(<baseDir>/skills, { recursive: true })`.
    - `chmod(dir, 0o700)` (best-effort, warn on failure).
    - Sweep orphaned `*.tmp` one level down: for each `<id>/`
      subdirectory (validated), `unlink(<id>/SKILL.md.tmp)` if
      present. Ignore errors (another process may be sweeping too).
    - Do NOT sweep empty `<id>/` directories on init. A user might
      be mid-authoring a skill and have only `scripts/` staged.

### Out (deferred to 5b / later)

- `/skill` slash command (`list` / `show` / `<id>` activate /
  `deactivate` / `help`) — 5b.
- System-prompt injection. 5a does NOT inject anything. 5b injects
  an activated skill's body at the `'org'`-bucket seam in
  `cacheHints.ts` for the duration of the activation window;
  deactivation removes it. There is no always-on injection —
  discovery is user-driven via `/skill list`.
- `allowed-tools` *enforcement* (intersection with the tool set
  passed to `callModel`; denial reason at the permission boundary)
  — 5b.
- Secret re-scan on activation (hand-authored SKILL.md bypasses 5a's
  write gate; 5b is the second checkpoint before the body reaches
  the prompt) — 5b.
- Activation audit events (`skill_activated`, `skill_deactivated`)
  — 5b.
- Editor-spawn `/skill new` / `/skill edit` — NOT in 5b either.
  Users author skills in `$EDITOR` outside Ultron; the substrate's
  `writeSkill` API exists for tests and future tooling.
- Any model-facing tool (`SkillRead` / `SkillWrite` / `SkillInvoke`)
  — not planned. Skills are user-authored, not model-authored.
- Multi-file asset management (a tool that surfaces
  `<id>/references/foo.md`). 5a preserves the sibling directories;
  read/write of them is a future concern.
- Cross-skill name collisions, namespacing, versioning beyond
  `schemaVersion: 1`.
- Project-local `.ultron/skills/` auto-discovery, multi-root merge.
  5a is `~/.ultron/skills/` only.
- Skill templates / scaffolding.
- Importing skills from URLs, MCP, or Claude Code skill
  directories.
- Migration from any hypothetical pre-5a flat layout. There is no
  such state to migrate from (5a is net-new).

---

## Data flow

### Write path (happy)

1. Caller constructs a `Skill`, calls
   `writeSkill(baseDir, skill, auditWriter, opts?)`.
2. Enqueue on the skills' per-`baseDir` chain.
3. Validate `id` → slug regex; reject with `InvalidSkillIdError`.
4. Validate `name`, `description`, `argumentHint` round-trip
   through `quoteScalar`/`unquoteScalar`; reject with
   `MalformedSkillError` on failure.
5. Validate `allowedTools` shape (array, each ≤128 chars, no
   newlines); reject with `MalformedSkillError` on failure.
6. `initSkillsDir(baseDir)` (idempotent).
7. `mkdir(<id>/, { recursive: true })`, `chmod 0o700`.
8. Serialize → string; check `bytes <= MAX_SKILL_BYTES`; reject with
   `SkillTooLargeError`.
9. `detectSecrets(serialized)`; any match (or, when
   `opts.allowLowConfidenceSecrets`, only high-confidence) →
   `SecretInSkillError`.
10. `listSkills()` to compute aggregate SKILL.md bytes + count;
    reject with `SkillsFullError` / `TooManySkillsError` on
    overflow (update path subtracts the prior entry's bytes).
11. `atomicWrite(<id>/SKILL.md.tmp)` → fsync → rename → chmod 0o600
    → fsync parent dir.
12. Rebuild `SKILLS.md` from the full skill set, atomic-write same
    way.
13. Emit `skill_written { id, name, bytes, hasAllowedTools, isNew,
    timestamp }`.

### Delete path

1. `deleteSkill(baseDir, id, auditWriter)`.
2. Validate id; `initSkillsDir(baseDir)`.
3. `readSkill` first to capture `name` for the audit event. If
   `null` → `SkillNotFoundError`.
4. `unlink(<id>/SKILL.md)`.
5. `readdir(<id>/)`:
   - Empty or only `SKILL.md.tmp` → unlink `.tmp`, `rmdir(<id>/)`.
   - Non-empty → leave the directory.
6. Rebuild `SKILLS.md`.
7. Emit `skill_deleted { id, name, timestamp }`.

### Crash recovery

- Filesystem (SKILL.md files) is truth; `SKILLS.md` is derived.
- Mid-write crash → `*.tmp` sweep by `initSkillsDir` on next
  mutation cleans up; `SKILLS.md` stale until the next mutation
  rebuilds it; `listSkills` regenerates from disk and doesn't trust
  the index.
- Mid-delete crash after `unlink(SKILL.md)` but before `rmdir` →
  stale `<id>/` dir remains (possibly with only `.tmp` inside). The
  next `listSkills` treats it as "skill in progress with no
  SKILL.md" and silently skips.

### Concurrent writes

Per-`baseDir` promise chain (separate `Map` from memory's)
serializes mutations within the process. Cross-process concurrency
at the SKILL.md level is atomic via POSIX rename; `SKILLS.md`
rewrites can interleave but the next mutation heals it. Acceptable
for single-user local-first.

---

## Module breakdown

### `src/skills/skill.ts` (new, ~220 LOC)

Types → ID validation → escape helpers → array helpers →
serialize → parse.

```ts
export type Skill = { /* as §1 above */ }

export type SkillParseError =
  | 'bad_frontmatter'
  | 'missing_field'
  | 'bad_type'
  | 'bad_escape'
  | 'bad_allowed_tools'
  | 'bad_argument_hint'

export type ParsedSkill =
  | { ok: true; skill: Skill }
  | { ok: false; error: SkillParseError }

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export function validateId(id: string): boolean { ... }

export function quoteScalar(s: string): string { ... }        // copied
export function unquoteScalar(raw: string): string | null { ... } // copied
export function canRoundTrip(s: string): boolean { ... }      // copied

// Parse one of:
//   [                   → []
//   []                  → []
//   ["a"]               → ["a"]
//   ["a", "b"]          → ["a", "b"]
//   [ "a" , "b" ]       → ["a", "b"]
// Returns null on anything else.
export function parseStringArray(raw: string): readonly string[] | null { ... }

export function serializeSkill(skill: Skill): string {
  // Frontmatter emission order:
  //   name, description, [allowed-tools], [argument-hint],
  //   schemaVersion, createdAt, updatedAt
  // Scalars matching /^[A-Za-z0-9][A-Za-z0-9 _\-./]*[A-Za-z0-9]$/
  // emit unquoted; others via quoteScalar.
  // Array uses one-line JSON-style literal.
}

export function parseSkillFile(
  id: string,
  raw: string,
  stat?: { birthtimeMs?: number; mtimeMs?: number },
): ParsedSkill {
  // Same frontmatter splitter as memory. Keys are kebab-case
  // (`allowed-tools`, `argument-hint`), TypeScript maps to camelCase.
  // Missing schemaVersion → default 1.
  // Missing createdAt → stat.birthtimeMs ?? stat.mtimeMs ?? 0.
  // Missing updatedAt → stat.mtimeMs ?? 0.
  // Quoted and unquoted scalar values both accepted.
  // Required: name, description. Else `missing_field`.
}
```

The `allowedTools` parse runs through `parseStringArray` — not
`JSON.parse`, because we already hand-parse scalars and mixing two
escape conventions invites subtle divergence. Tested on whitespace
variants.

### `src/skills/store.ts` (new, ~380 LOC)

Structurally parallel to `src/memory/store.ts`, with directory-aware
path helpers:

```ts
function skillsDir(baseDir: string): string
function skillDir(baseDir: string, id: string): string
function skillFile(baseDir: string, id: string): string   // .../SKILL.md
function skillTmpFile(baseDir: string, id: string): string // .../SKILL.md.tmp
function indexFile(baseDir: string): string               // .../SKILLS.md
```

Key differences from memory's store:

- Index filename: `SKILLS.md`.
- Index sort: by `name` then `id`. No `type` group.
- Caps: `MAX_SKILL_BYTES`, `MAX_TOTAL_SKILL_BYTES`, `MAX_SKILL_COUNT`.
- Directory-aware write (mkdir `<id>/` before atomic file write).
- Directory-aware delete (unlink SKILL.md, rmdir iff empty-ish).
- `listSkills` scans subdirectories, not flat files.
- `readSkill`/`listSkills` stat the file and thread the stat into
  `parseSkillFile` for timestamp fallback.
- Separate `chains: Map<string, Promise<unknown>>` — memory mutations
  and skill mutations don't serialize against each other.
- Audit calls: `makeSkillWrittenEvent` / `makeSkillDeletedEvent`.

`WriteSkillOptions` matches memory's pattern:
```ts
export type WriteSkillOptions = {
  readonly allowLowConfidenceSecrets?: boolean
}
```

### `src/memory/localMemoryGuard.ts` (edit, +1 line)

```ts
const dirs = [
  baseDir,
  join(baseDir, 'sessions'),
  join(baseDir, 'memory'),
  join(baseDir, 'skills'),    // ← Phase 5a
]
```

Docstring refresh: "Local guard for `~/.ultron/` directories —
transcript size + base directory permission enforcement for
sessions, memory, and skills."

### `src/core/queryEvents.ts` (edit, +~25 LOC)

After the memory event block (lines 156–178):

```ts
// Skill events (Phase 5a) — emitted by the skills store for writes/
// deletes. Payload is metadata only; skill content, description, and
// allowedTools are never on the event.

export type SkillWrittenEvent = {
  readonly type: 'skill_written'
  readonly id: string
  readonly name: string
  readonly bytes: number
  readonly hasAllowedTools: boolean
  readonly isNew: boolean
  readonly timestamp: number
}

export type SkillDeletedEvent = {
  readonly type: 'skill_deleted'
  readonly id: string
  readonly name: string
  readonly timestamp: number
}
```

Add both to the `QueryEvent` union (line 199–217).

### `src/core/queryEventFactories.ts` (edit, +~30 LOC)

```ts
export function makeSkillWrittenEvent(args: {
  id: string
  name: string
  bytes: number
  hasAllowedTools: boolean
  isNew: boolean
}): SkillWrittenEvent {
  return { type: 'skill_written', ...args, timestamp: Date.now() }
}

export function makeSkillDeletedEvent(args: {
  id: string
  name: string
}): SkillDeletedEvent {
  return { type: 'skill_deleted', ...args, timestamp: Date.now() }
}
```

### `src/audit/auditLog.ts` (edit, +2 lines)

Append `'skill_written', 'skill_deleted'` to `SHOULD_AUDIT` at line
28–44.

---

## Critical invariants

1. **Substrate-only.** No `QueryEngine` change, no tool registration,
   no slash command, no system-prompt injection. 5a is observable
   only via tests.
2. **Filesystem is truth, `SKILLS.md` is derived.** `listSkills`
   reads the directory tree directly; index rebuild is idempotent.
3. **Atomic writes.** Every SKILL.md and `SKILLS.md` write goes
   through tmp + fsync + rename + parent-dir fsync.
4. **Mutations serialized per baseDir.** Concurrent `writeSkill`
   calls from the same process queue cleanly.
5. **Memory and skill chains are independent.** Different `Map`
   instances.
6. **Sibling files and directories are preserved.** `writeSkill` and
   `deleteSkill` only touch `SKILL.md` and `SKILL.md.tmp`.
   `assets/`, `scripts/`, `references/`, `agents/` — whatever the
   user or a future tool drops in the skill dir — survives.
7. **Strict secret gate.** Any `detectSecrets` hit rejects in 5a.
8. **Audit metadata only.** Events carry `id`, `name`, `bytes`,
   `hasAllowedTools` boolean; never content, description,
   argumentHint, or the allowedTools list. `redactSecrets` runs as
   defense-in-depth.
9. **`allowedTools` is data, not policy, in 5a.** Stored, shape-
   validated, never consulted by any permission check.
10. **Permissions cascade unaffected.** Skills cannot grant
    themselves capabilities; the cascade is untouched.
11. **Hand-authored skill compat.** A `SKILL.md` with only `name`
    and `description` in frontmatter parses cleanly. Missing
    schemaVersion defaults to 1; missing timestamps fall back to
    `fs.stat().mtime`.

---

## Sharp edges

- **Codec duplication.** ~40 LOC of helpers copied from
  `memory/entry.ts`. Acceptable; dedup in a later cleanup.
- **`allowedTools` array serialization whitespace.** Serializer
  emits `["a", "b"]` (one space after comma); parser tolerates
  `["a","b"]`, `[ "a" , "b" ]`, `[]`, `[ ]`. Tested.
- **`allowedTools: []` vs absent.** Distinct: the field is omitted
  on serialize when `undefined`, emitted as `[]` when explicitly
  empty. Parser preserves the distinction on the parsed object.
- **`argumentHint` length cap.** 256 chars.
- **Caps math on update.** Subtract the prior skill's serialized
  bytes before adding the new one. Copy 4a's pattern.
- **Concurrent in-process write to the same id.** Per-`baseDir`
  chain serializes; second write reads first's state via
  `listSkills`. Tested.
- **Malformed SKILL.md files** — warn to stderr and skip; invisible
  to consumers until fixed (5b surfaces via `/skill list`).
- **Skill directories with only sibling content, no SKILL.md** —
  `listSkills` silently skips. A user mid-authoring doesn't get a
  warning spam. (`readSkill(baseDir, id)` on such a dir returns
  `null`, same as "missing skill".)
- **Loose `.md` files at `skills/` root (not in a subdir)** — one
  stderr warning per loose file on `listSkills`, suggesting the
  user move them into directories. Don't parse, don't index.
- **`deleteSkill` with sibling assets.** Intentional: we unlink
  SKILL.md and leave the dir. The skill is gone from Ultron's view
  but the user's assets survive. A later `/skill` option
  (`--purge-dir`) could offer full directory removal — not 5a.
- **Crash after mkdir `<id>/` but before writing SKILL.md.** Leaves
  an empty `<id>/` dir. `listSkills` skips it. Next write to the
  same `id` re-uses the directory; no extra cleanup needed.
- **Unquoted scalar with trailing whitespace or a colon.** The
  regex for "safe to emit unquoted" excludes both. If it slips past
  the emit-side check, the parser still handles it: `fields[key]`
  is `line.slice(colon+1).trim()`, so trailing whitespace dies.
  Colons inside would confuse the split; `canRoundTrip` (tests
  this) must match the regex the serializer uses.
- **mtime fallback precision.** `fs.stat().mtimeMs` is
  milliseconds-accurate on all supported platforms post-Node 20.
  Fine for display sort; drift under rsync/backup is noted in
  context above.
- **Directory perms on Windows.** 0o700 is best-effort. Tests that
  assert perms are gated on `process.platform !== 'win32'`.

---

## Verification

### Unit — `src/skills/skill.test.ts` (new)

- `validateId` — valid slugs pass; leading hyphens, uppercase,
  too-long fail.
- `quoteScalar`/`unquoteScalar` round-trip — empty, ASCII, all
  escape chars, `\uXXXX`; malformed inputs return null.
- `parseStringArray` — `[]`, `[ ]`, `["a"]`, `["a", "b"]`,
  `[ "a" , "b" ]`, `["a","b"]` all parse; non-arrays, unquoted
  elements, embedded `\n` fail.
- `serializeSkill` / `parseSkillFile` round-trip:
  - required-only (`name` + `description` + timestamps) → round-trip.
  - with `allowedTools: ["FileRead", "Bash"]` → round-trip.
  - with `allowedTools: []` → round-trip; parsed value is `[]`, not
    `undefined`.
  - with `argumentHint: "<pr-url>"` → round-trip.
  - unquoted scalar emission: `name: review-pr` re-parses to
    `"review-pr"`.
- Parser tolerance (hand-authored compat):
  - Missing `schemaVersion` → defaults to 1.
  - Missing `createdAt`/`updatedAt` with `stat` passed → falls back
    to `stat.birthtimeMs` / `stat.mtimeMs`.
  - Missing timestamps without `stat` → defaults to 0.
- Parser failure modes:
  - Missing `---` opener → `bad_frontmatter`.
  - Missing `name` → `missing_field`.
  - Missing `description` → `missing_field`.
  - `schemaVersion: 2` → `bad_type`.
  - Unbalanced quote → `bad_escape`.
  - `allowed-tools` not an array → `bad_allowed_tools`.
  - `allowed-tools` with non-string element → `bad_allowed_tools`.
  - `allowed-tools` element with embedded `\n` → `bad_allowed_tools`.
  - `argument-hint` with embedded `\n` → `bad_argument_hint`.

### Unit — `src/skills/store.test.ts` (new)

Each test uses a fresh tmp `baseDir` and a collecting `AuditWriter`
fake.

- `initSkillsDir` — idempotent; sweeps `<id>/SKILL.md.tmp`; sets
  0o700 on the `skills/` dir; does NOT sweep empty `<id>/`
  subdirectories.
- `writeSkill` happy path:
  - `<id>/SKILL.md` at mode 0o600, `<id>/` dir at 0o700.
  - `SKILLS.md` rebuilt with one entry, link target
    `<id>/SKILL.md`.
  - Audit event with `isNew: true`, `hasAllowedTools: false`.
- `writeSkill` preserves sibling assets:
  - Pre-create `<id>/assets/foo.txt` by hand.
  - `writeSkill` succeeds; `<id>/assets/foo.txt` still exists.
- `writeSkill` upsert — second write has `isNew: false`, `bytes`
  reflects new serialized size.
- `writeSkill` with `allowedTools` set → audit
  `hasAllowedTools: true`.
- `writeSkill` cap rejects:
  - oversized SKILL.md → `SkillTooLargeError`.
  - 129th skill → `TooManySkillsError`.
  - aggregate bytes overflow → `SkillsFullError`.
  - upsert that shrinks a skill near aggregate cap succeeds.
- `writeSkill` secret gate:
  - high-confidence match → `SecretInSkillError` regardless of opts.
  - low-confidence without opt → `SecretInSkillError`.
  - low-confidence with `allowLowConfidenceSecrets: true` → succeeds.
- `writeSkill` malformed:
  - bad id → `InvalidSkillIdError`.
  - non-round-trippable `name` → `MalformedSkillError`.
  - `allowedTools` with empty string → `MalformedSkillError`.
- `readSkill` — present returns `Skill`; absent returns `null`;
  malformed throws `MalformedSkillError`; missing timestamps in
  SKILL.md fall back to file mtime.
- `listSkills`:
  - Orders by `name` then `id`.
  - Skips `SKILLS.md`.
  - Skips directories with invalid id.
  - Skips directories without a `SKILL.md` (silent).
  - Warns on loose `.md` files at `skills/` root (not in a subdir).
  - Warns on malformed SKILL.md; does not throw.
- `deleteSkill`:
  - Empty-ish directory → full `rmdir(<id>/)` after `unlink`.
  - Directory with sibling `assets/` → SKILL.md unlinked, dir stays.
  - Missing SKILL.md → `SkillNotFoundError`.
  - Audit emits `skill_deleted` with the original `name`.
- `rebuildIndex` — regenerates `SKILLS.md` from on-disk skills; no
  audit event.
- Concurrency — two parallel `writeSkill` calls to different ids end
  with both SKILL.md files and `SKILLS.md` listing both.
- Independence from memory — interleave `writeSkill` and
  `writeEntry` on the same baseDir; neither blocks the other
  (observable by asserting ordering doesn't serialize across
  stores).

### Integration — `tests/integration/skill-store.test.ts` (new)

- End-to-end: `enforceBaseDirectoryPermissions(baseDir)` →
  `writeSkill` → `readSkill` round-trip; verify
  `~/.ultron/skills/` at 0o700, `<id>/` at 0o700, `SKILL.md` at
  0o600. (Skip perm assertions on Windows.)
- Hand-authored skill parse: hand-write `<id>/SKILL.md` with only
  `name` + `description` frontmatter; `readSkill` returns a `Skill`
  with timestamps from `fs.stat` and `schemaVersion: 1`.
- Audit log integration: real `createAuditWriter` (tmp dir) →
  `writeSkill` → `close()` → JSONL lines parse to expected events
  with `schemaVersion: 1` envelope.

### Manual smoke

```bash
npm run typecheck
npm run test
ls -la ~/.ultron/skills 2>/dev/null     # confirms substrate doesn't
                                        # touch disk until first write
```

`npm run typecheck && npm run test` green at every step.

---

## Acceptance

- `src/skills/skill.ts` exports `Skill`, `parseSkillFile`,
  `serializeSkill`, `validateId`, `canRoundTrip`, `ID_PATTERN`,
  `parseStringArray`, plus local `quoteScalar`/`unquoteScalar`.
- `src/skills/store.ts` exports `initSkillsDir`, `readSkill`,
  `listSkills`, `readIndex`, `writeSkill`, `deleteSkill`,
  `rebuildIndex`, plus cap constants and typed errors.
- `src/memory/localMemoryGuard.ts::enforceBaseDirectoryPermissions`
  enforces 0o700 on `<baseDir>/skills/`.
- `src/core/queryEvents.ts` exports `SkillWrittenEvent`,
  `SkillDeletedEvent`, both in `QueryEvent`.
- `src/core/queryEventFactories.ts` exports
  `makeSkillWrittenEvent`, `makeSkillDeletedEvent`.
- `src/audit/auditLog.ts::SHOULD_AUDIT` includes `'skill_written'`,
  `'skill_deleted'`.
- On-disk layout matches ecosystem convention:
  `<baseDir>/skills/<id>/SKILL.md`; `SKILLS.md` is the derived index;
  sibling directories inside `<id>/` survive all mutations.
- Hand-authored skills (missing `schemaVersion` / timestamps) parse.
- All Phase 4 (4a–4d) tests stay green.
- `npm run typecheck && npm run test` green.

---

## Implementation order

Each step keeps the build green.

1. **Add the event types and factories.** Edit
   `src/core/queryEvents.ts` (+events, extend `QueryEvent`) and
   `src/core/queryEventFactories.ts` (+factories). Pure types.
2. **Add `'skill_written' / 'skill_deleted'`** to `SHOULD_AUDIT` in
   `src/audit/auditLog.ts`. Pure data.
3. **Write `src/skills/skill.ts` + `skill.test.ts`.** Codec only —
   serialize/parse round-trip, array helper, hand-author tolerance,
   all failure modes.
4. **Write `src/skills/store.ts` + `store.test.ts`.** Directory-aware
   CRUD. Memory tests stay green (separate `Map`, separate dir).
5. **Extend `enforceBaseDirectoryPermissions`** with the `skills/`
   entry. Existing memory-guard tests stay green.
6. **Add `tests/integration/skill-store.test.ts`** for the end-to-end
   guard + write + hand-authored-parse + audit smoke.
7. **Green.** `npm run typecheck && npm run test`.

5a closes the substrate. 5b adds activation (`/skill <id>`), body
injection at the `'org'` seam, `allowed-tools` enforcement, the
activation-time secret re-scan, and loosens `writeSkill`'s gate to
ask-on-low-confidence the way 4b loosened memory.

---

## Critical files to modify or create

- `src/skills/skill.ts` (NEW)
- `src/skills/store.ts` (NEW)
- `src/memory/localMemoryGuard.ts` (EDIT — +1 dir entry, docstring)
- `src/core/queryEvents.ts` (EDIT — +2 events, extend union)
- `src/core/queryEventFactories.ts` (EDIT — +2 factories)
- `src/audit/auditLog.ts` (EDIT — +2 SHOULD_AUDIT entries)
- `src/skills/skill.test.ts` (NEW)
- `src/skills/store.test.ts` (NEW)
- `tests/integration/skill-store.test.ts` (NEW)

## Reused existing utilities (do not re-implement)

- `src/memory/secretScanner.ts::detectSecrets` — same secret gate.
- `src/audit/types.ts::AuditWriter` — same writer contract.
- `src/memory/redact.ts::redactSecrets` — runs at the audit boundary.
- `src/memory/store.ts` structural patterns: per-baseDir promise
  chain, `atomicWrite`, `initX` lazy-create idiom, warn-and-skip in
  `listX`, cap math on upsert. Copied structurally; memory module
  is not imported from skills (intentional decoupling).

## Verification end-to-end

```bash
npm run typecheck
npm run test
npx vitest run src/skills/skill.test.ts
npx vitest run src/skills/store.test.ts
npx vitest run tests/integration/skill-store.test.ts
# All Phase 4 suites stay green:
npx vitest run src/memory/
npx vitest run src/cli/memoryCommand.test.ts
npx vitest run src/context/memoryInjection.test.ts
```

5a is a substrate phase: success means the disk shape, codec, caps,
and audit events are in place, with the on-disk layout matching
ecosystem convention (Codex/Claude Code skill packages), zero
observable runtime change to today's CLI, and hand-authored skills
from other tools parse without modification. 5b adds the `/skill`
activation surface and the permission-narrowing path that turn a
skill on disk into a turn-scoped system-prompt part.

**Sources consulted for on-disk convention:**
- OpenAI Codex Skills: https://developers.openai.com/codex/skills
- Claude Code Skills: https://code.claude.com/docs/en/skills
