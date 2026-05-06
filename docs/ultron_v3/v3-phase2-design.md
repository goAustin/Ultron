# v3 Phase 2 Design: Playwright Browser Session

## Status

Implemented (commit pending). Approved plan: `~/.claude/plans/now-make-a-plan-pure-turtle.md`. Roadmap: `docs/ultron_v3/v3-computer-use-plan.md` (Phase 2 deliverables, lines 555–583). Predecessor: `docs/ultron_v3/v3-phase1-design.md` (image-observation substrate — complete in working tree, untracked/uncommitted).

Verification at time of implementation:
- `npm run typecheck` clean.
- `npm run test` — 1790 passed, 6 skipped (5 are this phase's env-gated integration suite + 1 pre-existing).
- `ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run src/core/computer/` — all 85 tests green (80 unit + 5 integration) against real headless Chromium.

Post-implementation tightenings (applied to fix issues found in code review):
- `pixelToNormalized` rejects `displaySize.{width,height} < 2` to avoid divide-by-zero (`maxX = width - 1` is degenerate at width=1; settings allow dimensions down to 1).
- Missing-Chromium detection narrowed from any `browserType.launch:`-prefixed error to specifically `Executable doesn't exist` / `ENOENT` / `no such file or directory` + chromium/playwright keywords. The broad matcher mistranslated timeouts/sandbox failures.

## Context

`docs/ultron_v3/v3-computer-use-plan.md` is the v3 roadmap (Computer-Use only). Phase 0 added the `computerUse` settings schema/validator and is shipped (`b36bcb6` / `dcc4988`). Phase 1 added the image-observation substrate (PNG attachments on `ToolResult`, OpenAI image mapping, audit redaction, `supportsVision` capability) and is **complete in the working tree** but not yet committed — see `git status` (untracked `redactImageData.{ts,test.ts}`, `imageAttachment.{ts,test.ts}`, `computerUseSettings.test.ts`, plus modified Phase 1 files).

Phase 2 builds the **runtime that produces those screenshots and accepts those normalized actions**. After Phase 2, an Ultron component (not yet a tool — Phase 3 wires the tool surface) can:

- Open an isolated Playwright browser context.
- Convert normalized `[0,1]` coordinates ↔ pixel coordinates.
- Take an in-memory PNG screenshot at the configured `displaySize`.
- Block navigation / requests to non-allowlisted hosts.
- Wait for a layered stabilization signal after a navigation.
- Clean up on `stop()`, on `maxDurationMs` timeout, and on `AbortSignal.aborted`.

Phase 2 is the smallest substrate that satisfies the four roadmap acceptance criteria (`docs/ultron_v3/v3-computer-use-plan.md:577–582`):

1. Starting a browser session creates an isolated context.
2. Navigation to denied domains is blocked before request completion.
3. Screenshot returns expected dimensions and MIME type.
4. Abort closes the Playwright context.

Phase 2 does **not** introduce Computer-Use tools, register them, change the system prompt, redact passwords, build the verification stack, or expose anything to the model. Those are Phases 3, 4, 4b, 5.

## Phase 1 prerequisite

Phase 2 imports `validateImageAttachment` from `src/core/tools/imageAttachment.ts` (Phase 1) — the screenshot path goes `Buffer (PNG) → base64 → validateImageAttachment(caps) → ToolResultAttachment`. Without Phase 1 committed, Phase 2's PR depends on uncommitted work. Recommendation: commit Phase 1 separately before Phase 2's first commit so blame stays clean.

## Goals

1. New directory `src/core/computer/` containing the runtime substrate. No tool definitions (those land in Phase 3).
2. `BrowserSession` interface (in `types.ts`) decouples the runtime contract from Playwright. Phase 2 ships **one implementation** (`PlaywrightBrowserSession`); Profiles B/C from the v3 plan (`docs/ultron_v3/v3-computer-use-plan.md:269–275`) plug in later under the same interface.
3. Coordinate conversion is a pure module (`coordinates.ts`) with deterministic round-trip behavior under DSF=1, DSF=2, and `viewport ≠ displaySize`.
4. `SessionManager` owns lifecycle: id minting, session lookup, timeout enforcement, abort propagation, cleanup-once semantics. The runtime closes contexts exactly once per session, even under concurrent stop / timeout / abort.
5. Domain enforcement runs **at the Playwright `route` layer**, not just at the tool layer. A model that requests `https://denied.com` either (a) gets a `domain_denied` error before any request leaves the host or (b) the route is short-circuited via `route.abort('blockedbyclient')`.
6. URL scheme enforcement: HTTPS-only by default. `http:` permitted only behind a test-only flag.
7. Stabilization (`stabilize.ts`) is implemented but is the **minimum viable** version for Phase 2: wait for navigation commit + `domcontentloaded` + a short animation debounce. The full ARIA-snapshot-sample loop (`docs/ultron_v3/v3-computer-use-plan.md:299–306`) is deferred to Phase 4 alongside `ariaSnapshot.ts`. Phase 2 just lays the function so Phase 3 tools can call it.
8. `package.json` gains `playwright` as a dependency. Chromium binary is **not** auto-downloaded — users run `npx playwright install chromium` manually. Missing-binary case is detected at session start and surfaced as a clear, actionable error.
9. Unit tests use in-memory fakes; integration tests require a real Playwright install and live in `*.integration.test.ts` (gated like `seatbelt.integration.test.ts:30`), so `npm run test` stays green on a fresh checkout.

## Non-goals

- No `Computer*` tool definitions, no registry registration (Phase 3).
- No password-field redaction or selector-based redaction (`redaction.ts` — Phase 4).
- No ARIA-snapshot serialization (`ariaSnapshot.ts` — Phase 4).
- No post-action verification (`verify.ts` — Phase 4).
- No DOM-first atom path (Phase 4b).
- No OpenAI/Anthropic native Computer-Use bridges (Stretch Phase).
- No system-prompt changes (Phase 5).
- No Computer-Use eval fixtures (Phase 6).
- No CLI watch-mode rendering (Phase 4).
- No JPEG support — PNG-only matches Phase 1.
- No multi-monitor or mid-session resolution change (`docs/ultron_v3/v3-computer-use-plan.md:179` — one virtual display per session).
- No actual screenshot-attachment-bearing tool execution end-to-end. The substrate is callable; Phase 3 wires it to the loop.
- No persistent profiles, downloads, uploads, or auth handoff (Phase 3 + Phase 4).
- **No JavaScript-evaluation safety policy.** Phase 2 does not call `page.evaluate()` from anywhere; if Phase 4b needs it for atom resolution, the policy lives there.
- No `postinstall` hook to download Chromium. Auto-download on every `npm install` would punish users who never enable Computer-Use.

## Key design decisions

### Split: `BrowserSession` interface vs. `PlaywrightBrowserSession` implementation

`types.ts` defines an abstract `BrowserSession` contract:

```ts
export interface BrowserSession {
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
}
```

Phase 2 ships `playwrightBrowserSession.ts` as the only implementation. Phase 4b's verification stack and Phase 3's tools depend on **the interface**, not on Playwright directly — so Profile B (managed stealth) and Profile C (container desktop) can land later without touching tool/policy/audit code.

**Why not just inline Playwright in tools:** the v3 plan's Design Principle 2 — "exactly one Computer-Use runtime" (`docs/ultron_v3/v3-computer-use-plan.md:41`) — and the migration story to Profile B both require this seam. Cheap to add now; expensive to retrofit later.

### Coordinate conversion: pure, deterministic, both directions, reject not clamp

`coordinates.ts` is a pure module with no Playwright import. Three functions:

```ts
// REJECTS (no clamping) on:
//   - NaN, +/-Infinity
//   - x or y outside [0, 1] (strict; 0 and 1 are inclusive)
//   - missing fields, wrong types
export function validateNormalizedPoint(p: unknown): NormalizedPoint | NormalizedPointError

// Mapping: cssX = Math.round(x * (viewport.width  - 1))
//          cssY = Math.round(y * (viewport.height - 1))
// Rationale: CSS pixels in a width-W viewport are indexed 0..W-1.
// x=0 maps to 0; x=1 maps to W-1 (last in-bounds pixel). x=0.5 maps to (W-1)/2 rounded.
// This guarantees `page.mouse.click(cssX, cssY)` is always in-bounds.
export function normalizedToCssPx(point: NormalizedPoint, viewport: ComputerViewport): { x: number; y: number }

// Inverse, parameterized by displaySize:
//   normX = px.x / (displaySize.width  - 1)
//   normY = px.y / (displaySize.height - 1)
// Pixel inputs outside [0, displaySize.{width,height} - 1] are REJECTED, not clamped.
// "Bridge inbound" half of the bridge translation contract (v3 plan lines 413-431).
export function pixelToNormalized(
  point: { x: number; y: number },
  displaySize: ComputerDisplaySize,
): NormalizedPoint | NormalizedPointError
```

Phase 2 **rejects** out-of-range input on both the `[0,1]` and pixel sides. Clamping silently absorbs model bugs (e.g., a coord emitted for the wrong viewport) into "click somewhere on the edge"; rejection surfaces them.

Why ship both directions in Phase 2 even though Phase 2 has no model-pixel callers: the v3 plan calls out this round-trip as a required test (`docs/ultron_v3/v3-computer-use-plan.md:778`). Implementing both halves in Phase 2 lets that test land alongside the primitive instead of being deferred to whichever phase first needs the inverse direction.

DSF (`viewport.deviceScaleFactor`) is **not multiplied in** at this layer. Playwright's `page.mouse.click(cssX, cssY)` API takes CSS pixels; multiplying by DSF gives device pixels and double-clicks the wrong target on Retina displays. The v3 plan's bridge translation contract (`docs/ultron_v3/v3-computer-use-plan.md:421–423`) already says DSF multiplication only happens "if the click API requires device px" — Playwright's does not.

### `SessionManager`: id minting, lookup, timeout, abort, cleanup-once

```ts
export interface SessionManager {
  start(opts: StartSessionOptions, signal: AbortSignal): Promise<BrowserSession>
  get(id: ComputerSessionId): BrowserSession | undefined
  stop(id: ComputerSessionId): Promise<void>
  stopAll(): Promise<void>      // for QueryEngine teardown
  // Used by BrowserSession instances to route abort/error close paths.
  requestClose(id: ComputerSessionId, reason: 'aborted' | 'timeout' | 'error'): Promise<void>
}
```

Per-session, the manager:

1. Mints a `ComputerSessionId` (branded string, `crypto.randomUUID()`).
2. Asserts `viewport.width === displaySize.width && viewport.height === displaySize.height` from settings; rejects with `viewport_mismatch` otherwise (see "Screenshot capture" below).
3. Builds the Playwright context via the injected `BrowserSessionFactory`.
4. Schedules a `setTimeout(closeOnce, maxDurationMs)` from settings; never rescheduled (sessions are bounded).
5. Subscribes to the `AbortSignal` passed at `start`; on abort, runs `closeOnce` and removes the session from the registry.
6. Wraps `closeOnce` with a "closed" flag so concurrent stop / timeout / abort can race without double-closing.

**Cleanup-once invariant:** every codepath that wants to close a session — explicit `stop`, timeout, abort, `stopAll`, error-during-navigate — calls the same private `closeOnce(id)` which (a) checks-and-sets `closed`, (b) clears the timeout, (c) detaches the abort listener, (d) awaits `context.close()` AND `browser.close()`, (e) deletes from the manager registry. Tested by firing all five concurrently against one session and asserting `context.close()` was called exactly once.

Mirrors `src/core/mcp/client.ts:120–169` (the MCP `onExit` cleanup that snapshots-then-clears in-flight state); same idea, applied to a Playwright context instead of an MCP transport.

### Domain enforcement at two layers, not just one

The v3 plan acceptance criterion is "**Navigation to denied domains is blocked before request completion**" (`docs/ultron_v3/v3-computer-use-plan.md:579`). To meet that:

1. **Pre-flight check in `navigate(url, signal)`.** Parse via `extractHost(url)` (existing — `src/web/domainPolicy.ts:26`); reject with `BrowserSessionError(kind: 'domain_denied')` before calling `page.goto`. This handles same-origin top-level navigation cleanly.

2. **`page.route('**/*', handler)` interceptor.** Even with (1), the page can issue subresource requests (analytics, third-party iframes, redirects) to non-allowlisted hosts. For each request, extract host via `extractHost(request.url())`:
   - Navigation request to a denied host → `route.abort('blockedbyclient')`.
   - Subresource request to a denied host → `route.abort('blockedbyclient')`.
   - Allowed host (or allowlist empty AND not in denylist) → `route.continue()`.

   The empty-allowlist semantics: the v3 plan says "non-test sessions require at least one allowed domain before navigation" (`docs/ultron_v3/v3-computer-use-plan.md:497`). Phase 2 enforces this at `navigate()` only — if `allowedDomains` is empty AND the session was started with `requireAllowlist: true` (default, off only for tests), `navigate()` rejects with `allowlist_empty` before doing anything.

3. **Reuse `matchDomain` and `extractHost` from `src/web/domainPolicy.ts`.** No new pattern syntax. Wildcard semantics (`*.github.com`) inherit from there.

Both layers share a tiny pure helper `isDomainAllowed(url, settings, opts)` in `policy.ts`. Phase 4's risk classifier extends `policy.ts`; Phase 2 only implements the domain piece.

**Why split policy into its own module rather than putting it in `playwrightBrowserSession.ts`:** the v3 plan's `policy.ts` is part of the canonical layout (`docs/ultron_v3/v3-computer-use-plan.md:93`). Putting domain enforcement in `policy.ts` from day one means Phase 4's risk classifier extends an existing module rather than refactoring it out of the Playwright file.

### URL scheme policy: HTTPS-only, with a test-local escape

The v3 plan says the Browser MVP must be **HTTPS-only by default** (`docs/ultron_v3/v3-computer-use-plan.md:286` and the tool-schema rule at line 205). Phase 2 enforces this in two places:

1. `policy.ts` adds `isUrlSchemeAllowed(url, opts: { allowHttpForTest: boolean })`. Returns `true` for `https:` always. Returns `true` for `http:` only when `allowHttpForTest === true`. `data:`, `file:`, `javascript:`, `chrome:`, `blob:`, `ws:`, `wss:`, `ftp:` always rejected.
2. `BrowserSession.navigate(url, signal)` calls `isUrlSchemeAllowed` before the domain check. Failure surfaces as `BrowserSessionError(kind: 'scheme_denied', host)`.

`StartSessionOptions` gains `allowHttpForTest?: boolean` (default `false`). The integration test sets it to `true` so `http://fixture.local/...` works against the in-process fixture server; production code paths never set it. `requireAllowlist: false`, `allowHttpForTest: true`, and `hostResolverRules` are all test-only escape hatches — `types.ts` JSDoc marks them so a future reader can't mistake them for production knobs.

### Missing-Chromium UX: detect at session start, point at the install command

`npm install` adds the `playwright` package but **does not** download the Chromium binary. A user who enables `computerUse` without running `npx playwright install chromium` would otherwise get a raw Playwright error like *"browserType.launch: Executable doesn't exist at .../chromium-1234/chrome-mac/Chromium.app"* — actionable only to people who already know the install command.

Phase 2 catches this case at `PlaywrightBrowserSession.start()`:

1. Wrap the `chromium.launch(...)` call in a try/catch.
2. Detect the missing-binary error shapes Playwright surfaces (substring match on `"Executable doesn't exist"` / `"browserType.launch"` / `ENOENT`). Playwright doesn't expose a typed error class; the unit test pins the substring set so future Playwright bumps surface a failing test if the message format changes.
3. Re-throw as `BrowserSessionError(kind: 'chromium_not_installed', message: 'Chromium is not installed. Run: npx playwright install chromium')`.

The new `BrowserSessionErrorKind` value `'chromium_not_installed'` joins the union. Phase 3's `ComputerStart` tool will surface this error message verbatim to the user via the tool result, so the model and the human both see the exact command to run.

The detection is **session-start-only**, not boot-time. A `QueryEngine` boot-time chromium check would slow startup for users who never invoke a Computer-Use session, and would tightly couple the engine constructor to Playwright. Lazy detection at first `start()` is cheap, scoped to actual use, and keeps the engine constructor synchronous.

### Stabilization: minimum viable, deferred enrichment

`stabilize.ts` in Phase 2 implements steps 1–4 of the v3 plan stabilization stack (`docs/ultron_v3/v3-computer-use-plan.md:299–304`):

1. Wait for the immediate action promise (caller does this — `stabilize` doesn't observe it).
2. Wait for committed navigation if the action triggered one (`page.waitForLoadState('domcontentloaded', { timeout })`).
3. Wait `'load'` opportunistically with a short cap.
4. `setTimeout` debounce of 150ms for animation tail.

Step 5 (sample two ARIA snapshots ~250ms apart) is **deferred to Phase 4**: it depends on `ariaSnapshot.ts`, which depends on Phase 4's redaction primitives. Phase 2's `stabilize.ts` exposes a `stabilize(page, signal)` function with the same signature it'll have post-Phase 4 — Phase 4 layers the ARIA sampling in without changing callers.

`networkidle` is **not** used. Playwright's own docs flag it as discouraged.

### Screenshot capture: in memory, viewport pinned to displaySize, validate

`screenshot(signal)` returns:

```ts
{
  attachment: ToolResultAttachment    // already validated & ready to attach to a ToolResult
  observation: { url: string; title: string | null }
}
```

**Phase 2 enforces `viewport === displaySize` at session start.** If a settings-config combination has them differing, `SessionManager.start()` rejects with `BrowserSessionError(kind: 'viewport_mismatch')`. This avoids the contract bug where a viewport-sized PNG would be advertised as displaySize-sized to the model. Settings still allow them to differ (`computerUseSettings.ts:23–24`), because Phase 4/Phase 6 may decouple them once a real downscaler ships — but Phase 2 doesn't pretend to support the decoupled case.

The v3 plan's "v3 simplification: one virtual display per session" (`docs/ultron_v3/v3-computer-use-plan.md:179`) gives air cover: defaulting both to 1024×768 is fine, and rejecting mismatched configs is honest about the substrate's current limit. Phase 4 (or whichever phase first needs differing viewport/displaySize, e.g., when a native bridge advertises a different `display_width_px`) ships a real `pngDownscale(buf, targetWidth, targetHeight)` and removes the start-time check.

Pipeline:

1. **At session start** (in `SessionManager.start`): assert `viewport === displaySize`; reject with `viewport_mismatch` otherwise.
2. `await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' })` → `Buffer`.
3. Encode `buf.toString('base64')`.
4. Call `validateImageAttachment(base64, 'image/png', { maxBytes, maxWidth, maxHeight })` from Phase 1. Returns `{ ok: false, ... }` on cap exceedance — the session surfaces it as `errorKind: 'screenshot_oversized'` (no truncation: a screenshot bigger than the cap is a config bug, not a runtime fallback).
5. Return the `ToolResultAttachment`. **No** `redacted: true`; redaction is Phase 4.

No tempfiles. No on-disk persistence. The v3 plan Open Question 2 (`docs/ultron_v3/v3-computer-use-plan.md:850–853`) recommends memory-only by default; Phase 2 commits to that. `debugPersistScreenshots` from settings is **not** read in Phase 2 — it's a Phase 4/6 escape hatch.

### Browser launch profile (Profile A only)

Per `docs/ultron_v3/v3-computer-use-plan.md:268–276`: v3 ships Profile A only.

`PlaywrightBrowserSession.start(opts)` does:

```ts
const launchArgs: string[] = []
if (opts.hostResolverRules) {
  // Used by the integration test to redirect fixture.local -> 127.0.0.1.
  // Production code paths never set this.
  launchArgs.push(`--host-resolver-rules=${opts.hostResolverRules}`)
}
const browser = await chromium.launch({ headless: opts.headless ?? true, args: launchArgs })
const context = await browser.newContext({
  viewport: { width: settings.viewport.width, height: settings.viewport.height },
  acceptDownloads: false,                  // Phase 4 will gate behind allowDownloads
  permissions: [],                          // explicit empty — no camera/mic/geo/clipboard
  bypassCSP: false,
  javaScriptEnabled: true,
  serviceWorkers: 'block',
  userAgent: undefined,                     // Playwright default; no spoofing
})
const page = await context.newPage()
await context.route('**/*', this.handleRoute)  // domain + scheme enforcement

// Popup blocking. `popup.close()` returns a Promise that can reject if the
// popup tore itself down between detection and close — swallow with a logged
// catch so an exotic popup teardown can't crash the session.
context.on('page', (popup) => {
  popup.close().catch((err) => this._notifyPopupError(err))
})
```

Headless is the default; Phase 4's `ComputerHandoffToUser` will require headed mode (`docs/ultron_v3/v3-computer-use-plan.md:218`) — that decision lives there, not here.

`browser` is owned by the session and closed in `closeOnce()` after `context.close()`. One browser per session avoids cross-session state.

**Trade-off note:** launching a fresh `chromium` process per session is heavier than reusing one and creating contexts. The v3 plan's design principle is sandbox-first (`docs/ultron_v3/v3-computer-use-plan.md:42`), and a per-session browser process gives stronger isolation against Chromium-level bugs than a shared browser with separate contexts. Phase 2 picks per-session browser; revisit if startup cost becomes a real issue.

### `package.json`: `playwright`, not `playwright-core`

The v3 plan Open Question 1 (`docs/ultron_v3/v3-computer-use-plan.md:845–848`) recommends `playwright`. Phase 2 picks `playwright`. Reasons:

- `playwright-core` ships *no* browser binaries and requires the caller to point at an installed Chromium — a UX surface Phase 2 doesn't want to own.
- `playwright` is the meta-package that bundles the browser-management CLI but **does not** auto-download Chromium during `npm install`. The user (or CI, or a postinstall hook we choose to add later) must run `npx playwright install chromium` to fetch the binary. This matches current Playwright docs (https://playwright.dev/docs/browsers).
- Package size hit on disk after `npx playwright install chromium` is ~170 MB — a one-time cost on a machine with Computer-Use enabled. Acceptable for v3.

Add to `dependencies`. **Not** `peerDependencies`: Computer-Use is a first-class Ultron feature when enabled; it's not optional in the way `pyodide` is.

CLAUDE.md gets a one-line note under "Commands":

> Computer-Use (v3) requires Chromium. After `npm install`, run `npx playwright install chromium` once. CI may set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` since the integration suite is env-gated and not run on CI.

Phase 2 does **not** add a `postinstall` script. A postinstall that downloads ~170 MB on every fresh `npm install` is hostile to users who never enable Computer-Use; if a future phase wants to streamline this, it can add an opt-in `npm run setup-computer-use` script that just shells out to the Playwright CLI.

Playwright API surface this design relies on (verified against current docs):

- `chromium.launch({ headless, args })` — https://playwright.dev/docs/api/class-browsertype
- `browser.newContext({ viewport, permissions, serviceWorkers, ... })` — https://playwright.dev/docs/api/class-browsercontext
- `context.route(pattern, handler)` and `route.abort('blockedbyclient')` — https://playwright.dev/docs/api/class-route
- `page.screenshot({ type: 'png', animations: 'disabled' })` returning a `Buffer` — https://playwright.dev/docs/screenshots
- `page.goto(url, { waitUntil: 'commit', timeout })` — https://playwright.dev/docs/api/class-page#page-goto
- `page.waitForLoadState('domcontentloaded', { timeout })` — https://playwright.dev/docs/api/class-page#page-wait-for-load-state (and the doc note that `networkidle` is discouraged)

### Abort threading: routed through `SessionManager.closeOnce`

Every public method on `BrowserSession` takes an `AbortSignal`. **Abort never short-circuits cleanup by directly calling `page.context().close()`** — that path bypasses the `SessionManager` registry, leaks the `Browser` process (only the context closes), and races the `closed` flag.

Instead, abort is wired through the manager's cleanup-once path:

- `navigate(url, signal)`, `screenshot(signal)`, `stabilize(signal)`: each registers a `{ once: true }` abort listener that calls `this._sessionManager.requestClose(this.id, 'aborted')`. `closeOnce` flips the `closed` flag, calls `await context.close()` AND `await browser.close()`, and removes the session from the registry.
- The in-flight Playwright call (`page.goto`, `page.screenshot`, `page.waitForLoadState`) rejects naturally because its underlying context is closing. The session catches the resulting "Target page, context or browser has been closed" error and re-throws it as `BrowserSessionError(kind: 'aborted')`.
- The success path of each method calls `signal.removeEventListener('abort', listener)` to keep listener count bounded across long sessions.

This design has three properties:

1. **One close path.** Every cleanup — explicit `stop`, timeout, abort, `stopAll`, error-during-navigate — goes through `closeOnce`. The "exactly one `context.close()` AND `browser.close()` per session" invariant is testable because there's only one place to count from.
2. **No leaked browser process.** A direct `page.context().close()` only closes the context; the `Browser` would still be owned by the session and would survive abort until GC. Routing through `closeOnce` ensures both `context.close()` and `browser.close()` run.
3. **Listener leak is bounded by definition.** Per-call listener accumulation is impossible because the listener is removed in both success and abort paths.

**Listener-leak testing.** `AbortSignal` does not expose a public `eventNames()` accessor — `EventTarget` keeps its listener list private. Instead, the test injects a spy `AbortController` whose `signal.addEventListener` and `signal.removeEventListener` are wrapped to count net registrations. The session is exercised through 100 `screenshot()` calls and the spy asserts `addedCount === removedCount` at the end. This validates the discipline without depending on undocumented runtime internals.

Mirrors `src/core/mcp/client.ts:120–169` for the listener register/remove discipline and the snapshot-then-clear cleanup pattern.

### Test strategy: unit fakes + opt-in integration

**Unit tests (always run in `npm run test`):**

- `coordinates.test.ts` — pure math. No Playwright import. Round-trip test grid for `(NormalizedPoint, viewport, displaySize, dsf)` combinations. Out-of-range and NaN inputs assert structured errors (rejection, not clamping).
- `policy.test.ts` — `isDomainAllowed` matrix (empty allowlist + denylist hit, allowlist hit + denylist miss, wildcard match, apex vs subdomain) **and** `isUrlSchemeAllowed` matrix (`https:` allowed, `http:` rejected unless test flag, `data:` / `file:` / `javascript:` always rejected).
- `sessionManager.test.ts` — uses a `FakeBrowserSession` that records `close()` calls. Tests cover: start/get/stop, timeout fires close, abort fires close, stop after timeout is a no-op, concurrent abort/stop/timeout closes once, `viewport !== displaySize` at start rejects with `viewport_mismatch`.
- `stabilize.test.ts` — stubs `page.waitForLoadState` and a fake clock. Tests cover: navigation-commit path waits for `domcontentloaded` then debounce, timeout from `loadStateTimeoutMs` rejects with a clear error, abort rejects.
- `playwrightBrowserSession.test.ts` — wiring tests only. Asserts the session passes `viewport`, `headless`, `args` to a mock factory; asserts `route` handler is registered; asserts the missing-Chromium error path: a mock factory that throws `Error('browserType.launch: Executable doesn\'t exist at /path/Chromium')` is translated into `BrowserSessionError(kind: 'chromium_not_installed')` whose message contains `npx playwright install chromium`. Does not exercise method bodies (those are covered in the integration suite).

**Integration tests (`*.integration.test.ts`, gated by env var):**

- `playwrightBrowserSession.integration.test.ts` — gated by `process.env.ULTRON_PLAYWRIGHT_INTEGRATION === '1'` (mirroring how `seatbelt.integration.test.ts:30` gates on `isDarwin`). Runs through `chromium.launch()` against in-process HTTP fixture servers.

Why env-var gating, not platform gating: Playwright works on all three OSes the project targets, so platform gating is wrong; what we want to gate on is "did the user run `npx playwright install`?" Using an explicit opt-in env var keeps `npm run test` fast on CI without a heavy chromium download.

**Integration-test host strategy.** `fixture.local` and `denied.local` do not resolve via the OS resolver, and `localhost` is rejected by `isValidDomainPattern` (single-label hostnames fail the `labels.length < 2` check at `src/web/domainPolicy.ts:53`). The integration test therefore:

1. Boots two `http.createServer` instances bound to `127.0.0.1` on two distinct ports (`fixturePort`, `deniedPort`).
2. Launches Chromium with `--host-resolver-rules="MAP fixture.local:80 127.0.0.1:<fixturePort>, MAP denied.local:80 127.0.0.1:<deniedPort>"`. Chromium's host resolver rules redirect by hostname:port, so the test can address `http://fixture.local/` and `http://denied.local/` without touching the OS resolver.
3. Sets `allowHttpForTest: true`, `allowedDomains: ['fixture.local']`, `requireAllowlist: true` on the session (the first two are test-only).
4. Exercises the four roadmap acceptance criteria.

`fixture.local` and `denied.local` both pass `isValidDomainPattern` (two labels, valid characters), so the existing domain policy machinery accepts them as patterns without modification.

CLAUDE.md gets a "Run integration tests:" line: `ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run src/core/computer/playwrightBrowserSession.integration.test.ts`.

### What does **not** change in Phase 2

- `src/sdk/QueryEngine.ts` — Phase 0 already calls `validateComputerUseSettings` at construction and discards the result. Phase 2 still discards it. **Phase 3** wires the result into `createDefaultRegistry` and into a `SessionManager` lifecycle (created at QE construction, `stopAll()` called on dispose).
- `src/core/tools/registry.ts` — no Computer-Use tools to register yet (Phase 3).
- `src/core/query.ts` — no changes. The substrate is callable from outside the loop; Phase 3 calls it from a tool.
- `src/core/messages.ts` / `normalizeMessages.ts` — Phase 1 already taught these about image-bearing tool results.
- `src/audit/*` — Phase 1 already redacts image bytes. Phase 2 emits no audit events directly.

## Schema

### `src/core/computer/types.ts` (new)

```ts
export type ComputerSessionId = string & { readonly __brand: 'ComputerSessionId' }

export type ComputerEnvironmentKind = 'browser' | 'desktop'

export type ComputerViewport = {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
}

export type ComputerDisplaySize = {
  readonly width: number
  readonly height: number
}

export type NormalizedPoint = {
  readonly x: number   // 0..1, validated, finite
  readonly y: number
}

export type ScreenshotResult = {
  readonly attachment: import('../tools/imageAttachment.js').ToolResultAttachment
  readonly observation: { readonly url: string; readonly title: string | null }
}

export type StartSessionOptions = {
  readonly headless?: boolean
  // TEST-ONLY: skip the "non-empty allowedDomains required" check.
  readonly requireAllowlist?: boolean
  // TEST-ONLY: permit `http:` URLs (default: HTTPS-only).
  readonly allowHttpForTest?: boolean
  // TEST-ONLY: forwarded to chromium as --host-resolver-rules so the integration
  // test can MAP fixture.local:80 -> 127.0.0.1:<fixturePort>.
  readonly hostResolverRules?: string
}

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

export class BrowserSessionError extends Error {
  readonly kind: BrowserSessionErrorKind
  readonly host?: string
  constructor(kind: BrowserSessionErrorKind, message: string, host?: string)
}

export interface BrowserSession {
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
}
```

### `src/core/computer/coordinates.ts` (new)

Three pure functions plus a `NormalizedPointError` discriminated-union result type. Signatures shown in §"Coordinate conversion" above.

### `src/core/computer/policy.ts` (new, Phase 2 slice)

```ts
export type DomainCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'denied' | 'not_in_allowlist' | 'malformed_url' }

export function isDomainAllowed(
  url: string,
  settings: { allowedDomains: readonly string[]; deniedDomains: readonly string[] },
  opts: { requireAllowlist: boolean },
): DomainCheck

export type SchemeCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'unsupported_scheme' | 'malformed_url' }

// HTTPS is always allowed. HTTP is allowed only when allowHttpForTest is true.
// data:, file:, javascript:, chrome:, blob:, ws:, wss:, ftp:, etc. always rejected.
export function isUrlSchemeAllowed(
  url: string,
  opts: { allowHttpForTest: boolean },
): SchemeCheck
```

Phase 4 grows this module with risk classification.

### `src/core/computer/sessionManager.ts` (new)

Class `SessionManager` with `start / get / stop / stopAll / requestClose`, internal `closeOnce(id)` private method. Constructor takes `{ settings: ComputerUseSettings, factory: BrowserSessionFactory }` so tests can swap the factory for `FakeBrowserSession`.

### `src/core/computer/stabilize.ts` (new)

```ts
export async function stabilize(
  page: import('playwright').Page,
  signal: AbortSignal,
  opts?: { animationDebounceMs?: number; loadStateTimeoutMs?: number },
): Promise<void>
```

### `src/core/computer/playwrightBrowserSession.ts` (new)

Class `PlaywrightBrowserSession implements BrowserSession`, plus a `BrowserSessionFactory` type and a default factory that calls `chromium.launch(...)`. The factory injection is what lets `sessionManager.test.ts` test against a fake without ever importing Playwright.

## Files

### New

| Path | Purpose |
|---|---|
| `docs/ultron_v3/v3-phase2-design.md` | This file |
| `src/core/computer/types.ts` | `BrowserSession` interface, errors, branded types |
| `src/core/computer/coordinates.ts` | Pure coordinate math (NormalizedPoint ↔ CSS px ↔ display px) |
| `src/core/computer/coordinates.test.ts` | Round-trip + cap + invalid-input tests |
| `src/core/computer/policy.ts` | `isDomainAllowed` + `isUrlSchemeAllowed` (Phase 2 slice; Phase 4 extends with risk classifier) |
| `src/core/computer/policy.test.ts` | Allowlist/denylist matrix + scheme matrix |
| `src/core/computer/sessionManager.ts` | Lifecycle, timeout, abort, cleanup-once, viewport-mismatch start guard |
| `src/core/computer/sessionManager.test.ts` | Concurrency tests with `FakeBrowserSession`, spy AbortController for listener-leak test |
| `src/core/computer/stabilize.ts` | Layered post-action stabilization (Phase 2 minimum) |
| `src/core/computer/stabilize.test.ts` | Fake-clock timing tests |
| `src/core/computer/playwrightBrowserSession.ts` | Profile A implementation |
| `src/core/computer/playwrightBrowserSession.test.ts` | Wiring/factory unit tests (no Playwright import) |
| `src/core/computer/playwrightBrowserSession.integration.test.ts` | Real-Playwright tests, env-gated, uses `--host-resolver-rules` |

### Modified

| Path | Change |
|---|---|
| `package.json` | Add `playwright` to `dependencies`; commit the lockfile |
| `CLAUDE.md` | Note: `npx playwright install chromium` after `npm install`; integration tests via `ULTRON_PLAYWRIGHT_INTEGRATION=1` |
| `docs/ultron_v3/v3-computer-use-plan.md` | Phase 2 deliverables (~lines 555–583) — record the design decisions formalized here (policy.ts split, missing-chromium UX, `playwright` not `-core`, viewport=displaySize Phase 2 invariant) |

### Reused (no modification)

- `src/core/tools/imageAttachment.ts` — `validateImageAttachment` + `ToolResultAttachment` consumed by `screenshot()`.
- `src/web/domainPolicy.ts` — `extractHost`, `matchDomain`, `isValidDomainPattern` consumed by `policy.ts`.
- `src/config/computerUseSettings.ts` — `ComputerUseSettings` already has every knob Phase 2 needs.
- `src/core/sandbox/seatbelt.integration.test.ts` — structural template for env/platform-gated integration test.
- `src/core/mcp/client.ts:120–169` — structural template for abort + cleanup-once.

## Implementation order

Two batches. Batch 1 is docs only; pause for review before Batch 2.

### Batch 1 — Docs

1. Write `docs/ultron_v3/v3-phase2-design.md` (this file).
2. Amend `docs/ultron_v3/v3-computer-use-plan.md` Phase 2 deliverables (~lines 555–583) to record the design decisions formalized here.

**Pause for review.** User reviews the design doc and roadmap amendments before any code lands.

### Batch 2 — Code

3. Add `playwright` to `package.json` `dependencies`. Run `npm install`. Commit the lockfile alongside.
4. Create `src/core/computer/types.ts` — interfaces, branded `ComputerSessionId`, `BrowserSessionError` class.
5. Create `src/core/computer/coordinates.ts` + `coordinates.test.ts` — pure math, ship both directions.
6. Create `src/core/computer/policy.ts` + `policy.test.ts` — `isDomainAllowed`, `isUrlSchemeAllowed`.
7. Create `src/core/computer/stabilize.ts` + `stabilize.test.ts` — layered stabilization, fake-clock tested.
8. Create `src/core/computer/sessionManager.ts` + `sessionManager.test.ts` — uses a `FakeBrowserSession` injected via `BrowserSessionFactory`. Concurrency tests (close-once invariant).
9. Create `src/core/computer/playwrightBrowserSession.ts` + `playwrightBrowserSession.test.ts` — Profile A implementation. Uses `chromium.launch(...)`, wires `route` interceptor (domain + scheme), calls `validateImageAttachment` for the screenshot path, plumbs abort through `SessionManager.requestClose`. Wiring/factory unit tests stay Playwright-free.
10. Create `src/core/computer/playwrightBrowserSession.integration.test.ts` — env-var-gated; runs against two in-process Node HTTP fixture servers with `--host-resolver-rules`. Asserts the four roadmap acceptance criteria end-to-end.
11. Add the CLAUDE.md notes: chromium install via `npx playwright install chromium`, integration-test env-var line.

## Verification

### Unit tests (always run)

- `coordinates.test.ts`:
  - `validateNormalizedPoint({ x: 0, y: 0 })` → ok; `{ x: 1, y: 1 }` → ok.
  - `{ x: -0.0001 }`, `{ x: 1.0001 }`, `NaN`, `Infinity`, missing fields → structured error.
  - Round-trip table: for each `(viewport, displaySize, dsf)` in DSF=1 and DSF=2 with `viewport === displaySize` (1024×768) AND `viewport ≠ displaySize` (e.g., viewport 1280×800, displaySize 1024×768), assert `pixelToNormalized(p, displaySize)` followed by `normalizedToCssPx(_, viewport)` produces stable results within 1 pixel rounding.
  - `normalizedToCssPx({ x: 0.5, y: 0.5 }, { width: 1024, height: 768, dsf: 1 })` → `{ x: Math.round(0.5 * 1023), y: Math.round(0.5 * 767) }`.
- `policy.test.ts`:
  - Empty allowlist + `requireAllowlist: true` → `not_in_allowlist`.
  - Empty allowlist + `requireAllowlist: false` → `allowed: true` (test mode).
  - Denylist hit beats allowlist hit (denylist priority).
  - Wildcard `*.github.com` matches `gist.github.com`, not `github.com` (apex excluded).
  - `extractHost` returning `null` (malformed URL) → `malformed_url`.
  - `https://example.com` → `allowed: true` regardless of `allowHttpForTest`.
  - `http://example.com` with `allowHttpForTest: false` → `unsupported_scheme`.
  - `http://example.com` with `allowHttpForTest: true` → `allowed: true`.
  - `data:`, `file:`, `javascript:`, `blob:`, `ws:`, `wss:`, `ftp:` → `unsupported_scheme` regardless of flag.
- `sessionManager.test.ts` (uses `FakeBrowserSession`):
  - `start` returns a session retrievable via `get`.
  - `stop(id)` calls `close()` once and removes from registry.
  - `start` followed by timeout firing → close called once.
  - `start` then `signal.abort()` → close called once.
  - Concurrent `stop + abort + timeout` against the same session → exactly one `close()` call.
  - `stopAll()` closes every live session.
  - `get` after `stop` → `undefined`.
  - `viewport !== displaySize` at start → `BrowserSessionError(kind: 'viewport_mismatch')`.
- `stabilize.test.ts`:
  - With a fake `page` whose `waitForLoadState('domcontentloaded')` resolves immediately, `stabilize` resolves after the animation debounce.
  - With a fake `page` whose `waitForLoadState` hangs, abort signal rejects with a clear error.
- `playwrightBrowserSession.test.ts` (no Playwright import — only construction-time wiring via the factory mock):
  - Factory is called with the right viewport/headless/args.
  - Mock factory throwing `Error("browserType.launch: Executable doesn't exist at ...")` is translated into `BrowserSessionError(kind: 'chromium_not_installed')`.
  - Real method bodies are exercised in the integration test.

### Integration tests (env-gated)

- `playwrightBrowserSession.integration.test.ts`:
  - Setup: spawn two `http.createServer` instances bound to `127.0.0.1` on `fixturePort` and `deniedPort`. The fixture server serves `<html><title>fixture</title><img src="//denied.local/track.gif"></html>` so subresource blocking can be verified via the denied server's request log. Launch the session with `hostResolverRules: \`MAP fixture.local:80 127.0.0.1:${fixturePort}, MAP denied.local:80 127.0.0.1:${deniedPort}\``, `allowedDomains: ['fixture.local']`, `allowHttpForTest: true`, `requireAllowlist: true`.
  - Acceptance 1 (isolated context): start session; assert `context.storageState()` cookies+origins are empty; close.
  - Acceptance 2 (denied domain blocked):
    - top-level: navigate to `http://denied.local/`; assert `BrowserSessionError(kind: 'domain_denied')`, AND assert the denied server's request log is empty.
    - subresource: navigate to `http://fixture.local/` (which embeds the denied subresource); poll the denied server's request log for 1s; assert it stayed empty.
  - Acceptance 3 (screenshot dimensions/MIME): navigate to `fixture.local`; screenshot; assert `attachment.mediaType === 'image/png'`, `width === 1024`, `height === 768`, base64 round-trips through `validateImageAttachment`.
  - Acceptance 4 (abort closes browser AND context):
    - start session; in parallel, fire `signal.abort()` while `navigate` is mid-flight.
    - Assert the resolved promise rejects with `BrowserSessionError(kind: 'aborted')`.
    - Assert `session.isClosed()` is true.
    - Assert the manager's internal `closeOnce` ran exactly once.
    - Assert the chromium subprocess for this session has exited (poll `browser.process()?.pid` via `process.kill(pid, 0)` until ESRCH, with a 5s cap). This proves `browser.close()` ran, not just `context.close()`.

### Manual smoke

1. `npm install` — `playwright` package installs without auto-downloading Chromium. Document `npx playwright install chromium` for the user.
2. `npm run typecheck` — clean.
3. `npm run test` — green; integration tests skipped without env var.
4. `ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run src/core/computer/playwrightBrowserSession.integration.test.ts` — green.
5. `git status` — only files in the "Files" section above are touched.

## Open questions (resolve during implementation, not blocking design)

1. **Should `viewport.deviceScaleFactor` be exposed in `StartSessionOptions`, or always pinned to 1 for v3?** The v3 plan says `1024x768` default and "one virtual display per session" (`docs/ultron_v3/v3-computer-use-plan.md:179`). DSF=1 is simplest and matches the bridge translation contract default. Tentative: pin to 1 in Phase 2; expose in Phase 4 if a Retina-rendering test fixture surfaces a need.
2. **Where does `SessionManager` live in `QueryEngine`'s lifecycle?** Phase 2 ships the class but doesn't wire it. Phase 3 will. Tentative: a private field on `QueryEngine`, instantiated when `computerUse.enabled === true`, with `stopAll()` called from a yet-to-exist engine `dispose()` path. Decide in Phase 3.
3. **Should `PlaywrightBrowserSession` reuse a single `Browser` across sessions to amortize launch cost?** Trade-off: per-session is simpler and stronger isolation; single-browser-many-contexts is faster (~200ms/session saved). Tentative: per-session for v3; revisit in Phase 6.
4. **Should we add an `npm run setup-computer-use` script that wraps `npx playwright install chromium`?** Phase 2 deliberately ships no postinstall hook (would force a 170 MB download on users who never enable Computer-Use). A named script gives an opt-in path without a hook. Tentative: defer to Phase 7 (docs + release).
5. **Should `FakeBrowserSession` live in the test file or in a shared `_test/fakes.ts`?** Tentative: inline in `sessionManager.test.ts` for Phase 2; promote if Phase 3's tool tests want to reuse it.

## Out of scope (mirrors v3 roadmap)

- Computer-Use tool surface — Phase 3 (`docs/ultron_v3/v3-computer-use-plan.md:585–615`).
- Risk classification, password redaction, approval prompts — Phase 4.
- DOM-first action path (`ComputerObserveActions`, `ComputerActAtom`) — Phase 4b.
- System-prompt guidance for Computer-Use — Phase 5.
- Eval fixtures — Phase 6.
- Native provider Computer-Use bridges — Stretch Phase.
- Profile B (managed stealth) and Profile C (container desktop) — future environment adapters.
- Direct host desktop control — explicitly forbidden by v3 scope.
