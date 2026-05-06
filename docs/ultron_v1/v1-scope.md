# Ultron v1 Scope

## In Scope

### Tools

| Tool | Description |
|------|-------------|
| `FileRead` | Read file contents, optionally by line range. Supports text and common binary formats (images via base64). |
| `FileWrite` | Create new files or overwrite existing ones. Requires prior read for overwrites (stale-write protection). |
| `FileEdit` | Exact string replacement. Rejects no-op edits, stale edits, and writes to denied paths. |
| `Glob` | File pattern matching (e.g., `**/*.ts`). Returns matching paths sorted by modification time. |
| `Grep` | Regex content search across files. Supports glob filtering, context lines, and multiple output modes. |
| `Bash` | Shell command execution. v1 uses allowlist-based classification; v2 targets AST-based parsing. |

### Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Read tools auto-approve. Write tools and shell commands prompt. |
| `acceptEdits` | File tools auto-approve. Shell commands prompt unless on the safe-command allowlist. |
| `bypassPermissions` | Everything auto-approves except safety-critical paths. |

### Permission Rule Types

- **allow** — tool + argument pattern auto-approves
- **deny** — tool + argument pattern always blocks (takes priority over allow)
- **ask** — tool + argument pattern always prompts (overrides mode-based auto-approve)

### Permission Decision Order

1. Explicit deny rules
2. Explicit ask rules
3. Tool-specific permission checks (e.g., `FileEdit.checkPermissions`)
4. Safety checks that cannot be bypassed (protected paths, symlink resolution)
5. Mode-based bypass or broad allow
6. Fallback to ask

### Transcript

- Format: JSON Lines, one message object per line
- Location: `~/.ultron/sessions/<session-id>/transcript.jsonl`
- Persisted types: `user`, `assistant`, `tool_result`, `compact_summary`
- Tool results stored in full (no summarization until compaction)
- Session resume replays from last compact boundary

### Core Architecture

- Agent loop: stream model response, detect tool_use, execute tools, append results, recurse
- Streaming events: `RequestStart`, `TextDelta`, `ToolUseStart`, `ToolResult`, `Terminal`
- Message normalization: ensure tool_use/tool_result pairing, strip UI-only messages
- Abort handling: propagate AbortController, inject synthetic error results, kill child processes
- Error recovery: retry on max_output_tokens (up to 3), stub compaction on prompt_too_long
- State store: `getState()`, `setState(partial)`, `subscribe(listener)`

### Session Persistence

- Transcript persisted before model response starts
- Resume rebuilds message history and derived state
- File-reading caches are separate from transcript

### Filesystem Safety

- Path normalization (absolute, case-normalized, symlink-resolved)
- Working directory boundary enforcement
- Protected path list: shell rc files, git metadata, editor config, `~/.ultron/`
- Stale-write detection via file state cache (content hash + mtime)

### Approval UX (CLI)

- Show: tool name, normalized input, reason for approval, allowlist option
- Actions: allow once, deny once, allow by rule (persisted)
- All decisions logged with structured metadata

---

## Out of Scope for v1

| Feature | Reason |
|---------|--------|
| Multi-tenant user model | Single-user architecture; no org/workspace separation needed |
| Shared memory across users | No other users exist |
| Remote sessions | Local-first; no server component |
| MCP instruction deltas | Not needed without external tool providers |
| Proactive mode | Assistant responds to prompts only; no autonomous triggers |
| Workflow engine | No predefined multi-step pipelines; the agent loop handles sequencing |
| Swarm teammates | No multi-agent coordination beyond simple subagent delegation |
| Cross-user collaboration | Single user |
| Web UI / Desktop app / IDE extension | CLI only |
| AST-based shell parsing | Deferred to v2; v1 uses allowlist classification |
| Advanced compaction (context collapse, reactive compact) | Basic summarization first |
| Token-budget-aware attachment injection | Deferred until compaction is stable |

---

## Success Criteria

You can explain Ultron v1 in one paragraph:

> Ultron is a single-user CLI assistant that accepts natural language prompts, calls an LLM, and executes tool actions (file reads, writes, edits, search, shell commands) through a permission-gated execution boundary. Every tool call is schema-validated, permission-checked, and auditable. Sessions persist to disk and can be resumed. Long conversations are handled through summarization-based compaction. The assistant runs locally with no server component and no multi-user features.

The tool list and permission modes fit on one page (see above).
