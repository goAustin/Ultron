# v3 CDP Backend Design: Drive a User-Owned Chrome via connectOverCDP

## Status

Drafted; not yet implemented. Plan file: `~/.claude/plans/yes-draft-option-3-async-snail.md`. Predecessors: Phases 0–7 (v3 baseline, all committed). Successor: none — this is a small additive backend variant within Profile A, not a new phase.

This is an additive launcher path next to the existing local-launch default. Profile B (managed stealth) and Profile C (container desktop) remain out of scope per `v3-computer-use-plan.md:267-275`.

### Pre-implementation corrections (v0 → v1)

A pre-implementation review caught four issues in v0 of this design; the resolutions are baked into the text below:

1. **`browser.close()` over CDP is safe and required.** v0 claimed `browser.close()` would kill the user's whole Chrome and proposed gating it on a `launchMode` field. The Playwright types are explicit (`node_modules/playwright-core/types/types.d.ts:9820-9826`): for a connected browser, `close()` *clears the contexts Playwright created and disconnects from the browser server*. The user's Chrome is unaffected. Skipping the call would leak a CDP WebSocket per session. **Resolution: drop `launchMode`; call `browser.close()` in both modes.** The "user's Chrome survives session teardown" property comes free from `connectOverCDP` semantics — we don't need to engineer it.
2. **`chromium.launchServer()` is the wrong harness for CDP integration tests.** It returns a Playwright-protocol endpoint paired with `chromium.connect()`, not a CDP endpoint for `connectOverCDP()` (`types.d.ts:15681-15688`). **Resolution: spawn `chromium.executablePath()` directly with `--remote-debugging-port=0`, parse the assigned port from stderr (`DevTools listening on ws://…:PORT/…`), then `connectOverCDP`.**
3. **Factory must fail closed for `backend: 'cdp'` without an endpoint.** v0's selector silently fell back to `defaultLaunchChromium`, contradicting the "clear failure rather than silent fallback" goal for SDK callers that bypass `ComputerStart.validateInput`. **Resolution: throw `BrowserSessionError('cdp_connect_failed', …)` immediately in the factory when `backend === 'cdp' && cdpEndpoint === undefined`.**
4. **`headless: true` + CDP needs explicit semantics.** `headless` is a launch-time flag for a spawned binary; it has no meaning when attaching to a Chrome the user has already started. **Resolution: reject the combination in `ComputerStart.validateInput`.** *(Initially proposed: force `session.headless = false` for CDP. Corrected post-review — see v1 → v2 below.)*

### Post-implementation corrections (v1 → v2)

A second review caught three issues in v1; the resolutions are baked into the text below:

1. **CDP session visibility was a lie.** v1 forced `session.headless = false` for CDP, on the (false) premise that CDP users always run a visible Chrome. The integration test exposed it: a Chromium spawned with `--headless=new` reported `headless: false`, which would let `ComputerHandoffToUser` fire against an actually-invisible Chrome. **Resolution: introduce `computerUse.cdpAssumeVisible: boolean` (default `false`).** For CDP sessions, `BrowserSession.headless = !cdpAssumeVisible`. The default is fail-safe — CDP sessions report `headless: true` (invisible, refuse handoff) until the operator explicitly opts in. Power users who run a visible Chrome with `--remote-debugging-port` set `cdpAssumeVisible: true`.
2. **`validateInput` checked `headless: true` against the EXPLICIT backend, not the EFFECTIVE one.** With `computerUse.cdpEndpoint` set globally and `{ headless: true }` passed (no explicit `backend`), v1's validator accepted the input, the call-site defaulted backend to `'cdp'`, and the factory silently dropped `headless: true`. The model's intent ("invisible session") was lost without an error. **Resolution: compute the EFFECTIVE backend in `validateInput` first** (explicit input → defaulted from `settings.cdpEndpoint`) and run the CDP rules against that. The error message points the model at `backend: "launch"` as the escape hatch when it really wants a headless bundled-Chromium session.
3. **`ComputerUseSettingsInput` was stale.** The TS shape used by `writeSettingsConfig` lacked `cdpEndpoint`, `cdpAssumeVisible`, and `requireAllowlistAtStart` (the last predates the CDP work but was missed earlier). Runtime JSON still validates because `validateComputerUseSettings(raw: unknown)` parses anything; SDK callers writing settings programmatically through `writeSettingsConfig` couldn't include these fields without a TS cast. **Resolution: add all three fields to `ComputerUseSettingsInput` in `src/config/settingsConfig.ts`.**

## Context

`ComputerStart` today always calls `chromium.launch()` against Playwright's bundled "Chromium for Testing" binary in `defaultLaunchChromium` (`src/core/computer/playwrightBrowserSession.ts:83-138`). That binary is separate from the user's installed Chrome and runs with an empty profile, which produces two predictable frictions:

1. **JD/Gmail/etc. anti-bot detection.** WAFs and slider captchas key on the headless Chromium fingerprint. The repro that motivated this design is JD: a `ComputerNavigate` against `search.jd.com` redirected into `cfe.m.jd.com/privatedomain/risk_handler/...`, and the page rendered no actionable atoms, blocking the agent.
2. **`OpenInBrowser` and `ComputerStart` produce two unrelated windows.** `OpenInBrowserTool` (`src/tools/OpenInBrowserTool.ts:107-120`) shells out to the OS launcher and immediately `unref()`s the child handle — there is no way to drive that window. `ComputerStart` then opens an entirely separate Chromium-for-Testing window for automation. Users see two browsers and reasonably ask why.

A **CDP backend** addresses fork (1) by using the user's real Chrome process (real fingerprint, real cookies seeded via `storageState`) and partially addresses fork (2) by surfacing the agent's window inside the same Chrome the user can already see. The seam already exists — `createPlaywrightSessionFactory` accepts a pluggable `LaunchChromiumFn` (`playwrightBrowserSession.ts:69-79, 160-163`) — so this design adds one launcher implementation and threads one settings field through; it touches no policy, no tools other than `ComputerStart`'s schema, no observation pipeline.

This is **not Profile B**. Profile B is a managed stealth backend (Browserbase / Anchor / Hyperbrowser); the CDP backend is still Profile A — a local Playwright session against a local Chrome. The honest framing is: "the user owns the Chrome process; Playwright attaches to it."

### Pre-implementation review notes

Two design decisions deferred to user review and resolved before this draft:

1. **Attach mode.** Two viable shapes — fresh isolated context inside the user's Chrome, or attach to the user's existing default context (sharing tabs and cookies). User selected **isolated new context** to keep the agent's actions from clobbering live tab state. Concretely: `connectOverCDP` → `browser.newContext({ storageState })` → `context.newPage()`. The user's existing tabs are untouched; `route('**/*')` interception stays scoped to the new context; `storageState` rehydration still applies (Phase 4·3 path is preserved).
2. **Endpoint configuration.** Two viable shapes — global setting vs. per-session input only. User selected **global setting + per-session override**. The endpoint lives in `~/.ultron/settings.json` under `computerUse.cdpEndpoint`; when set, `ComputerStart` defaults to the CDP backend; an optional `backend: 'launch' | 'cdp'` input override is accepted on `ComputerStart` for the case where a user wants one session on the local-launch path despite the global default.

## Goals

1. **`connectChromiumOverCdp` launcher.** A new `LaunchChromiumFn` next to `defaultLaunchChromium` that calls `chromium.connectOverCDP(endpoint)`, then creates an isolated `BrowserContext` via `browser.newContext({ ... })`. Returns the same `LaunchedBrowser` shape (`{ browser, context, page }`), so nothing downstream changes.
2. **Factory-side launcher selection.** `createPlaywrightSessionFactory` checks `options.backend === 'cdp' && options.cdpEndpoint !== undefined` and selects the CDP launcher; otherwise it uses `defaultLaunchChromium`. The seam is internal — `BrowserSessionFactory` callers (just `SessionManager`) see no change.
3. **`close()` is unchanged; no `launchMode` field.** Both modes call `context.close()` then `browser.close()`. For CDP, `browser.close()` clears the Playwright-created contexts and disconnects the WebSocket without terminating the user's Chrome (per Playwright type doc `types.d.ts:9820-9826`); skipping it would leak the WebSocket. The user's Chrome staying alive is a property of `connectOverCDP`, not something we engineer.
4. **Settings field.** Add `cdpEndpoint?: string` to `ComputerUseSettings`. Validator rejects non-`http(s)`/`ws(s)` schemes and malformed URLs. Default `undefined`. No effect when `enabled: false`.
5. **`ComputerStart` schema delta.** Optional `backend: 'launch' | 'cdp'` enum on the input. Default behavior: when `cdpEndpoint` is set in settings, the default is `'cdp'`; otherwise `'launch'`. Validator computes the *effective* backend (explicit input → defaulted from `settings.cdpEndpoint`) FIRST, then rejects `effective === 'cdp'` with no endpoint configured AND rejects `effective === 'cdp' + headless: true`. Computing the effective backend prevents `{ headless: true }` from silently flipping to CDP via the global default and getting dropped by the factory.
6. **`cdp_connect_failed` error kind.** Add to `BrowserSessionErrorKind`. Surfaced when `connectOverCDP` rejects (Chrome not running, port unreachable, version skew) AND when the factory is invoked with `backend: 'cdp'` but no endpoint (fail-closed for SDK callers that bypass `ComputerStart.validateInput`). Error message includes the endpoint (when present) and a remediation hint.
7. **`session.headless` for CDP sessions.** Reflects `computerUse.cdpAssumeVisible` (default `false`): `BrowserSession.headless = !cdpAssumeVisible`. Default is fail-safe — CDP sessions report `headless: true` (invisible, `ComputerHandoffToUser` refuses) until the operator explicitly opts in. We cannot introspect the CDP-attached Chrome's actual `--headless` flag, so the conservative default is "treat as invisible." Power users running a visible Chrome with `--remote-debugging-port` set `cdpAssumeVisible: true` to allow handoff.
8. **Tests.**
   - Unit: factory test asserting `backend: 'cdp'` with no endpoint throws `BrowserSessionError('cdp_connect_failed', …)` synchronously, before any chromium API is touched.
   - Unit: stub-launcher case for the CDP path that asserts `close()` calls both `context.close()` and `browser.close()` exactly once — matching the launch path's behavior, not gating either call.
   - Unit: `computerUseSettings.test.ts` validation cases for `cdpEndpoint` — valid `http://127.0.0.1:9222`, invalid scheme, malformed URL.
   - Unit: `ComputerTools.test.ts` — `backend: 'cdp'` without endpoint configured rejects; `backend: 'cdp' + headless: true` rejects; default selection logic.
   - Integration (separate env gate `ULTRON_PLAYWRIGHT_CDP_INTEGRATION=1`): spawn a real Chromium via `child_process.spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=<tmp>', '--no-first-run'])`, parse the assigned port from stderr's `DevTools listening on ws://127.0.0.1:PORT/...` line, point `connectOverCDP` at `http://127.0.0.1:PORT`, run navigate + screenshot + abort. Assert that `session.close()` does **not** stop the spawned Chromium (verify by checking the process is still alive AND a fresh `connectOverCDP` to the same port succeeds). Tear down with `process.kill('SIGTERM')` in `afterAll`.
9. **Docs delta.**
   - `docs/computer-use.md` — new "Driving your real Chrome via CDP" section with the manual Chrome-launch command, the settings.json snippet, and the safety implications.
   - `docs/ultron_v3/v3-computer-use-plan.md` Profile-A row — append a parenthetical noting the CDP variant.

## Non-goals

- **Not Profile B.** No managed-stealth integration, no residential IPs, no CAPTCHA solving. CDP keeps everything local; the user's Chrome fingerprint is what helps with passive bot detection. Slider captchas still require `ComputerHandoffToUser`.
- **Not attaching to existing tabs.** Resolved in pre-implementation review (option 2). The agent always operates inside a new isolated context within the CDP-attached Chrome. Tab-attachment can ship later as a separate flag if demand materializes.
- **Not unifying with `OpenInBrowserTool`.** That tool stays as-is. The CDP backend doesn't reuse the OS-launcher window because that window has no debugging port (and forcing one would require relaunching the user's Chrome, which we won't do).
- **No new observation/action methods.** Every existing `BrowserSession` method works unchanged over CDP because they all key on `_context` and `_page`, not on how the browser was launched.
- **No automatic Chrome launch.** If the user hasn't started Chrome with `--remote-debugging-port`, `ComputerStart` fails with `cdp_connect_failed`. We do not spawn Chrome on the user's behalf.
- **No CDP version negotiation.** Playwright `connectOverCDP` requires a recent-enough Chrome (≥ ~90); failure surfaces cleanly via the new error kind. We don't probe versions.
- **No multi-endpoint config.** One `cdpEndpoint` per Ultron settings file. SDK callers wanting per-session endpoints can pass it explicitly via the `StartSessionOptions` thread.

## Key design decisions

### Why isolated new context (not attach-existing)

`browser.contexts()[0]` over CDP returns the user's default context with their cookies and pages. The agent driving that context could:

- Navigate the user's logged-in tabs to attacker-chosen URLs.
- Apply `route('**/*')` interception that affects every tab in that context (every login the user is mid-flow on).
- See cookies the user never authorized for automation use.

The isolated-context shape (`browser.newContext({ storageState })`) avoids all three. The agent gets a new window inside the user's Chrome process — same fingerprint, same TLS stack, same OS-level integration — but with a clean cookie jar that only contains what `loadStorageState(host)` rehydrated. The user's open tabs are untouched. `route('**/*')` only filters the agent's own context.

The cost: CDP doesn't help bypass cookie-based bot detection on first hit (the new context has no JD cookies even if the user is logged in elsewhere in the same Chrome). For sites where the user has already authenticated, they still need `ComputerHandoffToUser` to log in inside the agent's window once, after which `storageState` persistence kicks in for subsequent sessions.

### Why `browser.close()` is safe (and required) in both modes

The intuition that `browser.close()` would terminate the user's Chrome is **wrong** for the connected case. Playwright's type doc (`node_modules/playwright-core/types/types.d.ts:9820-9826`) is explicit:

> "In case this browser is obtained using `browserType.launch`, closes the browser and all of its pages. **In case this browser is connected to, clears all created contexts belonging to this browser and disconnects from the browser server.**"

For a CDP-connected browser, `browser.close()`:

1. Closes every `BrowserContext` Playwright created on this connection.
2. Disconnects the WebSocket to the user's Chrome.
3. Does **not** terminate the user's Chrome process.

Skipping the call would *leak* the WebSocket per session — every `ComputerStart` would accumulate a dangling CDP connection until Ultron exits. Calling it cleans up correctly. So `close()` stays unchanged from today:

```ts
async close(): Promise<void> {
  if (this._closed) return
  this._closed = true
  this._lastAriaSnapshot = null
  this._atomCache = null
  try { await this._context.close() } catch { /* swallow */ }
  try { await this._browser.close() } catch { /* swallow */ }
}
```

The "user's Chrome stays alive after a session ends" property is a guarantee from `connectOverCDP` itself, not something the design has to engineer. No `launchMode` field is needed.

The disconnect handler installed in Phase 6 (`_installDisconnectHandler`, `playwrightBrowserSession.ts:376-381`) still covers the inverse case — if the user kills their Chrome while a session is active, the manager learns via `browser.on('disconnected')` and routes through `requestClose('error')` cleanly.

### Why `cdpEndpoint` is a global setting (not just per-session)

A typical user runs one Chrome instance for personal use and points Ultron at it once. Forcing `cdpEndpoint` into every `ComputerStart` call would either bloat the model-facing schema or require the user to type the URL every session. Putting it in `settings.json` keeps the friction at one-time setup; the per-session `backend` override on the input schema covers the "I want this one session to use the bundled Chromium instead" case (e.g., the user is running a headless evaluation in parallel with their interactive browsing).

The endpoint stays out of `defaultComputerUseSettings` defaults — its presence is what flips the backend, so default-undefined preserves today's behavior identically. Validation in `validateComputerUseSettings` rejects malformed URLs and unsupported schemes the same way `allowedDomains` patterns are validated.

### Why `cdp_connect_failed` is a new error kind

The existing `chromium_not_installed` kind is specific to "Playwright's bundled binary is missing." A CDP failure is conceptually different: the user's Chrome may be running but on the wrong port, or running but built without DevTools enabled, or running with an old version Playwright can't talk to. Reusing `chromium_not_installed` would surface a misleading "run `npx playwright install chromium`" hint. A separate `cdp_connect_failed` kind lets the error message say "start Chrome with `--remote-debugging-port=9222` and verify the port is reachable."

The same kind also fires *synchronously* from the factory when `backend: 'cdp'` is requested without a configured endpoint. SDK callers that bypass `ComputerStart.validateInput` (constructing `StartSessionOptions` and calling `SessionManager.start()` directly) get the same failure surface as model-driven calls — no silent fallback to the bundled binary, no half-configured CDP attempt.

### Why `headless: true` + CDP is rejected

`headless` is a launch-time argument forwarded to `chromium.launch({ headless })`. Once a Chrome is already running and Playwright is attaching via CDP, that flag has no effect — the user controls Chrome's visibility through their own launch command. Accepting `headless: true` under CDP would let the factory silently drop the model's claim and produce a session whose `headless` field disagrees with the model's intent.

The validator rejects the combination after computing the *effective* backend (explicit input → defaulted from `settings.cdpEndpoint`). The effective-backend step is load-bearing: with `settings.cdpEndpoint` set and `{ headless: true }` passed without an explicit `backend`, the older "explicit-only" check would accept the input and the factory would override it. The error message names `backend: "launch"` as the escape hatch for callers who genuinely want a headless bundled-Chromium session.

### Why `session.headless` reflects `cdpAssumeVisible`, not assumed-visible

The CDP-attached Chrome may be running headless (`--headless=new`) or visible — the user controls that with their own launch flags, and Playwright doesn't expose a way to introspect the value over CDP. So `session.headless` cannot be derived from the connection itself.

`ComputerHandoffToUser` checks `session.headless === false` to refuse handoff against an invisible browser. The conservative default — `cdpAssumeVisible: false` → `session.headless = true` → handoff refused — is fail-safe: an Ultron user who turns on CDP for some workflow doesn't accidentally tell the agent "yes, hand off to me" when their Chrome is actually invisible (a remote `--headless=new` session, an automation rig, etc.).

Operators who run a visible Chrome with `--remote-debugging-port` opt in by setting `computerUse.cdpAssumeVisible: true`. The setting is global because it describes the user's Chrome, not a per-session intent — there's no mode-mixing scenario where a single user runs both a visible and an invisible CDP target through the same Ultron settings file.

### Lifecycle: what's different vs. local-launch

| Phase | Local-launch | CDP |
|---|---|---|
| `chromium.launch(...)` | Spawns Chromium-for-Testing process | (skipped) |
| `chromium.connectOverCDP(endpoint)` | (skipped) | Connects to user's Chrome over WS |
| `browser.newContext({ storageState, viewport, ... })` | Same | Same — applies to a new context inside the attached Chrome |
| `context.newPage()` | Same | Same — opens a new window inside the attached Chrome |
| `context.route('**/*', ...)` | Same | Same |
| `page.goto(url)` / `page.screenshot()` / actions | Same | Same |
| `disconnected` handler | Fires on Chromium-for-Testing crash | Fires when user kills their Chrome |
| `close()` — `context.close()` | Tears down the session's context | Same |
| `close()` — `browser.close()` | Terminates the spawned process | Closes Playwright-created contexts and disconnects the WebSocket; user's Chrome unaffected |

Every other code path — policy, route interception, ARIA snapshot, atom cache, screenshot redaction, abort plumbing — is launch-mode-agnostic.

## Implementation outline

```ts
// src/core/computer/playwrightBrowserSession.ts

export const connectChromiumOverCdp =
  (endpoint: string): LaunchChromiumFn =>
  async (params) => {
    let browser: Browser
    try {
      browser = await chromium.connectOverCDP(endpoint)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserSessionError(
        'cdp_connect_failed',
        `connectOverCDP(${endpoint}) failed: ${msg}. ` +
          `Start Chrome with --remote-debugging-port and verify the port is reachable.`,
      )
    }
    // Identical context options to defaultLaunchChromium so storageState,
    // viewport, DSF, and the route interceptor behave the same way.
    const baseContextOptions: NonNullable<Parameters<typeof browser.newContext>[0]> = {
      viewport: { width: params.viewport.width, height: params.viewport.height },
      acceptDownloads: false,
      permissions: [],
      bypassCSP: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      ...(params.deviceScaleFactor !== undefined
        ? { deviceScaleFactor: params.deviceScaleFactor }
        : {}),
    }
    const context = await (params.storageState !== undefined
      ? browser.newContext({ ...baseContextOptions, storageState: params.storageState as never })
      : browser.newContext(baseContextOptions))
    const page = await context.newPage()
    return { browser, context, page }
  }
```

```ts
// createPlaywrightSessionFactory — fail closed for backend: 'cdp' without
// endpoint; SDK callers bypassing ComputerStart.validateInput get the same
// surface as model-driven calls.
let launch: LaunchChromiumFn
if (options.backend === 'cdp') {
  if (options.cdpEndpoint === undefined) {
    throw new BrowserSessionError(
      'cdp_connect_failed',
      "backend: 'cdp' requires a cdpEndpoint; configure computerUse.cdpEndpoint or pass cdpEndpoint in StartSessionOptions",
    )
  }
  launch = connectChromiumOverCdp(options.cdpEndpoint)
} else {
  launch = deps?.launchChromium ?? defaultLaunchChromium
}
```

`close()` is unchanged — both modes call `context.close()` then `browser.close()`. See "Why `browser.close()` is safe (and required) in both modes" above.

The route interceptor, screenshot pipeline, ARIA, atom cache, and abort plumbing stay byte-identical — they all operate on `this._context` / `this._page`, both of which exist the same way under CDP.

## Files to modify

| File | Change |
|---|---|
| `src/config/computerUseSettings.ts` | Add optional `cdpEndpoint?: string` to the schema. Validate via `new URL()` parse + scheme check (`http(s):` or `ws(s):`). Default `undefined`. |
| `src/core/computer/types.ts` | Extend `StartSessionOptions` with `readonly backend?: 'launch' \| 'cdp'` and `readonly cdpEndpoint?: string`. Add `'cdp_connect_failed'` to `BrowserSessionErrorKind`. |
| `src/core/computer/playwrightBrowserSession.ts` | Add `connectChromiumOverCdp` next to `defaultLaunchChromium`. In `createPlaywrightSessionFactory`, throw `BrowserSessionError('cdp_connect_failed', …)` when `options.backend === 'cdp' && options.cdpEndpoint === undefined`; otherwise pick the launcher from `options.backend`. For accepted CDP sessions, set `session.headless = false`. **No `launchMode` field; `close()` unchanged.** |
| `src/tools/ComputerTools.ts` | `buildStartTool`: expose optional `backend: 'launch' \| 'cdp'` enum on `inputSchema`. In `validateInput`, reject `backend: 'cdp'` when `deps.settings.cdpEndpoint` is unset AND reject `backend: 'cdp' + headless: true`. In `call`, thread `backend` and `cdpEndpoint` into `StartSessionOptions`. Default policy: `cdpEndpoint` set → backend defaults to `'cdp'`; otherwise `'launch'`. |
| `src/sdk/QueryEngine.ts` | No code change expected — verify the construction path passes `settings` through unchanged so `cdpEndpoint` reaches the factory. |
| `src/core/computer/playwrightBrowserSession.test.ts` | Two new cases: (a) factory throws `cdp_connect_failed` synchronously when `backend: 'cdp'` is passed without an endpoint, before any chromium API is touched; (b) stub-launcher CDP path calls both `context.close()` and `browser.close()` exactly once on session close — same as the launch path. |
| `src/config/computerUseSettings.test.ts` | Validation cases for `cdpEndpoint`: valid `http://127.0.0.1:9222`, invalid scheme (`javascript:`), missing port permitted (URL parser allows it), malformed URL → reject. |
| `src/tools/ComputerTools.test.ts` | `validateInput` cases: `backend: 'cdp'` with no endpoint → reject; `backend: 'cdp' + headless: true` → reject; `backend: 'launch'` always accepted; default-selection logic. |
| `src/core/computer/playwrightBrowserSession.cdp.integration.test.ts` (new) | Spawn `chromium.executablePath()` directly with `--headless=new --remote-debugging-port=0 --user-data-dir=<tmp> --no-first-run`, parse the port from stderr, run navigate + screenshot + abort, assert the spawned process is still alive after `session.close()` AND a fresh `connectOverCDP` to the same port succeeds. Tear down with `SIGTERM` in `afterAll`. Env-gated `ULTRON_PLAYWRIGHT_CDP_INTEGRATION=1`. |
| `docs/computer-use.md` | New section "Driving your real Chrome via CDP" with launch command, settings snippet, safety notes. |
| `docs/ultron_v3/v3-computer-use-plan.md` | Append parenthetical to Profile A row noting the CDP variant. |

## Verification

End-to-end smoke test (manual, requires the user's Chrome):

```bash
# 1. Start the user's Chrome with a debugging port.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/ultron-cdp-profile

# 2. Configure Ultron.
jq '.computerUse.cdpEndpoint = "http://127.0.0.1:9222"' ~/.ultron/settings.json

# 3. From an Ultron session, run ComputerStart and confirm:
#    - A new window appears inside that Chrome process (not Chromium-for-Testing).
#    - ComputerNavigate → ComputerObserve work as today.
#    - Closing the session leaves the user's other Chrome tabs alive.
```

Automated checks:

```bash
npm run typecheck
npm run test                         # unit tests including new factory + stub-launcher cases
ULTRON_PLAYWRIGHT_INTEGRATION=1 \
  npx vitest run src/core/computer/playwrightBrowserSession.integration.test.ts
ULTRON_PLAYWRIGHT_CDP_INTEGRATION=1 \
  npx vitest run src/core/computer/playwrightBrowserSession.cdp.integration.test.ts
```

The CDP integration test spawns Chromium directly via `child_process.spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=<tmp>', '--no-first-run'])`, parses the assigned port from the `DevTools listening on ws://127.0.0.1:PORT/...` line that Chromium writes to stderr, points `connectOverCDP` at `http://127.0.0.1:PORT`, runs navigate + screenshot + abort, and asserts that `session.close()` does **not** stop the spawned Chromium (verified by checking the process is still alive AND a fresh `connectOverCDP` to the same port succeeds). Tear down with `process.kill('SIGTERM')` in `afterAll`. (`chromium.launchServer()` is the wrong harness here — it returns a Playwright-protocol endpoint paired with `chromium.connect()`, not a CDP endpoint, per `playwright-core/types/types.d.ts:15681-15688`.)

## Risks / honest boundaries

- **`connectOverCDP` semantics — not `browser.close()` gating — protect the user's Chrome.** Skipping `browser.close()` for CDP would leak WebSocket connections without buying any safety. The "Chrome stays alive" property is a guarantee from `connectOverCDP`'s lifecycle, not from us.
- **First-hit bot detection still fails.** The CDP backend uses real-Chrome fingerprint and TLS, but with an empty cookie jar in the new context. Sites using cookie-based bot detection (most large e-commerce, including JD) still hit the WAF until `ComputerHandoffToUser` lets the user log in once and `storageState` persistence carries cookies forward.
- **`cdpEndpoint` is unauthenticated.** Anyone with local network access to the Chrome debugging port can drive the same Chrome. This is a Chrome design property, not an Ultron one — document that the port should be on `127.0.0.1` and not bound to a public interface.
- **Profile B is still missing.** WAFs that fingerprint at the network layer (Cloudflare, DataDome) will still block. CDP helps with passive client-side detection, not active server-side WAF. The Limitations table in `docs/computer-use.md` keeps this distinction.
- **No automatic recovery if the user kills Chrome mid-session.** The Phase 6 disconnect handler routes through `requestClose('error')` cleanly, but the user has to rerun their command. That is the correct behavior — silently relaunching would defeat the user-owned-process model.
