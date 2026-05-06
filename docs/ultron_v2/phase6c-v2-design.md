# Phase 6c Design: CodeSandbox

## Status

Shipped. Final test run: 1475 passed (1 skipped — friendly-install-hint test when Pyodide is absent). Final review pass closed: jsglobals lockdown, shared-budget output cap, UTF-8-safe truncation, REPL-style result display. Honest acknowledgement: Python WASM memory cap is best-effort (see "Python memory cap — honest limits" below). Plan: `~/.claude/plans/zazzy-growing-cocoa.md`.

## Context

v2-ROADMAP §6c calls for an ephemeral Python + JS execution tool with strict isolation:

- No access to user shell, `~/`, or the repo working directory.
- Per-call CPU + wall-clock + memory limits, hard kill on overrun.
- Output capped at 64 KB; overflow elided with an audit event.
- No persistent sandboxes.
- No package installs from arbitrary sources.

Pillar 6 split: **6a** shipped WebFetch + the per-host policy substrate; **6b** is in flight (WebSearch + `/web` slash + settings-file seeding); **6c** (this phase) adds CodeSandbox; **6d** adds first-class attachments. 6c depends on 3d (MCP permission/audit integration — done) and 2b (hooks — done).

The user explicitly asked the central design question up front: **"is it worth implementing the sandbox in Rust?"** The answer is no, and that decision shapes the rest of this doc. The runtime substrate is in-Node WASM-bound interpreters running inside `worker_threads`, branching on language inside the worker.

## The two load-bearing decisions

### 1. Not Rust

The Rust-via-npm distribution pattern (Biome, Oxc, SWC, Rolldown) requires 7+ prebuilt platform binaries (darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, linux-x64-musl, linux-arm64-musl, win32-x64-msvc), GitHub Actions cross-build matrix, macOS notarization (Apple Developer account), and Windows Authenticode. That tax pays off **only when Rust is the product** — when ≥30% of hot-path code is Rust, or when a single Rust component (parser, bundler) is the entire value prop.

For one sandbox tool in an otherwise pure-TypeScript codebase, every hour spent on a Rust release pipeline is an hour not spent on phases 6d, 7a–c, 8a–c, and Pa–c. The interesting Rust crates (`wasmtime`, `deno_core`) either give a runtime without an interpreter (you'd still need to embed Pyodide and QuickJS), or embed V8 — the same boundary `worker_threads` already provides.

Revisit Rust only if (a) the threat model becomes adversarial (it isn't — these are LLM-generated snippets), (b) sandbox throughput becomes a bottleneck (it won't for interactive snippet execution), or (c) a future phase independently needs Rust and amortizes the pipeline cost.

### 2. WASM-bound interpreters, not `node:vm`

Node's `vm` module documentation says, verbatim: *"The `vm` module is not a security mechanism. Do not use it to run untrusted code."* Worker threads add **isolation** (separate V8 isolate, separate JS heap) but do not sandbox `process`, `require`, `fs`, or any other Node global — those still exist in the worker by default and would have to be shadowed by hand. vm2 (the historical workaround) was deprecated in 2023 after a string of unfixable escapes.

Two languages, two WASM-bound interpreters:

- **JavaScript → QuickJS** via `quickjs-emscripten` (~1 MB WASM). Bellard's QuickJS compiled to WASM. No Node bindings exist inside the runtime by construction — `require`, `process`, `fs` are all `undefined`. Hard memory cap via `runtime.setMemoryLimit(bytes)`. Cooperative interrupt via `setInterruptHandler`. Battle-tested embeddable JS engine.
- **Python → Pyodide** (~30 MB WASM). CPython 3.12 compiled to WASM with numpy/pandas/scipy ported. No host filesystem unless explicitly mounted (MEMFS by default). Same WASM isolation property as QuickJS. **JS globals locked down via `loadPyodide({ jsglobals: {} })`** so `from js import process` / `fetch` / `require` / `Buffer` / `globalThis` all fail — without this, Pyodide's default would expose the host worker's `globalThis` (which in Node includes `process`, `Buffer`, `require`, etc.) into Python through the `js` module.

Both interpreters share the same harness: one `worker_threads.Worker` per call, instantiated via the inline `eval: true` form (no separate `worker.js` file → no test-vs-dist URL resolution drift). The worker branches on `language` inside its bootstrap. `worker.terminate()` from the parent is the unconditional hard-kill — it works against tight CPU loops the cooperative interrupt couldn't catch.

### Why a worker for both

QuickJS WASM bytecode and Pyodide WASM both block their host JS thread while executing. Without a worker, a `while(true){}` snippet would freeze the entire CLI until the cooperative interrupt fires — and Pyodide doesn't have a cooperative interrupt for tight C-extension loops at all. Putting both in a worker means `worker.terminate()` is the universal kill switch.

## Tool surface

`src/tools/CodeSandboxTool.ts`, registered after `WebSearchTool` in `createDefaultRegistry` at `src/core/tools/registry.ts:115`. Mirrors the WebFetchTool shape.

```ts
{
  language: 'python' | 'javascript',
  code: string,
  timeoutMs?: number,  // default 30_000, max 60_000
}
```

- `name: 'CodeSandbox'`
- `isMutating: false` (no host state mutation; the WASM heap dies with the worker)
- `isConcurrencySafe: () => true` (each call gets a fresh worker)
- No `getPath` / `getDomain` — CodeSandbox has no spatial scope. The cascade already supports tool-name-only rules (verified at `src/core/permissions/permissions.ts:151` — `findMatchingRules` matches when both `path` and `domain` are undefined).

## Runtime layer

```
src/sandbox/
├── runtime.ts            # SandboxOpts/Result types + runSandbox() entrypoint
├── workerBootstrap.ts    # exports BOOTSTRAP_SOURCE: string (the worker script)
├── outputCap.ts          # createHeadCap(maxBytes) → { append, value, truncated }
├── runtime.test.ts       # JS branch: hello-world, no-Node-globals, OOM, terminate
├── runtime.python.test.ts  # Python branch: gated on Pyodide presence
└── outputCap.test.ts
```

`runSandbox(opts)` spawns `new Worker(BOOTSTRAP_SOURCE, { eval: true, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } })`, posts the request, and races three terminators:

1. **Wall-clock** via `setTimeout(opts.timeoutMs)` → `worker.terminate()`.
2. **Caller abort** via `opts.signal` listener → `worker.terminate()`.
3. **Worker completion** via `'message'` listener → `worker.terminate()` (cleanup).

The result envelope: `{ stdout, stderr, truncated, timedOut, exitError? }`.

### Inside the worker (JS branch)

```
const { getQuickJS } = require('quickjs-emscripten')
const QuickJS = await getQuickJS()
const runtime = QuickJS.newRuntime()
runtime.setMemoryLimit(64 * 1024 * 1024)            // 64 MB hard cap
runtime.setInterruptHandler(() => false)            // cooperative kill (unused; terminate is the hard kill)
const ctx = runtime.newContext()
// wire console.log/error/warn → headCap via host functions
const result = ctx.evalCode(code)
// extract result, post {stdout, stderr, exitError}
```

Boundary asserts: inside the QuickJS runtime, `typeof require === 'undefined'`, `typeof process === 'undefined'`, `typeof globalThis.fs === 'undefined'`. These are unit tests, not assumptions.

### Inside the worker (Python branch)

```
let pyodide
try { pyodide = await import('pyodide') }
catch { return postMessage({ exitError: 'Python sandbox unavailable: install peer dep "pyodide" (npm install pyodide)' }) }
const py = await pyodide.loadPyodide({ stdout: cap.appendOut, stderr: cap.appendErr })
await py.runPythonAsync(code)
postMessage({ stdout: cap.outValue(), stderr: cap.errValue(), truncated: cap.truncated })
```

Memory bounding for Python is honest: WASM linear memory uses Pyodide's module defaults (configurable in a future phase). `worker.resourceLimits.maxOldGenerationSizeMb` caps V8's old-gen, not WASM linear memory. Wall-clock + `worker.terminate()` is the primary defense for runaway Python.

## Pyodide as an opt-in peer dep

`pyodide` is declared in `package.json` as:

```json
{
  "peerDependencies": { "pyodide": "^0.27.0" },
  "peerDependenciesMeta": { "pyodide": { "optional": true } }
}
```

**Not** `optionalDependencies` — npm installs optionalDeps by default; they only skip on platform mismatch or build failure, which would defeat the lean-install goal entirely. With the peer/optional pattern, npm warns (not errors) on missing install, and the first Python call surfaces a friendly install hint.

`quickjs-emscripten` is a regular `dependency` — it's small (~1 MB) and required for any JS sandbox call.

## Caps

| Cap | Value | Mechanism |
|---|---|---|
| Output bytes (TOTAL stdout+stderr) | 64 KB | One shared `ByteBudget` — UTF-8-safe head-preserving cut |
| Default timeout | 30 s | `setTimeout` → `worker.terminate()` |
| Max timeout | 60 s | input validation rejects above |
| JS memory | 64 MB | QuickJS `runtime.setMemoryLimit` (hard, enforced inside WASM) |
| Worker host heap | 256 MB | `Worker.resourceLimits.maxOldGenerationSizeMb` (belt-and-suspenders) |
| Python memory | best-effort 256 MB poll + Pyodide WASM max (~4 GB) | See "Python memory cap — honest limits" below |

The output cap is **head-preserving**, **UTF-8-safe**, and a **TOTAL** cap across stdout+stderr (single `ByteBudget` shared between both appenders). The roadmap says "capped" with "elided" overflow markers, which implies prefix preservation — a ring buffer would surprise users by keeping the tail. Mirrors the existing pattern in `src/hooks/runHook.ts:158-263` (`collectChildCapped`). UTF-8 handling: when a slice would land mid-sequence, walk back to the lead byte and drop the partial sequence rather than letting `Buffer.toString('utf8')` decode it as `U+FFFD` (3 bytes), which would push the result past the byte cap.

### Python memory cap — honest limits

The roadmap calls for "per-call memory limits, hard kill on overrun." This is **not fully delivered for Python** in 6c. The realities:

- **Pyodide's WASM linear memory is independent of V8 `resourceLimits`.** A worker's `maxOldGenerationSizeMb` caps V8's old-gen JS heap; it does not bound the WASM heap that Pyodide's CPython lives in.
- **In-worker `setInterval` polling cannot reliably interrupt tight Python loops.** Pyodide's `runPythonAsync` resolves through Promise microtasks (`asyncio.sleep(0)` → `Promise.resolve`). Microtasks starve the macrotask queue, so `setInterval(check, 100)` does not fire until Python is fully idle. A `bytes(N GB)` allocation in one Python opcode completes before any poll can observe it.
- **What we ship:** a best-effort polling check (kicks in for code that crosses real macrotask boundaries, e.g., `js.fetch` calls), plus Pyodide's compiled-in WASM max memory (~4 GB on a 64-bit host) as the eventual ceiling. The **rock-solid** cap is the parent's `setTimeout(timeoutMs)` → `worker.terminate()`: any Python execution lasting longer than the wall-clock cap is killed unconditionally.
- **What real enforcement would require:** running Pyodide in a `child_process.fork`'d Node process with `setrlimit(RLIMIT_AS)` (Linux) or platform-equivalent on macOS. That's a different threading model with measurable IPC overhead and is deferred to a future hardening phase.

QuickJS does not have this gap — `runtime.setMemoryLimit(64 MB)` is enforced synchronously inside the WASM heap allocator. JS memory bombs hit the cap before any host visibility issue.

## Permission integration

The cascade at `src/core/permissions/permissions.ts:151` (`findMatchingRules`) already supports tool-name-only rules — both `path` and `domain` parameters are optional. CodeSandbox uses this directly:

- First call: cascade falls through to `'ask'`. User answers `allow_by_rule` → session rule `{ toolName: 'CodeSandbox', behavior: 'allow' }` (no path, no domain).
- Subsequent calls: rule matches, no prompt.
- Skill activation: `src/skills/router.ts::filterToolDefs` does exact-name match on `'CodeSandbox'`. Skills with `allowed-tools: ['CodeSandbox']` permit; skills without it deny at `skillScope`. Verified during plan-phase exploration.

No new `PermissionRule` field needed. No new cascade branch needed.

## Audit integration

No new event variants. The existing `tool_call_started` / `tool_call_finished` events from `src/core/queryEventFactories.ts` cover lifecycle. Truncation and timeout surface as content markers in the `ToolResult`:

- `[output truncated at 64 KB]`
- `[killed: wall-clock timeout 30s]`

The runner's audit captures the result preview, including these markers. If finer-grained audit events become useful (e.g., a dedicated `sandbox_terminated` event with original output bytes), that's an additive change in a future phase.

## Tests

- `src/sandbox/outputCap.test.ts` — head-cap preserves first N bytes; appends past cap drop and set `truncated`.
- `src/sandbox/runtime.test.ts` — JS branch end-to-end: hello-world, boundary asserts (`require`/`process`/`fs` undefined inside QuickJS), `while(1){}` killed by `worker.terminate()` on timeout, `'x'.repeat(1e9)` rejected by QuickJS's 64 MB cap with an OOM error before the host process notices, output truncated past 64 KB, no globals leak between calls (each call gets a fresh worker + fresh QuickJS runtime).
- `src/sandbox/runtime.python.test.ts` — Python branch, gated on Pyodide present (`describe.skipIf(!hasPyodide)`): hello-world Python, `import os; os.listdir('/Users')` returns the MEMFS view (asserts no host paths leak), `while True: pass` killed at timeout, missing-Pyodide path returns the friendly install-hint error.
- `src/tools/CodeSandboxTool.test.ts` — input validation, permission shape, dispatch, error mapping. Mocks `runSandbox`.
- `tests/integration/codeSandbox.test.ts` — full pipeline through `authorizeToolUse` + `executeToolUse`, matching `tests/integration/webFetch.test.ts`. Proves first-call ask, `allow_by_rule` rule persistence, second-call no-prompt, skill `allowed-tools` intersection in both directions. End-to-end — not just the tool surface.

## Non-goals (mirrors v2-ROADMAP §6c "Does NOT do")

- **OS-level outer ring** (`sandbox-exec` / `bubblewrap`). Defense in depth is appealing, but the WASM/V8 boundary is the load-bearing one. Adding platform-specific code paths now is YAGNI.
- **Scratch-FS mount.** No way to pass files into the sandbox in 6c. If a snippet needs data, the model passes it inline as a string in `code`.
- **Package installs.** No `pip install`, no `npm install`. Stdlib + Pyodide's bundled scientific libraries only.
- **Long-lived / persistent sandboxes.** Each call is fresh.
- **Streaming stdout** during execution. Single result on completion. Streaming is a future enhancement when the runner gains a tool-progress channel.
- **Rust sidecar.** Explicitly rejected (see §1 above).

## Scope — what this sandbox does NOT secure

**The CodeSandbox boundary is the WASM heap.** It protects what runs *inside* `CodeSandboxTool` calls — Python snippets in Pyodide, JavaScript snippets in QuickJS. It does not extend any defense to other tools. Shell-spawned operations remain gated only by the permission cascade (ask-or-allow on the command string) and by the operator-prefix block in `BashTool.checkPermissions`. The proper defense-in-depth for shell — AST-aware classification, FS-safety integration, dangerous-pattern blocklist — is the parallel track Pa/Pb/Pc, which is unshipped at the time of this writing.

| Concern | Coverage in 6c | Where it lives |
|---|---|---|
| `BashTool` / shell command execution | **Not protected.** `BashTool` (`src/tools/BashTool.ts:64-136`) uses `execFile('/bin/bash', ['-c', cmd])` with permission-cascade gating only — no `sandbox-exec`, no `bubblewrap`, no seccomp. CodeSandbox cannot spawn shells (no `child_process` in QuickJS, no `/bin` in Pyodide MEMFS), so the new sandbox doesn't *create* a shell-attack surface, but it doesn't shrink the existing one either. | Roadmap **Pa** (shell AST) + **Pb** (FS-safety integration). |
| PowerShell on supported platforms | **Not supported at all.** No PowerShell tool exists. `BashTool` is hardcoded to `/bin/bash`. CLAUDE.md documents macOS/Linux only. | Out of project scope. |
| FS write scope of shell child processes | **Not enforced.** `workingDirectorySafetyCheck` (`src/core/permissions/filesystem.ts:198`) and `dangerousPathSafetyCheck` (line 171) only fire for tools that declare `getPath`. `BashTool` does not — there is no parser for shell command paths. | Roadmap **Pb** (per-node read/write classification + FS-safety integration). |
| Network access scope of shell child processes | **Not enforced.** `BashTool` does not declare `getDomain`. The 6a domain policy applies to `WebFetch`/`WebSearch` only; bash-spawned `curl` bypasses it. | Roadmap **Pb** (would extend AST classification to network calls) — not currently scoped. |
| High-risk paths and sandbox-escape patterns | **Partial.** `dangerousPathSafetyCheck` flags writes to a curated path list *for tools with `getPath`*. `BashTool` blocks shell operators (`>`, `\|`, `;`, `&`, backticks, `$()`, `${`) for unattended approval. WebFetch SSRF block (6a) rejects loopback/private/link-local hosts. **NOT shipped:** the curated dangerous-pattern blocklist (`curl … \| sh`, `rm -rf /`, traversal escapes, `dd if=/dev/…`, fork-bomb shape). | Roadmap **Pc** (dangerous-pattern pre-permission blocklist). |

## Risks and open questions

1. **QuickJS API surface for v0.31.** `quickjs-emscripten` is mature but not 1.0. The `getQuickJS()` / `newRuntime()` / `newContext()` / `evalCode()` shape has been stable across recent minor versions. If a breaking change lands, pin to `~0.31.0`.

2. **Pyodide cold-start latency** (~1–3 s). Each call spawns a fresh worker and re-loads Pyodide. Caching a warm worker between calls would help, but introduces lifecycle complexity (eviction, parallel calls) that's better left to a future "warm sandbox pool" phase if it becomes a real bottleneck. For interactive use, 1–3 s on first hit is acceptable.

3. **Worker `eval: true` security.** `BOOTSTRAP_SOURCE` is a hard-coded string constant in our own source, not user input. The `eval: true` flag is fine here — the alternative (a separate `worker.js` file) creates a test-vs-dist resolution problem with `import.meta.url` that has no clean answer in a `tsc`-compiled ESM project.

4. **Python memory enforcement is best-effort, not hard.** The full reasoning lives in the "Python memory cap — honest limits" section above. The roadmap's "memory cap with hard kill" is satisfied for JS (QuickJS hard cap) but NOT for Python in this phase. The wall-clock kill is rock-solid; Pyodide's WASM module max (~4 GB) is the only true ceiling on linear memory. A `child_process.fork` + OS rlimit refactor in a future phase can close this gap.

5. **No CPU limit per se.** "CPU limit" in the roadmap is satisfied by wall-clock — Node has no per-thread CPU quota on macOS. Linux cgroups would, but that's outer-ring work explicitly deferred.

6. **REPL-style result display in JS.** When the final expression in a JS snippet evaluates to a non-undefined value (e.g., `[1,2,3].map(x => x*x)`), it's printed to stdout automatically — matches user expectation for an interactive sandbox. Statements (`let x = 5`, `console.log(...)`) evaluate to undefined and print nothing extra. Python uses the explicit `print()` convention; no implicit display.
