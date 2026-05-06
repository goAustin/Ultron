# Computer-Use (v3)

> **TL;DR.** Opt-in browser automation, **disabled by default**, sandboxed in a fresh Playwright-controlled browser session, and gated by an action-by-action permission cascade. Off unless you set `computerUse.enabled: true` in `~/.ultron/settings.json`. Allowed domains are optional — the first navigate to an unknown host produces a runtime **Allow once / Allow by rule / Deny once** prompt. SDK / headless callers can opt back into pre-flight failure with `requireAllowlistAtStart: true`.

This is the user-facing reference for v3 Computer-Use. For the engineering plan and per-phase designs, see [`docs/ultron_v3/v3-computer-use-plan.md`](ultron_v3/v3-computer-use-plan.md) and `docs/ultron_v3/v3-phase{0..7}-design.md`.

---

## Quick start

A read-only walkthrough on `example.com`. Takes about a minute.

### 1. Install Chromium

Computer-Use uses Playwright Chromium. Install the browser once after `npm install`:

```bash
npx playwright install chromium
```

If you skip this command, your first `ComputerStart` will fail with `BrowserSessionError: chromium_not_installed` and the install command in the error message.

### 2. Enable the feature in `~/.ultron/settings.json`

Create or edit `~/.ultron/settings.json` and add a `computerUse` section:

```json
{
  "computerUse": {
    "enabled": true
  }
}
```

`enabled: true` is the only required field. Every other field has a safe default — see [Settings reference](#settings-reference).

`allowedDomains` is optional; when empty, the first navigation to a new host produces a runtime **Allow once / Allow by rule / Deny once** prompt. Picking **Allow by rule** appends both the apex (`youtube.com`) and the wildcard (`*.youtube.com`) to `computerUse.allowedDomains` in your settings file, so the same host won't re-prompt across sessions. Pre-seeding `allowedDomains` is fine if you already know the hosts you want — it just isn't required.

SDK callers that want the old fail-fast behavior (no prompts; refuse to start with an empty allowlist) can opt in with `"requireAllowlistAtStart": true`.

### 3. First run

Start an Ultron session and ask the model to fetch the page:

```
> Open example.com and tell me what the page heading says.
```

Roughly what the model will do under the hood:

1. `ComputerStart` — spin up a fresh browser context; the first run will prompt for approval.
2. `ComputerNavigate` — go to `https://example.com`.
3. `ComputerObserve` — capture a redacted, downscaled screenshot plus the URL, title, and ARIA snapshot.
4. `ComputerStop` — close the browser; clear cookies and storage.

You should see a one-line model reply containing something like *"Example Domain"*, with no approval prompts beyond the initial session start. Cookies and storage are wiped on stop.

### 4. What just happened

- A separate browser process opened with no extensions, no persistent profile, and HTTPS-only navigation.
- Network requests outside `example.com` were blocked at the subresource layer, not just the top-level URL.
- The screenshot was downscaled to 1024×768 before reaching the model. Password and payment fields would have been blacked out had any been present.
- The session closed cleanly; no `.png` files were left on disk.

For richer scenarios — auth, forms with submit buttons, multi-step flows — read the rest of this document before turning anything else on.

---

## How it works

Each Computer-Use request flows through the same pipeline:

```
Model proposes a Computer-* tool call
        ↓
Permission cascade + Computer safety checks + optional human approval
        ↓
Computer tool facade
        ↓
ComputerSessionManager  (lifecycle, timeouts, step counter)
        ↓
PlaywrightBrowserSession  (Profile A — local Playwright browser)
        ↓
Action → stabilize → screenshot → redact → downscale → emit
        ↓
Tool result + image observation + audit metadata
        ↓
Model decides next action
```

### Per-session sandbox

Every `ComputerStart` creates a fresh Playwright browser **context** (not just a new tab) with:

- A separate temporary user-data directory.
- No persistent auth profile (unless you opt into auth handoff).
- No extensions.
- A fixed viewport (default 1024×768; capped at 1280×800).
- HTTPS-only navigation by default. `data:`, `file:`, `javascript:`, `blob:`, `ws:`, `wss:`, `ftp:` are always rejected. `http:` is rejected unless a test-only flag is set.
- Camera, microphone, geolocation, notifications, clipboard, and background-sync permissions disabled.
- Downloads disabled (Playwright's `acceptDownloads: false`).
- Popups blocked or converted into explicit approval events.
- Cookies wiped on stop, unless you've explicitly opted into storageState persistence.

Sessions are **serial**: every Computer-Use tool is marked `isConcurrencySafe: false`. The agent loop will not run two browser actions in parallel.

### DOM-first atom path (preferred) + coordinate fallback

There are two ways the model can act on a page:

1. **DOM-first atom path (preferred).** `ComputerObserveActions` returns a list of semantic targets — `[{ atomId, role, name }, ...]` — derived from the page's accessibility tree. The model picks an `atomId`; `ComputerActAtom` resolves it to a Playwright locator and acts deterministically. No coordinates, no screenshot interpretation. A per-session selector cache means replays usually skip the ARIA serialization entirely.

2. **Coordinate fallback.** `ComputerClick`, `ComputerType`, `ComputerScroll`, `ComputerDrag` accept normalized `[0, 1]` coordinates. The model interprets a screenshot, picks a point, and Ultron clicks. Used when the atom path returns no candidates (canvas widgets, image-only buttons, weak ARIA trees) or fails to resolve.

The system prompt (only present when Computer-Use is enabled) instructs the model to prefer atoms first.

### Stabilization and post-action verify

After a mutating action, Ultron does **not** assume the page changed. It runs a layered stabilization (commit → `domcontentloaded` → animation debounce → ARIA snapshot stability sample) followed by a verification stack:

1. ARIA snapshot diff (the primary "did the page actually change" signal).
2. Masked-pixel SSIM at the action target bounding box (catches in-place visual changes).
3. Global screenshot pHash (backstop for canvas/image transitions).

If all three signals report "no change" after a mutating action, the result is marked `verified: false` and the model sees a warning so it can re-observe instead of advancing on a phantom click.

Set `verifyActions: false` to skip the pre-state capture and save one ARIA snapshot per action — at the cost of losing the "claimed-clicked-but-didn't" guard.

### Step counter and duration timeout

Every mutating action increments a per-session step counter. When `stepCount > computerUse.maxSteps` (default 30), the next action fails with `errorKind: 'execution_error'` and the session closes. There is also a wall-clock timeout (`maxDurationMs`, default 5 minutes).

A no-progress detector aborts the loop if all available change signals stall for 3 consecutive steps — protects against the model spinning on an unresponsive page.

### What's NOT in v3

- No managed stealth browser (Profile B).
- No container desktop / X11 / VNC (Profile C).
- No native OpenAI / Anthropic Computer-Use bridges.
- No host desktop control.

See [Limitations](#limitations) for the full list with attribution.

---

## Security model

Source for everything in this section: `docs/ultron_v3/v3-computer-use-plan.md` §"Permission And Safety Model" (lines 220–262). Reproduced here so you don't have to read the engineering plan to evaluate safety.

### Risk levels

| Level | Examples | Runtime behavior |
|---|---|---|
| 0 — Observation | Screenshot, wait | Allow only after session approval; redact sensitive regions |
| 1 — Reversible navigation/UI | Navigate allowlisted domain, scroll, harmless click | Allow by rule or ask once |
| 2 — Sensitive input | Passwords, tokens, PII, login, MFA, account settings | Per-action human approval |
| 3 — Irreversible external action | Submit, send, purchase, pay, delete, publish, transfer, invite | Per-action approval, even in permissive mode |
| 4 — Prohibited | CAPTCHA bypass, evading access controls, destructive host/OS actions, unapproved high-stakes domains | Deny |

A level-3 action requires approval **even if** you've broadened the permission mode for the session. There is no flag to suppress it short of editing the source.

### Five non-bypassable safety checks

These run **before** the permission-mode allow behavior — a permissive mode does not skip them.

1. Block actions when the session is not found or expired.
2. Block navigation outside the configured allowlist.
3. Ask for clicks near detected dangerous labels: `Delete`, `Submit`, `Send`, `Pay`, `Purchase`, `Confirm`, `Invite`, `Publish`, `Transfer`, `Disable`, `Remove`.
4. Ask for typing into password, token, MFA, payment, SSN, or similar sensitive fields.
5. Deny action loops that exceed `maxSteps`, `maxDurationMs`, or the no-progress threshold.

Plus runtime denials: file uploads/downloads beyond an explicitly approved scratch directory; camera, microphone, geolocation, notification, and clipboard permissions.

### Headless = strict-deny for any "ask"

When stderr is not a TTY (CI, scripted runs, piped output), every prompt that would have been an "ask" becomes a "deny". This matches the rest of Ultron's permission model: there is no human to approve, so the safe answer is no.

To use Computer-Use non-interactively for a known-safe workflow, you must add an explicit allow rule scoped to the same domain + tool + risk class. Allow rules are not offered for level 2 or level 3 actions unless tightly scoped.

### Domain allowlist enforcement

`computerUse.allowedDomains` is enforced at **three layers**:

1. **Cascade-time safety check** — `ComputerNavigate` to a host on `allowedDomains` short-circuits the cascade with `behavior: 'allow'`; an unknown host returns `'ask'` (runtime prompt: Allow once / Allow by rule / Deny once); a host on `deniedDomains` returns `'deny'`.
2. **Pre-flight** check inside `ComputerNavigate.call()` — defense in depth; denied URLs never open a request even if the cascade was bypassed.
3. **Subresource interception** via Playwright's route handler — a page allowed to navigate cannot pull resources from a denied domain. Subresource fetches are silently aborted; they do **not** prompt.

The runtime prompt's outcomes:

- **Allow once** — adds the host to a per-session overlay. The session can navigate to that host (and its subresources) for the rest of its lifetime; the overlay is dropped when the session closes.
- **Allow by rule** — adds the overlay entry AND persists `[apex, *.apex]` to `computerUse.allowedDomains` in `~/.ultron/settings.json` (e.g. `www.youtube.com` becomes `[youtube.com, *.youtube.com]`). Survives restart. Subdomain-first navigations (`studio.youtube.com`) persist a narrower pattern; edit settings.json to broaden.
- **Deny once** — refuses this navigation; no state change.

Pattern syntax (see `src/web/domainPolicy.ts`):

- Exact host: `github.com` matches `github.com` only.
- Suffix wildcard: `*.github.com` matches `gist.github.com`, `a.b.github.com`; does **not** match the apex `github.com`. The persistence helper writes both forms when persisting from a prompt.
- Bare `*` is rejected.

`computerUse.deniedDomains` overrides `allowedDomains` when both match. Use it to carve out subdomains of an otherwise-allowed parent.

### Webpage content is hostile

Text the model sees from the page — URL, title, ARIA names, atom labels, observation prose — is wrapped in `<untrusted-page-text>...</untrusted-page-text>` delimiters. The system prompt (when Computer-Use is enabled) tells the model that anything inside those tags is data, never instructions.

The wrapper neutralizes literal `</untrusted-page-text>` substrings inside hostile page content so a page can't escape the wrapper by including the closing tag in its own text.

**This is a prompt-engineering primitive, not a sandbox.** A sufficiently capable model can still be tricked by a sufficiently sophisticated injection. Phase 6's prompt-injection fixture proves the wrapper bytes survive end-to-end on a real adversarial page; it does **not** prove that any specific model honors the rule under attack. The vision channel (page text visible inside a screenshot) is also untrusted — a vision model can read injection text out of a PNG.

### Screenshot redaction

Before any screenshot leaves the runtime, the redaction pass blacks out:

- Password fields (`input[type="password"]`).
- MFA / OTP / verification-code fields.
- Payment fields (card number, CVV, expiry).
- SSN / tax-ID / sensitive-PII fields.
- Elements with sensitive ARIA roles where applicable.

You can extend the list with `computerUse.redactionSelectors` (CSS selectors). Built-ins always apply; your selectors are appended.

### Auth handoff (opt-in)

`ComputerHandoffToUser` pauses the agent loop, drops you into the visible browser window so you can complete a login or MFA step yourself, and resumes when you press Enter. The credentials never reach Ultron — you type them directly into the browser.

Gated behind `computerUse.allowAuthHandoff` (default `false`). Headless mode rejects the tool because it requires a visible browser. The handoff is logged to audit with metadata only — never with captured form values.

On resume, Ultron snapshots `storageState` (cookies + localStorage) into a per-session scratch directory so a future run with the same session ID skips the handoff.

### What the audit log records

By default, audit captures **metadata**, not bytes:

- Tool name, session ID, timestamp.
- Action summary (e.g., "click at (0.42, 0.31)" or "navigate to github.com").
- URL host, page title.
- Screenshot dimensions, redacted flag, hash, byte size — but **not** the screenshot bytes themselves.
- Permission decision (allow / ask / deny) and the reason.

Set `debugPersistScreenshots: true` to also write screenshot bytes to disk for debugging. **Off by default**; only flip it when you need to investigate a specific failure.

### What the security model does NOT promise

Honest boundaries:

- **Profile A is not a stealth browser.** WAF-based bot detection (Cloudflare, DataDome) will identify and block sessions on protected sites in 2026. This is documented as a v3 limitation, not a bug.
- **The `<untrusted-page-text>` wrapper is best-effort.** See above — proving a model honors it under attack is out of scope.
- **Domain allowlist is a navigation control, not a data-exfil control.** A page allowed to navigate can run JavaScript that calls allowlisted APIs to send data anywhere those APIs forward it.
- **Auth handoff exists for user convenience, not for credential safety.** You type the password into a real browser window. Ultron never sees the bytes, but it also doesn't validate the auth flow — you're responsible for trusting the page you're handing off to.

---

## What leaves the machine

Four egress channels carry data out of the local sandbox to the model. Each is bounded and toggleable.

| Channel | What it carries | Default cap | Setting that controls it |
|---|---|---|---|
| 1. Screenshot bytes | PNG/JPEG of the viewport, redacted | 1024×768, ≤ 2 MB | `displaySize`, `maxScreenshotBytes`, `maxScreenshotDimensions`, `redactionSelectors` |
| 2. ARIA snapshot text | Accessibility tree, redacted, token-budgeted | 4000 tokens | `ariaSnapshotMaxTokens` |
| 3. URL + page title | Current location, page metadata | n/a (always sent) | wrapped in `<untrusted-page-text>` |
| 4. Audit metadata (local) | Action + decision log | metadata only | `debugPersistScreenshots` (off → no bytes) |

### Screenshot bytes

Capture pipeline: render at `viewport` → redact sensitive regions → downscale to `displaySize` → encode → emit. Anthropic and OpenAI both lose accuracy on inputs larger than XGA and downscale server-side anyway; doing it locally keeps the round-trip deterministic.

Ultron-side caps:

- `displaySize` — what the model receives (default 1024×768).
- `maxScreenshotBytes` — hard byte cap (default 2 MB; oversized → reject or downscale).
- `maxScreenshotDimensions` — hard dimension cap (default 1024×768; capped at 1280×800 by the v3 plan's accuracy guidance).
- `redactionSelectors` — extra CSS selectors blacked out before encode.

### ARIA snapshot text

A YAML-style serialization of Playwright's accessibility tree. Used by both `ComputerObserve` (carried in the observation result) and the DOM-first atom path (`ComputerObserveActions`). Sensitive regions (the same selectors that drive screenshot redaction) are stripped before serialization. Truncated at `ariaSnapshotMaxTokens` (default 4000).

A short stable hash of the snapshot is also computed for cheap diffing in `verify.ts`. The hash, not the snapshot, is what `recordStep`'s no-progress detector compares.

### URL + page title

Always sent on observation. Both are wrapped in `<untrusted-page-text>` delimiters in the result text. The wrapper neutralizes literal closing-tag substrings in the page-derived content.

### Audit metadata

Kept local to `~/.ultron/`. Records every Computer-Use tool call as metadata only by default — see [Security model § What the audit log records](#what-the-audit-log-records) for the field list. The screenshot bytes path is a single explicit toggle, not a per-call decision: `debugPersistScreenshots: true` writes bytes; `false` (default) doesn't.

### Cookies and storageState

Per-session cookies and localStorage live inside the Playwright context for the lifetime of the session and are wiped on `ComputerStop` — **unless** you've used `ComputerHandoffToUser` and `allowAuthHandoff: true`. In that case Ultron snapshots `storageState` into a per-session scratch directory so the next run with the same session ID skips the handoff. Clear it by running `ComputerStop` or by deleting the scratch directory.

### Cross-channel toggle table

| If you want to stop... | Set |
|---|---|
| Screenshot bytes from reaching the model | Computer-Use is a screenshot-driven feature; the only "off" is `enabled: false`. You can shrink them with `displaySize` and `maxScreenshotBytes`. |
| Screenshot bytes from being written to disk | `debugPersistScreenshots: false` (default) |
| ARIA tree text from reaching the model | Not separately toggleable — observations always include it. Lower `ariaSnapshotMaxTokens` to bound size. |
| Cookies from persisting across sessions | Don't use auth handoff (or `allowAuthHandoff: false`, the default) |
| Auth handoff entirely | `allowAuthHandoff: false` (default) |
| All Computer-Use egress | `enabled: false` — tools aren't registered, the Playwright module is never loaded |

---

## Settings reference

All settings live under the `computerUse` key in `~/.ultron/settings.json`. Cross-checked against `defaultComputerUseSettings` in `src/config/computerUseSettings.ts:66-86`. Invalid values warn to stderr and fall back to the per-field default — boot never throws.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Master switch. When `false`, Computer-Use tools are not registered and the Playwright module is never loaded. |
| `defaultEnvironment` | `'browser' \| 'desktop'` | `'browser'` | Only `'browser'` is implemented in v3. `'desktop'` is reserved for a future profile. |
| `viewport` | `{ width, height }` | `{ 1024, 768 }` | What Playwright renders at (CSS pixels). Capped at 4096×4096; **must equal `displaySize` in v3**. |
| `displaySize` | `{ width, height }` | `{ 1024, 768 }` | What the model sees after downscaling. v3 enforces `viewport === displaySize` at session start. |
| `maxSteps` | `integer ≥ 1` | `30` | Hard cap on mutating actions per session. The (N+1)-th action fails with `execution_error` and closes the session. |
| `maxDurationMs` | `integer ≥ 1000` | `300000` | Wall-clock session timeout (5 min). Enforced via `setTimeout` in `SessionManager.start()`. |
| `maxScreenshotBytes` | `integer ≥ 1024` | `2_000_000` | Hard byte cap on emitted screenshots (2 MB). Oversized → reject or downscale. |
| `maxScreenshotDimensions` | `{ width, height }` | `{ 1024, 768 }` | Hard dimension cap. Width capped at 1280, height at 800 by the v3 plan's accuracy guidance. |
| `ariaSnapshotMaxTokens` | `integer ≥ 1` | `4000` | Token budget for the ARIA snapshot text in observations. |
| `allowedDomains` | `string[]` | `[]` | Domain allowlist (exact host or `*.suffix`). Empty list is fine — the first navigate to a new host prompts the user; "Allow by rule" persists `[apex, *.apex]` here. SDK callers can require a non-empty list at start via `requireAllowlistAtStart`. |
| `deniedDomains` | `string[]` | `[]` | Overrides `allowedDomains` when both match. Use to carve subdomains out of an allowed parent. Hard-deny: produces `permission_denied` without a prompt. |
| `requireAllowlistAtStart` | `boolean` | `false` | When `true`, `ComputerStart` throws `allowlist_empty` if `allowedDomains` is empty. CLI default `false` (per-navigate prompt). SDK / headless callers wanting fail-fast set `true`. |
| `persistProfiles` | `boolean` | `false` | Reserved for a future named-profile feature. No-op in v3. |
| `allowDownloads` | `boolean` | `false` | **Validated but not yet enforced in v3.** Playwright's `acceptDownloads: false` rejects all downloads regardless. |
| `allowUploads` | `boolean` | `false` | **Validated but not yet enforced in v3.** No tool exposes a `setInputFiles` path. |
| `allowAuthHandoff` | `boolean` | `false` | Gates `ComputerHandoffToUser`. When `true`, snapshots `storageState` on resume; rejected in headless mode. |
| `debugPersistScreenshots` | `boolean` | `false` | Write screenshot bytes to disk for debugging. Off by default — audit captures metadata only. |
| `redactionSelectors` | `string[]` | `[]` | Extra CSS selectors blacked out before screenshot emission. Built-ins (password / MFA / payment / sensitive PII) always apply. |
| `verifyActions` | `boolean` | `true` | Capture pre/post ARIA + screenshots and run the 3-signal verify pass after each action. Set `false` to save one ARIA snapshot per action at the cost of the "claimed-clicked-but-didn't" guard. |
| `watchMode` | `boolean` | `false` | Render one stderr line per Computer-tool event (start, ask, allow/deny, finish) when stderr is a TTY. No-op on piped stderr regardless. |

### Worked examples

**Read-only public site:**

```json
{
  "computerUse": {
    "enabled": true,
    "allowedDomains": ["example.com", "*.example.com"]
  }
}
```

**Internal app behind a single allowed domain:**

```json
{
  "computerUse": {
    "enabled": true,
    "allowedDomains": ["app.internal.example.com"],
    "watchMode": true,
    "maxSteps": 50
  }
}
```

**Authenticated site (one-time login, then automated):**

```json
{
  "computerUse": {
    "enabled": true,
    "allowedDomains": ["github.com", "*.github.com"],
    "allowAuthHandoff": true
  }
}
```

**Tightening defaults — short sessions, extra redaction:**

```json
{
  "computerUse": {
    "enabled": true,
    "allowedDomains": ["example.com"],
    "maxSteps": 10,
    "maxDurationMs": 60000,
    "redactionSelectors": [".user-email", "[data-pii]", "input[name='ssn']"]
  }
}
```

---

## Driving your real Chrome via CDP

By default, `ComputerStart` launches Playwright's bundled "Chromium for Testing" binary — a separate executable from your installed Chrome, with an empty profile. You can instead point Ultron at a Chrome you've started yourself with the DevTools Protocol enabled, and the agent will run inside an **isolated new BrowserContext** within that Chrome process. Your existing tabs are untouched; the agent gets its own window with a fresh cookie jar.

This is still Profile A (local Playwright). It is **not** a stealth browser; WAFs that fingerprint at the network layer (Cloudflare, DataDome) still apply. What it gives you:

- Real-Chrome User-Agent and TLS stack — helps with passive bot signatures.
- A window the user can see, inside the Chrome process they're already running.
- Cookies persisted via `storageState` (Phase 4·3) accumulate against your real Chrome's TLS fingerprint instead of Chromium-for-Testing's.

What it does **not** give you:

- Shared cookies with your existing Chrome tabs. The agent's context starts empty; logins must use `ComputerHandoffToUser` once, after which `storageState` carries cookies forward across sessions.
- Bypass for slider captchas or interactive bot challenges. Those still require the user.

### Setup

1. **Start Chrome with a debugging port** (use a separate user-data-dir so it doesn't conflict with your normal browsing profile):

   ```bash
   # macOS
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222 \
     --user-data-dir=/tmp/ultron-cdp-profile

   # Linux
   google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/ultron-cdp-profile

   # Windows
   "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
     --remote-debugging-port=9222 ^
     --user-data-dir=C:\Temp\ultron-cdp-profile
   ```

2. **Set `cdpEndpoint`** in `~/.ultron/settings.json`:

   ```json
   {
     "computerUse": {
       "enabled": true,
       "cdpEndpoint": "http://127.0.0.1:9222"
     }
   }
   ```

   When `cdpEndpoint` is set, `ComputerStart` defaults to the CDP backend. Pass `backend: "launch"` on a specific `ComputerStart` call to fall back to the bundled binary for that one session.

3. **Run a Computer-Use task as usual.** A new window appears inside your debugging-enabled Chrome; the agent drives that window. When the session ends, the window's context closes; your Chrome process stays alive.

### Safety notes

- **Bind `cdpEndpoint` to `127.0.0.1` only.** Anyone with network access to the Chrome debugging port can drive that Chrome. Don't expose port 9222 to other machines.
- **Use a dedicated `--user-data-dir`.** A throwaway profile path keeps the agent's window from contaminating (or being contaminated by) your real browsing profile. The `storageState` rehydration path still works the same way against the dedicated profile.
- **Closing a Computer-Use session does not close your Chrome.** This is a load-bearing safety property — `browser.close()` is gated when the session was attached via CDP. The user kills Chrome themselves when they're done with it.

### Failure modes

- **`BrowserSessionError: cdp_connect_failed`** — Chrome isn't running on the configured port, or it's running but without `--remote-debugging-port`. Restart Chrome with the flag and verify `curl http://127.0.0.1:9222/json/version` returns Chrome's version JSON.
- **`browser.on('disconnected')` during a session** — the user killed Chrome (or it crashed). The session closes via `requestClose('error')` cleanly; rerun the command after starting Chrome again.

### Settings reference

| Field | Type | Default | Description |
|---|---|---|---|
| `cdpEndpoint` | `string \| undefined` | `undefined` | When set, `ComputerStart` attaches to a Chrome at this URL via `chromium.connectOverCDP()` and runs in an isolated new context inside it. URL must be `http(s)://` or `ws(s)://`. Leave unset to keep today's bundled-binary launch behavior. |
| `cdpAssumeVisible` | `boolean` | `false` | Whether the CDP-attached Chrome is operator-visible. Drives `BrowserSession.headless` for CDP sessions. **Default `false` (fail-safe)** — a CDP session reports `headless: true` and `ComputerHandoffToUser` refuses handoff. Set to `true` only when you're running a visible Chrome with `--remote-debugging-port`; we cannot introspect Chrome's actual `--headless` flag over CDP, so the operator's word is the source of truth. |

The `backend: 'launch' | 'cdp'` input on `ComputerStart` is an optional per-session override; it defaults to `'cdp'` when `cdpEndpoint` is set, otherwise `'launch'`. Passing `backend: 'cdp'` with no endpoint configured rejects with a clear error. Passing `headless: true` rejects when the *effective* backend (explicit-or-defaulted) is CDP — `headless` is a launch-time flag with no CDP meaning. Use `backend: "launch"` if you want a headless bundled-Chromium session even when `cdpEndpoint` is configured globally.

---

## CLI watch mode

When `watchMode: true` and stderr is a TTY, Computer-Use renders one line per tool event:

```
[computer] start session=abc12345 url=- decision=allow
[computer] navigate session=abc12345 url=https://example.com decision=allow
[computer] observe session=abc12345 url=https://example.com decision=allow shotBytes=24831
[computer] click session=abc12345 point=(0.42,0.31) decision=ask
[computer] click session=abc12345 point=(0.42,0.31) decision=allow
[computer] stop session=abc12345 decision=allow
```

The renderer is silent on piped stderr regardless of the setting. No screenshot bytes are written.

---

## Troubleshooting

Failure-first reference. Search for the exact error string, find the cause, apply the fix.

### `BrowserSessionError: chromium_not_installed`

**Cause.** Playwright's Chromium binary isn't present.

**Fix.** Install Chromium:

```bash
npx playwright install chromium
```

The error message itself includes this command. CI environments may have set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` deliberately — the integration suite is env-gated and not expected to run on every PR.

### `BrowserSessionError: allowlist_empty`

**Cause.** Only fires when `computerUse.requireAllowlistAtStart: true` AND `allowedDomains` is empty. CLI default (`false`) does NOT throw this — the per-navigate prompt handles unknown hosts.

**Fix.** Either add the host(s) to `allowedDomains`, or set `requireAllowlistAtStart` back to `false` (the default).

```json
"allowedDomains": ["example.com", "*.example.com"]
```

Patterns: exact host, or `*.suffix` (matches subdomains only — list the apex separately if needed). Bare `*` is rejected.

### `BrowserSessionError: domain_denied`

**Cause.** The model tried to navigate to a host that matches `deniedDomains`. (Hosts not in `allowedDomains` no longer hit this error in CLI mode — they produce a runtime prompt instead. `domain_denied` only fires now for explicit denylist hits, headless mode where no prompt is possible, or SDK strict mode.)

**Fix.** If the host should be reachable, remove the matching `deniedDomains` entry. If you're in headless / SDK mode, add the host to `allowedDomains` so the navigation passes without a prompt. `deniedDomains` always overrides `allowedDomains` when both match.

### `BrowserSessionError: scheme_denied`

**Cause.** Tried to navigate to a non-HTTPS URL. `data:`, `file:`, `javascript:`, `blob:`, `ws:`, `wss:`, `ftp:` are always rejected. `http:` is rejected unless `allowHttpForTest` is set (test-only).

**Fix.** Use `https://` URLs.

### `BrowserSessionError: viewport_mismatch`

**Cause.** `computerUse.viewport` and `computerUse.displaySize` are not equal. v3 enforces equality at session start.

**Fix.** Set both to the same dimensions, or remove one — both default to 1024×768.

### Cloudflare / DataDome challenge page

**Cause.** The target site uses WAF-based bot detection that identifies Profile A's local Playwright Chromium. This is a known v3 limitation.

**Fix.** Profile B (managed stealth) would address this but is not implemented in v3. Workarounds:

- Use the site's official API instead of browsing the UI.
- Use `WebFetch` for the static fetch case if the site allows simple HTTP clients.
- Wait for Profile B (no scheduled phase).

### `permission_ask` followed by tool error in non-interactive mode

**Cause.** Headless mode (no TTY stderr) treats every "ask" as "deny". A model trying to perform a level-2 or level-3 action without an explicit allow rule fails closed.

**Fix.** Run interactively, or add a tightly scoped allow rule (same domain, same tool, same risk class). Allow rules are not offered for level-2 / level-3 actions unless explicitly scoped — by design.

### Session exceeded `maxSteps` / `maxDurationMs`

**Cause.** The model hit the per-session step counter (default 30 mutating actions) or wall-clock timeout (default 5 minutes).

**Fix.** Either raise the relevant setting:

```json
"maxSteps": 60,
"maxDurationMs": 600000
```

Or split the task — long Computer-Use flows are best decomposed into multiple shorter sessions. Repeated identical observations also trigger an early abort via the no-progress detector.

### `BrowserSessionError: navigation_failed` / `screenshot_failed` / `interaction_failed` / `atom_locator_failed`

**Cause.** A Playwright operation failed for a reason that isn't policy-related — slow network, page error, stale DOM, etc. The error message includes the underlying Playwright error.

**Fix.** Usually transient. If reproducible, the model can re-observe and retry. For stale-locator (`atom_locator_failed`) failures, the model is instructed to fall back to the coordinate path.

### Browser session won't close / leftover Chromium process

**Cause.** Should not happen — `closeOnce` routes all close paths (stop, timeout, abort, browser disconnect) through one idempotent path that closes both the context and the browser process.

**Fix.** If you observe a leftover process after Ultron exits, file an issue with the OS, Playwright version, and the session log. The Phase 6 disconnect handler covers the SIGKILL case.

---

## Limitations

Honest boundaries with attribution. A user reading this in 2027 should be able to tell which limitations are likely to be lifted in a future phase versus which are architectural.

| Limitation | Why | Future-phase fix? |
|---|---|---|
| **Profile A only** (local Playwright Chromium) | Simplest sandbox; reliable for internal apps and no-WAF public sites | Profile B (managed stealth) — no scheduled phase |
| **Cloudflare / DataDome bot detection** | Profile A is not a stealth browser; WAFs identify and block it | Profile B — no scheduled phase |
| **No desktop GUI support** | v3 is browser-first per the v3 plan's design principle 1 | Profile C (container desktop / X11 / VNC) — no scheduled phase |
| **No native OpenAI / Anthropic CUA bridges** | Stretch Phase deferred per `v3-computer-use-plan.md:728-754` — the unified Ultron tool path is sufficient for v3 | Stretch Phase, optional |
| **`allowDownloads` / `allowUploads` validated but not enforced** | Settings exist; runtime enforcement is a separate phase. Today: Playwright's `acceptDownloads: false` rejects all downloads; no tool exposes `setInputFiles` | Out of v3 scope |
| **Subagent forks don't inherit step counts** | Computer-Use sessions are per-engine; subagent forks don't share `sessionManager` state | Out of v3 scope |
| **DSF override is test-only** | Phase 6 deliberate posture — model-facing tools never expose `deviceScaleFactor`. Test seam only | Intentional, not a fix |
| **`_metrics` map has no TTL** | Engine-scoped lifetime is sufficient for single-CLI use; long-lived engines would want a TTL or LRU | Out of v3 scope |
| **Prompt-injection wrapper is best-effort** | Wrapper bytes survive end-to-end; whether a model honors them under attack is a model-eval concern, not an Ultron concern | Out of v3 scope |
| **No live-model integration tests** | Would require real API calls; flaky and expensive | Out of v3 scope |

For each item, the `docs/ultron_v3/v3-phase{N}-design.md` file referenced earlier in this doc has the engineering rationale.

---

## Disabling Computer-Use

To turn the feature off completely, set:

```json
{
  "computerUse": {
    "enabled": false
  }
}
```

Or omit the `computerUse` section entirely — the validator returns the safe defaults, including `enabled: false`.

What this gets you:

- **Tools are not registered.** `ComputerStart`, `ComputerObserve`, `ComputerNavigate`, ... — none of them appear in the tool registry. A model that hand-crafts a `tool_use` block referencing one gets the existing `tool_not_found` error.
- **The Playwright module is never loaded.** The `BrowserSessionFactory` is built lazily; with Computer-Use disabled, the dynamic import never fires, the Chromium binary is never touched, and there is no resident memory cost.
- **No leftover state.** Per-session cookies and storage live inside Playwright contexts that close with their session; with `enabled: false`, no contexts are ever created. `storageState` from prior auth handoffs (if any) lives under the Ultron scratch directory and can be removed with `rm -rf ~/.ultron/computer-use-scratch` (or the equivalent on your platform).

There is no `npm uninstall` step required. Playwright remains in `node_modules` so re-enabling is one settings change away.

---

## Where to learn more

- [`docs/ultron_v3/v3-computer-use-plan.md`](ultron_v3/v3-computer-use-plan.md) — the engineering plan, scope, and success criteria.
- `docs/ultron_v3/v3-phase{0..7}-design.md` — per-phase design docs.
- `tests/fixtures/computerUse/pages/` — Phase 6 acceptance fixtures; worked examples of search, multi-step forms, login handoff, dangerous buttons, modals, infinite scroll, prompt injection, slow load, and download/upload behavior.
- `src/config/computerUseSettings.ts` — settings validator and defaults (the source of truth for the Settings reference table above).
- `src/core/computer/types.ts` — `BrowserSession`, `ComputerSessionManager`, `BrowserSessionError`, and the action / observation types.
- `src/tools/ComputerTools.ts` — the 13 `Computer*` tool implementations.
