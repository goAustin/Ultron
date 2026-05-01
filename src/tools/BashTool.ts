/**
 * BashTool — execute shell commands with permission gating.
 *
 * v1 permission strategy: operator scan + prefix allowlist.
 * 1. Reject (ask) any command with shell operators (>, |, ;, &, `, $( , ${)
 * 2. Check first word (or two-word prefix for subcommand tools) against allowlist
 * 3. Unknown commands → ask
 *
 * Shell binary is selected per-platform: `/bin/bash -c` on macOS/Linux,
 * `powershell.exe -NoProfile -Command` on native Windows. On macOS, when
 * sandboxing is enabled and `sandbox-exec` is available, the bash
 * invocation is wrapped in a Seatbelt profile generated from
 * `ShellSandboxSettings`. The sandbox decision is the second enforcement
 * layer — permission gating upstream still has the final say on whether
 * the command runs at all.
 *
 * Native Windows has no OS-level sandbox in this phase; commands run
 * with permission-only enforcement and surface a warning so the user
 * sees that containment was not applied.
 */

import { execFile } from 'child_process'

import { decideShellExecution } from '../core/sandbox/manager.js'
import { buildSeatbeltArgv, generateSeatbeltProfile } from '../core/sandbox/macosSeatbelt.js'
import { defaultShellSandboxSettings } from '../core/sandbox/settings.js'
import type {
  ShellSandboxDecision,
  ShellSandboxSettings,
} from '../core/sandbox/types.js'
import type { AppState } from '../core/state.js'
import { buildTool } from '../core/tools/types.js'
import { selectShellInvocation } from './shellInvocation.js'

// ---------------------------------------------------------------------------
// Permission constants
// ---------------------------------------------------------------------------

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

const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'node', 'tsc'])

/**
 * Detect shell operators that could allow side effects even in
 * otherwise-safe commands (e.g., `cat foo > bar`, `ls | curl`).
 */
const SHELL_OPERATORS = /[|;&`]|>>?|\$\(|\$\{/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hasShellOperators(command: string): boolean {
  return SHELL_OPERATORS.test(command)
}

export function extractCommandPrefix(command: string): string {
  const words = command.trim().split(/\s+/)
  const first = words[0] ?? ''
  if (SUBCOMMAND_TOOLS.has(first) && words.length >= 2) {
    const twoWord = `${first} ${words[1]}`
    if (SAFE_COMMAND_PREFIXES.has(twoWord)) return twoWord
  }
  return first
}

export type BashPermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'ask'; message: string }

/**
 * Pure permission check, parameterized on platform so PowerShell's provider
 * semantics don't piggy-back on the bash-shaped allowlist.
 *
 * The bash allowlist (`ls`, `cat`, `pwd`, etc.) is *only* applied when the
 * spawned shell is bash. On native Windows the same prefixes route through
 * PowerShell, where `ls Env:`, `cat Variable:GLOBAL`, or
 * `Get-ChildItem Cert:\` traverse providers (registry, env, certificate
 * store) — that's well outside what the prefixes were judged read-only
 * for. On `win32` the operator scan still applies; everything else falls
 * through to `ask`.
 */
export function checkBashPermissions(
  command: string,
  platform: NodeJS.Platform,
): BashPermissionResult {
  if (hasShellOperators(command)) {
    return { behavior: 'ask', message: `Shell command requires approval: ${command}` }
  }
  if (platform !== 'win32') {
    const prefix = extractCommandPrefix(command)
    if (SAFE_COMMAND_PREFIXES.has(prefix)) {
      return { behavior: 'allow' }
    }
  }
  return { behavior: 'ask', message: `Shell command requires approval: ${command}` }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 120_000 // 2 minutes
const MAX_BUFFER = 1024 * 1024  // 1 MB

export const BashTool = buildTool({
  name: 'Bash',
  description: 'Execute a shell command via /bin/bash -c. Returns stdout and stderr.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds' },
    },
    required: ['command'],
  },

  async validateInput(input) {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      return { valid: false, message: 'command must be a non-empty string' }
    }
    if (input.timeout !== undefined && (typeof input.timeout !== 'number' || input.timeout <= 0)) {
      return { valid: false, message: 'timeout must be a positive number' }
    }
    return { valid: true }
  },

  async checkPermissions(input) {
    const command = (input.command as string).trim()
    return checkBashPermissions(command, process.platform)
  },

  async call(input, context, signal) {
    const command = (input.command as string).trim()
    const timeout = typeof input.timeout === 'number' ? input.timeout : DEFAULT_TIMEOUT

    const state = context.appState.getState()
    const cwd = resolveBashCwd(state)
    const settings = state.shellSandbox ?? defaultShellSandboxSettings
    const decision = await decideShellExecution({ settings, command })

    if (decision.kind === 'refuse') {
      return { content: refuseMessage(decision), isError: true }
    }

    const plan = buildBashExecutionPlan(decision, command, settings, cwd)

    return new Promise((resolve) => {
      execFile(
        plan.executable,
        plan.args,
        { timeout, maxBuffer: MAX_BUFFER, signal, cwd },
        (err, stdout, stderr) => {
          if (err) {
            // Abort
            if (signal.aborted) {
              resolve({ content: '[aborted] Command interrupted', isError: true })
              return
            }
            // Timeout
            if ('killed' in err && err.killed) {
              resolve({ content: `Command timed out after ${timeout}ms`, isError: true })
              return
            }
            // Non-zero exit
            const output = (stdout + (stderr ? '\n' + stderr : '')).trim()
            const annotated = annotateUnsandboxed(decision, output || err.message)
            const hinted = maybeAppendSandboxHint(decision, annotated)
            resolve({ content: hinted, isError: true })
            return
          }

          const output = (stdout + (stderr ? '\n' + stderr : '')).trim()
          resolve({ content: annotateUnsandboxed(decision, output), isError: false })
        },
      )
    })
  },
})

/**
 * Resolve the cwd a shell command should run in. Prefers the first entry
 * of `AppState.workingDirectories` (the SDK / engine surface for "the
 * project we're operating on") and falls back to `process.cwd()` only
 * when no working directory has been configured. This same value is used
 * as both the execFile cwd *and* the sandbox workspace, so a configured
 * cwd is consistently the writable root.
 */
export function resolveBashCwd(state: AppState): string {
  return state.workingDirectories[0] ?? process.cwd()
}

export type BashExecutionPlan = {
  readonly executable: string
  readonly args: readonly string[]
}

/**
 * Construct the argv shape for an executable BashTool decision (i.e.
 * `sandboxed` or `permissionOnly` — `refuse` is handled before this
 * runs). Pure: no I/O, no `process.platform` reads, no spawning. The
 * branch is driven entirely by `decision.platform` so unit tests can
 * synthesize either platform without stubbing globals.
 */
export function buildBashExecutionPlan(
  decision: Exclude<ShellSandboxDecision, { kind: 'refuse' }>,
  command: string,
  settings: ShellSandboxSettings,
  cwd: string,
): BashExecutionPlan {
  if (decision.kind === 'sandboxed') {
    const { profile } = generateSeatbeltProfile({ workspace: cwd, settings })
    const argv = buildSeatbeltArgv(profile, command)
    return { executable: argv.executable, args: [...argv.args] }
  }
  const shell = selectShellInvocation(decision.platform)
  if (decision.platform === 'win32') {
    return {
      executable: shell.executable,
      args: ['-NoProfile', shell.argFlag, command],
    }
  }
  return { executable: shell.executable, args: [shell.argFlag, command] }
}

/**
 * Prepend a one-line warning to command output when the command ran
 * without OS sandboxing despite the sandbox layer being intended to
 * apply. Skipped when the user explicitly disabled sandboxing
 * (`sandbox_disabled`) — in that case there's no surprise to surface.
 */
export function annotateUnsandboxed(
  decision: ShellSandboxDecision,
  output: string,
): string {
  if (decision.kind !== 'permissionOnly') return output
  if (decision.reason === 'sandbox_disabled') return output
  const warning = unsandboxedWarning(decision.reason)
  return output.length > 0 ? `${warning}\n${output}` : warning
}

/**
 * Substring patterns that look like an OS permission/Seatbelt block. We
 * keep the list short and high-signal — false positives just append a
 * hint to a real error, which is acceptable; false negatives leave a
 * confused user staring at a raw EACCES with no Ultron context, which
 * is the case we're solving.
 */
const SANDBOX_BLOCK_PATTERNS: readonly RegExp[] = [
  /operation not permitted/i,
  /permission denied/i,
  /\bEACCES\b/,
  /\bEPERM\b/,
]

/**
 * Append a one-line hint pointing at `~/.ultron/settings.json` when a
 * sandboxed command exits non-zero with an error that looks like an OS
 * permission/Seatbelt block. Only fires under `decision.kind ===
 * 'sandboxed'` — `permissionOnly` and `refuse` failures are not
 * containment-related, so the hint would be misleading there.
 */
export function maybeAppendSandboxHint(
  decision: ShellSandboxDecision,
  output: string,
): string {
  if (decision.kind !== 'sandboxed') return output
  if (output.length === 0) return output
  const looksLikeBlock = SANDBOX_BLOCK_PATTERNS.some((re) => re.test(output))
  if (!looksLikeBlock) return output
  return `${output}\n[ultron hint] Sandbox may have blocked this. See "filesystem" rules in ~/.ultron/settings.json.`
}

function unsandboxedWarning(
  reason: Exclude<
    Extract<ShellSandboxDecision, { kind: 'permissionOnly' }>['reason'],
    'sandbox_disabled'
  >,
): string {
  switch (reason) {
    case 'native_windows_unsupported':
      return '[ultron] Command ran without OS sandboxing — native Windows containment is not implemented.'
    case 'sandbox_unavailable_fallback':
      return '[ultron] Command ran without OS sandboxing — sandbox-exec is unavailable on this macOS.'
    case 'unsupported_platform':
      return '[ultron] Command ran without OS sandboxing — this platform has no supported sandbox mechanism.'
  }
}

function refuseMessage(decision: ShellSandboxDecision & { kind: 'refuse' }): string {
  switch (decision.reason) {
    case 'sandbox_required_but_unavailable':
      return 'Refused: shell sandbox is required by policy but is not available on this system.'
    case 'command_excluded':
      return 'Refused: command is in the sandbox excludedCommands list and unsandboxed execution is disallowed by policy.'
    case 'native_windows_unsupported':
      return 'Refused: shell sandbox is required, but native Windows OS sandboxing is not implemented in Ultron.'
  }
}
