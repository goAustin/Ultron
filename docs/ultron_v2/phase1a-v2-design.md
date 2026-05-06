# Phase 1a Design: Capability Metadata on `ModelEntry`

## Overview

Phase 1a makes model capabilities first-class **data** on every registered `ModelEntry`. Today `ModelEntry` carries only `{id, provider, label, description}`; every later v2 phase needs to ask questions the registry can't answer — "how big is this context window?", "does this model support extended thinking?", "is prompt caching explicit, implicit, or unavailable?". This phase extends `ModelEntry` with five readonly capability fields, populates them across all three adapters from vendor docs, exposes a `resolveCapabilities(modelId)` read path, and guards the registry with a load-time assertion so a future adapter author can't forget a field.

Phase 1a is pure substrate: **no runtime behavior changes**. No `cache_control` headers (that's 1b), no thinking-budget translation (1c), no memory or attachment injection (4d, 8c). Capabilities become readable, typed data and nothing else. The only visible behavior change is flipping the CLI's default model from Sonnet 4.6 → Opus 4.7 (roadmap step 1a.5).

---

## Architecture

```
         ┌──────────────────────────────┐
         │   capabilityMetadata.ts      │  pure constants
         │   (CONTEXT_1M, OUTPUT_64K,…) │
         └──────────────┬───────────────┘
                        │ imports
       ┌────────────────┼────────────────┐
       │                │                │
┌──────▼─────────┐ ┌────▼──────────┐ ┌───▼──────────┐
│ anthropicAdapt │ │ openaiAdapter │ │ minimaxAdapt │
│ MODELS[3]      │ │ MODELS[3]     │ │ MODELS[1]    │
└──────┬─────────┘ └────┬──────────┘ └───┬──────────┘
       │                │                │
       │  ProviderAdapter.models (readonly ModelEntry[])
       │                │                │
       └────────────────┼────────────────┘
                        │
                ┌───────▼────────────┐
                │    registry.ts     │
                │                    │
                │  ADAPTERS          │
                │  resolveModel()    │
                │  resolveCapabili…  │──► CapabilitySheet
                │  allModels()       │
                │  (load-time)       │
                │  assertCapabilit…  │──► throws at import if any field missing
                └────────────────────┘
                        ▲
                        │
                   ┌────┴─────┐
                   │callers:  │
                   │ cli.ts   │ (default model + fast fallback)
                   │ 1b/1c/4d │ (future phases — read CapabilitySheet,
                   │          │  never branch on providerId)
                   └──────────┘
```

Data flow: each adapter's `MODELS` catalog declares full capability data at construction time (typechecker-enforced). The registry composes all adapter catalogs and exposes two read APIs: `resolveModel()` (adapter + entry) and `resolveCapabilities()` (just the capability fields, typed as `CapabilitySheet`). A separate pure helper `assertCapabilitiesPopulated()` is called once at `registry.ts` load with the real `ADAPTERS` map; tests exercise the helper in isolation with fake fixtures, no mutation of the real registry needed.

---

## Core Types & Interfaces

### Extended `ModelEntry` (`src/core/providers/types.ts`)

```ts
export type ModelEntry = {
  readonly id: string            // e.g. 'claude-opus-4-7'
  readonly provider: ProviderId
  readonly label: string         // e.g. 'Claude Opus 4.7'
  readonly description: string   // e.g. 'Highest capability'

  // --- new in Phase 1a ---
  readonly maxContextTokens: number
  readonly maxOutputTokens: number
  readonly supportsThinking: boolean
  readonly supportsInterleavedThinking: boolean
  readonly promptCacheModel: 'explicit' | 'implicit' | 'none'
}
```

All five new fields are **required** (no `?:`). The compiler enforces that every `ModelEntry` literal sets them; this is verification #1 from the roadmap ("typecheck") wired into the type system itself.

### `CapabilitySheet` alias

```ts
export type CapabilitySheet = Pick<
  ModelEntry,
  | 'maxContextTokens'
  | 'maxOutputTokens'
  | 'supportsThinking'
  | 'supportsInterleavedThinking'
  | 'promptCacheModel'
>
```

The exact shape returned by `resolveCapabilities()`. Downstream phases (1b, 1c, 4d, 8a, 8c) import **this** type — they do not depend on the full `ModelEntry` or on `ProviderAdapter`.

### Unchanged

- `ProviderId`, `ProviderAdapter`, `CreateCallModelOptions`, `UnknownModelError`, `MissingApiKeyError` — no modifications. Phase 1a is purely additive.

---

## Implementation Details

### Capability constants (`src/core/providers/capabilityMetadata.ts`)

Pure-constant module; zero runtime logic. Centralizes numeric values so "64K output" lives in one place, not seven catalog entries.

```ts
// Context windows
export const CONTEXT_1M   = 1_000_000
export const CONTEXT_400K =   400_000
export const CONTEXT_256K =   256_000
export const CONTEXT_200K =   200_000

// Output caps
export const OUTPUT_128K = 128_000
export const OUTPUT_64K  =  64_000
export const OUTPUT_16K  =  16_384
```

**No shared-object "presets"** (e.g. `NON_THINKING_IMPLICIT`). Only MiniMax would have used one; inlining its fields is clearer than a one-use abstraction.

### Catalog population

#### Anthropic (`src/core/providers/anthropicAdapter.ts:295-299`)

Sourced from Anthropic's *Context Windows* + *Extended Thinking* docs (platform.claude.com).

| id | maxContextTokens | maxOutputTokens | supportsThinking | supportsInterleavedThinking | promptCacheModel |
|---|---|---|---|---|---|
| `claude-opus-4-7`          | `CONTEXT_1M`   | `OUTPUT_128K` | `true` | `true`  | `'explicit'` |
| `claude-sonnet-4-6`        | `CONTEXT_1M`   | `OUTPUT_64K`  | `true` | `true`  | `'explicit'` |
| `claude-haiku-4-5-20251001`| `CONTEXT_200K` | `OUTPUT_64K`  | `true` | `false` | `'explicit'` |

Notes:
- **Opus 4.7 output is 128K, not 64K.** Anthropic docs give Opus 4.7/4.6 up to 128K output; Sonnet 4.6 and Haiku 4.5 stay at 64K.
- **Haiku 4.5 `supportsInterleavedThinking: false`.** The Extended Thinking docs list interleaving for Opus/Sonnet variants only. If a later Anthropic release confirms Haiku interleaving, flip this cell — it's a one-line data change with no code impact.
- The 1M window on Opus 4.7 / Sonnet 4.6 is the documented cap; Phase 1b will handle the beta-header wiring needed to actually request a context that large.

#### OpenAI (`src/core/providers/openaiAdapter.ts:310-313`)

Per OpenAI's current models page, the entire `gpt-5.4` family exposes reasoning controls natively — they are **not** non-thinking models.

| id | maxContextTokens | maxOutputTokens | supportsThinking | supportsInterleavedThinking | promptCacheModel |
|---|---|---|---|---|---|
| `gpt-5.4`      | `CONTEXT_1M`   | `OUTPUT_128K` | `true` | `false` | `'implicit'` |
| `gpt-5.4-mini` | `CONTEXT_400K` | `OUTPUT_128K` | `true` | `false` | `'implicit'` |
| `gpt-5.4-nano` | `CONTEXT_400K` | `OUTPUT_128K` | `true` | `false` | `'implicit'` |

Notes:
- `supportsInterleavedThinking: false` — OpenAI models expose reasoning as *persisted reasoning items*, not Anthropic-style between-tool interleaving. Phase 1c will translate Ultron's generic `thinkingBudget` into `reasoning_effort: "low"|"medium"|"high"` via a bucketed mapping; no interleaving-beta header is ever sent to OpenAI.
- `promptCacheModel: 'implicit'` — OpenAI does automatic prefix caching server-side; Ultron never sets a cache hint.
- The roadmap's "`o*` reasoning" bullet is satisfied by the existing catalog. No new `o*` entries are added in 1a; if Ultron later wants a reasoning-first model like `o4-mini`, that's a separate catalog addition.

#### MiniMax (`src/core/providers/minimaxAdapter.ts:14-16`)

| id | maxContextTokens | maxOutputTokens | supportsThinking | supportsInterleavedThinking | promptCacheModel |
|---|---|---|---|---|---|
| `MiniMax-M2.7` | `CONTEXT_256K` | `OUTPUT_16K` | `false` | `false` | `'implicit'` |

Notes:
- **`promptCacheModel: 'implicit'`, not `'none'`.** MiniMax documents automatic prompt caching on both its OpenAI-compatible and Anthropic-compatible surfaces; our adapter hits the OpenAI-compatible endpoint, so caching is on without any Ultron-side action.
- Context/output set conservatively. If MiniMax's model spec page gives different numbers for `MiniMax-M2.7`, adjust these two constants — it's a pure data fix caught by the verification hand-probe.

### Read API & validation (`src/core/providers/registry.ts`)

Add one read helper:

```ts
import type { CapabilitySheet } from './types.js'

export function resolveCapabilities(modelId: string): CapabilitySheet {
  const { entry } = resolveModel(modelId)
  return {
    maxContextTokens:            entry.maxContextTokens,
    maxOutputTokens:             entry.maxOutputTokens,
    supportsThinking:            entry.supportsThinking,
    supportsInterleavedThinking: entry.supportsInterleavedThinking,
    promptCacheModel:            entry.promptCacheModel,
  }
}
```

Throws `UnknownModelError` (via `resolveModel`) if the id isn't registered.

Add one module-load assertion:

```ts
import { assertCapabilitiesPopulated } from './validateCapabilities.js'
assertCapabilitiesPopulated(Object.values(ADAPTERS))
```

…so any future adapter that forgets a capability field trips at `import` time, not at first use.

### Validation helper (`src/core/providers/validateCapabilities.ts` — new file)

Extracted so it can be unit-tested against hand-crafted fake adapters without mutating the real `ADAPTERS` registry.

```ts
import type { ProviderAdapter } from './types.js'

const REQUIRED_CAPABILITY_FIELDS = [
  'maxContextTokens',
  'maxOutputTokens',
  'supportsThinking',
  'supportsInterleavedThinking',
  'promptCacheModel',
] as const

export function assertCapabilitiesPopulated(
  adapters: readonly ProviderAdapter[],
): void {
  for (const a of adapters) {
    for (const m of a.models) {
      const missing = REQUIRED_CAPABILITY_FIELDS.filter(
        k => m[k] === undefined,
      )
      if (missing.length > 0) {
        throw new Error(
          `Adapter "${a.id}" model "${m.id}" is missing capability ` +
          `fields: ${missing.join(', ')}`,
        )
      }
    }
  }
}
```

Error message includes **adapter id, model id, and every missing field** — checked by tests as three separate substrings.

### CLI default model flip (`src/cli.ts:28`)

```ts
const DEFAULT_MODEL       = 'claude-opus-4-7'   // was 'claude-sonnet-4-6'
const FAST_FALLBACK_MODEL = 'claude-sonnet-4-6' // new — not wired in 1a
```

Resolution order is **unchanged**: `--model` flag → `readUserConfig().lastModel` → `DEFAULT_MODEL`. `FAST_FALLBACK_MODEL` is a named constant only; later phases (error recovery, rate-limit degradation) can reference it without introducing a new string literal.

---

## File Map

| File | Responsibility | SDK imports? |
|------|---------------|--------------|
| `src/core/providers/types.ts` | Extend `ModelEntry`; export `CapabilitySheet` | No |
| `src/core/providers/capabilityMetadata.ts` | **New.** Pure constants (context windows, output caps) | No |
| `src/core/providers/validateCapabilities.ts` | **New.** `assertCapabilitiesPopulated()` helper | No |
| `src/core/providers/validateCapabilities.test.ts` | **New.** Unit tests for the validator | No |
| `src/core/providers/registry.ts` | Add `resolveCapabilities()`; load-time assert | No |
| `src/core/providers/anthropicAdapter.ts` | Populate 3 catalog entries | Yes (existing) |
| `src/core/providers/openaiAdapter.ts` | Populate 3 catalog entries | Yes (existing) |
| `src/core/providers/minimaxAdapter.ts` | Populate 1 catalog entry | No (existing — proxies to openaiAdapter) |
| `src/core/providers/registry.test.ts` | Add capability-metadata assertions | No |
| `src/cli.ts` | Flip `DEFAULT_MODEL`; add `FAST_FALLBACK_MODEL` | No |
| `docs/ultron_v2/phase1a-v2-design.md` | **New.** This doc | — |

---

## Downstream Consumers

- **Phase 1b** (cache hints) — reads `promptCacheModel` to decide whether to emit `cache_control` on static system-prompt parts (Anthropic only) or rely on implicit prefix caching (OpenAI, MiniMax).
- **Phase 1c** (thinking budget) — reads `supportsThinking` / `supportsInterleavedThinking` to decide whether `thinkingBudget` is forwarded, translated, or ignored-with-warning per-provider.
- **Phase 4d** (memory injection) — reads `maxContextTokens` to size the memory injection budget.
- **Phase 8a/8c** (compaction, attachment injector) — read `maxContextTokens - headroom` to trigger compaction and evict attachments.
- **Phase 7** (subagents) — may forward the parent's `CapabilitySheet` to sub-agents so each sub-agent loop picks consistent thinking/cache settings.

No Phase 1a consumer branches on `providerId`; they all read `CapabilitySheet`.

---

## Verification Criteria

### Typecheck (roadmap #1, static half)
1. `npm run typecheck` passes — adding the five required fields to `ModelEntry` forces every literal in the three adapter catalogs to set them, with no `?:` escape hatch.

### Runtime (roadmap #1, runtime half)
2. `assertCapabilitiesPopulated(Object.values(ADAPTERS))` runs at `registry.ts` load and does not throw.
3. `resolveCapabilities('claude-opus-4-7')` returns exactly:
   ```ts
   { maxContextTokens: 1_000_000, maxOutputTokens: 128_000,
     supportsThinking: true, supportsInterleavedThinking: true,
     promptCacheModel: 'explicit' }
   ```
4. `resolveCapabilities('gpt-5.4-mini')` returns `maxContextTokens: 400_000`, `supportsThinking: true`, `promptCacheModel: 'implicit'`.
5. `resolveCapabilities('MiniMax-M2.7')` returns `supportsThinking: false`, `promptCacheModel: 'implicit'`.
6. `resolveCapabilities('not-a-model')` throws `UnknownModelError`.
7. Every entry in `allModels()` has all five capability fields defined (iterate-and-assert test).

### Validator helper (unit-tested in isolation)
8. `assertCapabilitiesPopulated([goodAdapter])` does not throw.
9. `assertCapabilitiesPopulated([adapterWithOneMissingField])` throws; error message contains the adapter id, the model id, and the name of the missing field (three substring checks).
10. `assertCapabilitiesPopulated([adapterWithMultipleMissing])` throws; error message lists **all** missing field names in a single message.

### No provider-identity branching (roadmap #2)
11. ``grep -RnE "providerId\s*===\s*['\"]" src --include='*.ts' | grep -v 'providers/'`` returns nothing. No non-provider file infers capabilities from provider id. (Baseline check — already passes before 1a per exploration.)

### Adding a provider is one file + one line (roadmap #3)
12. Hypothetical 4th adapter exercise: the diff to add one is exactly (a) one new `someAdapter.ts` exporting a `ProviderAdapter`, plus (b) one key/value line added to `ADAPTERS` in `registry.ts`. No other file needs editing. (Confirmed by code inspection at design-doc time; will be re-confirmed against the final Phase 1a diff.)

### No regressions
13. `npm run test` — existing tests (`QueryEngine.test.ts`, `registry.test.ts`, `modelMenu.test.ts`, `userConfig.test.ts`) pass untouched; they reference `ModelEntry` only by `id` / `provider` / `label`, so adding fields doesn't break them.

### CLI behavior
14. `node dist/cli.js` with no flags and no persisted `~/.ultron/config.json`: resolves to `claude-opus-4-7`.
15. `node dist/cli.js --model claude-sonnet-4-6`: resolves to `claude-sonnet-4-6` (explicit flag still wins).
16. `FAST_FALLBACK_MODEL` is exported but never imported in 1a — grep confirms zero call sites (it's a forward-declaration only).

---

## Out of Scope (Hard Gate)

- **No** `cache_control` header emission, even though Anthropic entries declare `'explicit'`. That's Phase 1b.
- **No** `thinking_budget` / `reasoning_effort` translation in adapters, even though three entries declare `supportsThinking: true`. That's Phase 1c.
- **No** use of `maxContextTokens` in memory injection, compaction, or attachment budgeting. Those are Phases 4d, 8a, and 8c respectively.
- **No** `/thinking` CLI toggle or per-turn UX.
- **No** new `o*`-series OpenAI entries. The existing `gpt-5.4` family already exposes reasoning; adding reasoning-first models is a separate catalog change.

---

## Risks & Unknowns

- **MiniMax-M2.7 exact context/output caps.** Set conservatively to `CONTEXT_256K` / `OUTPUT_16K`. If MiniMax's model spec page gives different numbers, adjust the two constants. Pure data fix; no plan shape change.
- **Sonnet 4.6 1M context assumption.** Anthropic's docs list Sonnet 4.6 alongside Opus 4.7/4.6 as 1M-capable. If the docs were misread at design time, flip to `CONTEXT_200K` — again a one-cell data fix.

Both unknowns are design-doc-review-time catches, not post-ship liabilities: the typechecker and runtime assertion still pass either way, and no downstream phase is broken by a conservative context-window value.
