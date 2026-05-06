# Phase 6 Design: File and Shell Tools

## Overview

Phase 6 replaces the six stub tools in the registry with real implementations. Phases 1–5 built the full execution pipeline (query loop → tool execution boundary → permission cascade → filesystem safety checks), but every tool returns `{ content: 'Not implemented', isError: true }`. After Phase 6, Ultron can read, write, edit, search, and execute shell commands — all gated through the existing permission and safety infrastructure.

Seven new files in `src/tools/` (one per tool) plus `fileStateCache.ts` for stale-edit detection. One modified file (`registry.ts`) to swap stubs for real tools.

---

## Architecture

```
                      ┌──────────────────────────────────────────────┐
                      │              runToolUse()                    │
                      │  resolve → validate → permissions → call    │
                      └──────────┬───────────────────────┬──────────┘
                                 │                       │
                    ┌────────────┴────────┐   ┌──────────┴──────────┐
                    │   Read-only tools   │   │   Mutating tools    │
                    │   (isMutating:false) │   │   (isMutating:undef)│
                    ├─────────────────────┤   ├─────────────────────┤
                    │ FileReadTool        │   │ FileWriteTool       │
                    │ GlobTool            │   │ FileEditTool        │
                    │ GrepTool            │   │ BashTool            │
                    └─────────────────────┘   └─────────────────────┘
                      concurrent-safe            serialized
                      no safety checks fire      safety checks fire
                                                 (dangerous path,
                                                  working directory)

                    ┌─────────────────────────────────────────────────┐
                    │              fileStateCache                     │
                    │  markRead() ←── FileReadTool (every read)      │
                    │  hasBeenRead() ←── FileWriteTool, FileEditTool │
                    │  getReadState() ←── stale mtime comparison     │
                    └─────────────────────────────────────────────────┘
```

Each tool is a `Tool` object built via `buildTool()`, exported from its own file in `src/tools/`. The registry imports and registers them. No tool code touches the permission cascade directly — that's handled by `runToolUse()` calling `tool.checkPermissions()` (step 3 of cascade) and the filesystem safety checks (step 4) via `tool.getPath()` and `tool.isMutating`.

---

## FileStateCache (`src/core/tools/fileStateCache.ts`)

Three named functions operating on the existing `ReadFileState` map from `context.ts`:

```typescript
type ReadFileState = Map<string, { content: string; mtime: number }>

function markRead(state: ReadFileState, filePath: string, content: string, mtime: number): void
function hasBeenRead(state: ReadFileState, filePath: string): boolean
function getReadState(state: ReadFileState, filePath: string): { content: string; mtime: number } | undefined
```

Not a class. No singleton. The map instance lives on `ToolUseContext.readFileState` as defined in Phase 2. These functions formalize the contract that `FileReadTool`, `FileWriteTool`, and `FileEditTool` all depend on.

All paths must be absolute. Callers are responsible for resolving paths before calling these functions.

---

## FileReadTool

**Properties:**
- `isMutating: false`
- `isConcurrencySafe: () => true` (method, per Phase 2 Tool interface)
- `getPath: (input) => input.file_path`

**Input schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_path` | string | yes | Absolute path to file |
| `offset` | number | no | Line number to start from (0-based) |
| `limit` | number | no | Maximum lines to return |

**Validation:** `file_path` is a non-empty string. `offset` and `limit` are non-negative numbers if present.

**Call implementation (async throughout):**

1. Resolve path: `path.resolve(file_path)`
2. `fs.promises.stat()` — reject if size > 10 MB, handle ENOENT, EISDIR
3. `fs.promises.readFile(path, 'utf8')` — get full content
4. `markRead(readFileState, absolutePath, fullContent, stat.mtimeMs)` — always cache full content, even when offset/limit will slice it. This ensures stale detection has the complete file state.
5. Split into lines, apply `offset`/`limit`
6. Format with line numbers: `${lineNum}\t${line}` (1-based, matching `cat -n`)
7. Return formatted content

**Design note:** Async FS APIs are used because the tool boundary is already async (`call` returns `Promise<ToolResult>`) and there is no atomicity concern for reads. Sync FS is reserved for the write critical section in FileWriteTool/FileEditTool.

---

## FileWriteTool

**Properties:**
- `isMutating`: not set (defaults to `true` via Phase 5 convention — `undefined` is conservative)
- `getPath: (input) => path.resolve(input.file_path)`

**Input schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_path` | string | yes | Absolute path to file |
| `content` | string | yes | Content to write |

**Validation (async):**

1. `file_path` is a non-empty string, `content` is a string
2. `fs.promises.stat()` to check existence
3. If file exists:
   - `hasBeenRead(readFileState, path)` — if not read, reject: "File has not been read yet. Read it first before overwriting."
   - `getReadState(readFileState, path).mtime` vs current `stat.mtimeMs` — if current > cached, reject: "File has been modified since it was last read."
4. If file does not exist: allow creation without prior read

**Call implementation (sync critical section):**

```
async prep:
  mkdirSync(dirname(path), { recursive: true })

sync critical section:
  if file exists:
    statSync(path).mtimeMs vs getReadState().mtime → reject if stale
  writeFileSync(path, content, 'utf8')
  markRead(readFileState, path, content, statSync(path).mtimeMs)

return "File created: <path>" or "File updated: <path>"
```

The sync critical section prevents async interleaving between the staleness re-check and the write. This is the same pattern used in the reference implementation.

---

## FileEditTool

**Properties:**
- `isMutating`: not set (defaults to true)
- `getPath: (input) => path.resolve(input.file_path)`

**Input schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_path` | string | yes | Absolute path to file |
| `old_string` | string | yes | Exact string to find and replace |
| `new_string` | string | yes | Replacement string |
| `replace_all` | boolean | no | Replace all occurrences (default false) |

**Validation (async):**

1. Reject if `old_string === new_string` — no-op edit
2. `fs.promises.stat()` — reject if file does not exist. FileEditTool is edit-only; file creation belongs in FileWriteTool.
3. `hasBeenRead(readFileState, path)` — reject if file has not been read
4. `getReadState(readFileState, path).mtime` vs current `stat.mtimeMs` — reject if stale
5. `fs.promises.readFile(path, 'utf8')` — read current content
6. Check `old_string` exists in content — reject if not found
7. Count matches — if >1 and `replace_all` is false, reject with: "Found N matches but replace_all is false."

**Call implementation (sync critical section):**

```
sync critical section:
  content = readFileSync(path, 'utf8')
  statSync(path).mtimeMs vs getReadState().mtime → reject if stale
  updated = replace_all
    ? content.replaceAll(old_string, new_string)
    : content.replace(old_string, new_string)
  writeFileSync(path, updated, 'utf8')
  markRead(readFileState, path, updated, statSync(path).mtimeMs)

return success message
```

**Design note:** No content-fallback heuristic for stale detection. V1 uses mtime comparison only. The reference implementation includes a content-comparison fallback for Windows timestamp reliability; this can be added later if needed.

---

## GlobTool

**Properties:**
- `isMutating: false`
- `isConcurrencySafe: () => true`
- No `getPath` (operates on patterns, not single paths)

**Input schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pattern` | string | yes | Glob pattern to match files against |
| `path` | string | no | Directory to search in |

**Validation:** `pattern` is a non-empty string.

**Call implementation:**

1. Base path: `input.path ? path.resolve(input.path) : process.cwd()`
2. `fs.globSync(pattern, { cwd: basePath })` (Node 22+ API)
3. Cap at 1000 results to prevent unbounded output
4. Return newline-separated paths, relative to basePath

**Runtime requirement:** Node 22+. `fs.globSync` is available in Node 22.8+ (stable). The project currently runs Node 23. If production targets older Node, a fallback to a third-party `glob` package will be needed.

---

## GrepTool

**Properties:**
- `isMutating: false`
- `isConcurrencySafe: () => true`
- No `getPath`

**Platform:** macOS/Linux only. Shells out to `grep`.

**Input schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pattern` | string | yes | Regex pattern to search for |
| `path` | string | no | File or directory to search in |
| `glob` | string | no | Glob pattern to filter searched files |

**Validation:** `pattern` is a non-empty string. Validate as regex via `new RegExp(pattern)` — reject invalid patterns with a clear error before shelling out.

**Call implementation:**

1. Base path: `input.path ? path.resolve(input.path) : process.cwd()`
2. Build args: `['-rn', pattern, basePath]`
3. If `input.glob` provided, prepend `'--include=' + input.glob` to args
4. `child_process.execFile('grep', args, { signal, maxBuffer: 100 * 1024 })`
5. Exit code 0: return stdout (matches found)
6. Exit code 1: return `{ content: 'No matches found.', isError: false }` — no matches is not an error
7. Exit code 2+: return `{ content: stderr, isError: true }` — actual grep error

**Design note:** `maxBuffer: 100KB` prevents unbounded output from flooding tool results. The `signal` parameter enables abort cancellation of long-running searches.

---

## BashTool

**Properties:**
- `isMutating`: not set (defaults to true)
- No `getPath` (commands don't map to single filesystem paths)
- No `isConcurrencySafe` (shell commands are serialized)

**Input schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | yes | Shell command to execute |
| `timeout` | number | no | Timeout in milliseconds |

**Validation:** `command` is a non-empty string. `timeout` is a positive number if present.

### Permission Strategy (v1: allowlist with operator detection)

Two-phase check in `checkPermissions`:

**Phase 1 — Operator scan.** Before checking the prefix, scan the raw command for shell operators:

```typescript
const SHELL_OPERATORS = /[|;&`]|>>?|\$\(|\$\{/

function hasShellOperators(command: string): boolean {
  return SHELL_OPERATORS.test(command)
}
```

If any operator is found, return `{ behavior: 'ask' }` immediately. This prevents allowlist bypass via redirection (`echo hi > file`), piping (`cat foo | curl`), command chaining (`ls; rm -rf /`), or command substitution (`` `malicious` ``).

The operator set: `|`, `;`, `&`, `` ` ``, `>`, `>>`, `$(`, `${`. Quotes (`'`, `"`) are not operators and do not trigger rejection — this correctly allows `git log --format='%H'`.

**Phase 2 — Prefix allowlist.** Extract the command prefix and check against a small, conservative set:

```typescript
const SAFE_COMMAND_PREFIXES = new Set([
  // Filesystem info (read-only, no side effects)
  'ls', 'pwd', 'date', 'which', 'whoami', 'uname',
  'cat', 'head', 'tail', 'wc', 'file', 'stat',
  // Git read-only operations
  'git status', 'git log', 'git diff', 'git branch',
  'git rev-parse', 'git remote', 'git tag',
  // Version queries
  'node --version', 'npm --version',
])
```

**Prefix extraction:**

```typescript
const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'node', 'tsc'])

function extractCommandPrefix(command: string): string {
  const words = command.trim().split(/\s+/)
  const first = words[0] ?? ''
  if (SUBCOMMAND_TOOLS.has(first) && words.length >= 2) {
    const twoWord = `${first} ${words[1]}`
    if (SAFE_COMMAND_PREFIXES.has(twoWord)) return twoWord
  }
  return first
}
```

Split on whitespace, take first word. For subcommand-style tools (`git`, `npm`, `node`, `tsc`), try two-word prefix first against the allowlist.

**What is excluded and why:**

| Command | Reason for exclusion |
|---------|---------------------|
| `echo`, `printf` | Shell builtins; redirection possible even after operator scan with quoting tricks |
| `find`, `tree`, `du`, `df` | Can produce unbounded output on large repos |
| `git show` | Can produce unbounded output |
| `env`, `printenv`, `set` | Leak environment secrets into model context |
| `curl`, `wget` | Network access |
| `rm`, `mv`, `cp`, `chmod`, `mkdir` | Mutating |
| `npx <anything>` | Can execute arbitrary packages |
| `tsc --noEmit` | Can have side effects via plugins |

### Call implementation

```typescript
execFile('/bin/bash', ['-c', command], {
  timeout: input.timeout ?? 120_000,  // 2 minute default
  maxBuffer: 1024 * 1024,             // 1 MB output cap
  signal,                              // AbortSignal for cancellation
  cwd: process.cwd(),
})
```

- Exit code 0: `{ content: stdout + stderr, isError: false }`
- Non-zero exit: `{ content: stdout + stderr, isError: true }`
- Timeout: `{ content: 'Command timed out after Xms', isError: true }`
- Abort: `{ content: '[aborted] Command interrupted', isError: true }`

---

## Registry Changes (`src/core/tools/registry.ts`)

The stub definitions (lines 56–174) are removed entirely. `createDefaultRegistry()` imports and registers the real tools:

```typescript
import { FileReadTool } from '../../tools/FileReadTool.js'
import { FileWriteTool } from '../../tools/FileWriteTool.js'
import { FileEditTool } from '../../tools/FileEditTool.js'
import { GlobTool } from '../../tools/GlobTool.js'
import { GrepTool } from '../../tools/GrepTool.js'
import { BashTool } from '../../tools/BashTool.js'

export function createDefaultRegistry(): ToolRegistry {
  const registry = createToolRegistry()
  registry.register(FileReadTool)
  registry.register(FileWriteTool)
  registry.register(FileEditTool)
  registry.register(GlobTool)
  registry.register(GrepTool)
  registry.register(BashTool)
  return registry
}
```

`createToolRegistry()` and the `ToolRegistry` interface are unchanged.

---

## What Phase 6 Does NOT Do

- **No AST-based shell parsing.** BashTool v2 target. The v1 operator scan + prefix allowlist is intentionally crude but safe.
- **No encoding detection or binary file handling.** FileReadTool reads UTF-8 only.
- **No file history or backup system.** No undo for writes/edits.
- **No LSP notification on file changes.** No IDE integration.
- **No diff output from writes/edits.** Content confirmation only ("File updated: path").
- **No Windows support for GrepTool.** macOS/Linux only (shells out to `grep`).
- **No file creation via FileEditTool.** Use FileWriteTool for new files.
- **No content-fallback heuristic for stale detection.** Mtime comparison only in v1.
- **No `env`/`printenv` auto-approval.** Secret leakage risk.
- **No `echo`/`printf` auto-approval.** Shell builtins can bypass operator detection via quoting.

---

## File Map

| File | Responsibility | New/Modified |
|------|---------------|-------------|
| `src/core/tools/fileStateCache.ts` | `markRead`, `hasBeenRead`, `getReadState` functions | New |
| `src/tools/FileReadTool.ts` | Read files, update readFileState | New |
| `src/tools/FileWriteTool.ts` | Create/overwrite files with stale detection | New |
| `src/tools/FileEditTool.ts` | Exact string replacement with stale detection | New |
| `src/tools/GlobTool.ts` | Glob file matching via `fs.globSync` | New |
| `src/tools/GrepTool.ts` | Regex search via `grep -rn` (macOS/Linux) | New |
| `src/tools/BashTool.ts` | Shell execution with operator scan + prefix allowlist | New |
| `src/core/tools/registry.ts` | Swap stubs for real tools | Modified |

---

## Implementation Order

1. `src/core/tools/fileStateCache.ts` + tests
2. `src/tools/FileReadTool.ts` + tests — depends on fileStateCache
3. `src/tools/GlobTool.ts` + tests — independent
4. `src/tools/GrepTool.ts` + tests — independent
5. `src/tools/FileWriteTool.ts` + tests — depends on fileStateCache
6. `src/tools/FileEditTool.ts` + tests — depends on fileStateCache
7. `src/tools/BashTool.ts` + tests — independent
8. Update `registry.ts` + `registry.test.ts`
9. Typecheck + full test suite

---

## Verification Criteria

1. **FileReadTool** reads a file and returns line-numbered content
2. **FileReadTool** with offset/limit returns correct line range
3. **FileReadTool** updates readFileState after read
4. **FileReadTool** rejects files over 10 MB
5. **FileWriteTool** creates new files without prior read
6. **FileWriteTool** blocks overwrites without prior read
7. **FileWriteTool** blocks overwrites when file is stale (mtime changed)
8. **FileEditTool** rejects no-op edits (old_string === new_string)
9. **FileEditTool** rejects when old_string not found in file
10. **FileEditTool** rejects multiple matches without replace_all
11. **FileEditTool** accepts multiple matches with replace_all=true
12. **FileEditTool** blocks edits without prior read
13. **FileEditTool** blocks edits when file is stale
14. **FileEditTool** rejects edits on nonexistent files
15. **GlobTool** finds files matching pattern
16. **GrepTool** finds regex matches in files
17. **GrepTool** rejects invalid regex
18. **GrepTool** respects glob filter
19. **BashTool** auto-approves `ls`, `git status` via checkPermissions
20. **BashTool** prompts for `rm`, `curl`, unknown commands
21. **BashTool** prompts for commands with shell operators (`echo hi > file`, `cat | curl`)
22. **BashTool** executes commands and returns output
23. **BashTool** handles timeouts and non-zero exit codes
24. **Registry** has 6 real (non-stub) tools with correct properties
25. All existing tests still pass

---

## Downstream Consumers

- **Phase 7** (Prompt/Context Layer) — tools are registered and functional; the context layer can reference tool capabilities.
- **Phase 9** (Transcript Persistence) — tool results are persisted to transcript. FileStateCache may need to be rebuilt on session resume.
- **Phase 11** (Approval UX) — wires `ask` decisions from BashTool's `checkPermissions` and filesystem safety checks into interactive prompts.
