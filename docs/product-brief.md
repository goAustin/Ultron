# Ultron Product Brief

## What It Is

Ultron is a single-user CLI personal assistant powered by a large language model. It operates locally on the user's machine, manages tasks through tool execution, and maintains session continuity across conversations. It is designed for one person to manage their daily life — reading and writing files, running shell commands, searching codebases, and orchestrating multi-step workflows through a safe, auditable agent loop.

## Who It Is For

A single power user who wants an LLM-backed assistant that:

- Runs locally with full control over what the assistant can and cannot do
- Executes real actions (file edits, shell commands) under a permission model
- Maintains conversation context across sessions
- Can delegate subtasks to scoped subagents

## Where It Runs

**CLI only** for v1. The assistant runs as a terminal process on macOS/Linux. No web UI, no desktop app, no IDE extension. The CLI is the only interface surface.

## Architecture Constraints

- **Single-user, single-tenant.** No organization model, no shared state, no team features.
- **Local-first.** All state (transcripts, memory, config) lives on the local filesystem.
- **One primary agent.** Subagents are optional and scoped; there is no swarm, no mailbox, no multi-worker coordination.

## Core Capabilities

### Tool Set (v1 minimum)

| Tool | Purpose | Concurrency |
|------|---------|-------------|
| `FileRead` | Read file contents with line ranges | Safe (read-only) |
| `FileWrite` | Create or overwrite files | Serialized |
| `FileEdit` | Exact string replacement in existing files | Serialized |
| `Glob` | Find files by pattern | Safe (read-only) |
| `Grep` | Search file contents by regex | Safe (read-only) |
| `Bash` | Execute shell commands | Serialized |

### Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Read-only tools auto-approve. Write tools and shell commands prompt for approval. |
| `acceptEdits` | File reads and writes auto-approve. Shell commands still prompt unless allowlisted. |
| `bypassPermissions` | All tools auto-approve **except** safety-critical paths (shell rc files, git metadata, assistant config). Those always prompt. |

### Transcript Model

- **Persisted message types:** user messages, assistant messages (text + tool_use blocks), tool results.
- **Storage format:** JSON Lines (one JSON object per message), stored per session in `~/.ultron/sessions/<session-id>/transcript.jsonl`.
- **Tool results:** Stored in full for v1. Summarization is deferred to compaction (Phase 10).
- **Compact boundaries:** When compaction runs, a synthetic `compact_summary` message replaces older messages. The original messages are archived but no longer loaded into context.
- **Resume:** Loading a session replays the transcript from the last compact boundary forward.

### Context Assembly

The prompt sent to the model is assembled from layered sources:

1. **Static system prompt** — identity, capabilities, behavioral rules (cacheable across turns)
2. **Dynamic system context** — current date, environment info, git status snapshot
3. **User context** — project instructions file (`ULTRON.md` in working directory, if present)
4. **Attachments** — injected after tool execution: edited file summaries, status deltas
5. **Conversation history** — user/assistant/tool_result messages from the transcript

A cache boundary separates static (1) from dynamic (2-5) sections to optimize API costs.

## Interaction Model

1. User types a prompt in the terminal.
2. Ultron streams the model response, rendering text and tool calls progressively.
3. When a tool call requires approval, Ultron pauses and presents a permission dialog showing tool name, arguments, and reason.
4. The user approves or denies. Approved tools execute; denied tools produce a structured error result.
5. The loop continues until the model emits no further tool calls.
6. The full exchange is persisted to the session transcript.

## Security Model

- Every tool call passes through: schema validation -> input validation -> permission check -> execution.
- No tool executes without passing all gates.
- Filesystem writes are bounded to the working directory (and any additional configured paths).
- Protected paths (shell configs, git internals, assistant config) always require explicit approval regardless of permission mode.
- Symlinks are resolved before permission checks to prevent bypass.
- Shell commands are classified and gated (allowlist for v1, AST-based classification for v2).
- Headless/SDK mode denies any action that would have prompted interactively.
