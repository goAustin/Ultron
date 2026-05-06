# v3 Phase 1 Design: Image Observation Substrate

## Status

Pre-implementation. Approved plan: `~/.claude/plans/now-make-a-pla-crispy-flask.md`. Roadmap: `docs/ultron_v3/v3-computer-use-plan.md` (Phase 1 deliverables, lines 523–547). Predecessor: `docs/ultron_v3/v3-phase0-design.md` (settings + disabled-state contract — already shipped on this branch).

## Context

`docs/ultron_v3/v3-computer-use-plan.md` is the v3 roadmap. Phase 0 added the `computerUse` settings schema and validator. Phase 1 lays the *substrate* for tool results that carry screenshots so the model can see the browser. **No screenshots are actually produced yet** — Phase 2 will do that with Playwright. Phase 1 only proves that an Ultron tool *could* return text + a PNG, that the next model request would receive both, and that message normalization, audit, and provider-mapping layers all stay correct under that change.

Phase 1 is the smallest substrate change that satisfies the four roadmap acceptance criteria (lines 543–547):

1. A tool can return text plus one PNG screenshot and the next model request receives both.
2. Tool-use/tool-result pairing remains valid after normalization.
3. Oversized images are rejected or downscaled deterministically.
4. OpenAI and Anthropic adapter tests cover image-bearing turns.

The work splits into five concrete pieces: extend `ToolResult` with an `attachments?` field; lay the images down as adjacent `ImageBlock`s in the same `UserMessage` that carries the `ToolResultBlock`; teach the OpenAI adapter to map `ImageBlock`s (it currently ignores them — `src/core/providers/openaiAdapter.ts:51–190`); add a `supportsVision` capability flag wired into the load-time guard; and stop the audit log from persisting raw base64 bytes.

## Goals

1. Tools can return one or more PNG attachments alongside text via a typed `ToolResult.attachments?: readonly ToolResultAttachment[]` field.
2. The single conversion site (`createToolResultMessage` at `src/core/messages.ts:148–165`, called from `query.ts:462`) lays attachments down as adjacent `ImageBlock`s in the same `UserMessage`. No invariant change in `normalizeMessages.ts`.
3. Both provider adapters round-trip image-bearing tool results to the model:
   - Anthropic: existing `ImageBlock → ImageBlockParam` mapping (`anthropicAdapter.ts:74–82`) carries the work — image lives as a sibling block in the user `MessageParam.content`. No mapping change.
   - OpenAI Responses: emit `function_call_output` for the tool result, then a sibling `{type:'message', role:'user', content:[{type:'input_image', image_url:'data:…', detail:'auto'}]}` for the screenshot. The `detail` field is required by the SDK type (`responses.d.ts:2823–2828`).
   - OpenAI Chat Completions: the same restructure, emitting `tool` then `user` messages inline.
4. A pure helper `validateImageAttachment(image, caps)` enforces `maxScreenshotBytes` and `maxScreenshotDimensions` from Phase 0 settings via a tiny PNG IHDR parser — no new runtime dependency.
5. `supportsVision: boolean` lives on `ModelEntry` and `CapabilitySheet`, populated by every adapter, and enforced by `assertCapabilitiesPopulated` in `validateCapabilities.ts`.
6. Audit serialization strips base64 image bytes before secret redaction, replacing them with metadata (mediaType, byteSize, dimensions, redacted flag).

## Non-goals

- No actual screenshot capture (Phase 2 — `playwrightBrowserSession.ts`).
- No downscaling or resampling (Phase 2 — Playwright captures at `displaySize` natively, eliminating the need for a server-side resampler).
- No Computer-Use tools (Phase 3).
- No password-field redaction or selector-based redaction (Phase 4 — `redaction.ts`).
- No ARIA snapshot serialization or post-action verification (Phase 4 — `ariaSnapshot.ts` / `verify.ts`).
- No native provider Computer-Use bridges (Stretch Phase).
- No system-prompt changes (Phase 5).
- No image hash on audit metadata (Phase 4, alongside selector-based redaction).
- No capability gating on `supportsVision` at registry time (Phase 3, where Computer-Use tools get registered).
- No JPEG support — Phase 1 is PNG-only. Reach matches the v3 plan's `mediaType: 'image/png' | 'image/jpeg'` (`docs/ultron_v3/v3-computer-use-plan.md:168`); JPEG IHDR parsing can be added when a Phase 2 use case demands it.
- No modification of `src/context/attachments.ts`. The v3 plan listed it conditionally ("if the attachment path is used", line 540); this design opts out — see "Why not `src/context/attachments.ts`" below.

## Key design decisions

### Internal representation: adjacent blocks, not nested

The `ToolResult` carries `attachments?: readonly ToolResultAttachment[]`. `createToolResultMessage` lays them down as `ImageBlock`s appended to the same `UserMessage`'s `content` array, immediately after the `ToolResultBlock`:

```ts
UserMessage { content: [ToolResultBlock, ImageBlock, ImageBlock?, ...] }
```

**Why adjacent, not nested inside `ToolResultBlock.content`:**

- Keeps `ToolResultBlock.content: string` (`src/core/messages.ts:48–53`) — no schema rewrite, no normalize-pipeline ripple, no test-fixture churn elsewhere in the codebase.
- Anthropic's API accepts both forms (sibling and nested); we pick the form that costs less code.
- For OpenAI Responses, `function_call_output.output` is **string-only** by spec — the image must be a sibling user item regardless of how we model it internally. Matching the OpenAI mapping at the internal layer keeps both adapters block-by-block instead of forcing one of them to invent a flatten/inline pass.
- `stripOrphanedToolResults` (`normalizeMessages.ts:99–101`) only inspects `tool_result` blocks; `ImageBlock`s pass through untouched. `enforceRoleAlternation` (`normalizeMessages.ts:118–140`) merges adjacent same-role messages without inspecting block types; image blocks ride through. The 5-step pipeline does not need to learn about images.

### Adapter mapping is asymmetric (and that is fine)

| Internal | Anthropic adapter | OpenAI Responses | OpenAI Chat Completions |
|---|---|---|---|
| `ToolResultBlock` | `ToolResultBlockParam(content: string)` (today) | `function_call_output(output: string)` (today) | `{role:'tool', content: string}` (today) |
| `ImageBlock` (sibling in same user message) | `ImageBlockParam` (already mapped at `anthropicAdapter.ts:74–82`) | NEW: `{type:'message', role:'user', content:[{type:'input_image', image_url:'data:image/png;base64,…', detail:'auto'}]}` | NEW: `{role:'user', content:[{type:'image_url', image_url:{url:'data:image/png;base64,…'}}]}` |

Both OpenAI paths gain image support inside the existing `anthropicToOpenAI` / `anthropicToResponsesInput` user-content loops — current code paths drop `image` blocks silently (`openaiAdapter.ts:82–95` for Chat, `139–162` for Responses).

The `detail: 'auto'` field is **required** at the type level: `ResponseInputMessageContentList = Array<ResponseInputContent>` (`responses.d.ts:3451`), and `ResponseInputContent = ResponseInputText | ResponseInputImage | ResponseInputFile` (line 2768) — `ResponseInputImage.detail` (line 2823–2828) has no `?`. The mapping cannot omit it.

### Ordering: stream-emit for Responses, two-pass for Chat Completions

`enforceRoleAlternation` merges adjacent user messages, so parallel tool runs produce a single `UserMessage` with content `[tr_A, img_A, tr_B, img_B]`. The current `anthropicToResponsesInput` and `anthropicToOpenAI` loops collect user *text* into a buffer and flush it at the end; copying that pattern for images would detach images from their owning tool_result and emit `[fco_A, fco_B, img_A, img_B]`. The two adapters need different fixes because the two APIs have different ordering rules.

**Responses API — stream-emit.** Function-call outputs are not bound to follow assistant tool_calls directly, so we walk blocks in order with a `flushPendingText()` helper that runs before any non-text block. Pseudocode:

```ts
let pendingText: string[] = []
const flushText = () => {
  if (pendingText.length > 0) {
    result.push({ role: 'user', content: pendingText.join('\n') })
    pendingText = []
  }
}
for (const block of msg.content) {
  if (block.type === 'text') {
    pendingText.push(block.text)
  } else if (block.type === 'tool_result') {
    flushText()
    result.push({
      type: 'function_call_output',
      call_id: block.tool_use_id,
      output: block.content ?? '',
    })
  } else if (block.type === 'image') {
    flushText()
    result.push({
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_image',
        image_url: `data:${block.mediaType};base64,${block.data}`,
        detail: 'auto',
      }],
    })
  }
}
flushText()
```

Output for `[tr_A, img_A, tr_B, img_B]`: `[fco_A, msg_user(img_A), fco_B, msg_user(img_B)]` — images stay tied to their owning tool_result.

**Chat Completions — two-pass.** Chat Completions enforces a stricter constraint: every `role:'tool'` response must follow the assistant's `tool_calls` turn directly. Putting a `role:'user'` message between two tool responses for a multi-call assistant turn is rejected by the API. So the inline pattern that works for Responses would emit invalid request bodies here. Instead, do one pass over all blocks for tool responses, then a second pass for text and images grouped into a single user message:

```ts
const userContent: ChatCompletionContentPart[] = []
for (const block of msg.content) {
  if (block.type === 'tool_result') {
    result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content ?? '' })
  }
}
for (const block of msg.content) {
  if (block.type === 'text') {
    userContent.push({ type: 'text', text: block.text })
  } else if (block.type === 'image') {
    userContent.push({ type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } })
  }
}
if (userContent.length > 0) {
  result.push({ role: 'user', content: userContent })
}
```

Output for `[tr_A, img_A, tr_B, img_B]`: `[tool(A), tool(B), user(img_A, img_B)]`. Image-to-tool ordering is preserved by sequence within each group (image_A appears before image_B because tool_A appeared before tool_B in the source content), so the model can still pair them. The trade-off — losing strict adjacency between an image and its tool — is forced by the Chat Completions protocol, not a design choice.

### Caps enforced at attachment construction, not at the adapter

A pure helper `validateImageAttachment(image, caps)` returns either the validated `ToolResultAttachment` or a structured error. Phase 2's Playwright session calls it before stuffing the screenshot into a `ToolResult`. Phase 1 ships:

- `src/core/tools/imageAttachment.ts` — `ToolResultAttachment` type, the validator, plus a tiny PNG header parser (read IHDR width/height from bytes 16–24 — deterministic; no decoder needed).
- Byte cap check — `Buffer.byteLength(base64, 'base64')` is exact and fast.
- Dimension cap check — parse PNG IHDR. **Reject** if oversized; do not downscale in Phase 1. Phase 2's Playwright capture renders at `displaySize` natively, so resampling never enters the substrate.
- PNG-only. JPEG SOF0 parsing can be added later if a use case emerges.

The validator is a pure function. The screenshot-producing tool (Phase 2) is responsible for calling it; the substrate doesn't pull settings.

### Capability flag: `supportsVision`

Add `readonly supportsVision: boolean` to `ModelEntry` (and to `CapabilitySheet`, which is a `Pick<>` of `ModelEntry` at `providers/types.ts:29–36`). Populate in every adapter's catalog:

- Anthropic: `true` for all currently-listed models (Claude 4.5+).
- OpenAI: `true` for the GPT-5.x catalog (Responses + vision).
- MiniMax: `false` for current entries (verify at implementation time; flip if a vision-capable MiniMax model exists worth wiring up).

**Critical:** also add `'supportsVision'` to `REQUIRED_CAPABILITY_FIELDS` in `src/core/providers/validateCapabilities.ts:11–17`. The load-time guard `assertCapabilitiesPopulated` enumerates each required field by name; without the addition, a model that forgets to declare `supportsVision` would silently typecheck-pass and ship as `undefined`. Adding it to the list makes the guard fail loudly on omission. (The unit-test fixture for `validateCapabilities.test.ts` is updated in lockstep.)

Phase 1 does **not** gate behavior on `supportsVision`. It's metadata that Phase 3's Computer-Use tool registry can read to deny `ComputerStart` when the resolved model can't see screenshots. Phase 1 only wires the flag through.

### Audit: strip image data before serialization

Add `redactImageData(value)` that walks any object/array tree and replaces `{type:'image', mediaType, data:<base64>}` with `{type:'image', mediaType, byteSize, width, height, redacted:true}`. Hash is deferred to Phase 4 (where redaction-aware hashing belongs alongside selector-based redaction). Phase 1's audit envelope just records bytes + dimensions.

Wire it inside `auditLog.ts:serialize()` between the envelope build (line 147–153) and `redactSecrets()` (line 152). One-line insertion. The order matters: `redactImageData` first replaces base64 with metadata; `redactSecrets` then runs over the resulting (smaller) tree and catches any secret patterns inside the now-textual metadata. Existing audit tests don't break — they don't ship base64 images.

### Why not `src/context/attachments.ts`

The v3 plan listed `src/context/attachments.ts` conditionally — "if the attachment path is used" (line 540). Phase 1 opts out. Reasons:

- `src/context/attachments.ts` (lines 1–169) handles **post-tool workspace-state injections**: git status changes, `CLAUDE.md` updates, file-change notifications, date changes. Each is an independent system-reminder `UserMessage` injected after tool execution.
- A tool-result image is **part of the tool result**, not a separate workspace-state event. It belongs in the `UserMessage` that carries the `ToolResultBlock`, paired by toolUseId.
- Routing screenshots through `attachments.ts` would (a) decouple the image from its `ToolResultBlock` (so `stripOrphanedToolResults` no longer protects it), (b) introduce a second "post-tool" stage in `query.ts:504–517`, and (c) require attachment.ts to know about Computer-Use tool semantics it shouldn't care about.

Keeping the two concepts disjoint means the only thing the substrate needs to teach is "tool results can carry images." `attachments.ts` stays a workspace-state observer.

## Schema

### `ToolResultAttachment` (new)

Lives in `src/core/tools/imageAttachment.ts` (alongside the validator and PNG IHDR parser):

```ts
export type ToolResultAttachment = {
  readonly type: 'image'
  readonly mediaType: 'image/png'
  readonly data: string             // base64
  readonly width: number
  readonly height: number
  readonly byteSize: number
  readonly redacted?: boolean       // Phase 4 sets this; Phase 1 leaves undefined
}
```

`mediaType` is locked to `'image/png'` for Phase 1; Phase 2 may relax to a union if JPEG is wired in.

### `ToolResult` (extended)

`src/core/tools/types.ts:32–36`:

```ts
export type ToolResult = {
  readonly content: string
  readonly isError: boolean
  readonly errorKind?: ToolErrorKind
  readonly attachments?: readonly ToolResultAttachment[]   // ← new
}
```

Existing call sites that don't set `attachments` are unaffected (the field is optional).

### `ImageBlock` (extended)

`src/core/messages.ts`:

```ts
export type ImageBlock = {
  readonly type: 'image'
  readonly mediaType: string
  readonly data: string // base64
  // Optional metadata populated by tool-result attachments (v3 Phase 1).
  // Wire-format adapters (Anthropic, OpenAI) ignore these fields; they
  // exist so audit redaction can record dimensions without re-parsing
  // the PNG. See `src/audit/redactImageData.ts`.
  readonly width?: number
  readonly height?: number
  readonly byteSize?: number
}
```

The metadata fields are optional so plain user-message images (no upstream `ToolResultAttachment`) still satisfy the type. Wire-format adapters use only `mediaType` and `data`; the extra fields ride through unchanged.

### `createToolResultMessage` signature (extended)

`src/core/messages.ts`:

```ts
export function createToolResultMessage(
  toolUse: ToolUseBlock,
  result: {
    content: string
    isError: boolean
    attachments?: readonly ToolResultAttachment[]
  },
  id: MessageId,
  timestamp?: number,
): UserMessage {
  const blocks: ContentBlock[] = [
    { type: 'tool_result', toolUseId: toolUse.id, content: result.content, isError: result.isError },
  ]
  if (result.attachments && result.attachments.length > 0) {
    for (const att of result.attachments) {
      blocks.push({
        type: 'image',
        mediaType: att.mediaType,
        data: att.data,
        width: att.width,
        height: att.height,
        byteSize: att.byteSize,
      })
    }
  }
  return createUserMessage(blocks, { id, timestamp })
}
```

`width`/`height`/`byteSize` are forwarded onto the `ImageBlock` so audit redaction can record dimensions without re-parsing the PNG. Wire-format adapters ignore these fields.

### `validateImageAttachment` signature

`src/core/tools/imageAttachment.ts`:

```ts
export type ImageCaps = {
  readonly maxBytes: number
  readonly maxWidth: number
  readonly maxHeight: number
}

export type ValidateImageResult =
  | { ok: true; attachment: ToolResultAttachment }
  | { ok: false; reason: 'oversized_bytes' | 'oversized_dimensions' | 'malformed_png' | 'unsupported_media_type'; message: string }

export function validateImageAttachment(
  data: string,           // base64
  mediaType: string,
  caps: ImageCaps,
): ValidateImageResult
```

The PNG IHDR parser is a private helper. It validates the 8-byte signature, the IHDR chunk length (must be 13), and the chunk type (must be "IHDR") before reading width/height — so a file with a valid signature but arbitrary bytes at offsets 16/20 cannot pass:

```ts
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const IHDR_DATA_LENGTH = 13
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52] as const // "IHDR"

function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null
  }
  if (buf.readUInt32BE(8) !== IHDR_DATA_LENGTH) return null
  for (let i = 0; i < IHDR_TYPE.length; i++) {
    if (buf[12 + i] !== IHDR_TYPE[i]) return null
  }
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width === 0 || height === 0) return null
  return { width, height }
}
```

### `ModelEntry` / `CapabilitySheet` (extended)

`src/core/providers/types.ts:15–36`:

```ts
export type ModelEntry = {
  // ... existing fields ...
  readonly supportsVision: boolean   // ← new
}

export type CapabilitySheet = Pick<
  ModelEntry,
  | 'maxContextTokens'
  | 'maxOutputTokens'
  | 'supportsThinking'
  | 'supportsInterleavedThinking'
  | 'promptCacheModel'
  | 'supportsVision'                 // ← new
>
```

`validateCapabilities.ts:11–17`:

```ts
const REQUIRED_CAPABILITY_FIELDS = [
  'maxContextTokens',
  'maxOutputTokens',
  'supportsThinking',
  'supportsInterleavedThinking',
  'promptCacheModel',
  'supportsVision',                  // ← new
] as const
```

## Files

### New

| Path | Purpose |
|---|---|
| `docs/ultron_v3/v3-phase1-design.md` | This file |
| `src/core/tools/imageAttachment.ts` | `ToolResultAttachment` type, `validateImageAttachment(image, caps)`, PNG IHDR parser |
| `src/core/tools/imageAttachment.test.ts` | Caps tests, malformed-PNG handling, oversized-byte rejection |
| `src/audit/redactImageData.ts` | Pure helper: walk a value tree, replace `{type:'image',data:…}` with metadata |
| `src/audit/redactImageData.test.ts` | Walks nested objects/arrays/Errors; non-image data unchanged |

### Modified

| Path | Change |
|---|---|
| `docs/ultron_v3/v3-computer-use-plan.md` | Phase 1 file list (~lines 532–540) — drop the conditional `src/context/attachments.ts` hedge so the roadmap matches this design's "not modified" decision |
| `src/core/tools/types.ts` | Re-export `ToolResultAttachment`; add `attachments?: readonly ToolResultAttachment[]` to `ToolResult` |
| `src/core/messages.ts` | Extend `ImageBlock` with optional `width?`/`height?`/`byteSize?` so audit redaction has dimensions. Extend `createToolResultMessage` to accept attachments, lay them down as adjacent `ImageBlock`s, and forward dimension metadata. Update the JSDoc. |
| `src/core/messages.test.ts` | Direct test: `createToolResultMessage` with attachments produces a `UserMessage` whose content is `[ToolResultBlock, ImageBlock, ImageBlock?, ...]` in order, with `width`/`height`/`byteSize` forwarded onto each `ImageBlock`. Absence of attachments preserves the existing single-block shape. |
| `src/core/normalizeMessages.ts` | Widen the `stripStaleThinkingBlocks` trajectory predicate to accept user messages whose content is a mix of `tool_result` and `image` blocks (was: every block must be `tool_result`). Without this widening, an image-bearing tool result would terminate the trajectory walk and the prior assistant turn's thinking blocks would be wrongly treated as stale. |
| `src/core/normalizeMessages.test.ts` | Add image-bearing tool-result fixture; confirm the 5-step pipeline preserves block order. Add a parallel-tool-result merge test confirming `[tr_A, img_A, tr_B, img_B]` ordering survives `enforceRoleAlternation`. Add a thinking-preservation test asserting that an image-bearing tool result does not strip thinking from the prior assistant turn. |
| `src/core/providers/types.ts` | Add `supportsVision: boolean` to `ModelEntry` and `CapabilitySheet` |
| `src/core/providers/validateCapabilities.ts` | Add `'supportsVision'` to `REQUIRED_CAPABILITY_FIELDS` |
| `src/core/providers/validateCapabilities.test.ts` | Add a fixture missing `supportsVision`; assert `assertCapabilitiesPopulated` throws |
| `src/core/providers/anthropicAdapter.ts` | Populate `supportsVision: true` per model entry. (No mapping change — `ImageBlock` already mapped at lines 74–82.) |
| `src/core/providers/anthropicAdapter.test.ts` | Add: tool_use → tool_result + ImageBlock → request body has `tool_result` and `image` blocks adjacent in the user MessageParam |
| `src/core/providers/openaiAdapter.ts` | Add `ImageBlock` handling. **Responses** uses a stream-emit loop with `flushPendingText` so images stay inline next to their owning `function_call_output`; emits `{type:'message', role:'user', content:[{type:'input_image', image_url:'data:…', detail:'auto'}]}` (the `detail` field is required by the SDK type). **Chat Completions** uses a two-pass loop — all `role:'tool'` responses first, then a single `user` message with text + `image_url` content — because Chat Completions rejects a `user` message between tool responses for a multi-call assistant turn. Populate `supportsVision: true` per model entry. |
| `src/core/providers/openaiAdapter.test.ts` | Three image tests: Chat Completions plain user message with `image_url`; Responses `input_image` with `detail`; Responses parallel-tool-results asserting inline `[fco_A, img_A, fco_B, img_B]` ordering. Plus a Chat Completions parallel test asserting the *opposite* ordering — `[tool_A, tool_B, user(img_A, img_B)]` — required by the Chat protocol. |
| `src/core/providers/minimaxAdapter.ts` | Populate `supportsVision: false` per model entry |
| `src/audit/auditLog.ts` | One-line insertion in `serialize()` (~line 147–153): apply `redactImageData(envelope)` before `redactSecrets(envelope)` |
| `src/core/query.ts` | No code change. The substrate is exercised through `messages.test.ts` + adapter tests; `query.ts:462` is a single-line call to `createToolResultMessage` and inherits the attachment forwarding for free. |

### Reused (no modification)

- `src/config/computerUseSettings.ts` — Phase 0 caps (`maxScreenshotBytes`, `maxScreenshotDimensions`) consumed by Phase 2's screenshot-producing tool when it calls `validateImageAttachment`. No new fields.
- `src/core/providers/registry.ts:36–65` — `resolveCapabilities` automatically includes `supportsVision` once the field is added to `ModelEntry`/`CapabilitySheet`. No change.
- `src/memory/redact.ts` — `redactSecrets` runs *after* `redactImageData`; ordering preserves existing secret-detection behavior on the now-shrunk envelope.
- `src/context/attachments.ts` — explicitly **not** touched (see "Why not `src/context/attachments.ts`" above).

## Implementation order

Two batches. Batch 1 is docs only; pause for review before Batch 2.

### Batch 1 — Docs

1. Write this design doc (`docs/ultron_v3/v3-phase1-design.md`).
2. Amend `docs/ultron_v3/v3-computer-use-plan.md` Phase 1 file list (~lines 532–540) to drop the conditional `src/context/attachments.ts` hedge.

**Pause for review.** User reviews the design doc and roadmap amendment before any code lands.

### Batch 2 — Code

3. Add `ToolResultAttachment` to `src/core/tools/imageAttachment.ts` (new file). Implement `validateImageAttachment` and the private PNG IHDR parser.
4. Add `attachments?` to `ToolResult` in `src/core/tools/types.ts`. Re-export `ToolResultAttachment` from there for convenience.
5. Extend `createToolResultMessage` in `src/core/messages.ts` to lay attachments down as adjacent `ImageBlock`s. Update its JSDoc.
6. Add `supportsVision: boolean` to `ModelEntry` + `CapabilitySheet` in `providers/types.ts`. Populate per-model in `anthropicAdapter.ts`, `openaiAdapter.ts`, `minimaxAdapter.ts`. Add `'supportsVision'` to `REQUIRED_CAPABILITY_FIELDS` in `validateCapabilities.ts`.
7. Add `ImageBlock` handling to both OpenAI mapping functions. `anthropicToResponsesInput` uses a stream-emit loop with `flushPendingText` (function_call_output items can interleave freely). `anthropicToOpenAI` uses a two-pass loop — all `role:'tool'` responses first, then one `user` message gathering text and `image_url` parts — because Chat Completions rejects a `user` between tool responses for a multi-call turn. For Responses, include the required `detail: 'auto'` field on `input_image` content.
8. Create `src/audit/redactImageData.ts`. Wire it into `auditLog.ts:serialize()` before `redactSecrets`.
9. Tests:
   - `messages.test.ts` — `createToolResultMessage` attachment behavior (multi-block result, single-block fallback when no attachments).
   - `imageAttachment.test.ts` — byte cap rejected, dimension cap rejected, malformed PNG rejected, valid attachment passes through, JPEG rejected.
   - `redactImageData.test.ts` — walks nested arrays/objects, replaces `{type:'image',data:…}`, leaves non-image data untouched, handles Errors per `redactSecrets` parity.
   - `validateCapabilities.test.ts` — fixture missing `supportsVision` makes `assertCapabilitiesPopulated` throw.
   - `anthropicAdapter.test.ts` — image-bearing tool result lands in `MessageParam.content` with `tool_result` and `image` adjacent.
   - `openaiAdapter.test.ts` — Chat Completions request body has `image_url`; Responses request body has `function_call_output` followed by `{type:'message', role:'user', content:[{type:'input_image', image_url:'data:…', detail:'auto'}]}`. Plus parallel-tool-results inline ordering.
   - `normalizeMessages.test.ts` — image-bearing tool-result fixture round-trips through the 5-step pipeline; merge-after-alternation preserves block order.

## Verification

### Unit tests

- `messages.test.ts`:
  - `createToolResultMessage` with no attachments → single-block `[ToolResultBlock]` (existing behavior).
  - With one attachment → `[ToolResultBlock, ImageBlock]`. `ImageBlock.data`, `ImageBlock.mediaType`, **and** `ImageBlock.width` / `height` / `byteSize` mirror the input `ToolResultAttachment` exactly.
  - With three attachments → `[ToolResultBlock, ImageBlock, ImageBlock, ImageBlock]` in order.
- `imageAttachment.test.ts`:
  - Valid 1024×768 PNG under the byte cap → `{ ok: true, attachment }`.
  - Same PNG with `maxBytes` smaller than its size → `{ ok: false, reason: 'oversized_bytes' }`.
  - 1281×768 PNG with `maxWidth: 1280` → `{ ok: false, reason: 'oversized_dimensions' }`.
  - JPEG `mediaType` → `{ ok: false, reason: 'unsupported_media_type' }`.
  - Truncated PNG (< 24 bytes) → `{ ok: false, reason: 'malformed_png' }`.
  - Wrong magic bytes → `{ ok: false, reason: 'malformed_png' }`.
  - Valid signature but IHDR chunk length ≠ 13 → `{ ok: false, reason: 'malformed_png' }`.
  - Valid signature but chunk type ≠ "IHDR" → `{ ok: false, reason: 'malformed_png' }`.
- `redactImageData.test.ts`:
  - `{type:'image', mediaType:'image/png', data:'<base64>'}` → `{type:'image', mediaType:'image/png', byteSize:N, redacted:true}` (dimensions reflected if upstream populated them; tolerant of missing).
  - Non-image data passes through unchanged.
  - Walks nested arrays, plain objects, and Errors (mirrors `redactSecrets` behavior).
  - Idempotent — running twice does not double-redact.
- `validateCapabilities.test.ts`:
  - Existing fixtures still pass with the added field.
  - New fixture: a `ProviderAdapter` with a model lacking `supportsVision` → `assertCapabilitiesPopulated` throws with a clear message naming the missing field.
- `anthropicAdapter.test.ts`:
  - Round-trip: assistant `tool_use` → user `[ToolResultBlock, ImageBlock]` → request body's `messages[N].content` contains `tool_result` and `image` blocks adjacent in that order.
- `openaiAdapter.test.ts`:
  - Chat Completions: image-bearing user message produces `{role:'user', content:[{type:'image_url', image_url:{url:'data:image/png;base64,…'}}]}`.
  - Chat Completions parallel: `[tr_A, img_A, tr_B, img_B]` produces `[system, tool(A), tool(B), user(img_A, img_B)]` — all tool responses before the user image message, as required by the Chat protocol.
  - Responses: image after a tool result emits `function_call_output` then `{type:'message', role:'user', content:[{type:'input_image', image_url:'data:…', detail:'auto'}]}`.
  - Responses parallel: a merged user message with `[tr_A, img_A, tr_B, img_B]` produces `[fco_A, msg_user(img_A), fco_B, msg_user(img_B)]` — images stay tied to their tool_results.
- `normalizeMessages.test.ts`:
  - Image-bearing tool-result fixture: the 5-step pipeline preserves block order and pairing.
  - Parallel tool runs merged by `enforceRoleAlternation` keep `[tr_A, img_A, tr_B, img_B]` ordering.
  - Thinking preservation: an `assistant([thinking, toolUse]) → user([tool_result, image]) → assistant(...)` trajectory keeps the assistant's thinking block intact; the `stripStaleThinkingBlocks` predicate must accept image blocks alongside `tool_result` to walk back through the trajectory correctly.

### Manual smoke

1. `npm run typecheck` — clean.
2. `npm run test` — green.

The "round-trip with stub callModel" check is covered by the unit suite (`messages.test.ts` proves the substrate hinge; the adapter tests prove wire-format mappings; `normalizeMessages.test.ts` proves merge ordering). No new `query.test.ts` is introduced — `query.ts:462` is a single-line call to `createToolResultMessage` and inherits the attachment forwarding for free.

## Open questions (resolve during implementation, not blocking design)

1. Does MiniMax support vision via its OpenAI-compatible Chat Completions endpoint? Tentative: `supportsVision: false` for all current MiniMax entries. Flip if a vision-capable MiniMax model gets added; the load-time guard will catch any forgotten declaration.
2. Should `validateImageAttachment` accept `Buffer` or `string` (base64)? Internal representation is base64 string (`ImageBlock.data`). Tentative: accept base64 string, decode lazily for `Buffer.byteLength` and IHDR parsing.
3. Should `redactImageData` insert a `hash` field? Phase 4 needs hashing for verification (post-action ARIA-snapshot diff + screenshot pHash backstop). Phase 1 deliberately omits it — adding hashing here would couple audit redaction to the verification stack before the verification stack exists. Defer.
4. JPEG support — Phase 1 PNG-only is fine. Add JPEG SOF0 dimension parsing (~20 LOC) if a Phase 2 use case demands it; otherwise defer.

## Out of scope (mirrors v3 roadmap)

- Real screenshot capture — Phase 2 (`playwrightBrowserSession.ts`).
- Actual downscaling/resampling — Phase 2 (Playwright captures at `displaySize` natively, so resampling never enters the substrate).
- Computer-Use tools (`ComputerStart`, `ComputerObserve`, etc.) — Phase 3.
- Conditional registry gating on `supportsVision` — Phase 3.
- Password-field redaction in screenshots — Phase 4 (`redaction.ts`).
- ARIA snapshot serialization and post-action verification (`ariaSnapshot.ts`, `verify.ts`) — Phase 4.
- Image hash on audit metadata — Phase 4 (alongside selector-based redaction).
- Provider-native Computer-Use bridges (OpenAI `computer_call`, Anthropic `computer_*`) — Stretch Phase.
- System prompt guidance for Computer-Use — Phase 5.
