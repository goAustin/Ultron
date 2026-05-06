# v3 Phase 4 Design: Policy, Safety Checks, And Watch Mode

## Status

Pre-implementation. Plan file: `~/.claude/plans/now-make-a-plan-deep-glade.md`. Roadmap: `docs/ultron_v3/v3-computer-use-plan.md` (Phase 4 deliverables, lines 636–662). Predecessors: Phase 0/1/2/3 (substrate, image attachments, browser session, 11 Computer tools — all landed). Successors: Phase 4b (DOM-first atom path — depends on `ariaSnapshot.ts` shipping here), Phase 5 (system-prompt guidance — depends on safety-check + verify telemetry).

## Context

Phases 0–3 shipped a complete but **safety-naive** Computer-Use spine: the model can drive a sandboxed browser, but every action runs at "fallback ask" with no risk awareness. A model deciding to click `Submit` on a payment form gets the same prompt as scrolling a wiki — even though one is irreversible. Password fields appear in screenshots verbatim. A click that lands on an overlay returns "success" because Playwright's `mouse.click` resolved cleanly, even though nothing on the page actually changed. And `ComputerHandoffToUser` requires the user to log in again every run because Phase 3 deferred `storageState` snapshotting.

Phase 4 closes those gaps. It is the **policy, verification, and observability** phase — the safety stack that turns the Phase 3 substrate from "demo-grade" into "lets you click Submit on a real site."

Phase 4 satisfies five of the six v3-roadmap acceptance criteria (`docs/ultron_v3/v3-computer-use-plan.md:656–662`):

1. `Submit`, `Delete`, `Send`, `Pay`, and similar actions require approval even under permissive modes.
2. Headless mode denies actions that would require approval.
3. Password-field screenshots are redacted.
4. **Moved to Phase 5.** "Prompt-injection fixture pages do not get to override the user's task" requires the `<untrusted-page-text>` system-prompt delimiter rule, which Phase 5 owns (`v3-computer-use-plan.md:695–697`). Phase 4's contribution is foundational — the safety check loads ARIA *structure* (roles, names, bboxes) for risk classification, never raw page text — so policy decisions are not influenced by injected instructions. The acceptance criterion as worded is Phase 5 territory.
5. Audit rows contain metadata but not raw screenshot bytes. *(Already satisfied by Phase 1's `redactImageData`; Phase 4 adds new safety-decision metadata via widened cascade types — see "Decision metadata propagation" below.)*
6. `verify.ts` is wired into action tools: a click on an overlay-blocked button returns `verified: false`, not a false success.

It also clears Phase 4b's prerequisite (`ariaSnapshot.ts` + `verify.ts`), and finishes the `ComputerHandoffToUser` story (`storageState` snapshot/rehydrate, deferred from Phase 3 — `docs/ultron_v3/v3-phase3-design.md:44`).

## Phase 1/2/3 prerequisites

- Phase 1 — `ToolResultAttachment` (`src/core/tools/imageAttachment.ts`) carries `width`/`height` already; Phase 4's pHash backstop reads those without extending the type.
- Phase 1 — `redactImageData` (`src/audit/redactImageData.ts`) strips screenshot bytes from audit envelopes; Phase 4 adds a new `safetyMetadata` field to `permission_decision` events that rides through the same redactor unchanged.
- Phase 2 — `BrowserSession` interface (`src/core/computer/types.ts:80–110`) is the seam Phase 4 extends with `ariaSnapshot()` and `getSensitiveRegions()`. `_page` stays private; Phase 4 does NOT bypass that.
- Phase 2 — `policy.ts` already exposes `isDomainAllowed` + `isUrlSchemeAllowed`; the file's docstring (`policy.ts:10`) explicitly reserves room for the Phase 4 risk classifier.
- Phase 2 — `stabilize.ts` ships steps 1–4 of the v3 stack; step 5 ("sample two ARIA snapshots ~250ms apart") is deferred there with a comment pointing at Phase 4 (`stabilize.ts:11`).
- Phase 3 — `observeAndPack` (`src/tools/ComputerTools.ts:294–307`) is the central post-action seam where Phase 4's verify pipeline plugs in. Phase 3 also reserved the `sensitive: boolean` flag on `ComputerType` as advisory-only with an explicit Phase 4 enforcement comment.
- Phase 3 — `permissionOpts.safetyChecks: [...filesystemSafetyChecks]` (`src/sdk/QueryEngine.ts:348`) is the slot Phase 4 extends with `computerUseSafetyChecks`. The cascade-step-4 (`permissions.ts:111–117`) machinery is the only contract Phase 4 must honor.
- Phase 3 — `ComputerHandoffToUser.call` (`src/tools/ComputerTools.ts:927–937`) currently captures a screenshot on resume and stops; Phase 4 extends it with `context.storageState()` snapshotting.

## Goals

1. **Risk classification.** Add `classifyAction(toolName, input, context): RiskAssessment` to `policy.ts`. Detect dangerous labels (`Submit / Delete / Send / Pay / Confirm / Invite / Publish / Transfer / Disable / Remove`) at click targets, password/MFA/payment fields at type targets, and the `sensitive: true` advisory flag on `ComputerType`.
2. **Non-bypassable safety check.** Wire a `computerUseSafetyCheck` into `permissionOpts.safetyChecks` so the cascade fires it at step 4 — BEFORE explicit allow rules (step 6) and BEFORE permission-mode bypass (step 5). `bypassPermissions` mode cannot escape it.
3. **Richer ask payload.** Extend the cascade's `'safetyCheck'` reason carrier so the approval prompt can render: tool name, sessionId, current URL, action summary, risk level + reason, optional nearby-text excerpt, optional screenshot preview path.
4. **Password & selector redaction.** Add `src/core/computer/redaction.ts` (pure pixel-blackout helpers) + a new `BrowserSession.getSensitiveRegions(extraSelectors, signal)` method. Modify `screenshot()` to apply blackouts before `validateImageAttachment`, so the redacted PNG is what reaches the model AND audit (`redacted: true` flag was already reserved by Phase 1).
5. **ARIA snapshot infrastructure.** Add `src/core/computer/ariaSnapshot.ts` (serialize, hash, token-truncate, redact) + a new `BrowserSession.ariaSnapshot(signal)` method. Wire step 5 of the stabilization stack (sample two snapshots 250ms apart) into `stabilize.ts`.
6. **Post-action verification.** Add `src/core/computer/verify.ts` with the **ARIA-diff** primary signal and an **image pHash backstop** (no SSIM in v3 — see "Verification scope" below). Wire it into a new `runActionAndObserve(session, signal, prefix, action)` helper in `ComputerTools.ts` that replaces the current `observeAndPack` pattern. A click that doesn't change the page surfaces `verified: false` in the result text; the model can then re-observe and retry instead of advancing.
7. **CLI watch-mode.** Add `src/ui/computerWatchMode.ts` — an event subscriber that renders Computer-tool activity to stderr (current URL, proposed action, risk level, screenshot preview path). Off by default; gated on `computerUse.watchMode: true` AND `process.stderr.isTTY`.
8. **HandoffToUser completion.** On resume, snapshot `context.storageState()` to a per-domain JSON file under `~/.ultron/computer-storage/<sha256(host)>.json`. Future `ComputerStart` calls for the same site auto-rehydrate, skipping the handoff. Gated on `computerUse.allowAuthHandoff: true`; cleared by `ComputerStop` when `persistProfiles: false`.

## Non-goals

- **No SSIM in v3.** The v3 plan lists masked-pixel SSIM as one of three verify signals (`v3-computer-use-plan.md:308–313`). Phase 4 ships only ARIA-diff (primary) + pHash (backstop) — see "Verification scope" below for the rationale. SSIM lands later if/when image-processing deps become unavoidable.
- **No new image-processing native dep.** No `sharp`, no `jimp`. The pHash implementation runs against PNG bytes via a tiny in-tree decoder (Phase 4-internal, not exported). If pHash proves insufficient in evaluation (Phase 6), the upgrade path is documented.
- **No DOM-first atom path.** `ComputerObserveActions` / `ComputerActAtom` are Phase 4b. Phase 4 ships only the substrate (`ariaSnapshot.ts`) they will reuse.
- **No system-prompt changes.** Phase 5 owns Computer-Use prompting, including the `<untrusted-page-text>` delimiter rule. Phase 4's safety stack is the *enforcement* layer; the prompt layer that *informs the model* is separate.
- **No native provider bridges.** Stretch Phase.
- **No managed-stealth or container-desktop profiles.** Profiles B/C remain future environment adapters under the same `BrowserSession` interface.
- **No new audit envelope shape.** The existing `permission_decision` event (`src/core/queryEvents.ts:59–69`) gains an optional `safetyMetadata` field; no new top-level event type.
- **No watch-mode interactivity.** Watch-mode is read-only display. Approval prompts continue to flow through `src/ui/permissionPrompt.ts` unchanged.
- **No eval fixtures.** Phase 6 owns the deterministic local test pages.

## Implementation sub-batches

Phase 4's scope is the largest of the v3 phases. To keep PRs reviewable and let the user see incremental safety value, Phase 4 ships in **three batches**, each independently mergeable.

**Re-shuffled from the initial draft (review feedback):** ARIA snapshot infrastructure was originally slated for Batch 4·2 alongside verify. That left Batch 4·1's safety check unable to classify `ComputerClick` targets — the synchronous safety check has only `{toolName, x, y, currentUrl}` and no way to ask "what's at that coordinate?". Without ARIA evidence at click time, the headline "Submit/Pay/Delete approval" claim is half-true (it works for `ComputerNavigate` URL-classification and `ComputerType` sensitive-flag classification, but not for clicks). ARIA infrastructure now lands in Batch 4·1; the verify pipeline (which also needs ARIA) follows in Batch 4·2.

### Batch 4·1 — Policy, ARIA, safety check, approval payload (the headline)

Delivers acceptance criteria 1, 2, 5. After this batch, `Submit / Pay / Delete` actions require approval even under `bypassPermissions`, headless denies them, the audit log records which check fired with structured `metadata` (risk level, category, evidence), and the approval prompt renders rich Computer-tool context.

Includes the ARIA substrate the safety check depends on:
- `src/core/computer/ariaSnapshot.ts` — structured `AriaNode` tree + `serializeToYaml` + `hashTree` + `findAtPoint` (see "Structured ARIA contract" below).
- `BrowserSession.ariaSnapshot()` returning `{ tree, yaml, hash }`.
- `BrowserSession.lastAriaSnapshot()` — synchronous accessor returning the most recent successful capture (or `null`), so the synchronous safety check can read structured ARIA without an async hop.
- A modest cache update inside `observeAndPack` (and any new wrapping helper) that captures an ARIA snapshot opportunistically after each `screenshot()`.

**No** redaction, **no** verify pipeline, **no** watch-mode, **no** storageState yet. Phase 4b's atom path also benefits from the `AriaNode` tree shipping here — but the atom-path tools themselves remain in 4b.

### Batch 4·2 — Redaction + verify pipeline

Delivers acceptance criteria 3, 6. Adds:
- `src/core/computer/redaction.ts` (sensitive-region detection + bbox blackout + minimal PNG re-encode).
- `src/core/computer/verify.ts` (ARIA-diff primary signal + image pHash backstop — see "Verification scope").
- `src/core/computer/pHash.ts` (in-tree, no new deps).
- `BrowserSession.getSensitiveRegions()`.
- Refactor `observeAndPack` → `runActionAndObserve` (pre/post ARIA capture wired through verify).

After this batch, password-field screenshots are blacked out and overlay-blocked clicks return `verified: false` in the result content.

### Batch 4·3 — Watch-mode + Handoff completion

Delivers `computerUse.watchMode` + `src/ui/computerWatchMode.ts`, and finishes `ComputerHandoffToUser` with `storageState` snapshot/rehydrate. Includes:
- `initialUrl?: string` field on `ComputerStart` so rehydration has a domain to look up at session-start time (see "Storage-state rehydration" below).
- `persistProfiles: true` (existing setting field) gates writing storageState. `allowAuthHandoff` continues to gate "can the tool fire."
- `src/core/computer/storageStateStore.ts` (sha256-keyed per-domain JSON files under `~/.ultron/computer-storage/`).
- Watch-mode wired as a fan-out at the **CLI's event-consumption point**, not a fictional `engine.queryEvents` subscriber (see "Watch-mode integration point" below).

Each batch lands as its own commit with its own design-doc revision in this file (Status section + "completed batches" table). The user reviews each batch before the next starts.

## Key design decisions

### Risk classifier — extend `policy.ts`, not a new module

`policy.ts:10` already documents the Phase 4 risk-classifier extension as a planned same-file addition. Splitting into `riskClassifier.ts` would split the cohesive "what is allowed at the URL/action layer" responsibility into two files for no boundary win. The classifier reads the same settings shape and emits the same discriminated-union result style as `isDomainAllowed`.

```ts
// src/core/computer/policy.ts (additions)

export type RiskLevel = 0 | 1 | 2 | 3 | 4

export type RiskCategory =
  | 'observation'        // level 0: screenshot, wait
  | 'reversible_ui'      // level 1: scroll, navigate-allowlisted, harmless click
  | 'sensitive_input'    // level 2: password / token / MFA / PII
  | 'irreversible'       // level 3: Submit / Delete / Send / Pay / Confirm / Transfer / Publish
  | 'prohibited'         // level 4: CAPTCHA bypass, evade access controls

export type RiskAssessment = {
  readonly level: RiskLevel
  readonly category: RiskCategory
  readonly reason: string                                        // short, user-facing
  readonly evidence?: { readonly nearbyText?: string; readonly fieldType?: string }
}

export type ClassifyContext = {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly currentUrl: string | null
  // The most recent ARIA snapshot, if available. Phase 4·1 lands the
  // classifier with `ariaSnapshot: undefined` (label detection falls back to
  // the input's text/url alone). Batch 4·2 wires the ARIA context after
  // ariaSnapshot.ts ships.
  readonly ariaSnapshot?: string
}

export function classifyAction(ctx: ClassifyContext): RiskAssessment
```

`classifyAction` returns a level-0 assessment for `ComputerObserve`/`ComputerWait`, level-1 for `ComputerScroll`/`ComputerNavigate`-when-domain-already-allowed, level-2 for `ComputerType` when `sensitive: true` OR when ARIA evidence shows a password/MFA/payment field at the inferred target, level-3 for `ComputerClick` when the target's accessible name matches a dangerous-label regex (`/^(submit|delete|send|pay|purchase|confirm|invite|publish|transfer|disable|remove)\b/i`), and level-4 only for explicit CAPTCHA-evasion-style requests (defined narrowly — see "Level 4 boundary" below).

**Why not return `PermissionDecision` directly?** The classifier is a pure data function. Wrapping the classifier output into a `PermissionDecision` happens in `computerSafetyChecks.ts` so the cascade contract stays in one file, and the classifier is reusable by watch-mode (which wants the level/reason but not the cascade interaction).

### Safety-check wiring — non-bypassable, runs before allow rules

Phase 3's permission posture is `'allow'` from `checkPermissions` for every Computer tool except `ComputerHandoffToUser` (`ComputerTools.ts:10–16`). The cascade then falls through to step 6 (allow rules) and step 7 (fallback ask). Phase 4 inserts at **step 4** (safety checks):

```ts
// src/core/permissions/computerSafetyChecks.ts (new)

export function makeComputerUseSafetyCheck(
  deps: {
    readonly settings: ComputerUseSettings
    readonly sessionManager: ComputerSessionManager   // for currentUrl + ARIA lookup
  },
): SafetyCheck {
  return (tool, input, _ctx) => {
    if (!tool.name.startsWith('Computer')) return null            // not our concern
    const sessionId = input.sessionId
    const session = typeof sessionId === 'string'
      ? deps.sessionManager.get(sessionId as ComputerSessionId)
      : undefined
    const currentUrl = session?.currentUrl() ?? null
    const ariaSnapshot = session?.lastAriaSnapshot?.() ?? undefined

    const assessment = classifyAction({ toolName: tool.name, input, currentUrl, ariaSnapshot })

    if (assessment.level === 4) {
      return {
        behavior: 'deny',
        reason: { type: 'safetyCheck', message: `denied (level 4 ${assessment.category}): ${assessment.reason}` },
      }
    }
    if (assessment.level >= 2) {
      return {
        behavior: 'ask',
        reason: { type: 'safetyCheck', message: formatAskMessage(tool.name, assessment, session) },
      }
    }
    return null   // levels 0, 1: defer to the rest of the cascade
  }
}
```

**Why `null` for levels 0/1?** The cascade contract — returning `null` means "no opinion, continue." Levels 0/1 fall through to step 5 (mode), step 6 (allow rules), step 7 (fallback ask). Per-host allow rules still work; `bypassPermissions` still works for the harmless majority. Only level 2/3/4 are non-bypassable.

**`session.lastAriaSnapshot()` — sync accessor for structured ARIA.** Batch 4·1 adds this to the `BrowserSession` interface as `lastAriaSnapshot(): AriaTreeSnapshot | null` (returns the most recent successful capture). The classifier reads it synchronously inside the safety check; safety checks must be sync per `permissions.ts:112–117`. Returning a structured tree (not just a string) is what enables coord-based click classification — see "Structured ARIA contract" below.

### Decision metadata propagation — widen the cascade types end-to-end

The initial draft of this design described "the audit envelope gets `safetyMetadata`" without specifying the carrier. Review feedback flagged that today's `PermissionDecisionReason.safetyCheck` is `{ type: 'safetyCheck'; message: string }` (`permissions/types.ts:34`) and `AskUserFn` takes only `(toolName, input, reason: string, signal)` (`permissions/types.ts:67–72`) — so without explicit type widening, the metadata has nowhere to ride. Phase 4 widens both:

```ts
// src/core/permissions/types.ts (widened)

export type SafetyMetadata = {
  readonly checkName: 'computerUseSafetyCheck'
  readonly riskLevel: RiskLevel
  readonly riskCategory: RiskCategory
  readonly evidence?: { readonly nearbyText?: string; readonly fieldType?: string }
}

export type PermissionDecisionReason =
  // ... unchanged ...
  | { type: 'safetyCheck'; message: string; metadata?: SafetyMetadata }
  // ... unchanged ...

export type AskUserFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
  opts?: { readonly metadata?: SafetyMetadata },     // ← new optional fifth arg
) => Promise<'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'>
```

Both fields are **optional**, so existing callers (filesystem safety checks, MCP-tool checks, all the `askUser` consumers) are untouched. The cascade caller passes `metadata` from the decision's reason to `askUser`; the `permission_decision` event reads `metadata` from the same source. Audit rows get structured fields, not parsed strings.

### Richer ask payload — `formatApprovalPrompt` reads typed metadata

With `AskUserFn` widened, the prompt UI receives structured metadata directly. The CLI's `askUser` implementation (which captures `sessionManager` in its closure) calls `promptForApproval(toolName, input, reason, signal, { metadata, sessionLookup })`, and `formatApprovalPrompt` branches on `toolName.startsWith('Computer')`:

```ts
// src/ui/permissionPrompt.ts (signature change)
export function formatApprovalPrompt(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  opts?: {
    readonly metadata?: SafetyMetadata
    readonly sessionLookup?: (id: string) => { url: string | null; title: string | null } | null
  },
): string
```

Both `opts` fields are optional — existing call sites (filesystem prompts, etc.) pass `undefined`. The Computer branch renders:

```
Tool:    ComputerClick
Session: 7af3...d22  →  https://github.com/user/repo/settings
Action:  click(0.86, 0.41) — left button
Target:  «Delete repository» (button, level 3 irreversible)
Reason:  delete-class label at click target requires explicit approval
```

The `sessionLookup` is wired by `QueryEngine` when constructing `permissionOpts.askUser`: a closure that calls `sessionManager.get(id)?.currentUrl()`. SDK callers that pass their own `askUser` opt out of the rich rendering by ignoring `opts.metadata`. The `reason: string` stays terse and is the canonical audit payload (already there); the `metadata` is the structured payload (newly there); the rich render is a UI concern.

Trade-off considered and rejected: embedding the rich render into `reason: string` (multi-line) avoids any signature widening. Rejected because audit rows would then carry a free-text blob instead of typed `riskLevel` / `riskCategory` / `evidence` fields, defeating acceptance criterion 5's intent (structured safety-decision metadata).

### Structured ARIA contract — `AriaNode` tree, not just YAML+hash

The initial draft proposed `BrowserSession.ariaSnapshot()` returning `{ yaml: string; hash: string }`. Review feedback flagged that coordinate-based risk classification needs role/name/bbox lookup at a point — a YAML string supports model display and hash-diffing but doesn't support `findElementAtCoord(point)`. Phase 4b's atom path also needs structured atoms. Both consumers want the same structured tree.

`ariaSnapshot.ts` exports a structured intermediate plus serializers:

```ts
// src/core/computer/ariaSnapshot.ts

export type AriaNode = {
  readonly role: string
  readonly name: string | null
  readonly bbox: BoundingBox | null   // null if Playwright cannot resolve
  readonly focused: boolean
  readonly disabled: boolean
  readonly children: readonly AriaNode[]
}

export type AriaTreeSnapshot = {
  readonly tree: AriaNode
  readonly yaml: string                // model-display, also Phase 5 prompt input
  readonly hash: string                // verify.ts diff key
}

export function captureAriaTree(page: PageLike, signal: AbortSignal): Promise<AriaNode>
export function serializeToYaml(tree: AriaNode, opts: { tokenBudget: number }): string
export function hashTree(tree: AriaNode): string
export function findAtPoint(tree: AriaNode, point: NormalizedPoint, viewport: ComputerViewport): AriaNode | null
export function redactNodes(tree: AriaNode, sensitiveSelectors: readonly string[]): AriaNode
```

`BrowserSession.ariaSnapshot(signal)` returns the full `AriaTreeSnapshot`. The risk classifier's `ClassifyContext` carries `ariaSnapshot?: AriaTreeSnapshot` (not `string`) so it can call `findAtPoint(tree, {x, y}, viewport)` to read the role/name/bbox of the element under a click. The dangerous-label regex matches `node.name` (the accessible name), not free-form page text — this is exactly the property that keeps Phase 4 policy from being injection-influenced (see acceptance criterion 4 disposition above).

Phase 4b's atom-path tools (`ComputerObserveActions`, `ComputerActAtom`) consume the same `AriaTreeSnapshot` and assign `atomId`s by walking the tree. Shipping the structured contract here means Phase 4b adds tools, not infrastructure.

### Verification scope — ARIA diff + pHash; no SSIM in v3

The v3 plan calls for three verify signals (`v3-computer-use-plan.md:308–313`):

| Signal | Purpose | Phase 4 status |
|---|---|---|
| ARIA snapshot diff | Primary "did the page actually change" | **Ship** — the load-bearing primitive |
| Masked-pixel SSIM at action target | Catches in-place visual changes | **Defer** — requires native image decode + DCT/SSIM impl |
| Global screenshot pHash | Backstop for canvas/image swaps | **Ship** — minimal in-tree implementation, no new deps |

**Why skip SSIM in v3:** SSIM is a structural-similarity metric that needs raw pixel access to a bbox-clipped region. Implementing it without `sharp` or `jimp` means writing a PNG decoder *and* a DCT-style luminance/contrast comparator inline — that's a meaningful surface area for a backstop signal. ARIA-diff catches the "no DOM change" case (the most common false-positive failure mode); pHash catches canvas/image swaps (the rare case). The exact failure mode SSIM uniquely catches — a button changing visual state without a DOM mutation — is rare in 2026 React/Vue apps that re-render on state change. v3 ships the two cheap signals; SSIM is a Phase 6 / post-v3 add if the eval suite shows missed verifications.

**pHash implementation:** an 8×8 average-hash (aHash) variant. Decode PNG → grayscale → resize to 8×8 → compute mean → 64-bit fingerprint where each bit is `pixel > mean`. Hamming-distance threshold tuned per-fixture in tests. ~200 LOC including a minimal PNG inflate (using Node's built-in `zlib`). No new dependencies.

```ts
// src/core/computer/verify.ts (sketch)
export type VerifySignal = { readonly changed: boolean; readonly evidence: string }

export type VerifyResult = {
  readonly verified: boolean                            // any signal says "changed"
  readonly signals: {
    readonly aria: VerifySignal
    readonly pHash: VerifySignal
  }
}

export function verify(
  before: { ariaHash: string; pngBytes: Uint8Array },
  after:  { ariaHash: string; pngBytes: Uint8Array },
): VerifyResult
```

`verified: false` does NOT throw. The result text gains a one-line warning so the model sees it:

```
click(0.5, 0.3) — left button
url: https://...
title: ...
WARNING: post-action verification did not detect a page change. Re-observe before assuming success.
```

This matches the v3 plan: "Returns `verified: boolean` plus per-signal evidence so the model can decide whether to retry" (`v3-computer-use-plan.md:96`).

### Redaction — modify `screenshot()`, not the attachment

The clean-architecture tempting design is "capture screenshot, then run a redactor on the bytes." That requires a second PNG decode/encode pass — measurable cost on every action. The alternative is to apply the blackouts on the Playwright page before capture (`page.evaluate(() => { document.querySelector('input[type=password]').style.background = '#000'; ... })`) — which won't work for input *values* the user just typed (the value is rendered by the browser, not by CSS).

**Chosen approach:** capture once with Playwright's `screenshot({ clip })` is too restrictive. Instead, capture full screenshot once, run blackouts on the in-memory PNG via a minimal PNG-aware blackout (replace pixels in a bbox with `0x000000` and re-encode using Node's `zlib`). This adds ~2–4ms per screenshot vs ~0ms today; acceptable for the safety win. The implementation lives in `redaction.ts`; `playwrightBrowserSession.screenshot()` calls it conditionally on `regions.length > 0`.

Sensitive region detection is a new BrowserSession method:

```ts
// src/core/computer/types.ts (additions)
export interface BrowserSession {
  // ... existing ...
  ariaSnapshot(signal: AbortSignal): Promise<AriaTreeSnapshot>          // batch 4·1
  lastAriaSnapshot(): AriaTreeSnapshot | null                            // batch 4·1 — sync, for SafetyCheck
  getSensitiveRegions(extraSelectors: readonly string[], signal: AbortSignal): Promise<readonly BoundingBox[]>  // batch 4·2
  exportStorageState(signal: AbortSignal): Promise<unknown>             // batch 4·3
}

export type BoundingBox = {
  readonly x: number; readonly y: number
  readonly width: number; readonly height: number
}
```

`PlaywrightBrowserSession.getSensitiveRegions` runs `page.locator(SELECTORS).all()` against the union of the built-in sensitive selectors and `extraSelectors`, then `boundingBox()` on each:

```ts
const SENSITIVE_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete~="current-password"]',
  'input[autocomplete~="new-password"]',
  'input[autocomplete~="one-time-code"]',
  'input[autocomplete~="cc-number"]',
  'input[autocomplete~="cc-csc"]',
  'input[name~="ssn" i]',
] as const
```

`screenshot()` calls `getSensitiveRegions(this._settings.redactionSelectors, signal)` before encoding, passes the bbox list to `redaction.blackoutRegions(buf, bboxes)`, and sets `attachment.redacted = bboxes.length > 0`.

### `runActionAndObserve` — replace `observeAndPack`

Phase 3's `observeAndPack(session, signal, prefix)` only knows the *post-action* state (`stabilize → screenshot → return`). Verification needs both pre- and post-action context. Phase 4 introduces:

```ts
// src/tools/ComputerTools.ts (additions)
async function runActionAndObserve(
  session: BrowserSession,
  signal: AbortSignal,
  prefix: string,
  action: () => Promise<void>,
  opts?: { readonly skipVerify?: boolean },
): Promise<ToolResult> {
  const before = opts?.skipVerify ? null : await safelyAriaSnapshot(session, signal)
  const beforeShot = opts?.skipVerify ? null : await safelyScreenshotBytes(session, signal)

  await action()
  await session.stabilize(signal)
  const result = await session.screenshot(signal)

  let verifyText = ''
  if (before !== null && beforeShot !== null) {
    const after = await safelyAriaSnapshot(session, signal)
    const verdict = verify(
      { ariaHash: before.hash, pngBytes: beforeShot },
      { ariaHash: after.hash,  pngBytes: decodeBase64(result.attachment.data) },
    )
    if (!verdict.verified) {
      verifyText = '\nWARNING: post-action verification did not detect a page change. Re-observe before assuming success.'
    }
  }

  return {
    content: formatObservationText(prefix, result) + verifyText,
    isError: false,
    attachments: [result.attachment],
  }
}
```

`safelyAriaSnapshot` and `safelyScreenshotBytes` swallow errors and return `null` — verification is best-effort, never blocks the action. Every `Computer*` mutating tool's `call` body changes from `await session.click(...); return await observeAndPack(...)` to `return await runActionAndObserve(session, signal, summary, () => session.click(...))`. `observeAndPack` is removed (or kept as a thin wrapper for `ComputerObserve` which has no action to wrap).

### Watch-mode integration point — CLI fan-out, not engine subscriber

The initial draft proposed `attachComputerWatchMode(engine.queryEvents)`. Review feedback flagged that there is no reusable `engine.queryEvents` stream — events are yielded by the async generator inside `submitPrompt` and teed to audit inline (`QueryEngine.ts:~905`). There's nowhere to subscribe after construction.

The right integration point is the **CLI's existing event-consumption switch** — wherever the CLI already iterates `for await (const ev of engine.submitPrompt(...))` to render output. Watch mode is a fan-out at that point:

```ts
// src/ui/computerWatchMode.ts (new)

export type WatchModeRenderer = {
  readonly handle: (ev: QueryEvent) => void
  readonly detach: () => void
}

export function createComputerWatchMode(opts: {
  readonly output?: NodeJS.WritableStream     // defaults to process.stderr
  readonly isTTY?: boolean                     // defaults to (output as any).isTTY
}): WatchModeRenderer
```

The CLI's event loop calls `watchMode.handle(ev)` for every event; the renderer filters internally to events whose `toolName` starts with `Computer`. When `isTTY === false`, `handle` is a no-op (no spam in non-interactive logs). The approval prompt (`permissionPrompt.ts`) writes its own banner above the watch-mode stream — same stderr destination, the prompt's blocking I/O serializes with watch-mode lines naturally.

Watch-mode lines render after authorization:

```
[ComputerClick    ] start    7af3 → github.com/.../settings  click(0.86, 0.41)
[ComputerClick    ] ask L3   «Delete repository» — irreversible action requires approval
[ComputerClick    ] allow    user approved (allow_once)
[ComputerClick    ] finish   ok (1247ms)
```

**Pre-action display is the prompt's job, not watch-mode's.** `tool_call_started` fires after authorization, so a watch-mode line cannot show a risky proposed action *before* the approval prompt. That's intentional: the rich approval prompt (the `formatApprovalPrompt` Computer branch above) IS the pre-action display. Watch-mode narrates what passed authorization; the prompt asks about what wants to.

Settings: `computerUse.watchMode: boolean` (default `false`). When `true`, the CLI builds the renderer once and calls `handle` on every event. Engine-internal wiring is unnecessary.

### Storage-state rehydration — `initialUrl` on `ComputerStart`, gated by `persistProfiles`

The initial draft said: "when `StartSessionOptions.allowedDomains` includes a host with a matching `<key>.json`, the file is loaded." Review feedback flagged two problems:

1. **`ComputerStart` has no URL/host input** (`v3-phase3-design.md:488` schema table — only `headless`). With multiple `allowedDomains`, there's no rule for picking which snapshot to load.
2. **Playwright's `storageState` is set at `browser.newContext()` time** — it cannot be applied later. Deferring the choice to first `ComputerNavigate` would mean recreating the context, a significant lifecycle change.

Phase 4 adds an explicit `initialUrl?: string` to the `ComputerStart` input schema. When provided AND the host passes the same allowlist/scheme policy checks `ComputerNavigate` enforces, `sessionManager.start` looks up `~/.ultron/computer-storage/<sha256(host(initialUrl)).slice(0,16)>.json`, the store validates its shape, and the validated object is passed as `storageState` to `newContext`. Without `initialUrl` (or for a denied host) no rehydration happens — the model can navigate freely, and the session starts cookie-less. The validated object — not a path — flows end-to-end so there's exactly one validation pass.

```
ComputerStart input:                  ComputerStart behavior:
  { initialUrl: 'https://gh.com' }    → look up sha256('gh.com'), load if exists
  { /* no initialUrl */ }             → no rehydration; cookie-less context
```

**Persistence is gated on `persistProfiles: true`, not `allowAuthHandoff`.** Two distinct user consents:

- `allowAuthHandoff: true` — the model is permitted to invoke `ComputerHandoffToUser` to ask the user to log in. (Phase 3 already enforces this.)
- `persistProfiles: true` — the post-handoff `storageState` is **written** to disk. This is the existing settings field (`computerUseSettings.ts:32`) that Phase 4 finally honors. Defaults to `false` — explicit user opt-in for credentials surviving across runs.

`ComputerHandoffToUser.call` after Phase 4:

```ts
async call(input, _ctx, signal) {
  const lookup = resolveSession(deps, input.sessionId)
  if (!lookup.ok) return lookup.result
  try {
    // verify: false — the resume action is a no-op; running pre/post ARIA diff
    // would falsely report `verified: false` because nothing changed.
    const result = await runActionAndObserve(
      lookup.session,
      signal,
      'handoff resumed',
      async () => {
        // The user has approved the cascade prompt; resume signals the pause is over.
      },
      { verify: false },
    )
    // Snapshot storageState for cross-run rehydration — only if user opted in.
    if (deps.settings.persistProfiles && deps.settings.allowAuthHandoff) {
      const host = extractHost(lookup.session.currentUrl() ?? '')
      if (host !== null) {
        const state = await lookup.session.exportStorageState(signal)
        // Best-effort persistence: aborts MUST propagate (Batch 4·2 fix #8 rule),
        // disk-write hiccups warn-and-swallow.
        try {
          await writeStorageState(host, state)
        } catch (err) {
          if (isAbortError(err)) throw err
          warnOnce('storageState persistence failed', err)
        }
      }
    }
    return result
  } catch (err) {
    return mapBrowserSessionError(err)
  }
}
```

**Why domain-keyed, not session-keyed:** session IDs are random UUIDs (`sessionManager.ts:102`); they don't survive process restart. Domain-keying is the only stable cross-run identifier.

**Schema validation on rehydration:** Playwright's `storageState` format is `{ cookies: [...], origins: [{ origin, localStorage: [...] }] }`. The loader rejects malformed files (logs warn, proceeds without rehydration) — never throws at session start. Per the v3 contract, "boot must never throw" extends to "session start must never throw on rehydration."

### Settings additions

```ts
// src/config/computerUseSettings.ts (additions to ComputerUseSettings)
{
  // ... existing 17 fields ...
  redactionSelectors: readonly string[]   // user-configured CSS selectors for redaction
  watchMode: boolean                      // CLI watch-mode toggle (default false)
  verifyActions: boolean                  // post-action verify toggle (default true)
}
```

`redactionSelectors` is validated like `allowedDomains` — array of strings, malformed entries skipped with warn. `watchMode` and `verifyActions` are simple booleans. Defaults preserve current behavior (`watchMode: false`, `verifyActions: true`). All three are optional on disk; missing fields fall back to defaults per existing pattern.

### What does NOT change

- `src/core/query.ts` — Phase 4 adds no new event types and no new control flow. Safety checks plug into the existing slot.
- `src/core/messages.ts` / `normalizeMessages.ts` — verification warnings ride in the existing `content` field; no new block types.
- `src/audit/redactImageData.ts` — Phase 4 adds `safetyMetadata` to `permission_decision` events; the recursive walker handles unknown nested shapes already.
- `src/core/permissions/permissions.ts` — the cascade already supports the safety-check slot. Only `permissionOpts.safetyChecks` array contents change.
- `src/core/permissions/types.ts` — `AskUserFn` signature unchanged. The richer payload is rendered inside `formatApprovalPrompt` from the input + a session lookup, not piped through cascade types.
- `src/core/computer/coordinates.ts` — no changes.
- Provider adapters — no changes; image attachments already flow through them.

## Schema

### `policy.ts` additions

```ts
export type RiskLevel = 0 | 1 | 2 | 3 | 4
export type RiskCategory = 'observation' | 'reversible_ui' | 'sensitive_input' | 'irreversible' | 'prohibited'
export type RiskAssessment = {
  readonly level: RiskLevel
  readonly category: RiskCategory
  readonly reason: string
  readonly evidence?: { readonly nearbyText?: string; readonly fieldType?: string }
}
export type ClassifyContext = {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly currentUrl: string | null
  readonly ariaSnapshot?: string
}
export function classifyAction(ctx: ClassifyContext): RiskAssessment
```

### `BrowserSession` additions (per batch)

```ts
export interface BrowserSession {
  // ... Phase 2/3 fields ...

  // Batch 4·1
  ariaSnapshot(signal: AbortSignal): Promise<AriaTreeSnapshot>
  lastAriaSnapshot(): AriaTreeSnapshot | null     // sync — required for SafetyCheck

  // Batch 4·2
  getSensitiveRegions(
    extraSelectors: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly BoundingBox[]>

  // Batch 4·3
  exportStorageState(signal: AbortSignal): Promise<unknown>     // raw Playwright storageState
}
```

### `StartSessionOptions` additions (Batch 4·3)

```ts
export type StartSessionOptions = {
  // ... Phase 2 fields ...
  readonly storageState?: unknown         // validated Playwright storageState object (loaded + validated by storageStateStore)
}
```

### `ComputerStart` input addition (Batch 4·3)

```ts
// Tool input schema
{
  initialUrl?: string   // when set, sessionManager.start looks up sha256(host).json
                        // and passes its contents as Playwright `storageState`
  headless?: boolean    // existing
}
```

### `PermissionDecisionReason` widening (Batch 4·1)

```ts
export type SafetyMetadata = {
  readonly checkName: 'computerUseSafetyCheck'
  readonly riskLevel: RiskLevel
  readonly riskCategory: RiskCategory
  readonly evidence?: { readonly nearbyText?: string; readonly fieldType?: string }
}

export type PermissionDecisionReason =
  // ... unchanged ...
  | { type: 'safetyCheck'; message: string; metadata?: SafetyMetadata }
  // ... unchanged ...
```

### `AskUserFn` widening (Batch 4·1)

```ts
export type AskUserFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
  opts?: { readonly metadata?: SafetyMetadata },
) => Promise<'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'>
```

### `BrowserSessionErrorKind` additions

No new kinds. Verification produces a soft warning, not an error. Storage rehydration failures are warnings, not throws (the contract: "boot must never throw" extends to "session start must never throw on rehydration"). If a future need surfaces — a corrupted storageState that Playwright rejects mid-context-creation — it surfaces as `'navigation_failed'` (existing).

### `ComputerUseSettings` additions

```ts
{
  redactionSelectors: readonly string[]   // default: []
  watchMode: boolean                      // default: false
  verifyActions: boolean                  // default: true
}
```

### `permission_decision` event addition (Batch 4·1)

```ts
// src/core/queryEvents.ts (addition)
export type PermissionDecisionEvent = {
  // ... existing ...
  readonly safetyMetadata?: SafetyMetadata    // typed; populated from decision.reason.metadata
}
```

The event-builder reads `safetyMetadata` directly from `decision.reason.metadata` when `reason.type === 'safetyCheck'`. No string parsing. Backward-compatible — every existing reader treats unknown `safetyMetadata` as `undefined`.

## Files

### New (Batch 4·1)

| Path | Purpose |
|---|---|
| `docs/ultron_v3/v3-phase4-design.md` | This file |
| `src/core/computer/ariaSnapshot.ts` | `AriaNode` type + `captureAriaTree`, `serializeToYaml`, `hashTree`, `findAtPoint`, `redactNodes` |
| `src/core/computer/ariaSnapshot.test.ts` | Tree shape stability; hash determinism; `findAtPoint` correctness; YAML serialization + token-budget |
| `src/core/permissions/computerSafetyChecks.ts` | `makeComputerUseSafetyCheck(deps)` — wires `classifyAction` into the cascade with structured `metadata` |
| `src/core/permissions/computerSafetyChecks.test.ts` | Each level → expected behavior; non-Computer tool → `null`; click classifier reads `lastAriaSnapshot` for nearby-text evidence |

### New (Batch 4·2)

| Path | Purpose |
|---|---|
| `src/core/computer/redaction.ts` | `blackoutRegions(buf, bboxes)`, sensitive-selector list, PNG re-encode helpers |
| `src/core/computer/redaction.test.ts` | Pure-function tests; PNG round-trip; bbox math |
| `src/core/computer/verify.ts` | `verify({before, after})`, ARIA-diff signal, pHash signal, soft-fail evidence |
| `src/core/computer/verify.test.ts` | Per-signal correctness; combined verdict; identical-snapshot edge case |
| `src/core/computer/pHash.ts` | Internal: PNG decode + 8×8 average-hash. NOT exported from package |
| `src/core/computer/pHash.test.ts` | PNG round-trip; identical images → distance 0; trivially-different → distance ≥ N |

### New (Batch 4·3)

| Path | Purpose |
|---|---|
| `src/ui/computerWatchMode.ts` | `createComputerWatchMode({output, isTTY})` — renderer the CLI fans events into; no engine hook |
| `src/ui/computerWatchMode.test.ts` | Renders expected lines for Computer events; no-op on non-TTY; non-Computer events ignored |
| `src/core/computer/storageStateStore.ts` | `loadStorageState(host)`, `writeStorageState(host, state)`, sha256-key derivation |
| `src/core/computer/storageStateStore.test.ts` | Round-trip; malformed file → warn + null; sha256 stability |

### Modified (Batch 4·1)

| Path | Change |
|---|---|
| `src/core/computer/types.ts` | Add `BoundingBox`; add `ariaSnapshot()` + `lastAriaSnapshot()` to `BrowserSession` (the rest of the BrowserSession additions land in 4·2 / 4·3) |
| `src/core/computer/policy.ts` | Add `RiskLevel`, `RiskCategory`, `RiskAssessment`, `ClassifyContext` (consumes `AriaTreeSnapshot`, not string), `classifyAction`. Dangerous-label regex matches `AriaNode.name`; sensitive-field detector reads `AriaNode.role`/`fieldType` |
| `src/core/computer/policy.test.ts` | Risk-classifier truth table per category; click target classification given an `AriaTreeSnapshot` fixture |
| `src/core/computer/playwrightBrowserSession.ts` | Implement `ariaSnapshot()` + `lastAriaSnapshot()`; cache the most recent snapshot on success |
| `src/core/computer/playwrightBrowserSession.test.ts` | Wiring tests for ARIA capture; cache populates after successful capture; cache survives across calls |
| `src/core/computer/playwrightBrowserSession.integration.test.ts` | ARIA snapshot of fixture page (includes password input, button, link); `findAtPoint` against fixture coords |
| `src/core/permissions/types.ts` | Widen `PermissionDecisionReason.safetyCheck` with optional `metadata: SafetyMetadata`; widen `AskUserFn` with optional 5th `opts.metadata` arg |
| `src/core/permissions/permissions.ts` | Pass `decision.reason.metadata` through when calling `askUser` |
| `src/core/permissions/permissions.test.ts` | Cascade preserves `metadata` from safety check through to `askUser` |
| `src/ui/permissionPrompt.ts` | Widen `formatApprovalPrompt` and `promptForApproval` with `opts: { metadata?, sessionLookup? }`; add `Computer*` branch in `formatInputDisplay` |
| `src/ui/permissionPrompt.test.ts` | Computer-tool rendering snapshot test; existing non-Computer tests pass unchanged (opts undefined) |
| `src/core/queryEvents.ts` | Add optional `safetyMetadata: SafetyMetadata` to `PermissionDecisionEvent` |
| `src/sdk/QueryEngine.ts` | Append `makeComputerUseSafetyCheck(deps)` to `permissionOpts.safetyChecks` when `computerUse.enabled`; wrap `config.askUser` in a closure that injects `sessionLookup` for Computer tools; populate event `safetyMetadata` from decision reason |
| `src/sdk/QueryEngine.test.ts` | Safety-check is registered iff Computer-Use enabled; `sessionLookup` closure resolves correct URL for prompt rendering |

### Modified (Batch 4·2)

| Path | Change |
|---|---|
| `src/core/computer/types.ts` | Add `getSensitiveRegions()` to `BrowserSession` |
| `src/core/computer/playwrightBrowserSession.ts` | Implement `getSensitiveRegions`; integrate redaction into `screenshot()` (calls `getSensitiveRegions` → `blackoutRegions` before `validateImageAttachment`); set `attachment.redacted = bboxes.length > 0` |
| `src/core/computer/playwrightBrowserSession.test.ts` | Wiring tests for new method; redaction applied iff regions present |
| `src/core/computer/playwrightBrowserSession.integration.test.ts` | Password-field redaction round-trip; verify on overlay-blocked click |
| `src/core/computer/stabilize.ts` | Add step 5 — sample two ARIA snapshots ~250ms apart when the session exposes `ariaSnapshot()` (use the BrowserSession capability flag, not a `page.X` probe) |
| `src/core/computer/stabilize.test.ts` | Step 5 fires when capability present; skipped when absent |
| `src/tools/ComputerTools.ts` | Replace `observeAndPack` with `runActionAndObserve` for action tools; pre/post ARIA capture; verify wiring; ComputerType passes `sensitive` advisory through the safety-check evidence path |
| `src/tools/ComputerTools.test.ts` | Verify wired into action tools; `verified: false` adds warning text; verification disabled when `verifyActions: false` |
| `src/config/computerUseSettings.ts` | Add `redactionSelectors`, `verifyActions` validators |
| `src/config/computerUseSettings.test.ts` | Validation cases for new fields |

### Modified (Batch 4·3)

| Path | Change |
|---|---|
| `src/config/computerUseSettings.ts` | Add `watchMode` validator |
| `src/core/computer/types.ts` | Add `storageState?: unknown` (validated object, not path) to `StartSessionOptions`; add `exportStorageState()` to `BrowserSession` |
| `src/core/computer/playwrightBrowserSession.ts` | Pass `storageState` object through to `browser.newContext` when `opts.storageState !== undefined`; implement `exportStorageState` |
| `src/core/computer/sessionManager.ts` | No body change — type widens transitively; tool layer handles the lookup, gating, and policy check before calling `start` |
| `src/tools/ComputerTools.ts` | Add `initialUrl?: string` to `ComputerStart` input schema (validate parsable URL + scheme + allowlist via `policy.ts`); when `persistProfiles && policy-allowed`, call `loadStorageState(host)` and set on `StartSessionOptions.storageState`; `ComputerHandoffToUser.call` calls `runActionAndObserve(..., {verify:false})` then snapshots `exportStorageState` and writes via `storageStateStore` (gated on `persistProfiles && allowAuthHandoff`; aborts propagate, disk-write hiccups warn) |
| `src/tools/ComputerTools.test.ts` | `ComputerStart({initialUrl})` triggers rehydration when snapshot exists; denied host skips rehydration with warn; handoff resume writes storageState only when `persistProfiles: true` |
| `src/sdk/QueryEngine.ts` | Add public `getComputerUseSettings()` getter; export `makeSessionLookup(engine)` helper for watch-mode injection |
| `src/cli.ts` (lines 328–384) | Construct `createComputerWatchMode({sessionLookup})` once when `engine.getComputerUseSettings()?.watchMode && process.stderr.isTTY`; call `watchMode.handle(event)` at top of the `for await` loop, before the existing switch; `detach()` on teardown |

## Implementation order

Three batches, each separately reviewable. Batches 4·2 and 4·3 do not start until the prior batch is merged.

### Batch 4·1 — Policy, ARIA, safety check, approval payload

1. Write this design doc.
2. Add `ariaSnapshot.ts` (`AriaNode` type + `captureAriaTree` / `serializeToYaml` / `hashTree` / `findAtPoint` / `redactNodes`) + tests.
3. Extend `BrowserSession` with `ariaSnapshot()` and `lastAriaSnapshot()`; implement in `PlaywrightBrowserSession` with the snapshot cache.
4. Extend `policy.ts` with risk classifier consuming `AriaTreeSnapshot` (uses `findAtPoint` for click classification).
5. Widen `PermissionDecisionReason.safetyCheck` and `AskUserFn` with optional structured `metadata`.
6. Update the cascade in `permissions.ts` to thread `metadata` through to `askUser`.
7. Add `computerSafetyChecks.ts` + tests (the SafetyCheck reads `lastAriaSnapshot` and emits `metadata`).
8. Extend `formatApprovalPrompt` / `promptForApproval` with `opts: { metadata?, sessionLookup? }`; add Computer branch.
9. Add `safetyMetadata` field to `permission_decision` event; populate from decision reason.
10. Wire safety check into `QueryEngine.permissionOpts.safetyChecks`; wrap `config.askUser` in a closure that injects `sessionLookup`.
11. Tests + typecheck pass.

**Pause for review.** User reviews Batch 4·1 PR before Batch 4·2 starts.

### Batch 4·2 — Redaction + verify pipeline

12. Add `pHash.ts` + tests.
13. Add `redaction.ts` + tests.
14. Add `verify.ts` + tests.
15. Extend `BrowserSession` with `getSensitiveRegions()`; implement; integrate redaction into `screenshot()`.
16. Wire ARIA step 5 into `stabilize.ts` (uses Batch 4·1's `ariaSnapshot()` capability).
17. Refactor `observeAndPack` → `runActionAndObserve`; wire pre/post ARIA + verify into all action tools.
18. Update integration tests for redaction + verification.
19. Settings: `redactionSelectors`, `verifyActions`.

**Pause for review.** User reviews Batch 4·2 PR before Batch 4·3 starts.

### Batch 4·3 — Watch-mode + Handoff completion

20. Add `storageStateStore.ts` + tests.
21. Add `initialUrl?: string` to `ComputerStart` input schema (validation: parsable HTTPS URL when present).
22. Add `storageStatePath?: string` to `StartSessionOptions`; thread through `sessionManager.start` (gated on `persistProfiles: true`).
23. Implement `exportStorageState`; complete `ComputerHandoffToUser.call` (gated on `persistProfiles && allowAuthHandoff`).
24. Add `computerWatchMode.ts` + tests; settings: `watchMode`.
25. Wire `createComputerWatchMode` into the CLI event loop when enabled + TTY.
26. Integration test: handoff round-trip with rehydration on second `ComputerStart({initialUrl})`.

## Verification

### Unit tests (always run)

- **Risk classifier** (`policy.test.ts`): truth table — each `(toolName, input.text/url, ariaSnapshot)` combination → expected `(level, category, reason)`. Includes `Submit / Pay / Delete / Confirm / Send / Transfer / Publish / Invite / Disable / Remove` regex coverage; password / MFA / SSN / cc-* field detection; level-4 boundaries.
- **Safety check** (`computerSafetyChecks.test.ts`): non-Computer tool → `null`; level-0/1 → `null`; level-2/3 → `behavior: 'ask'` with formatted message; level-4 → `behavior: 'deny'`; missing session → falls back gracefully (no throw).
- **Approval prompt** (`permissionPrompt.test.ts`): Computer-tool snapshot includes URL, action summary, risk reason; non-Computer tools render unchanged; missing session lookup degrades gracefully.
- **ARIA snapshot** (`ariaSnapshot.test.ts`): serialization is deterministic; hash is stable across two captures of the same fixture; token-budget truncation preserves top-level structure.
- **Redaction** (`redaction.test.ts`): bbox blackout returns valid PNG; empty bbox list short-circuits; out-of-bounds bbox is clipped not crash.
- **pHash** (`pHash.test.ts`): identical PNGs → distance 0; same image with one-pixel change → small distance; visually different fixtures → distance ≥ threshold.
- **Verify** (`verify.test.ts`): identical before/after → `verified: false`; ARIA differs → `verified: true`; pHash differs but ARIA same → `verified: true`; both identical → `verified: false` with both-signals-no-change evidence.
- **Watch mode** (`computerWatchMode.test.ts`): renders one line per Computer event; non-TTY → no output; `detach` removes listener.
- **Storage state store** (`storageStateStore.test.ts`): write/read round-trip; malformed JSON → warn + null; sha256 keys are deterministic + path-safe.

### Integration tests (env-gated `ULTRON_PLAYWRIGHT_INTEGRATION=1`)

- **Submit-button approval (Batch 4·1)**: fixture with `<button>Delete account</button>`; navigate, observe (cache populates `lastAriaSnapshot`), then `ComputerClick` at the button. The classifier reads the cached tree, calls `findAtPoint`, matches the dangerous-label regex on `node.name`, returns level 3. Safety check fires `ask` with `metadata.riskLevel === 3`. Under `bypassPermissions`, the action still asks (acceptance criterion 1).
- **Headless denial (Batch 4·1)**: same fixture, `permissionOpts.headless: true` → cascade escalates `ask → deny` (acceptance criterion 2).
- **Password-field redaction (Batch 4·2)**: fixture with `<input type="password" value="secret">`; `ComputerObserve` returns a screenshot with the input region blacked out; `attachment.redacted === true` (acceptance criterion 3).
- **Overlay-blocked verify (Batch 4·2)**: fixture with `<button>Click me</button>` covered by an absolutely-positioned `<div>` with no event handlers; `ComputerClick` lands on the overlay; ARIA snapshot before/after is identical → `verified: false`; result `content` includes the WARNING line (acceptance criterion 6).
- **Handoff round-trip (Batch 4·3)**: with `allowAuthHandoff: true` AND `persistProfiles: true`, run a fixture login flow, complete it via the handoff prompt, observe storageState file written under `~/.ultron/computer-storage/`. Second `ComputerStart({ initialUrl: 'https://fixture.host/...' })` for the same domain reuses storageState and skips the handoff. Negative case: `persistProfiles: false` → no file written even after handoff.

### Manual smoke

1. `npm run typecheck` — clean.
2. `npm run test` — green.
3. `ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run src/core/computer/` — green.
4. Programmatic check: enable `computerUse.enabled: true`, point at a benign allowlisted page, run a click on a non-dangerous element → no approval; click on a `<button>Delete</button>` → approval prompt with rich Computer payload.

## Open questions (resolve during implementation, not blocking design)

1. **Level-4 boundary.** What exactly triggers level-4 (`prohibited`)? The v3 plan lists "CAPTCHA bypass, evading access controls, destructive host/OS actions, unapproved high-stakes domains." Level-4 means *deny without prompt*; over-broad classification breaks legitimate flows. Tentative: ship level-4 as **input/URL pattern matching only** (e.g., URLs containing `recaptcha`-style domains the user hasn't allowlisted explicitly). Defer broader semantic detection to Phase 6's eval suite.
2. **Per-host allow rules for level 3.** The v3 plan says: "No `allow_by_rule` should be offered for level 2 or level 3 actions unless the rule is tightly scoped to the same tool, same domain, and same risk class." Phase 4's approval prompt currently offers `allow_by_rule` uniformly. Tentative: gate `allow_by_rule` to levels 0/1 only by reading `opts.metadata.riskLevel` inside `promptForApproval`'s option list. Level 2/3 surfaces only `allow_once` and `deny_once`.
3. **`verifyActions: false` for cost-sensitive callers.** When verification is disabled, pre-action ARIA capture is skipped — but the post-action screenshot is still emitted. Should the action also skip the post-action ARIA capture (savings) or capture it for the *next* action's pre-state (continuity)? Tentative: skip both; verification-off is verification-off. Phase 4b's atom path can re-enable selectively per-tool.
4. **ARIA cache freshness for the SafetyCheck.** `lastAriaSnapshot()` returns the most recent successful capture, which may be stale relative to the current page state if the page changed without a `screenshot()` / `ariaSnapshot()` call between observation and the next action. For coordinate-based clicks, the model typically observes-then-clicks within one turn so staleness is rare; but `ComputerClick` followed by another `ComputerClick` on a page that auto-mutated (timer, animation) could classify against the pre-mutation ARIA. Tentative: accept the staleness; the auto-observe-after-action default (Phase 3) means every action refreshes the cache. Document the failure mode as a known limitation and revisit if Phase 6 evals surface it.
5. **`storageState` file pruning.** Files persist forever under `~/.ultron/computer-storage/`. After the user enables Computer-Use across multiple sites, the directory grows monotonically. Tentative: ship without TTL pruning; surface a `/computer storage list` and `/computer storage clear` slash command later if it becomes a real concern.
6. **pHash threshold tuning.** The Hamming-distance threshold for "different enough to count as changed" depends on screenshot dimensions and JPEG-vs-PNG noise. v3's screenshots are PNG at fixed 1024x768; a fixed threshold (e.g., distance ≥ 4) likely works. Tentative: ship with `THRESHOLD = 4` and adjust based on Phase 6 fixture results.
7. **Locating the CLI event-loop seam for watch-mode.** Batch 4·3 wires `createComputerWatchMode` at the CLI's existing `for await` over engine events. The exact file is TBD until implementation reads the CLI entrypoint; the pattern is clear (one `handle(ev)` call inside the existing switch) but the file path is locate-during-implementation.

## Out of scope (mirrors v3 roadmap)

- DOM-first action path (`ComputerObserveActions`, `ComputerActAtom`) — Phase 4b.
- System-prompt guidance for Computer-Use (including `<untrusted-page-text>` delimiter rule) — Phase 5.
- Native OpenAI/Anthropic Computer-Use bridges — Stretch Phase.
- Eval fixtures (deterministic local test pages, prompt-injection page, dangerous-action fixtures) — Phase 6.
- SSIM verification signal — deferred until image-processing deps become unavoidable; ARIA-diff + pHash are the v3 verification stack.
- Profiles B (managed stealth) and C (container desktop) — future environment adapters.
- Direct host desktop control — explicitly forbidden by v3 scope.
- TTL-based pruning of `~/.ultron/computer-storage/` — see Open Question 5.
