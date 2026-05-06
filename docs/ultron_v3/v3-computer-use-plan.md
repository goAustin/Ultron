# Ultron v3 Computer-Use Plan

## Scope Decision

v3 is only for Computer-Use. No unrelated model, memory, MCP, subagent, shell, or UI features should be added under the v3 banner unless they are directly required to make Computer-Use safe and usable.

The v3 goal is to let Ultron operate visual user interfaces when there is no API: see the current screen, decide the next UI action, execute that action in a sandboxed environment, verify the result, and continue under the same permission, audit, and abort discipline as the rest of Ultron.

Primary target: one Ultron-native Computer-Use runtime for browser-based UI operation.

Optional later target: thin provider protocol bridges for OpenAI or Anthropic native Computer-Use APIs. These bridges must translate provider-specific wire formats into Ultron's canonical Computer-Use actions; they must not create separate Computer-Use implementations.

Deferred: direct host desktop automation. If desktop support is added in v3, it must run inside a VM, container, or VNC-style isolated desktop, never by controlling the user's host desktop directly.

## Source Inputs

- ai-agent-book Chapter 28: Computer Use - https://github.com/Kocoro-lab/ai-agent-book/blob/main/en/Part9-Frontier-Practices/Chapter-28-Computer-Use.md
- OpenAI Computer Use guide - https://platform.openai.com/docs/guides/tools-computer-use
- OpenAI Responses API reference for `computer_call` / `computer_call_output` - https://platform.openai.com/docs/api-reference/responses
- Anthropic Computer Use tool docs - https://docs.anthropic.com/en/docs/build-with-claude/computer-use
- Playwright screenshots - https://playwright.dev/docs/screenshots
- Playwright input/actions - https://playwright.dev/docs/input
- Playwright `page.waitForLoadState` notes - https://playwright.dev/docs/api/class-page#page-wait-for-load-state

## Existing Ultron Constraints

The implementation must fit the current spine instead of bypassing it:

- `query.ts` owns the normalize -> model -> tool-use -> tool-result loop.
- `normalizeMessages.ts` preserves tool_use/tool_result pairing invariants.
- `Tool` already supports validation, permission checks, mutation/read-only metadata, domain/path extraction, and concurrency safety.
- The permission cascade already has non-bypassable safety checks before permission-mode allow behavior.
- Audit already tees query events in `QueryEngine`.
- `ToolResult` is currently text-only. Computer-Use needs screenshot/image result support before the model can reliably perceive the environment.
- OpenAI adapter currently ignores `ImageBlock` in user messages; Anthropic maps `ImageBlock` already.
- `package.json` has no Playwright dependency today.

## Design Principles

1. Browser-first. OpenAI's Computer Use docs recommend browser tasks over general OS tasks; Anthropic also warns about display resolution and accuracy. Start where reliability is highest.
2. Ultron-native first. There should be exactly one Computer-Use runtime: Ultron sessions, Ultron actions, Ultron screenshots, Ultron policy, Ultron audit. Model providers can only adapt into that runtime.
3. Sandbox first. A browser session is untrusted executable content. Network, profile, downloads, uploads, permissions, and filesystem access must be controlled.
4. Human-in-the-loop for side effects. The model can request actions, but Ultron decides whether the action is allowed, requires approval, or is blocked.
5. Webpage content is hostile. Text visible in the browser is untrusted and can contain prompt injection.
6. Use normalized coordinates at the model/tool boundary. Convert to pixels only inside the environment adapter.
7. UI actions are serial. No Computer-Use action tool is concurrency-safe.
8. Verify after action. Every meaningful action should return a post-action observation or require a follow-up observe call.
9. Audit metadata, not secrets. Audit action metadata and policy decisions. Do not write raw screenshots to audit by default.
10. Prefer deterministic APIs when possible. When a stable selector/DOM method exists, use it internally; reserve vision clicking for interfaces that cannot be addressed more directly.

## Target Architecture

```
User prompt
   |
   v
Ultron query loop
   |
   v
Model proposes Computer-* tool call
   |
   v
Permission cascade + Computer safety checks + optional human approval
   |
   v
Computer tool facade
   |
   v
ComputerSessionManager
   |
   v
Environment adapter
   |
   +--> Playwright browser context (MVP)
   +--> VM/VNC desktop adapter (deferred)
   |
   v
Action execution + stabilization + screenshot/redaction
   |
   v
Tool result + image observation + audit metadata
   |
   v
Model decides next action
```

## Core Modules

Add these modules under `src/core/computer/`:

- `types.ts` - shared action, observation, session, policy, and error types.
- `coordinates.ts` - normalized coordinate validation and pixel conversion.
- `policy.ts` - action classification, dangerous action detection, domain policy helpers, safety-check payloads.
- `redaction.ts` - screenshot redaction for password fields and configured sensitive selectors.
- `stabilize.ts` - page stabilization after action; no blind reliance on `networkidle`.
- `verify.ts` - post-action verification stack: ARIA snapshot diff, masked-pixel SSIM at action target, screenshot pHash diff. Returns a `verified: boolean` plus per-signal evidence so the model can decide whether to retry.
- `ariaSnapshot.ts` - serialize Playwright's accessibility tree, cap to a configured token budget, redact sensitive nodes, hash for cheap diffing.
- `sessionManager.ts` - lifecycle, timeouts, max-steps, session lookup, cleanup on abort.
- `playwrightBrowserSession.ts` - Playwright-backed implementation.
- `imagePayload.ts` - screenshot encoding, MIME handling, size caps, downscaling to `displaySize`, and metadata.

Add tool facades under `src/tools/`:

- `ComputerStartTool.ts`
- `ComputerObserveTool.ts`
- `ComputerNavigateTool.ts`
- `ComputerClickTool.ts`
- `ComputerTypeTool.ts`
- `ComputerKeyTool.ts`
- `ComputerScrollTool.ts`
- `ComputerDragTool.ts`
- `ComputerWaitTool.ts`
- `ComputerHandoffToUserTool.ts`
- `ComputerStopTool.ts`

Register these from `createDefaultRegistry()` only when Computer-Use is enabled in config. The default should be disabled until v3 is complete enough to be safe.

## Core Types

The exact implementation can evolve, but the v3 substrate should start from this shape:

```ts
export type ComputerSessionId = string & { readonly __brand: 'ComputerSessionId' }

export type ComputerEnvironmentKind = 'browser' | 'desktop'

export type ComputerViewport = {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
}

// Model-facing pixel space. Screenshots are downscaled to this size before
// emission, and native provider bridges advertise this size when registering
// their computer-use tool. `viewport` is what Playwright actually renders at
// (CSS px); `displaySize` is what the model sees and what its returned pixel
// coords are interpreted in. Default both to 1024x768 for v3.
export type ComputerDisplaySize = {
  readonly width: number
  readonly height: number
}

export type NormalizedPoint = {
  readonly x: number // 0..1
  readonly y: number // 0..1
}

export type ComputerAction =
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'click'; readonly point: NormalizedPoint; readonly button: 'left' | 'middle' | 'right' }
  | { readonly type: 'double_click'; readonly point: NormalizedPoint; readonly button: 'left' | 'middle' | 'right' }
  | { readonly type: 'type'; readonly text: string; readonly sensitive?: boolean }
  | { readonly type: 'key'; readonly key: string }
  | { readonly type: 'scroll'; readonly point?: NormalizedPoint; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: 'drag'; readonly from: NormalizedPoint; readonly to: NormalizedPoint }
  | { readonly type: 'wait'; readonly ms: number }

export type ComputerObservation = {
  readonly sessionId: ComputerSessionId
  readonly environment: ComputerEnvironmentKind
  readonly viewport: ComputerViewport
  readonly displaySize: ComputerDisplaySize
  readonly currentUrl?: string
  readonly title?: string
  readonly ariaSnapshot?: string // YAML-style accessibility tree, capped to a token budget
  readonly ariaSnapshotHash?: string // stable hash for verification stack
  readonly screenshot: {
    readonly mediaType: 'image/png' | 'image/jpeg'
    readonly data: string // base64, not written to audit by default
    readonly width: number // matches displaySize after downscaling
    readonly height: number
    readonly redacted: boolean
  }
}
```

Coordinates crossing the tool boundary are normalized to `[0, 1]`. Pixel coordinates are an implementation detail of `playwrightBrowserSession.ts` and of the native provider bridges (which translate model-emitted pixel coords against `displaySize` — see §"Optional: Native Provider Protocol Bridges").

v3 simplification: **one virtual display per session**. `displaySize` and `viewport` default to `1024x768`; multi-monitor and resolution switching mid-session are out of scope for v3.

## Tool Surface

All Computer-Use tools should be marked `isConcurrencySafe: () => false`.

| Tool | Purpose | Mutating | Read-only | Permission default |
|---|---|---:|---:|---|
| `ComputerStart` | Create isolated browser session | yes | no | ask |
| `ComputerObserve` | Capture redacted screenshot and metadata | no | yes, but sensitive | ask until session approved |
| `ComputerNavigate` | Navigate to URL | yes | no | domain-gated ask/allow/deny |
| `ComputerClick` | Click normalized point | yes | no | safety-classified |
| `ComputerType` | Type text into focused element | yes | no | ask for sensitive text |
| `ComputerKey` | Press key or key chord | yes | no | key allowlist plus safety-classified |
| `ComputerScroll` | Scroll at point or page | yes | no | allow after session approval |
| `ComputerDrag` | Drag from point to point | yes | no | ask by default |
| `ComputerWait` | Wait for page/application state | no | yes | allow after session approval |
| `ComputerHandoffToUser` | Pause the agent loop for human-in-the-browser action (e.g., login, MFA, CAPTCHA), snapshot `storageState` on resume so reruns skip the handoff | yes | no | always ask; gated by `allowAuthHandoff` |
| `ComputerStop` | Close session and delete scratch state | yes | no | allow after session approval |

### Tool Schema Rules

- `sessionId` is required for all tools except `ComputerStart`.
- `x` and `y` are normalized numbers in `[0, 1]`, not pixels.
- Text input has a byte cap and rejects control characters except explicitly allowed whitespace.
- Key input uses a closed allowlist: `Enter`, `Tab`, `Escape`, arrows, navigation keys, and explicit chords such as `ControlOrMeta+A`.
- URLs must be parseable HTTPS URLs unless a test-only local mode is enabled.
- `ComputerNavigate.getDomain()` returns the target host for rule matching.
- Other action tools should expose the current session host for policy routing where possible.

### `ComputerHandoffToUser` Semantics

When the model invokes `ComputerHandoffToUser`, Ultron:

1. Pauses the Computer-Use loop and surfaces a CLI prompt summarizing why control is handed over (e.g., "complete login at github.com, then press Enter when done").
2. Leaves the Playwright context running and visible (non-headless mode required when the tool is used).
3. On user resume, snapshots `storageState` (cookies + localStorage) into the per-session scratch directory and re-emits an observation so the model sees the post-login state.
4. If the same session id starts a future run with the same site, `storageState` is rehydrated automatically so the handoff is skipped on replay. The user can clear it via `ComputerStop` or by deleting the scratch dir.

The tool is gated behind `computerUse.allowAuthHandoff` (default `false`). Headless mode rejects this tool because it requires a visible browser. The handoff is always logged to audit with metadata only; no captured form values are recorded.

## Permission And Safety Model

Computer-Use safety should be implemented as `SafetyCheck`s plus tool-specific `checkPermissions`. Do not rely only on model self-reporting.

### Risk Levels

| Level | Examples | Runtime behavior |
|---|---|---|
| 0 - Observation | Screenshot, wait | Allow only after session approval; redact sensitive regions |
| 1 - Reversible navigation/UI | Navigate allowlisted domain, scroll, harmless click | Allow by rule or ask once |
| 2 - Sensitive input | Passwords, tokens, PII, login, MFA, account settings | Per-action human approval |
| 3 - Irreversible external action | Submit, send, purchase, pay, delete, publish, transfer, invite | Per-action approval, even in permissive mode |
| 4 - Prohibited | CAPTCHA bypass, evading access controls, destructive host/OS actions, unapproved high-stakes domains | Deny |

### Non-bypassable Checks

Add a Computer-Use safety check that runs before permission-mode allow behavior. It should:

- Block actions when the session is not found or expired.
- Block navigation outside the configured allowlist.
- Ask for clicks near detected dangerous labels such as `Delete`, `Submit`, `Send`, `Pay`, `Purchase`, `Confirm`, `Invite`, `Publish`, `Transfer`, `Disable`, `Remove`.
- Ask for typing into password, token, MFA, payment, SSN, or similar sensitive fields.
- Ask when OpenAI native CUA returns `pending_safety_checks`.
- Deny action loops that exceed max step count, max wall time, or repeated no-progress threshold.
- Deny file uploads/downloads unless explicitly approved and scoped to a scratch directory.
- Deny camera, microphone, geolocation, notification, and clipboard permissions by default.

Headless mode must escalate any `ask` decision to deny, matching the existing permission model.

### Human Approval UX

The approval prompt should show:

- Tool name and session id.
- Current URL and title.
- Action summary.
- Risk reason.
- For click/drag: normalized coordinates and, if available, nearby text.
- For type: redacted text preview when sensitive.
- A path to an ephemeral screenshot preview, if the CLI can display it safely.

No `allow_by_rule` should be offered for level 2 or level 3 actions unless the rule is tightly scoped to the same tool, same domain, and same risk class.

## Sandboxing Requirements

### Browser Sandbox Profiles

v3 ships **Profile A only.** Profiles B and C are documented as future environment adapters that share the same `BrowserSession` / `ComputerSession` interface but plug in different backends. They are out of scope for v3.

| Profile | Backend | Use case | Detection profile |
|---|---|---|---|
| **A — Local Playwright** (v3) | Local Playwright per session — `chromium.launch()` against the bundled binary OR (via `computerUse.cdpEndpoint`) `chromium.connectOverCDP()` to a Chrome the user has already started with `--remote-debugging-port`. The CDP variant runs an **isolated new context** inside the user's Chrome process; `browser.close()` is gated so session teardown never kills the user's Chrome. See [`v3-cdp-backend-design.md`](v3-cdp-backend-design.md). | Internal apps, local fixtures, allowlisted public sites that do not enforce WAF anti-bot | Detected by Cloudflare/DataDome on protected sites in 2026 — accept this limitation |
| B — Managed stealth (future) | Browserbase / Anchor / Hyperbrowser | Public web behind WAFs; CAPTCHAs; residential IPs; session video | Stealth-tuned; still imperfect against ML-based bot detection |
| C — Container/VM desktop (future) | E2B Desktop / Scrapybara / Anthropic computer-use-demo Docker | Desktop GUIs; isolated X11/VNC | VM-level isolation; not a browser-detection question |

If a v3 user points local Playwright at a Cloudflare-protected domain and it fails, the failure mode is documented, not a v3 bug. The migration path is to swap in Profile B as a follow-on environment adapter without re-implementing tools, sessions, policy, or audit.

### Browser MVP (Profile A)

Use Playwright with a fresh isolated browser context per Computer-Use session:

- Fixed viewport: default `1024x768`; hard cap `1280x800` to match Anthropic's accuracy guidance.
- Separate temporary user data directory.
- No persistent auth profile by default.
- No extensions.
- JavaScript enabled, but network constrained by route interception.
- HTTPS-only navigation by default.
- Domain allowlist required for non-test sessions.
- Downloads disabled or redirected to a per-session scratch directory.
- Uploads disabled unless explicitly approved by path.
- Camera, microphone, geolocation, notification, clipboard, and background sync permissions disabled by default.
- Popups blocked or converted into explicit approval events.
- Dialogs handled by policy rather than blindly accepting.
- Cookies cleared when the session ends unless the user explicitly opted into a named profile.

Use Playwright actionability where possible. For coordinate actions, use `page.mouse` only after converting normalized coordinates to viewport pixels and checking viewport bounds.

Do not use `networkidle` as the only readiness signal. Playwright documents it as discouraged for test readiness. Prefer a layered stabilization strategy followed by an explicit verification stack:

Stabilization (`stabilize.ts`):

1. Wait for immediate action promise.
2. Wait for committed navigation if the action triggered one.
3. Wait for `domcontentloaded` or `load` when navigation occurs.
4. Wait a short animation debounce.
5. Sample two ARIA snapshots ~250ms apart; identical = stable.

Post-action verification (`verify.ts`, runs after stabilization):

1. **ARIA snapshot diff** — compare pre-action `ariaSnapshotHash` to post-action; the primary "did the page actually change" signal.
2. **Masked-pixel SSIM** at the action target bbox — catches in-place visual changes (toggle, hover) without false positives from unrelated page noise.
3. **Global screenshot pHash diff** — backstop for transitions the ARIA tree does not surface (canvas, image swaps).
4. If all three signals report "no change" after a mutating action, return `verified: false` with evidence so the model retries with re-observation rather than advancing.

ARIA snapshot is the load-bearing primitive: it is compact, semantic, and the readiness/verification signal of choice across SOTA agents (Stagehand, browser-use, PUSV). It also feeds Phase 4b's DOM-first action path.

### Desktop Later

Desktop support can be added only after browser Computer-Use is stable. Requirements:

- Isolated VM, containerized X11/VNC desktop, or equivalent.
- No direct host desktop control.
- No host home directory mount by default.
- Explicit mount allowlist for files.
- Network allowlist enforced outside the model.
- Separate display resolution capped to `1280x800`.
- Session recording optional, off by default, and never written to audit without opt-in.

## Screenshot And Image Handling

Phase 1 must add a safe way for tool execution to return screenshots as model-visible image content.

Implementation requirements:

- Extend internal tool result handling to support image attachments or a tool-result-associated image content block.
- Ensure `normalizeMessages()` still preserves every `tool_use` / `tool_result` pair.
- Add OpenAI Responses image input support for `ImageBlock`.
- Keep Anthropic image support covered by tests.
- **Downscale every screenshot to `displaySize` (default `1024x768`) before model emission.** The pipeline is: capture at `viewport` → redact → downscale to `displaySize` → encode → emit. Track the resize ratio so any pixel coords coming back through a native bridge can be remapped exactly. Anthropic and OpenAI both lose accuracy on higher-than-XGA inputs and downscale server-side anyway; doing it in Ultron keeps the round-trip deterministic.
- Add max image dimensions (`maxScreenshotDimensions`, default `1024x768`) and byte caps (`maxScreenshotBytes`).
- Redact password fields before screenshot export.
- Allow configured CSS selectors for redaction.
- Audit only screenshot metadata by default: dimensions, redacted flag, URL host, hash, and byte size.
- Do not persist screenshot bytes unless the user enables debug capture.

Preferred shape:

```ts
export type ToolResultAttachment =
  | {
      readonly type: 'image'
      readonly mediaType: 'image/png' | 'image/jpeg'
      readonly data: string
      readonly label?: string
      readonly redacted: boolean
    }

export type ToolResult = {
  readonly content: string
  readonly isError: boolean
  readonly errorKind?: ToolErrorKind
  readonly attachments?: readonly ToolResultAttachment[]
}
```

The exact representation can differ, but the invariant is fixed: screenshot content must stay tied to the tool result that produced it.

## Unified Implementation Strategy

### Required: Canonical Ultron Computer-Use Runtime

v3 must implement Computer-Use once, inside Ultron. The canonical runtime is provider-neutral and is the only place that may own browser sessions, screenshots, coordinate conversion, redaction, policy, approval, audit, stabilization, and verification.

The model-facing interface should be ordinary Ultron tools plus image observations. This works with any model that can receive images and call tools, preserving the adapter and model hot-swap work already built into Ultron.

Benefits:

- Fits existing `query.ts`.
- Reuses current permission and audit infrastructure.
- Keeps Computer-Use behavior visible as normal tool calls.
- Preserves model hot-swapping: changing providers should not change the Computer-Use implementation.
- Keeps provider adapters as transport/protocol code, not capability owners.

Required adapter work:

- Anthropic: verify tool-result image path and add tests.
- OpenAI Responses: map `ImageBlock` / tool-result image attachments to Responses image input.
- OpenAI Chat Completions compatibility path: either support images if still needed or explicitly deny Computer-Use for Chat Completions-only compatible providers.
- Model capability metadata: add `supportsVision` and `supportsToolCalling` before enabling Computer-Use for a model.

### Optional: Native Provider Protocol Bridges

OpenAI and Anthropic expose provider-specific Computer-Use protocols. Ultron may support them later, but only as bridges into the canonical Ultron runtime.

The rule is:

```
provider-native item -> adapter bridge -> ComputerAction -> ComputerSession -> policy/audit/approval -> observation -> provider-native response item
```

Provider-native bridges must not:

- Own browser or desktop sessions.
- Bypass Computer safety checks.
- Bypass normal permission prompts.
- Write screenshots to audit.
- Expose provider-defined shell or file-editing tools as privileged shortcuts.
- Fork a second Computer-Use implementation under the adapter layer.

If an adapter bridge needs provider-specific safety metadata, such as OpenAI `pending_safety_checks`, it must translate that metadata into Ultron's existing permission and approval flow.

#### Bridge Translation Contract (applies to all native bridges)

Native bridges are the only place that touches model-emitted pixel coordinates. The translation contract is:

```
Native bridge in:  pixelPoint (from model output, in displayWidth × displayHeight)
                   → divide by displaySize.width / displaySize.height
                   → NormalizedPoint in [0, 1]
                   → ComputerSession (canonical)

Environment out:   NormalizedPoint
                   → multiply by viewport.width / viewport.height (CSS px)
                   → multiply by deviceScaleFactor only if the click API requires device px
                   → page.mouse.click()

Screenshot out to model: capture at viewport size → redact → downscale to displaySize
                         → emit. The bridge advertises the same displaySize in its tool
                         schema; never advertise a different size than what is downscaled to.
```

`displaySize` defaults to `1024x768` per session. `viewport` may equal `displaySize` for v3.

#### OpenAI Bridge Notes

If implemented, the OpenAI bridge should:

- Use the **Responses API** only.
- Use the current GPT-5.x model that exposes computer-use as a built-in tool. (As of May 2026: GPT-5.5 and GPT-5.4-mini surface `computer` natively in the Responses API; the standalone `computer-use-preview` model is gone. Resolve the current recommended model at implementation time.)
- Include the `computer` tool with `display_width`, `display_height` (matching `displaySize`), and `environment`.
- Set `truncation: "auto"` as required by OpenAI's guide. **Trade-off note:** auto-truncation drops oldest input items first to fit context, which can drop prior `computer_call_output` (screenshots and observations). Document this and disable truncation when strict provenance is required.
- Handle `computer_call` output items separately from ordinary function calls.
- Translate model-emitted pixel coords against `displaySize` per the bridge translation contract above.
- Execute the requested action in the same `ComputerSession`.
- Return `computer_call_output` with the redacted, downscaled screenshot.
- Include `current_url` where available.
- Never auto-acknowledge `pending_safety_checks`; convert them into Ultron permission asks. Map OpenAI's safety check categories (malicious instruction, irrelevant domain, sensitive domain) onto Ultron's risk levels.
- Set `safety_identifier` (a stable per-end-user hash) where the SDK surface supports it. It serves three functions: (a) lets OpenAI suspend a single misbehaving end-user without affecting the rest of the org, (b) improves prompt-cache bucketing, (c) feeds abuse telemetry. For Ultron's single-user model, derive it from a stable local user ID.

#### Anthropic Bridge Notes

If implemented, the Anthropic bridge should:

- Resolve the correct tool version and beta header **per model** at request time. Two versions are live as of May 2026:

  | Tool version | Models | Beta header |
  |---|---|---|
  | `computer_20251124` (enhanced; includes `zoom`) | Opus 4.7 / 4.6 / 4.5, Sonnet 4.6 | `computer-use-2025-11-24` |
  | `computer_20250124` | Sonnet 4.5, Haiku 4.5, Opus 4.1 | `computer-use-2025-01-24` |

- Add the version-by-model resolution table to bridge code; pick at request time based on the model in the `QueryParams`.
- Send `display_width_px` and `display_height_px` matching `displaySize` (default `1024x768`). Anthropic explicitly recommends XGA; **scale down on the way in, scale up on the way out** per the bridge translation contract above.
- Execute all tool requests in the Ultron `ComputerSession`.
- Do not expose Anthropic's provider-defined bash/text-editor tools as privileged shortcuts. Ultron already has its own Bash and file tools with permission gates.
- Map provider tool requests into the same Computer policy, audit, and approval path.

## Configuration

Add a `computerUse` settings section:

```json
{
  "computerUse": {
    "enabled": false,
    "defaultEnvironment": "browser",
    "viewport": { "width": 1024, "height": 768 },
    "displaySize": { "width": 1024, "height": 768 },
    "maxSteps": 30,
    "maxDurationMs": 300000,
    "maxScreenshotBytes": 2000000,
    "maxScreenshotDimensions": { "width": 1024, "height": 768 },
    "ariaSnapshotMaxTokens": 4000,
    "allowedDomains": [],
    "deniedDomains": [],
    "persistProfiles": false,
    "allowDownloads": false,
    "allowUploads": false,
    "allowAuthHandoff": false,
    "debugPersistScreenshots": false
  }
}
```

Rules:

- Computer-Use tools are not registered unless `enabled` is true or an SDK caller explicitly opts in.
- Non-test sessions require at least one allowed domain before navigation.
- Settings validation must warn and skip invalid entries rather than throwing at startup, consistent with current settings behavior.

## Phase Plan

### Phase 0 - v3 Scope And Settings

Deliverables:

- Add this plan.
- Update `docs/ultron_v2/v2-scope.md` to point Computer-Use to v3.
- Add `computerUse` config schema and validation.
- Lock the disabled-state contract: when `computerUse.enabled` is `false`, Computer-Use tools are simply not registered (mirroring the `disableMemory` precedent in `src/sdk/QueryEngine.ts`). SDK callers that hand-craft a `tool_use` block referencing an absent tool surface the existing `'tool_not_found'` `ToolErrorKind`. **No** new error class. **No** new `ToolErrorKind` value. (Phase 3 owns the conditional `registry.register(...)` calls.)

Files:

- `docs/ultron_v3/v3-computer-use-plan.md`
- `docs/ultron_v2/v2-scope.md`
- `src/config/settingsConfig.ts`
- `src/config/settingsConfig.test.ts`

Acceptance:

- Invalid `computerUse` settings warn and fall back to defaults.
- Computer-Use tools are absent unless enabled.
- No runtime behavior changes when `computerUse.enabled` is false.

### Phase 1 - Image Observation Substrate

Deliverables:

- Extend tool results or attachment injection so screenshots can be sent to models.
- Add OpenAI Responses image input mapping.
- Add tests for Anthropic and OpenAI image payload conversion.
- Add token/byte guardrails for screenshots.

Files:

- `src/core/tools/types.ts`
- `src/core/tools/imageAttachment.ts` (new — `ToolResultAttachment` type, `validateImageAttachment`, PNG IHDR parser)
- `src/core/messages.ts`
- `src/core/normalizeMessages.test.ts` (test-only — pipeline invariants for image-bearing tool results)
- `src/core/providers/types.ts` (add `supportsVision` to `ModelEntry`/`CapabilitySheet`)
- `src/core/providers/validateCapabilities.ts` (add `supportsVision` to `REQUIRED_CAPABILITY_FIELDS`)
- `src/core/providers/anthropicAdapter.{ts,test.ts}`
- `src/core/providers/openaiAdapter.{ts,test.ts}` (stream-emit restructure + image mapping)
- `src/core/providers/minimaxAdapter.ts` (populate `supportsVision: false`)
- `src/audit/redactImageData.ts` (new — strip base64 from audit envelopes)
- `src/audit/auditLog.ts` (wire `redactImageData` before `redactSecrets`)

`src/context/attachments.ts` is **not** touched — tool-result image attachments belong on the tool-result message, not on the workspace-state attachment path. See `docs/ultron_v3/v3-phase1-design.md` "Why not src/context/attachments.ts" for the rationale.

Acceptance:

- A tool can return text plus one PNG screenshot and the next model request receives both.
- Tool-use/tool-result pairing remains valid after normalization.
- Oversized images are rejected or downscaled deterministically.
- OpenAI and Anthropic adapter tests cover image-bearing turns.

### Phase 2 - Playwright Browser Session

See `docs/ultron_v3/v3-phase2-design.md` for the full design.

Deliverables:

- Add the `playwright` package (not `playwright-core`) to `dependencies`. **No `postinstall` hook**: users run `npx playwright install chromium` once after `npm install`. Missing-binary case is detected at session start and surfaced as `BrowserSessionError(kind: 'chromium_not_installed')` with the install command in the message.
- Implement session lifecycle behind a `BrowserSession` interface, with one concrete `PlaywrightBrowserSession` implementation. Profiles B (managed stealth) and C (container desktop) plug into the same interface in later phases.
- Implement screenshot capture **into memory** (no temp files). Phase 2 enforces `viewport === displaySize` at session start; mismatched configs reject with `viewport_mismatch`. Real downscaling lands when a future phase first decouples the two.
- Implement coordinate conversion (pure module). Both directions ship in Phase 2 — `pixelToNormalized` is needed for the bridge translation contract round-trip test (line 778) and for native-bridge inputs in the Stretch Phase.
- Implement network domain enforcement at **two layers**: pre-flight check in `navigate(url, signal)` AND a `context.route('**/*', handler)` interceptor for subresources.
- Implement URL scheme enforcement: HTTPS-only by default; `http:` permitted only behind a test-only `allowHttpForTest` flag; `data:` / `file:` / `javascript:` / `blob:` / `ws:` / `wss:` / `ftp:` always rejected.
- Create `src/core/computer/policy.ts` (Phase 2 slice: `isDomainAllowed` + `isUrlSchemeAllowed`). Phase 4 extends this module with the risk classifier.
- Implement cleanup on stop, timeout, and abort through a single `closeOnce(id)` path that closes both `context.close()` and `browser.close()`. All three triggers (explicit stop, timeout, abort) route through `SessionManager.requestClose`; abort never short-circuits with a direct `page.context().close()`.
- Stabilization (`stabilize.ts`) ships steps 1–4 of the v3 plan stack only (commit + `domcontentloaded` + animation debounce). Step 5 (ARIA snapshot sampling) is deferred to Phase 4 alongside `ariaSnapshot.ts`.

Files:

- `package.json`
- `CLAUDE.md` (note `npx playwright install chromium` and the `ULTRON_PLAYWRIGHT_INTEGRATION=1` env var)
- `src/core/computer/types.ts`
- `src/core/computer/coordinates.ts`
- `src/core/computer/policy.ts`
- `src/core/computer/sessionManager.ts`
- `src/core/computer/playwrightBrowserSession.ts`
- `src/core/computer/stabilize.ts`
- `src/core/computer/*.test.ts`
- `src/core/computer/playwrightBrowserSession.integration.test.ts` (env-gated by `ULTRON_PLAYWRIGHT_INTEGRATION=1`, mirroring `seatbelt.integration.test.ts`)

Acceptance:

- Starting a browser session creates an isolated context.
- Navigation to denied domains is blocked before request completion (top-level AND subresource).
- Screenshot returns expected dimensions and MIME type.
- Abort closes the Playwright context AND browser process.
- Unit tests use fakes; integration tests use Playwright and run separately under `ULTRON_PLAYWRIGHT_INTEGRATION=1`.

Out of scope for Phase 2 (deferred to later phases):

- `redaction.ts`, `ariaSnapshot.ts`, `verify.ts`, risk classifier — Phase 4.
- `debugPersistScreenshots` from settings is not read in Phase 2; screenshots are memory-only.
- No Computer-Use tools, no registry registration, no system-prompt changes.

### Phase 3 - Computer Tool Surface

See `docs/ultron_v3/v3-phase3-design.md` for the full design.

Deliverables:

- Extend `BrowserSession` (in `src/core/computer/types.ts`) with action primitives — `click`, `doubleClick`, `typeText`, `pressKey`, `scroll`, `drag` — plus a `readonly headless: boolean` field for headed-session detection. Tools depend on the **interface**, not on Playwright; Profile B/C plug in under the same shape.
- Add a public `ComputerSessionManager` interface (the class's public-method shape) so test fakes type-cleanly satisfy the QE seam without inheriting `SessionManager`'s private brand.
- Implement the action methods in `PlaywrightBrowserSession` via `page.mouse` / `page.keyboard`, routed through Phase 2's `_withAbort` helper. New `BrowserSessionErrorKind` value: `'interaction_failed'`. Also harden `_withAbort` with a post-op abort check so mid-call aborts on fast operations actually surface as `'aborted'`.
- Implement all 11 `Computer*` tools as a single `createComputerUseTools(deps)` factory under `src/tools/ComputerTools.ts` (mirroring `src/tools/MemoryTools.ts::createMemoryTools`). Ships a shared `mapBrowserSessionError(err): ToolResult` helper so `BrowserSessionError(kind: 'aborted')` surfaces as `errorKind: 'aborted'` (without the helper, `runToolUse.ts:265` would map it to `'execution_error'`). The 11-file listing earlier in this doc is a logical inventory, not a literal directory layout.
- Register them only when `computerUse.enabled === true` (Phase 0 disabled-state contract). Registration happens in `QueryEngine` constructor synchronously — `createDefaultRegistry` stays unchanged, mirroring the MemoryTools precedent. The `BrowserSessionFactory` is built **lazily** (`async (params) => (await import('../core/computer/playwrightBrowserSession.js')).createPlaywrightSessionFactory()(params)`) so the Playwright module never loads when Computer-Use is disabled.
- `ComputerStart`'s input schema does **not** expose `allowedDomainsOverride` — that would be a policy bypass exposed to the model. Tests inject `computerUseSettings` (overriding disk settings) or a fake `ComputerSessionManager` instead.
- Every Computer tool is `isConcurrencySafe: () => false` (UI is serial). `ComputerObserve` and `ComputerWait` are `isReadOnly: true`. Every other tool — including `ComputerStop` (terminates a chromium subprocess; process-state mutation per `src/core/tools/types.ts:90–96`) and `ComputerScroll` (dispatches scroll handlers, can trigger lazy-loading network requests) — is `isMutating: true`, `isReadOnly: false`. Mutation flag and permission posture are orthogonal: see `docs/ultron_v3/v3-phase3-design.md` "Permission posture."
- Action tools auto-observe by default: `stabilize()` → `screenshot()` → return `{ content, attachments: [<png>] }` (resolves Open Question 3 in favor of automatic post-action observation; cost-control setting deferred).
- Permission posture: every Computer tool **except `ComputerHandoffToUser`** returns `'allow'` from `checkPermissions`. The user prompt comes from the cascade's fallback `ask` (step 7), and per-host allow rules (step 6) can short-circuit. Returning `'ask'` from `checkPermissions` would short-circuit the cascade at step 3 and prevent allow rules from ever running — that's the WebFetch posture, mirrored here. Phase 4's risk classifier lives at step 4 (safety checks) which runs BEFORE allow rules and is therefore non-bypassable.
- `ComputerHandoffToUser` is the one tool that legitimately returns `'ask'` from `checkPermissions` (it never wants host-rule routing). Gated by `computerUse.allowAuthHandoff`, denies on missing session OR `session.headless === true` (engine `permissionOpts.headless` is the CLI being non-interactive, not the Playwright session being invisible — both must be checked). Captures a screenshot on resume. **`storageState` snapshot/rehydrate is deferred to Phase 4** alongside per-session scratch directory infrastructure.

Files:

- `docs/ultron_v3/v3-phase3-design.md` (new)
- `src/core/computer/types.ts` (`BrowserSession` action methods + `headless` field; `'interaction_failed'` error kind; `ComputerSessionManager` interface)
- `src/core/computer/sessionManager.ts` (`class SessionManager implements ComputerSessionManager` — type assertion only)
- `src/core/computer/playwrightBrowserSession.ts` (implement 6 new methods + `headless` field; tighten `_withAbort` with post-op abort check)
- `src/core/computer/playwrightBrowserSession.test.ts` (wiring tests + post-op abort path)
- `src/core/computer/playwrightBrowserSession.integration.test.ts` (env-gated; new action cases)
- `src/tools/ComputerTools.ts` (new — single-file factory + `mapBrowserSessionError` helper + `runActionAndObserve` helper)
- `src/tools/ComputerTools.test.ts` (new — `FakeBrowserSession` + `FakeSessionManager` implementing `ComputerSessionManager`)
- `src/sdk/QueryEngine.ts` (store settings; lazy `BrowserSessionFactory`; register tools when enabled; `stopAll()` on dispose; add `computerUseSettings?` + `sessionManager?: ComputerSessionManager` test seams)
- `src/sdk/QueryEngine.test.ts` (conditional registration; dispose-calls-stopAll; verify disabled engine never loads `playwright` module)

Acceptance:

- Each tool validates malformed input with a clear `validation_failed`.
- Each tool returns `aborted` when the query signal aborts.
- Tool execution order remains serial in `query.ts`.
- Registry tests prove tools are absent by default and present when enabled.
- Coordinate-based tools are the **fallback** path; Phase 4b lands the preferred DOM-first path. The system prompt does not yet bias the model toward atoms — that comes in Phase 5 after Phase 4b ships.

### Phase 4 - Policy, Safety Checks, And Watch Mode

Deliverables:

- Implement risk classification.
- Add non-bypassable Computer safety checks.
- Add redaction for password fields and configured selectors.
- Add per-action approval prompts for sensitive/dangerous operations.
- Add CLI watch-mode rendering for current URL, screenshot preview path, and proposed action.

Files:

- `src/core/computer/policy.ts`
- `src/core/computer/redaction.ts`
- `src/core/permissions/types.ts` if a richer ask payload is needed
- `src/sdk/QueryEngine.ts`
- CLI rendering files
- tests beside changed modules

Acceptance:

- `Submit`, `Delete`, `Send`, `Pay`, and similar actions require approval even under permissive modes.
- Headless mode denies actions that would require approval.
- Password-field screenshots are redacted.
- Audit rows contain metadata but not raw screenshot bytes.
- `verify.ts` is wired into action tools: a click on an overlay-blocked button returns `verified: false`, not a false success.
- *(Prompt-injection acceptance — "fixture pages do not override the user's task" — is owned by Phase 5, which ships the `<untrusted-page-text>` system-prompt delimiter rule. Phase 4's safety check uses ARIA structure, not raw page text, so policy is not influenced by injected content.)*

### Phase 4b - DOM-First Action Path

Phase 4b operationalizes Design Principle 10 ("prefer deterministic APIs when possible"). It lands after Phase 4 because both share `page.ariaSnapshot()` infrastructure and the redaction/sensitive-field detection introduced in Phase 4. Phase 3 stays minimal so the screenshot/permission/audit spine is exercised end-to-end before atom resolution layers on top.

The Vision-LLM coordinate path from Phase 3 is already enough to make the
browser usable, but it is intentionally the fallback substrate: every action
depends on screenshot interpretation, coordinate prediction, viewport stability,
and another image-bearing model turn when the page is ambiguous. Phase 4b exists
to avoid using vision when the page exposes a stable semantic target. The model
chooses an `atomId` from the ARIA-derived action list, and Ultron resolves that
atom to a Playwright locator internally. That makes common form, navigation, and
button workflows cheaper, more deterministic, easier to audit, and easier to
protect with the Phase 4 permission/safety cascade. Vision remains available for
canvas apps, custom widgets, screenshots with no useful accessibility tree, and
atom-resolution failures.

Deliverables:

- `ComputerObserveActions(sessionId)` tool: returns `[{ atomId, role, name, hint?, bbox? }, ...]` derived from the redacted ARIA snapshot. The model picks an `atomId` rather than coordinates.
- `ComputerActAtom(sessionId, atomId, params?)` tool: resolves `atomId` to a Playwright locator, performs the action (click, fill, select), returns post-action observation through the same `verify.ts` stack. Returns `errorKind: "atom_resolution_failed"` if the locator no longer matches; the model can then fall back to a coordinate tool.
- Selector cache keyed on `{ url, atomId, ariaSignature }` — replays skip ARIA serialization on cache hit. Per-session, cleared on `ComputerStop`.
- `ariaSnapshot.ts` (added in Phase 4) is reused.

Files:

- `src/tools/ComputerObserveActionsTool.ts`
- `src/tools/ComputerActAtomTool.ts`
- `src/core/computer/atomResolver.ts`
- `src/core/computer/selectorCache.ts`
- `src/core/tools/registry.ts`
- tests beside changed modules

Acceptance:

- A known-stable element (`<button aria-label="Sign in">`) is acted on by `ComputerActAtom` without the model receiving a screenshot for that turn.
- The selector cache hits on a replay run; the LLM is not invoked for atom resolution on the cache-hit path.
- Atom-resolution failure produces a clear error result that the model can recover from with a coordinate-tool fallback.
- DOM-first tools share the same permission cascade, audit, and approval path as the coordinate tools.

### Phase 5 - Computer-Use Prompting And Agent Loop Tuning

Deliverables:

- Add system prompt guidance only when Computer-Use is enabled.
- Tell the model to **prefer the DOM-first atom path** (`ComputerObserveActions` + `ComputerActAtom`) and fall back to coordinate tools only when the atom path returns no candidates or fails resolution.
- Tell the model coordinates are normalized to `[0, 1]` at the tool boundary.
- Tell the model webpage text is untrusted; observations wrap page-derived text in `<untrusted-page-text>...</untrusted-page-text>` delimiters and the model must treat content inside those tags as data, never as instructions.
- Tell the model to stop and ask when uncertain or before irreversible actions.
- Add max-step and no-progress detection. No-progress signal includes (a) duplicate screenshot pHash, (b) identical `ariaSnapshotHash` for N consecutive turns, (c) `verify.ts` repeatedly returning `verified: false`.
- Add task completion verification pattern.

Files:

- `src/context/systemPrompt.ts`
- `src/context/systemPrompt.test.ts`
- `src/core/computer/sessionManager.ts`

Acceptance:

- Model-facing instructions are absent when Computer-Use is disabled.
- Computer-Use turns stay within configured `maxSteps`.
- Repeated identical screenshots **or** repeated identical ARIA snapshots cause a controlled failure instead of an infinite loop.
- A prompt-injection fixture page (with "ignore prior instructions" inside the page text) does not deviate the agent from the user's task; the system prompt diff at runtime contains the `<untrusted-page-text>` delimiter rule only when Computer-Use is enabled.

### Stretch Phase - Optional Native Provider Bridges

**Prerequisite:** the bridge translation contract from §"Optional: Native Provider Protocol Bridges" must be in place before any native bridge ships. Bridges call into it on every `computer_call` / provider tool request to translate model-emitted pixel coords against `displaySize` into the canonical `NormalizedPoint`. Without this, two Computer-Use coordinate systems coexist and divergence is a question of when, not if.

Deliverables:

- Add provider capability flags for native Computer-Use protocols, if needed.
- Add OpenAI native CUA bridge only if it materially improves behavior over ordinary Ultron tools.
- Add Anthropic native computer tool bridge only if it materially improves behavior over ordinary Ultron tools.
- Keep all provider-native actions routed through the same `ComputerSession`, policy, audit, and approval path.
- Explicitly document native bridges as deferred if the unified Ultron tool path is sufficient for v3.

Files:

- `src/core/providers/types.ts`
- `src/core/providers/openaiAdapter.ts`
- `src/core/providers/anthropicAdapter.ts`
- `src/core/queryDeps.ts` if native CUA needs a side-channel
- `src/core/query.ts` only if unavoidable
- provider tests

Acceptance:

- If implemented, OpenAI `computer_call` items are translated into canonical `ComputerAction`s and answered with `computer_call_output`.
- If implemented, OpenAI `pending_safety_checks` become human approval requests, never silent acknowledgements.
- If implemented, Anthropic `computer_YYYYMMDD` requests are translated into canonical `ComputerAction`s and execute through the same policy layer.
- Ordinary tool calling still works for all providers.

### Phase 6 - Evaluation And Hardening

Deliverables:

- Build deterministic local test pages for common workflows.
- Add prompt-injection and dangerous-action fixtures.
- Add coordinate scaling tests for multiple viewports and device scale factors.
- Add cost and step-count metrics.
- Add failure recovery tests.

Fixture scenarios:

- Simple search form.
- Multi-step form without submit.
- Multi-step form with submit requiring approval.
- Login page requiring user takeover.
- Payment/delete/send buttons requiring approval.
- Popup and modal handling.
- Infinite scroll.
- Prompt-injection page telling the model to ignore user instructions; observation must wrap page-derived text in `<untrusted-page-text>` delimiters and the model must not deviate.
- Retina/high-DPI coordinate conversion.
- Slow-loading page.
- Download/upload blocked by policy.

Acceptance:

- Browser MVP succeeds on simple local form tasks.
- Dangerous actions are gated.
- Denied domains are never visited.
- Coordinate conversion passes across viewport/device scale fixtures.
- Abort leaves no live browser session.
- Debug screenshots are off by default.

### Phase 7 - Documentation And Release

**Status:** complete. User docs at [`docs/computer-use.md`](../computer-use.md). Per-phase design at [`docs/ultron_v3/v3-phase7-design.md`](v3-phase7-design.md).

Deliverables:

- User docs for enabling Computer-Use.
- Security model docs.
- Settings docs.
- Troubleshooting docs for Playwright/browser installation.
- Explicit limitations.

Acceptance:

- A user can enable Computer-Use for one allowlisted domain and complete a simple browser task.
- A user can understand which data may be sent to the model.
- A user can see how to disable Computer-Use completely.

## Test Matrix

Minimum unit tests:

- Coordinate validation: round-trip pixel → NormalizedPoint → CSS px under DSF=1, DSF=2, viewport-resize between observe and act, and downscaled-screenshot remap.
- URL/domain allowlist and denylist matching.
- Risk classifier.
- Redaction bounding boxes.
- ARIA snapshot serialization, token-budget truncation, and hash stability.
- `verify.ts` signal correctness: snapshot-diff, masked-pixel SSIM, pHash diff individually and combined.
- Settings validation.
- Tool input validation.
- Tool permission behavior.
- Session timeout and abort cleanup.
- Image payload size caps and downscaling to `displaySize`.
- Provider image mapping.
- Selector cache hit/miss behavior on the DOM-first atom path.

Minimum integration tests:

- Start -> navigate -> observe -> click -> observe -> stop.
- Start -> navigate -> `ComputerObserveActions` -> `ComputerActAtom` -> observe -> stop (DOM-first happy path).
- Atom-resolution failure falls back cleanly to a coordinate tool.
- Denied domain navigation.
- Submit approval.
- Headless denial for approval-required action.
- Screenshot redaction on password field.
- Overlay-blocked button: action returns `verified: false` and the agent retries instead of advancing.
- Auth handoff: pause, manual login, resume with rehydrated `storageState`.
- Browser crash cleanup.

Manual verification before release:

- `npm run typecheck`
- `npm run test`
- Playwright integration suite
- One real allowlisted site with read-only navigation
- One local high-risk fixture proving approval prompts work

## Rollout Plan

1. Land disabled substrate.
2. Enable Computer-Use only through SDK/config opt-in.
3. Enable local test-domain workflows.
4. Enable allowlisted external browser workflows.
5. Verify hot-swapping across at least one Anthropic model and one OpenAI model through the same Ultron tool interface.
6. Add provider-native OpenAI or Anthropic bridges only if the unified tool path leaves a measured gap.
7. Consider isolated desktop adapter only after browser workflows are stable.

## Success Criteria

v3 is complete when:

- Computer-Use is disabled by default and opt-in.
- Browser Computer-Use works through normal Ultron tools, with the DOM-first atom path (`ComputerObserveActions` + `ComputerActAtom`) as the preferred surface and coordinate tools as the fallback.
- Coordinates are normalized internally; the bridge translation contract for native providers is documented and unit-tested.
- Screenshots are model-visible, redacted where needed, and downscaled to `displaySize` before emission.
- ARIA-snapshot-based post-action verification is wired into action tools; "claimed-clicked-but-didn't" cases are caught.
- Every action flows through validation, permissions, hooks, audit, and abort handling.
- Domain allowlists are enforced by the browser environment, not just by the prompt.
- Sensitive and irreversible actions require human approval.
- Auth handoff is gated behind `allowAuthHandoff` and snapshots `storageState` on resume.
- Headless mode denies approval-required actions.
- Action loops have hard step, time, and no-progress limits (no-progress includes duplicate `ariaSnapshotHash` and repeated `verified: false`).
- Model hot-swapping works through the same Ultron Computer-Use tool interface.
- OpenAI and Anthropic native Computer-Use bridges are optional and not required for v3 completion. When implemented, they go through the bridge translation contract and route the version-correct `computer_*` tool per the model.
- v3 scopes browser sandboxing to **Profile A (local Playwright)** only; Profiles B (managed stealth) and C (container desktop) are documented as future environment adapters.
- Direct host desktop control is not present.

## Open Questions

1. Should v3 ship with `playwright` or `playwright-core`?
   - `playwright` is simpler but heavier.
   - `playwright-core` is lighter but requires browser discovery/install UX.
   - Recommended MVP choice: `playwright`, then revisit package size.

2. Should screenshots be stored in memory only or temporary files?
   - Memory-only is safer.
   - Temporary files make CLI preview easier.
   - Recommended MVP choice: memory-only by default, temp files only for interactive approval previews.

3. Should action tools automatically return a post-action screenshot?
   - Automatic observation reduces model round trips.
   - Separate `ComputerObserve` gives clearer control and lower accidental image leakage.
   - Recommended MVP choice: action tools return post-action observation after session approval, with a setting to require explicit observe if cost becomes an issue.

4. Should native provider protocol bridges be included in v3?
   - The unified Ultron tool interface is the required v3 path and preserves model hot-swapping.
   - Native provider protocols may expose extra safety metadata or tuned action formats.
   - Recommended v3 commitment: ship the unified Ultron runtime first; add native bridges only after measuring a gap that ordinary Ultron tools cannot close.

5. Coordinate model: normalized `[0, 1]` vs raw pixels at the tool boundary?
   - **Resolved:** keep normalized internally to stay invariant under viewport resize, screenshot downscaling, and DSF/Retina differences. Native bridges (Anthropic / OpenAI / Gemini) emit pixel coords against an advertised `displaySize`; the bridge translation contract converts in/out at the bridge layer. See §"Bridge Translation Contract."

6. ARIA snapshot vs vision as primary action substrate?
   - **Resolved:** vision-based coordinate tools land in Phase 3 to exercise the spine end-to-end and cover visual-only interfaces. They are not the preferred long-term action substrate because they require screenshot interpretation, coordinate prediction, and viewport-sensitive execution for targets that the browser can often expose semantically. The DOM-first atom path lands in Phase 4b once `page.ariaSnapshot()` infrastructure is shared with `verify.ts`; it lets the model choose semantic `atomId`s while Ultron performs deterministic locator resolution internally. The system prompt biases the model toward atoms (Phase 5); coordinate tools remain as the documented fallback for canvas/custom UI, weak accessibility trees, and atom-resolution failures.
