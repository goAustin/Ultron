# CLI Design: Input Surface + ESC-to-Abort

## Status

Pre-implementation. Approved plan: `~/.claude/plans/add-a-new-function-wondrous-castle.md`.

This is a cross-cutting surface doc, not a phase. It documents how every input the user can give the interactive REPL (`node dist/cli.js`) influences Ultron's operation, and it introduces ESC as an in-flight abort signal.

## Context

Until now, the CLI surface is described only as a one-line hint at startup (`src/cli.ts:391`) and incidentally inside per-feature phase docs. As commands have accreted (`/model`, `/memory`, `/skill`, `/web`, `/mcp …`) the input surface has outgrown that one line. With the addition of **ESC-to-abort** — a soft interrupt that stops the agent mid-stream without killing the process — the surface deserves a single canonical document.

The REPL is a single readline loop in `src/cli.ts`. Every input routes through that loop and triggers either:

- a **local CLI handler** (slash command, parsed inline or delegated to a `src/cli/*.ts` module), or
- a **spine call** into `QueryEngine` (plain prompt → `engine.submitPrompt`, `/model` → `engine.setModel`, `/mcp …` → `engine.getMcpStatus` / `reloadMcp` / `listMcpTools`, etc.).

The same loop also brokers two non-line inputs the OS surfaces directly: `SIGINT` (Ctrl+C) and EOF (Ctrl+D).

## Goals

1. One place to look when answering "what does X do in the CLI?" — for users and for contributors adding the next slash command.
2. ESC as a first-class soft interrupt: stops the model stream, in-flight tools, and any open sub-prompt cleanly, **without** dropping the user's typed text.
3. No surprise re-entrancy bugs when ESC fires during a sub-prompt (`/model` menu, tool approval prompt) — the existing abort signal plumbing carries the cancellation, the CLI wrapper just has to not fight raw-mode toggling.

## Non-goals

- Multi-line input editor, command history search, completion, mouse, or paste-bracketing.
- Re-binding Ctrl+C to a soft interrupt. Ctrl+C remains a graceful process exit (`SIGINT` handler at `src/cli.ts:412`); ESC is the new soft path.
- Changing `permissionPrompt.ts` or `modelMenu.ts`. They already cancel on `signal.aborted`; the new wiring lives in `cli.ts`.
- New SDK surface or event types. `engine.abort()` (`src/sdk/QueryEngine.ts:889`) is the only existing API the new path consumes.
- Headless / piped-stdin parity for ESC. When `!isTTY`, raw mode is skipped and ESC handling is a no-op (matches the `modelMenu.ts:78` precedent). Slash commands and plain prompts still work line-by-line.

## State machine

The CLI is in exactly one of three states:

- **idle** — readline open, waiting for the next line at `you>`.
- **streaming** — readline closed, agent generator draining, ESC handler armed on raw stdin.
- **sub-prompt** — a raw-mode prompt (`promptForApproval`, `promptForModel`) owns stdin; the ESC handler is paused for the duration so it doesn't fight the sub-prompt's own raw-mode toggling.

```
   ┌──────────────────────────────────────────┐
   │                                          │
   ▼                                          │
 idle ──[plain text + Enter]──▶ streaming ────┘ [generator done → idle]
   ▲                              │  ▲
   │                         [ESC]│  │ [sub-prompt resolves]
   │                              ▼  │
   │                     abort + re-idle (with prefill)
   │                              │
   │                              ├──[tool needs approval]──▶ sub-prompt
   │                              ◀──────────────────────────────┘
   │
   └────[/model, /memory, /skill, /web]────▶ sub-prompt ──[resolve]──▶ idle
```

Slash commands that own stdin (`/model`, `/memory`, `/skill`, `/web`) transition idle → sub-prompt → idle directly without going through streaming, because they don't run the agent.

## Input → operation table

Every input the user can give the running CLI, the state in which it applies, the handler that owns it, and what it does to Ultron.

| Input | Applies in | Handler | Effect on Ultron |
|---|---|---|---|
| plain text + Enter | idle | `engine.submitPrompt(text)` (`src/cli.ts:307`) | starts a new agent turn; streams `QueryEvent`s to stdout (`text_delta`, `tool_use_start`, `tool_result`, `compaction_finished`, `error`); transitions to **streaming** |
| empty line | idle | inline (`cli.ts:127`) | re-prompts; no-op |
| `/quit`, `/exit` | idle | inline (`cli.ts:132`) | `engine.dispose()` then `process.exit(0)` |
| `/session` | idle | inline (`cli.ts:139`) | prints `engine.sessionId` |
| `/model` | idle | `promptForModel` (`src/ui/modelMenu.ts`) | raw-mode submenu listing every model from every registered provider; on confirm, `engine.setModel(choice)` and persist via `writeUserConfig({ lastModel })`; ESC inside the submenu cancels selection (model unchanged) |
| `/memory`, `/memory <args>` | idle | `handleMemoryCommand` (`src/cli/memoryCommand.ts`) | inspects/edits auto-memory under `~/.claude/projects/<slug>/memory/`; may spawn `$EDITOR` |
| `/skill`, `/skill <args>` | idle | `handleSkillCommand` (`src/cli/skillsCommand.ts`) | manages skill registry and activation state |
| `/web`, `/web <args>` | idle | `handleWebCommand` (`src/cli/webCommand.ts`) | reads/writes the domain allow/deny policy used by `WebFetch` and `WebSearch` |
| `/mcp status` | idle | `engine.getMcpStatus()` (`cli.ts:145`) | per-server connection state, tool count, retry timer |
| `/mcp reload` | idle | `engine.reloadMcp()` (`cli.ts:172`) | re-reads MCP config; reports diff (connected / failed / removed / disabled / unchanged / backoff / toolDefinitionsChanged) |
| `/mcp list-tools [server]` | idle | `engine.listMcpTools(server?)` (`cli.ts:192`) | enumerates registered MCP tools, optionally filtered by server |
| Y / N / arrows / Enter | sub-prompt (tool approval) | `promptForApproval` (`src/ui/permissionPrompt.ts`) | resolves the in-flight permission decision; cancels on `signal.aborted` |
| ↑ / ↓ / Enter / ESC | sub-prompt (model menu) | `promptForModel` (`src/ui/modelMenu.ts`) | navigate / confirm / cancel model choice |
| **ESC** | **streaming** | **`escAbort` (new) → `engine.abort()`** | **cancels the model stream, any in-flight tool, and any open sub-prompt; query loop returns `Terminal { reason: 'aborted' }`; CLI prints `[aborted — press Enter to send, or edit]` and re-prompts with the prior text pre-filled** |
| Ctrl+C (`SIGINT`) | any | `SIGINT` handler (`src/cli.ts:412`) | `engine.dispose()` then `process.exit(130)` — full process exit, distinct from ESC |
| Ctrl+D / EOF | idle | readline `close` | terminates the REPL loop |

## ESC-to-abort: the load-bearing details

### Why ESC, not Ctrl+C

Ctrl+C is already a process-level kill (`process.exit(130)`). Coopting it for soft-abort would either lose the kill semantics or surprise users who expect Ctrl+C to terminate the whole CLI. ESC is unbound today, has obvious "go back / cancel" semantics, and matches what `promptForModel` already uses inside its submenu (`src/ui/modelMenu.ts:176`).

### Distinguishing bare ESC from arrow keys

Arrow keys send `\x1B[A`, `\x1B[B`, etc. as a multi-byte sequence whose first byte is also bare ESC. Decision: a **50 ms debounce** — when `\x1B` arrives, set a timer; if any follow-up byte arrives before the timer fires, cancel the timer and treat the sequence as a non-ESC key. This is the same constant (`ESC_DEBOUNCE_MS = 50`) and pattern already used in `src/ui/modelMenu.ts:21`. Reusing the constant by lifting it into a shared module is a future cleanup, not a goal here.

### Coexistence with sub-prompts

`promptForApproval` and `promptForModel` set `setRawMode(true)` on entry and `setRawMode(false)` on cleanup. If our ESC listener kept its raw-mode lock during a sub-prompt, the sub-prompt's cleanup would silently turn raw mode off and the listener would stop receiving keys for the rest of the agent run.

The fix is local: wrap the `askUser` callback in `src/cli.ts:73` so it pauses the ESC controller before delegating to `promptForApproval` and resumes it in a `finally`. Both prompts already cancel on `signal.aborted`, so an ESC pressed *inside* a sub-prompt isn't lost — it just travels through the abort signal path instead of through our top-level listener. From the user's perspective ESC works identically in both states.

**Contributor rule** (also stated in §Risks): any future slash command that opens its own raw-mode prompt outside `askUser` must wrap that prompt in the same `escController.pause()` / `resume()` envelope, or it will leak raw-mode state. This is the price of keeping the ESC wiring local to `cli.ts`.

### Prompt preservation

`readline.Interface.write(string)` injects characters into the line buffer as if the user typed them, leaving the cursor at the end. After an aborted run, the CLI calls `prompt(trimmed)` and that helper, after `rl.question(...)`, calls `rl.write(prefill)` so the original prompt is editable in place. This covers the user's primary use case for ESC: *"I want to revise what I just submitted."* It also gracefully handles "ESC on a long answer I no longer need" — Enter resends as-is, Backspace clears, anything else edits.

`rl.write` is undocumented public Node API but stable across Node 18–22; flagged in §Risks for revisit if behavior changes.

### Abort message

Single line, yellow, bracketed, matching the existing convention from `cli.ts:230,318,335`:

```
[aborted — press Enter to send, or edit]
```

## File surface

| File | Change |
|---|---|
| `src/cli.ts` | Wrap `askUser`; install/detach `escController` around the agent generator drain; branch on `terminal.reason === 'aborted'`; thread `prefill` through `prompt()` |
| `src/cli/escAbort.ts` | **new** (~40 lines) — `installEscAbort(onEsc)` → `{ pause, resume, detach }` |
| `src/cli/escAbort.test.ts` | **new** — vitest unit tests using a `stream.PassThrough` cast to `ReadStream`: bare ESC fires after debounce; `\x1B[A` does not; `pause`/`resume` correctly toggle the listener; `detach` restores prior raw mode |
| `docs/cli-design.md` | **new** — this file |

## Tests

- **Unit (new).** `src/cli/escAbort.test.ts` covers the listener in isolation: ESC debounce, arrow-key suppression, `pause`/`resume`/`detach`, raw-mode restoration on detach.
- **Integration (existing, unchanged).** `src/sdk/QueryEngine.test.ts` already exercises the abort path end-to-end ("aborted terminal preserves the activation window", lines 884–931). The new feature reuses that path; no new integration test is needed at the engine layer.
- **Manual smoke (TTY).**
  1. Submit a long-running prompt, press ESC mid-stream → expect `[aborted — press Enter to send, or edit]` and the `you>` prompt pre-filled.
  2. Trigger a tool that requires approval, press ESC at the approval prompt → agent aborts cleanly, same pre-filled `you>`.
  3. Submit a trivial prompt, mash ESC during the very short stream → no race, no crash, either the stream finishes or aborts; `you>` returns either way.
- **Manual smoke (piped stdin).** `echo "hi" | node dist/cli.js` → ESC handler is a no-op, REPL processes the line and exits on EOF.

## Risks / open questions

1. **Raw-mode coexistence is a contributor contract.** Future slash commands that open their own raw-mode prompts outside `askUser` must wrap them in `escController.pause()` / `resume()`. There is no compile-time enforcement; the rule lives here and in code comments. If we add a third such command, lifting the wrapper into a shared helper inside `src/cli/` is the next refactor.
2. **`rl.write` is undocumented.** Stable in Node 18–22. If a future Node release changes line-buffer injection semantics, prompt preservation will break and the test in §Tests should catch it.
3. **`escAbort` constants duplicated.** `ESC_DEBOUNCE_MS = 50` is now defined in two places (`escAbort.ts` and `modelMenu.ts:21`). Acceptable for one round; lift to a shared module on the next touch.
4. **Concurrent ESC + natural completion.** If ESC fires in the same microtask that the generator yields its terminal value, we may print `[aborted ...]` for a turn that actually completed normally. Mitigation: branch only on `terminal.reason === 'aborted'`, never on a CLI-side `userAborted` flag — the engine is the source of truth. Listed for completeness; not expected to surface in practice.
