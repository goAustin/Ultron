# Ultron

A single-user CLI personal assistant powered by an LLM. Reads and writes files, runs shell commands, searches the web, and drives an opt-in browser, all under a permission model you control. Local-first, terminal-only, no telemetry.

Inspired by Claude Code's architecture, rebuilt from the ground up around a small, auditable agent loop with pluggable LLM providers.

```
ultron · gpt-5.4-mini                              ~/Projects/<your-project>
────────────────────────────────────────────────────────────────────────────

Hello.
I'm ultron — a small assistant that lives in your terminal.
I can run commands, read & write files, look things up on
the web, and explain code.

  ask        just type a question   /web      search the web
  /run       run a shell command    /help     see everything
  /read      open a file   ctrl-c   cancel · ctrl-d quit
```

## Features

- **Multi-provider** — Anthropic, OpenAI / OpenAI-compatible (OpenRouter, etc.), and MiniMax. Adding a provider is one file in `src/core/providers/`.
- **Hot model swap** — `/model` switches model mid-session; choice persists in `~/.ultron/config.json`.
- **Permission model** — every tool call passes schema validation, input validation, and a permission gate. Three modes: `default`, `acceptEdits`, `bypassPermissions`. Safety-critical paths (shell rc files, git internals, assistant config) always prompt regardless of mode.
- **Filesystem safety** — writes bounded to the working directory; symlinks resolved before checks; protected paths require explicit approval.
- **Bash gating and sandboxing** — commands are checked for shell operators, compared against a conservative read-only prefix allowlist, and optionally run inside the platform sandbox where available.
- **Session persistence** — transcripts, attachments, and tool results stored as JSONL under `~/.ultron/sessions/<id>/`. Resume from the last compaction boundary.
- **MCP servers** — connect external tool servers via the [Model Context Protocol](https://modelcontextprotocol.io/). `/mcp status`, `/mcp reload`, `/mcp list-tools`.
- **Memory** — long-term notes and project files via `/memory`. Skills via `/skill`.
- **Web** — search and fetch via `/web` (Brave / Tavily / DuckDuckGo fallback).
- **Computer-Use (opt-in)** — sandboxed Playwright Chromium with per-action approval and per-domain allowlist. **Disabled by default**. See [docs/computer-use.md](docs/computer-use.md).
- **No telemetry** — every byte of state lives on your machine.

## Install From Source

Requires Node.js ≥ 20.

```bash
git clone https://github.com/goAustin/Ultron.git
cd Ultron
npm install
npm run build
npm install -g .
```

That puts an `ultron` binary on your `PATH`. This repository is source-install only for now; there is no published npm package. Set at least one provider's API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # for Claude models
export OPENAI_API_KEY=sk-...               # for GPT / OpenAI-compatible models
export MINIMAX_API_KEY=...                 # for MiniMax models
```

(Optional) for richer web search:

```bash
export BRAVE_SEARCH_API_KEY=...   # https://brave.com/search/api
export TAVILY_API_KEY=...         # https://tavily.com
```

## Quick start

```bash
ultron
```

That's it — pick a model with `/model`, then ask anything. The first time you ask Ultron to edit a file or run a shell command, you'll see a permission prompt explaining what it wants to do and why.

### CLI flags

| Flag | Description |
|------|-------------|
| `--model <id>` | Override the model for this run. Otherwise reads `lastModel` from `~/.ultron/config.json`. |
| `--base-url <url>` | Custom OpenAI-compatible endpoint (e.g. OpenRouter, local LM Studio). |

## Slash commands

| Command | Description |
|---------|-------------|
| `/model` | Switch the active model (interactive picker). |
| `/init` | Creat project-level instructions `ULTRON.md`. |
| `/theme` | Switch theme (`light` / `dark`). |
| `/glyph` | Change the prompt glyph. |
| `/memory` | Manage long-term notes. |
| `/skill` | Manage skills. |
| `/web` | Search the web. |
| `/mcp status`, `/mcp reload`, `/mcp list-tools` | Inspect and manage MCP servers. |
| `/session` | Show the current session id. |
| `/clear` | Clear the screen. |
| `/help` | Show all commands. |
| `/quit`, `/exit` | Exit. |
| `esc` | Cancel a streaming reply (the prompt comes back pre-filled so you can edit). |

## Built-in tools

| Tool | Purpose |
|------|---------|
| `FileRead` | Read file contents (line ranges, image / PDF support). |
| `FileWrite` | Create or overwrite files. |
| `FileEdit` | Exact string replacement. |
| `Glob` | Find files by pattern. |
| `Grep` | Ripgrep-backed content search. |
| `Bash` | Run shell commands with permission gating and optional sandboxing. |
| `WebSearch`, `WebFetch` | Search the web; fetch a URL. |
| `OpenInBrowser` | Open a URL in the system browser. |
| `CodeSandbox` | Run Python (Pyodide) or JavaScript (QuickJS) in a sandbox. |
| `Memory*` | Read / write long-term memory. |
| `Agent` | Run a scoped subagent for delegated work. |
| `Computer*` | Browser automation (opt-in, see below). |

## Configuration

Config lives in `~/.ultron/`:

```
~/.ultron/
├── config.json          # last model, theme, glyph
├── settings.json        # feature toggles, web policy, permission rules
├── mcp.json             # optional MCP server definitions
├── hooks.json           # optional pre/post tool-use hooks
├── audit.jsonl          # every permission decision and tool call
├── sessions/            # per-session transcripts (JSONL)
├── memory/              # long-term memory files
└── skills/              # custom skills
```

Project-level instructions go in `ULTRON.md` at your working-directory root and are injected into the system prompt when present. Run `/init` to scaffold one.

## Permissions

| Mode | Behavior |
|------|----------|
| `default` | Read-only tools auto-approve. Writes and shell commands prompt. |
| `acceptEdits` | Reads and writes auto-approve. Shell commands still prompt unless allowlisted. |
| `bypassPermissions` | Everything auto-approves **except** safety-critical paths, which always prompt. |

Every decision is recorded in `~/.ultron/audit.jsonl` with a timestamp, tool name, input hash, and outcome.

## Security And Privacy

Ultron does not include product telemetry, analytics, or a hosted control plane. Local state is written under `~/.ultron/`, and project instructions are read from `ULTRON.md` in the working directory.

Prompts, selected file contents, tool results, and web/browser observations can still be sent to the LLM provider or search provider you configure. Treat permission prompts as the security boundary: review proposed file edits, shell commands, web fetches, and browser actions before approving them.

Computer-Use is disabled by default, uses a fresh Playwright browser context, wipes cookies/storage on stop, and applies per-domain navigation approval. See [docs/computer-use.md](docs/computer-use.md) for the full security model and limitations.

## Computer-Use (opt-in)

Browser automation via Playwright Chromium. **Disabled by default.** To enable:

```bash
npx playwright install chromium
```

```jsonc
// ~/.ultron/settings.json
{
  "computerUse": {
    "enabled": true
  }
}
```

The first navigation to an unknown host triggers a runtime **Allow once / Allow by rule / Deny once** prompt. Approved hosts persist to `computerUse.allowedDomains`. Cookies and storage wipe on every `ComputerStop`.

Full reference: [docs/computer-use.md](docs/computer-use.md).

## Architecture

The load-bearing spine is an async generator (`query()`) under `src/core/`:

```
src/core/
├── query.ts              # main agent loop (LoopState, not recursion)
├── normalizeMessages.ts  # 5-step pipeline run before every API call
├── messages.ts           # internal message types (no SDK imports)
├── providers/            # per-provider adapters (anthropic, openai, minimax)
└── tools/                # tool execution boundary
```

Provider SDKs are isolated to `src/core/providers/<name>Adapter.ts`. All other code uses the internal message format and resolves models through `src/core/providers/registry.ts`. Adding a provider is one adapter file plus one line in the registry.

## Development

```bash
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run test:watch   # vitest
```

Run a single test file:

```bash
npx vitest run src/core/query.test.ts
```

Run the Playwright integration suites (env-gated):

```bash
ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run src/core/computer/playwrightBrowserSession.integration.test.ts
ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run tests/integration/phase6Acceptance.integration.test.ts
```

Path alias: `@/*` maps to `./src/*`. ESM only — imports use `.js` extensions.

## Project status

- **v1** (core agent loop, tools, permissions, sessions, MCP) — complete. Roadmap and per-phase designs archived under [docs/ultron_v1/](docs/ultron_v1/).
- **v2** (multi-provider, hot model swap, memory, skills) — complete. Scope: [docs/ultron_v2/v2-scope.md](docs/ultron_v2/v2-scope.md).
- **v3** (browser-based Computer-Use) — shipped, opt-in. Engineering plan: [docs/ultron_v3/v3-computer-use-plan.md](docs/ultron_v3/v3-computer-use-plan.md).

Out of scope, by design: multi-tenant model, shared / team memory, swarm teammate framework, cross-user collaboration.

## Contributing

Issues and PRs welcome. Before opening a PR:

1. `npm run typecheck && npm run test` must pass.
2. Add or update tests for behavior changes.
3. Keep provider SDK imports inside `src/core/providers/` — no leakage elsewhere.

For vulnerability reports, avoid posting exploit details in a public issue. Use GitHub's private vulnerability reporting flow if it is enabled for the repository, or contact the maintainer privately first.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

Architecturally inspired by [Claude Code](https://www.anthropic.com/claude-code).
