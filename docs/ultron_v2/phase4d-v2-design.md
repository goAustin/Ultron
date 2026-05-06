# Phase 4d Design: Memory Injection + Scope-Aware Cache Hints

## Context

Phase 4 closes the v2 §4 Memory pillar. The prior three phases shipped
everything *around* memory but never actually showed it to the model:

- **4a** — on-disk store under `~/.ultron/memory/` (typed entries,
  caps, atomic writes, index rebuild, audit events).
- **4b** — three tools (`MemoryRead` / `MemoryWrite` / `MemoryEdit`)
  so the model can manage memory on demand.
- **4c** — `/memory` slash command for direct user management.

None of those three paths puts persisted entries into the model's
system prompt. A user can save "I prefer tabs", the model can read it
back via a `MemoryRead` tool call, but unless the model *remembers to
ask*, the fact is invisible. The entire point of memory is that facts
persist into future turns without a tool round-trip.

4d fixes this by **injecting the memory store into the system prompt
on every turn** at the seam already documented in
`src/context/cacheHints.ts:33-36`. The injection has to be
cache-friendly: memory changes relatively slowly (a `writeEntry` per
conversation at most), the Ultron preamble above it changes never, and
the date/env tail changes every turn. The current `CacheHint` is a
two-bucket `'static' | 'volatile'` with a single cache breakpoint on
the last static part — which means the very first memory byte after
injection would invalidate the preamble's cache.

4d therefore widens `CacheHint` to a three-bucket
`'global' | 'org' | 'volatile'` and teaches the Anthropic adapter to
emit **two** `cache_control` breakpoints (preamble boundary, memory
boundary), leveraging Anthropic's 4-breakpoint allowance. OpenAI and
MiniMax are unaffected — they rely on implicit prefix caching, which
already benefits from a stable part order.

The central architectural questions:

1. **How does the injection reach `memoryBaseDir` without refactoring
   the whole context pipeline?** `buildSystemPromptParts(cwd)` is a
   pure async function called from `QueryEngine.submitPrompt` at
   `src/sdk/QueryEngine.ts:425`. Answer: extend the signature to
   `buildSystemPromptParts(cwd, opts?: { memoryBaseDir?: string | null })`.
   When `memoryBaseDir` is absent, the injection step no-ops and
   output is byte-identical to today minus the `'static'` → `'global'`
   rename.
2. **What scope shape can the Anthropic adapter actually emit?** The
   installed SDK (`@anthropic-ai/sdk@0.39.0`,
   `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:49`)
   defines `CacheControlEphemeral = { type: 'ephemeral' }` with no
   `scope` field. Answer: widen the *internal* `CacheHint` now — it's
   the correct signal for the codebase's bookkeeping — but the
   adapter encodes scope as **two breakpoints** instead of a scope
   field. When the SDK lands a scope field, the adapter changes in
   one place and no caller updates.
3. **What about CLAUDE.md?** The memory note flagged it as a candidate
   `'org'`-scoped block. But CLAUDE.md already flows through the
   attachments pipeline (`src/context/attachments.ts:40`) as a
   volatile `<system-reminder>`. 4d does NOT move it into the system
   prompt — keeping the attachment path as the single source of
   project-scoped state avoids duplicating the change-detection logic.

---

## Architecture

```
  src/context/systemPromptParts.ts      (EDIT — type widen)
    └─ CacheHint: 'static' | 'volatile' → 'global' | 'org' | 'volatile'

  src/context/cacheHints.ts             (EDIT — opts + seam)
    ├─ buildSystemPromptParts(cwd, opts?: {memoryBaseDir?: string|null})
    ├─ preamble parts: cacheHint 'global' (was 'static')
    └─ if memoryBaseDir: invoke buildMemoryInjectionParts at the seam

  src/context/memoryInjection.ts        (NEW, ~160 LOC)
    ├─ buildMemoryInjectionParts(baseDir, budgetTokens)
    │    → SystemPromptPart[]
    ├─ wrap entries in one <system-reminder> block
    ├─ estimate tokens via CHARS_PER_TOKEN heuristic
    └─ trim oldest-first by updatedAt when over budget

  src/context/tokenBudget.ts            (EDIT — +1 constant)
    └─ export MEMORY_INJECTION_TOKEN_BUDGET = 8192

  src/core/providers/anthropicAdapter.ts (EDIT — two-pass scan)
    └─ buildAnthropicSystemField:
        pass 1 — last 'global' part gets cache_control
        pass 2 — last 'org' part (after global) gets cache_control

  src/sdk/QueryEngine.ts                (EDIT — 1 arg)
    └─ buildFullSystemPromptParts(this.config.cwd,
                                  { memoryBaseDir: this._memoryBaseDir })

  src/context/memoryInjection.test.ts   (NEW)
  src/context/cacheHints.test.ts        (EDIT — rename + new cases)
  src/context/queryContext.test.ts      (EDIT — rename)
  src/core/providers/anthropicAdapter.test.ts (EDIT — two-breakpoint case)
```

No changes to: provider registry, OpenAI/MiniMax adapters, query loop,
messages pipeline, permission engine, hooks spine, MCP, memory store,
memory tools, `/memory` slash, audit spine. 4d is additive along the
injection seam and the cache-hint bookkeeping — every other surface is
untouched.

---

## Scope

### In (locked)

1. Widen `CacheHint` in `src/context/systemPromptParts.ts:14` from
   `'static' | 'volatile'` to `'global' | 'org' | 'volatile'`.
   Semantics:
   - `'global'` — content byte-identical across all Ultron installs
     (the Ultron policy preamble). First-caching candidate.
   - `'org'` — content stable within one user but per-install (memory
     entries; future: skills, CLAUDE.md if it ever migrates off the
     attachment path). Second cache breakpoint.
   - `'volatile'` — changes every turn (date, env info).
2. Extend `buildSystemPromptParts` signature to
   `buildSystemPromptParts(cwd, opts?: { memoryBaseDir?: string | null })`.
   Backward-compat: when `opts?.memoryBaseDir` is absent or `null`,
   behavior is byte-identical to today (apart from the rename).
3. New `src/context/memoryInjection.ts` exporting:
   ```ts
   export async function buildMemoryInjectionParts(
     baseDir: string,
     budgetTokens: number,
   ): Promise<SystemPromptPart[]>
   ```
   - Reads `readIndex(baseDir)` + `listEntries(baseDir)` from 4a's
     store. No writes.
   - Returns `[]` when: baseDir doesn't exist, index is empty, list is
     empty, or budget ≤ 0.
   - Non-empty case: returns exactly one `SystemPromptPart` whose
     `content` is a `<system-reminder>` block containing the index
     followed by all entries serialized in `updatedAt`-desc order,
     grouped by `type`. One part, not many — keeps the cache breakpoint
     simple and matches how attachments wrap their reminders.
   - Budget trim: estimate token cost of the assembled block via
     `Math.ceil(charLength / CHARS_PER_TOKEN)` (reuses the existing
     heuristic at `src/context/tokenEstimator.ts:15`). If over budget,
     drop the oldest entry (by `updatedAt`) and retry. The index line
     for a dropped entry is also removed from the injected index (we
     regenerate our own view, not copy MEMORY.md byte-for-byte, so
     consumers don't look up entries that weren't injected).
4. New constant `MEMORY_INJECTION_TOKEN_BUDGET = 8192` in
   `src/context/tokenBudget.ts`. Budget is a cap on the injected
   block's total estimated tokens, not on individual entries. 8K tokens
   at 4 chars/token ≈ 32 KB — the same order of magnitude as one
   single entry's 32 KB cap.
5. Anthropic adapter — `buildAnthropicSystemField` at
   `src/core/providers/anthropicAdapter.ts:113`:
   - Pass 1: scan backward, find last `'global'` part with non-empty
     content; attach `cache_control: {type:'ephemeral'}`.
   - Pass 2: scan backward, find last `'org'` part with non-empty
     content; attach a second `cache_control: {type:'ephemeral'}`.
     Pass 2 never lands on a part already carrying a breakpoint
     because `'org'` and `'global'` are disjoint.
   - If no `'org'` parts in the array (memory empty or disabled),
     only Pass 1 fires — identical to today's behavior. Every
     existing adapter test stays green.
   - If both passes find a candidate, result has exactly 2
     `cache_control` blocks. Anthropic allows up to 4; we use 2.
6. `QueryEngine.submitPrompt` — one-line change at line 425 to pass
   `{ memoryBaseDir: this._memoryBaseDir }`. `_memoryBaseDir` is
   already a private field (added in 4c at line 160).
7. Injection ordering: the whole memory block lands **after** the
   preamble and **before** the date/env tail. Matches the seam comment.
   Inside the memory block, entries are grouped by `type` (in the
   existing `MEMORY_TYPES` order: user, feedback, project, reference),
   and within each type, newest `updatedAt` first. Stable across turns
   given a stable store — which is the point; a stable prefix is what
   makes prompt caching work.
8. The injected block is wrapped in `<system-reminder>…</system-reminder>`
   with a short header inside: `Persistent memory entries from earlier
   sessions. Use them to inform your responses without waiting for the
   user to repeat context.` Short enough not to consume budget,
   explicit about the model's expected behavior.
9. Comment refresh across every surface that still says `'static'`:
   - `src/context/systemPromptParts.ts` — rewrite the file-level
     JSDoc to describe the three-bucket semantics (`global` /
     `org` / `volatile`) and the two-breakpoint adapter strategy.
   - `src/context/cacheHints.ts` — rewrite the file-level JSDoc and
     replace the seam comment at lines 33-36 with "Memory injection
     lands here when `opts.memoryBaseDir` is set. Skills (5b) will
     add additional `'org'` parts to this region."
   - `src/core/providers/anthropicAdapter.ts:105-112` — rewrite the
     JSDoc above `buildAnthropicSystemField` to describe Pass 1
     (`'global'`) and Pass 2 (`'org'`).
   - `src/core/providers/openaiAdapter.ts::joinSystemPromptParts`
     and any adjacent comment — confirm there's no stale `'static'`
     mention; update if present.
10. Every existing test that filters on `cacheHint === 'static'` is
    renamed to `'global'`. Mechanical edit; no assertion semantics
    change.

### Out (deferred)

- **CLAUDE.md into the system prompt.** Already handled by attachments
  (`src/context/attachments.ts:40`). Moving it is a separate pillar.
- **Per-entry scope.** All memory entries currently share the `'org'`
  bucket. A future phase might promote `type: 'reference'` to a
  different bucket if provider caching semantics warrant it.
- **Tokenizer upgrade.** We use `CHARS_PER_TOKEN = 4`. Good enough for
  an 8K cap; a real tokenizer is a concern for the context-budget
  pillar that also owns attachment trimming.
- **Invalidation callbacks.** Memory mutations don't proactively
  invalidate cache — the next turn's `buildSystemPromptParts` just
  rebuilds from disk, and Anthropic's cache lookup handles the
  change transparently. Key insight: with two breakpoints, a memory
  change only invalidates the memory-segment cache; the preamble
  segment stays cached.
- **Scope field on Anthropic `cache_control`.** SDK v0.39.0 doesn't
  have it. When it lands, the two-pass logic flips to a scope-aware
  single-pass in one place. Zero caller changes.
- **Skills injection.** Phase 5b. Will insert additional `'org'` parts
  at the same seam; 4d's two-pass logic already covers them (last
  `'org'` part wins the second breakpoint, regardless of whether it's
  memory or a skill).
- **Disabling injection per-turn.** A runtime toggle (e.g. "don't
  inject memory this turn") is not part of 4d. Users who want memory
  disabled set `disableMemory: true` at engine construction.
- **Integration test through `callModel`.** 4d's new surface is
  covered by unit tests on `buildMemoryInjectionParts` +
  `buildSystemPromptParts` + `buildAnthropicSystemField`. A full
  `QueryEngine` integration test adds little — memory store
  integration is already covered by 4a/4b's integration tests.

---

## Data flow

### Turn submission (populated store)

1. `QueryEngine.submitPrompt` hits line 425:
   `buildFullSystemPromptParts(this.config.cwd, { memoryBaseDir: this._memoryBaseDir })`.
2. `buildSystemPromptParts` walks `buildSystemPrompt()` sections,
   pushes each non-empty section as `{content, cacheHint: 'global'}`.
3. `memoryBaseDir` is truthy → call `buildMemoryInjectionParts(baseDir, 8192)`.
   a. `readIndex(baseDir)` → string. Empty → return `[]`.
   b. `listEntries(baseDir)` → `readonly MemoryEntry[]`. Empty → `[]`.
   c. Sort: by `type` (MEMORY_TYPES order), then by `updatedAt` desc.
   d. Assemble candidate block:
      ```
      <system-reminder>
      Persistent memory entries from earlier sessions. …

      Index:
      {{re-rendered 1-line-per-entry summary}}

      ---

      ## user

      ### {{name}}

      {{description}}

      {{content}}

      (repeat per entry, grouped by type)
      </system-reminder>
      ```
   e. Estimate token cost via `CHARS_PER_TOKEN`. If over budget,
      drop the oldest entry and its index line, retry. Stop when
      under budget or zero entries remain. An empty assembly after
      trim → return `[]`.
   f. Return `[{content: <the wrapped block>, cacheHint: 'org'}]`.
4. `buildSystemPromptParts` pushes the memory part(s).
5. Date + env parts pushed with `cacheHint: 'volatile'`.
6. Returns `SystemPromptPart[]`.
7. Downstream: `callModel` → adapter. For Anthropic,
   `buildAnthropicSystemField`:
   - Pass 1 finds last `'global'` part → breakpoint 1.
   - Pass 2 finds last `'org'` part → breakpoint 2.
   - Returns `TextBlockParam[]` with two `cache_control` markers.

### Turn submission (empty store / disableMemory)

1. `_memoryBaseDir` is `null` (when `disableMemory: true`) or points at
   `~/.ultron` but `~/.ultron/memory/` is empty.
2. `buildMemoryInjectionParts` returns `[]` (either skipped via
   null check or after reading an empty index).
3. Parts array has global + volatile only.
4. Anthropic adapter's Pass 1 fires (breakpoint on last global), Pass 2
   finds no `'org'` part and no-ops. One breakpoint total — identical
   to today's behavior.

### Rebuild note

No bespoke cache invalidation. Memory changes between turns →
next turn's `buildSystemPromptParts` reads the new store state → the
injected block has different bytes → Anthropic's server-side cache
sees a changed second breakpoint and invalidates only that segment.
Preamble cache stays alive. This is the entire reason for the
two-breakpoint split.

---

## Module breakdown

### `src/context/systemPromptParts.ts` (edit)

```ts
// Before:
export type CacheHint = 'static' | 'volatile'

// After:
/**
 * Cache-hint bucket for a system-prompt part.
 *
 * - 'global'   : content byte-identical across all Ultron installs.
 *                Today: the Ultron policy preamble. Eligible for
 *                provider global-cache lookup where supported.
 * - 'org'      : content stable within one user but per-install.
 *                Today: memory entries. Future: skills, CLAUDE.md.
 *                The Anthropic adapter emits a separate cache
 *                breakpoint here so memory changes don't invalidate
 *                the preamble cache.
 * - 'volatile' : changes every turn (date, env info). No breakpoint.
 */
export type CacheHint = 'global' | 'org' | 'volatile'

export type SystemPromptPart = {
  readonly content: string
  readonly cacheHint?: CacheHint
}
```

### `src/context/cacheHints.ts` (edit)

```ts
export type BuildSystemPromptPartsOpts = {
  readonly memoryBaseDir?: string | null
}

export async function buildSystemPromptParts(
  cwd: string,
  opts: BuildSystemPromptPartsOpts = {},
): Promise<SystemPromptPart[]> {
  const staticSections = buildSystemPrompt()
  const systemCtx = await getSystemContext(cwd)
  const currentDate = `Today's date is ${new Date().toISOString().slice(0, 10)}.`

  const parts: SystemPromptPart[] = []

  for (const section of staticSections) {
    if (section.length > 0) {
      parts.push({ content: section, cacheHint: 'global' })
    }
  }

  // Memory/skills injection seam — 4d injects memory as 'org' parts here,
  // 5b will add skills using the same bucket. Anthropic adapter emits a
  // separate cache breakpoint on the last 'org' part so memory changes
  // leave the 'global' preamble cache intact.
  if (opts.memoryBaseDir) {
    const memParts = await buildMemoryInjectionParts(
      opts.memoryBaseDir,
      MEMORY_INJECTION_TOKEN_BUDGET,
    )
    parts.push(...memParts)
  }

  parts.push({ content: currentDate, cacheHint: 'volatile' })
  parts.push({ content: systemCtx.envInfo, cacheHint: 'volatile' })

  return parts
}
```

### `src/context/memoryInjection.ts` (new)

**Naming note (important).** `baseDir` in this module is the **Ultron
root** (e.g. `~/.ultron`) — the same value `QueryEngine._memoryBaseDir`
holds. The store's `readIndex` / `listEntries` internally join
`memory/` onto it. Do NOT pre-join `memory/` here; the store will
silently look for `~/.ultron/memory/memory/` if you do. A `baseDir`
comment in the module header keeps this from regressing.

```ts
import type { SystemPromptPart } from './systemPromptParts.js'
import { listEntries, readIndex } from '../memory/store.js'
import type { MemoryEntry, MemoryType } from '../memory/entry.js'
import { MEMORY_TYPES } from '../memory/entry.js'
import { CHARS_PER_TOKEN } from './tokenEstimator.js'

const HEADER = [
  '<system-reminder>',
  'Persistent memory entries from earlier sessions. Use them to inform',
  'your responses without waiting for the user to repeat context. These',
  'are authoritative statements of user preferences, project facts, and',
  'references — not ephemeral chat history.',
  '',
].join('\n')

const FOOTER = '</system-reminder>'

/**
 * Build the memory injection block for the system prompt.
 *
 * - Empty store, missing dir, or zero budget → [].
 * - Otherwise, returns exactly one 'org' part whose content wraps the
 *   rendered index + all entries (newest-first within each type group)
 *   in a <system-reminder>.
 * - Trims oldest entries (by updatedAt) when over the token budget.
 */
export async function buildMemoryInjectionParts(
  baseDir: string,
  budgetTokens: number,
): Promise<readonly SystemPromptPart[]> {
  if (budgetTokens <= 0) return []

  const index = await readIndex(baseDir)
  if (index.length === 0) return []

  const all = await listEntries(baseDir)
  if (all.length === 0) return []

  // Sort by (type-order, updatedAt desc).
  const typeOrder = new Map(MEMORY_TYPES.map((t, i) => [t, i]))
  const sorted = [...all].sort((a, b) => {
    const ta = typeOrder.get(a.type as MemoryType) ?? 999
    const tb = typeOrder.get(b.type as MemoryType) ?? 999
    if (ta !== tb) return ta - tb
    return b.updatedAt - a.updatedAt
  })

  // Newest-first across the whole list, for trim order (drops by age).
  const trimOrder = [...all].sort((a, b) => a.updatedAt - b.updatedAt)

  let included = new Set(sorted.map((e) => e.id))
  let block = renderBlock(sorted.filter((e) => included.has(e.id)))

  while (estimateTokens(block) > budgetTokens && included.size > 0) {
    // drop oldest still included
    for (const e of trimOrder) {
      if (included.has(e.id)) {
        included.delete(e.id)
        break
      }
    }
    if (included.size === 0) return []
    block = renderBlock(sorted.filter((e) => included.has(e.id)))
  }

  if (estimateTokens(block) > budgetTokens) return []
  return [{ content: block, cacheHint: 'org' }]
}

function renderBlock(entries: readonly MemoryEntry[]): string {
  const lines: string[] = [HEADER]
  lines.push('Index:')
  for (const e of entries) {
    lines.push(`- [${e.type}] ${e.name} — ${e.description}`)
  }
  lines.push('', '---', '')

  let lastType: MemoryType | null = null
  for (const e of entries) {
    if (e.type !== lastType) {
      lines.push(`## ${e.type}`, '')
      lastType = e.type
    }
    lines.push(`### ${e.name}`, '')
    lines.push(e.description, '')
    lines.push(e.content, '')
  }
  lines.push(FOOTER)
  return lines.join('\n')
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN)
}
```

### `src/context/tokenBudget.ts` (edit, +3 LOC)

```ts
/**
 * Token cap for memory injection into the system prompt (Phase 4d).
 * Attachments have their own budget; this one is memory-specific.
 */
export const MEMORY_INJECTION_TOKEN_BUDGET = 8192
```

### `src/core/providers/anthropicAdapter.ts` (edit)

Two independent backward scans; if neither finds a breakpoint target,
fall back to the joined string. `'global'` and `'org'` are a disjoint
union on the type so the two passes can't collide — no bookkeeping
needed.

```ts
export function buildAnthropicSystemField(
  parts: readonly SystemPromptPart[],
  promptCacheModel: ModelEntry['promptCacheModel'],
): string | TextBlockParam[] {
  if (promptCacheModel !== 'explicit') {
    return parts.map(p => p.content).join('\n\n')
  }

  const blocks: TextBlockParam[] = parts.map(p => ({
    type: 'text',
    text: p.content,
  }))

  let marked = false

  // Pass 1 — last non-empty 'global' part gets a cache breakpoint.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.cacheHint === 'global' && part.content.length > 0) {
      blocks[i] = { ...blocks[i]!, cache_control: { type: 'ephemeral' } }
      marked = true
      break
    }
  }

  // Pass 2 — last non-empty 'org' part gets a second breakpoint.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.cacheHint === 'org' && part.content.length > 0) {
      blocks[i] = { ...blocks[i]!, cache_control: { type: 'ephemeral' } }
      marked = true
      break
    }
  }

  // All-volatile input (or empty) → no breakpoint target; fall back to
  // the joined string so the pre-1b tests and any all-volatile callers
  // still get byte-identical output.
  if (!marked) return parts.map(p => p.content).join('\n\n')

  return blocks
}
```

Also refresh the JSDoc above the function (currently mentions only
`'static'`) to describe the two-pass `'global'` / `'org'` semantics.

### `src/sdk/QueryEngine.ts` (edit, 1 line)

```ts
// Before (line 425):
const systemPromptParts = await buildFullSystemPromptParts(this.config.cwd)

// After:
const systemPromptParts = await buildFullSystemPromptParts(this.config.cwd, {
  memoryBaseDir: this._memoryBaseDir,
})
```

No config changes; `_memoryBaseDir` is already populated (line 186) or
null (line 196) from 4c.

---

## Critical invariants

1. **Empty-store path is byte-identical to today's behavior.** When
   memory is empty or `disableMemory: true`, the injected parts array
   contains zero `'org'` parts; the Anthropic adapter emits exactly
   one cache breakpoint (same as 1b); OpenAI/MiniMax still join the
   parts in the same order.
2. **Preamble cache survives memory changes.** Two breakpoints mean a
   memory mutation invalidates the memory segment cache but leaves
   the preamble segment cache intact. This is the whole reason for
   the widening.
3. **Injection is read-only.** 4d never calls `writeEntry` /
   `deleteEntry`. No audit events fire from the injection path. No
   mutation queue contention with 4b/4c tool/slash writes.
4. **Injection ordering is stable across turns.** Given a stable
   store, two calls to `buildSystemPromptParts` produce identical
   memory parts — byte-for-byte. `MEMORY_TYPES`-order grouping plus
   `updatedAt`-desc ordering within group plus explicit sort.
5. **Budget is a hard cap.** If even after dropping every entry the
   wrapper exceeds budget (pathological), return `[]`. Never ship a
   block over budget.
6. **Injection is one part, not many.** Simpler cache breakpoint
   placement; matches how attachments wrap their reminders in one
   `<system-reminder>` block.
7. **CacheHint disjoint sets.** A part carries at most one hint.
   Pass 2 skips the index that Pass 1 marked, and the source code
   never assigns both. Invariant checked by the adapter test that
   asserts exactly ≤2 breakpoints.
8. **No new scope field on Anthropic `cache_control`.** The SDK
   doesn't have one yet; we encode scope positionally. When the SDK
   adds it, the adapter changes in exactly one place.

---

## Sharp edges

- **`readIndex` vs. re-rendering the index.** We don't copy
  `MEMORY.md` verbatim — we regenerate the index from the trimmed
  entry list. Otherwise a trimmed entry's name would appear in the
  injected index but not in the rendered body, confusing the model.
  The original `MEMORY.md` on disk is unchanged.
- **Clock skew on `updatedAt`.** Entries store ms-epoch. If two
  entries have identical `updatedAt`, the trim order is stable by JS
  sort stability (V8 is stable post-2018). Reviewed.
- **Empty memory dir vs. missing memory dir.** `readIndex` returns
  `''` for both; `listEntries` returns `[]` for both. Either case
  yields zero injection parts. Matches the "no-op when empty"
  invariant.
- **Large index, few entries.** `MEMORY.md` can be up to ~25 KB
  (256 entries × ~100 chars/line). Re-rendering from trimmed
  entries means we never carry the disk `MEMORY.md` directly, so
  budget accounts for what the model actually sees.
- **Entries referencing each other.** If entry A says "see entry B"
  and B gets trimmed, the model will be confused. 4d does not
  implement reference resolution — mention in `/memory help` that
  entries should be self-contained.
- **Budget heuristic is approximate.** `CHARS_PER_TOKEN = 4` can
  under-count 2-3x for code-heavy content. Not a correctness issue
  — injection is a prefix of the prompt; over-inclusion just eats
  into the main budget, handled by existing compaction triggers.
- **Model sees both `<system-reminder>` and a `## user` section.**
  Some readers may conflate memory `type: 'user'` with the chat role
  "user". Headers use lowercase type tokens (`user`, `feedback`,
  `project`, `reference`) under H2; the header text above explicitly
  frames them as memory categories. Acceptable.
- **Two breakpoints on OpenAI.** Ignored. OpenAI implicit caching
  doesn't consume the `cache_control` field; only Anthropic does.
  OpenAI/MiniMax still see one big joined string with the same stable
  prefix.
- **Concurrent `/memory` edit while a turn is in flight.** The
  engine already built its parts array at line 425; the mutation
  lands for the *next* turn. No race window.
- **`listEntries` silently skips malformed entries.** Already 4a's
  posture; propagates to 4d's injection. A corrupt entry is
  invisible to both the user and the model until they fix it via
  `/memory edit`.

---

## Verification

### Unit — `src/context/memoryInjection.test.ts` (new)

Each test uses a fresh tmp `baseDir`. **Test setup writes entries via
the real `writeEntry` path** (with a collecting `AuditWriter` fake) so
`MEMORY.md`, file modes, and the mutation queue all match production.
The corrupt-entry case is the only one that hand-writes a malformed
file directly under `memory/`.

- Empty dir → returns `[]`.
- Single entry, ample budget → returns one `'org'` part whose content
  includes `<system-reminder>`, the entry name, and description.
- Multiple entries → grouped by `MEMORY_TYPES` order; within each
  group, `updatedAt`-desc.
- Budget = 0 → returns `[]`.
- Budget too tight for even one entry → returns `[]`.
- Budget mid-range → returns a part, and that part's token estimate
  is ≤ budget.
- **Trimming (deterministic).** Write 5 entries with explicit sizes
  and staggered `updatedAt`s chosen so exactly the three newest fit
  under a specific budget. Assert:
  - the three newest entry names ARE in the block,
  - the two oldest entry names are NOT in the block,
  - `estimateTokens(block) <= budget`.
  No assertion of the form "fits 3 at some arbitrary budget" — pick
  entries and budget deliberately so the math is closed-form.
- Two calls with no store change → byte-identical output (cache
  stability).
- Corrupt entry on disk (via hand-write) → `listEntries` skips it;
  output contains the non-corrupt entries.

### Unit — `src/context/cacheHints.test.ts` (edit + new cases)

Existing assertions on `cacheHint === 'static'` → rename to `'global'`.
Add:
- No `opts.memoryBaseDir` → no `'org'` parts.
- `opts.memoryBaseDir` pointing at empty tmp → no `'org'` parts.
- `opts.memoryBaseDir` with one entry → exactly one `'org'` part,
  placed between last `'global'` and first `'volatile'`.
- Ordering invariant: all `'global'` parts precede all `'org'` parts,
  which precede all `'volatile'` parts.

### Unit — `src/core/providers/anthropicAdapter.test.ts` (edit + new)

Existing single-breakpoint assertions still valid (an empty `'org'`
array yields one breakpoint).
Add:
- Parts with `'global'` + `'org'` + `'volatile'` → exactly two
  `cache_control` markers; one on the last `'global'`, one on the
  last `'org'`.
- Parts with `'global'` + `'volatile'` (no org) → one marker on the
  last `'global'` (regression of today's behavior).
- All `'volatile'` parts → joined string (fallback unchanged).
- Parts with two `'org'` parts → only the last one carries the
  marker.

### Unit — `src/context/queryContext.test.ts` (edit)

Rename `'static'` → `'global'` in existing assertions. No new cases
— the re-export surface doesn't change.

### Manual smoke

Requires an Anthropic key + populated memory:

```bash
# populate memory via 4c
node dist/cli.js
> /memory new prefs user
  (editor: name="tabs", description="prefers tabs", content="user prefers tabs over spaces", save)
> /quit

# next session sees it without asking
node dist/cli.js
> do you remember my tab/space preference?
# → model references the saved entry without invoking MemoryRead
```

Debug-level logging confirms two `cache_control` entries in the
`system` field on a turn with populated memory, one on empty memory.

`npm run typecheck && npm run test` green at every step.

---

## Acceptance

- `src/context/systemPromptParts.ts::CacheHint` is
  `'global' | 'org' | 'volatile'`.
- `buildSystemPromptParts(cwd, { memoryBaseDir })` injects exactly
  one `'org'` wrapped part on populated stores, zero parts on empty
  stores.
- `src/context/memoryInjection.ts` exports
  `buildMemoryInjectionParts(baseDir, budgetTokens)` with the
  semantics above.
- `MEMORY_INJECTION_TOKEN_BUDGET = 8192` exported from
  `src/context/tokenBudget.ts`.
- Anthropic `buildAnthropicSystemField` emits 2 `cache_control`
  markers when both `'global'` and `'org'` parts are present, 1 when
  only `'global'`, 0 (joined string) when all `'volatile'`.
- OpenAI/MiniMax adapters behave identically to today (byte-for-byte
  on the same input).
- `QueryEngine.submitPrompt` passes `this._memoryBaseDir` into
  `buildFullSystemPromptParts`.
- All 4a/4b/4c tests remain green. Every test that filtered on
  `cacheHint === 'static'` has been mechanically renamed to
  `'global'`.
- `npm run typecheck && npm run test` green.

---

## Implementation order

Each step keeps the build green.

1. **Widen `CacheHint`.** Edit
   `src/context/systemPromptParts.ts:14`. Update
   `src/context/cacheHints.ts:29` to push `'global'` instead of
   `'static'`. Mechanical rename in
   `src/context/cacheHints.test.ts` and
   `src/context/queryContext.test.ts` (`'static'` → `'global'`).
   Typecheck + test green; no behavior change besides the rename.
2. **Extend Anthropic adapter.** Add Pass 2 to
   `buildAnthropicSystemField`. All existing tests still green
   (empty `'org'` array → one breakpoint). Add the four new
   adapter-test cases.
3. **Add budget constant.** Append
   `MEMORY_INJECTION_TOKEN_BUDGET = 8192` to
   `src/context/tokenBudget.ts`. Pure.
4. **Write `memoryInjection.ts` + tests.** Implement
   `buildMemoryInjectionParts`. Unit tests cover empty, single,
   multi, budget zero, budget tight, budget mid, trimming, stability.
5. **Wire injection into `cacheHints.ts`.** Extend the signature,
   invoke `buildMemoryInjectionParts` when `opts.memoryBaseDir` is
   set, update the seam comment. Add `cacheHints.test.ts` cases for
   the populated path. Existing tests stay green (no opt = no
   injection).
6. **Wire through `QueryEngine`.** One-line change at
   `src/sdk/QueryEngine.ts:425` to pass `{memoryBaseDir:
   this._memoryBaseDir}`. Existing `QueryEngine.test.ts` cases stay
   green (they don't populate memory).
7. **Green + smoke.** `npm run typecheck && npm run test`. Manual
   smoke from the verification section (populate memory via 4c, run a
   new session, confirm the model uses it).

4d closes v2 §4; the same seam serves 5b (Skills) next.

---

## Critical files to modify or create

- `src/context/systemPromptParts.ts` (EDIT — widen `CacheHint`)
- `src/context/cacheHints.ts` (EDIT — opts + invoke + rename)
- `src/context/memoryInjection.ts` (NEW)
- `src/context/tokenBudget.ts` (EDIT — +1 constant)
- `src/core/providers/anthropicAdapter.ts` (EDIT — two-pass scan)
- `src/sdk/QueryEngine.ts` (EDIT — 1 line)
- `src/context/memoryInjection.test.ts` (NEW)
- `src/context/cacheHints.test.ts` (EDIT — rename + new cases)
- `src/context/queryContext.test.ts` (EDIT — rename)
- `src/core/providers/anthropicAdapter.test.ts` (EDIT — new cases)

## Reused existing utilities (do not re-implement)

- `src/memory/store.ts`: `readIndex`, `listEntries` — read-only.
- `src/memory/entry.ts`: `MemoryEntry`, `MemoryType`, `MEMORY_TYPES`.
- `src/context/tokenEstimator.ts::CHARS_PER_TOKEN = 4`.
- `src/context/cacheHints.ts` structure — extend, don't rebuild.
- `src/core/providers/anthropicAdapter.ts::buildAnthropicSystemField` —
  extend with Pass 2, do not fork.
- `src/sdk/QueryEngine.ts::_memoryBaseDir` field — already populated
  (line 186) or null (line 196) from Phase 4c.

## Verification end-to-end

```bash
npm run typecheck
npm run test
npx vitest run src/context/memoryInjection.test.ts
npx vitest run src/context/cacheHints.test.ts
npx vitest run src/context/queryContext.test.ts
npx vitest run src/core/providers/anthropicAdapter.test.ts
```

Manual smoke: populate memory via `/memory new`, start a fresh
session, prompt the model with a question whose answer is in memory;
confirm it answers without invoking `MemoryRead`. With
`ANTHROPIC_LOG=debug`, confirm two `cache_control` entries in the
system field on the populated-memory turn.
