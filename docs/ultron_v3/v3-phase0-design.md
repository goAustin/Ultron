# v3 Phase 0 Design: Scope and Settings

## Status

Pre-implementation. Approved plan: `~/.claude/plans/now-make-a-plan-shimmering-parasol.md`. Roadmap: `docs/ultron_v3/v3-computer-use-plan.md` (Phase 0 deliverables, lines 501–521).

## Context

`docs/ultron_v3/v3-computer-use-plan.md` is the v3 roadmap. v3 is *only* about Computer-Use — the ability to operate visual UIs when no API exists. Phase 0 is the substrate every later phase rests on: declare the v3 scope, lock down the `computerUse` settings schema, and prove that v2 boot is unaffected when the feature is disabled.

Later phases (1: image attachment substrate, 2: Playwright session, 3: tool surface, 4: policy/safety, 4b: DOM-first action path, 5: prompting, 6: eval, 7: docs) all assume Phase 0 has shipped. Without it, Phase 3 has no settings field to gate `registry.register(ComputerStartTool)`, and Phase 1's image substrate has no way to know whether the user opted in.

Phase 0 acceptance is small but load-bearing:

1. Invalid `computerUse` settings warn and fall back to defaults — never throw at startup.
2. Computer-Use tools are absent unless explicitly enabled (forward-looking; tools don't exist until Phase 3, but the gating contract is fixed now).
3. No runtime behavior change when `computerUse.enabled` is `false`.

## Goals

1. `SettingsConfig` carries an optional `computerUse?` block whose shape matches the v3 plan's example (`docs/ultron_v3/v3-computer-use-plan.md:470–491`) and whose merge semantics mirror `shellSandbox` exactly.
2. A pure `validateComputerUseSettings(raw: unknown): ComputerUseSettings` returns a fully-defaulted, validated settings object — never throws, warns once per invalid leaf to stderr, drops bad list entries individually.
3. The validator runs once at `QueryEngine` construction so invalid settings warn at startup. Phase 0 discards the result; Phase 3 will store it.
4. The disabled-state contract is locked in writing so Phase 3 inherits it without re-litigating: tools are not registered when `computerUse.enabled` is `false`, and stray callers surface the existing `'tool_not_found'` `ToolErrorKind`. No new error class. No new `ToolErrorKind` value.

## Non-goals

- No `ComputerUseDisabledError` (replaces the v3 plan line at `docs/ultron_v3/v3-computer-use-plan.md:508` — see "Disabled-state contract" below).
- No `'feature_disabled'` `ToolErrorKind` value.
- No AppState field for `computerUse` (Phase 3 owns this — the validator runs at boot but the result is discarded in Phase 0).
- No tool-registry change, no Computer-Use tool stubs.
- No `src/core/computer/` directory (reserved for Phase 2: `types.ts`, `coordinates.ts`, `policy.ts`, etc.).
- No Playwright dependency (Phase 2).
- No image-attachment substrate (Phase 1).
- No system-prompt changes (Phase 5).
- No CLI surface for Computer-Use (Phase 4 watch mode, Phase 7 docs).

## Key design decisions

### Disabled-state contract: tools-absent, no new error

The v3 plan currently says (line 508):

> Add `ComputerUseDisabledError` or a simple disabled tool result path.

Phase 0 picks **neither**. The existing codebase already solves this with the `disableMemory` precedent (`src/sdk/QueryEngine.ts:236–248`):

```typescript
if (!config.disableMemory) {
  // ... register memory tools ...
} else {
  this._memoryBaseDir = null
}
```

When memory is disabled, the tools are simply not registered — they don't appear in the registry, the model's tool list, or the `getToolDefinitions` output. An SDK caller that hand-crafts a `tool_use` block referencing an absent tool gets the existing `'tool_not_found'` `ToolErrorKind` (`src/core/tools/runToolUse.ts:87`). Clean, mechanical, no new types.

Phase 3 will follow this pattern verbatim for Computer-Use: `if (computerUseSettings.enabled) { registry.register(ComputerStartTool); ... }`. Phase 0 only needs to ensure the schema, validator, and boot path are in place — not the conditional registration itself, since no Computer-Use tools exist yet.

If Phase 3 surfaces a real need for an explicit disabled-state result (e.g., the model needs to *see* the tool exists but is off, so it can ask the user to enable it), add the `ToolErrorKind` value there with full context — not speculatively now.

**Doc sync**: Batch 1 of the implementation amends `docs/ultron_v3/v3-computer-use-plan.md:508` to record this contract, so the roadmap and design doc agree.

### Validator input is `unknown`, not `ComputerUseSettingsInput | undefined`

`readSettingsConfig()` does `parsed as SettingsConfig` at `src/config/settingsConfig.ts:75` — a TypeScript-only cast, no runtime validation. So at runtime, `settings.computerUse` may be a string, null, an array, a number, or anything else JSON can hold. The validator must defend against this.

Signature:

```typescript
export function validateComputerUseSettings(raw: unknown): ComputerUseSettings
```

Mirrors `validateAndNormalizeRules(raw: readonly unknown[])` in `src/web/rulesSeed.ts:35`. If `raw` is not a plain object, the validator warns once and returns defaults. Otherwise it narrows leaf-by-leaf, warning per invalid leaf and falling back to the per-field default.

### Validator location: `src/config/computerUseSettings.ts`

Existing convention is "consuming module owns its own validator":

- `src/web/rulesSeed.ts` — validates `permissionRules` and `webPolicy`
- `src/core/sandbox/settings.ts` — validates `shellSandbox`

But the v3 plan reserves `src/core/computer/` for Phase 2 (`types.ts`, `coordinates.ts`, `policy.ts`, ...). Putting the Phase 0 validator at `src/core/computer/settings.ts` would pre-empt that directory before the rest of it lands.

`src/config/computerUseSettings.ts` keeps the validator next to the schema it validates and out of Phase 2's way. Phase 3 imports it from there. Can be relocated to `src/core/computer/settings.ts` later if a stronger reason emerges.

### Boot wiring: run the validator, discard the result

Phase 0 invokes `validateComputerUseSettings(settings.computerUse)` once during `QueryEngine` construction, immediately after `mergeShellSandboxSettings(settings.shellSandbox)` (`src/sdk/QueryEngine.ts:259–271`). The result is discarded in Phase 0 — no AppState field, no registry consumption.

Without this boot call, the Phase 0 acceptance "invalid `computerUse` settings warn and fall back to defaults" only triggers when Phase 3 lands and finally consumes the validator. Running it at boot now exercises the warn path immediately and lets users discover bad config the first time they start the CLI after editing `settings.json`.

Risk to the v2 boot path is near-zero: the validator is a pure function whose only side effect is `process.stderr.write`. Phase 3 will assign the result to AppState; this is a single-line evolution.

### Domain pattern lowercasing

`allowedDomains` and `deniedDomains` mirror `webPolicy.{allowlist,denylist}` semantically. `compileWebPolicy` in `rulesSeed.ts:118` lowercases each entry before validating with `isValidDomainPattern`. The Phase 0 validator does the same:

```typescript
for (const entry of raw.allowedDomains) {
  if (typeof entry !== 'string') { warn(...); continue }
  const lowered = entry.toLowerCase()
  if (!isValidDomainPattern(lowered)) { warn(...); continue }
  out.push(lowered)
}
```

Output array is lowercased. Tests use `'Good.COM'` to prove the normalization is working.

### "Warn and skip" boot contract is the hard rule

`rulesSeed.ts:1–13` codifies it:

> The contract is "boot must never throw": invalid entries warn to stderr and are skipped; valid entries pass through unchanged.

Phase 0's validator obeys the same rule. Tests assert (a) one bad leaf does not poison sibling leaves, (b) one bad list entry does not drop sibling entries, (c) non-object root inputs return defaults rather than throwing.

## Schema

### `ComputerUseSettingsInput` (settings.json shape)

Loose, all-optional. Mirrors `ShellSandboxSettingsInput` in shape. Lives in `src/config/settingsConfig.ts` next to `SettingsConfig`:

```typescript
export type ComputerUseSettingsInput = {
  enabled?: boolean
  defaultEnvironment?: 'browser' | 'desktop'
  viewport?: { width?: number; height?: number }
  displaySize?: { width?: number; height?: number }
  maxSteps?: number
  maxDurationMs?: number
  maxScreenshotBytes?: number
  maxScreenshotDimensions?: { width?: number; height?: number }
  ariaSnapshotMaxTokens?: number
  allowedDomains?: string[]
  deniedDomains?: string[]
  persistProfiles?: boolean
  allowDownloads?: boolean
  allowUploads?: boolean
  allowAuthHandoff?: boolean
  debugPersistScreenshots?: boolean
}

export type SettingsConfig = {
  schemaVersion?: 1
  webSearch?: { /* ... */ }
  webPolicy?: { /* ... */ }
  permissionRules?: PermissionRule[]
  shellSandbox?: ShellSandboxSettingsInput
  computerUse?: ComputerUseSettingsInput   // ← new
}
```

### `ComputerUseSettings` (validated, fully-defaulted)

Lives in `src/config/computerUseSettings.ts`. All leaves are required after validation; nested objects are required:

```typescript
export type ComputerUseSettings = {
  enabled: boolean
  defaultEnvironment: 'browser' | 'desktop'
  viewport: { width: number; height: number }
  displaySize: { width: number; height: number }
  maxSteps: number
  maxDurationMs: number
  maxScreenshotBytes: number
  maxScreenshotDimensions: { width: number; height: number }
  ariaSnapshotMaxTokens: number
  allowedDomains: readonly string[]   // lowercased
  deniedDomains: readonly string[]    // lowercased
  persistProfiles: boolean
  allowDownloads: boolean
  allowUploads: boolean
  allowAuthHandoff: boolean
  debugPersistScreenshots: boolean
}

export const defaultComputerUseSettings: ComputerUseSettings = {
  enabled: false,
  defaultEnvironment: 'browser',
  viewport: { width: 1024, height: 768 },
  displaySize: { width: 1024, height: 768 },
  maxSteps: 30,
  maxDurationMs: 300_000,
  maxScreenshotBytes: 2_000_000,
  maxScreenshotDimensions: { width: 1024, height: 768 },
  ariaSnapshotMaxTokens: 4000,
  allowedDomains: [],
  deniedDomains: [],
  persistProfiles: false,
  allowDownloads: false,
  allowUploads: false,
  allowAuthHandoff: false,
  debugPersistScreenshots: false,
}
```

Defaults match `docs/ultron_v3/v3-computer-use-plan.md:470–491`.

### Validation rules per field

| Field | Rule | On invalid |
|---|---|---|
| `enabled` | `typeof === 'boolean'` (no truthy coercion) | warn, default `false` |
| `defaultEnvironment` | `=== 'browser' \|\| === 'desktop'` | warn, default `'browser'` |
| `viewport.width` / `.height` | integer in `[1, 4096]` | warn, default `1024` / `768` |
| `displaySize.width` / `.height` | integer in `[1, 4096]` | warn, default `1024` / `768` |
| `maxSteps` | integer `>= 1` | warn, default `30` |
| `maxDurationMs` | integer `>= 1000` | warn, default `300_000` |
| `maxScreenshotBytes` | integer `>= 1024` | warn, default `2_000_000` |
| `maxScreenshotDimensions.{width,height}` | integer in `[1, 1280]` (width) / `[1, 800]` (height) — Anthropic's hard cap per v3 plan | warn, default `1024` / `768` |
| `ariaSnapshotMaxTokens` | integer `>= 1` | warn, default `4000` |
| `allowedDomains` / `deniedDomains` | `Array<string>`; each entry lowercased and validated via `isValidDomainPattern` | warn per bad entry, drop bad entry, keep good ones |
| `persistProfiles`, `allowDownloads`, `allowUploads`, `allowAuthHandoff`, `debugPersistScreenshots` | `typeof === 'boolean'` | warn, default `false` |

Sibling leaves are independent: `viewport.width: -1` doesn't poison `viewport.height`, and `allowedDomains: ['good.com', 42]` keeps `'good.com'` and drops `42`.

## Schema-aware merge

`mergeSettings()` in `src/config/settingsConfig.ts:95–146` already does per-field merging for existing sections. The `computerUse` branch matches the `shellSandbox` shape exactly — top-level spread plus per-key spread for nested objects:

```typescript
if (partial.computerUse !== undefined) {
  const prevCu = prev.computerUse ?? {}
  const partCu = partial.computerUse
  const merged: ComputerUseSettingsInput = { ...prevCu, ...partCu }
  if (prevCu.viewport !== undefined || partCu.viewport !== undefined) {
    merged.viewport = { ...(prevCu.viewport ?? {}), ...(partCu.viewport ?? {}) }
  }
  if (prevCu.displaySize !== undefined || partCu.displaySize !== undefined) {
    merged.displaySize = { ...(prevCu.displaySize ?? {}), ...(partCu.displaySize ?? {}) }
  }
  if (prevCu.maxScreenshotDimensions !== undefined || partCu.maxScreenshotDimensions !== undefined) {
    merged.maxScreenshotDimensions = {
      ...(prevCu.maxScreenshotDimensions ?? {}),
      ...(partCu.maxScreenshotDimensions ?? {}),
    }
  }
  next.computerUse = merged
}
```

Arrays (`allowedDomains`, `deniedDomains`) replace, matching `webPolicy.allowlist` semantics.

## Boot-time wiring

In `src/sdk/QueryEngine.ts` constructor, immediately after the existing `mergeShellSandboxSettings` call (~line 264):

```typescript
const settings = readSettingsConfig()
const seededRules = validateAndNormalizeRules(settings.permissionRules ?? [])
const seededFromPolicy = compileWebPolicy(settings.webPolicy)
const seeded = dedupeRules([...seededRules, ...seededFromPolicy])
const seededSandbox = mergeShellSandboxSettings(settings.shellSandbox)
validateComputerUseSettings(settings.computerUse)   // ← Phase 0: warn-on-invalid only; Phase 3 will store the result for tool gating.
```

The result is intentionally discarded. Phase 3 will assign it to a private field on `QueryEngine` (or an AppState slot) and pass it to a `createDefaultRegistry({ computerUse })` factory.

## Files

### New

| Path | Purpose |
|---|---|
| `docs/ultron_v3/v3-phase0-design.md` | This file |
| `src/config/computerUseSettings.ts` | `ComputerUseSettings` type, `defaultComputerUseSettings`, `validateComputerUseSettings(raw: unknown)` |
| `src/config/computerUseSettings.test.ts` | Validator tests, mirroring `src/web/rulesSeed.test.ts` |

### Modified

| Path | Change |
|---|---|
| `docs/ultron_v2/v2-scope.md` | Line 76 — link Computer-Use callout to both `ultron_v3/v3-computer-use-plan.md` and `ultron_v3/v3-phase0-design.md` |
| `docs/ultron_v3/v3-computer-use-plan.md` | Phase 0 deliverables (~line 508) — replace "Add `ComputerUseDisabledError` or a simple disabled tool result path" with the absent-tools / `tool_not_found` contract |
| `src/config/settingsConfig.ts` | Add `ComputerUseSettingsInput`, add `computerUse?` to `SettingsConfig`, extend `mergeSettings()` with the `computerUse` branch, update `mergeSettings` JSDoc |
| `src/config/settingsConfig.test.ts` | Round-trip a `computerUse` write; non-clobber merge test (`viewport.width` write preserves `maxSteps`) |
| `src/sdk/QueryEngine.ts` | One-line `validateComputerUseSettings(settings.computerUse)` next to existing seeders |
| `src/sdk/QueryEngine.test.ts` (or equivalent boot-seed test) | Construction with invalid `computerUse.enabled: 'yes'` warns at startup, doesn't throw |

### Reused (no modification)

- `src/web/rulesSeed.ts:31–33` — `warn(msg)` stderr pattern
- `src/web/domainPolicy.ts` — `isValidDomainPattern` (called by both `compileWebPolicy` and the new validator)
- `src/config/settingsConfig.ts:57` — `__setSettingsPathForTest` test seam
- `src/config/settingsConfig.ts:123–143` — `shellSandbox` merge branch as the structural template for the new `computerUse` branch

## Implementation order

Two batches. Batch 1 is docs only; pause for review before Batch 2.

### Batch 1 — Docs

1. Write this design doc (`docs/ultron_v3/v3-phase0-design.md`).
2. Update `docs/ultron_v2/v2-scope.md:76` to link the new design doc alongside the plan.
3. Amend `docs/ultron_v3/v3-computer-use-plan.md` Phase 0 deliverables (~line 508) to replace the `ComputerUseDisabledError`-or-disabled-result line with the absent-tools / `tool_not_found` contract.

**Pause for review.** User reviews the design doc, scope edit, and plan amendment before any code lands.

### Batch 2 — Code

4. Add `ComputerUseSettingsInput` and `computerUse?` to `SettingsConfig`. Extend `mergeSettings()` with the `computerUse` branch. Update JSDoc.
5. Create `src/config/computerUseSettings.ts` — `ComputerUseSettings` type, `defaultComputerUseSettings`, `validateComputerUseSettings(raw: unknown)`.
6. Add tests to `src/config/settingsConfig.test.ts` for round-trip and non-clobber merge.
7. Create `src/config/computerUseSettings.test.ts` — validator tests covering `unknown`-input defensiveness, per-leaf type checks, range guards, list-entry resilience, domain lowercasing.
8. Wire `validateComputerUseSettings(settings.computerUse)` into `QueryEngine` constructor next to existing seeders.
9. Add a single boot-seed test proving an invalid `computerUse.enabled` warns at construction without throwing.

## Verification

### Unit tests

- `computerUseSettings.test.ts`:
  - `undefined` input → returns `defaultComputerUseSettings`, no warnings.
  - Fully valid input → returns it unchanged (canonical fixture).
  - Non-object root inputs (`null`, `'string'`, `42`, `[]`) each warn once, return defaults.
  - `enabled: 'yes'` → warn, falls back to default `false`.
  - `viewport: { width: -1 }` → warn, falls back to default `1024`. Sibling `viewport.height` unaffected.
  - `maxSteps: 0` → warn, falls back to default `30`.
  - `maxScreenshotDimensions: { width: 9999 }` → warn (exceeds `1280` cap), falls back to default.
  - `allowedDomains: ['Good.COM', 42, 'bad..com']` → output `['good.com']` (proves lowercasing); two separate warns for the number and the malformed pattern.
  - One bad leaf does not poison siblings (`enabled: 'yes'` + `maxSteps: 50` → returns `{ enabled: false, maxSteps: 50, ... }`).
- `settingsConfig.test.ts`:
  - Round-trip: write `{ computerUse: { enabled: true, allowedDomains: ['example.com'] } }`, read returns the same shape.
  - Non-clobber merge: write `computerUse.viewport.width`, then write `computerUse.maxSteps`; final state has both fields.
- `QueryEngine.test.ts` (or wherever boot-seed behavior is tested):
  - Constructing with an invalid `computerUse.enabled: 'yes'` writes one stderr warning and does not throw.

### Manual smoke

1. `rm ~/.ultron/settings.json`. `npm start`. CLI starts cleanly, no Computer-Use mention anywhere.
2. Write `~/.ultron/settings.json` with `{ "computerUse": { "enabled": "yes" } }`. `npm start`. Observe one `[ultron] settings.json: ...` warning at startup. CLI continues normally.
3. Write `~/.ultron/settings.json` with `{ "computerUse": "not-an-object" }`. `npm start`. Observe one stderr warning, no throw (proves `unknown`-input defensiveness).
4. `git status` after Batch 2 — only the files in the "Files" section above are touched.

## Open questions (resolve during implementation, not blocking design)

1. Should the validator warn on **unknown** keys in `computerUse` (e.g., a user typo'd `viewPort` instead of `viewport`)? `rulesSeed.ts` ignores unknown keys silently. Tentative answer: match `rulesSeed.ts` — silent — to keep the contract simple. Revisit if Phase 3 surfaces real config-typo pain.
2. Where exactly should the boot-seed test for `computerUse` live? `QueryEngine.test.ts`, or alongside the validator? Resolve by checking the existing pattern when Batch 2 lands; if `rulesSeed`'s seed test lives next to `rulesSeed.ts`, follow that. If `QueryEngine.test.ts` is the canonical boot-seed test, add it there.
3. Should `defaultComputerUseSettings` be exported as `readonly`? The struct is logically immutable. Tentative: yes — `readonly` on every leaf via the type, plus `Object.freeze` on the literal at module init. Cheap defensiveness.

## Out of scope (mirrors v3 roadmap)

- `ComputerUseDisabledError` / `'feature_disabled'` `ToolErrorKind` — not added.
- `src/core/computer/` directory — reserved for Phase 2.
- AppState field for `computerUse` — Phase 3.
- Conditional tool registration — Phase 3.
- Image-attachment substrate — Phase 1.
- Playwright dependency — Phase 2.
- Computer-Use system prompt guidance — Phase 5.
