# Sandbox OS Implementation: macOS and Windows

## Status

Implementation in progress.

**Shipped:** types and settings layer, macOS Seatbelt mechanism (detection, profile generator, integration tests against real `sandbox-exec`), Windows policy module (permission-only or refuse), `BashTool` execution dispatch with PowerShell on win32, permission-only warning surfacing, friendliness hint for sandbox-blocked errors, and `~/.ultron/settings.json` integration via `ShellSandboxSettingsInput` + `mergeShellSandboxSettings` seeded by `QueryEngine`.

**Deferred to a separate phase:** extending `permission_decision` audit events with `ShellSandboxAudit`, network-domain enforcement via a local proxy, real Linux containment (Bubblewrap), real Windows containment (AppContainer / Job Objects).

Scope is limited to macOS and native Windows. Linux, WSL, and container-based Linux sandboxing are out of scope because Ultron does not currently support Linux.

## Source Basis

The key architectural point is that sandboxing is a second enforcement layer for spawned shell commands. It does not replace the permission model.

## Current Ultron Context

Ultron currently has an application-level permission flow around tool execution. The shell tool path is represented by `src/tools/BashTool.ts`, with permission and execution behavior coordinated through the core tool loop.

Ultron also has `src/sandbox/runtime.ts`, but that file refers to the CodeSandbox runtime used for hosted code execution. It should not be treated as the local shell OS sandbox. The shell sandbox described here should live under a separate namespace, such as `src/core/sandbox/`, to avoid mixing hosted runtime semantics with local process containment.

## Core Decision

Ultron should implement two different behaviors:

| Platform | Sandbox behavior | Security posture |
| --- | --- | --- |
| macOS | Use OS-level shell sandboxing for spawned shell commands | Permission model plus OS process/filesystem containment |
| Native Windows | No OS-level shell sandbox in this phase | Permission model only, or refuse execution when strict sandboxing is required |

This means Windows is not operating at the same OS sandbox layer as macOS in this design. On native Windows, Ultron must either:

1. fall back to permission-level controls and clearly report that the command is not OS-sandboxed, or
2. refuse the command when policy requires an OS sandbox.

It must not report native Windows shell commands as sandboxed unless a real Windows containment implementation is added later.

## Goals

- Run macOS shell commands through an operating-system-level sandbox.
- Keep permission checks before sandbox execution.
- Make native Windows behavior explicit: permission-only fallback or refusal.
- Prevent `autoAllowBashIfSandboxed` from applying unless a real OS sandbox is active.
- Preserve auditability: every shell command should record whether it ran sandboxed, unsandboxed by policy, or was refused because sandboxing was unavailable.
- Keep direct file tools protected by application-level path permissions, regardless of shell sandbox support.

## Non-Goals

- Linux, WSL, Bubblewrap, Seccomp, Docker, or VM sandbox support.
- Replacing Ultron's permission model.
- Treating Windows permission prompts as OS sandboxing.
- Implementing Windows AppContainer, low-integrity tokens, Job Object restrictions, or WDAC in this phase.
- Providing complete network domain isolation through the first macOS implementation.

## Security Model

Ultron should enforce shell execution in this order:

```text
tool_use request
-> tool schema validation
-> application permission checks
-> shell sandbox decision
-> platform execution strategy
-> audit event
-> tool_result
```

The permission model remains authoritative. A denied permission must stop execution before the sandbox layer is considered.

The sandbox layer is a containment layer for the spawned shell process and its descendants. It cannot protect direct file edits made by Ultron itself, so tools such as file write and file edit must continue to enforce path permissions in application code.

## Configuration Model

Add a shell sandbox configuration object. The names below are intentionally close to the Claude Code model but should be adapted to Ultron's settings system.

```ts
export type ShellSandboxSettings = {
  enabled: boolean
  failIfUnavailable: boolean
  autoAllowBashIfSandboxed: boolean
  allowUnsandboxedCommands: boolean
  excludedCommands: string[]
  filesystem: {
    allowWrite: string[]
    denyWrite: string[]
    allowRead: string[]
    denyRead: string[]
  }
  network: {
    allowedDomains: string[]
  }
}
```

`SettingsConfig` carries the user-facing shape as `shellSandbox?: ShellSandboxSettingsInput` — a deep-optional version of `ShellSandboxSettings` so a user can persist `{ failIfUnavailable: true }` or `{ filesystem: { denyWrite: ['custom.secret'] } }` without serializing the full schema. `mergeShellSandboxSettings(input, base?)` (in `src/core/sandbox/settings.ts`) folds the partial onto `defaultShellSandboxSettings` (or any baseline), with array leaves replacing wholesale and scalar leaves falling back to the base when unset. `QueryEngine` reads the persisted value at init and seeds `AppState.shellSandbox`; `BashTool.call` reads it from app state on every command. The `mergeSettings` function in `settingsConfig.ts` does per-field merging on the persisted form so writing one leaf does not erase siblings (mirroring the existing `webSearch.apiKeys` pattern).

`excludedCommands` matches against the command's resolved prefix using the same logic Ultron's `BashTool` already exposes via `extractCommandPrefix` (`src/tools/BashTool.ts:47-55`). For two-word subcommand tools (`git`, `npm`, `node`, `tsc`) the two-word prefix is matched first, then falls back to the bare verb. Substring matching is explicitly **not** supported — `excludedCommands: ['rm']` excludes `rm` and `rm -rf foo`, but does not match `vim` or `npm`.

Recommended defaults:

```ts
export const defaultShellSandboxSettings: ShellSandboxSettings = {
  // Enabled on darwin (real Seatbelt) and win32 (permission-only fallback so
  // the "not OS-sandboxed on Windows" warning actually surfaces). Disabled
  // on other platforms — there is no sandbox mechanism, so reaching the
  // `sandbox_disabled` branch keeps audit and UX clean.
  enabled: process.platform === 'darwin' || process.platform === 'win32',
  failIfUnavailable: false,
  autoAllowBashIfSandboxed: false,
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  filesystem: {
    allowWrite: ['.'],
    denyWrite: [
      '.ultron/settings',
      '.ultron/skills',
      '.env',
      '.ssh',
    ],
    allowRead: ['.'],
    denyRead: [],
  },
  network: {
    allowedDomains: [],
  },
}
```

For managed or strict environments, use:

```ts
{
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: false
}
```

`autoAllowBashIfSandboxed` should stay disabled until macOS sandbox tests prove the boundary is reliable for common developer workflows.

## Platform Decision Logic

Create a platform decision function instead of scattering platform checks through tool code.

```ts
export type ShellSandboxDecision =
  | {
      kind: 'sandboxed'
      platform: NodeJS.Platform
      mechanism: 'seatbelt' // future: 'bubblewrap' | 'job_object'
      reason: 'available'
    }
  | {
      kind: 'permissionOnly'
      platform: NodeJS.Platform
      reason:
        | 'native_windows_unsupported'
        | 'sandbox_disabled'
        | 'sandbox_unavailable_fallback'
        | 'unsupported_platform'
    }
  | {
      kind: 'refuse'
      platform: NodeJS.Platform
      reason:
        | 'sandbox_required_but_unavailable'
        | 'command_excluded'
        | 'native_windows_unsupported'
    }
```

The `mechanism` discriminator means a future Linux/Bubblewrap implementation can add a value without rewriting every consumer. `platform` widens to `NodeJS.Platform` to remove the `'darwin'`/`'win32'` literal lock-in.

Decision rules:

| Condition | Result |
| --- | --- |
| Permission model denies the command | Refuse before sandbox decision |
| `sandbox.enabled === false` | Run with permission model only |
| macOS and sandbox executable is available | Run sandboxed |
| macOS and sandbox unavailable with `failIfUnavailable === false` and `allowUnsandboxedCommands === true` | Run with permission model only, with audit warning |
| macOS and sandbox unavailable with strict policy | Refuse |
| native Windows with `allowUnsandboxedCommands === true` | Run with permission model only |
| native Windows with `allowUnsandboxedCommands === false` | Refuse |
| native Windows with `failIfUnavailable === true` | Refuse |
| Linux / other platform with `allowUnsandboxedCommands === true` | Run with permission-only and `unsupported_platform` reason |
| Linux / other platform with strict policy | Refuse with `sandbox_required_but_unavailable` |
| command matches `excludedCommands` | Do not sandbox; apply permission-only or refuse under strict policy |

## macOS Implementation

macOS should be the only OS-level shell sandbox implementation in this phase.

Use the macOS Seatbelt sandbox through `sandbox-exec`. Ultron should wrap shell commands rather than relying on shell aliases or user configuration.

Execution shape:

```text
sandbox-exec -p <generated-profile> /bin/bash -lc <user-command>
```

The user command remains a single string passed to `bash -c` — Ultron's `BashTool` already does this, and a free-form shell tool cannot avoid it. The rule applies to the `sandbox-exec` invocation itself: do not string-concatenate `sandbox-exec`, the profile, and the command into one shell line. The correct shape is:

```ts
execFile('sandbox-exec', ['-p', profile, '/bin/bash', '-c', userCommand])
```

Each of `sandbox-exec`, `-p`, the profile, `/bin/bash`, `-c`, and `userCommand` is its own argv entry. The user command may contain shell metacharacters; that is `bash`'s problem to interpret, not Ultron's to escape.

### macOS Components

Add these modules:

```text
src/core/sandbox/types.ts
src/core/sandbox/settings.ts
src/core/sandbox/manager.ts
src/core/sandbox/macosSeatbelt.ts
src/core/sandbox/windowsPolicy.ts
```

Note: `src/sandbox/runtime.ts` is unrelated — it hosts the worker-thread CodeSandbox runtime for `CodeSandboxTool`. The new shell-OS sandbox lives under `src/core/sandbox/` so the two concepts do not get conflated by name.

`types.ts` should define shared setting, decision, and audit types.

`settings.ts` should load and normalize sandbox settings.

`manager.ts` should expose the public API:

```ts
export interface ShellSandboxManager {
  getAvailability(): Promise<ShellSandboxAvailability>
  decideShellExecution(input: ShellSandboxInput): Promise<ShellSandboxDecision>
  wrapCommand(input: ShellSandboxWrapInput): Promise<ShellSandboxCommand>
}
```

`macosSeatbelt.ts` should:

- detect whether `sandbox-exec` is available;
- normalize allow and deny paths to absolute real paths;
- generate the Seatbelt profile;
- wrap the command invocation;
- map sandbox failures into user-facing errors and audit events.

### macOS Filesystem Policy

The first macOS implementation should focus on filesystem containment.

Baseline behavior:

- allow reads needed for normal shell startup and project inspection;
- allow writes to the current workspace;
- allow writes to Ultron-owned temporary directories;
- deny writes to Ultron settings and skill directories;
- deny writes to common sensitive files such as `.env`, `.ssh`, shell rc files, and credential stores unless explicitly allowed;
- deny writes outside configured writable roots.

Path resolution rules for `denyWrite`, `denyRead`, `allowWrite`, and `allowRead`:

- **Absolute path** (e.g. `/etc/hosts`) — used as-is.
- **Path starting with `~/`** — resolved against the user's home directory.
- **Bare relative path** (e.g. `.env`, `.ssh`, `.ultron/settings`) — expanded to **both** `<HOME>/<entry>` and `<workspace>/<entry>`, then deduplicated. This protects user dotfiles and checked-in secrets without forcing every entry to be listed twice.

"Workspace" is defined as the `cwd` Ultron passes to the spawned shell process. `BashTool.call` reads it via `resolveBashCwd(state)` (in `src/tools/BashTool.ts`), which prefers `AppState.workingDirectories[0]` and falls back to `process.cwd()` only when no working directory has been configured. The same value is used as both the `execFile` cwd *and* the sandbox workspace, so SDK callers passing a configured `cwd` to `QueryEngine` get the right execution dir *and* the right writable root. Resolve workspace once at decision time and pass the absolute path to the profile generator. Do not re-resolve `cwd` inside the profile generator.

**Path canonicalization.** Seatbelt's `(subpath ...)` is a literal string match against the kernel's canonical path. macOS aliases `/var` → `/private/var` and `/tmp` → `/private/tmp` via firmlinks, so an allow on `/var/folders` does **not** cover an access logged as `/private/var/folders`. The profile generator runs each resolved path through `realpathSync` once. For paths that don't exist yet (e.g., a `denyWrite` target for a file that hasn't been created), the generator walks up to the deepest existing ancestor, canonicalizes that, and re-joins the missing tail — otherwise a deny rule for `<workspace>/.env` written as `/var/folders/.../.env` silently misses the kernel's `/private/var/folders/.../.env` access.

Recommended writable roots:

```text
<workspace>
<ultron temp dir>
```

Do not use a broad home-directory write allowlist. Package managers and build tools that need cache directories should require explicit `allowWrite` entries.

### macOS Profile Generation

Generate the profile from structured data. Do not build policy from arbitrary user-provided profile text.

The shipped profile shape is:

```text
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "<implicit allowed write root>")) ...
(allow file-write* (subpath "<user allowed write root>")) ...
(deny file-write* (subpath "<denied write root>")) ...
(deny file-read* (subpath "<denied read root>")) ...
```

Implicit write roots: `tmpdir()`, `/private/tmp`, `/private/var/folders`, `/dev` — needed so common shell utilities, tty/null, and macOS per-user temp areas don't break under the deny-default flip for writes. User `allowWrite` entries append to the implicit list.

**Read enforcement.** `denyRead` rules emit `(deny file-read* (subpath ...))` after `(allow default)` so last-match-wins gives the deny precedence over the broad default allow. `allowRead` is currently a **no-op** because reads remain broadly allowed by `(allow default)` — flipping to deny-default for reads is too aggressive for v1 (it breaks shell startup, which needs to read `/bin`, `/usr`, dyld caches, etc.). The field is reserved in the type so a future hardening pass can use it without a schema change.

The profile generator has tests for:

- path escaping;
- path normalization (firmlink canonicalization, ancestor walk for missing paths);
- deny precedence over allow (writes and reads);
- workspace write allowance;
- sensitive path denial;
- temporary directory allowance.

Use generated profiles only as process arguments or temporary files owned by Ultron. If temporary files are used, create them with restrictive permissions and remove them after execution.

### macOS Network Policy

Do not claim domain-level network enforcement from Seatbelt alone in the initial implementation. Domain-aware network rules are difficult to enforce correctly at the OS profile layer because process network access is not naturally expressed as HTTP domains.

Recommended v1 behavior:

- keep network permission decisions in the application permission model;
- audit whether a shell command ran with network allowed or denied by policy;
- optionally deny all network from sandboxed shell commands if the generated Seatbelt profile can do so reliably.

Recommended later behavior:

- route sandboxed command network access through an Ultron-controlled local proxy;
- allow the sandboxed process to reach only the proxy;
- enforce domain allowlists in the proxy;
- record allowed and blocked domains in audit logs.

## Native Windows Implementation

Native Windows should not be treated as OS-sandboxed in this phase.

Claude Code's PowerShell behavior is the useful precedent: when sandboxing is enabled but no sandbox is available, strict policy refuses execution rather than silently pretending the command is contained.

Ultron should implement a Windows policy module with this behavior:

```ts
export function decideWindowsShellExecution(
  settings: ShellSandboxSettings,
): ShellSandboxDecision {
  if (!settings.enabled) {
    return {
      kind: 'permissionOnly',
      platform: 'win32',
      reason: 'sandbox_disabled',
    }
  }

  if (settings.failIfUnavailable || !settings.allowUnsandboxedCommands) {
    return {
      kind: 'refuse',
      platform: 'win32',
      reason: 'native_windows_unsupported',
    }
  }

  return {
    kind: 'permissionOnly',
    platform: 'win32',
    reason: 'native_windows_unsupported',
  }
}
```

### Windows User-Facing Behavior

`BashTool` invokes PowerShell on win32: `powershell.exe -NoProfile -Command <cmd>`. The shell selection lives in `src/tools/shellInvocation.ts::selectShellInvocation(platform)` and branches off `decision.platform`, not `process.platform` — so the platform path is unit-testable on a non-Windows dev box.

**Permission-only commands prepend a warning.** When `decision.kind === 'permissionOnly'` and `decision.reason !== 'sandbox_disabled'` (the user did not opt out), `annotateUnsandboxed` adds one line above the command output:

| Reason | Warning |
| --- | --- |
| `native_windows_unsupported` | `[ultron] Command ran without OS sandboxing — native Windows containment is not implemented.` |
| `sandbox_unavailable_fallback` | `[ultron] Command ran without OS sandboxing — sandbox-exec is unavailable on this macOS.` |
| `unsupported_platform` | `[ultron] Command ran without OS sandboxing — this platform has no supported sandbox mechanism.` |

`sandbox_disabled` deliberately suppresses the warning — the user explicitly turned containment off, so there is no surprise to surface.

When strict policy refuses execution, `BashTool.call` returns a structured refuse message:

| Reason | Message |
| --- | --- |
| `native_windows_unsupported` | `Refused: shell sandbox is required, but native Windows OS sandboxing is not implemented in Ultron.` |
| `sandbox_required_but_unavailable` | `Refused: shell sandbox is required by policy but is not available on this system.` |
| `command_excluded` | `Refused: command is in the sandbox excludedCommands list and unsandboxed execution is disallowed by policy.` |

This distinction matters. Permission prompts are authorization; they are not containment.

### Sandbox-block hint

When a `sandboxed` command exits non-zero with output matching one of `Operation not permitted`, `Permission denied`, `EACCES`, or `EPERM`, `maybeAppendSandboxHint` (in `BashTool.ts`) appends a single line pointing at the right config knob:

```text
[ultron hint] Sandbox may have blocked this. See "filesystem" rules in ~/.ultron/settings.json.
```

The hint only fires under `decision.kind === 'sandboxed'`; permission-only and refuse failures are not containment-related, so the hint would mislead there. The patterns are deliberately narrow — false positives just add a benign extra line on a real OS-permission error; false negatives would leave an ordinary user staring at a raw `EACCES` with no Ultron context.

### Windows Hardening in Permission-Only Mode

Because native Windows does not have OS containment in this phase, strengthen the application-level path:

- require explicit permission for shell commands unless a trusted allow rule matches;
- never auto-allow because of sandbox settings;
- treat shell metacharacters and command chaining conservatively;
- keep path-sensitive file operations in dedicated tools when possible;
- log unsandboxed command execution clearly;
- make strict policy available for users who prefer refusal over permission-only execution;
- **skip the bash-shaped prefix allowlist on win32.** `BashTool.checkPermissions` delegates to `checkBashPermissions(command, platform)` (in `src/tools/BashTool.ts`); on `'win32'` the `SAFE_COMMAND_PREFIXES` allow (e.g. `ls`, `cat`, `pwd`) is *not* applied, because PowerShell aliases those names to `Get-ChildItem` / `Get-Content` which traverse providers (`Env:`, `Cert:`, `Variable:`, registry hives). A bash-style read-only judgement does not transfer. Every non-operator command on win32 falls through to `ask`, and the user must approve explicitly.

## Bash Tool Integration

`src/tools/BashTool.ts` should call the sandbox manager after permission checks and before process execution.

Proposed flow:

```text
BashTool input
-> validate command
-> check application permissions
-> decide shell sandbox strategy
-> execute through platform shell executor
-> emit audit metadata
-> return tool_result
```

The shell executor should receive a structured execution plan:

```ts
export type ShellExecutionPlan =
  | {
      kind: 'sandboxed'
      command: string
      argv: string[]
      cwd: string
      environment: Record<string, string>
      sandboxProfileId: string
    }
  | {
      kind: 'permissionOnly'
      command: string
      argv: string[]
      cwd: string
      environment: Record<string, string>
      reason: string
    }
```

Avoid embedding sandbox decisions directly in UI code. UI should render the decision result produced by core code.

## Permission Rules

Permission rules and sandbox rules solve different problems.

Permission rules answer:

```text
May this tool call start?
```

Sandbox rules answer:

```text
What can the spawned process access after it starts?
```

Important invariants:

- Permission deny always wins.
- A sandbox allow rule must not override a permission deny.
- A direct file edit must not rely on shell sandbox policy.
- `autoAllowBashIfSandboxed` can apply only when `decision.kind === 'sandboxed'`.
- Native Windows can never satisfy `autoAllowBashIfSandboxed` in this phase.
- `excludedCommands` is a convenience control, not a security boundary.

## Audit Events

Add sandbox metadata to shell command audit records.

Suggested fields:

```ts
export type ShellSandboxAudit = {
  sandboxEnabled: boolean
  executionKind: 'sandboxed' | 'permissionOnly' | 'refused'
  platform: NodeJS.Platform
  reason: string
  writableRoots: string[]
  deniedRoots: string[]
  networkMode: 'notControlled' | 'denyAll' | 'proxyAllowlist'
}
```

These fields are not a new audit event type. They extend Ultron's existing `permission_decision` event in `src/core/queryEvents.ts`, which already carries `toolName`, `input`, `decision`, `reason`, and `userResponse`. Add `sandbox?: ShellSandboxAudit` to that event so a single record describes both the permission outcome and the containment outcome. Downstream `auditLog.ts` writes JSONL and will pick up the new field with no code change.

Audit examples:

```text
macOS sandboxed command:
executionKind=sandboxed
platform=darwin
reason=available

Windows permission-only command:
executionKind=permissionOnly
platform=win32
reason=native_windows_unsupported

Windows strict refusal:
executionKind=refused
platform=win32
reason=native_windows_unsupported
```

## Implementation Plan

1. Add sandbox settings and platform decision types.
2. Add a shell sandbox manager under `src/core/sandbox/`.
3. Implement native Windows policy as permission-only or refusal.
4. Implement macOS availability detection for `sandbox-exec`.
5. Implement macOS Seatbelt profile generation for filesystem write containment.
6. Route `BashTool` execution through the sandbox manager after permission checks.
7. Add audit metadata for sandboxed, permission-only, and refused commands.
8. Add UI messages for sandbox unavailable and Windows permission-only execution.
9. Add macOS integration tests guarded by `process.platform === 'darwin'`.
10. Keep network domain enforcement application-level until a proxy design is implemented.

## Test Plan

Unit tests:

- macOS decision returns `sandboxed` when sandboxing is enabled and available.
- macOS decision returns `permissionOnly` when sandboxing is unavailable and fallback is allowed.
- macOS decision returns `refuse` when sandboxing is unavailable and strict policy is enabled.
- Windows decision returns `permissionOnly` when fallback is allowed.
- Windows decision returns `refuse` when `failIfUnavailable === true`.
- Windows decision returns `refuse` when `allowUnsandboxedCommands === false`.
- `autoAllowBashIfSandboxed` does not apply to Windows.
- `excludedCommands` does not bypass strict refusal.
- generated macOS profile escapes and normalizes paths.
- sensitive deny paths override writable roots.
- `sandbox-exec` unavailable returns `permissionOnly` with `reason: 'sandbox_unavailable_fallback'` under default settings, and returns `refuse` under `failIfUnavailable: true`.

macOS integration tests:

- command can write inside the workspace;
- command can write inside Ultron temp directory;
- command cannot write to `/etc/hosts`;
- command cannot write to a denied settings path;
- command failure produces a clear sandbox violation result;
- audit record says `executionKind=sandboxed`.
- `permission_decision` audit record carries `sandbox.executionKind === 'sandboxed'` end-to-end through `query()` (mock the model, assert on the emitted event).

Windows tests:

- no OS sandbox wrapper is created;
- permission-only command includes `native_windows_unsupported` audit reason;
- strict policy refuses before process spawn;
- UI message does not claim OS sandboxing.

## Risk Areas

Seatbelt profile correctness is the main macOS risk. Profiles should be generated from structured policy, heavily tested, and kept conservative.

Shell wrapping is another risk. The user command must be passed as an argument to the shell executable. Do not construct one large interpolated command line.

Network control should not be overstated. A filesystem sandbox is useful, but domain-level network policy needs either application-level mediation or a proxy.

Developer tools often write outside the repository. The right fix is explicit writable roots for known cache directories, not disabling the sandbox globally.

Windows permission-only mode is not containment. The product should communicate that plainly and offer strict refusal for users who require sandboxed shell execution.

`sandbox-exec` itself is Apple-deprecated. It still ships and functions on macOS 14 and 15, but a future release may remove it or escalate the deprecation warning to a hard error. Ultron must detect ENOENT or a non-zero spawn from `sandbox-exec` and route through the existing `permissionOnly` (with audit warning) or `refuse` (under strict policy) branches. The availability check in `macosSeatbelt.ts` is the gate that protects Ultron from a future macOS that drops the binary.

## Recommended Initial Policy

For the first Ultron implementation:

```text
macOS:
  sandbox enabled by default
  filesystem write sandbox active for shell commands
  permission model still required before execution
  network enforcement remains application-level

native Windows:
  sandbox unavailable
  permission-only fallback allowed by default for local development
  strict mode refuses shell commands when sandbox is required
  no auto-allow based on sandbox settings
```

This gives Ultron real OS-level shell containment on macOS while keeping native Windows behavior honest and auditable.
