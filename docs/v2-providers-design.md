# Multi-Provider Registry — Design

## Context

Before this change, provider selection was hard-coded in three places:

- `src/cli.ts` — arg parsing forked on `--provider` to pick a default model and API-key env var.
- `src/sdk/QueryEngine.ts` constructor — ternary between `createAnthropicCallModel` and `createOpenAICallModel`.
- `src/sdk/QueryEngine.ts` `setModel()` — the same ternary, which assumed the provider never changes.

The `/model` picker (formerly `src/ui/modelCatalog.ts`) only showed the *current* provider's list, so cross-provider switches (Anthropic ↔ OpenAI) required a process restart with `--provider openai`. Adding Gemini or Minimax would have meant touching all three ternaries plus a picker branch.

The registry refactor resolves this by:

- letting new providers drop in as a single file under `src/core/providers/`,
- presenting a **unified model catalog** so `/model` shows every model from every provider in one grouped list (Cursor-style),
- re-resolving the API key per-provider on every model switch (so OpenAI ↔ Anthropic works live), and
- persisting the last-picked model to `~/.ultron/config.json` so it sticks across restarts.

Scope: refactor-only. No new providers shipped in this pass — Gemini/Minimax become ~1 new file each afterward.

## Architecture

### Provider contract — `src/core/providers/types.ts`

```ts
export type ProviderAdapter = {
  readonly id: ProviderId          // 'anthropic' | 'openai' | ...
  readonly displayName: string     // 'Anthropic' — group header in /model picker
  readonly envKeyName: string      // 'ANTHROPIC_API_KEY'
  readonly models: readonly ModelEntry[]
  readonly createCallModel: (opts: CreateCallModelOptions) => CallModelFn
}
```

`createCallModel` takes an options object (not positional args). That's the seam where new providers (Gemini, Minimax, whatever) plug in without touching any other file.

### Registry — `src/core/providers/registry.ts`

```ts
const ADAPTERS = { anthropic: anthropicAdapter, openai: openaiAdapter }

resolveModel(modelId): { adapter, entry }   // throws UnknownModelError
getAdapter(providerId): ProviderAdapter      // throws on unknown id
allModels(): readonly ModelEntry[]           // flat, for the picker
listProviders(): readonly ProviderAdapter[]  // ordered
```

Adding a provider = 1 new adapter file + 1 line in `ADAPTERS`.

### QueryEngine wiring — `src/sdk/QueryEngine.ts`

The old ternary disappears behind a private helper:

```ts
private resolveCallModel(modelId, toolDefs): CallModelFn {
  const { adapter } = resolveModel(modelId)
  const apiKey = process.env[adapter.envKeyName] ?? this.config.apiKey
  if (!apiKey) throw new MissingApiKeyError(adapter.envKeyName)
  return adapter.createCallModel({ apiKey, model: modelId, baseUrl, tools })
}
```

The precedence is **env-first, then config.apiKey fallback**. That's what makes cross-provider switching work: when you start with `ANTHROPIC_API_KEY` set and later `/model` into GPT-5.4, the helper pulls `OPENAI_API_KEY` from env rather than trying to reuse the Anthropic key.

`setModel()` now re-runs `resolveCallModel()`, so it supports cross-provider swaps natively. The "cannot switch while running" guard and `compactCallModel` lockstep-update are preserved.

A new `currentProvider` getter returns `resolveModel(this._model).adapter.id` for the CLI.

### `/model` picker — `src/ui/modelMenu.ts`

Grouped, single-list view:

```
─── Select model ───  ↑/↓ navigate · Enter confirm · Esc cancel

  Anthropic
    > Claude Opus 4.7       — Highest capability
      Claude Sonnet 4.6 (current) — Balanced
      Claude Haiku 4.5       — Fastest, cheapest
  OpenAI
      GPT-5.4                — Highest capability
      GPT-5.4 Mini           — Balanced
      GPT-5.4 Nano           — Fastest, cheapest
```

Group headers are non-selectable; the cursor is backed by a `selectable: number[]` array of row indices, so arrow navigation skips them automatically. Return value is still just the selected model id (provider is implicit).

### CLI — `src/cli.ts`

- Dropped the `--provider` flag and its forking logic.
- Model resolution order: `--model` flag → `readUserConfig().lastModel` → `claude-sonnet-4-6`.
- Startup validates `process.env[adapter.envKeyName]` — prints a clean `Missing ${envVar}. Set the env var and retry.` and `exit 1` if absent.
- `/model` handler calls `writeUserConfig({ lastModel: choice })` after a successful `setModel` — persistence lives in the CLI, not the engine (keeps the engine I/O-free for tests).

### Persistence — `src/config/userConfig.ts`

`~/.ultron/config.json` with `{ lastModel?: string }`. `readUserConfig` returns `{}` on missing/corrupt files (one-line stderr warn on corrupt). `writeUserConfig` uses `mkdir -p` + tmp-file + atomic rename. Never throws — silently warns on failure.

A `__setConfigPathForTest` export lets tests redirect the path.

## File map

| File | Action |
|------|--------|
| `src/core/providers/types.ts` | **new** |
| `src/core/providers/registry.ts` | **new** |
| `src/core/providers/anthropicAdapter.ts` | **moved** from `src/core/apiAdapter.ts`; exports `ProviderAdapter` |
| `src/core/providers/openaiAdapter.ts` | **moved** from `src/core/openaiAdapter.ts`; exports `ProviderAdapter` |
| `src/ui/modelCatalog.ts` | **deleted** — replaced by adapter `.models` |
| `src/ui/modelMenu.ts` | **rewritten** — unified grouped list, skip-headers arrow loop |
| `src/sdk/QueryEngine.ts` | **edited** — registry-based `resolveCallModel`, `currentProvider` getter, dropped `provider` config field |
| `src/cli.ts` | **edited** — dropped `--provider`, wired userConfig persistence, startup env-key check |
| `src/config/userConfig.ts` | **new** |
| `CLAUDE.md` | **edited** — SDK-isolation line points at new paths; registry mentioned |

Tests added:

- `src/core/providers/registry.test.ts` — resolve/allModels/listProviders happy paths + unknown-model/unknown-provider errors.
- `src/config/userConfig.test.ts` — missing file, corrupt JSON, round-trip, merge-preserves-keys, parent dir creation, atomic rename.
- `src/sdk/QueryEngine.test.ts` — cross-provider `setModel`, unknown-model rejection, `MissingApiKeyError` when neither config nor env supplies a key.
- `src/ui/modelMenu.test.ts` — updated to the new registry-backed API; added a navigation-skips-headers case.

## Invariants preserved

- Every `tool_use` still has a matching `tool_result` (unchanged; orthogonal to this refactor).
- `normalizeMessages()` still runs before every API call (unchanged).
- `StreamAccumulator` still lives at the Anthropic-shaped wire format — every adapter produces `RawStreamEvent`s conforming to that shape, so the core loop stays provider-agnostic.
- Anthropic SDK is still isolated to a single file (`providers/anthropicAdapter.ts`). OpenAI SDK likewise.

## Deferred (explicitly out of scope)

- Gemini / Minimax adapters — each is one new file + one line in `ADAPTERS`.
- Per-provider rate-limit / streaming-backoff tuning.
- Status-line display of current provider.
- Migrating API-key storage out of env (e.g. OS keychain).
