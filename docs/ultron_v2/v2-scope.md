# Ultron v2 Scope

v1 delivered a safe, local, single-user CLI agent loop. v2 brings Ultron up to SOTA (as of early 2026) without abandoning the local-first, single-user posture. v1 docs are archived under [`ultron_v1/`](ultron_v1/).

## Guiding Principles

1. Keep the v1 execution spine: message normalization, permission ordering, tool-execution boundary. Upgrades layer *on top of* that spine, not around it.
2. Prefer first-party model-platform primitives (prompt caching, MCP, memory, Agent SDK patterns, extended thinking / reasoning) over bespoke reimplementations — but expose them through provider-agnostic abstractions so OpenAI, MiniMax, and future adapters stay first-class, not afterthoughts.
3. Every new capability must pass the same permission/audit gates as v1 tools. No privileged bypass for "platform" features.

---

## v2 Pillars

### 1. Model & Inference Upgrades

Ultron stays multi-provider in v2. Anthropic gets the flagship features first because that is where the 1M-context + extended-thinking frontier lives today, but the substrate is designed so OpenAI and MiniMax adapters remain first-class — adding a provider must stay a single adapter file plus one registry line, exactly as in v1.

- Target **Claude Opus 4.7** with the 1M-context profile as the default model; Sonnet 4.6 as the fast-mode fallback. OpenAI and MiniMax models continue to work without regression and participate in every capability below to the extent their API supports it.
- Enable **extended thinking / reasoning** (and, on Anthropic, interleaved thinking between tool calls) with configurable per-turn budgets. Expose it generically so OpenAI reasoning models (`o*` family) and future providers plug into the same runtime knob — adapters translate to `thinking: {...}`, `reasoning_effort`, or whatever native shape the provider uses.
- Adopt **prompt-cache breakpoints** as a generic *cache-hint* annotation on structured system-prompt parts, keeping the v1 dynamic boundary as the cut point. The Anthropic adapter emits `cache_control`; OpenAI uses implicit prefix caching and just needs the prompt ordered consistently; MiniMax and others ignore or translate as appropriate.
- Promote capability flags to first-class `ModelEntry` metadata: `maxContextTokens`, `maxOutputTokens`, `supportsThinking`, `supportsInterleavedThinking`, `promptCacheModel: "explicit" | "implicit" | "none"`, etc. The rest of Ultron reads capabilities, never provider identity.

### 2. MCP (Model Context Protocol)

**Why an MCP client at all.** MCP is a protocol-level tool seam — independent of which LLM provider is calling — with a mature open-source ecosystem (GitHub, filesystem, Postgres, Puppeteer, Slack, and dozens more ship as MCP servers). Consuming it gives Ultron a large integration surface without reimplementing each service, keeps third-party code crash-isolated in its own process with its own release cadence, and lets users add or remove servers through config instead of a rebuild. Because MCP sits at the tool boundary — below the provider adapter — it works uniformly whether the active model is Opus, GPT, or MiniMax.

**What the client contains.**

- **Transport.** stdio first (spawn subprocess with `command` + `args` + `env`); HTTP/SSE for remote servers is deferred to v2.x. stdio alone covers local dev tools and most community servers.
- **Protocol.** JSON-RPC handshake, `initialize` capability negotiation, `list_tools` / `call_tool` as the v2 core. Resources and prompts follow later.
- **Config surface.** A single user-editable file (e.g. `.ultron/mcp.json`) listing servers with `command`, `args`, `env`, `disabled`, `timeout`. No rebuild to add a server; no source edits.
- **Registry integration.** Each server becomes a namespaced prefix (e.g. `mcp__github__create_issue`) in the same registry as built-in tools. From the rest of the codebase, MCP tools and built-ins are indistinguishable — same `ToolDefinition` shape, same execution path.
- **Permissions.** Every MCP call flows through the v1 permission engine; allow/deny keyed on namespace and tool name. No bypass for being "external", and remote transports (when added) get tighter defaults than local stdio.
- **Lifecycle.** Lazy connect on first use, reconnect with backoff on failure, clean shutdown on Ultron exit. Connection errors and tool-call failures surface through the same event/audit stream as built-in tools.

No MCP *server* exposure in v2 — Ultron consumes MCP, does not publish to it.

### 3. Bash — AST-Based Classification

- Promote the v1 "v2 target" for `BashTool` to a v2 deliverable: a real shell AST (pipes, subshells, redirections, command substitution) with per-node read/write classification.
- Validate redirection targets against the v1 filesystem-safety layer.
- Block known-dangerous patterns (`curl | sh`, `rm -rf /`, path traversal) before the permission prompt even fires.

### 4. Memory & Skills

- Add a **persistent memory layer** modelled on the auto-memory pattern (typed entries — user / feedback / project / reference — indexed by a `MEMORY.md`), gated by the v1 secret scanner and byte/token caps.
- Add a **skills** primitive: reusable instruction/capability bundles the user can invoke by name. Skills are plain files on disk, loaded lazily, and obey the same tool-permission rules when they trigger tools.

### 5. Subagents via Agent SDK

- Ship a real subagent tool (not just the Phase 13 stub): forked context, scoped tool pool, separate transcript, parallel fan-out for read-only investigations.
- Subagents share the parent's permission engine; they cannot grant themselves capabilities the parent lacks.

### 6. New First-Party Tools

- **WebSearch / WebFetch** — gated read-only tools for live lookups, with domain allow/deny lists.
- **CodeSandbox** — Python/JS execution in an ephemeral sandbox for quick analysis without touching the user's shell.
- **Attachments** — first-class image, PDF, and notebook attachments flowing through the v1 attachment pipeline.

### 7. Hooks & Observability

- Add **pre-tool / post-tool hooks** (user-configured shell commands) that can inspect or block tool calls — modelled on the Claude Code harness hooks.
- Emit a **structured audit log** for every permission decision, tool call, and compaction event. Local-only, rotated on disk.

### 8. Smarter Compaction & Context Budget

- Replace the v1 single-pass summarizer with **hierarchical compaction** (per-turn summaries → session summary → compact boundary) and **selective tool-result trimming** for oversized outputs.
- Add a **token-budget-aware attachment injector** (deferred from v1) that evicts low-value attachments before the model runs.

---

## Explicitly Out of Scope for v2

- Multi-tenant / org model, shared memory across users, remote sessions.
- Computer-use / desktop automation tool (reserved for v3; see [`ultron_v3/v3-computer-use-plan.md`](ultron_v3/v3-computer-use-plan.md) and [`ultron_v3/v3-phase0-design.md`](ultron_v3/v3-phase0-design.md)).
- Web UI, desktop app, IDE extension — still CLI only.
- Exposing Ultron as an MCP server or remote agent.
- Autonomous / proactive triggers without an explicit user prompt.

---

## Success Criteria

You can explain Ultron v2 in one paragraph:

> Ultron v2 is the v1 CLI agent upgraded to modern agent-platform capabilities: Opus 4.7 with 1M context and extended thinking as the default, OpenAI and MiniMax adapters still first-class, prompt-cached prefixes, MCP-pluggable tools, AST-validated shell execution, persistent memory and skills, real subagents, first-party web/sandbox/attachment tools, and configurable hooks with a structured audit log — all running under the same v1 permission engine, still single-user, local-first, and still multi-provider.

---

## Suggested Build Order

A full phased roadmap is deferred until these pillars are scoped individually. The sequence below is optimized for "pave the road first" — land the substrate that every later pillar depends on before widening the tool surface.

1. **Inference & runtime substrate** — provider-agnostic capability metadata on `ModelEntry` (context window, thinking/reasoning, prompt-cache model, max output, interleaved-thinking support); structured system-prompt parts with generic cache-hint annotations that each adapter translates into its native shape (Anthropic `cache_control`, OpenAI implicit prefix caching, MiniMax, …); thinking/reasoning budgets surfaced as a generic per-turn setting mapped per provider. Defaults: Opus 4.7 (1M) primary, Sonnet 4.6 fast fallback; OpenAI and MiniMax adapters must continue working without regression, and adding a provider stays a single adapter file plus one registry line per the v1 contract. Every later pillar reads from this contract, so it goes first.
2. **Hooks & audit spine** — one typed event stream covering permission decisions, tool lifecycle, compaction, and (later) subagents; pre/post tool hooks wired to that stream. Lands before any new tool surface so observability is never retrofitted.
3. **MCP-capable dynamic tool registry** — promote tool source/namespace to first-class metadata, add an MCP client that registers through the same seam. Unblocks both third-party and the v2 first-party tools cheaply.
4. **Memory MVP** — typed entries on disk (user / feedback / project / reference), generated `MEMORY.md` index, secret scanner + byte/token caps, controlled injection. Narrow on purpose; richer auto-memory behaviors are v2.x.
5. **Skills** — reusable instruction/capability bundles, lazy-loaded, routed through the same permission engine when they trigger tools. Shares the on-disk typed-file pattern with memory, so it piggybacks on #4's plumbing.
6. **New first-party tools (text)** — WebSearch / WebFetch with allow/deny lists, CodeSandbox. Safe to add here because the registry is already dynamic and every call is hook/audit covered. First-class attachments are deliberately split out to #9 (see below).
7. **Subagents via Agent SDK** — forked context, scoped tool pool, parallel read-only fan-out. Deliberately late: subagents are most useful once the tool pool is rich and the audit spine can trace nested calls.
8. **Hierarchical compaction + budget-aware attachment injector** — per-turn → session → compact-boundary summaries, selective tool-result trimming, a single token-budget policy informed by the capability layer from #1. The injector arrives before its main consumer (attachments) so #9 can plug in without retrofitting eviction.
9. **First-class attachments** — image / PDF / notebook attachments flowing through the v1 attachment pipeline, consumed by the budget-aware injector from #8 and surfaced through WebFetch (which until now refuses non-text content types). Pushed to the end on purpose: a text-driven CLI agent loses bounded functionality without it, and the injector in #8 is the right substrate to land first.

**Parallel track: AST Bash classification.** The largest v1 safety gap, but orthogonal to the substrate — it doesn't block thinking, cache, memory, MCP, or anything else. Land it any time after #2 (so it inherits hook/audit coverage) without gating the main sequence on it.

Each pillar gets its own `docs/phaseN-v2-design.md` before implementation.
