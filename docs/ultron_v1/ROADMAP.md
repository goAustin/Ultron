# Personal Assistant Rebuild Roadmap

## Goal

Build a personal assistant inspired by this codebase, but with a narrower, controllable architecture:

1. A robust agent loop
2. A safe tool-execution boundary
3. A practical context-engineering layer
4. Optional single-user subagents
5. Strong local-first security controls

This roadmap assumes a single-user architecture for the foreseeable future:

- one user is the only tenant
- no organization/workspace separation
- no shared team memory
- no cross-user collaboration layer
- no swarm teammate framework

This roadmap is organized as executable phases. Each phase includes:

- Objective
- Scope
- Concrete tasks
- Deliverables
- Verification criteria
- Source references in this repository

The intent is not to clone every Claude Code product feature. The intent is to reproduce the core assistant architecture safely.

---

## Guiding Extraction Principles

Before implementation, keep these rules in force:

1. Reuse the execution model, not the product surface.
2. Preserve permission ordering exactly in spirit.
3. Rewrite system prompts and UX copy for your own assistant.
4. Keep dynamic context outside the static prompt whenever possible.
5. Start with a single-agent local assistant before adding subagents, workflows, or remote integrations.
6. Exclude shared-memory and multi-user coordination features unless you later make them explicit product requirements.

Primary source areas:

- Main loop: [reference/query.ts](reference/query.ts:241)
- SDK/session entrypoint: [reference/QueryEngine.ts](reference/QueryEngine.ts:211)
- Tool execution boundary: [reference/services/tools/toolExecution.ts](reference/services/tools/toolExecution.ts:599)
- Permission engine: [reference/utils/permissions/permissions.ts](reference/utils/permissions/permissions.ts:1158)
- Filesystem write safety: [reference/utils/permissions/filesystem.ts](reference/utils/permissions/filesystem.ts:620)
- Prompt/context assembly: [reference/utils/queryContext.ts](reference/utils/queryContext.ts:44), [reference/constants/prompts.ts](reference/constants/prompts.ts:561), [reference/context.ts](reference/context.ts:116)
- Dynamic attachments: [reference/utils/attachments.ts](reference/utils/attachments.ts:2938)
- Subagent runner: [reference/tools/AgentTool/runAgent.ts](reference/tools/AgentTool/runAgent.ts:248)

---

## Phase 0: Product Definition (Finalized)

Ultron is a single-user CLI assistant that accepts natural language prompts, calls an LLM, and executes tool actions through a permission-gated execution boundary. Every tool call is schema-validated, permission-checked, and auditable. Sessions persist to disk and can be resumed. The assistant runs locally with no server component and no multi-user features.

Full details: [`docs/product-brief.md`](../product-brief.md) and [`docs/ultron_v1/v1-scope.md`](v1-scope.md).

### Tool Set

| Tool | Purpose | Concurrency |
|------|---------|-------------|
| `FileRead` | Read file contents with line ranges | Read-only (concurrent) |
| `FileWrite` | Create or overwrite files | Serialized |
| `FileEdit` | Exact string replacement in existing files | Serialized |
| `Glob` | Find files by pattern | Read-only (concurrent) |
| `Grep` | Search file contents by regex | Read-only (concurrent) |
| `Bash` | Execute shell commands | Serialized |

### Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Read tools auto-approve. Write tools and shell commands prompt. |
| `acceptEdits` | File tools auto-approve. Shell commands prompt unless allowlisted. |
| `bypassPermissions` | All auto-approve **except** safety-critical paths (always prompt). |

### Permission Decision Order

1. Explicit deny → 2. Explicit ask → 3. Tool-specific checks → 4. Non-bypassable safety checks → 5. Mode-based allow → 6. Fallback to ask

### Transcript

- Format: JSONL, one message per line, stored at `~/.ultron/sessions/<session-id>/transcript.jsonl`
- Persisted types: `user`, `assistant`, `tool_result`, `compact_summary`
- Tool results stored in full; summarization deferred to compaction
- Resume replays from last compact boundary

### Non-Goals for v1

Multi-tenant model, shared memory, remote sessions, MCP instruction deltas, proactive mode, workflow engine, swarm teammates, cross-user collaboration, web/desktop/IDE UI, AST-based shell parsing.

---

## Phase 1: Extract the Core Execution Model

### Objective

Build a minimal assistant loop that can:

1. accept user input
2. call the model
3. detect tool requests
4. execute tools
5. append tool results
6. continue until completion

### Source References

- [reference/query.ts](reference/query.ts:241)
- [reference/query/deps.ts](reference/query/deps.ts:1)
- [reference/query/config.ts](reference/query/config.ts:1)
- [reference/services/api/claude.ts](reference/services/api/claude.ts) — `normalizeMessagesForAPI()`, streaming event types

### Tasks

1. Create a new `query` module in your own app with:
   - `QueryParams`
   - loop state
   - `query()`
   - `queryLoop()`
2. Keep the top-level loop structure simple:
   - build request
   - stream response
   - collect assistant messages
   - collect `tool_use`
   - run tools
   - recurse with updated message history
3. Remove from your first version:
   - reactive compact
   - context collapse
   - budget continuation
   - tool-use summaries
   - background task summaries
4. Keep these invariants:
   - tool results must always pair with tool calls
   - aborted runs must not leave dangling tool requests
   - retries must not replay stale tool IDs
   - every message array sent to the API must pass through normalization before submission
5. Extract a narrow dependency interface similar to [reference/query/deps.ts](reference/query/deps.ts:1).
   - model call function
   - compaction hook placeholder
   - UUID generator
6. Commit to a streaming contract for the query loop.
   - The loop should be an async generator (or event emitter) yielding typed events: `RequestStart`, `TextDelta`, `ToolUseStart`, `ToolResult`, `Terminal`.
   - This determines how the UI renders progress, how tool results flow back, and how abort works.
   - Reference: `reference/query.ts` uses `async function*` yielding `StreamEvent` and `Message` types.
7. Implement minimal error recovery stubs in the loop:
   - `max_output_tokens`: detect stop reason, retry with reduced limit (up to 3 attempts).
   - `prompt_too_long`: detect API error, stub a compaction hook call (implemented in Phase 10).
   - These are not optional — without them the loop will crash on long conversations before Phase 10 is reached.
8. Implement `normalizeMessagesForAPI()`:
   - Strip UI-only system messages before sending to the API.
   - Ensure every `tool_use` block has a matching `tool_result` (inject error results for aborted/missing calls).
   - Handle thinking blocks: preserve or strip based on model capability.
   - Reference: logic spread across [reference/services/api/claude.ts](reference/services/api/claude.ts) and [reference/query.ts](reference/query.ts:241).

### Deliverables

- `src/core/query.ts`
- `src/core/queryTypes.ts`
- `src/core/queryDeps.ts`
- `src/core/queryEvents.ts` (streaming event type definitions)
- `src/core/normalizeMessages.ts`

### Verification

- A text-only prompt can complete with no tools.
- A prompt that requests a tool call continues correctly after the tool result.
- Aborting during a tool call yields a clean terminal state.
- The loop yields streaming events that a consumer can render progressively.
- A `prompt_too_long` API error triggers a compaction stub, not an unhandled crash.
- An aborted tool call produces a synthetic error `tool_result`, not a dangling `tool_use`.

---

## Phase 2: Define the Tool Abstraction

### Objective

Create a small, stable tool interface that all tools implement.

### Source References

- [reference/Tool.ts](reference/Tool.ts:1)
- [reference/tools.ts](reference/tools.ts:173)
- [reference/state/AppStateStore.ts](reference/state/AppStateStore.ts) — reference for store responsibilities and mutation flow (tightly coupled to Claude Code’s React/Ink UI; study for the *what*, not the *how*)

### Tasks

1. Define a `Tool` interface with:
   - `name`
   - `inputSchema`
   - optional `validateInput`
   - `checkPermissions`
   - `call`
   - optional `isConcurrencySafe`
   - optional `getPath`
2. Define a `ToolUseContext` with:
   - app state access
   - abort controller
   - current messages
   - read file state
   - tool registry
3. Build a minimal registry.
4. Register only the initial tool set from Phase 0.
5. Avoid product-specific fields at first.
   - Do not copy all of Claude Code’s `ToolUseContext`.
   - Add fields only when required by your app.
6. Define a mutable state store interface for `ToolUseContext.appState`.
   - Minimum contract: `getState()`, `setState(partial)`, `subscribe(listener)`.
   - Tools and the query loop both read/write through this interface.
   - Keep it simple — a plain object with change listeners is sufficient for single-user.

### Deliverables

- `src/core/tools/types.ts`
- `src/core/tools/registry.ts`
- `src/core/tools/context.ts`
- `src/core/state.ts`

### Verification

- Tools can be looked up by name.
- Tool input validation fails before execution.
- Tool calls run through one common path.

---

## Phase 3: Build the Tool Execution Boundary

### Objective

Ensure model output never executes directly. Every tool call must pass through one guarded path.

### Source References

- [reference/services/tools/toolExecution.ts](reference/services/tools/toolExecution.ts:337)
- [reference/services/tools/toolExecution.ts](reference/services/tools/toolExecution.ts:599)
- [reference/services/tools/toolOrchestration.ts](reference/services/tools/toolOrchestration.ts:1)

### Tasks

1. Build a `runToolUse()` function.
2. Build a `checkPermissionsAndCallTool()` function.
3. Preserve this execution order:
   - locate tool
   - parse tool input against schema
   - run tool-local validation
   - run pre-tool hooks if you support hooks
   - evaluate permissions
   - execute tool
   - normalize tool result into transcript form
4. Build concurrent execution only for tools that explicitly declare themselves safe.
5. For v1, batch concurrency only for read-only tools.
6. Ensure unknown tools fail safely with structured errors.
7. Implement abort propagation through tool execution:
   - Pass `AbortController` from the query loop into every `runToolUse()` call.
   - On abort signal: cancel in-flight tool (especially shell processes), inject a synthetic error `tool_result`, restore consistent state.
   - For shell tools: kill the child process group, not just the parent PID.
   - Reference: `AbortController` threading in [reference/services/tools/toolExecution.ts](reference/services/tools/toolExecution.ts:599).

### Deliverables

- `src/core/tools/runToolUse.ts`
- `src/core/tools/toolExecution.ts`
- `src/core/tools/toolOrchestration.ts`

### Verification

- Unknown tool names fail without crashing the session.
- Invalid tool arguments fail before execution.
- Read-only tool batches can run concurrently.
- Write tools stay serialized.
- Ctrl+C during a shell command kills the process and produces a clean tool result.
- Ctrl+C during concurrent read-only tools cancels all in-flight calls.

---

## Phase 4: Rebuild the Permission Engine

### Objective

Implement a minimal but correct policy engine before adding richer UX.

### Source References

- [reference/utils/permissions/permissions.ts](reference/utils/permissions/permissions.ts:473)
- [reference/utils/permissions/permissions.ts](reference/utils/permissions/permissions.ts:1158)

### Required Invariant

Preserve this decision order:

1. explicit deny
2. explicit ask
3. tool-specific permission checks
4. safety checks that cannot be bypassed
5. mode-based bypass or broad allow
6. fallback to ask

### Tasks

1. Define permission rule types:
   - allow
   - deny
   - ask
2. Define permission modes:
   - `default`
   - `acceptEdits`
   - `bypassPermissions`
3. Build `hasPermissionsToUseTool()`.
4. Build `hasPermissionsToUseToolInner()`.
5. Ensure bypass mode does not skip sensitive-path safety checks.
6. Add headless-mode behavior:
   - if prompts are unavailable, return explicit denial rather than implicit execution
7. Add structured decision reasons so you can audit why a tool was allowed or denied.

### Deliverables

- `src/core/permissions/types.ts`
- `src/core/permissions/permissions.ts`
- `src/core/permissions/rules.ts`

### Verification

- A deny rule always wins.
- A sensitive file still prompts in bypass mode.
- A normal file in `acceptEdits` can be edited without prompting.
- A missing prompt UI in headless mode causes denial, not silent execution.

---

## Phase 5: Rebuild Filesystem Safety

### Objective

Protect the assistant from dangerous or ambiguous write targets.

### Source References

- [reference/utils/permissions/filesystem.ts](reference/utils/permissions/filesystem.ts:620)
- [reference/utils/permissions/filesystem.ts](reference/utils/permissions/filesystem.ts:683)
- [reference/utils/permissions/filesystem.ts](reference/utils/permissions/filesystem.ts:1305)

### Tasks

1. Implement path normalization:
   - absolute path expansion
   - case normalization for comparisons where needed
   - symlink-aware permission checking
2. Define dangerous paths for your app:
   - shell rc files
   - git metadata
   - editor config
   - your assistant’s own config
3. Implement `checkPathSafetyForAutoEdit()`.
4. Implement `pathInAllowedWorkingPath()`.
5. Gate file writes based on:
   - working directory
   - additional working directories
   - explicit permission rules
   - protected paths
6. Keep special handling for network/UNC paths if you support Windows.

### Deliverables

- `src/core/permissions/filesystem.ts`

### Verification

- Symlinked protected files are still treated as protected.
- Writes outside the allowed working directory prompt or fail.
- Sensitive config paths cannot be silently edited.

---

## Phase 6: Implement the File and Shell Tools Safely

### Objective

Bring up the minimum tool set with strong local validation.

### Source References

- File edit: [reference/tools/FileEditTool/FileEditTool.ts](reference/tools/FileEditTool/FileEditTool.ts:125)
- File write: [reference/tools/FileWriteTool/FileWriteTool.ts](reference/tools/FileWriteTool/FileWriteTool.ts:125)
- Bash permissions: [reference/tools/BashTool/bashPermissions.ts](reference/tools/BashTool/bashPermissions.ts:1663)

### Tasks

1. Implement `FileReadTool`.
2. Implement `FileWriteTool`.
   - Require prior read for overwrites if that fits your safety model.
3. Implement `FileEditTool`.
   - Reject no-op edits
   - Reject stale writes
   - Reject denied paths
4. Implement `GlobTool` and `GrepTool`.
5. Implement `BashTool` with a layered permission strategy.
   - **v1 minimum (allowlist-based):** maintain a list of known-safe command prefixes (e.g., `ls`, `cat`, `git status`, `echo`) that can auto-approve. Everything else prompts.
   - **v2 target (AST-based):** parse shell commands into an AST, classify each node as read-only or mutating, validate output redirection paths, detect pipe chains with write sinks.
   - This is the single hardest tool to get right. Claude Code's [bashPermissions.ts](reference/tools/BashTool/bashPermissions.ts:1663) is 1,663 lines. Do not underestimate this.
6. For shell execution validation (v2):
   - parse command into AST (handle pipes, subshells, redirections, command substitution)
   - classify each command as read-only vs write
   - validate output redirection targets against filesystem safety rules
   - detect path traversal in arguments (`../../../etc/passwd`)
   - block dangerous patterns: `rm -rf /`, `chmod 777`, `curl | sh`, etc.
   - Reference: [reference/tools/BashTool/bashPermissions.ts](reference/tools/BashTool/bashPermissions.ts:1663) for the full classification logic.
7. Implement a `FileStateCache` for stale edit detection.
   - When a file is read (by any tool), store a snapshot (content hash + mtime).
   - When `FileEditTool` receives an edit, compare the file's current state against the cached snapshot.
   - If the file changed since last read, reject the edit with a clear error asking the model to re-read.
   - Reference: `readFileState` in `ToolUseContext`, used by [FileEditTool.ts](reference/tools/FileEditTool/FileEditTool.ts:125).
8. Add unit tests for:
   - no-op file edits
   - stale file edits
   - denied paths
   - shell command classification

### Deliverables

- `src/tools/FileReadTool.ts`
- `src/tools/FileWriteTool.ts`
- `src/tools/FileEditTool.ts`
- `src/tools/GlobTool.ts`
- `src/tools/GrepTool.ts`
- `src/tools/BashTool.ts`
- `src/core/tools/fileStateCache.ts`

### Verification

- Overwriting a file without reading it first is blocked if configured.
- Editing a file changed after read is blocked.
- Destructive shell commands require approval.
- Read-only shell commands can be auto-allowed when policy permits.

---

## Phase 7: Build the Prompt and Context Layer

### Objective

Design a context system that is simpler than Claude Code’s but keeps the same architectural strengths.

### Source References

- [reference/utils/queryContext.ts](reference/utils/queryContext.ts:44)
- [reference/constants/prompts.ts](reference/constants/prompts.ts:561)
- [reference/context.ts](reference/context.ts:116)

### Tasks

1. Split prompt material into:
   - static system prompt
   - user context
   - system context
   - dynamic attachments/deltas
2. Write your own system prompt.
   - Do not reuse Claude Code product copy directly.
3. Implement `getUserContext()`.
   - current date
   - project instructions file if you support one
4. Implement `getSystemContext()`.
   - optional git snapshot
   - environment facts
   - local user-only runtime settings if needed
5. Implement a prompt boundary between static and dynamic sections.
6. Design an explicit prompt cache boundary.
   - Place a `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker between static and dynamic sections.
   - Everything before the boundary is cacheable (stable across turns and sessions).
   - Everything after (git status, project instructions, date) changes per turn.
   - If using Anthropic's API, map this to the `cache_control` parameter with `scope: 'global'` on the static prefix.
   - Reference: `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in [reference/constants/prompts.ts](reference/constants/prompts.ts:561).
7. Keep the first version narrow.
   - current date
   - project instructions
   - git snapshot
   - environment block

### Deliverables

- `src/context/systemPrompt.ts`
- `src/context/userContext.ts`
- `src/context/systemContext.ts`
- `src/context/queryContext.ts`

### Verification

- The assistant behaves consistently across turns.
- Static prompt content can be reused without rebuilding every section.
- Dynamic state changes do not force full prompt regeneration.

---

## Phase 8: Move Dynamic State into Attachments or Deltas

### Objective

Keep the static prompt stable by moving volatile state into structured message attachments.

### Source References

- [reference/utils/attachments.ts](reference/utils/attachments.ts:2938)
- Delta examples:
  - [reference/utils/attachments.ts](reference/utils/attachments.ts:1491)
  - [reference/utils/attachments.ts](reference/utils/attachments.ts:1560)

### Tasks

1. Define an attachment model.
2. Start with only a few attachment types:
   - file attachment
   - edited file summary
   - project instruction reminder
   - git status snapshot
3. Implement `getAttachmentMessages()`.
4. Add attachment injection after tool execution, not inside the static prompt builder.
5. If you support instruction or agent changes later, represent them as deltas.

### Deliverables

- `src/context/attachments.ts`
- `src/context/attachmentTypes.ts`

### Verification

- Dynamic state can be added to the next turn without mutating the base prompt.
- Attachment generation can be disabled independently for debugging.

---

## Phase 9: Add Transcript Persistence and Resume

### Objective

Make sessions durable and resumable.

### Source References

- Query/session flow: [reference/QueryEngine.ts](reference/QueryEngine.ts:413)

### Tasks

1. Define your persisted transcript schema.
2. Record:
   - user messages
   - assistant messages
   - tool results
   - compact boundaries if you support compaction
3. Persist the user message before the model response starts.
4. Add resume support:
   - load transcript
   - rebuild `messages`
   - rebuild any derived state you actually need
5. Keep file-reading caches separate from transcript persistence.

### Deliverables

- `src/session/transcript.ts`
- `src/session/resume.ts`

### Verification

- Killing the app after a user prompt still leaves a resumable session.
- Reloading the transcript produces the same next-turn behavior.

---

## Phase 10: Add Compaction Only After the Core Works

### Objective

Prevent long sessions from exhausting context without destabilizing the loop.

### Source References

- Compaction integration in [reference/query.ts](reference/query.ts:365)

### Recommended Strategy

Implement compaction in three steps:

1. manual summary/compact command
2. automatic summary when token threshold is exceeded
3. optional finer-grained result trimming

### Tasks

1. Implement or adopt a token estimation function.
   - Needed to decide when compaction triggers and to budget attachment injection.
   - Options: use `tiktoken` (if targeting OpenAI-compatible tokenizers), Anthropic's token counting API, or a simple character-ratio heuristic (1 token ≈ 4 chars) for v1.
   - Wire this into the query loop so it can check `estimatedTokens(messages) > threshold` after each turn.
2. Start with one simple compaction method:
   - summarize old messages into a compact boundary message
3. Add a token threshold.
4. Rebuild message history after compaction.
5. Make sure tool result pairing and turn continuity still work after compaction.
6. Do not implement context collapse or reactive compact until the basic summarizer is stable.

### Deliverables

- `src/context/tokenEstimator.ts`
- `src/context/compact.ts`
- `src/context/tokenBudget.ts`

### Verification

- A long conversation can continue after compaction.
- Tool execution still works after the summary boundary.
- Resume still works after compaction.

---

## Phase 11: Add Approval UX

### Objective

Make permission requests understandable and auditable.

### Source References

- Interactive permission flow: [reference/hooks/useCanUseTool.tsx](reference/hooks/useCanUseTool.tsx:57)

### Tasks

1. Build a prompt/approval UI for tool requests.
2. Show:
   - tool name
   - normalized input
   - why approval is needed
   - whether the tool is asking once or can be allowlisted
3. Support:
   - allow once
   - deny once
   - optionally allow by rule
4. Log every permission decision with structured reason metadata.

### Deliverables

- `src/ui/permissionDialog.*`
- `src/core/permissions/logging.ts`

### Verification

- Every asked permission is understandable without reading code.
- Every allow/deny action is traceable in logs.

---

## Phase 12: Add Headless and SDK Support

### Objective

Support both interactive and programmatic use.

### Source References

- [reference/QueryEngine.ts](reference/QueryEngine.ts:211)

### Tasks

1. Keep the headless interface separate from the UI.
2. Add one SDK-style entrypoint that:
   - accepts prompt
   - streams messages/events
   - exposes permission denials
3. Ensure headless mode never silently executes actions that would have required UI confirmation.

### Deliverables

- `src/sdk/QueryEngine.ts`
- `src/sdk/types.ts`

### Verification

- The same core loop works in both interactive and SDK modes.
- Headless mode denies unavailable prompts instead of bypassing them.

---

## Phase 13: Add Optional Single-User Subagents Only After Single-Agent Stability

### Objective

Introduce delegation without destabilizing the primary assistant.

### Source References

- [reference/tools/AgentTool/runAgent.ts](reference/tools/AgentTool/runAgent.ts:248)

### Tasks

1. Start with one simple subagent mode:
   - forked context
   - separate transcript
   - same tool-execution rules
2. Keep subagent prompts self-contained.
3. Give subagents restricted tool pools.
4. Persist subagent transcripts separately.
5. Do not implement teammate mailboxes, team task queues, or multi-worker coordination in the single-user design.

### Deliverables

- `src/agents/runAgent.ts`
- `src/agents/agentContext.ts`

### Verification

- A subagent can run independently and return results.
- A subagent cannot bypass the parent’s safety model.

---

## Phase 14: Add Local Memory Safeguards

### Objective

Protect single-user memory files from accidental secret capture and uncontrolled growth.

### Tasks

1. Keep memory local to the current user and machine by default.
2. Define which files may act as assistant memory.
3. Add optional secret scanning before writing to long-lived memory stores.
4. Add byte and token caps for memory injection back into the model context.
5. Add tests for:
   - oversized memory entries
   - obvious API key patterns
   - duplicate memory injection

### Deliverables

- `src/memory/localMemoryGuard.ts`
- `src/memory/secretScanner.ts`

### Verification

- Local memory remains private to one user context.
- Memory writes containing secrets are rejected when scanning is enabled.
- Memory cannot grow without bound in the prompt path.

---

## Phase 15: Build the Test Matrix

### Objective

Lock down correctness before expanding scope.

### Test Categories

1. Unit tests
   - permission ordering
   - filesystem path checks
   - tool input validation
   - transcript transforms
2. Integration tests
   - model -> tool -> model continuation
   - interrupted tool execution
   - compaction continuity
   - resume continuity
3. Security tests
   - symlink bypass attempts
   - dangerous path edits
   - shell-command escalation attempts
   - headless approval bypass attempts

### Deliverables

- `tests/unit/*`
- `tests/integration/*`
- `tests/security/*`

### Verification

- Critical permission and tool-execution tests run in CI.
- Regressions in safety ordering fail fast.

---

## Recommended Build Order

Implement in this order:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
9. Phase 8
10. Phase 9
11. Phase 15
12. Phase 10
13. Phase 11
14. Phase 12
15. Phase 13
16. Phase 14

This order keeps the core safe and testable before adding complexity.

---

## Suggested v1 File Layout

```text
src/
  core/
    query.ts
    queryDeps.ts
    queryTypes.ts
    queryEvents.ts
    normalizeMessages.ts
    state.ts
    tools/
      types.ts
      context.ts
      registry.ts
      runToolUse.ts
      toolExecution.ts
      toolOrchestration.ts
      fileStateCache.ts
    permissions/
      types.ts
      rules.ts
      permissions.ts
      filesystem.ts
  tools/
    FileReadTool.ts
    FileWriteTool.ts
    FileEditTool.ts
    GlobTool.ts
    GrepTool.ts
    BashTool.ts
  context/
    systemPrompt.ts
    userContext.ts
    systemContext.ts
    queryContext.ts
    attachments.ts
    attachmentTypes.ts
    tokenEstimator.ts
    compact.ts
    tokenBudget.ts
  session/
    transcript.ts
    resume.ts
  sdk/
    QueryEngine.ts
    types.ts
  agents/
    runAgent.ts
    agentContext.ts
  memory/
    localMemoryGuard.ts
    secretScanner.ts
```

---

## Explicit “Do Not Copy Blindly” List

Treat these as references, not direct foundations:

- large product prompts in [reference/constants/prompts.ts](reference/constants/prompts.ts:477)
- attachment surface in [reference/utils/attachments.ts](reference/utils/attachments.ts:2938)
- full tool registry in [reference/tools.ts](reference/tools.ts:173)
- product-specific remote, MCP, proactive, workflow, and analytics subsystems

For a single-user assistant, the swarm/team subsystem should stay out of scope unless you later decide to support concurrent workers for the same user.

---

## Completion Definition

Your rebuild is in good shape when all of the following are true:

1. A user prompt can trigger a tool loop and complete reliably.
2. No tool executes without passing schema validation and permissions.
3. Sensitive file paths remain protected even in permissive modes.
4. Long sessions can continue through resume and compaction.
5. Headless usage does not silently bypass interactive safety.
6. Optional subagents reuse the same execution and permission spine.

---

## Immediate Next Action

Start with Phases 0 through 3 only. Do not implement subagents, local memory, or advanced compaction until you have:

- one stable loop
- one stable permission engine
- one stable file/shell tool boundary
- one working transcript format

If you follow that order, you will reproduce the load-bearing architecture without inheriting the full product complexity.
