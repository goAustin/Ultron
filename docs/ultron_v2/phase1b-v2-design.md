# Phase 1b Design: Structured System-Prompt Parts + Cache-Hint Annotations

## Overview

Phase 1b replaces the single flat `systemPrompt: string` that flows through the agent loop with an ordered `readonly SystemPromptPart[]`, where each part carries an optional generic `cacheHint: 'static' | 'volatile'`. Each provider adapter translates those hints into its native prompt-cache shape: Anthropic emits `cache_control: {type: 'ephemeral'}` on the last `static` part, OpenAI and MiniMax concatenate parts in a stable order so the server's implicit prefix cache can attach.

The v1 dynamic-boundary sentinel (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) retires. The cut point between cacheable and non-cacheable content becomes **structural** — it is the transition from `static` → `volatile` in the parts list, not a magic string filtered before join.

Phase 1b is a type-shape change: it touches every `CallModelFn` call site (main query loop, subagent fork, compaction), but it introduces no new UX, no memory injection, and no compaction strategy changes. It reads `promptCacheModel` (populated in Phase 1a) to decide whether to emit Anthropic's explicit `cache_control` header; models with `'implicit'` or `'none'` rely on server-side behavior or receive no hint at all.

Memory and skills are **not injected** in 1b. Their future insertion point is documented as a source-code seam inside the builder — no empty `SystemPromptPart` is emitted, because an empty part makes a bad `cache_control` target.

CLAUDE.md / project instructions remain **attachment-only** per `src/context/queryContext.ts:4-6`. Re-introducing them as system-prompt content in 1b would duplicate context and break the OpenAI/MiniMax byte-identity requirement below.

---

## Architecture

```
  ┌────────────────────────────────────┐
  │   src/context/systemPrompt.ts      │  static sections (sync, pure)
  │   buildSystemPrompt(): string[]    │  — no boundary sentinel anymore —
  └──────────────────┬─────────────────┘
                     │
                     │  consumed by
                     ▼
  ┌────────────────────────────────────┐
  │   src/context/cacheHints.ts        │  ← NEW
  │                                    │
  │   buildSystemPromptParts(cwd)      │  composes:
  │     → Promise<SystemPromptPart[]>  │    1) static ultron preamble parts
  │                                    │    2) [memory/skills seam — 4d/5b]
  │                                    │    3) volatile dynamic tail
  └──────────────────┬─────────────────┘     (date, envInfo)
                     │
                     ▼
  ┌────────────────────────────────────┐
  │   src/context/queryContext.ts      │  re-export + thin wrapper:
  │   buildFullSystemPromptParts(cwd)  │  renamed from buildFullSystemPrompt
  └──────────────────┬─────────────────┘
                     │
       ┌─────────────┼───────────────────┐
       │             │                   │
       ▼             ▼                   ▼
  QueryEngine    runAgent.ts        compact.ts
  (main loop)    (subagent fork)    (summarization)
                 │                  │
                 │ preamble-wrap    │ wraps const as a
                 ▼                  │ single 'static' part
          agentPrompt.ts            │
          buildSubagentSystemPrompt │
          (parts) → parts           │
                 │                  │
                 └─────┬────────────┘
                       │
                       ▼
          CallModelFn(messages, parts, opts, signal)
                       │
          ┌────────────┼───────────────┐
          │            │               │
          ▼            ▼               ▼
  anthropicAdapter  openaiAdapter   minimaxAdapter
  TextBlockParam[]  join('\n\n')    (via openai factory)
  + cache_control   single system
  on last static    message
```

Data flow: one builder in `cacheHints.ts` produces `SystemPromptPart[]`; every `CallModelFn` caller passes parts forward untouched; adapters make the final translation to their native wire format. Nothing between the builder and the adapter inspects or rewrites the parts — subagent wrapping prepends a part, compaction substitutes its own parts, but neither mutates the shape.

---

## Core Types & Interfaces

### `SystemPromptPart` (`src/context/systemPromptParts.ts` — new)

```ts
export type CacheHint = 'static' | 'volatile'

export type SystemPromptPart = {
  readonly content: string
  readonly cacheHint?: CacheHint   // absent ≈ 'volatile'
}
```

Deliberately tiny. `cacheHint` is optional so future injection sites (memory, skills) can leave it unset and get sensible default placement (treated as volatile, appended after the static prefix).

### `CallModelFn` signature change (`src/core/providers/types.ts`)

```ts
export type CallModelFn = (
  messages: unknown[],
  systemPromptParts: readonly SystemPromptPart[],   // was: systemPrompt: string
  options: CallModelOptions,
  signal: AbortSignal,
) => AsyncGenerator<RawStreamEvent, ApiResponseMeta>
```

Changing the type drags every caller through the refactor at typecheck time — the compiler is the migration script.

### `QueryParams` field rename (`src/core/queryTypes.ts`)

```ts
export type QueryParams = {
  readonly messages: readonly Message[]
  readonly systemPromptParts: readonly SystemPromptPart[]   // was: systemPrompt: string
  readonly deps: Partial<QueryDeps>
  readonly signal?: AbortSignal
  readonly maxTurns?: number
}
```

### `SubagentOptions` field rename (`src/agents/runAgent.ts`)

```ts
export type SubagentOptions = {
  // ...unchanged fields...
  readonly parentSystemPromptParts: readonly SystemPromptPart[]   // was: parentSystemPrompt: string
}
```

### `buildSubagentSystemPrompt` signature change (`src/agents/agentPrompt.ts`)

```ts
export function buildSubagentSystemPrompt(
  parentParts: readonly SystemPromptPart[],
): readonly SystemPromptPart[]
```

Preamble becomes a single `static` part prepended at index 0.

### Unchanged
- `ProviderId`, `ProviderAdapter`, `CapabilitySheet`, `ModelEntry`, `QueryEvent`, `CallModelOptions` — all untouched by 1b.
- `RawStreamEvent` / `ApiResponseMeta` — the response path is unaffected.

---

## Implementation Details

### Builder (`src/context/cacheHints.ts` — new)

One public function, no other exports:

```ts
import type { SystemPromptPart } from './systemPromptParts.js'
import { buildSystemPrompt } from './systemPrompt.js'
import { getSystemContext } from './systemContext.js'

export async function buildSystemPromptParts(
  cwd: string,
): Promise<SystemPromptPart[]> {
  const staticSections = buildSystemPrompt()   // returns string[]
  const systemCtx      = await getSystemContext(cwd)
  const currentDate    = `Today's date is ${new Date().toISOString().slice(0, 10)}.`

  const parts: SystemPromptPart[] = []

  // 1) Ultron static preamble — one part per non-empty section.
  //    Splitting per-section keeps diffs surgical if later a single section changes.
  for (const section of staticSections) {
    if (section.length > 0) {
      parts.push({ content: section, cacheHint: 'static' })
    }
  }

  // 2) [Memory/skills injection seam — Phase 4d / 5b will insert here.]
  //    Intentionally left empty; no part emitted until real content exists,
  //    because an empty part would make a bad cache_control target.

  // 3) Dynamic tail — two volatile parts.
  parts.push({ content: currentDate,      cacheHint: 'volatile' })
  parts.push({ content: systemCtx.envInfo, cacheHint: 'volatile' })

  return parts
}
```

**Invariants enforced by this builder:**
- At least one `static` part with non-empty `content` exists (guaranteed by `buildSystemPrompt()` always returning a non-empty ultron preamble).
- The last `static` part is followed only by `volatile` parts (no interleaving).
- Stable order across calls with the same `cwd` — load-bearing for both explicit and implicit caching.

### `queryContext.ts` wrapper

```ts
export { buildSystemPromptParts as buildFullSystemPromptParts } from './cacheHints.js'
```

The old `buildFullSystemPrompt(cwd): Promise<string>` is **removed**. The `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` re-export is **removed**. `systemPrompt.ts` deletes its boundary constant and stops inserting it into the returned array.

### Anthropic adapter (`src/core/providers/anthropicAdapter.ts`)

At `createCallModel` construction time the adapter already knows the `ModelEntry` for the chosen model (it looked it up from its own `MODELS` catalog to validate the id). Read `promptCacheModel` from that entry — **no import of `resolveCapabilities`** from `registry.ts` (would create a cycle: `registry.ts:13` already imports `anthropicAdapter`).

Replace `system: systemPrompt` at line ~260 with:

```ts
// Pseudocode — actual TextBlockParam import comes from @anthropic-ai/sdk.
type TextBlockParam = {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

function buildSystemField(
  parts: readonly SystemPromptPart[],
  promptCacheModel: ModelEntry['promptCacheModel'],
): string | TextBlockParam[] {
  if (promptCacheModel !== 'explicit') {
    // Fallback: single joined string — byte-identical to pre-1b.
    return parts.map(p => p.content).join('\n\n')
  }

  const blocks: TextBlockParam[] = parts.map(p => ({
    type: 'text',
    text: p.content,
  }))

  // Attach cache_control to the LAST static part with non-empty content.
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].cacheHint === 'static' && parts[i].content.length > 0) {
      blocks[i].cache_control = { type: 'ephemeral' }
      return blocks
    }
  }

  // Unreachable given the builder invariant, but fall back safely.
  return parts.map(p => p.content).join('\n\n')
}
```

Anthropic allows up to 4 cache breakpoints; 1b uses exactly 1. No bookkeeping is added for multi-breakpoint scenarios — if 4d later wants memory as its own cache segment, that's a 4d concern.

### OpenAI adapter (`src/core/providers/openaiAdapter.ts`)

Inside `anthropicToOpenAI` (lines ~48-52) replace the `content: systemPrompt` single-string with:

```ts
const systemContent = systemPromptParts
  .map(p => p.content)
  .join('\n\n')

// ...
{ role: 'system', content: systemContent }
```

For a given cwd the `systemContent` string is **byte-identical** to `buildFullSystemPrompt(cwd)`'s pre-1b output. This is enforced by a fixture test (see Verification §byte-parity).

### MiniMax adapter

No source change. `minimaxAdapter.ts` delegates to `createOpenAICompatibleCallModel()` which now routes `systemPromptParts` through. Hints are effectively ignored (correct — MiniMax is implicit caching).

### Subagent preamble (`src/agents/agentPrompt.ts`)

```ts
const SUBAGENT_PREAMBLE_PART: SystemPromptPart = {
  content: SUBAGENT_PREAMBLE,
  cacheHint: 'static',
}

export function buildSubagentSystemPrompt(
  parent: readonly SystemPromptPart[],
): readonly SystemPromptPart[] {
  return [SUBAGENT_PREAMBLE_PART, ...parent]
}
```

The parent's own last-static part still carries `cache_control`; Anthropic caches the whole prefix ending at that marker, so preamble + ultron static sections + any future memory/skills all share a single cached segment.

### Compaction (`src/context/compact.ts`)

`callForSummary` at line 201-228 still needs a system prompt. Wrap the constant once, at module scope:

```ts
const SUMMARIZATION_PARTS: readonly SystemPromptPart[] = [
  { content: SUMMARIZATION_SYSTEM_PROMPT, cacheHint: 'static' },
]
```

Change line 209-214:

```ts
const stream = callModel(
  [{ role: 'user', content: [{ type: 'text', text: conversationText }] }],
  SUMMARIZATION_PARTS,
  { maxOutputTokens: SUMMARIZATION_MAX_TOKENS },
  abortController.signal,
)
```

Side benefit: summarization requests on Anthropic now cache automatically — the system prompt is identical across every summarization call in a session.

### QueryEngine wiring (`src/sdk/QueryEngine.ts`)

Three call sites change:

- Line 232: `const systemPrompt = await buildFullSystemPrompt(...)` → `const systemPromptParts = await buildFullSystemPromptParts(this.config.cwd)`.
- Line 259: `parentSystemPrompt: systemPrompt` → `parentSystemPromptParts: systemPromptParts`.
- Line 290: `systemPrompt` → `systemPromptParts` in the `query()` call.

`src/cli.ts` is **not modified**. It never constructs a system prompt directly.

### `query.ts` wiring

`streamModelResponse` (line ~371-375) passes `params.systemPromptParts` to `deps.callModel` instead of `params.systemPrompt`. No other logic change in the loop.

---

## File Map

| File | Responsibility | Change type |
|------|---------------|-------------|
| `src/context/systemPromptParts.ts` | `SystemPromptPart` type | **New** |
| `src/context/cacheHints.ts` | Parts builder (`buildSystemPromptParts`) | **New** |
| `src/context/cacheHints.test.ts` | Builder invariants, ordering | **New** |
| `src/core/providers/anthropicAdapter.test.ts` | `cache_control` placement + capability gating | **New** |
| `src/core/providers/openaiAdapter.test.ts` | Byte-identical concatenation | **New** |
| `docs/ultron_v2/phase1b-v2-design.md` | This doc | **New** |
| `src/core/providers/types.ts` | `CallModelFn` signature (`string → parts`) | Modified |
| `src/core/providers/anthropicAdapter.ts` | `system` field becomes `string \| TextBlockParam[]` with conditional `cache_control` | Modified |
| `src/core/providers/openaiAdapter.ts` | `anthropicToOpenAI` joins parts | Modified |
| `src/core/providers/minimaxAdapter.ts` | No code change (delegates) | Unchanged |
| `src/core/queryDeps.ts` | `CallModelFn` import + stub update | Modified |
| `src/core/queryTypes.ts` | `QueryParams.systemPromptParts` | Modified |
| `src/core/query.ts` | Thread parts through `streamModelResponse` | Modified |
| `src/context/queryContext.ts` | Rename → `buildFullSystemPromptParts`; drop boundary re-export | Modified |
| `src/context/systemPrompt.ts` | Delete `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` + marker from returned array | Modified |
| `src/sdk/QueryEngine.ts` | Lines 232/259/290 → parts | Modified |
| `src/agents/runAgent.ts` | `parentSystemPromptParts` field; line-120 call site | Modified |
| `src/agents/agentPrompt.ts` | `(parts) → parts` signature; preamble is `static` part | Modified |
| `src/context/compact.ts` | `SUMMARIZATION_PARTS` wrap; line-209 call site | Modified |
| `src/sdk/QueryEngine.test.ts` | Thread parts where string was used | Modified |
| `src/agents/runAgent.test.ts` | Parts-shaped `SubagentOptions` | Modified |
| `src/context/compact.test.ts` | Summarization assertion on parts shape | Modified |
| `src/context/queryContext.test.ts` | Rename + return-type change | Modified |
| `src/context/systemPrompt.test.ts` | Boundary sentinel removed | Modified |

---

## Downstream Consumers

- **Phase 4d (memory injection)** — inserts a new `static` part at the documented seam in `cacheHints.ts`. Builder invariants already guarantee memory's part can slot in without changing the adapter contract; the existing last-static-part cache breakpoint just moves forward to the memory part.
- **Phase 5b (skills)** — same seam; skill body becomes a `static` part for the activation turn.
- **Phase 8a (hierarchical summarizer)** — session summary gets `cacheHint: 'static'` once stable; the last-static-part breakpoint follows.
- **Phase 1c (thinking budget)** — orthogonal; uses `supportsThinking` from 1a, does not touch parts.

No downstream consumer needs to re-traverse adapter code after 1b — they plug into the builder, not the wire format.

---

## Verification Criteria

### Typecheck
1. `npm run typecheck` passes. The `CallModelFn` signature change forces every call site (`query.ts`, `QueryEngine.ts`, `runAgent.ts`, `compact.ts`) through the rename; any missed site is a compile error.

### Builder (`cacheHints.test.ts`)
2. `buildSystemPromptParts(cwd)` returns parts in documented order (`static` preamble → `volatile` date → `volatile` envInfo).
3. At least one part has `cacheHint: 'static'` and non-empty `content`.
4. No part with `cacheHint: 'volatile'` appears before the last `static` part (static-then-volatile invariant).
5. Two calls with the same `cwd` return identical `content` for all `static` parts (determinism).

### Anthropic adapter (`anthropicAdapter.test.ts`)
6. For `claude-opus-4-7` (`promptCacheModel: 'explicit'`): the `system` field sent to `client.messages.stream` is a `TextBlockParam[]`, and exactly one element carries `cache_control: {type: 'ephemeral'}`.
7. That one element is the **last** part whose `cacheHint === 'static'` in the input.
8. For a hypothetical Anthropic entry with `promptCacheModel: 'implicit'` or `'none'` (test-fixture model, not a real shipped id): `system` is a plain joined string, no `TextBlockParam[]`, no `cache_control`.
9. The adapter reads `promptCacheModel` from its **own catalog** (no import from `registry.ts`) — enforced by a `grep` check in CI: no file under `src/core/providers/*adapter*.ts` imports from `./registry.js`.

### OpenAI adapter (`openaiAdapter.test.ts`) — byte-parity
10. Check a fixture `SystemPromptPart[]` in, `{role:'system', content: X}` out. `X` equals a recorded pre-1b `buildFullSystemPrompt(fixedCwd)` output **byte-for-byte**. The fixture is committed alongside the test.
11. Same check covers MiniMax (routes through the same factory).

### Subagent (`runAgent.test.ts`)
12. `buildSubagentSystemPrompt(parent)` returns `[{content: SUBAGENT_PREAMBLE, cacheHint:'static'}, ...parent]`. Preamble is index 0; parent parts preserved verbatim and in order.

### Compaction (`compact.test.ts`)
13. `callForSummary` passes a parts array of length 1 with `content === SUMMARIZATION_SYSTEM_PROMPT` and `cacheHint === 'static'`.

### Retired surface (grep-level)
14. `grep -Rn "SYSTEM_PROMPT_DYNAMIC_BOUNDARY" src` returns nothing.
15. `grep -Rn "buildFullSystemPrompt\b" src` returns nothing (only `buildFullSystemPromptParts` remains).

### Integration (opt-in, env-gated)
16. With a real `ANTHROPIC_API_KEY`, two consecutive Opus 4.7 calls sharing identical static parts: the second response's `usage.cache_read_input_tokens > 0`.

### No regressions
17. `npm run test` — all pre-existing tests pass.

---

## Out of Scope (Hard Gate)

- **No** hierarchical compaction or session-summary generation. That is Phase 8a.
- **No** memory content injection. The seam is left empty; Phase 4d fills it.
- **No** skill routing or skill-body injection. That is Phase 5b.
- **No** CLAUDE.md / project-instruction inclusion in the system prompt. They remain attachments (per `queryContext.ts:4-6`).
- **No** `/thinking`-style CLI toggle or any UX for cache inspection.
- **No** multi-breakpoint logic. Exactly 1 `cache_control` marker is emitted on Anthropic; Anthropic's cap is 4; future phases may use more.
- **No** beta-header wiring for 1M-context or interleaved-thinking. Those live in 1c (thinking) and possibly a later request-options cleanup.

---

## Deferred Design Decisions

- **Scope-aware cache hints.** The retired `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel encoded two things: the structural cut point (preserved here as the `static → volatile` transition) **and** a scope signal — content above the boundary is globally identical across all users/installs (eligible for `scope: 'global'` caching on providers that support it), content below is per-user/per-session at best. The binary `'static' | 'volatile'` collapses the scope dimension because today the only static content is the Ultron preamble. Phase 4d (memory) introduces the first org/user-scoped static content (memory, CLAUDE.md); at that point widen `CacheHint` to `'global' | 'org' | 'volatile'` (or equivalent) and teach the Anthropic adapter to attach `cache_control` at both the last global and the last org part (Anthropic allows up to 4 breakpoints).

---

## Risks & Unknowns

- **OpenAI byte-parity fixture staleness.** If the static sections in `src/context/systemPrompt.ts` change between branch-off and merge, the recorded fixture must be regenerated. The test's failure mode is a clear byte-diff, not a silent regression — low ongoing risk.
- **Anthropic SDK type for `system`.** `@anthropic-ai/sdk ^0.39.0` accepts `string | MessageParam[]` on recent versions; verifying the exact `TextBlockParam` shape (`type: 'text'`) and the `cache_control: {type: 'ephemeral'}` field is a SDK-types sanity check at implementation time, not a design-level unknown.
- **Empty volatile tail.** If `systemCtx.envInfo` is ever empty for an exotic platform, an empty `volatile` part slips into the array. Harmless for caching (not a target), but the builder could filter `content.length > 0` defensively. Decision: don't filter — keep the shape predictable; an empty volatile part is a nop downstream.
- **`promptCacheModel: 'none'` for Anthropic.** No currently-shipped Anthropic model carries `'none'`, so the fallback branch in the adapter is dead code today. It stays for forward-compatibility; the test covers it with a fixture model.
