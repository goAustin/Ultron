# Ultron v2 Roadmap

Phase-by-phase build plan for [`docs/v2-scope.md`](docs/v2-scope.md). Each of the 8 pillars (+ 1 parallel track) is split into sub-phases small enough to pick up and ship individually. Every sub-phase has its own Objective, Tasks, Deliverables (exact file paths), Verification (acceptance criteria), and scope gate. Per-sub-phase deep designs land later in `docs/phaseN{letter}-v2-design.md`.

Format mirrors [`docs/ultron_v1/ROADMAP.md`](docs/ultron_v1/ROADMAP.md): substrate-first, deliverables as exact paths, verification as "must" statements, explicit "Does NOT do" gates.

## Numbering convention

Phases are pillars (`1..8`, `P` for parallel). Sub-phases append a letter (`1a`, `1b`, …). A sub-phase is the smallest unit the roadmap tracks; it maps to one design doc and one PR/cluster.

---

## Phase Sequence (at-a-glance, sub-phase level)

| # | Sub-phase | Depends on | Parallelizable with |
|---|---|---|---|
| 1a | Capability metadata on `ModelEntry` | — | 2a |
| 1b | Structured system-prompt parts + cache-hint annotations | 1a | 2a |
| 1c | Thinking/reasoning budget as a generic runtime knob | 1a | 2a, 1b |
| 2a | Unified typed event stream + audit log sink | — | 1a |
| 2b | Pre/post tool hooks (user-configurable) | 2a | 1b, 1c |
| 3a | Tool metadata: `source` + `namespace` + dynamic registration seam | 2a | 1b, 1c, 2b |
| 3b | MCP stdio client (JSON-RPC, `initialize`, `list_tools`, `call_tool`) | 3a | 4a |
| 3c | MCP config surface + lifecycle (lazy connect, reconnect, shutdown) | 3b | 4b |
| 3d | MCP permission + audit integration | 3c, 2a, 2b | 4c |
| 4a | Typed entry schema + on-disk layout | 2a | 3a |
| 4b | Store (read/write) + `MEMORY.md` index generation | 4a | 3b |
| 4c | Secret scanner + byte/token caps on write | 4b | 3c |
| 4d | Injection into system prompt behind budget | 4c, 1b | 3d |
| 5a | Skills substrate (store + codec + caps + guards) | 2a | 3b, 3c, 3d, 4b, 4c, 4d |
| 5b | Skill router + injection + scoped tool allowlist | 5a, 4d | 6a, 6b, 6c |
| 6a | WebFetch + domain policy substrate (`PermissionRule.domain`, `Tool.getDomain`) | 3d, 2b | 5b |
| 6b | WebSearch + `/web` slash command + settings-file seeding of domain rules | 6a | 5b |
| 6c | CodeSandbox tool (ephemeral Python/JS, no shell/FS access) | 3d, 2b | 6a, 6b |
| 7a | Forked context + scoped tool pool primitive | 3d, 6a–c | — |
| 7b | Parallel fan-out for read-only subagents | 7a | — |
| 7c | Nested audit correlation (parent ↔ subagent) | 7a, 2a | 7b |
| 8a | Per-turn → session → boundary hierarchical summarizer | 1a | 5–7 |
| 8b | Selective tool-result trimming | 8a, 2a | 6a–c |
| 8c | Budget-aware attachment injector substrate | 8a, 1a | 7a–c |
| 9 | First-class attachments (image / PDF / notebook) | 8c, 3d | — |
| Pa | Shell AST parser (pipes, subshells, redirections, cmd-subst) | 2a | 1–8 |
| Pb | Per-node read/write classification + FS-safety integration | Pa | 1–8 |
| Pc | Dangerous-pattern pre-permission blocklist | Pb | 1–8 |

Rationale: pave substrate (1a, 2a) before anything reads from it; land registry + permissions (3a, 2b) before new tools (6); defer subagents (7) until the tool pool and audit are ready; land hierarchical compaction + injector substrate (8) before attachments (9) so the eviction surface exists when its main consumer arrives; AST Bash (P) runs off the critical path once audit exists.

---

# Pillar 1 — Inference & Runtime Substrate

Split into three: the **types/data** contract (1a), the **prompt-cache** surface (1b), and the **thinking-budget** runtime knob (1c). Everything downstream reads from 1a; 1b and 1c are independent features on top of it.

## Phase 1a — Capability metadata on `ModelEntry`

**Objective.** Make provider capabilities first-class *data* so the rest of the codebase reads capabilities, never provider identity.

**Source references.** `src/core/providers/types.ts` (existing `ModelEntry`, `ProviderAdapter`), `src/core/providers/registry.ts`, per-adapter catalogs.

**Tasks.**
1. Add fields to `ModelEntry`: `maxContextTokens: number`, `maxOutputTokens: number`, `supportsThinking: boolean`, `supportsInterleavedThinking: boolean`, `promptCacheModel: "explicit" | "implicit" | "none"`.
2. Extract catalog defaults to a new `src/core/providers/capabilityMetadata.ts` so each adapter imports shared constants instead of restating them.
3. Populate all three existing adapters' catalogs: Anthropic (Opus 4.7 @ 1M, Sonnet 4.6, Haiku 4.5), OpenAI (GPT-class + `o*` reasoning), MiniMax.
4. Add a `resolveCapabilities(modelId)` helper that returns the full capability sheet — downstream code imports this, not the adapter.
5. Register Opus 4.7 (1M) as default; Sonnet 4.6 as fast fallback.

**Deliverables.**
- Modified: `src/core/providers/types.ts`, `anthropicAdapter.ts`, `openaiAdapter.ts`, `minimaxAdapter.ts`, `registry.ts`
- New: `src/core/providers/capabilityMetadata.ts`
- New: `docs/phase1a-v2-design.md`

**Verification.**
- Every entry in `allModels()` has all 5 new fields populated (typecheck + runtime assertion).
- No non-provider file contains a `providerId === "..."` branch that reads capability info.
- Adding a hypothetical provider stays one adapter file + one line in `ADAPTERS`.

**Does NOT do.** Anything runtime (no thinking, no cache hints, no budget policy).

## Phase 1b — Structured system-prompt parts + cache-hint annotations

**Objective.** Turn the system prompt from a flat string into ordered **parts** with generic `cacheHint` annotations each adapter translates natively. Keep the v1 dynamic-boundary cut point.

**Source references.** v1 system-prompt assembly, each adapter's request builder.

**Tasks.**
1. Define `SystemPromptPart = { content: string; cacheHint?: "static" | "volatile" }` and replace the flat system prompt with `SystemPromptPart[]`.
2. New module `src/context/cacheHints.ts`: builds the parts list from (a) the static Ultron preamble, (b) project/CLAUDE.md content, (c) memory/skills (later phases inject here), (d) the dynamic tail.
3. Adapter translations:
   - Anthropic: emit `cache_control: {type: "ephemeral"}` on the last `static` part, respecting provider cache-breakpoint rules.
   - OpenAI: concatenate parts in a stable order (implicit prefix caching); no explicit hint.
   - MiniMax: concatenate (ignore hints).
4. Preserve the v1 dynamic boundary — the transition from `static` → `volatile` is the single cut point.

**Deliverables.**
- New: `src/context/cacheHints.ts`, `src/context/systemPromptParts.ts`
- Modified: `anthropicAdapter.ts` (add `cache_control`), `openaiAdapter.ts` (stable ordering), `minimaxAdapter.ts` (no-op)
- Modified: system-prompt assembly call site in `src/core/query.ts` (or wherever it lives today)
- New: `docs/phase1b-v2-design.md`

**Verification.**
- Recorded Anthropic request shows `cache_control` on the last static part.
- Two consecutive Anthropic calls with identical static parts show a cache read on the second (integration test against the live API, opt-in).
- OpenAI + MiniMax requests remain byte-identical to pre-change for the same input (no regression).

**Does NOT do.** Hierarchical compaction (8a). Memory/skills injection (4d, 5b) — just leaves a hook.

## Phase 1c — Thinking/reasoning budget as a generic runtime knob

**Objective.** Add a single provider-agnostic `thinkingBudget` option; adapters translate to native shape.

**Source references.** `src/core/queryDeps.ts` (`CallModelOptions`), each adapter.

**Tasks.**
1. Extend `CallModelOptions` with `thinkingBudget?: number` (tokens) and `interleavedThinking?: boolean`.
2. Anthropic adapter: translate to `thinking: {type: "enabled", budget_tokens: N}`; set `interleaved-thinking` beta header when `interleavedThinking && capability`.
3. OpenAI adapter: translate N to `reasoning_effort: "low"|"medium"|"high"` via a bucketed mapping for `o*` models; no-op for non-reasoning models (log-once warning if user sets it).
4. MiniMax adapter: no-op; ignore.
5. Surface per-turn default in app config (e.g., `thinkingBudget: 4096` for Opus 4.7). `/thinking` style CLI toggle is **out of scope for 1c** (belongs to UX later).
6. Honor `supportsThinking` / `supportsInterleavedThinking` from 1a — ignore the knob with a warning if the model can't do it.

**Deliverables.**
- Modified: `src/core/queryDeps.ts`, `src/core/query.ts` (thread the option), `anthropicAdapter.ts`, `openaiAdapter.ts`, `minimaxAdapter.ts`
- New: `docs/phase1c-v2-design.md`

**Verification.**
- Anthropic Opus 4.7 call with `thinkingBudget: 4096` includes the thinking block in request and `thinking_delta` events in the stream.
- OpenAI `o4-mini` call with the same option carries `reasoning_effort: "medium"`.
- MiniMax call is unchanged.
- Setting the option on a non-thinking model produces one warning and no request change.

**Does NOT do.** Interleaved thinking UX (display of thinking between tools — handled in event rendering later). Model-specific tuning UI.

---

# Pillar 2 — Hooks & Audit Spine

Split into two: **audit event stream + sink** (2a, substrate) and **user-configurable hooks** (2b, feature on top).

## Phase 2a — Unified typed event stream + audit log sink

**Objective.** One typed event stream covering permission decisions, tool lifecycle, compaction boundaries, and (later) subagents; write every event to a rotating on-disk audit log.

**Source references.** `src/core/queryEvents.ts`, `src/core/permissions/*`.

**Tasks.**
1. Extend the `QueryEvent` union with `permission_decision`, `compaction_boundary`, `audit_warning` variants alongside existing tool events.
2. Give every tool call a `correlationId` (UUID) so `tool_use_start`, `permission_decision`, `tool_result` share it.
3. New sink: `src/audit/auditLog.ts` — append-only JSONL to `~/.ultron/audit/YYYY-MM-DD.log`, rotated by day and by size (e.g., 10 MB).
4. Wire the sink to receive every event (not just tool events); the query generator still yields the same events to callers.
5. Redact secret-scanner-flagged content before writing.

**Deliverables.**
- Modified: `src/core/queryEvents.ts`, `src/core/query.ts`, `src/core/permissions/*`
- New: `src/audit/auditLog.ts`, `src/audit/redaction.ts`
- New: `docs/phase2a-v2-design.md`

**Verification.**
- Unit: a single tool call produces `tool_use_start` + `permission_decision` + `tool_result` with matching `correlationId`.
- Unit: an audit entry containing a fake API key is redacted before it hits disk.
- Manual: a session produces a JSONL file that a `jq` one-liner can parse cleanly.

**Does NOT do.** User-configured hook commands (2b). Remote log shipping. UI over the log.

## Phase 2b — Pre/post tool hooks (user-configurable)

**Objective.** Let users register shell commands that inspect or block tool calls (pre-tool) or observe them (post-tool).

**Source references.** 2a event stream; v1 tool-execution boundary.

**Tasks.**
1. Config surface: `~/.ultron/hooks.json` with entries `{ matcher: string|regex, stage: "pre"|"post", command: string, args?: string[], env?: {}, timeout: number, blockOnFail: boolean }`.
2. Loader + validator (`src/hooks/config.ts`).
3. Hook runner (`src/core/hooks.ts`):
   - Pre-hooks: run sequentially in matcher order; exit code 0 = allow; non-zero = block (surface as standard `tool_result` error, no special path); stdout may carry a rewritten input JSON.
   - Post-hooks: fire-and-forget with a timeout; failures emit an audit warning, never block.
4. Hooks get a minimal payload on stdin: `{ tool, input, correlationId }`.
5. Guard: hook failures don't crash the loop; timeouts kill the subprocess.

**Deliverables.**
- New: `src/core/hooks.ts`, `src/hooks/config.ts`
- Modified: tool-execution boundary to call pre/post hooks
- New: `docs/phase2b-v2-design.md`

**Verification.**
- A pre-hook exiting non-zero blocks the tool and produces a standard error `tool_result`.
- A pre-hook rewriting input on stdout changes what the tool sees (demonstrable with Bash tool + echo hook).
- A post-hook timing out emits one audit warning; the tool's result still reaches the model.
- Removing `~/.ultron/hooks.json` is equivalent to no hooks configured (no crash).

**Does NOT do.** Non-shell hooks (JS modules). Hook-to-hook communication. Scheduling.

---

# Pillar 3 — MCP-Capable Dynamic Tool Registry

Split into four: **metadata/seam** (3a), **client** (3b), **config/lifecycle** (3c), **permissions/audit integration** (3d).

## Phase 3a — Tool metadata: `source` + `namespace` + dynamic registration seam

**Objective.** Promote tool provenance to first-class metadata so MCP-sourced tools are indistinguishable from built-ins downstream.

**Tasks.**
1. Extend `ToolDefinition` with `source: "builtin" | "mcp" | "custom"` and `namespace?: string`.
2. Standardize on `mcp__<server>__<tool>` naming for MCP tools.
3. Ensure the registry's dynamic-registration path (already present) handles a late-arriving batch (MCP servers connect lazily).
4. `/tools` listing groups by namespace.

**Deliverables.**
- Modified: `src/core/tools/types.ts`, `src/core/tools/registry.ts`, `src/core/tools/context.ts`
- New: `docs/phase3a-v2-design.md`

**Verification.**
- A synthetic "late-registered" tool appears in the registry after startup, flows through permissions, and executes normally.
- Built-in tools have `source: "builtin"`, namespace `undefined`.
- Duplicate-name registration across namespaces is allowed; duplicate within a namespace errors clearly.

**Does NOT do.** Any MCP protocol work (3b). Permission integration (3d).

## Phase 3b — MCP stdio client

**Objective.** A JSON-RPC client over stdio that speaks the subset of MCP Ultron needs in v2.

**Tasks.**
1. Stdio transport: spawn server via `command` + `args` + `env`; newline-delimited JSON-RPC.
2. Protocol: `initialize` handshake with capability negotiation, `tools/list`, `tools/call`. Resources and prompts **deferred to v2.x**.
3. Request/response correlation with ids; stream-safe framing.
4. Error surface: transport errors, protocol errors, tool-call errors — each distinct and typed.

**Deliverables.**
- New: `src/mcp/client.ts`, `src/mcp/protocol.ts`, `src/mcp/transportStdio.ts`
- New: `docs/phase3b-v2-design.md`

**Verification.**
- Connects to the reference `@modelcontextprotocol/server-filesystem` and lists tools successfully.
- `tools/call` round-trips result + errors.
- Server process dying mid-call surfaces a typed transport error (not a hang).

**Does NOT do.** HTTP/SSE transport. Resources or prompts. Server role (Ultron never publishes).

## Phase 3c — Config surface + lifecycle

**Objective.** User-editable `~/.ultron/mcp.json`; lazy connect, reconnect with backoff, clean shutdown.

**Tasks.**
1. Config schema: `{ servers: { [name]: { command, args, env, disabled?, timeout? } } }`.
2. Lazy connect: first call to any `mcp__<server>__*` tool triggers `initialize` + `tools/list`; subsequent calls reuse the connection.
3. Reconnect with exponential backoff on unexpected disconnect; cap attempts per session.
4. Shutdown: on Ultron exit, send any graceful-close signal and kill after a grace period.
5. `/mcp status` CLI subcommand (or equivalent) shows per-server state.

**Deliverables.**
- New: `src/mcp/config.ts`, `src/mcp/lifecycle.ts`, `src/mcp/registry.ts`
- Modified: Ultron shutdown path
- New: `docs/phase3c-v2-design.md`

**Verification.**
- A disabled server is not spawned.
- Killing a server mid-session, then invoking a tool, reconnects successfully.
- Ultron exit kills all MCP subprocesses (no orphans).

**Does NOT do.** Server health UI beyond a status list. Auto-install of MCP servers.

## Phase 3d — MCP permission + audit integration

**Objective.** Every MCP tool call flows through the v1 permission engine and the 2a event stream. No bypass.

**Tasks.**
1. Permission keys: match on `mcp__<server>__<tool>`; allow wildcards `mcp__github__*`.
2. Default deny for all MCP tools; user must add an allow rule (tighter than built-ins on purpose).
3. Audit: MCP tool calls emit the same correlation chain as built-ins + a `source: "mcp"` tag.
4. Document tighter defaults for future remote transports (v2.x) — they ship denied-by-default.

**Deliverables.**
- Modified: permission engine, permission config surface
- Modified: tool-execution boundary (attach `source` to audit events)
- New: `docs/phase3d-v2-design.md`

**Verification.**
- A first-time MCP tool call is denied with a prompt to add an allow rule.
- Wildcard rule `mcp__github__*` allows all GitHub-server tools.
- Audit entries for MCP calls include `source: "mcp"` + server name.

**Does NOT do.** Prompt-level UX for remembering MCP allows. Remote-transport rules (that's v2.x).

---

# Pillar 4 — Memory MVP

Split into four: **schema/layout** (4a), **store + index** (4b), **guards** (4c), **injection** (4d).

## Phase 4a — Typed entry schema + on-disk layout

**Objective.** Define the memory entry format and where it lives on disk. No I/O yet beyond parsing.

**Tasks.**
1. Frontmatter schema: `{ name, description, type: "user"|"feedback"|"project"|"reference" }` + Markdown body.
2. Disk layout: `~/.ultron/memory/<type>_<slug>.md`; `MEMORY.md` at the directory root (index).
3. Parser + type guards; error messages point at the bad file.

**Deliverables.**
- New: `src/memory/memoryTypes.ts`, `src/memory/parser.ts`
- New: `docs/phase4a-v2-design.md`

**Verification.**
- Round-trip parse/serialize is stable.
- Malformed frontmatter yields a clear error naming the file.

**Does NOT do.** Any filesystem I/O beyond reading test fixtures. Injection.

## Phase 4b — Store + `MEMORY.md` index generation

**Objective.** Read/write the memory directory and regenerate the index.

**Tasks.**
1. `MemoryStore` with `list()`, `read(name)`, `write(entry)`, `remove(name)`.
2. Regenerate `MEMORY.md` on every mutation: one line per entry, `- [Title](file.md) — description`.
3. Cap `MEMORY.md` to ~200 lines; truncate tail with a warning comment in the file.

**Deliverables.**
- New: `src/memory/memoryStore.ts`, `src/memory/index.ts`
- New: `docs/phase4b-v2-design.md`

**Verification.**
- Writing then removing an entry leaves the directory and `MEMORY.md` identical to start.
- Over-cap index is truncated deterministically (stable order by name).

**Does NOT do.** Guards (4c). Injection (4d).

## Phase 4c — Secret scanner + byte/token caps

**Objective.** Gate writes. No secret leaks into memory; no unbounded growth.

**Tasks.**
1. Integrate the v1 secret scanner on every `write()`; reject with a clear error on match.
2. Per-entry byte cap (e.g., 16 KB) and approximate-token cap (e.g., 4k).
3. Whole-store cap (e.g., 256 KB / 64k tokens); on overflow, reject the write and tell the user to prune.

**Deliverables.**
- Modified: `src/memory/memoryStore.ts`
- New: `docs/phase4c-v2-design.md`

**Verification.**
- A secret-bearing write is rejected before disk touch.
- Exceeding the per-entry cap rejects with a byte count in the error.
- Total-store overflow rejects with a helpful message ("prune N KB to fit").

**Does NOT do.** Auto-compaction of memory (that's v2.x auto-authoring). Cross-session sync.

## Phase 4d — Injection into system prompt behind budget

**Objective.** Put `MEMORY.md` (or a filtered subset) into the system prompt through the 1b parts pipeline, respecting a token budget.

**Tasks.**
1. New system-prompt part "memory", placed before the dynamic tail, marked `cacheHint: "static"` when stable.
2. Budget: a configurable fraction of `maxContextTokens - headroom` (from 1a); pick entries by type priority (user > feedback > project > reference) and recency.
3. On-demand filter: only inject entries whose `description` passes a simple relevance predicate (start with naive "always inject all within budget"; smarter selection is v2.x).

**Deliverables.**
- Modified: `src/context/systemPromptParts.ts` (new part type)
- New: `src/memory/injection.ts`
- New: `docs/phase4d-v2-design.md`

**Verification.**
- Memory appears in the assembled system prompt at the configured position.
- Over-budget memory is truncated at entry boundaries, never mid-entry.
- Disabling memory via config produces a system prompt byte-identical to pre-4d for the same input.

**Does NOT do.** Auto-memory authoring by the model. Per-session memory.

---

# Pillar 5 — Skills

Split into two: **substrate + loader** (5a) and **router + injection + scoped tool allowlist** (5b). Skills are user-authored (not written by the model), so Pillar 5 does NOT need the 4-phase decomposition Memory used — there's no model-facing CRUD surface, and injection is tied to activation rather than being always-on. 5a lands the store and parser; 5b turns an activated skill into an `'org'`-bucket system-prompt part and narrows the tool set for the duration.

## Phase 5a — Skills substrate (store + codec + caps + guards)

**Objective.** On-disk format, typed store, codec, caps, secret-write gate, directory-permission guard, and audit events for user-authored skill bundles. Substrate only — no activation, no injection, no permission narrowing, no slash surface.

**Source references.** Codec pattern from `src/memory/entry.ts`; store pattern from `src/memory/store.ts`; dir-perm guard at `src/memory/localMemoryGuard.ts`; audit seam at `src/audit/auditLog.ts`. On-disk convention from OpenAI Codex Skills (`developers.openai.com/codex/skills`) and Claude Code Skills (`code.claude.com/docs/en/skills`).

**Tasks.**
1. On-disk layout: `<baseDir>/skills/<id>/SKILL.md` — **directory-per-skill**, matching Codex/Claude Code convention. Sibling dirs (`assets/`, `scripts/`, `references/`, `agents/`) preserved but untouched by 5a. Derived index at `<baseDir>/skills/SKILLS.md` with `- [name](<id>/SKILL.md) — description` lines sorted by name.
2. Frontmatter — kebab-case on disk, camelCase internally. Required: `name`, `description`. Optional: `allowed-tools: [...]`, `argument-hint: "..."`, `schemaVersion`, `createdAt`, `updatedAt`. Missing timestamps fall back to `fs.stat().birthtimeMs` / `mtimeMs` so hand-authored skills parse. Ultron-managed writes always emit the full frontmatter.
3. Codec in `src/skills/skill.ts`: `parseSkillFile(id, raw, stat?)`, `serializeSkill`, `validateId`, plus `quoteScalar`/`unquoteScalar`/`canRoundTrip`/`parseStringArray` helpers copied from `memory/entry.ts` (shared-lib dedup deferred until both stores stable).
4. Store in `src/skills/store.ts`: `initSkillsDir`, `readSkill`, `listSkills`, `readIndex`, `writeSkill`, `deleteSkill`, `rebuildIndex`. Atomic writes (tmp + fsync + rename + parent-dir fsync), per-`baseDir` mutation queue (**separate** `Map` instance from memory's — no cross-blocking). Directory-aware write (mkdir `<id>/` at 0o700 before atomic SKILL.md write); directory-aware delete (unlink `SKILL.md`, `rmdir(<id>/)` iff empty-ish, else leave sibling assets).
5. Caps: `MAX_SKILL_BYTES = 64 KB`, `MAX_TOTAL_SKILL_BYTES = 4 MB`, `MAX_SKILL_COUNT = 128`. Enforced on `writeSkill`; counts `SKILL.md` bytes only (sibling assets unmetered in 5a).
6. Write gate: `detectSecrets` runs on every serialized `SKILL.md`; any match (high or low confidence) rejects in 5a. 5b loosens to ask-on-low-confidence once the activation surface exists. `allowed-tools` field is shape-validated (non-empty strings ≤128 chars, no newlines) but never enforced as policy in 5a.
7. Extend `enforceBaseDirectoryPermissions` in `src/memory/localMemoryGuard.ts` to chmod `<baseDir>/skills/` at 0o700; refresh docstring to reflect broadened scope (sessions + memory + skills).
8. Audit events: `skill_written { id, name, bytes, hasAllowedTools, isNew, timestamp }` and `skill_deleted { id, name, timestamp }`. Metadata only — no body, description, argument-hint, or allowed-tools list on the events. Added to `SHOULD_AUDIT`; `redactSecrets` runs at the audit boundary as defense in depth.

**Deliverables.**
- New: `src/skills/skill.ts`, `src/skills/store.ts`
- Modified: `src/memory/localMemoryGuard.ts` (+1 dir entry, docstring refresh)
- Modified: `src/core/queryEvents.ts` (+`SkillWrittenEvent`, `SkillDeletedEvent`, union)
- Modified: `src/core/queryEventFactories.ts` (+`makeSkillWrittenEvent`, `makeSkillDeletedEvent`)
- Modified: `src/audit/auditLog.ts` (+2 `SHOULD_AUDIT` entries)
- New: `src/skills/skill.test.ts`, `src/skills/store.test.ts`
- New: `tests/integration/skill-store.test.ts`
- New: `docs/phase5a-v2-design.md`

**Verification.**
- `serializeSkill` / `parseSkillFile` round-trip is byte-stable for the full matrix (required-only, with `allowed-tools: []` vs `undefined`, with `argument-hint`).
- Hand-authored `SKILL.md` with only `name` + `description` parses cleanly; timestamps fall back to file mtime; `schemaVersion` defaults to 1.
- `writeSkill` + `readSkill` round-trip preserves hand-placed `assets/` and `scripts/` subdirectories inside `<id>/`.
- Cap rejections surface typed errors (`SkillTooLargeError`, `SkillsFullError`, `TooManySkillsError`) with byte/count fields.
- Secret-bearing body rejects before disk touch; low-confidence-only matches also reject unless `allowLowConfidenceSecrets` is set (5b uses this).
- Post-`enforceBaseDirectoryPermissions`, `~/.ultron/skills/` is 0o700; post-`writeSkill`, `<id>/` is 0o700 and `SKILL.md` is 0o600 (perm assertions gated off on Windows).
- `listSkills` warns once per loose `.md` at the `skills/` root and silently skips `<id>/` dirs without a `SKILL.md` (user mid-authoring).
- `deleteSkill` with sibling `assets/` unlinks `SKILL.md` and leaves the directory; with no siblings, rmdir cleans it up.
- All Phase 4 (4a–4d) tests stay green — memory and skill mutation queues are proven independent.

**Does NOT do.** Activation, body injection into the system prompt, `allowed-tools` enforcement, `/skill` slash command (all 5b). Multi-file asset read/write (future). Project-local `.ultron/skills/` discovery. Skill templates / scaffolding. Remote skill fetch.

## Phase 5b — Skill router + injection + scoped tool allowlist

**Objective.** Activating a skill injects its body into the system prompt as an `'org'`-bucket part and narrows the available tool set for the duration.

**Source references.** 5a store; 4d injection seam at `src/context/cacheHints.ts`; permission engine at `src/core/permissions/permissions.ts`; memory slash dispatch pattern at `src/cli/memoryCommand.ts`.

**Tasks.**
1. `/skill` slash command (`src/cli/skillsCommand.ts`) — subcommands: `list`, `show <id>`, `<id> [args]` (activate), `deactivate`, `help`. Mirrors `/memory` dispatch (`src/cli/memoryCommand.ts`).
2. Activation state on `QueryEngine`: `activeSkillId: string | null` + `remainingTurns: number`. Default 1 turn; configurable `--turns N` on activate.
3. Secret re-scan on activation: call `detectSecrets` on the resolved SKILL.md body before injection. Hand-authored files bypass 5a's write gate, so activation is the second checkpoint — any match refuses activation and emits a deny-audit event.
4. Inject the activated skill's body at the existing `src/context/cacheHints.ts` seam as a single `cacheHint: 'org'` part, positioned after the memory injection block. Update the seam comment to note skills occupy this slot during active turns.
5. `allowed-tools` enforcement: when a skill is active, intersect the tool list passed to `callModel` with `skill.allowedTools` before send. At the permission boundary, attempts to call a tool outside the active allowlist deny with reason `"tool not in active skill's allowed-tools"`. Permission cascade still wins — a user's explicit deny rule can't be overridden by a skill's allow.
6. `skill_activated { id, name, turns, hasAllowedTools }` + `skill_deactivated { id, name, reason: 'turns_exhausted' | 'user_deactivated' | 'error' | 'secret_refused' }`. Added to `SHOULD_AUDIT`.
7. Deactivation paths: `remainingTurns` hits 0, explicit `/skill deactivate`, secret refusal on activation, or an error during the active turn.
8. `writeSkill` callers (tests / future tooling) pass `allowLowConfidenceSecrets: true` now that an askUser path exists — mirrors the 4a → 4b loosening.

**Deliverables.**
- New: `src/cli/skillsCommand.ts`, `src/skills/router.ts`, `src/context/skillInjection.ts`
- Modified: `src/sdk/QueryEngine.ts` (activation state; wire into `buildFullSystemPromptParts` + the tool set passed to `callModel`)
- Modified: `src/context/cacheHints.ts` (skill-injection branch; seam comment)
- Modified: `src/core/tools/runToolUse.ts` or `src/core/permissions/permissions.ts` (allowed-tools intersection at the boundary)
- Modified: `src/core/queryEvents.ts`, `src/core/queryEventFactories.ts`, `src/audit/auditLog.ts` (+2 events)
- Modified: `src/cli.ts` startup banner (+`/skill`)
- New: `docs/phase5b-v2-design.md`

**Verification.**
- Skill declaring `allowed-tools: ["FileRead"]` cannot invoke `FileWrite` during active turns, even under a global allow.
- Activated skill's body appears in the assembled system prompt on active turns; absent after deactivation.
- Skill whose SKILL.md body triggers `detectSecrets` refuses activation; audit shows `skill_deactivated { reason: 'secret_refused' }`.
- `/skill list` output matches `listSkills()` ordering; `/skill show <id>` prints the serialized SKILL.md byte-for-byte.
- An active skill cannot override an explicit user deny rule at the permission cascade (skill allow ≠ user allow).
- Two consecutive Anthropic calls during a single skill activation show a cache read on the `'org'`-bucket part (the skill body is stable across turns within the activation window).

**Does NOT do.** Skills-as-code (JS modules). Skill composition (one skill activating another). Remote skill fetch. Editor-spawn `/skill new` / `/skill edit` — users author skills in their editor outside Ultron.

---

# Pillar 6 — New First-Party Tools

Split per tool, with the web pillar itself further split: **WebFetch + domain policy substrate** (6a), **WebSearch + slash + settings seeding** (6b), **CodeSandbox** (6c). First-class attachments are deliberately deferred to Pillar 9 so the budget-aware injector substrate (8c) lands first and Pillar 9 can plug in without retrofitting eviction. 6a paves the per-host policy seam with one consumer (WebFetch); 6b adds the second consumer (WebSearch) and the imperative + persistent surfaces. Each phase needs 3d + 2b in place.

## Phase 6a — WebFetch + domain policy substrate

**Status.** Shipped. See [`docs/phase6a-v2-design.md`](docs/phase6a-v2-design.md).

**Objective.** Pave the per-host policy seam by extending the cascade with a `domain` rule scope, adding `Tool.getDomain` (parallel to `getPath`), and shipping `WebFetchTool` as the first concrete consumer.

**Tasks.**
1. `PermissionRule.domain?: string` (exact host or `*.suffix`); `findMatchingRules` threads `toolHost` and is exported so the fetcher's redirect re-check reuses cascade rule semantics.
2. `Tool.getDomain?(input) → string | undefined`; `buildTool` propagates.
3. `runToolUse.ts::buildAllowByRule` threads `tool.getDomain` into `ruleCreated` with a defensive escape (refuses over-broad rules for domain-bearing tools whose `getDomain` returned nothing).
4. `src/web/` substrate: `domainPolicy.ts` (`extractHost`, `matchDomain`, `isValidDomainPattern`), `htmlToText.ts` (entity decode + tag strip), `fetcher.ts` (HTTPS-only `fetchWeb` with IP-class block, redirect-hop policy re-check, 5 MB cap, 30 s timeout, DI hooks for `lookup` / `httpsAgent` / `isPrivateAddress`, raced DNS lookup).
5. `src/tools/WebFetchTool.ts`: `{url}` schema; HTTPS-only validation; closure mirrors cascade order (`deny > ask > allow > fallback ask`); registered between `BashTool` and `AgentTool` in `createDefaultRegistry`.

**Deliverables.** `src/web/{domainPolicy,htmlToText,fetcher}.ts` + tests, `src/tools/WebFetchTool.ts` + tests, modified `src/core/permissions/{types,permissions}.ts`, `src/core/tools/{types,runToolUse,registry}.ts`, `tests/integration/webFetch.test.ts`, `docs/phase6a-v2-design.md`.

**Verification.** First WebFetch call asks; `allow_by_rule` persists a domain-scoped session rule; second call to same host doesn't prompt. `allow_once` and `bypassPermissions` both authorize without persisting a rule and the tool still executes (regression caught in review). Skill activation with `allowedTools: ['WebFetch']` works; without it the cascade denies at `skillScope`. Cross-host redirect to a denied host throws `WebFetchPolicyRedirectError`. SSRF block rejects loopback/private/link-local/IPv4-mapped IPv6.

**Does NOT do.** WebSearch (6b). `/web` slash command (6b). Settings-file seeding of initial domain rules (6b). Defense against PreToolUse hook URL rewrites (deferred to a future cross-tool re-auth-on-mutation phase). HTML→markdown via `turndown` (6c attachment phase). Cookies / authenticated fetch / non-GET methods.

## Phase 6b — WebSearch + `/web` slash + settings-file seeding

**Objective.** Add the second consumer of the 6a domain-policy seam (WebSearch), the imperative rule-management surface (`/web` slash command), and boot-time persistence (`~/.ultron/settings.json` → seeded `permissionRules`).

**Tasks.**
1. `WebSearchTool`: calls a configured search backend behind a provider abstraction (no hardcoded vendor). Search-backend choice (Brave / Tavily / Bing / DuckDuckGo / etc.) and API-key config land in this phase's design doc.
2. WebSearch participates in the same cascade: `getDomain` returns the result-host being inspected (or undefined when the tool emits a list of result links, in which case rule scope is per-result evaluated downstream).
3. `/web` slash command in `src/cli/webCommand.ts`: `list`, `allow <host>`, `deny <host>`, `remove <host>`, `rules`. Mutations write through `appState.setState({ permissionRules: [...] })` so they share the same persistence path as `allow_by_rule`.
4. `~/.ultron/settings.json` loader: at engine init, parse a `webPolicy: { allowlist: string[]; denylist: string[] }` block (each entry validated via `isValidDomainPattern`) and seed `permissionRules` with the corresponding `domain`-scoped rules. Same loader surface that future phases can extend (e.g. file-path allow-lists).
5. `WriteSkillOptions.allowLowConfidenceSecrets`-style ergonomics: `/web` rules persist to `settings.json` when the user opts in (`/web allow github.com --persist`); without `--persist`, the rule lives in the session only.

**Deliverables.** `src/tools/WebSearchTool.ts` + tests, `src/cli/webCommand.ts` + tests, `src/cli/settingsFile.ts` (loader/writer for `~/.ultron/settings.json`) + tests, `src/sdk/QueryEngine.ts` (init-time settings load), `tests/integration/web-slash.test.ts`, `docs/phase6b-v2-design.md`.

**Verification.** WebSearch returns results subject to the same per-host policy as WebFetch (denying `evil.com` blocks any result whose host matches). `/web allow github.com` adds a session rule; `--persist` also writes to `settings.json`. Restarting Ultron reloads the persisted rules without prompting. URL canonicalization (`@`-tricks, unicode lookalikes, percent-decode) tests live here, since they apply equally to WebFetch and WebSearch result inspection.

**Does NOT do.** Browser automation. Authenticated fetch (still — anonymous only). Multiple search providers active simultaneously (one configured backend at a time).

## Phase 6c — CodeSandbox

**Tasks.**
1. Ephemeral Python + JS execution via a sandbox runtime (e.g., `node --experimental-permission` for JS, `micromamba`/`pyodide` subprocess for Python — pick one in design doc).
2. No access to user shell, `~/`, or repo working directory.
3. Per-call CPU + wall-clock + memory limits; hard kill on overrun.
4. Output capped (e.g., 64 KB); overflow elided with audit event.

**Deliverables.** `src/tools/CodeSandboxTool.ts`, `src/sandbox/runtime.ts`, `docs/phase6c-v2-design.md`.

**Verification.** A script attempting to read `~/.ssh/id_rsa` fails. A `while(true)` script is killed at the wall-clock limit. Memory-bomb script is killed before OOM.

**Does NOT do.** Persistent sandboxes. Package installs from arbitrary sources.

---

# Pillar 7 — Subagents via Agent SDK

Split into three: **primitive** (7a), **fan-out** (7b), **audit correlation** (7c).

## Phase 7a — Forked context + scoped tool pool

**Tasks.**
1. Real implementation replacing the v1 Phase 13 stub.
2. Subagent gets: forked message list, a **subset** of parent's tools (never a superset), the same permission engine instance.
3. Separate transcript; result returned to parent as a tool result.

**Deliverables.** Modified `src/agents/runAgent.ts`, new `src/agents/sandboxContext.ts`, `docs/phase7a-v2-design.md`.

**Verification.** Subagent calling a tool outside its scoped pool is denied at the permission layer. Parent transcript is unmodified during subagent execution.

**Does NOT do.** Fan-out (7b). Audit correlation (7c).

## Phase 7b — Parallel fan-out for read-only subagents

**Tasks.**
1. Read-only subagents (no write-capable tools in their pool) may run in parallel.
2. Any subagent with a write-capable tool falls back to serial.
3. Results return in a deterministic order (by request index, not completion order).

**Deliverables.** New `src/agents/parallelFanOut.ts`, `docs/phase7b-v2-design.md`.

**Verification.** N read-only subagents complete in `max(times) + overhead`, not `sum(times)`. A mixed read-only + write batch runs serially.

**Does NOT do.** Subagent-to-subagent communication.

## Phase 7c — Nested audit correlation

**Tasks.**
1. Every subagent event carries `parentCorrelationId` + its own `correlationId`.
2. Audit log reconstruction can rebuild the tree deterministically.

**Deliverables.** Modified audit schema, `docs/phase7c-v2-design.md`.

**Verification.** A recorded session with nested subagents can be rendered as a tree by a test fixture.

**Does NOT do.** Real-time UI of the tree.

---

# Pillar 8 — Hierarchical Compaction & Budget-Aware Attachment Injector

Split into three: **hierarchical summarizer** (8a), **selective tool-result trimming** (8b), **attachment injector** (8c).

## Phase 8a — Hierarchical summarizer

**Tasks.**
1. Per-turn summary (short; cache-friendly) rolled up into session summary at a configurable cadence.
2. Compact-boundary uses the session summary + recent raw turns; preserves the v1 invariant (every `tool_use` has its `tool_result`).
3. Summaries carry `cacheHint: "static"` once written.

**Deliverables.** Modified `src/context/compact.ts`, new `src/context/compactionStrategy.ts`, `docs/phase8a-v2-design.md`.

**Verification.** Compaction never breaks tool pairing (property test). Session that would exceed `maxContextTokens - headroom` (from 1a) triggers compaction.

**Does NOT do.** Cross-session memory (that's pillar 4).

## Phase 8b — Selective tool-result trimming

**Tasks.**
1. Oversized tool result trimmed to head + tail with a visible elision marker.
2. Trimming is auditable (emits an event with original size).
3. Thresholds per tool type (e.g., `Read` vs `Bash` differ).

**Deliverables.** Modified tool-result path, `docs/phase8b-v2-design.md`.

**Verification.** Trim is visible in transcript (no silent truncation). Audit carries original byte count.

**Does NOT do.** Summarizing the elided middle (that's a future optimization).

## Phase 8c — Budget-aware attachment injector substrate

**Objective.** Land the injector + eviction policy as a substrate ahead of its main consumer. Pillar 9 (attachments) plugs in as the first concrete payload type; the substrate itself is payload-agnostic (any token-priced item with a priority + timestamp fits).

**Tasks.**
1. Budget derived from `maxContextTokens - headroom - current usage` (from 1a, 8a).
2. Eviction order: deterministic by (priority desc, timestamp asc).
3. Evicted items emit an audit event with original size.
4. Payload-agnostic interface (`InjectableItem { tokens, priority, timestamp, payload }`); concrete payload routing for attachments lands in Pillar 9.

**Deliverables.** New `src/context/tokenBudget.ts`, `src/context/injector.ts`, `docs/phase8c-v2-design.md`.

**Verification.** Same input always evicts the same items. Evicted items are auditable. The interface accepts a stub payload type with no attachment knowledge — the pipeline does not import from `src/attachments/`.

**Does NOT do.** Attachment-specific routing (Pillar 9). Item summarization. Partial-item inclusion.

---

# Pillar 9 — First-Class Attachments

Single phase. Deferred from Pillar 6 so the budget-aware injector substrate (8c) lands first and attachments plug in as the first concrete payload type, not the other way around. A text-driven CLI agent loses bounded functionality without 9 (WebFetch refuses non-text content types; users cannot hand the model a screenshot or PDF directly), which is why this sits at the end of the main sequence rather than alongside text-only first-party tools.

## Phase 9 — Image / PDF / notebook attachments

**Source references.** v1 attachment pipeline; 8c injector substrate; per-adapter request builders.

**Tasks.**
1. Extend the v1 attachment pipeline: image (pass-through to provider), PDF (extract text + optional page rasterization), notebook (`.ipynb` — cells + outputs).
2. Size caps per attachment; route through 8c's injector as the eviction layer.
3. Provider adapter routing: Anthropic supports image + PDF natively; OpenAI image only; MiniMax text-only (convert PDF/notebook to text).
4. WebFetch (6a) currently refuses non-text content types — relax that gate for image/PDF responses now that the pipeline can consume them.

**Deliverables.** `src/attachments/pdf.ts`, `src/attachments/notebook.ts`, modified attachment pipeline, modified `src/tools/WebFetchTool.ts` (lift the non-text refusal for image/PDF), `docs/phase9-v2-design.md`.

**Verification.** Round-trip image through Anthropic + OpenAI. PDF attached on MiniMax arrives as extracted text. Notebook attachment preserves cell order. WebFetch on an image URL succeeds and routes through the injector. Over-budget batches evict deterministically per 8c's policy.

**Does NOT do.** OCR of image-only PDFs. Notebook execution. Attachment summarization (would belong in a follow-up to 8b).

---

# Parallel Track P — AST Bash Classification

Depends only on 2a (so it inherits audit coverage); otherwise orthogonal. Split into three: **parser** (Pa), **classifier** (Pb), **blocklist** (Pc).

## Phase Pa — Shell AST parser

**Tasks.**
1. Adopt or wrap an existing POSIX-shell parser (e.g., `mvdan/sh` via bindings, or a JS-native equivalent identified in the design doc).
2. Produce a typed AST covering: simple commands, pipelines, subshells, command substitution, redirections, conditionals, loops.
3. Parse errors route through standard tool error (no crash).

**Deliverables.** `src/bash/astParser.ts`, `docs/phasePa-v2-design.md`.

**Verification.** Parses a corpus of ~50 sample commands (listed in design doc) with expected shapes. Pathological input (`$(cat <<EOF...)` etc.) parses or errors cleanly.

**Does NOT do.** Classification (Pb). Blocking (Pc).

## Phase Pb — Per-node read/write classification + FS-safety integration

**Tasks.**
1. Walk the AST; for each node, classify as read / write / exec / meta; collect affected paths (including globs).
2. Route extracted paths through the v1 filesystem-safety layer; surface violations before the permission prompt.

**Deliverables.** `src/bash/classify.ts`, modified `src/tools/BashTool.ts` + `src/core/permissions/filesystem.ts`, `docs/phasePb-v2-design.md`.

**Verification.** A write inside a subshell or command substitution is classified as a write. A redirection to `/etc/passwd` is flagged before prompting.

**Does NOT do.** Blocklist (Pc).

## Phase Pc — Dangerous-pattern pre-permission blocklist

**Tasks.**
1. Hardcoded patterns: `curl … | sh`, `wget … | sh`, `rm -rf /`, traversal escapes, `dd if=/dev/…`, fork-bomb shape.
2. Matches short-circuit **before** the permission prompt — refuse with a clear error + audit event.
3. Curated list ships in `src/bash/dangerousPatterns.ts`; user can extend via config (no way to *shrink*).

**Deliverables.** `src/bash/dangerousPatterns.ts`, `docs/phasePc-v2-design.md`.

**Verification.** Every pattern in the corpus is blocked without a prompt. User-added pattern participates. Existing v1 bash tests still pass.

**Does NOT do.** Dynamic heuristics or ML-based detection.

---

## Critical path + parallelization

- **Critical path** (longest chain): `1a → 1b → 4d` and `2a → 3a → 3b → 3c → 3d → 6{a,b,c} → 7a → 7b/7c → 8a → 8c → 9`.
- **Cheap parallel wins:** `1a` + `2a` together; `4a–d` alongside `3b–d`; `P*` any time after `2a`.

## Scope gates mirror [`docs/v2-scope.md`](docs/v2-scope.md) §"Explicitly Out of Scope"

No multi-tenant / shared memory across users. No computer-use / desktop automation. No web UI, desktop app, or IDE extension. No Ultron-as-MCP-server. No autonomous / proactive triggers.
