# Phase 13: Add Optional Single-User Subagents

## Context

The core loop (`query()`) is a composable async generator. Phase 12's `QueryEngine` wires deps and manages sessions. Subagents are the natural next step: let the assistant delegate a subtask to a forked `query()` call with isolated state.

The key constraint from the ROADMAP: "Introduce delegation without destabilizing the primary assistant." The design must be **as simple as possible for v1** while remaining **extensible for future multi-agent work**.

## Key Design Decisions

1. **Subagent = `AgentTool` that calls a `forkSubagent` function.** A subagent is just another tool. The model invokes `AgentTool` with a prompt string; the tool calls `context.forkSubagent(prompt)`, which runs a forked `query()` with isolated state and returns the result text. No new loop mechanism — it's `query()` all the way down.

2. **`forkSubagent` is injected via `ToolUseContext`, not hardwired.** `ToolUseContext` gains one optional field: `forkSubagent?: ForkSubagentFn`. `AgentTool` calls it; all other tools ignore it. `QueryEngine` wires the real implementation. This is simpler than a structured `agentContext` object AND more extensible — future agent types (parallel agents, specialized agents) call the same primitive with different options.

3. **Forked state, shared infrastructure.** Each subagent gets:
   - Its own `AppState` (cloned from parent — isolated permission rules)
   - Its own `ReadFileState` (fresh — no stale-edit contamination)
   - Its own `AbortController` (linked to parent — parent abort cascades)
   - Its own message history (starts with the subagent prompt only)
   - Its own transcript subdirectory (`<session>/agents/<subagent-id>/`)
   - **Shared**: `callModel`, `compactCallModel` (same API key/model), parent's `ToolRegistry` (filtered to read-only)

4. **Hardcoded read-only tool pool for v1.** Subagents get `FileRead`, `Glob`, `Grep` only. No model-facing `allowedTools` parameter — the model just provides a prompt. The internal `SubagentOptions.allowedTools` exists as an extension point for future phases but is not exposed in v1's `AgentTool` input schema.

5. **Linked abort hierarchy.** The subagent's `AbortController` listens to the parent's signal. Parent abort cascades to child. The subagent can also terminate independently (e.g., `max_turns`, `end_turn`).

6. **Subagent result = final assistant text.** `AgentTool` collects `turn` events from the subagent's `query()` and returns the last assistant text as the tool result. The parent model sees the subagent's conclusion, not its full event stream.

7. **Separate transcript persistence.** Subagent messages are persisted to `<parent-session-dir>/agents/<subagent-id>/transcript.jsonl`. Keeps the parent transcript clean while maintaining audit trail.

8. **No recursive subagents.** `Agent` tool is excluded from the subagent's tool pool. Prevents unbounded nesting. Future multi-agent phases can lift this with depth limits.

9. **`AgentTool` auto-approves; subtool permissions are the safety boundary.** `AgentTool.checkPermissions` returns `{ behavior: 'allow' }`. V1 subagents are read-only (`FileRead`, `Glob`, `Grep`) — all safe tools that auto-approve anyway. The delegation itself adds no risk, so requiring approval for it is redundant friction. For future write-capable subagents: each individual tool call within the subagent still goes through the full `runToolUse` → permission cascade → `askUser` flow. The dangerous operation is gated at the tool level inside the subagent, not at the delegation level. This matches Claude Code's pattern where `Agent` tool auto-approves while subtools are permission-checked independently.

10. **Subagent gets the same dynamic context as the parent.** The subagent's context model mirrors the parent's:
    - **System prompt**: parent's static system prompt + a short subagent preamble
    - **Initial attachments**: `getInitialAttachments(cwd)` prepended to subagent messages — provides git status and project instructions, same as the parent gets on first turn
    - **No per-turn attachments for v1**: Since v1 subagents are read-only, they don't modify files, so there are no file changes or git status updates to report. When future phases add write-capable subagents, they'd get `getAttachments` too.
    - This follows Claude Code's pattern where subagents call `getSystemContext()` and `getUserContext()` for workspace awareness, adapted to Ultron's attachment-based architecture.

11. **`ForkSubagentFn` is a narrow, opaque function — not a config transport.** The signature is `(prompt: string) => Promise<SubagentResult>`. All configuration (tool pool, model, permissions, context) is captured at creation time via `createForkSubagent(opts)`. The prompt string is purely the task description. Future expansion adds new parameters to `SubagentOptions`, not to the prompt.

## Architecture

```
src/agents/
  runAgent.ts        — forkSubagent(): create isolated deps, call query(), collect result
  agentTool.ts       — AgentTool: Tool implementation, calls context.forkSubagent()
  agentPrompt.ts     — subagent system prompt preamble
```

## Files to Create

### `src/agents/agentPrompt.ts`

**Purpose:** Subagent system prompt template.

```typescript
export function buildSubagentSystemPrompt(parentSystemPrompt: string): string
```

Prepends a short preamble to the parent's system prompt. The preamble instructs the model to focus on the assigned task, return a concise result, and not ask follow-up questions.

### `src/agents/runAgent.ts`

**Purpose:** Fork a subagent `query()` call with isolated state.

```typescript
export type ForkSubagentFn = (prompt: string) => Promise<SubagentResult>

export type SubagentOptions = {
  readonly callModel: CallModelFn
  readonly compactCallModel: CallModelFn
  readonly parentToolRegistry: ToolRegistry
  readonly parentAppState: Store<AppState>
  readonly parentSystemPrompt: string
  readonly parentSignal: AbortSignal
  readonly cwd: string                        // for initial attachments (git status, project instructions)
  readonly sessionDir: string
  readonly permissionOpts: PermissionOptions
  readonly allowedTools?: readonly string[]   // extension point — not exposed in v1 AgentTool
  readonly maxTurns?: number                  // default: 30 (subagents should be shorter)
}

export type SubagentResult = {
  readonly text: string
  readonly terminal: Terminal
  readonly subagentId: string
}

/** Create a ForkSubagentFn bound to the given parent context. */
export function createForkSubagent(opts: SubagentOptions): ForkSubagentFn
```

**`createForkSubagent` returns a function that:**

1. Generates subagent ID (`randomUUID()`)
2. Creates linked `AbortController` (listens to `parentSignal`)
3. Clones `AppState` from parent (fresh `createStore` with parent's snapshot)
4. Creates fresh `ReadFileState`
5. Builds filtered `ToolRegistry` — copies only `allowedTools` (default: `['FileRead', 'Glob', 'Grep']`) from parent registry, always excludes `'Agent'`
6. Builds `ToolUseContext` with forked state (no `forkSubagent` — preventing recursion)
7. Builds `runTool` via `createRunToolFn(toolUseContext, permissionOpts)`
8. Builds system prompt via `buildSubagentSystemPrompt(parentSystemPrompt)`
9. Gets initial attachments via `getInitialAttachments(cwd)` — gives subagent the same workspace context as parent
10. Creates user message from prompt
11. Calls `query({ messages: [...initialAttachments, userMsg], systemPrompt, deps, signal, maxTurns })` — no `getAttachments` dep (read-only subagents don't trigger per-turn refreshes)
12. Iterates events: persists via `appendMessage()` to `<sessionDir>/agents/<subagentId>/`, collects final assistant text from the last `turn` event
13. Cleans up abort listener
14. Returns `{ text, terminal, subagentId }`

**Tests (co-located):**
- `createForkSubagent` with mock callModel returns result text
- Subagent gets isolated AppState (mutations don't affect parent)
- Subagent gets filtered tool registry (only allowed tools)
- `Agent` tool never in subagent's registry
- Parent abort cascades to subagent
- Subagent messages persisted to subdirectory

### `src/agents/agentTool.ts`

**Purpose:** `AgentTool` — a `Tool` implementation the model can invoke.

```typescript
export const AGENT_TOOL_NAME = 'Agent'

export function createAgentTool(): Tool
```

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "prompt": { "type": "string", "description": "The task to delegate to a subagent" }
  },
  "required": ["prompt"]
}
```

Minimal — just a prompt string. No tool selection, no model overrides. V1 simplicity.

**`call`:** Reads `context.forkSubagent`, calls it with the prompt, returns `{ content: result.text, isError: false }`. If `forkSubagent` is not available, returns an error result.

**`validateInput`:** Check `prompt` is non-empty string.

**`checkPermissions`:** Returns `{ behavior: 'allow' }` — lets the normal cascade decide. No special overrides.

**Tests (co-located):**
- Returns error if `forkSubagent` not in context
- Calls `forkSubagent` with prompt and returns text result
- Validates prompt is non-empty

## Files to Modify

### `src/core/tools/context.ts`

Add optional `forkSubagent` field:

```typescript
import type { ForkSubagentFn } from '../../agents/runAgent.js'

export type ToolUseContext = {
  // ... existing 5 fields ...
  forkSubagent?: ForkSubagentFn
}
```

Update `createToolUseContext` to accept and pass through the field.

### `src/core/tools/registry.ts`

Register `AgentTool` in `createDefaultRegistry()`.

### `src/sdk/QueryEngine.ts`

In `submitPrompt()`, create and pass `forkSubagent` when building `ToolUseContext`:

```typescript
const forkSubagent = createForkSubagent({
  callModel: this.callModel,
  compactCallModel: this.compactCallModel,
  parentToolRegistry: this.toolRegistry,
  parentAppState: this.appState,
  parentSystemPrompt: systemPrompt,
  parentSignal: this.currentAbort.signal,
  cwd: this.config.cwd,
  sessionDir: this.session.dir,
  permissionOpts: this.permissionOpts,
})

const toolUseContext = createToolUseContext({
  // ... existing fields ...
  forkSubagent,
})
```

## Implementation Order

1. `src/agents/agentPrompt.ts` — standalone
2. `src/core/tools/context.ts` — add `forkSubagent` field
3. `src/agents/runAgent.ts` + tests — fork logic
4. `src/agents/agentTool.ts` + tests — Tool implementation
5. `src/core/tools/registry.ts` — register AgentTool
6. `src/sdk/QueryEngine.ts` — wire `forkSubagent`

Steps 1-2 independent. Step 3 depends on 1-2. Step 4 depends on 3. Steps 5-6 depend on 4.

## Extension Points for Future Multi-Agent Work

These are **not implemented in v1** but the design accommodates them:

- **`SubagentOptions.allowedTools`**: Internal parameter ready for model-facing exposure when write-capable subagents are needed
- **`SubagentOptions.maxTurns`**: Already parameterized for different agent budgets
- **`ForkSubagentFn` abstraction**: Future agent types (parallel, specialized, write-capable) can provide different `ForkSubagentFn` implementations without changing the Tool interface
- **Transcript subdirectory pattern**: `<session>/agents/<id>/` naturally extends to multiple concurrent agents
- **Depth limit**: Currently prevented by excluding `Agent` from subagent tools. Future: pass a depth counter through `SubagentOptions` and include `Agent` when depth < max
- **Custom models per agent**: Add `model?: string` to `SubagentOptions`, create a separate `callModel` if provided
- **Agent definitions from files**: Load `AgentDefinition` frontmatter that specifies tools, model, prompt — the `createForkSubagent` call site just passes different options

## What Phase 13 Does NOT Do

- No recursive subagents (Agent excluded from subagent tool pool)
- No model-facing tool selection (hardcoded read-only pool)
- No teammate mailboxes or task queues
- No multi-worker coordination or parallel execution
- No subagent-to-subagent communication
- No subagent state merging back to parent
- No custom subagent models
- No agent definitions from files/frontmatter

## Verification

1. Model can invoke `AgentTool` with a prompt
2. Subagent runs isolated `query()` loop and returns result text
3. Subagent gets initial attachments (git status, project instructions) — same workspace context as parent
4. Subagent transcript persisted to `<session>/agents/<subagent-id>/`
5. Parent abort cascades to subagent
6. Subagent tool pool is read-only only (`FileRead`, `Glob`, `Grep`)
7. `Agent` tool never appears in subagent's tool pool (no recursion)
8. `AgentTool` auto-approves (no approval prompt for read-only delegation)
9. Subagent respects parent's permission mode and safety checks for its subtools
10. Subagent's `AppState` mutations don't affect parent
11. Missing `forkSubagent` in context returns error (graceful degradation)
12. All tests pass, typecheck clean
