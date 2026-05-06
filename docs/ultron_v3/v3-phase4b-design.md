# v3 Phase 4b Design: DOM-First Action Path

## Status

Pre-implementation. Plan file: `~/.claude/plans/now-make-a-plan-lexical-umbrella.md`. Roadmap: `docs/ultron_v3/v3-computer-use-plan.md` (Phase 4b deliverables, lines 664–689). Predecessors: Phase 0/1/2/3/4 — substrate, image attachments, browser session, 11 Computer tools, ARIA snapshot infrastructure + safety stack (all landed; recent commit `7be60f9`). Successors: Phase 5 (system-prompt guidance — biases the model toward the atom path), Phase 6 (eval fixtures, including a deterministic atom-action fixture).

## Context

Phase 4 shipped the safety stack: ARIA snapshot capture + structured `AriaNode` tree, dangerous-label and sensitive-field risk classifier, non-bypassable safety check at cascade step 4, password/selector redaction, post-action verify (ARIA-diff + pHash), CLI watch-mode, and `storageState` handoff. Coordinate-based tools (`ComputerClick`, `ComputerType`, …) drive a sandboxed browser end-to-end, route through the cascade for every action, and surface `verified: false` when a click lands on an overlay.

Coordinate-based vision is the most flexible substrate, but it is also the most expensive (every action attaches a screenshot to the model's turn) and the most failure-prone (the model has to predict pixel coordinates from a downscaled JPEG). For pages that expose a stable accessibility tree — which is most of the modern web — Ultron should drive Playwright via a semantic locator (`getByRole({name})`) and let the model pick a stable `atomId` rather than predict a pixel.

Phase 4b operationalizes Design Principle 10 from the v3 plan ("prefer deterministic APIs when possible"). It adds two model-facing tools — `ComputerObserveActions` and `ComputerActAtom` — that replace the screenshot+coordinate loop with a redacted atom catalog and a typed action over an `atomId`. Coordinate tools remain as the documented fallback for canvas-style interfaces, image-only buttons, and any element the ARIA walker cannot resolve.

Phase 4b satisfies all four v3-roadmap acceptance criteria for the DOM-first path (`docs/ultron_v3/v3-computer-use-plan.md:684–689`):

1. A known-stable element (`<button aria-label="Sign in">`) is acted on by `ComputerActAtom` with **no screenshot attachment on the result envelope** (i.e. no image input reaches the model on that turn). Internal screenshot capture for `verify`'s pHash backstop still runs — see §"Internal screenshot capture vs model image input."
2. The selector cache hits on a replay run; the LLM is not invoked for atom resolution on the cache-hit path.
3. Atom-resolution failure produces a clear error result that the model can recover from with a coordinate-tool fallback.
4. DOM-first tools share the same permission cascade, audit, and approval path as the coordinate tools.

## Phase 1/2/3/4 prerequisites

- **Phase 1** — `ToolResultAttachment` (`src/core/tools/imageAttachment.ts`) carries the post-action screenshot for coordinate tools. Phase 4b deliberately omits the attachment from `ComputerActAtom`'s result envelope; the type itself is unchanged.
- **Phase 2** — `BrowserSession` interface (`src/core/computer/types.ts:88-156`) is the seam Phase 4b extends with `actOnAtom` and three cache accessors. `_page` stays private; Phase 4b does NOT bypass that.
- **Phase 3** — `createComputerUseTools(deps)` factory pattern (`ComputerTools.ts:84-98`) is the slot Phase 4b extends with two `build*Tool(deps)` builders. `mapBrowserSessionError(err)` (`ComputerTools.ts:171-199`) is the slot extended with the `'atom_locator_failed'` → `'atom_resolution_failed'` route. `resolveSession`, `makeSessionGetDomain`, and `errorResult` are reused unchanged.
- **Phase 4·1** — `AriaNode` (`ariaSnapshot.ts:33-60`), `redactNodes` (`ariaSnapshot.ts:471`), `isSensitiveNode` (`ariaSnapshot.ts:535`), `describeSensitiveSignal` (`ariaSnapshot.ts:559`), and the synchronous `BrowserSession.lastAriaSnapshot()` are all consumed. `INTERESTING_ROLES` (`ariaSnapshot.ts:590`) is referenced but **not** reused as the atom-catalog filter — Phase 4b introduces a stricter `ACTIONABLE_ROLES` subset (see §"Why ACTIONABLE_ROLES, not INTERESTING_ROLES").
- **Phase 4·1** — `ClassifyContext` (`policy.ts:139-153`) already accepts `ariaSnapshot?: AriaTreeSnapshot | null` for coordinate-click classification via `findAtPoint`. Phase 4b widens it with `targetNode?: AriaNode | null` so atom-based actions pass the resolved node directly without a coordinate lookup.
- **Phase 4·1** — `makeComputerUseSafetyCheck(deps)` (`computerSafetyChecks.ts:45-72`) reads `session.lastAriaSnapshot()` synchronously inside the safety-check closure. Phase 4b extends it to also resolve `input.atomId` via `session.lookupAtom(atomId)` — same synchronous-accessor pattern.
- **Phase 4·2** — `runActionAndObserve(session, signal, prefix, action, opts)` (`ComputerTools.ts:315-374`) is the seam ActAtom plugs into. Phase 4b widens `opts` with `attachScreenshot?: boolean` (default `true`) so ActAtom can drop the post-action screenshot from its result envelope while still running verify internally.
- **Phase 4·2** — `verify({before, after})` (`verify.ts:63-74`) is consumed unchanged. ActAtom's pre/post ARIA hashes flow through it identically to coordinate tools.

## Goals

1. **DOM-first atom path.** Add `ComputerObserveActions(sessionId)` (returns `[{atomId, role, name, hint?, bbox?}, …]` from the redacted ARIA tree, NO screenshot attachment) and `ComputerActAtom(sessionId, atomId, action)` (resolves the atom, drives `getByRole(...).click() / .fill() / .selectOption()`).
2. **One new BrowserSession seam.** Add a single `actOnAtom(locator, action, signal)` method to the abstract interface — Profile B (managed stealth) and Profile C (container desktop) implement one method, not three. Cache accessors (`setAtomCache`, `lookupAtom`, `currentAtomCache`) are mechanical add-ons that mirror the existing `lastAriaSnapshot()` precedent.
3. **Three-source error surface converging on `'atom_resolution_failed'`.** Cache miss (atomId absent / different sessionId / cache cleared by navigation), locator zero-match (`getByRole(...).nth(...).count() === 0`), AND bbox-drift retarget (the `nth`-indexed match is no longer the cached element — duplicate-name shuffle) all surface as `errorKind: 'atom_resolution_failed'`. The new `BrowserSessionErrorKind: 'atom_locator_failed'` carries the latter two paths; `mapBrowserSessionError` routes it. Genuine post-resolution action failures stay `'execution_error'`. Recovery messages stay generic — never echo `locatorName`.
4. **No screenshot attachment / no model image input on the ActAtom turn.** `runActionAndObserve` widens with `attachScreenshot?: boolean` (default `true` to preserve coordinate-tool behavior). ActAtom passes `false`. The post-action screenshot is dropped from `ToolResult.attachments`, so no image reaches the model. Internal capture still happens — Phase 4·2's `verify` needs the bytes for the pHash backstop signal and Phase 4·1's `lastAriaSnapshot` cache refresh runs after every action. The acceptance criterion targets *model image input*, not pipeline cost.
5. **Cascade parity.** ActAtom flows through the same step-4 safety-check slot as every other Computer tool. The classifier stays the single source of truth: dangerous-label regex matches against `targetNode.name` (raw); sensitive-field detection uses `isSensitiveNode(targetNode)`. `Submit / Pay / Delete` clicks via ActAtom trigger the same level-3 ask as via ComputerClick under any permission mode.
6. **Redacted-name vs locator-name separation.** The atom catalog the model sees uses `displayName` (redacted by `isSensitiveNode`); the cached entry holds `locatorName` (raw accessible name) for `getByRole({name})`. **The locator name never reaches the model.** This lets a password input render as `[REDACTED]` to the model while Playwright still resolves `getByRole('textbox', {name: 'Password'})`.
7. **Reuse the Phase 4 spine end-to-end.** `redactNodes`, `isSensitiveNode`, `describeSensitiveSignal`, `runActionAndObserve`, `verify.ts`, `mapBrowserSessionError`, `makeSessionGetDomain`, `resolveSession`, `errorResult` are all consumed unchanged or with minimal additive widening.

## Non-goals

- **No fuzzy atomId rebinding across page mutations.** The cache binds an atomId to a specific `(role, locatorName, ancestorPath)` snapshot; if the page changes, the cache miss path or the locator-preflight path surfaces a clear error. The model re-observes or falls back to coordinate tools. Fail-fast is the v3 contract.
- **No cross-session atom cache.** AtomIds are scoped to the session that emitted them. A session restart invalidates everything.
- **No screenshot ATTACHMENT in `ComputerObserveActions` or `ComputerActAtom`.** The acceptance criterion targets the model's image input, not pipeline cost. Internal screenshot capture continues so `verify`'s pHash backstop and `lastAriaSnapshot` cache refresh keep working — see §"Internal screenshot capture vs model image input."
- **No system-prompt guidance.** Phase 5 owns the "prefer the DOM-first atom path" instruction. Phase 4b ships the tools; the model only learns to use them when Phase 5 tells it to.
- **No native-CUA bridge changes.** Stretch Phase. OpenAI/Anthropic native computer-use protocols still translate into the canonical Ultron tool path; if/when they ship, they'll route through `actOnAtom` for the atom path the same way they route through `click` for coordinates.
- **No new image-processing or DOM-walking dependency.** ARIA extraction stays on Phase 4·1's `extractAriaTreeInBrowser`. Locator resolution stays on Playwright's `getByRole`. No `sharp`/`jimp`/etc.
- **No iframe-rooted atoms.** Phase 4·1's ARIA walker traverses the top document only. A same-origin iframe's `<button>Sign in</button>` is invisible to the catalog. Documented as a known limitation; revisit in Phase 6 if eval fixtures surface real breakage.
- **No batched PRs.** Phase 4b's surface is small (2 tools, 2 pure modules, 1 BrowserSession seam, 1 ToolErrorKind value, ~6 modified files). Bundling reads more cleanly than splitting.
- **No watch-mode event-envelope extension.** ObserveActions/ActAtom render through the existing `tool_call_started` / `tool_call_finished` events; structured atom counts and screenshot-path lines would need event extension and are deferred.

## Key design decisions

### AtomId scheme — index-based with `(role, locatorName, ancestorPath, bbox)` fingerprint

`atomId = "a-" + dfsIndex`, assigned by walking the **raw** tree in DFS order and picking nodes whose `role` is in `ACTIONABLE_ROLES`. Each cached entry records `(role, locatorName, ancestorPath, nth, bbox)` for diagnostics, audit, and post-resolution drift detection, plus the full `AriaNode` for the safety check.

Resolution is **two-tier**:

1. **Cache present, atomId known** → return the entry directly. The model can replay actions without re-observing as long as the page is structurally stable; this is the cache-hit path the v3 plan calls out.
2. **Cache miss, atomId unknown, OR session has no cache** → return `null`; ActAtom surfaces `'atom_resolution_failed'` synchronously, without touching the page.

A separate **locator-preflight** check inside `actOnAtom` covers the third failure mode: the cache says the atom exists, but Playwright's `getByRole(...).nth(...).count()` returns 0 because the element was removed or restructured between observation and action. That path raises `BrowserSessionError(kind: 'atom_locator_failed')`, which `mapBrowserSessionError` routes to the same `errorKind: 'atom_resolution_failed'` so the model sees one consistent retry signal.

We do not attempt fuzzy re-resolution by walking the live tree for a structurally-similar node. Quietly silent-rebinding to a different element would violate the safety check (the cached `AriaNode` would no longer match the executed action). Fail-fast is correct: the model cheaply re-observes when needed.

### Why `ACTIONABLE_ROLES`, not `INTERESTING_ROLES`

`INTERESTING_ROLES` (`ariaSnapshot.ts:590`) is the broader set used by Phase 4·1's classifier and observation paths — it includes `heading`, `landmark`, `list`, `img`, etc. Useful for the model to *see* the page structure; not useful for the *atom catalog*. Headings and landmarks aren't click/fill/select targets; including them in `serializeAtoms` output adds noise and tempts the model to issue actions on non-actionable nodes that would error out at preflight.

`ACTIONABLE_ROLES` (Phase 4b, in `atomResolver.ts`) is the strict subset:

```ts
export const ACTIONABLE_ROLES = new Set<string>([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option',
  'textbox', 'searchbox', 'combobox', 'spinbutton',
  'checkbox', 'radio', 'switch', 'slider',
  'treeitem',
])
```

`assignAtomIds` filters on this. The risk classifier (`policy.ts`) keeps using `INTERESTING_ROLES` for click-target lookup because dangerous-label detection on a `heading` is still meaningful even though Phase 4b doesn't catalog headings as atoms.

### `AtomEntry` / `AtomLocator` / `AtomAction` types

```ts
// src/core/computer/atomResolver.ts
import type { AriaNode, AriaTreeSnapshot, BoundingBox } from './ariaSnapshot.js'

export type AtomEntry = {
  readonly atomId: string                    // 'a-0', 'a-1', …
  readonly role: string
  readonly displayName: string | null        // REDACTED — the only name field serializeAtoms emits
  readonly locatorName: string | null        // RAW accessible name — for getByRole; NEVER serialized to the model
  readonly hint?: string                     // e.g. 'form: Sign in'  (computed from raw ancestor names; redacted at emit)
  readonly bbox?: BoundingBox                // for watch-mode rendering / debug
  readonly node: AriaNode                    // raw node — for safety-check lookup (carries raw name + sensitive signals)
  readonly ancestorPath: readonly string[]   // diagnostics — chain of (role, name) from <body>
  readonly nth: number                       // disambiguates duplicate (role, locatorName)
}

export type AtomLocator = {
  readonly role: string
  readonly locatorName: string | null        // RAW name — passed to Playwright getByRole({name})
  readonly nth: number
  readonly expectedBbox: BoundingBox | null  // cached bbox at observation; checked post-resolution to detect silent retarget
}

export type AtomAction =
  | { readonly type: 'click';  readonly button?: 'left' | 'middle' | 'right'; readonly double?: boolean }
  | { readonly type: 'fill';   readonly text: string; readonly sensitive?: boolean }
  | { readonly type: 'select'; readonly value: string }
```

### Bbox post-resolution check — closing the silent-retarget gap

Indexing duplicate `(role, locatorName)` matches by `nth` is insufficient on its own. Consider a settings page with two `<button>Save</button>` instances; we cache the second one as `nth: 1`. A live DOM mutation removes the first `Save` button between observation and action — Playwright's `getByRole('button', {name: 'Save'}).count()` now returns `1`, and `.nth(1)` resolves to nothing (a Playwright "out of bounds" no-op error covered by the existing path) — but if the mutation instead INSERTS a new earlier `Save`, `count()` stays `2` and `.nth(1)` now points to what was previously `nth: 2` — a different element. The safety check classified the cached `AriaNode`; Playwright would act on a different one. The cache-miss path doesn't catch this. The locator-zero-match path doesn't catch this either.

The fix is a **bbox-tolerance post-resolution check** inside `actOnAtom`, after the count preflight:

```ts
const live = await target.boundingBox()
if (live === null || locator.expectedBbox === null || !bboxesMatch(live, locator.expectedBbox, BBOX_TOLERANCE_PX)) {
  throw new BrowserSessionError('atom_locator_failed', 'locator bbox drift exceeds tolerance')
}
```

`bboxesMatch` returns `true` when `|live.x - expected.x| ≤ T && |live.y - expected.y| ≤ T && |live.width - expected.width| ≤ T && |live.height - expected.height| ≤ T`. `BBOX_TOLERANCE_PX = 8` covers normal reflow (font metric variation, scroll-induced sticky-bar shift, hover-state padding) without admitting a different element.

When `entry.bbox === null` (the ARIA walker couldn't compute one — rare for visible interactive elements but possible for off-screen / `display: none` toggled-in nodes), the locator falls back to `count()`-only resolution. Documented as a soft-failure mode: ambiguous elements without bboxes are slightly less safe; the model can re-observe to refresh.

This adds one Playwright round-trip per ActAtom call (~2-5ms locally). Worth the cost: it converts the silent-retarget class from "safety check classified node A; action ran on node B" to a clean `'atom_resolution_failed'` the model can recover from.

`bboxesMatch` lives in `atomResolver.ts` (pure helper, exported for tests).

### Redacted-name vs locator-name split — the load-bearing decision

`redactNodes` (`ariaSnapshot.ts:471`) replaces sensitive node names with `'[REDACTED]'`. If we cache that redacted tree and use the redacted name as the Playwright locator name, `getByRole('textbox', {name: '[REDACTED]'})` resolves zero elements — every password input becomes unfillable. That is a real bug, not a theoretical one.

The fix is to keep both forms per entry:

- `displayName`: the model-visible name. Computed as `(isSensitiveNode(node) || nodeIntersectsRegion(node, sensitiveRegions)) ? '[REDACTED]' : node.name` (see "Honoring user redactionSelectors" below for the second predicate). `serializeAtoms` is the only writer that emits this string into a model-visible payload. Hints are also redacted at emit time using the same combined predicate.
- `locatorName`: the raw `node.name`. Lives only in the in-process cache on `BrowserSession._atomCache`, plus on the `AtomLocator` value passed to `BrowserSession.actOnAtom` for the lifetime of one action call. Never serialized to disk, never sent to the model, never echoed in error messages (see "Locator-failure messages stay generic" below), never logged to audit (audit logs receive `displayName` via the existing `redactImageData` and `permission_decision.safetyMetadata` paths).

`buildLocator(entry)` reads `locatorName`. `serializeAtoms(entries)` reads `displayName`. Tests cover both directions to prevent the obvious bug of crossing the streams.

The safety check reads `entry.node.name` (raw) — that's correct: dangerous-label detection (`Submit`, `Delete`, `Pay`) needs the raw text to match `DANGEROUS_LABEL_RE`, and sensitive-field detection runs on `isSensitiveNode(entry.node)`. The redaction is a model-visibility boundary, not a security boundary against the safety check itself.

### Honoring user `redactionSelectors`

`isSensitiveNode` (`ariaSnapshot.ts:535`) catches HTML-semantic sensitive fields — password inputs, MFA codes, payment fields, ssn-style names, autocomplete tokens. It does NOT catch user-flagged custom UI: a `<div>` displaying a session token, a `<button>` whose accessible name embeds a credit-card number, a `<span>` containing an API secret. Phase 4·2 added `computerUseSettings.redactionSelectors` for exactly this case — a list of CSS selectors the user knows are sensitive — and `getSensitiveRegions(extraSelectors)` (`types.ts:144-147`) resolves them to bboxes for screenshot blackout.

Phase 4b extends the same plumbing into the atom catalog. `ComputerObserveActions`:

```ts
async call(input, _ctx, signal) {
  const lookup = resolveSession(deps, input.sessionId); if (!lookup.ok) return lookup.result
  try {
    const snap = await lookup.session.ariaSnapshot(signal)
    const sensitiveRegions = await lookup.session.getSensitiveRegions(
      deps.settings.redactionSelectors, signal,
    )
    const url = lookup.session.currentUrl() ?? ''
    const cache = buildAtomCache(snap, url, { sensitiveRegions })
    lookup.session.setAtomCache(cache)
    return { content: serializeAtoms([...cache.entries.values()]), isError: false }
  } catch (err) { return mapBrowserSessionError(err) }
}
```

`buildAtomCache` forwards `sensitiveRegions` to `assignAtomIds`, which uses them in the `displayName` decision:

```ts
function assignAtomIds(
  snapshot: AriaTreeSnapshot,
  opts?: { readonly sensitiveRegions?: readonly BoundingBox[] },
): readonly AtomEntry[]
```

The intersection check is the standard rectangle-overlap test against `node.bbox`. A node whose bbox overlaps any sensitive region (or whose bbox is `null`) gets `displayName: '[REDACTED]'`. `locatorName` stays raw so Playwright still resolves the locator.

This propagates the same redaction surface the user already configured for screenshots. A user who marks `.payment-card-display` in their settings sees that element's name redacted in both the screenshot and the atom catalog. No "narrow the guarantee" caveat needed.

### Locator-failure messages stay generic

The locator-preflight failure inside `actOnAtom` (and the new bbox-drift failure) must not echo `locatorName` into the error message — `BrowserSessionError.message` flows through to `mapBrowserSessionError`, which writes the model-visible `errorResult.content`. Echoing the raw name would defeat the redaction boundary.

Inside `actOnAtom`:

```ts
if (matches === 0) {
  throw new BrowserSessionError('atom_locator_failed', 'locator resolved zero elements')
}
// … bbox drift check …
throw new BrowserSessionError('atom_locator_failed', 'locator bbox drift exceeds tolerance')
```

The string is internal-only diagnostic. `mapBrowserSessionError` for `'atom_locator_failed'` constructs its own model-visible recovery message that does NOT include the source error text:

```ts
case 'atom_locator_failed':
  return errorResult(
    'atom_resolution_failed',
    'The atom is no longer resolvable on the current page (it may have been removed or the page changed). ' +
    'Re-observe with ComputerObserveActions, or fall back to ComputerClick / ComputerType.',
  )
```

Same recovery wording for both cache-miss and locator-failure paths. The model gets one consistent retry signal.

### Selector cache shape and lifetime

```ts
// src/core/computer/selectorCache.ts
export type SessionAtomCache = {
  readonly url: string
  readonly ariaHash: string
  readonly entries: ReadonlyMap<string /* atomId */, AtomEntry>
}

export function buildAtomCache(snapshot: AriaTreeSnapshot, url: string): SessionAtomCache
```

**One cache per session at a time.** Replaced wholesale by the next `ComputerObserveActions` call. AtomIds are only valid for the snapshot they were assigned in; holding multiple historical caches would invite the model to act on stale snapshots' ids.

**Cleared on three events:**
- `ComputerStop` / `BrowserSession.close()` — session is gone.
- `BrowserSession.navigate()` — the URL is changing; locator-name strings might still match elements on the new page, but they wouldn't be the same elements. Clearing eliminates that whole class of confusion.
- (Implicit) replacement on the next `ComputerObserveActions` for a different `(url, ariaHash)`.

### Cache home — attached to `BrowserSession`, not a module-level Map

Three reasons the cache lives on the session, accessed via four interface methods (`actOnAtom` already counted):

1. **Lifetime parity.** Cache is meaningless without the session; binding it to the session means session teardown cleans it for free. No separate registry to drain in `sessionManager.stop`.
2. **Synchronous read for the safety check.** `permissions.ts:112-117` requires safety checks to be sync. The safety check needs to resolve `atomId → AriaNode` to feed `targetNode` to `classifyAction`. A module-level Map would work too, but the BrowserSession-attached pattern keeps the dependency graph cleaner — no module-level mutable state, no reset hook for tests.
3. **Matches existing precedent.** `BrowserSession.lastAriaSnapshot(): AriaTreeSnapshot | null` (Phase 4·1) is the same shape: synchronous accessor populated by the implementation, cleared on close. Phase 4b's cache accessors (`lookupAtom`, `currentAtomCache`, `setAtomCache`) are the trio.

### `atomResolver.ts` — pure module

Pure functions only. No Playwright import, no I/O. Lets unit tests run under Node without spawning a browser, and lets the same module be reused if a non-Playwright BrowserSession ever ships.

```ts
export function assignAtomIds(snapshot: AriaTreeSnapshot): readonly AtomEntry[]
export function buildLocator(entry: AtomEntry): AtomLocator
export function serializeAtoms(entries: readonly AtomEntry[]): string  // YAML
```

`assignAtomIds` walks the **raw** tree (NOT the redacted tree — we need the raw `name` to compute `locatorName`). It picks `ACTIONABLE_ROLES` nodes in DFS order. For each:

- `atomId = 'a-' + index` (DFS-order monotonic).
- `locatorName = node.name`.
- `displayName = isSensitiveNode(node) ? '[REDACTED]' : node.name`.
- `nth` is incremented per `(role, locatorName)` pair so duplicates disambiguate.
- `hint` is the `'<role>: <name>'` of the nearest non-`generic` non-`group` named ancestor (raw name). At emit time `serializeAtoms` redacts the hint using the same predicate so a password input nested in a redacted form section doesn't leak the form's name through the hint either.
- `ancestorPath` is the chain of `'<role>:"<name>"'` strings from `<body>` down. Diagnostics only.

`serializeAtoms` produces compact YAML keyed for model consumption (no `node`, no `ancestorPath`, no `locatorName`):

```yaml
- id: a-0
  role: button
  name: "Sign in"
  hint: "form: Sign in"
- id: a-3
  role: textbox
  name: "[REDACTED]"
  hint: "form: Sign in"
```

### Single `actOnAtom` BrowserSession method, not three

A single `actOnAtom(locator, action, signal)` method beats three (`clickLocator`/`fillLocator`/`selectLocator`) for two reasons:

1. **Lean seam.** `BrowserSession` is the abstract interface every backend implements. Profile B (managed stealth) and Profile C (container desktop) implement one new method, not three.
2. **One action router.** The discriminated-union dispatch (`switch (action.type)`) lives in one place — the Playwright impl — instead of being smeared across three call sites in `ComputerActAtom`.

Implementation detail in `playwrightBrowserSession.ts`:

```ts
async actOnAtom(locator: AtomLocator, action: AtomAction, signal: AbortSignal): Promise<void> {
  const base = this._page.getByRole(
    locator.role as Parameters<Page['getByRole']>[0],
    locator.locatorName !== null ? { name: locator.locatorName, exact: true } : {},
  )
  const target = base.nth(locator.nth)
  await this._withAbort(signal, async () => {
    // Preflight 1 — count > 0 (page didn't lose the element).
    const matches = await target.count()
    if (matches === 0) {
      throw new BrowserSessionError('atom_locator_failed', 'locator resolved zero elements')
    }
    // Preflight 2 — bbox drift (page didn't silently retarget nth to a different element).
    if (locator.expectedBbox !== null) {
      const live = await target.boundingBox()
      if (live === null || !bboxesMatch(live, locator.expectedBbox, BBOX_TOLERANCE_PX)) {
        throw new BrowserSessionError('atom_locator_failed', 'locator bbox drift exceeds tolerance')
      }
    }
    // Action.
    switch (action.type) {
      case 'click':
        if (action.double === true) await target.dblclick({ button: action.button ?? 'left' })
        else await target.click({ button: action.button ?? 'left' })
        return
      case 'fill':
        await target.fill(action.text)
        return
      case 'select':
        await target.selectOption(action.value)
        return
    }
  })
}
```

Both `BrowserSessionError` messages stay generic — never echo `locatorName`. The model-visible recovery message is composed by `mapBrowserSessionError` (see "Locator-failure messages stay generic" above), so the raw name never leaves the in-process boundary.

### Two-layer error surface — both paths converge on `'atom_resolution_failed'`

`ComputerActAtom` can fail at three boundaries:

| Failure point | Detected by | BrowserSessionErrorKind | ToolErrorKind |
| --- | --- | --- | --- |
| atomId not in cache (no observation, stale cache, wrong session) | `session.lookupAtom(atomId) === null` in `ComputerActAtom.call` | — (no Playwright touch) | `'atom_resolution_failed'` |
| Cache says element exists, but Playwright finds zero matches | `await target.count() === 0` inside `actOnAtom` preflight | `'atom_locator_failed'` (NEW) | `'atom_resolution_failed'` (via `mapBrowserSessionError` extension) |
| Cache says element exists at a known bbox, but the live element's bbox drifted past tolerance (silent retarget — duplicate-name shuffle) | `!bboxesMatch(live, expected, BBOX_TOLERANCE_PX)` inside `actOnAtom` preflight | `'atom_locator_failed'` | `'atom_resolution_failed'` |
| Element found, bbox stable, but action couldn't complete (timeout, modal stole focus, strict-mode multi-match the preflight didn't catch, …) | Playwright throws during `.click()` / `.fill()` / `.selectOption()` | `'interaction_failed'` (existing) | `'execution_error'` (existing) |

Two recovery signals for two semantically different failure modes:
- `'atom_resolution_failed'` → "the atom doesn't refer to anything anymore; re-observe or fall back to coordinates."
- `'execution_error'` (with `interaction_failed` source) → "the atom is real but couldn't be acted on; the page is in some weird state; consider waiting/observing/retrying."

### `ComputerObserveActions` tool wiring

```ts
function buildObserveActionsTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerObserveActions',
    description: 'List the interactive elements on the current page as ' +
      '{atomId, role, name, hint?}. Pass an atomId to ComputerActAtom instead of ' +
      'pixel coordinates when available.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    isMutating: false,
    isReadOnly: true,
    isConcurrencySafe: () => false,

    async validateInput(input) { return validateSessionId(deps, input.sessionId) },
    async call(input, _ctx, signal) {
      const lookup = resolveSession(deps, input.sessionId); if (!lookup.ok) return lookup.result
      try {
        const snap = await lookup.session.ariaSnapshot(signal)
        // Phase 4·2 redactionSelectors flow into the atom catalog the same way
        // they flow into the screenshot redactor — same predicate surface.
        const sensitiveRegions = await lookup.session.getSensitiveRegions(
          deps.settings.redactionSelectors, signal,
        )
        const url = lookup.session.currentUrl() ?? ''
        const cache = buildAtomCache(snap, url, { sensitiveRegions })
        lookup.session.setAtomCache(cache)
        return {
          content: serializeAtoms([...cache.entries.values()]),
          isError: false,
          // NO attachments — this is the load-bearing acceptance criterion.
        }
      } catch (err) { return mapBrowserSessionError(err) }
    },
  })
}
```

`buildAtomCache` calls `assignAtomIds` against the **raw** `snap.tree` (so `locatorName` survives), passing `sensitiveRegions` through. `serializeAtoms` redacts at emit time via `displayName`, where `displayName` already accounts for both `isSensitiveNode` (HTML semantic signals) and `nodeIntersectsRegion` (user-configured `redactionSelectors`). The `redactNodes` call from the Phase 4 plan is **NOT** part of this flow — that pre-redaction approach loses `locatorName`.

Permission posture: `'allow'` from `checkPermissions` (cascade falls through to allow rules / fallback ask). The safety check classifies the tool name as level 0 — observation only.

### `ComputerActAtom` tool wiring

```ts
function buildActAtomTool(deps: ComputerUseToolsDeps): Tool {
  return buildTool({
    name: 'ComputerActAtom',
    description: 'Perform a click/fill/select on the element identified by atomId. ' +
      'Call ComputerObserveActions first to discover atomIds. On atom_resolution_failed, ' +
      're-observe or fall back to ComputerClick / ComputerType.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        atomId: { type: 'string' },
        action: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['click', 'fill', 'select'] },
            button: { type: 'string', enum: ['left', 'middle', 'right'] },
            double: { type: 'boolean' },
            text: { type: 'string' },
            sensitive: { type: 'boolean' },
            value: { type: 'string' },
          },
          required: ['type'],
        },
      },
      required: ['sessionId', 'atomId', 'action'],
    },
    isMutating: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    getDomain: makeSessionGetDomain(deps),

    async validateInput(input) { /* sessionId + atomId + action shape; per-type required-fields */ },

    async call(input, _ctx, signal) {
      const lookup = resolveSession(deps, input.sessionId); if (!lookup.ok) return lookup.result
      const entry = lookup.session.lookupAtom(input.atomId as string)
      if (entry === null) {
        return errorResult(
          'atom_resolution_failed',
          `atom '${String(input.atomId)}' is not resolvable in this session. ` +
          `Call ComputerObserveActions to refresh the catalog, or fall back to ComputerClick / ComputerType.`,
        )
      }
      const locator = buildLocator(entry)
      const action = input.action as AtomAction
      const summary = formatAtomSummary(input.atomId as string, entry, action)
      try {
        return await runActionAndObserve(
          lookup.session, signal, summary,
          () => lookup.session.actOnAtom(locator, action, signal),
          { verify: deps.settings.verifyActions, attachScreenshot: false },
        )
      } catch (err) { return mapBrowserSessionError(err) }
    },
  })
}
```

`runActionAndObserve` opts widening (`ComputerTools.ts:315-374`):

```ts
async function runActionAndObserve(
  session: BrowserSession,
  signal: AbortSignal,
  prefix: string,
  action: () => Promise<void>,
  opts: { readonly verify: boolean; readonly attachScreenshot?: boolean },
): Promise<ToolResult> {
  // … existing pre-action capture …
  await action()
  await session.stabilize(signal)
  const result = await session.screenshot(signal)        // still runs — verify needs the bytes
  // … existing post-action ARIA cache refresh …
  // … existing verify branch with WARNING text …
  const attachScreenshot = opts.attachScreenshot ?? true
  return {
    content: formatObservationText(prefix, result) + warning,
    isError: false,
    ...(attachScreenshot ? { attachments: [result.attachment] } : {}),
  }
}
```

ActAtom is the only Phase 4b caller passing `attachScreenshot: false`. Coordinate tools keep the default `true` and so keep their post-action screenshots — no regression.

### Safety-check integration via `targetNode`

Extend `ClassifyContext` (`policy.ts:139-153`) with `targetNode?: AriaNode | null`. In `classifyAction`, add early-return cases:

```ts
if (toolName === 'ComputerObserveActions') {
  return { level: 0, category: 'observation', reason: 'observation tool' }
}
if (toolName === 'ComputerActAtom') {
  return classifyActAtom(input, ctx.targetNode ?? null)
}
```

`classifyActAtom` is the atom-aware peer of `classifyClick`/`classifyType`:

```ts
function classifyActAtom(input: Record<string, unknown>, target: AriaNode | null): RiskAssessment {
  const action = (input.action ?? {}) as { type?: string; sensitive?: boolean }
  if (target === null) {
    // Cache miss — ActAtom will error out at execute time with 'atom_resolution_failed'.
    // Classify level 1 so the cascade defers to allow rules / fallback ask for non-target
    // tools that share this code path. The actual deny happens in the tool's call body.
    return { level: 1, category: 'reversible_ui', reason: 'atomId not resolvable; cascade defers' }
  }
  if (action.type === 'fill') {
    if (action.sensitive === true || isSensitiveNode(target)) {
      return {
        level: 2, category: 'sensitive_input',
        reason: `fill on sensitive ${describeSensitiveSignal(target) ?? target.fieldType ?? 'field'}`,
        evidence: {
          fieldType: describeSensitiveSignal(target) ?? 'unknown',
          ...(target.name !== null && { nearbyText: target.name }),
        },
      }
    }
    return { level: 1, category: 'reversible_ui', reason: 'plain text fill' }
  }
  if (action.type === 'select') {
    return { level: 1, category: 'reversible_ui', reason: 'select option' }
  }
  // click — reuse classifyTarget so the dangerous-label regex fires identically
  return classifyTarget(target, 'actAtom click')
}
```

`computerSafetyChecks.ts` resolves the atom synchronously via `session.lookupAtom`:

```ts
const atomEntry =
  tool.name === 'ComputerActAtom' && typeof input.atomId === 'string'
    ? (session?.lookupAtom(input.atomId) ?? null)
    : null
const targetNode = atomEntry?.node ?? null

const assessment = classifyAction({
  toolName: tool.name, input, currentUrl, ariaSnapshot,
  ...(viewport && { viewport }),
  targetNode,
})
```

Cascade parity is preserved: same step-4 slot, same classifier, same `SafetyMetadata` envelope (`riskLevel`, `riskCategory`, `evidence`) flowing through to `permission_decision` events and the rich approval prompt. A `<button>Delete account</button>` triggers level-3 ask whether the model used `ComputerClick` or `ComputerActAtom`.

### Internal screenshot capture vs model image input

The acceptance criterion ("without the model receiving a screenshot for that turn") is unambiguous about the model side: ActAtom's `ToolResult.attachments` is empty. It does NOT say "do not capture a screenshot at all" — and it should not, because Phase 4·2's `verify` pipeline reads the post-action PNG bytes for the pHash backstop signal, and Phase 4·1's `lastAriaSnapshot` cache primes off `runActionAndObserve`'s post-action ARIA capture. Both still need to run on the ActAtom path so cascade parity is preserved (a stale `lastAriaSnapshot` would silently degrade the next safety check; a missing pHash signal would silently degrade verify).

So the cost story is:
- **Latency:** ActAtom pays the same `screenshot()` round-trip as a coordinate tool (~30-100ms locally). Removing the attachment doesn't remove the capture.
- **Tokens:** ActAtom pays zero image tokens — the attachment is dropped before serialization, and Anthropic/OpenAI never see the bytes.
- **Audit:** unchanged; `redactImageData` already strips bytes from audit envelopes whether or not they reach the model.

If a future phase wants to skip the capture entirely (e.g., Phase 6 evaluation surfaces ActAtom as latency-bound), the right path is a settings-gated `verifyActions: false` + a tool-level "skip ARIA refresh" hint, not removing the helper's screenshot call. That's out of scope here.

### Watch-mode — scoped to data already in the event envelope

The original plan called for `ComputerObserveActions` watch-mode lines like `observe-actions: <N> atoms`. Without extending `tool_call_finished` (which carries `toolName` + `resultPreview`), there's no place to ship that count structurally. Phase 4b keeps watch-mode within the existing envelope:

- `ComputerObserveActions` → the existing `[ComputerObserveActions] start … finish (Xms)` shape every other Computer tool already produces.
- `ComputerActAtom` → same shape, plus an input-derived summary on the `start` line. The atomId and action type are already in `tool_call_started.input`, so we render `[ComputerActAtom] start  actAtom(a-7 → click)` without event extension.

Names rendered to stderr always use `displayName` (redacted). `locatorName` never reaches the watch-mode renderer.

### `QueryEngine` registration — two `register()` calls

Inside the existing `if (computerUseSettings.enabled)` block (`QueryEngine.ts:299-329`):

```ts
this.toolRegistry.register(computerTools.observeActions)
this.toolRegistry.register(computerTools.actAtom)
```

Lazy Playwright import is unchanged — `actOnAtom` lives in `playwrightBrowserSession.ts`, covered by the same lazy chain. When Computer-Use is disabled, neither tool is registered, and `playwright` never loads.

### What does NOT change

- `src/core/query.ts` — no new event types, no new control flow.
- `src/core/messages.ts` / `normalizeMessages.ts` — no new block types; verification warnings keep riding in `content`.
- `src/audit/redactImageData.ts` — Phase 4b adds no audit envelope shape changes.
- `src/core/permissions/permissions.ts` — cascade contract unchanged; Phase 4b only adds inputs to the existing safety-check slot.
- `src/core/computer/coordinates.ts`, `verify.ts`, `redaction.ts`, `pHash.ts`, `stabilize.ts`, `storageStateStore.ts`, `ariaSnapshot.ts` — all consumed unchanged.
- Provider adapters — no changes.

## Schema

### `atomResolver.ts` exports

```ts
export const ACTIONABLE_ROLES: ReadonlySet<string>
export const BBOX_TOLERANCE_PX: number   // = 8

export type AtomEntry = {
  readonly atomId: string
  readonly role: string
  readonly displayName: string | null
  readonly locatorName: string | null
  readonly hint?: string
  readonly bbox?: BoundingBox
  readonly node: AriaNode
  readonly ancestorPath: readonly string[]
  readonly nth: number
}

export type AtomLocator = {
  readonly role: string
  readonly locatorName: string | null
  readonly nth: number
  readonly expectedBbox: BoundingBox | null   // for post-resolution drift check inside actOnAtom
}

export type AtomAction =
  | { readonly type: 'click'; readonly button?: 'left' | 'middle' | 'right'; readonly double?: boolean }
  | { readonly type: 'fill'; readonly text: string; readonly sensitive?: boolean }
  | { readonly type: 'select'; readonly value: string }

export type AssignAtomsOptions = {
  readonly sensitiveRegions?: readonly BoundingBox[]   // user redactionSelectors → bboxes; intersect with node.bbox to redact displayName
}

export function assignAtomIds(snapshot: AriaTreeSnapshot, opts?: AssignAtomsOptions): readonly AtomEntry[]
export function buildLocator(entry: AtomEntry): AtomLocator
export function serializeAtoms(entries: readonly AtomEntry[]): string
export function bboxesMatch(a: BoundingBox, b: BoundingBox, tolerancePx: number): boolean
```

### `selectorCache.ts` exports

```ts
export type SessionAtomCache = {
  readonly url: string
  readonly ariaHash: string
  readonly entries: ReadonlyMap<string, AtomEntry>
}

export type BuildAtomCacheOptions = {
  readonly sensitiveRegions?: readonly BoundingBox[]
}

export function buildAtomCache(
  snapshot: AriaTreeSnapshot,
  url: string,
  opts?: BuildAtomCacheOptions,
): SessionAtomCache
```

### `BrowserSession` additions (`src/core/computer/types.ts`)

```ts
export interface BrowserSession {
  // … existing Phase 2/3/4 fields …
  actOnAtom(locator: AtomLocator, action: AtomAction, signal: AbortSignal): Promise<void>
  setAtomCache(cache: SessionAtomCache): void
  lookupAtom(atomId: string): AtomEntry | null      // sync — for SafetyCheck
  currentAtomCache(): SessionAtomCache | null
}
```

### `BrowserSessionErrorKind` addition

```ts
export type BrowserSessionErrorKind =
  // … existing kinds …
  | 'atom_locator_failed'
```

### `ToolErrorKind` addition (`src/core/tools/types.ts`)

```ts
export type ToolErrorKind =
  // … existing kinds …
  | 'atom_resolution_failed'
```

### `ClassifyContext` widening (`src/core/computer/policy.ts`)

```ts
export type ClassifyContext = {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly currentUrl: string | null
  readonly ariaSnapshot?: AriaTreeSnapshot | null
  readonly viewport?: ComputerViewport
  readonly targetNode?: AriaNode | null     // NEW — set by computerSafetyChecks for ComputerActAtom
}
```

### `runActionAndObserve` opts widening (`src/tools/ComputerTools.ts`)

```ts
async function runActionAndObserve(
  session: BrowserSession,
  signal: AbortSignal,
  prefix: string,
  action: () => Promise<void>,
  opts: { readonly verify: boolean; readonly attachScreenshot?: boolean },   // attachScreenshot defaults to true
): Promise<ToolResult>
```

### `ComputerUseTools` extension

```ts
export type ComputerUseTools = {
  // … existing 11 tools …
  observeActions: Tool
  actAtom: Tool
}
```

## Files

### New

| Path | Purpose |
| --- | --- |
| `docs/ultron_v3/v3-phase4b-design.md` | This file |
| `src/core/computer/atomResolver.ts` | `ACTIONABLE_ROLES`, `BBOX_TOLERANCE_PX`, `AtomEntry`/`AtomLocator`/`AtomAction`/`AssignAtomsOptions`, `assignAtomIds(snapshot, opts?)` / `buildLocator` / `serializeAtoms` / `bboxesMatch` |
| `src/core/computer/atomResolver.test.ts` | DFS order; ACTIONABLE_ROLES filter; `nth` dedup; hint computation; `displayName` redaction (both `isSensitiveNode` and `sensitiveRegions` predicates); `locatorName` raw passthrough; `expectedBbox` populated; `bboxesMatch` truth table; locator round-trip |
| `src/core/computer/selectorCache.ts` | `SessionAtomCache`/`BuildAtomCacheOptions` types + `buildAtomCache(snapshot, url, opts?)` |
| `src/core/computer/selectorCache.test.ts` | Cache shape; replacement on `(url, ariaHash)` change; lookup hit/miss; `sensitiveRegions` opt forwards to `assignAtomIds` |

### Modified

| Path | Change |
| --- | --- |
| `src/core/tools/types.ts` | Add `'atom_resolution_failed'` to `ToolErrorKind` |
| `src/core/computer/types.ts` | Add `'atom_locator_failed'` to `BrowserSessionErrorKind`; add `actOnAtom` + `setAtomCache` / `lookupAtom` / `currentAtomCache` to `BrowserSession` |
| `src/core/computer/playwrightBrowserSession.ts` | Implement four new methods; `actOnAtom` runs two preflights (`count() === 0` AND bbox-drift); both raise `'atom_locator_failed'` with generic messages (no `locatorName` echo); clear `_atomCache` in `close()` and `navigate()` |
| `src/core/computer/playwrightBrowserSession.test.ts` | Wiring tests; cache lifecycle; preflight zero-match path; bbox-drift path |
| `src/core/computer/playwrightBrowserSession.integration.test.ts` | `actOnAtom` happy-path; `nth` disambiguation; preflight failure on element removal; preflight failure on duplicate-name shuffle (silent retarget) |
| `src/core/computer/policy.ts` | Add `targetNode?: AriaNode \| null` to `ClassifyContext`; level-0 short-circuit for `ComputerObserveActions`; `classifyActAtom` |
| `src/core/computer/policy.test.ts` | New cases per "classifier truth table" in §"Verification" |
| `src/core/permissions/computerSafetyChecks.ts` | Resolve `atomId → AriaNode` via `session.lookupAtom`; pass `targetNode` to `classifyAction` |
| `src/core/permissions/computerSafetyChecks.test.ts` | New ActAtom cases (cached delete-button; cached password input; missing session; missing atomId) |
| `src/tools/ComputerTools.ts` | `buildObserveActionsTool` (calls `getSensitiveRegions(settings.redactionSelectors)` and forwards through `buildAtomCache`) + `buildActAtomTool`; extend `ComputerUseTools` + `createComputerUseTools` return; widen `runActionAndObserve` opts with `attachScreenshot?: boolean`; extend `mapBrowserSessionError` so `'atom_locator_failed'` returns `'atom_resolution_failed'` with a self-composed recovery message that does NOT echo the source error text |
| `src/tools/ComputerTools.test.ts` | Tool tests per §"Verification"; cache-miss + locator-failure paths; `attachScreenshot: false` confirmed for ActAtom; `redactionSelectors` propagation; locator-failure recovery message contains no raw `locatorName` |
| `src/sdk/QueryEngine.ts` | Two `toolRegistry.register(...)` calls inside the `computerUseSettings.enabled` block |
| `src/sdk/QueryEngine.test.ts` | Registry presence/absence assertion |
| `src/ui/computerWatchMode.ts` | Tool-name dispatch entries for `ComputerObserveActions` + `ComputerActAtom` (basic start/finish; ActAtom adds input-derived summary on `start`); displayName-only |
| `src/ui/computerWatchMode.test.ts` | New rendering cases |

## Implementation order

Single PR.

1. Write this design doc; pause for user review.
2. Add `atomResolver.ts` (`ACTIONABLE_ROLES`, `BBOX_TOLERANCE_PX`, types, `assignAtomIds(snap, opts?)` honoring `sensitiveRegions` for displayName redaction, `buildLocator` populating `expectedBbox`, `serializeAtoms`, `bboxesMatch`) + tests. Pure module — shippable in isolation against fixture `AriaTreeSnapshot` values.
3. Add `selectorCache.ts` (`SessionAtomCache`, `BuildAtomCacheOptions`, `buildAtomCache(snap, url, opts?)` forwarding to `assignAtomIds`) + tests.
4. Add `'atom_resolution_failed'` to `ToolErrorKind` and `'atom_locator_failed'` to `BrowserSessionErrorKind`. One-line type additions; confirms the type system is honest before runtime callers exist.
5. Widen `BrowserSession` with `actOnAtom` + cache trio. Update fakes in tests with TODO-throwing defaults.
6. Implement the four new methods in `PlaywrightBrowserSession`. `close()` and `navigate()` null the cache. `actOnAtom` runs two preflights — `count()` zero-match AND `boundingBox()` drift against `locator.expectedBbox` — both raise `'atom_locator_failed'` with **generic** messages (no `locatorName` echo).
7. Extend `policy.ts` with `targetNode` and `classifyActAtom`. Unit-test against synthetic `AriaNode`s for each (action, target) permutation.
8. Extend `computerSafetyChecks.ts` to resolve `atomId → AriaNode` and pass `targetNode` to `classifyAction`. Confirm existing tests pass; add ActAtom cases (delete-button, password input, missing session).
9. Add `buildObserveActionsTool` + `buildActAtomTool` in `ComputerTools.ts`. ObserveActions calls `getSensitiveRegions(settings.redactionSelectors)` and forwards through `buildAtomCache`. Extend `mapBrowserSessionError` with the `'atom_locator_failed'` route — write a self-composed recovery message that does NOT echo the source error text. Widen `runActionAndObserve` opts with `attachScreenshot?: boolean`. Tool tests assert no attachments on Observe and `'atom_resolution_failed'` surface on cache miss + locator failure.
10. Two `register(...)` calls in `QueryEngine`. Engine test asserts presence/absence.
11. Watch-mode dispatch entries (use `displayName` only; never echo `locatorName`).
12. Integration tests (env-gated `ULTRON_PLAYWRIGHT_INTEGRATION=1`) — eight cases per §"Verification" (added bbox-drift retarget + redactionSelectors-redacted-name parity).
13. `npm run typecheck` + `npm run test` + integration suite — all green.

## Verification

### Unit tests

- **`atomResolver.test.ts`**
  - DFS order matches structural order (assignAtomIds against a fixture tree).
  - Only `ACTIONABLE_ROLES` nodes get ids; `heading`, `landmark`, `list`, `img` skipped.
  - Duplicate `(role, locatorName)` pairs receive monotonic `nth`.
  - `hint` resolves to the nearest named non-`generic` non-`group` ancestor; `undefined` when none exists.
  - `displayName === '[REDACTED]'` for `isSensitiveNode` matches; `displayName === node.name` otherwise.
  - `displayName === '[REDACTED]'` when `node.bbox` intersects any `sensitiveRegions` entry passed via `opts`, even if `isSensitiveNode` returns false (covers user-configured `redactionSelectors`).
  - `displayName === '[REDACTED]'` when `node.bbox` is `null` AND the node would otherwise be eligible for region-based redaction (fail-closed for unmappable nodes that can't be intersection-checked).
  - `hint` is also redacted at emit when its source ancestor matches either predicate (no leak via hint).
  - `locatorName` always equals raw `node.name`, regardless of redaction.
  - `serializeAtoms` emits `displayName`, never `locatorName`; round-trip parsing of YAML output preserves all `id`/`role`/`name`/`hint` fields.
  - `buildLocator` populates `role`/`locatorName`/`nth`/`expectedBbox` from the entry; `expectedBbox === null` when `entry.bbox === undefined`.
  - `bboxesMatch` truth table — identical bbox → true; ±tolerance shift on each axis → true; tolerance+1 shift → false; same x/y but width/height differ past tolerance → false.
- **`selectorCache.test.ts`**
  - `buildAtomCache(snapshot, url)` returns a cache whose `entries.size` matches `assignAtomIds(snapshot).length`.
  - `entries.get('a-N')` returns the entry for hit; `entries.get('a-99')` returns `undefined` for miss.
  - Two snapshots with different `(url, ariaHash)` produce caches with different identities (no implicit sharing).
- **`policy.test.ts` additions**
  - `ComputerObserveActions` → level 0, category `'observation'`.
  - `ComputerActAtom { click }` on `<button>Submit</button>` → level 3 with `evidence.nearbyText: 'Submit'`.
  - `ComputerActAtom { click }` on `<button>Delete account</button>` → level 3.
  - `ComputerActAtom { click }` on `<button>Sign in</button>` → level 1 (benign click).
  - `ComputerActAtom { fill }` on `password` textbox → level 2 with `evidence.fieldType: 'password'`.
  - `ComputerActAtom { fill }` on `cc-number` text input → level 2 (autocomplete-driven).
  - `ComputerActAtom { fill }` with `sensitive: true` on benign textbox → level 2.
  - `ComputerActAtom { fill }` with `sensitive: false`/unset on benign textbox → level 1.
  - `ComputerActAtom { select }` → level 1 regardless of target.
  - `targetNode === null` (cache miss) → level 1 (cascade defers; ActAtom errors out at execute time).
- **`computerSafetyChecks.test.ts` additions**
  - `ComputerActAtom` with no session → returns `null` (no-op, defer).
  - `ComputerActAtom` with cached `<button>Delete</button>` node → `'ask'` with `metadata.riskLevel === 3`.
  - `ComputerActAtom { fill }` with cached password node → `'ask'` with `metadata.riskLevel === 2`, `metadata.evidence.fieldType: 'password'`.
  - `ComputerActAtom` with `input.atomId` not a string → `targetNode === null` path; classifier returns level 1; cascade defers.
- **`playwrightBrowserSession.test.ts` additions**
  - `setAtomCache` then `lookupAtom` round-trip; `currentAtomCache` returns the cache.
  - `lookupAtom('a-99')` returns `null` on miss.
  - `close()` nulls the cache (`currentAtomCache() === null` afterward).
  - `navigate()` nulls the cache.
- **`ComputerTools.test.ts` additions**
  - `ComputerObserveActions` returns `attachments === undefined` and content shaped like the documented YAML.
  - `ComputerActAtom` with unknown atomId → `errorKind: 'atom_resolution_failed'` with recovery text mentioning ComputerObserveActions and ComputerClick.
  - `ComputerActAtom` happy-path click routes through `runActionAndObserve` with `attachScreenshot: false` → result has `attachments === undefined`.
  - `ComputerActAtom` with `verify: true` and a stubbed no-op `actOnAtom` produces a WARNING (no page change).
  - `mapBrowserSessionError(BrowserSessionError('atom_locator_failed', …))` returns `{errorKind: 'atom_resolution_failed', …}` with the locator-zero-match recovery text.
- **`QueryEngine.test.ts` additions**
  - Registry contains `'ComputerObserveActions'` and `'ComputerActAtom'` when `computerUse.enabled === true`.
  - Both are absent when disabled; the lazy Playwright import never fires.
- **`computerWatchMode.test.ts` additions**
  - `tool_call_started` for `ComputerActAtom` renders the `actAtom(a-7 → click)` summary on the start line.
  - `tool_call_started` for `ComputerObserveActions` renders the basic `[ComputerObserveActions] start` line.
  - Renderer never emits `locatorName` strings.

### Integration tests (env-gated `ULTRON_PLAYWRIGHT_INTEGRATION=1`)

1. **No model image input on the ActAtom turn.** Start → Navigate to fixture with `<button aria-label="Sign in">` → `ComputerObserveActions` (assert `attachments === undefined`; YAML lists the button as an atom; safety check classifies the observation as level 0) → `ComputerActAtom({type: 'click'})` succeeds AND the recorded tool result has `attachments === undefined` (acceptance: no image input reaches the model on this turn — internal screenshot capture for verify still runs).
2. **Cache hit replay.** Two consecutive `ComputerActAtom` calls without a re-observe between them — both succeed; `currentAtomCache().ariaHash` matches before/after the first action (page didn't structurally change).
3. **Cache miss for unknown atomId.** ObserveActions → `ComputerActAtom` with an atomId never assigned (e.g. `'a-99'`) → returns `'atom_resolution_failed'` synchronously, without touching the page (assert via Playwright route interception that no extra page interaction occurred).
4. **Locator preflight zero-match after element removal.** ObserveActions → trigger DOM mutation that REMOVES the cached atom's target element (e.g. `page.evaluate(() => document.querySelector('button[aria-label="Sign in"]')?.remove())`) → `ComputerActAtom({atomId: 'a-0', type: 'click'})` → `actOnAtom` preflight `count() === 0` → `BrowserSessionError('atom_locator_failed', 'locator resolved zero elements')` → `mapBrowserSessionError` → `errorKind: 'atom_resolution_failed'` with the generic recovery message; assert the result `content` does NOT contain the original button's accessible name → `ComputerClick` (coordinate fallback) at the original coords reaches the page successfully.
5. **Bbox-drift detection (silent retarget).** Fixture with two `<button>Save</button>` instances; observe → cache assigns the second one as `nth: 1` with its bbox → DOM mutation INSERTS a new earlier `<button>Save</button>` (count stays ≥ 2; nth:1 now points to what was previously nth:2 — a different element with a different bbox) → `ComputerActAtom({atomId: <second-Save>, type: 'click'})` → preflight `count()` passes → `boundingBox()` returns the new element's bbox → `bboxesMatch === false` → `BrowserSessionError('atom_locator_failed', 'locator bbox drift exceeds tolerance')` → `errorKind: 'atom_resolution_failed'`. The original second button is never clicked.
6. **Cascade parity.** `ComputerActAtom({click})` on `<button>Delete account</button>` triggers level-3 ask under `bypassPermissions`, identical to `ComputerClick` on the same coords. Audit row carries `safetyMetadata.riskLevel === 3`.
7. **Redacted-name locator parity (HTML-semantic).** Fixture with `<input type="password" aria-label="Password">` → `ComputerObserveActions` (assert serialized YAML shows `name: "[REDACTED]"`; `entry.locatorName === 'Password'` in the cache, never reaches the model) → `ComputerActAtom({type: 'fill', text: 'hunter2', sensitive: true})` → safety check fires level-2 ask (because `isSensitiveNode(targetNode)` matches the raw node) → on approval, `actOnAtom` calls `getByRole('textbox', {name: 'Password'}).fill('hunter2')` and the input value is set correctly.
8. **Redacted-name parity for user `redactionSelectors`.** Fixture with `<button aria-label="Card 4242 ending 4242" class="payment-card-display">…</button>` and `computerUseSettings.redactionSelectors: ['.payment-card-display']` → `ComputerObserveActions` calls `getSensitiveRegions(['.payment-card-display'])` → returns the button's bbox → `assignAtomIds` sees the bbox intersection → emits `name: "[REDACTED]"` while keeping `locatorName: 'Card 4242 ending 4242'` in the cache → `ComputerActAtom({type: 'click'})` resolves via `getByRole('button', {name: 'Card 4242 ending 4242'})` and clicks correctly. Model never sees the raw text.

### Manual smoke

1. `npm run typecheck` — clean.
2. `npm run test` — green (full unit suite).
3. `ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run src/core/computer/ src/tools/` — green.
4. Programmatic check: enable `computerUse.enabled: true`, point at a benign allowlisted page, observe with `ComputerObserveActions`, click a non-dangerous atom via `ComputerActAtom` (no approval); attempt `ComputerActAtom({type: 'click'})` on a `<button>Delete</button>` (rich approval prompt with `riskLevel: 3` and the redacted name in the prompt body).

## Open questions (resolve during implementation, not blocking design)

1. **Re-snapshot vs reuse `lastAriaSnapshot()` in `ComputerObserveActions`.** Current proposal: re-snapshot unconditionally for freshness. The cheaper alternative — reuse the cached snapshot if it is < N ms old or if `verify` hasn't reported a change since — would let observe-act-observe sequences amortize one ARIA capture. Defer to Phase 6 evaluation; current shape is correct under all conditions.
2. **`ComputerNavigate` clearing the atom cache.** The plan clears in `navigate()` so a sequence `Observe → Navigate → ActAtom` always reaches the cache-miss path. Alternative: rely on the next `ObserveActions` to overwrite. The eager-clear is safer (matches the "cache can never name an element on a different URL" invariant); accepted.
3. **`ActAtom { fill }` against a `<select>`.** Current proposal: strict — Playwright surfaces an interaction error, mapped to `'execution_error'`. Documenting that `select` is the right action for combobox-role atoms is a Phase 5 prompt-tuning item; no Phase 4b code change.
4. **Watch-mode line for ActAtom on a redacted-name atom.** Current proposal: pass `displayName` through (`'[REDACTED]'`). Alternative: render `<sensitive>` or role-only. The pass-through preserves model-facing parity (the model sees `[REDACTED]` and so does the operator) and is what the existing `permissionPrompt` Computer branch already does for sensitive type events.
5. **`serializeAtoms` token-budget cap.** Pages with hundreds of `listitem`/`option` atoms (e.g. long combobox dropdowns) could blow past sensible context budgets. Defer to Phase 5 prompt-tuning unless integration tests surface a real breakage.
6. **Iframe-rooted atoms.** Phase 4·1's ARIA walker is top-document only. A same-origin iframe's `<button>Sign in</button>` is invisible to the catalog; Playwright's `getByRole` could still resolve it (it traverses iframes by default), but `atomId` won't exist for it. The cache-miss path handles it cleanly. Phase 6 evaluation may surface a real iframe story; out of scope for Phase 4b.

## Out of scope (mirrors v3 roadmap)

- System-prompt guidance to bias the model toward the atom path (`<untrusted-page-text>` delimiter rule continues to be Phase 5's responsibility). — **Phase 5**.
- Eval fixtures (deterministic local pages, prompt-injection, dangerous-action). — **Phase 6**.
- Native OpenAI / Anthropic CUA bridges (when shipped, they translate native `computer_call` items into `ComputerAction` and route through the same `ComputerSession` — including the new atom path when applicable). — **Stretch Phase**.
- Iframe-rooted atoms — top-document only; documented Phase 6 follow-up.
- Fuzzy atomId rebinding across page mutations — fail-fast is the v3 contract; Phase 6 evaluation may revisit.
- `serializeAtoms` token-budget cap — Phase 5 prompt-tuning unless Phase 6 evals surface a real breakage.
- Watch-mode atom-count rendering on `ObserveActions` finish line — would need event-envelope extension; deferred.
