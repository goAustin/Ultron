# Ultron -- a personal assiatant that you need

Claude Code source files used as study material live under `reference/`, preserving their original relative paths for easy cross-referencing.

New implementation code lives under `src/`. v1 is complete — the v1 roadmap and per-phase designs are archived under [`docs/ultron_v1/`](docs/ultron_v1/). v2 direction lives in [`docs/v2-scope.md`](docs/v2-scope.md). v3 ships browser-based Computer-Use, **disabled by default**; see [`docs/computer-use.md`](docs/computer-use.md) for enabling, security, settings, and limitations, or [`docs/ultron_v3/v3-computer-use-plan.md`](docs/ultron_v3/v3-computer-use-plan.md) for the engineering plan.

The assistant is aligned to a **single-user personal assistant** scope:

- no multi-tenant model
- no shared/team memory
- no swarm teammate framework
- no cross-user collaboration features

## Reference Files

All Claude Code source copies are in `reference/`. Each file is categorized by how you should use it:

- **needed** — core execution spine and security boundary. First files to study; strongest candidates to extract into your own project.
- **reference** — important for understanding broader system design, but more tightly coupled to Claude Code's product behavior. Use for architecture reference, not direct copying.
- **directly-usable** — isolated modules with low coupling; realistic to adapt with light modification.

### Needed

| File | Purpose |
|------|---------|
| `reference/query.ts` | Main query loop (core execution) |
| `reference/query/deps.ts` | Dependency injection for query loop (also directly-usable) |
| `reference/query/config.ts` | Runtime configuration snapshot (also directly-usable) |
| `reference/Tool.ts` | Tool interface, types, registry utilities |
| `reference/services/tools/toolExecution.ts` | Tool execution boundary |
| `reference/services/tools/toolOrchestration.ts` | Batching and concurrency orchestration (also directly-usable) |
| `reference/utils/permissions/permissions.ts` | Permission decision engine |
| `reference/utils/permissions/filesystem.ts` | Filesystem safety checks |
| `reference/tools/FileEditTool/FileEditTool.ts` | Safe file editing |
| `reference/tools/FileWriteTool/FileWriteTool.ts` | Safe file writing |
| `reference/tools/BashTool/bashPermissions.ts` | Shell command permission classification and validation |

### Reference

| File | Purpose |
|------|---------|
| `reference/QueryEngine.ts` | SDK/session entrypoint |
| `reference/utils/queryContext.ts` | Cache-key prefix builder |
| `reference/constants/prompts.ts` | System prompt assembly |
| `reference/context.ts` | User/system context generation |
| `reference/utils/attachments.ts` | Dynamic attachment system |
| `reference/tools.ts` | Tool registry |
| `reference/tools/AgentTool/runAgent.ts` | Subagent runner |
| `reference/services/api/claude.ts` | API request building, `normalizeMessagesForAPI()`, retry/backoff, streaming. Critical for correct `tool_use`/`tool_result` pairing and thinking block handling. |
| `reference/services/compact/autoCompact.ts` | Token-threshold compaction trigger and compact boundary message injection. |
| `reference/state/AppStateStore.ts` | Reference for store responsibilities and mutation flow. Tightly coupled to Claude Code's React/Ink UI layer; study for the *what*, not the *how*. |

## Known Complexity Hotspots

These areas require disproportionate implementation effort relative to their line count in the ROADMAP:

1. **`reference/tools/BashTool/bashPermissions.ts` (1,663 lines)** — Shell AST parsing, semantic command classification, output redirection validation, pipe chain analysis. The single hardest tool to build safely.
2. **Message normalization** — Ensuring every `tool_use` has a matching `tool_result`, stripping UI-only messages, handling thinking blocks. Load-bearing logic spread across `reference/query.ts`, `reference/services/tools/toolExecution.ts`, and `reference/services/api/claude.ts`.
3. **Abort/interrupt handling** — `AbortController` propagation, partial tool result injection, clean state restoration. Touches the query loop, tool execution, and shell process management.

## Notes

1. The v1 execution plan is archived in [docs/ultron_v1/ROADMAP.md](docs/ultron_v1/ROADMAP.md); v2 scope is in [docs/v2-scope.md](docs/v2-scope.md).
2. Files in `reference/` preserve their original relative paths from Claude Code for easy cross-referencing.
3. Categories (needed / reference / directly-usable) indicate coupling level, not directory location.
