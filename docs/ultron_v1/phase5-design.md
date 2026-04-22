# Phase 5 Design: Filesystem Safety

## Overview

Phase 5 fills the empty `safetyChecks` slot from Phase 4 with two filesystem-aware safety checks: dangerous-path detection and working-directory containment. These checks sit at step 4 of the permission cascade — non-bypassable, even in `bypassPermissions` mode. They only fire for mutating tools, leaving read-only tools unrestricted.

One new file (`filesystem.ts`), plus minor additions to `types.ts` and `state.ts`.

---

## Architecture

```
tool.getPath?(input) → path
         │
         ├── tool.isMutating === false? → return null (no opinion)
         │
         v
getPathsToCheck(path)        ← symlink + parent resolution
         │
         ├── dangerousPathSafetyCheck
         │   (case-insensitive match against DANGEROUS_FILES/DIRECTORIES)
         │   → { behavior: 'ask', reason: { type: 'safetyCheck', message } }
         │
         ├── workingDirectorySafetyCheck
         │   (case-preserving containment via path.relative)
         │   → { behavior: 'ask', reason: { type: 'safetyCheck', message } }
         │
         └── both return null → cascade continues to step 5 (mode)
```

Both checks implement `SafetyCheck` from Phase 4: `(tool, input, context) => PermissionDecision | null`. They are plugged into `permissionOpts.safetyChecks` when wiring the production permission pipeline.

---

## Types

### Tool interface addition (`src/core/tools/types.ts`)

```typescript
interface Tool {
  // ... existing fields ...

  /**
   * Whether this tool mutates state (files, processes, etc.).
   * Filesystem safety checks only fire for mutating tools.
   * Default undefined = true (conservative).
   */
  readonly isMutating?: boolean
}
```

Also added to `ToolSpec` so `buildTool()` can pass it through.

### AppState addition (`src/core/state.ts`)

```typescript
type AppState = {
  readonly permissionMode: PermissionMode
  readonly permissionRules: PermissionRule[]
  readonly workingDirectories: readonly string[]  // new
}
```

Default: `[]`. When empty, the working-directory check returns `null` (no restriction configured).

---

## Constants (`src/core/permissions/filesystem.ts`)

### Dangerous Files

```typescript
const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
] as const
```

Shell rc files and git config — files that can execute code or exfiltrate data on shell startup or git operations.

Not included: `.mcp.json` (no MCP support yet), `~/.ssh/*` (future candidate when tools can operate outside the repo).

### Dangerous Directories

```typescript
const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  '.claude',
] as const
```

- `.git` — repository internals, hooks can execute code
- `.vscode` — `tasks.json` and `launch.json` can execute arbitrary commands
- `.idea` — JetBrains run configs can execute commands
- `.claude` — Ultron's own config; self-preservation

All of these trigger `ask`, not `deny`. The user can approve if intended.

---

## Path Utilities

### `getPathsToCheck(path: string): string[]`

Returns all paths that should be checked for a given input path. Handles symlink resolution.

- Resolves the input to an absolute path via `path.resolve()`
- Attempts `fs.realpathSync()` on the absolute path
  - If it succeeds and differs from the original, includes both
  - If it fails (file doesn't exist), resolves the nearest existing ancestor directory via walking up and retrying `realpathSync()`, then appends the remaining relative segments. This catches symlink escapes through parent directories (e.g., `/repo/symlinked-dir/newfile` where `symlinked-dir` → `/etc/`)
- Deduplicates the result

**Synchronous by design.** The `SafetyCheck` type signature is synchronous (`=> PermissionDecision | null`). The reference implementation also uses `realpathSync`. For a local-first CLI tool, this is acceptable. If async is needed later, the `SafetyCheck` type signature change is localized to `types.ts` and the loop in `permissions.ts`.

**TOCTOU gap (documented).** There is a time-of-check-time-of-use gap: a symlink could be created or changed between the permission check and the actual file operation. This is inherent to any symlink-based security check without kernel-level enforcement. Acceptable for a single-user assistant where the threat model is "prevent the model from accidentally touching sensitive files," not "defend against a concurrent attacker."

### `isDangerousPath(path: string): boolean`

Case-insensitive comparison against the dangerous names list only. Does not lowercase the full path.

- Splits the absolute path on the path separator
- Checks each segment against `DANGEROUS_DIRECTORIES` (case-insensitive)
- Checks the filename (last segment) against `DANGEROUS_FILES` (case-insensitive)
- Returns `true` if any match

### `isWithinDirectory(path: string, directory: string): boolean`

Case-preserving containment check. No blanket lowercasing — this avoids false positives on case-sensitive Linux filesystems.

- Both inputs resolved via `path.resolve()`
- macOS symlink normalization: `/private/var/` → `/var/`, `/private/tmp/` → `/tmp/`
- Compute `path.relative(directory, filePath)`
- Outside if: relative path starts with `..`, or is absolute
- Same path (`""`) counts as inside

---

## Safety Check Functions

### `dangerousPathSafetyCheck: SafetyCheck`

```typescript
(tool, input, context) => {
  if (tool.isMutating === false) return null
  const filePath = tool.getPath?.(input)
  if (!filePath) return null

  const paths = getPathsToCheck(filePath)
  for (const p of paths) {
    if (isDangerousPath(p)) {
      return {
        behavior: 'ask',
        reason: {
          type: 'safetyCheck',
          message: `${filePath} is a sensitive file that requires approval to edit`,
        },
      }
    }
  }
  return null
}
```

Returns `ask`, not `deny`. The user should be able to approve editing `.gitconfig` if they genuinely want to. Explicit deny rules (step 1 of the cascade) are the hard blocks.

### `workingDirectorySafetyCheck: SafetyCheck`

```typescript
(tool, input, context) => {
  if (tool.isMutating === false) return null
  const filePath = tool.getPath?.(input)
  if (!filePath) return null

  const workingDirs = context.appState.getState().workingDirectories
  if (workingDirs.length === 0) return null  // no restriction configured

  const pathsToCheck = getPathsToCheck(filePath)
  const resolvedWorkingDirs = workingDirs.flatMap(getPathsToCheck)

  const allInside = pathsToCheck.every(p =>
    resolvedWorkingDirs.some(wd => isWithinDirectory(p, wd))
  )

  if (!allInside) {
    return {
      behavior: 'ask',
      reason: {
        type: 'safetyCheck',
        message: `${filePath} is outside the allowed working directories`,
      },
    }
  }
  return null
}
```

All resolved forms of the path must be within at least one resolved form of a working directory. If any resolved path escapes, it's flagged.

### `filesystemSafetyChecks`

```typescript
export const filesystemSafetyChecks: readonly SafetyCheck[] = [
  dangerousPathSafetyCheck,
  workingDirectorySafetyCheck,
]
```

Convenience export. Production wiring plugs this into `permissionOpts.safetyChecks`.

---

## Integration Changes

### Where safety checks get wired in

Phase 5 does **not** change the cascade or `runToolUse()`. It creates the safety check functions and exports them. The production wiring point (wherever `PermissionOptions` is constructed and passed to `runToolUse()` or `createRunToolFn()`) imports `filesystemSafetyChecks` and passes them as `safetyChecks`.

Until a production entrypoint exists (Phase 7+), tests exercise the checks directly and via `hasPermissionsToUseTool()`.

### Existing tests

Tests constructing `AppState` gain `workingDirectories: []`. The `makeContext` helpers in `runToolUse.test.ts` and `toolOrchestration.test.ts` already use `bypassPermissions` mode. Since both safety checks return `null` for tools without `getPath` (which the test stubs don't have), existing tests pass without behavioral changes.

---

## What Phase 5 Does NOT Do

- **No glob/prefix matching for permission rules.** Exact match stays from Phase 4.
- **No Windows/UNC/8.3/ADS pattern detection.** macOS/Linux only for now.
- **No interactive approval UI.** "Ask" decisions return as error results. Phase 11.
- **No Bash command path extraction.** Bash has no `getPath`. Phase 6.
- **No `~/.ssh` protection.** Future candidate when tools can operate outside the repo.
- **No `.claude/` special-case allowlisting.** Worktrees, skills, etc. don't exist yet.
- **No read-tool restrictions.** Filesystem safety is write-only for now. The `isMutating` flag gates this explicitly.

---

## File Map

| File | Responsibility | New/Modified |
|------|---------------|-------------|
| `src/core/permissions/filesystem.ts` | Constants, path utilities, `SafetyCheck` implementations | New |
| `src/core/permissions/filesystem.test.ts` | Full coverage of path checks and safety functions | New |
| `src/core/tools/types.ts` | `isMutating` added to `Tool` and `ToolSpec` | Modified |
| `src/core/state.ts` | `workingDirectories` added to `AppState` | Modified |

---

## Implementation Order

1. `src/core/tools/types.ts` — add `isMutating` to `Tool` and `ToolSpec`, pass through in `buildTool()`
2. `src/core/state.ts` — add `workingDirectories` to `AppState`, update `getDefaultAppState()`
3. Fix any existing tests broken by `AppState` shape change
4. `src/core/permissions/filesystem.ts` — constants, path utilities, safety check functions
5. `src/core/permissions/filesystem.test.ts` — full test suite
6. Verify all existing tests still pass

---

## Verification Criteria

1. **Dangerous path blocks mutating tools** — mutating tool targeting `.bashrc` → ask, even in `bypassPermissions`
2. **Dangerous path ignores read-only tools** — tool with `isMutating: false` targeting `.bashrc` → null (no opinion)
3. **Case variations caught** — `.Git/config`, `.BASHRC` → detected as dangerous
4. **Working directory enforced** — mutating tool writing outside configured dirs → ask
5. **Working directory allows inside** — mutating tool writing inside → null
6. **Empty working dirs = no restriction** — `workingDirectories: []` → null
7. **Symlink to dangerous file caught** — `link.txt` → `.bashrc` → ask
8. **Symlink escape via parent caught** — `/repo/symlinked-dir/newfile` where dir → `/etc/` → ask
9. **macOS /private normalization** — `/private/tmp/file` treated as within `/tmp` working dir
10. **No getPath = no opinion** — tools without `getPath` pass through both checks
11. **Structured reasons** — every ask decision has `{ type: 'safetyCheck', message }` with meaningful text
12. **All existing tests pass** — no regressions from `AppState` shape change or `isMutating` addition

All tests use in-memory constructs. Symlink tests may use `fs.mkdtempSync` + `fs.symlinkSync` for real filesystem verification.

---

## Downstream Consumers

- **Phase 6** (Tool Implementations) — file tools set `isMutating: true`, read tools set `isMutating: false`. Tools implement `getPath()` to route through filesystem safety.
- **Phase 7+** (Production Wiring) — imports `filesystemSafetyChecks` into the `PermissionOptions` construction.
- **Phase 11** (Approval UX) — wires "ask" decisions from safety checks into interactive prompts.
