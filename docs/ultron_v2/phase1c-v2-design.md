# Phase 1c Design: Thinking/Reasoning Budget as a Generic Runtime Knob

## Overview

Phase 1c is the third runtime-substrate piece in Pillar 1. Phase 1a made `supportsThinking` and `supportsInterleavedThinking` first-class data on every `ModelEntry`; Phase 1b made the system prompt structurally cache-aware. Phase 1c introduces a single provider-agnostic option, `thinkingBudget` (tokens), plus the orthogonal `interleavedThinking` flag, that flows from caller → query loop → adapter, where each adapter translates it into its native shape:

- **Anthropic** — body field `thinking: { type: 'enabled', budget_tokens: N }`; when interleaved thinking is requested *and* supported, the request switches to `client.beta.messages.stream(...)` with `betas: ['interleaved-thinking-2025-05-14']`.
- **OpenAI** — bucketed mapping into `reasoning_effort: 'low' | 'medium' | 'high'` for any model whose `supportsThinking: true`.
- **MiniMax** — silent no-op; the shared OpenAI factory handles it via the same warn-and-drop path.

Today no caller can ask for thinking output: Opus 4.7's catalog entry advertises `supportsThinking: true` (Phase 1a) but the adapter never emits a `thinking` block. After 1c the CLI defaults Opus 4.7 to a 4096-token thinking budget, the SDK exposes both knobs on `QueryEngineConfig` plus per-submission overrides on `submitPrompt()`, and subagents inherit the parent's resolved values.

Capability gating is uniform: a knob set on a model that lacks the corresponding capability is dropped with **exactly one stderr warning per (model, knob) per process**, via a tiny `warnOnce` helper.

Per the roadmap, the `/thinking` UX toggle is **out of scope for 1c**; only the underlying knob, a fixed CLI default, and engine-side input normalization ship.

---

## Architecture

```
┌─────────────────────┐
│ src/cli.ts          │  DEFAULT_THINKING_BUDGET = 4096 (constant only)
│                     │  passed into QueryEngine constructor
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ QueryEngineConfig   │  + thinkingBudget?: number
│                     │  + interleavedThinking?: boolean
│ submitPrompt(p,opts)│  resolves per-call opts → config defaults → undefined,
│                     │  normalizes once, threads into QueryParams + subagent fork
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ src/core/query.ts   │  builds CallModelOptions per stream:
│ streamModelResponse │    { maxOutputTokens, thinkingBudget,
│                     │      interleavedThinking }
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ CallModelFn(opts)   │  per-adapter translation; capabilities baked in at
│                     │  createCallModel construction (passed by QueryEngine)
└──────────┬──────────┘
   ┌───────┼────────────────┬────────────────┐
   ▼       ▼                ▼                ▼
Anthropic  OpenAI            MiniMax        warnOnce.ts
thinking:  reasoning_effort  (no-op via     emits exactly one
{enabled,  via bucket map    shared OpenAI  stderr line per
budget_N}  + warn on non-    factory; warns (model, knob) key
+ optional reasoning models  because        per process
beta.stream                  supportsThinking
branch                       = false
```

Data flow: the engine resolves the effective budget per submission, runs it through `normalizeThinkingBudget()` once, then hands it to both the main `query()` loop and the `forkSubagent` factory. Adapters trust whatever they receive: there is no per-adapter input validation — they only translate or warn-and-drop based on the capability sheet baked in at construction.

---

## Core Types & Interfaces

### `CallModelOptions` (`src/core/queryDeps.ts`)

```ts
export type CallModelOptions = {
  readonly maxOutputTokens?: number
  readonly thinkingBudget?: number      // tokens; 0 / undefined = no thinking
  readonly interleavedThinking?: boolean
}
```

### `CreateCallModelOptions` (`src/core/providers/types.ts`)

Add a required `capabilities` field so each adapter can gate translation without re-resolving from its own catalog. This also retires the local `MODELS.find(m => m.id === model)` lookup that Phase 1b added inside `anthropicAdapter.ts:294` to read `promptCacheModel`.

```ts
export type CreateCallModelOptions = {
  readonly apiKey: string
  readonly model: string
  readonly baseUrl?: string
  readonly tools?: readonly ApiToolDefinition[]
  readonly capabilities: CapabilitySheet     // NEW (required)
}
```

### `QueryParams` (`src/core/queryTypes.ts`)

```ts
export type QueryParams = {
  // ...existing fields...
  readonly thinkingBudget?: number
  readonly interleavedThinking?: boolean
}
```

### `SubagentOptions` (`src/agents/runAgent.ts`)

```ts
export type SubagentOptions = {
  // ...existing fields...
  readonly parentThinkingBudget?: number
  readonly parentInterleavedThinking?: boolean
}
```

`createForkSubagent` forwards both into the inner `query({...})` call at line 142. Per-fork override is **not** in 1c — subagent-level UX is a Phase 7 concern.

### `QueryEngineConfig` + `submitPrompt` (`src/sdk/QueryEngine.ts`)

```ts
export type QueryEngineConfig = {
  // ...existing fields...
  readonly thinkingBudget?: number
  readonly interleavedThinking?: boolean
}

class QueryEngine {
  async *submitPrompt(
    prompt: string,
    opts?: { thinkingBudget?: number; interleavedThinking?: boolean },
  ): AsyncGenerator<QueryEvent, Terminal>
}
```

Resolution order per submission: explicit `opts` → `config` defaults → undefined. The resolved values pass through `normalizeThinkingBudget()` exactly once, and the normalized result feeds both the main loop and the `forkSubagent` opts.

### Unchanged

- `ProviderId`, `ProviderAdapter`, `CapabilitySheet`, `ModelEntry`, `QueryEvent`, `RawStreamEvent`, `ApiResponseMeta`, `Terminal` — all untouched.
- `MissingApiKeyError`, `UnknownModelError` — untouched.

---

## Implementation Details

### Input normalization (`src/core/providers/thinkingNormalize.ts` — new)

Anthropic's SDK enforces `budget_tokens >= 1024` (per `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` near `ThinkingConfigEnabled`); a user passing `thinkingBudget: 1` would 4xx at the API. OpenAI's `reasoning_effort` has no minimum but tiny budgets bucket meaninglessly. Normalize once at the **engine boundary**, not per-adapter, so adapters always receive `undefined` or a valid number.

```ts
import type { CapabilitySheet } from './types.js'
import { warnOnce } from './warnOnce.js'

export const ANTHROPIC_THINKING_MIN = 1024

export function normalizeThinkingBudget(
  raw: number | undefined,
  modelId: string,
  capabilities: CapabilitySheet,
): number | undefined {
  if (raw === undefined || raw === 0) return undefined
  if (!Number.isFinite(raw) || raw < 0) {
    warnOnce(`normalize:${modelId}`,
      `thinkingBudget=${raw} is invalid; ignoring.`)
    return undefined
  }
  if (!capabilities.supportsThinking) {
    // Adapter still warns at request time with provider-specific phrasing;
    // here we just pass through and let the adapter handle the no-op.
    return raw
  }
  // Currently-shipped Anthropic models all advertise promptCacheModel: 'explicit'.
  // The simplest rule that catches the SDK floor is "round up to 1024 with a
  // one-time warn" for any explicit-thinking provider.
  if (raw < ANTHROPIC_THINKING_MIN && capabilities.promptCacheModel === 'explicit') {
    warnOnce(`normalize:${modelId}`,
      `thinkingBudget=${raw} below Anthropic minimum (${ANTHROPIC_THINKING_MIN}); raising.`)
    return ANTHROPIC_THINKING_MIN
  }
  return raw
}
```

Called from `QueryEngine.submitPrompt` exactly once per submission with the resolved (per-call → config-default) budget.

### `warnOnce` helper (`src/core/providers/warnOnce.ts` — new)

```ts
const warned = new Set<string>()

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  process.stderr.write(`[ultron] ${message}\n`)
}

/** Test-only: clear the dedup set so warning tests aren't order-dependent. */
export function __resetWarnOnceForTesting(): void {
  warned.clear()
}
```

Key shape: `'thinking:<modelId>'`, `'interleaved:<modelId>'`, `'normalize:<modelId>'` so each (model, knob) pair warns exactly once per process. The reset hook is only called from tests in `beforeEach`; production code never imports it.

### Anthropic adapter (`src/core/providers/anthropicAdapter.ts`)

At construction:
- Replace local `const entry = MODELS.find(m => m.id === model)` (line 294) with reading from `opts.capabilities`. Both `promptCacheModel` (1b) and the new thinking checks read from the same source.

In `callModel`:
- If `callOpts.thinkingBudget && capabilities.supportsThinking`:
  - Add request body field `thinking: { type: 'enabled', budget_tokens: callOpts.thinkingBudget }`. The value is already ≥1024 (normalized engine-side).
  - Bump `max_tokens` to `Math.max(callOpts.maxOutputTokens ?? 16_384, callOpts.thinkingBudget + 1024)` — Anthropic requires `max_tokens > thinking.budget_tokens`.
- If `callOpts.thinkingBudget && !capabilities.supportsThinking`: `warnOnce('thinking:' + model, ...)`, drop.
- **Stream-factory selection.** When `callOpts.interleavedThinking && capabilities.supportsInterleavedThinking` is true, route the request through `client.beta.messages.stream(...)` with `betas: ['interleaved-thinking-2025-05-14']`. The non-beta `client.messages` API (current path at `anthropicAdapter.ts:305`) **does not** accept the `betas` field — confirmed against the installed `@anthropic-ai/sdk`'s `resources/messages/messages.d.ts` (no `betas`) vs. `resources/beta/messages/messages.d.ts:1105` (has `betas`). A small `pickStream(opts) → typeof client.messages.stream | typeof client.beta.messages.stream` helper makes the branch explicit. Both factories yield SSE events with the same wire shape, so `StreamAccumulator` is unaffected.
- If `callOpts.interleavedThinking && !capabilities.supportsInterleavedThinking`: `warnOnce('interleaved:' + model, ...)`, stay on the non-beta path.

### OpenAI shared factory (`src/core/providers/openaiAdapter.ts`)

Receive `capabilities` via `opts`. Bucket constants in the same file:

```ts
const REASONING_LOW_MAX     = 4096
const REASONING_MEDIUM_MAX  = 16_384

function bucketReasoningEffort(budget: number): 'low' | 'medium' | 'high' {
  if (budget < REASONING_LOW_MAX)    return 'low'
  if (budget < REASONING_MEDIUM_MAX) return 'medium'
  return 'high'
}
```

In `callModel`:
- If `callOpts.thinkingBudget && capabilities.supportsThinking`: add `reasoning_effort: bucketReasoningEffort(N)` to the chat-completions request.
- If `callOpts.thinkingBudget && !capabilities.supportsThinking`: `warnOnce('thinking:' + model, ...)`, drop. (This is the path MiniMax takes — same shared factory.)
- If `callOpts.interleavedThinking`: always `warnOnce('interleaved:' + model, ...)`, drop. (No OpenAI/MiniMax model carries `supportsInterleavedThinking: true` today; the helper handles the future case if one ever does.)

### MiniMax adapter (`src/core/providers/minimaxAdapter.ts`)

Zero source change. The shared OpenAI factory already gets `capabilities` via opts; MiniMax's catalog has `supportsThinking: false`, so the warn-and-drop path triggers automatically.

### `QueryEngine` wiring (`src/sdk/QueryEngine.ts`)

`resolveCallModel` (line 163) already calls `resolveModel(modelId)`. Widen the destructure:

```ts
const { adapter, entry } = resolveModel(modelId)
const capabilities: CapabilitySheet = {
  maxContextTokens:            entry.maxContextTokens,
  maxOutputTokens:             entry.maxOutputTokens,
  supportsThinking:            entry.supportsThinking,
  supportsInterleavedThinking: entry.supportsInterleavedThinking,
  promptCacheModel:            entry.promptCacheModel,
}
return adapter.createCallModel({ apiKey, model: modelId, baseUrl, tools, capabilities })
```

This avoids a second `resolveCapabilities()` call — the registry helper exists for callers that don't already have `entry`.

`submitPrompt` becomes:

```ts
async *submitPrompt(
  prompt: string,
  opts?: { thinkingBudget?: number; interleavedThinking?: boolean },
): AsyncGenerator<QueryEvent, Terminal> {
  // ...existing body...

  const { entry } = resolveModel(this._model)
  const capSheet = /* same derivation as above */
  const rawBudget = opts?.thinkingBudget ?? this.config.thinkingBudget
  const thinkingBudget = normalizeThinkingBudget(rawBudget, this._model, capSheet)
  const interleavedThinking = opts?.interleavedThinking ?? this.config.interleavedThinking

  const forkSubagent = createForkSubagent({
    // ...existing fields...
    parentThinkingBudget: thinkingBudget,
    parentInterleavedThinking: interleavedThinking,
  })

  const gen = query({
    messages: allMessages,
    systemPromptParts,
    deps,
    signal: this.currentAbort.signal,
    maxTurns: this.config.maxTurns,
    thinkingBudget,
    interleavedThinking,
  })

  // ...rest unchanged...
}
```

### `query.ts` wiring

In `streamModelResponse` (line ~371), build options from params:

```ts
const stream = deps.callModel(
  apiMessages,
  systemPromptParts,
  {
    maxOutputTokens: state.maxOutputTokensOverride,
    thinkingBudget: params.thinkingBudget,
    interleavedThinking: params.interleavedThinking,
  },
  signal,
)
```

`params` is already in scope (`query()` closes over it).

### `runAgent.ts` wiring

Inside `createForkSubagent` (line 142), forward the two new fields into the inner `query()` call:

```ts
const gen = query({
  messages,
  systemPromptParts,
  deps,
  signal: abortController.signal,
  maxTurns,
  thinkingBudget: opts.parentThinkingBudget,
  interleavedThinking: opts.parentInterleavedThinking,
})
```

### CLI default (`src/cli.ts`)

```ts
const DEFAULT_THINKING_BUDGET = 4096   // applies whenever the resolved model
                                       // has supportsThinking
```

Pass `thinkingBudget: DEFAULT_THINKING_BUDGET` into the `QueryEngine` constructor. No `/thinking` toggle, no per-model override.

**Behavior on `/model` switch (deliberate).** `setModel()` swaps the active model without touching `config.thinkingBudget`. Consequences:
- Switching to another thinking-capable model: budget carries over silently — correct.
- Switching to a non-thinking model (e.g., `MiniMax-M2.7`): the budget keeps flowing in; the adapter triggers `warnOnce` exactly once per (model, knob) per process and drops it. Subsequent submissions are silent.
- Switching back: thinking is automatically re-enabled.

This is the right layering for 1c — config is the source of truth, the engine doesn't second-guess. Model-aware effective-budget resolution is `/thinking` UX territory, explicitly out of scope.

---

## File Map

| File | Responsibility | Change type |
|------|---------------|-------------|
| `docs/ultron_v2/phase1c-v2-design.md` | This doc | **New** |
| `src/core/queryDeps.ts` | Extend `CallModelOptions` | Modified |
| `src/core/queryTypes.ts` | Extend `QueryParams` | Modified |
| `src/core/query.ts` | Build `CallModelOptions` from params in `streamModelResponse` | Modified |
| `src/core/providers/types.ts` | Require `capabilities` on `CreateCallModelOptions` | Modified |
| `src/core/providers/warnOnce.ts` | Per-process dedup helper + test reset | **New** |
| `src/core/providers/warnOnce.test.ts` | One-shot semantics; uses `__resetWarnOnceForTesting()` in `beforeEach` | **New** |
| `src/core/providers/thinkingNormalize.ts` | `normalizeThinkingBudget()` — engine-boundary input validation | **New** |
| `src/core/providers/thinkingNormalize.test.ts` | Negative / zero / sub-1024 / valid cases per capability shape | **New** |
| `src/core/providers/anthropicAdapter.ts` | Read `capabilities` from opts; emit `thinking` body; switch to `client.beta.messages.stream` when interleaving requested + capable; retire local `MODELS.find` for `promptCacheModel` | Modified |
| `src/core/providers/openaiAdapter.ts` | Read `capabilities` from opts; bucketed mapping → `reasoning_effort`; warnOnce paths | Modified |
| `src/core/providers/minimaxAdapter.ts` | No source change (delegates) | Unchanged |
| `src/sdk/QueryEngine.ts` | Add config knobs; widen `submitPrompt(prompt, opts?)`; `resolveCallModel` derives `CapabilitySheet` inline; normalize once; thread into `QueryParams` + `forkSubagent` | Modified |
| `src/agents/runAgent.ts` | `SubagentOptions` gets `parentThinkingBudget` / `parentInterleavedThinking`; forwarded into the inner `query()` call at line 142 | Modified |
| `src/agents/runAgent.test.ts` | Assert subagent inherits parent's thinking knobs | Modified |
| `src/cli.ts` | Add `DEFAULT_THINKING_BUDGET` constant; pass through to `QueryEngine` | Modified |
| `src/core/providers/anthropicAdapter.test.ts` | New cases for thinking body + beta-stream branch + warn paths | Modified |
| `src/core/providers/openaiAdapter.test.ts` | Bucket boundary cases + warn paths | Modified |
| `src/sdk/QueryEngine.test.ts` | `submitPrompt(prompt, opts)` overrides config defaults | Modified |

---

## Downstream Consumers

- **Phase 7 (subagents)** — fork-time UX may want per-fork thinking overrides; the propagation seam (`SubagentOptions.parentThinkingBudget` / `parentInterleavedThinking`) is already in place.
- **Phase 8a (hierarchical summarizer)** — summarization currently runs without a thinking budget (cheap, deterministic); 1c does not change that. If 8a wants summarization-time thinking it'll pass its own value into `createCompactFn`.
- **Future `/thinking` UX** — the engine config + per-submission opt path is the same surface a `/thinking` slash command would target. Effective-budget recomputation on `/model` switch is the natural extension.

No 1c consumer branches on `providerId`; capability gating is uniform via `CapabilitySheet`.

---

## Verification Criteria

### Typecheck (substrate half)

1. `npm run typecheck` passes. The `CallModelOptions` extension, `CreateCallModelOptions.capabilities` requirement, `QueryParams` widening, and `SubagentOptions` extension force every call site through the rename — any missed site is a compile error.

### Anthropic adapter (`anthropicAdapter.test.ts`)

2. **Thinking body.** Opus 4.7 call with `thinkingBudget: 4096` records a request whose body has `thinking: { type: 'enabled', budget_tokens: 4096 }` and `max_tokens >= 5120`. Stream surfaces at least one `thinking_delta` event (existing accumulator path).
3. **Branch selection.** With `interleavedThinking: true` on Opus 4.7, the request goes through `client.beta.messages.stream(...)` (mock-spy) and carries `betas: ['interleaved-thinking-2025-05-14']`. With `interleavedThinking: false` (or undefined), the request stays on `client.messages.stream(...)` — negative test asserts the beta path is **not** invoked.
4. **No-thinking baseline.** Anthropic call without `thinkingBudget` produces a request body byte-identical to pre-1c (no `thinking` field).
5. **Capability gating + warn-once.** Haiku 4.5 (`supportsInterleavedThinking: false`) with `interleavedThinking: true`: stays on the non-beta stream, produces exactly one warning; thinking body still emitted (orthogonal `supportsThinking: true`). Two consecutive Haiku calls produce no second warning. Test calls `__resetWarnOnceForTesting()` in `beforeEach`.

### OpenAI adapter (`openaiAdapter.test.ts`)

6. **Bucketed mapping.** `gpt-5.4` with `thinkingBudget: 2_000` → `reasoning_effort: 'low'`; `8_000` → `'medium'`; `20_000` → `'high'`. Boundary cases at 4095/4096/16383/16384 verify the `<` thresholds.
7. **MiniMax no-op + warn.** `MiniMax-M2.7` with `thinkingBudget: 4096` produces a request **byte-identical** to one without (no `reasoning_effort`, no body change), and exactly one `[ultron] ... unsupported thinking budget on MiniMax-M2.7` line on stderr.

### Normalization (`thinkingNormalize.test.ts`)

8. `normalizeThinkingBudget(0, …)` → `undefined`.
9. `normalizeThinkingBudget(-5, opus)` → `undefined` + one warn.
10. `normalizeThinkingBudget(NaN, opus)` → `undefined` + one warn.
11. `normalizeThinkingBudget(500, opus)` → `1024` + one warn.
12. `normalizeThinkingBudget(4096, opus)` → `4096` (no warn).
13. `normalizeThinkingBudget(500, gpt-5.4)` → `500` (no Anthropic floor on OpenAI-shaped capability).
14. `normalizeThinkingBudget(4096, minimax)` → `4096` (no thinking, but pass-through; adapter handles the warn).

### QueryEngine + runtime threading

15. **Per-submission override.** `engine.submitPrompt('hi', { thinkingBudget: 8192 })` wins over the engine-config default; `engine.submitPrompt('hi', { thinkingBudget: 0 })` disables thinking for that single call (asserted via mock `callModel` capturing `CallModelOptions`).
16. **Subagent inheritance.** A subagent forked under a parent with `thinkingBudget: 4096` receives the same value in its own `query()` call (asserted in `runAgent.test.ts` via the inner-`query` mock).

### CLI default

17. `node dist/cli.js` with no flags + `claude-opus-4-7` → engine submits with `thinkingBudget: 4096`. Switching to `MiniMax-M2.7` via `/model` produces exactly one warning on the next submission, no crash.

### Surface invariants

18. `grep -Rn "from '../registry" src/core/providers/*adapter*.ts` returns nothing — adapters get capabilities via opts (preserves the no-cycle rule from Phase 1b).
19. `grep -Rn "MODELS.find" src/core/providers/anthropicAdapter.ts` returns nothing — the local catalog lookup added in 1b is retired.

### No regressions

20. `npm run test` — all pre-existing tests pass.

### Integration (opt-in, env-gated)

21. With a real `ANTHROPIC_API_KEY`, an Opus 4.7 call with `thinkingBudget: 1024` returns a stream whose `usage` reports non-zero thinking tokens.

---

## Out of Scope (Hard Gate)

- **No** `/thinking` CLI subcommand or per-turn UX toggle.
- **No** display of thinking output between tools (interleaved-thinking rendering is event-renderer territory, deferred).
- **No** per-model thinking-default field on `ModelEntry` — defaults are *policy*, not capability. The CLI default is a single constant; SDK callers pass their own. (If a per-model default ever lands it's a clean additive change.)
- **No** model-aware effective-budget recomputation on `/model` switch. The fixed-session-default behavior is documented above; per-model auto-disable is a `/thinking` UX feature.
- **No** OpenAI `o*`-series catalog additions; the `gpt-5.4` family already advertises `supportsThinking: true` and exercises the bucketed path.
- **No** changes to `compact.ts` thinking semantics — summarization runs without a thinking budget; that's correct (cheap, deterministic).
- **No** per-fork subagent thinking overrides; subagent-level UX is Phase 7.

---

## Risks & Unknowns

- **Anthropic SDK beta vs non-beta paths.** Resolved during planning: the installed SDK's non-beta `client.messages.stream` does **not** accept `betas`; only `client.beta.messages.stream` does. The plan branches on this. Residual risk: the two stream factories have subtly different request-param types in TypeScript (`MessageCreateParamsStreaming` vs the beta equivalent) — request construction may need a small typed-pass-through helper to avoid duplicating fields. Failure mode is a compile error, not silent.
- **`max_tokens >= thinking_budget + ε`.** The SDK enforces `max_tokens > budget_tokens` plus "sufficient for non-thinking output"; +1024 is a safe margin per docs but may need bumping if a small-output prompt 4xxs. Easy data fix.
- **OpenAI `reasoning_effort: 'minimal'`.** Newer OpenAI SDK versions add a fourth bucket. Phase 1c stays with the three-bucket roadmap mapping; widening is a one-line bucket-table edit later.
- **`warnOnce` lifetime.** Module-level `Set<string>` survives across vitest cases in the same module; the `__resetWarnOnceForTesting()` hook keeps tests order-independent. No production code path imports the reset.
- **Subagent `parentThinkingBudget` already-normalized.** The engine normalizes once before populating fork opts, so subagents skip normalization. If a future caller bypasses the engine and constructs `SubagentOptions` directly, raw values would flow through — acceptable since `runAgent.ts` is internal API; the engine remains the only public path.
