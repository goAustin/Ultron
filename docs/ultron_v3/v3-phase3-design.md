# v3 Phase 3 Design: Computer Tool Surface

## Status

Pre-implementation. Plan file: `~/.claude/plans/now-make-a-plan-tender-wozniak.md`. Roadmap: `docs/ultron_v3/v3-computer-use-plan.md` (Phase 3 deliverables, lines 598–629). Predecessors: `docs/ultron_v3/v3-phase0-design.md` (settings + disabled-state contract — shipped), `docs/ultron_v3/v3-phase1-design.md` (image-observation substrate — complete in working tree, untracked), `docs/ultron_v3/v3-phase2-design.md` (Playwright browser session — implemented in `78eef89`).

## Context

Phase 2 shipped the **runtime that produces screenshots and accepts normalized actions** (`src/core/computer/`). It is callable from outside the agent loop but is NOT yet visible to the model — there are no Computer tools registered, no system-prompt changes, no hook into `query.ts`. Phase 3 closes that gap by adding the **11 `Computer*` tools** and conditionally registering them when `computerUse.enabled === true`.

Phase 3 is the smallest set of changes that satisfies the four roadmap acceptance criteria (`docs/ultron_v3/v3-computer-use-plan.md:622–629`):

1. Each tool validates malformed input with a clear `validation_failed`.
2. Each tool returns `aborted` when the query signal aborts.
3. Tool execution order remains serial in `query.ts` (every Computer tool is `isConcurrencySafe: () => false`).
4. Registry tests prove tools are absent by default and present when enabled.

Phase 3 does **not** introduce risk classification, password redaction, ARIA snapshotting, post-action verification, watch-mode rendering, the DOM-first atom path, system-prompt changes, or native provider bridges. Those are Phases 4 / 4b / 5 / Stretch.

## Phase 1 + 2 prerequisites

- Phase 1 (`src/core/tools/imageAttachment.ts`) — Phase 3 action tools wrap `BrowserSession.screenshot()` results into a `ToolResult.attachments` array. Phase 1 is required for the model to actually see the post-action image.
- Phase 2 (`src/core/computer/`) — `BrowserSession` interface, `SessionManager`, `PlaywrightBrowserSession`, `coordinates.ts`, `policy.ts`, `stabilize.ts`. Phase 3 imports all of these; without Phase 2's PR landed, Phase 3's PR depends on uncommitted work. Recommendation: commit Phases 1 and 2 separately before Phase 3's first commit so blame stays clean.

## Goals

1. Add **action primitives** to the `BrowserSession` interface — `click`, `type`, `key`, `scroll`, `drag` — and implement them in `PlaywrightBrowserSession` via `page.mouse` / `page.keyboard`. The interface is the load-bearing seam (Phase 2 design decision); tools depend on it, never on Playwright.
2. Implement 11 Computer tools as a single `createComputerUseTools(deps: { sessionManager })` factory in `src/tools/ComputerTools.ts`, mirroring `src/tools/MemoryTools.ts::createMemoryTools`. Each tool captures `sessionManager` in a closure.
3. Wire the factory into `QueryEngine`: store the validated `ComputerUseSettings`, build a `SessionManager` when `enabled === true`, register the 11 tools in the engine's registry, and call `await sessionManager.stopAll()` on `dispose()`.
4. Preserve the disabled-state contract from Phase 0: when `computerUse.enabled === false`, no Computer tools register, no `SessionManager` is constructed, no Playwright import paths execute. SDK callers that hand-craft a missing `tool_use` get the existing `'tool_not_found'` `ToolErrorKind`.
5. Permission posture is **minimal in Phase 3**: every tool except `ComputerHandoffToUser` returns `'allow'` from `checkPermissions`. The cascade falls through to step 6 (allow rules) and step 7 (fallback ask). This is the WebFetch posture (`src/tools/WebFetchTool.ts:72–77`) — it's the only posture where per-host allow rules can short-circuit the prompt. Phase 4 adds the risk classifier as a non-bypassable safety check at cascade step 4 (`Submit / Pay / Delete`, password fields).
6. Action tools auto-observe: each mutating tool calls `stabilize()` then `screenshot()` and returns `{ content: <text summary>, attachments: [<png>] }`. This resolves v3 plan Open Question 3 (`docs/ultron_v3/v3-computer-use-plan.md:863–867`) in favor of automatic post-action observation.
7. Ship `ComputerHandoffToUser` minimally: gated by `computerUse.allowAuthHandoff`, denied in headless mode, asks via the cascade, captures a screenshot on resume. Storage-state snapshotting/rehydration is **deferred to Phase 4** alongside scratch-directory infrastructure.

## Non-goals

- No risk classifier, no SafetyChecks, no `Submit/Pay/Delete`-label detection (Phase 4 — `src/core/computer/policy.ts` extension).
- No password-field redaction or selector-based redaction (Phase 4 — `src/core/computer/redaction.ts`).
- No ARIA-snapshot serialization (Phase 4 — `src/core/computer/ariaSnapshot.ts`).
- No post-action verification (Phase 4 — `src/core/computer/verify.ts`).
- No DOM-first atom path (`ComputerObserveActions` / `ComputerActAtom`) — Phase 4b.
- No system-prompt guidance for Computer-Use — Phase 5.
- No CLI watch-mode rendering — Phase 4.
- No `storageState` snapshot/rehydrate for `ComputerHandoffToUser` — Phase 4 (depends on per-session scratch directory).
- No native OpenAI/Anthropic Computer-Use bridges — Stretch Phase.
- No Computer-Use eval fixtures — Phase 6.
- No `page.evaluate()` calls — none of the Phase 3 tools need it. If Phase 4b wants it for atom resolution, the JS-eval safety policy lives there.
- No persistent profiles / downloads / uploads policy — Phase 4 (the settings flags exist; Phase 3 simply does not act on them yet).
- No multi-monitor / mid-session resolution change — `viewport === displaySize` invariant from Phase 2 still holds.

## Key design decisions

### Extend `BrowserSession` with action primitives — the central seam

Phase 2's `BrowserSession` interface (`src/core/computer/types.ts:77–88`) deliberately omitted action methods because Phase 2's substrate goal was "produce screenshots, accept navigations." Phase 3 needs `click`, `type`, `key`, `scroll`, `drag`, and the v3 plan's Design Principle 2 forbids leaking `page` out of the implementation file (`docs/ultron_v3/v3-computer-use-plan.md:41`). The fix is to extend the interface:

```ts
export interface BrowserSession {
  // existing
  readonly id: ComputerSessionId
  readonly viewport: ComputerViewport
  readonly displaySize: ComputerDisplaySize
  navigate(url: string, signal: AbortSignal): Promise<void>
  screenshot(signal: AbortSignal): Promise<ScreenshotResult>
  stabilize(signal: AbortSignal): Promise<void>
  currentUrl(): string | null
  currentTitle(): Promise<string | null>
  isClosed(): boolean
  close(): Promise<void>

  // new in Phase 3 — every method takes pre-validated NormalizedPoint inputs
  // (the tool layer runs validateNormalizedPoint upstream). All methods
  // surface BrowserSessionError with `interaction_failed` on Playwright errors
  // and `aborted` when signal aborts mid-call.
  click(point: NormalizedPoint, button: 'left' | 'middle' | 'right', signal: AbortSignal): Promise<void>
  doubleClick(point: NormalizedPoint, button: 'left' | 'middle' | 'right', signal: AbortSignal): Promise<void>
  typeText(text: string, signal: AbortSignal): Promise<void>
  pressKey(key: string, signal: AbortSignal): Promise<void>
  scroll(point: NormalizedPoint | null, deltaX: number, deltaY: number, signal: AbortSignal): Promise<void>
  drag(from: NormalizedPoint, to: NormalizedPoint, signal: AbortSignal): Promise<void>
}
```

Six methods, all routed through the same `_withAbort` helper Phase 2 already uses (`playwrightBrowserSession.ts:362–379`). `PlaywrightBrowserSession` implements them via `page.mouse.click / move / down / up / wheel` and `page.keyboard.type / press`. The CSS-pixel conversion uses Phase 2's `normalizedToCssPx(point, this.viewport)` — Playwright's mouse API takes CSS pixels.

**Why interface extension, not a `getPage()` accessor:** the Phase 2 design explicitly states "Phase 4b's verification stack and Phase 3's tools depend on **the interface**, not on Playwright directly" (`docs/ultron_v3/v3-phase2-design.md:94`). A `getPage()` accessor would leak `playwright`'s `Page` type into the tool layer, breaking Profile B/C's plug-in story. The six new methods are cheap to add now; impossible to retrofit cleanly later.

**Why `typeText` / `pressKey` / `doubleClick` rather than `type` / `key` / `dblClick`:** `type` is a TS reserved-word footgun in destructuring; `key` collides with the React-style identifier; `dblClick` is non-obvious. Slightly verbose names cost nothing.

**No `wait()` on the interface.** `ComputerWait` is a sleep + abort + a quiet "still alive" check; it goes through `signal` directly without needing a session method.

### Tool factory pattern: one file, one factory, eleven builders

`src/tools/ComputerTools.ts` exports `createComputerUseTools(deps: { sessionManager: SessionManager }): { start, observe, navigate, click, type, key, scroll, drag, wait, handoffToUser, stop }`. Each builder captures `sessionManager` in a closure and returns a `Tool` (mirrors `src/tools/MemoryTools.ts:53–63`).

A single file (instead of 11 files under `src/tools/Computer*.ts` per the v3 plan's literal listing) because:
- The 11 tools share heavy helper code (sessionId resolution, post-action observe, normalized-point validation, error mapping).
- The MemoryTools precedent puts 3 tools in one file; 11 in one file is the same shape, scaled.
- Tests live in one `ComputerTools.test.ts` instead of 11 files, which keeps the FakeBrowserSession definition in one place.
- Re-export shims (`src/tools/ComputerStartTool.ts`, etc.) are not needed — the registry registers from the factory's return value, not by importing per-tool files.

The v3 plan's listing of 11 file paths (`docs/ultron_v3/v3-computer-use-plan.md:611–621`) is a logical inventory, not a literal directory layout. The roadmap amendment (below) records this.

### `SessionManager` lifecycle — constructor-time tool registration, lazy Playwright import

Two constraints are in tension:

- **Phase 0's disabled-state contract** says when `computerUse.enabled === false`, "no Playwright import path executes." But `playwrightBrowserSession.ts:22` does a static `import { chromium, ... } from 'playwright'` — so any module that statically imports `createPlaywrightSessionFactory` (e.g., `QueryEngine`) drags Playwright into the load graph the moment Ultron is required, regardless of the `enabled` flag.
- **Tool registration** must happen synchronously at constructor time so `getToolDefinitions(this.toolRegistry)` (`src/sdk/QueryEngine.ts:250`) captures the 11 Computer tools before they're baked into `callModel`. Lazy registration would require a post-bootstrap `rebuildCallModels()` round-trip identical to MCP's.

The fix is **conditional registration synchronously, lazy Playwright loading via dynamic `import()`**. `QueryEngine` constructor:

```ts
const settings = readSettingsConfig()
const computerUseSettings = validateComputerUseSettings(settings.computerUse)
this._computerUseSettings = computerUseSettings

if (computerUseSettings.enabled) {
  // The factory closes over a deferred dynamic-import call. The first call to
  // factory({...}) — which only happens when ComputerStart actually runs —
  // imports both the playwright package and playwrightBrowserSession.ts.
  // Disabled engines never reach the dynamic import, so `import('ultron')`
  // does NOT pull `playwright` into the load graph.
  const factory: BrowserSessionFactory = async (params) => {
    const mod = await import('../core/computer/playwrightBrowserSession.js')
    const lazyFactory = mod.createPlaywrightSessionFactory()
    return lazyFactory(params)
  }
  this._sessionManager = config.sessionManager ?? new SessionManager({
    settings: computerUseSettings,
    factory,
  })
  const computerTools = createComputerUseTools({
    sessionManager: this._sessionManager,
    settings: computerUseSettings,
  })
  this.toolRegistry.register(computerTools.start)
  // ... 10 more
}
```

Two consequences:
1. **The `playwrightBrowserSession.ts` module is never loaded when `enabled === false`** — the static `import 'playwright'` inside it stays unevaluated. This is what the Phase 0 contract literally requires.
2. The `BrowserSessionFactory` shape from Phase 2 is unchanged (it was already an async function returning `Promise<BrowserSession>`); only the call site swaps `import` → `await import()`.

`QueryEngine.dispose()` adds:

```ts
if (this._sessionManager) {
  await this._sessionManager.stopAll()
}
await this.mcpManager.shutdown()
```

Mirrors the MCP `shutdown()` precedent (`src/sdk/QueryEngine.ts:923–927`) for dispose, and the conditional memory-tools registration precedent (lines 236–249) for the if-branch.

**Test seam:** `QueryEngineConfig` gains `readonly computerUseSettings?: ComputerUseSettings` (test override of disk settings) and `readonly sessionManager?: ComputerSessionManager` (test injection of a fake — see "Public interface for test seam" below). When `sessionManager` is injected, the engine never builds the lazy factory — the test path has no `await import('playwright')` reachable.

### Public interface for the test seam — `ComputerSessionManager`

`SessionManager` (`src/core/computer/sessionManager.ts:53`) is a class with private fields (`_settings`, `_factory`, `_sessions`). TypeScript's nominal-typing on private fields means a structural fake `{ start, get, stop, stopAll, requestClose }` does NOT satisfy `sessionManager: SessionManager` — the compiler complains about the missing private brand.

Phase 3 introduces a public interface that both the production class and any fake implement:

```ts
// src/core/computer/types.ts
export interface ComputerSessionManager {
  start(opts: StartSessionOptions, signal: AbortSignal): Promise<BrowserSession>
  get(id: ComputerSessionId): BrowserSession | undefined
  stop(id: ComputerSessionId): Promise<void>
  stopAll(): Promise<void>
  requestClose(id: ComputerSessionId, reason: 'aborted' | 'timeout' | 'error'): Promise<void>
}

// src/core/computer/sessionManager.ts (modified)
export class SessionManager implements ComputerSessionManager { /* ... */ }
```

`createComputerUseTools` and `QueryEngineConfig.sessionManager` both refer to `ComputerSessionManager`, never the class. Test fakes implement the interface directly. Mirrors the `BrowserSession` interface / `PlaywrightBrowserSession` class split that already exists from Phase 2.

### Permission posture — `'allow'` from `checkPermissions`, fallback `ask` from the cascade

The cascade order in `src/core/permissions/permissions.ts:54–135` is:
1. explicit deny rules → 2. explicit ask rules → 3. `tool.checkPermissions` → 4. safety checks → 5. mode → 6. **explicit allow rules** → 7. fallback ask.

A tool that returns `'ask'` from step 3 short-circuits the cascade. Step 6 (allow rules) **never runs**. So the WebFetch-style posture — `checkPermissions` returns `'allow'`, the cascade falls through to allow rules then fallback ask — is the only way to let users add per-host allow rules that skip the prompt. (`src/tools/WebFetchTool.ts:72–77` is the canonical example.)

Every Phase 3 Computer tool except `ComputerHandoffToUser` returns `'allow'` from `checkPermissions`. The user prompt in headed mode comes from the **fallback ask** (cascade step 7), and explicit `{ tool: 'ComputerNavigate', domain: 'example.com', behavior: 'allow' }` rules short-circuit at step 6.

| Tool | `checkPermissions` | `getDomain` / `getPath` | UX outcome (no rules set) |
|---|---|---|---|
| `ComputerStart` | `'allow'` | — | fallback `ask` in headed; `deny` headless |
| `ComputerObserve` | `'allow'` | — | fallback `ask` in headed; `deny` headless |
| `ComputerNavigate` | `'allow'` | `getDomain` returns URL host | fallback `ask` in headed; `deny` headless. Per-host allow rules at step 6 skip the prompt. |
| `ComputerClick` | `'allow'` | — | fallback `ask` in headed; `deny` headless |
| `ComputerType` | `'allow'` | — | fallback `ask` in headed; `deny` headless. Phase 4 adds sensitive-text safety check at step 4. |
| `ComputerKey` | `'allow'` | — | fallback `ask` in headed; `deny` headless |
| `ComputerScroll` | `'allow'` | — | fallback `ask` in headed; `deny` headless |
| `ComputerDrag` | `'allow'` | — | fallback `ask` in headed; `deny` headless |
| `ComputerWait` | `'allow'` | — | fallback `ask` in headed; `deny` headless |
| `ComputerHandoffToUser` | special (see below) | — | always denies in headless or invisible-browser session; otherwise `'ask'` with the user's message |
| `ComputerStop` | `'allow'` | — | fallback `ask` in headed; `deny` headless |

`ComputerHandoffToUser` is the one tool that legitimately returns `'ask'` from `checkPermissions` — it never wants host-rule routing, and the user-facing prompt message is the entire point. Its `checkPermissions` (with closure-captured `settings` and `sessionManager`):

```ts
checkPermissions(input) {
  if (settings.allowAuthHandoff !== true) {
    return { behavior: 'deny', message: 'Handoff disabled (computerUse.allowAuthHandoff)' }
  }
  const session = sessionManager.get(input.sessionId as ComputerSessionId)
  if (!session) {
    return { behavior: 'deny', message: 'Session not found or already closed' }
  }
  if (session.headless) {  // see "Headed-session tracking" below
    return { behavior: 'deny', message: 'Handoff requires a headed (visible) browser session' }
  }
  return { behavior: 'ask', message: input.message as string }
}
```

This denies the three failure modes deterministically and asks via the cascade in the success case. The cascade's headless escalation (step 40) does NOT apply here — the engine's `permissionOpts.headless` is the CLI being non-interactive, not the Playwright session being invisible. Both must be checked.

Phase 4 will replace the blanket `'allow'`s with risk-classifier-aware safety checks at step 4 (`Submit / Pay / Delete` label detection, password-field detection). Step 4 runs BEFORE step 6 allow rules, so dangerous-action checks remain non-bypassable even when host allow rules are in place.

### Mutation flags — orthogonal to permission posture

| Tool | `isMutating` | `isReadOnly` | Notes |
|---|---|---|---|
| `ComputerStart` | `true` | `false` | Spawns a chromium subprocess |
| `ComputerObserve` | `false` | `true` | Pure screenshot capture |
| `ComputerNavigate` | `true` | `false` | Mutates page state |
| `ComputerClick` | `true` | `false` | UI mutation |
| `ComputerType` | `true` | `false` | UI mutation |
| `ComputerKey` | `true` | `false` | UI mutation |
| `ComputerScroll` | `true` | `false` | Dispatches scroll handlers; can trigger lazy-loaded network requests |
| `ComputerDrag` | `true` | `false` | UI mutation |
| `ComputerWait` | `false` | `true` | Pure sleep |
| `ComputerHandoffToUser` | `true` | `false` | Pauses the loop and surfaces a CLI prompt |
| `ComputerStop` | `true` | `false` | Terminates a chromium subprocess (process-state mutation per `src/core/tools/types.ts:90–96`) |

Mutation flag and permission posture are orthogonal — `ComputerScroll` is mutating but `'allow'` (no real damage); `ComputerStop` is mutating but `'allow'` (cleanup is desirable). The flag drives filesystem-safety-check eligibility (only mutating tools), while the permission posture drives the cascade.

### Headed-session tracking — `BrowserSession.headless`

`ComputerHandoffToUser` needs to know whether the Playwright session is headed (visible to the user) — independent of the engine's `permissionOpts.headless` (which is about the CLI). Today `BrowserSession` has no such field; the launch knob lives in `StartSessionOptions.headless` and is only visible to `PlaywrightBrowserSession`'s constructor.

Phase 3 adds `readonly headless: boolean` to the `BrowserSession` interface and populates it in `PlaywrightBrowserSession`'s constructor from `params.options.headless ?? true`. `ComputerHandoffToUser.checkPermissions` reads `session.headless` directly via the `sessionManager.get(id)` lookup. No new bookkeeping in `SessionManager` required.

### Action-then-observe

Per v3 plan Open Question 3 (resolved, `docs/ultron_v3/v3-computer-use-plan.md:863–867`): "action tools return post-action observation after session approval, with a setting to require explicit observe if cost becomes an issue."

Every mutating tool's `call()` ends with:

```ts
await session.stabilize(signal)         // Phase 2: domcontentloaded + animation debounce
const screenshot = await session.screenshot(signal)
return {
  content: `${actionSummary}\nurl: ${screenshot.observation.url}\ntitle: ${screenshot.observation.title ?? ''}`,
  isError: false,
  attachments: [screenshot.attachment],
}
```

This means a single `ComputerClick` tool call yields one model-visible image, eliminating the need for the model to emit `Click` then `Observe` as two separate turns. The `attachments` field rides on the `ToolResult` (Phase 1 substrate) and lands as an adjacent `ImageBlock` in the next user message.

A future cost-control setting (e.g., `computerUse.autoObserveAfterAction: false`) is straightforward to add later; Phase 3 ships the always-on default.

### `BrowserSessionError` → `ToolResult` mapping (shared helper)

Acceptance criterion 2 ("Each tool returns `aborted` when the query signal aborts") is broken by the default `tool.call` error path: any throw out of `tool.call` is wrapped by `runToolUse.ts:265–272` as `errorKind: 'execution_error'`, regardless of the underlying error type. A `BrowserSessionError(kind: 'aborted')` propagating uncaught becomes `'execution_error'`, not `'aborted'`.

Phase 3 ships a shared mapper inside `src/tools/ComputerTools.ts`:

```ts
function mapBrowserSessionError(err: unknown): ToolResult {
  if (err instanceof BrowserSessionError) {
    switch (err.kind) {
      case 'aborted':
        return { content: '[aborted]', isError: true, errorKind: 'aborted' }
      case 'session_closed':
        return { content: 'Session is closed; create a new one with ComputerStart', isError: true, errorKind: 'execution_error' }
      case 'domain_denied':
      case 'scheme_denied':
      case 'allowlist_empty':
        return { content: err.message, isError: true, errorKind: 'permission_denied' }
      case 'chromium_not_installed':
      case 'navigation_failed':
      case 'screenshot_failed':
      case 'screenshot_oversized':
      case 'interaction_failed':
      case 'timeout':
      case 'viewport_mismatch':
        return { content: err.message, isError: true, errorKind: 'execution_error' }
    }
  }
  return {
    content: err instanceof Error ? err.message : String(err),
    isError: true,
    errorKind: 'execution_error',
  }
}
```

Every tool's `call()` wraps its work in `try { ... } catch (err) { return mapBrowserSessionError(err) }`. Unit tests assert that an `AbortSignal.abort()` mid-call surfaces `errorKind: 'aborted'` (not `'execution_error'`), and that a denied domain surfaces `errorKind: 'permission_denied'`.

### Tighten Phase 2's `_withAbort` — post-op abort check

Phase 2's `_withAbort` (`playwrightBrowserSession.ts:362–379`) pre-checks `signal.aborted`, attaches an abort listener that calls `requestClose`, then awaits the op. If the op resolves successfully but the signal aborted mid-flight, the method returns the success value. Fast `page.mouse.click()` / `page.keyboard.press()` calls can resolve in microseconds, so the abort listener's `requestClose` runs after the success has already been observed — and acceptance criterion 2 (mid-call abort returns `aborted`) gets violated.

Phase 3 hardens `_withAbort` with a post-op abort check:

```ts
private async _withAbort<T>(signal: AbortSignal, op: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    throw new BrowserSessionError('aborted', 'operation aborted before start')
  }
  let onAbort: (() => void) | null = null
  try {
    onAbort = (): void => { void this._requestClose('aborted') }
    signal.addEventListener('abort', onAbort, { once: true })
    const result = await op()
    if (signal.aborted) {
      throw new BrowserSessionError('aborted', 'operation aborted mid-call')
    }
    return result
  } finally {
    if (onAbort !== null) signal.removeEventListener('abort', onAbort)
  }
}
```

This is technically a Phase 2 hardening landing in Phase 3 — the change is small (two lines added), the existing tests still pass (none assert non-abort behavior on a flipped signal), and Phase 3's mid-call-abort tests fail without it. Documented as an explicit Phase 3 sub-task in the file list.

### `ComputerHandoffToUser` — minimal Phase 3 shape, storageState deferred

Three constraints:
1. The tool requires headed mode (Playwright must be visible so the user can interact).
2. The tool requires `computerUse.allowAuthHandoff: true`.
3. The full flow needs storageState snapshotting on resume (`docs/ultron_v3/v3-computer-use-plan.md:213–218`) — this depends on a per-session scratch directory that Phase 3 does not establish.

Phase 3's `ComputerHandoffToUser` ships:
- `validateInput`: requires `sessionId` + `message: string` (the prompt to surface).
- `checkPermissions`:
  - `permissionOpts.headless === true` → `{ behavior: 'deny', message: 'Handoff requires headed mode' }`.
  - `computerUseSettings.allowAuthHandoff === false` → `{ behavior: 'deny', message: 'Handoff disabled in settings (computerUse.allowAuthHandoff)' }`.
  - Otherwise → `{ behavior: 'ask', message: input.message }`. The cascade calls `askUser`, which surfaces the message and waits for the user's "allow_once" response. The user uses that wait window to interact with the visible browser.
- `call`: on resume (i.e., `call()` runs because the user approved the prompt), captures a fresh screenshot via `session.screenshot(signal)` and returns it. **No** storageState snapshot; **no** scratch directory writes.

The deferred Phase 4 work: snapshot `context.storageState()` to a per-session scratch dir, rehydrate on next `ComputerStart` for the same domain, expose the scratch dir in settings.

This matches the pattern of "Phase 3 satisfies the literal v3 plan deliverable; Phase 4 layers in the policy/safety stack." `ComputerHandoffToUser` lives where the rest of `policy.ts` will live anyway.

**Why not defer the whole tool to Phase 4?** Because the tool's existence (gated, denied in headless, asks via cascade) exercises the permission-cascade-as-handoff-signal pattern that Phase 4's tighter handoff will refine. Shipping the stub in Phase 3 keeps the registration count at 11 and the v3 plan's tool table accurate.

### Coordinate input shape — flat `x` / `y`, validate in tool layer

The v3 plan's tool schema rule (`docs/ultron_v3/v3-computer-use-plan.md:202`): "`x` and `y` are normalized numbers in `[0, 1]`, not pixels." Tools take flat numbers in their JSON schema (model-friendly) and convert to `NormalizedPoint` via `validateNormalizedPoint({ x: input.x, y: input.y })` before calling the session.

For `ComputerScroll`, both `x` and `y` are optional (page-level scroll). When provided, both must be supplied together (validate-pair-or-neither). For `ComputerDrag`, the four fields `fromX / fromY / toX / toY` mirror this shape.

Out-of-range or NaN inputs produce `validation_failed` (acceptance criterion 1) before `checkPermissions` runs.

### Key allowlist — closed set, validated in `validateInput`

`ComputerKey` accepts a closed allowlist (`docs/ultron_v3/v3-computer-use-plan.md:204`):

```ts
const ALLOWED_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
])

const ALLOWED_CHORD_PREFIXES = ['ControlOrMeta+', 'Control+', 'Meta+', 'Alt+', 'Shift+'] as const
const ALLOWED_CHORD_SUFFIX = /^[A-Za-z0-9]$|^(Enter|Tab|Escape|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/
```

A key is valid if (a) it's in `ALLOWED_KEYS`, or (b) it is `<prefix>...<suffix>` where each `<prefix>` is in `ALLOWED_CHORD_PREFIXES` (one or more, joined) and `<suffix>` matches `ALLOWED_CHORD_SUFFIX`. Anything else → `validation_failed`. Playwright's `page.keyboard.press(key)` accepts these directly.

### Type input — byte cap, control-char rejection

`ComputerType.validateInput` rejects:
- `text` longer than `MAX_TYPE_BYTES` (1024 — covers passwords, tokens, short sentences; rejects screen-blasts).
- Control characters except `\t`, `\n`, `\r` (allow whitespace; reject `\x00`–`\x08`, `\x0B`, `\x0C`, `\x0E`–`\x1F`, `\x7F`).

`sensitive: boolean` is accepted but ignored by Phase 3 (Phase 4's redaction will use it). Documented as "advisory, will be enforced in Phase 4."

### Test strategy: unit fakes + opt-in integration

**Unit (`src/tools/ComputerTools.test.ts`, always runs):**
- A `FakeBrowserSession` records every method invocation with arguments and returns canned `ScreenshotResult`s.
- A `FakeSessionManager` returns the fake session from `start` / `get`.
- One describe block per tool: validation table (good inputs, malformed inputs → `validation_failed`), permission table (allow vs ask vs deny), happy-path call (verifies `session.<method>(...)` was called with the right args, post-action observe ran, attachment in result), abort path (signal aborts mid-call → `errorKind: 'aborted'`), session-not-found (invalid sessionId → `validation_failed`), session-closed (`session.isClosed()` → `execution_error`).
- One describe block for `createComputerUseTools` itself: returns 11 tools, every tool has the expected `name`, `isMutating`, `isReadOnly`, `isConcurrencySafe: () => false`.

**Integration (`src/core/computer/playwrightBrowserSession.integration.test.ts`, env-gated):**
- Add cases for `click` (against a fixture button), `typeText` (focused input), `pressKey` (Enter to submit form), `scroll` (page-level + point-anchored), `drag` (fixture drag-target). Reuses Phase 2's host-resolver-rules fixture infrastructure.
- Assertions: the action lands on the expected DOM element (via the fixture's data-testid), and `session.isClosed()` stays `false`.

**Engine (`src/sdk/QueryEngine.test.ts`):**
- Conditional registration: construct with `computerUse: { enabled: false }`, assert `engine.getRegistry().has('ComputerStart')` is false. Construct with `computerUse: { enabled: true, allowedDomains: ['fixture.local'] }`, assert all 11 names are present.
- Dispose: when `_sessionManager` is set, `dispose()` calls `stopAll()`. Use a fake `SessionManager` injected via the new `config.sessionManager` test seam to spy on the call.

### What does **not** change in Phase 3

- `src/core/query.ts` — no changes. Tools register through the existing path; the loop already serializes mutating tool calls, and Phase 2's `BrowserSession` already routes abort through `_withAbort`.
- `src/core/tools/registry.ts::createDefaultRegistry` — Phase 3 does NOT mutate this signature. The conditional registration happens in `QueryEngine` (matches the MemoryTools precedent — memory tools are also registered in `QueryEngine`, not `createDefaultRegistry`). The roadmap's `createDefaultRegistry({ computerUse })` shorthand turns out to be unnecessary; updating the roadmap to reflect this.
- `src/core/messages.ts` / `normalizeMessages.ts` — Phase 1 already taught the substrate about image-bearing tool results.
- `src/audit/*` — Phase 1 already strips screenshot bytes. Phase 3 emits no new audit envelope shapes.
- `src/context/systemPrompt.ts` — Phase 5 owns Computer-Use prompting. Phase 3 keeps the system prompt unchanged when Computer-Use is enabled (the model discovers the tools via the standard tool-definitions list).

## Schema

### `BrowserSession` (extended) + `ComputerSessionManager` (new interface)

`src/core/computer/types.ts` (additions only — Phase 2 fields preserved):

```ts
export type BrowserSessionErrorKind =
  | 'domain_denied'
  | 'scheme_denied'
  | 'allowlist_empty'
  | 'viewport_mismatch'
  | 'chromium_not_installed'
  | 'navigation_failed'
  | 'screenshot_oversized'
  | 'screenshot_failed'
  | 'session_closed'
  | 'aborted'
  | 'timeout'
  | 'interaction_failed'   // ← new: covers click/type/key/scroll/drag Playwright errors

export interface BrowserSession {
  // ... Phase 2 fields ...
  readonly headless: boolean   // ← new: true iff the browser was launched headless

  click(point: NormalizedPoint, button: 'left' | 'middle' | 'right', signal: AbortSignal): Promise<void>
  doubleClick(point: NormalizedPoint, button: 'left' | 'middle' | 'right', signal: AbortSignal): Promise<void>
  typeText(text: string, signal: AbortSignal): Promise<void>
  pressKey(key: string, signal: AbortSignal): Promise<void>
  scroll(point: NormalizedPoint | null, deltaX: number, deltaY: number, signal: AbortSignal): Promise<void>
  drag(from: NormalizedPoint, to: NormalizedPoint, signal: AbortSignal): Promise<void>
}

// Public-shape contract for `SessionManager`. The class implements it; test
// fakes implement it directly (without inheriting the class's private brand,
// so structural fakes type-cleanly satisfy the QueryEngineConfig seam).
export interface ComputerSessionManager {
  start(opts: StartSessionOptions, signal: AbortSignal): Promise<BrowserSession>
  get(id: ComputerSessionId): BrowserSession | undefined
  stop(id: ComputerSessionId): Promise<void>
  stopAll(): Promise<void>
  requestClose(id: ComputerSessionId, reason: 'aborted' | 'timeout' | 'error'): Promise<void>
}
```

### `createComputerUseTools` factory

`src/tools/ComputerTools.ts`:

```ts
export type ComputerUseToolsDeps = {
  readonly sessionManager: ComputerSessionManager   // ← interface, not class
  readonly settings: ComputerUseSettings            // for allowAuthHandoff + Handoff checkPermissions
}

export function createComputerUseTools(deps: ComputerUseToolsDeps): {
  start: Tool
  observe: Tool
  navigate: Tool
  click: Tool
  type: Tool
  key: Tool
  scroll: Tool
  drag: Tool
  wait: Tool
  handoffToUser: Tool
  stop: Tool
}
```

### Tool input schemas (summary)

| Tool | Required | Optional |
|---|---|---|
| `ComputerStart` | — | `headless: boolean` (default true) |
| `ComputerObserve` | `sessionId` | — |
| `ComputerNavigate` | `sessionId`, `url` | — |
| `ComputerClick` | `sessionId`, `x`, `y` | `button: 'left'\|'middle'\|'right'` (default left), `double: boolean` (default false) |
| `ComputerType` | `sessionId`, `text` | `sensitive: boolean` (advisory) |
| `ComputerKey` | `sessionId`, `key` | — |
| `ComputerScroll` | `sessionId`, `deltaX`, `deltaY` | `x`, `y` (provide both or neither) |
| `ComputerDrag` | `sessionId`, `fromX`, `fromY`, `toX`, `toY` | — |
| `ComputerWait` | `sessionId`, `ms` (1..10000) | — |
| `ComputerHandoffToUser` | `sessionId`, `message` | — |
| `ComputerStop` | `sessionId` | — |

### `QueryEngineConfig` (extended)

`src/sdk/QueryEngine.ts`:

```ts
export type QueryEngineConfig = {
  // ... existing fields ...

  /**
   * v3 Phase 3: override the validated computerUse settings (test seam).
   * Production reads from settings.json. When set, completely replaces the
   * disk-loaded settings for the engine's lifetime.
   */
  readonly computerUseSettings?: ComputerUseSettings

  /**
   * v3 Phase 3: inject a pre-built session manager (test seam).
   * Typed against the interface so structural fakes satisfy it without the
   * class's private brand. When provided, the engine skips the lazy
   * Playwright factory entirely — no `await import('playwright')` is reachable
   * on the test path. Mirrors the mcpManager seam.
   */
  readonly sessionManager?: ComputerSessionManager
}
```

## Files

### New

| Path | Purpose |
|---|---|
| `docs/ultron_v3/v3-phase3-design.md` | This file |
| `src/tools/ComputerTools.ts` | `createComputerUseTools` factory + 11 tool builders |
| `src/tools/ComputerTools.test.ts` | Unit tests (FakeBrowserSession + FakeSessionManager) |

### Modified

| Path | Change |
|---|---|
| `src/core/computer/types.ts` | Add 6 action methods + `readonly headless: boolean` to `BrowserSession`; add `'interaction_failed'` to `BrowserSessionErrorKind`; add `ComputerSessionManager` interface |
| `src/core/computer/sessionManager.ts` | `class SessionManager implements ComputerSessionManager` (no behavior change) |
| `src/core/computer/playwrightBrowserSession.ts` | Implement `click / doubleClick / typeText / pressKey / scroll / drag`; populate `readonly headless`; route through `_withAbort`; convert NormalizedPoint via `normalizedToCssPx(point, this.viewport)`. **Also** harden `_withAbort` with the post-op abort check (Phase 2 fix landing in Phase 3 — see "Tighten Phase 2's `_withAbort`" above) |
| `src/core/computer/playwrightBrowserSession.integration.test.ts` | Add integration cases for the 6 new methods |
| `src/core/computer/playwrightBrowserSession.test.ts` | Add wiring tests for the new methods (mock factory verifies args round-trip) |
| `src/sdk/QueryEngine.ts` | Store `_computerUseSettings`; conditionally build a **lazy** `BrowserSessionFactory` (uses `await import('../core/computer/playwrightBrowserSession.js')`) and register 11 tools; add `_sessionManager?.stopAll()` to `dispose()`; add `computerUseSettings?: ComputerUseSettings` and `sessionManager?: ComputerSessionManager` (the **interface**, not the class) test seams to `QueryEngineConfig` |
| `src/sdk/QueryEngine.test.ts` | Conditional-registration tests; dispose-calls-stopAll test |
| `docs/ultron_v3/v3-computer-use-plan.md` | Phase 3 deliverables (~lines 598–629) — record (a) `BrowserSession` interface extension, (b) single-file `ComputerTools.ts` (not 11 files), (c) `ComputerHandoffToUser` storageState deferral to Phase 4, (d) auto-observe-after-action default |

### Reused (no modification)

- `src/core/computer/coordinates.ts` — `validateNormalizedPoint`, `normalizedToCssPx` consumed by every coordinate-bearing tool.
- `src/core/computer/sessionManager.ts` — Phase 2's `SessionManager` is the runtime owner; tools read from it via the closure-captured reference.
- `src/core/computer/policy.ts` — `isDomainAllowed` / `isUrlSchemeAllowed` are called transitively through `BrowserSession.navigate()`. Phase 3 tools do not call them directly.
- `src/core/computer/stabilize.ts` — called transitively through `BrowserSession.stabilize()`; `_installRouteInterceptor` already wires the route enforcement.
- `src/core/tools/imageAttachment.ts` — Phase 1's `ToolResultAttachment` is the type returned by `ScreenshotResult.attachment`; tools just forward it.
- `src/core/tools/types.ts::buildTool` — every Computer tool is built through this helper (mirrors WebFetch / Bash / MemoryTools).
- `src/core/permissions/permissions.ts` — the cascade transparently handles `'ask'` / `'allow'` / `'deny'` returns; no change needed.
- `src/core/tools/runToolUse.ts` — `'tool_not_found'` already fires for SDK callers that hand-craft a missing tool_use (Phase 0 disabled-state contract).
- `src/web/domainPolicy.ts::extractHost` — `ComputerNavigate.getDomain` calls this for per-host rule matching.

## Implementation order

Two batches. Batch 1 is docs only; pause for review before Batch 2.

### Batch 1 — Docs

1. Write `docs/ultron_v3/v3-phase3-design.md` (this file).
2. Amend `docs/ultron_v3/v3-computer-use-plan.md` Phase 3 deliverables (~lines 598–629) per the four bullet points above.

**Pause for review.** User reviews the design doc and roadmap amendments before any code lands.

### Batch 2 — Code

3. Extend `src/core/computer/types.ts`: add `readonly headless: boolean` and the 6 action methods to `BrowserSession`; add `'interaction_failed'` to `BrowserSessionErrorKind`; export the new `ComputerSessionManager` interface.
4. Mark `class SessionManager implements ComputerSessionManager` in `src/core/computer/sessionManager.ts` (no behavior change — purely a type assertion that the public surface matches the interface).
5. Implement the 6 action methods in `src/core/computer/playwrightBrowserSession.ts`. Each follows the shared shape: `_withAbort(signal, async () => { try { ... } catch (err) { if (this._closed) throw aborted; throw interaction_failed } })`. Coordinate inputs convert via `normalizedToCssPx(point, this.viewport)`. **Also**: harden `_withAbort` with the post-op abort check (`if (signal.aborted) throw new BrowserSessionError('aborted', ...)` after `await op()`), and populate `this.headless = params.options.headless ?? true` in the constructor.
6. Add unit-test wiring assertions in `src/core/computer/playwrightBrowserSession.test.ts` for the new methods (mock factory verifies CSS-px args), the `headless` field, and the post-op abort path (signal flips while op resolves successfully → `BrowserSessionError(kind: 'aborted')`).
7. Add integration tests in `src/core/computer/playwrightBrowserSession.integration.test.ts` for `click`, `typeText`, `pressKey`, `scroll`, `drag` against fixture pages.
8. Create `src/tools/ComputerTools.ts` with `createComputerUseTools(deps: { sessionManager: ComputerSessionManager, settings: ComputerUseSettings })` and 11 builders. Includes the shared `mapBrowserSessionError(err): ToolResult` helper (every tool's `call()` wraps in `try { ... } catch (err) { return mapBrowserSessionError(err) }`) and the `runActionAndObserve(session, action, signal)` helper that wraps `action()` → `stabilize` → `screenshot` → `{ content, attachments }`.
9. Create `src/tools/ComputerTools.test.ts` with a `FakeBrowserSession` (records calls, returns canned `ScreenshotResult`s, satisfies the `BrowserSession` interface including `headless`) and a `FakeSessionManager` (implements `ComputerSessionManager`, returns the fake from `start`/`get`). One describe block per tool plus top-level "factory shape" + "BrowserSessionError → ToolResult mapping" describes. Mid-call abort → `errorKind: 'aborted'`; denied domain → `errorKind: 'permission_denied'`; chromium-not-installed → `errorKind: 'execution_error'` (asserts the mapper).
10. Wire `src/sdk/QueryEngine.ts`: store `_computerUseSettings`; build the **lazy** factory via `async (params) => (await import('../core/computer/playwrightBrowserSession.js')).createPlaywrightSessionFactory()(params)`; conditionally construct `_sessionManager` (use `config.sessionManager` when injected); register 11 tools; add `stopAll()` to `dispose()`; add `computerUseSettings?` + `sessionManager?` (typed `ComputerSessionManager`) to `QueryEngineConfig`.
11. Add tests to `src/sdk/QueryEngine.test.ts`: tool absence by default; presence when `computerUseSettings: { enabled: true, ... }` + `sessionManager: fakeManager` are provided; dispose calls `fakeManager.stopAll()` exactly once. **Verify** the disabled-state test does not transitively load `playwright` (e.g., snapshot the loaded modules via `Object.keys(require.cache)` or assert `'playwright' in module.children` is false — use a less brittle check at implementation time).

## Verification

### Unit tests (always run)

- `ComputerTools.test.ts` (eleven describe blocks + factory shape):
  - Each tool's `validateInput` rejects malformed inputs with `validation_failed` (missing fields, wrong types, NaN/Infinity, out-of-range coordinates, oversized text, disallowed key strings, disallowed URL schemes).
  - Each tool's `checkPermissions` returns the expected behavior (table from "Permission posture" above).
  - Each tool's happy path: input passes → expected `BrowserSession` method called with correct args → screenshot returned → result has `attachments[0]` and the right `content` summary.
  - Each tool's abort path: pre-aborted signal → `errorKind: 'aborted'`. Mid-call abort: signal aborts during `session.<method>(...)` → `errorKind: 'aborted'`.
  - Session-not-found: an unknown sessionId → `validation_failed` (cleaner than `execution_error` because the input is malformed in context).
  - Session-closed: `session.isClosed()` returns true → `execution_error` with `'session_closed'` message.
  - `ComputerHandoffToUser` denies in headless mode and when `allowAuthHandoff: false`; asks via cascade otherwise.
  - Factory: returns 11 tools; every tool has `isConcurrencySafe: () => false`; mutating flags match the table; tool names match the expected set exactly.
- `playwrightBrowserSession.test.ts` (additions): each new `BrowserSession` method translates a NormalizedPoint into the CSS px the mock factory observes; abort during the action throws `BrowserSessionError(kind: 'aborted')`; Playwright errors translate to `'interaction_failed'`.
- `QueryEngine.test.ts` (additions):
  - With `computerUseSettings: { enabled: false, ...defaults }` (or omitted): `engine.getRegistry().has('ComputerStart')` is false (and the same for the other 10 names).
  - With `computerUseSettings: { enabled: true, allowedDomains: ['fixture.local'], ...defaults }` AND `sessionManager: fakeManager`: all 11 names present.
  - With `sessionManager: fakeManager`: `await engine.dispose()` calls `fakeManager.stopAll()` exactly once.

### Integration tests (env-gated)

- `playwrightBrowserSession.integration.test.ts` (additions, gated by `ULTRON_PLAYWRIGHT_INTEGRATION=1`):
  - `click`: navigate to a fixture page with `<button data-testid="x">`; call `session.click({x:0.5, y:0.5}, 'left', signal)`; assert the page recorded the click via fixture's onclick handler.
  - `typeText`: navigate to fixture with `<input data-testid="i">`; click to focus; `typeText('hello', signal)`; assert `input.value === 'hello'` (read via fixture's `/state` endpoint).
  - `pressKey('Enter', signal)`: focused input + Enter triggers form submit handled by fixture; assert fixture saw the submit.
  - `scroll(null, 0, 500, signal)`: page-level scroll; assert `window.scrollY > 0` via fixture endpoint.
  - `drag({x:0.2,y:0.5}, {x:0.8,y:0.5}, signal)`: fixture's draggable element ends up at the right side; assert via fixture endpoint.
  - Abort during a long Playwright op (slow-loading fixture): assert `BrowserSessionError(kind: 'aborted')` and `session.isClosed() === true`.

### Manual smoke

1. `npm run typecheck` — clean.
2. `npm run test` — green; integration suite skipped without env var.
3. `ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run src/core/computer/` — green.
4. Programmatic check: instantiate `QueryEngine` with `computerUse: { enabled: true, allowedDomains: ['example.com'] }` and `apiKey` set; call `engine.getRegistry().has('ComputerStart')` → `true`; call `engine.dispose()` cleanly.
5. `git status` — only files in the "Files" section above are touched.

## Open questions (resolve during implementation, not blocking design)

1. **`ComputerStart` `headless` default.** Phase 3 defaults to `true`. `ComputerHandoffToUser` requires headed mode. Should `ComputerStart` accept `headless: false` directly, or should the engine derive it from session usage patterns? Tentative: `headless: false` is allowed via input; the model only requests it when a handoff is anticipated. Phase 4 may add a settings-level default.
2. **`ComputerScroll` permission posture.** Phase 3 sets it to `'allow'` because scroll has no real side effects. If a hostile page uses scroll-driven mutation (rare but possible — scroll-jacking forms), we may need to flip it to `'ask'`. Tentative: keep `'allow'` for v3; revisit if a fixture surfaces a real abuse path.
3. **Should `createComputerUseTools` live under `src/tools/` or under `src/core/computer/`?** The MemoryTools precedent puts user-visible tools under `src/tools/`. Tentative: `src/tools/ComputerTools.ts`. The factory imports from `src/core/computer/`; the boundary stays clean.
4. **`ComputerStop`'s permission posture.** Phase 3 sets it to `'allow'` (cleanup is always desirable). But a model that closes a session prematurely could waste user time. Tentative: keep `'allow'`; the worst case is the user re-runs `ComputerStart`.
5. **Should Phase 3 surface a `ComputerSessionStart`-style audit event distinct from generic tool execution?** Tentative: no — Phase 1's `redactImageData` already strips screenshot bytes from audit envelopes; the existing `tool_use` / `tool_result` audit rows carry the metadata. Phase 4's policy/safety stack can add finer-grained events if the watch-mode UX needs them.

## Out of scope (mirrors v3 roadmap)

- Risk classification, password redaction, approval prompts, watch-mode rendering — Phase 4 (`docs/ultron_v3/v3-computer-use-plan.md:633–658`).
- DOM-first action path (`ComputerObserveActions`, `ComputerActAtom`) — Phase 4b.
- System-prompt guidance for Computer-Use — Phase 5.
- `ComputerHandoffToUser` storageState snapshot/rehydrate — Phase 4 (depends on per-session scratch directory).
- Eval fixtures — Phase 6.
- Native provider Computer-Use bridges — Stretch Phase.
- Profiles B (managed stealth) and C (container desktop) — future environment adapters that plug into the same `BrowserSession` interface.
- Direct host desktop control — explicitly forbidden by v3 scope.
