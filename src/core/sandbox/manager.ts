/**
 * Shell-sandbox decision manager.
 *
 * The single entry point — `decideShellExecution` — turns settings + a
 * candidate shell command into a `ShellSandboxDecision`. The platform
 * branches are kept thin; macOS is the only branch that actually probes
 * the filesystem (for `sandbox-exec`).
 *
 * Permission-cascade gating happens upstream in
 * `src/core/permissions/permissions.ts`. By the time `decideShellExecution`
 * runs, the command has already been authorized to start; the question
 * here is only "what containment shape does it run in?".
 *
 * `excludedCommands` matches the resolved verb (or two-word verb for
 * `git`/`npm`/`node`/`tsc`) — the same shape `BashTool.extractCommandPrefix`
 * already produces for permission decisions, but extended so that listing
 * `git push` in `excludedCommands` matches even though the cascade itself
 * never special-cases that pair.
 */

import { detectSandboxExec } from './macosSeatbelt.js'
import type { ShellSandboxDecision, ShellSandboxSettings } from './types.js'
import { decideWindowsShellExecution } from './windowsPolicy.js'

export type DecideShellExecutionInput = {
  readonly settings: ShellSandboxSettings
  readonly command: string
  readonly platform?: NodeJS.Platform
}

const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'node', 'tsc'])

export function commandMatchesExcluded(
  command: string,
  excluded: readonly string[],
): boolean {
  if (excluded.length === 0) return false
  const words = command.trim().split(/\s+/).filter((w) => w.length > 0)
  const first = words[0] ?? ''
  if (first === '') return false
  if (excluded.includes(first)) return true
  if (words.length >= 2 && SUBCOMMAND_TOOLS.has(first)) {
    const twoWord = `${first} ${words[1]}`
    if (excluded.includes(twoWord)) return true
  }
  return false
}

export async function decideShellExecution(
  input: DecideShellExecutionInput,
): Promise<ShellSandboxDecision> {
  const { settings, command } = input
  const platform = input.platform ?? process.platform

  if (commandMatchesExcluded(command, settings.excludedCommands)) {
    if (settings.failIfUnavailable || !settings.allowUnsandboxedCommands) {
      return { kind: 'refuse', platform, reason: 'command_excluded' }
    }
    return { kind: 'permissionOnly', platform, reason: 'sandbox_disabled' }
  }

  if (!settings.enabled) {
    return { kind: 'permissionOnly', platform, reason: 'sandbox_disabled' }
  }

  if (platform === 'darwin') {
    const available = await detectSandboxExec()
    if (available) {
      return {
        kind: 'sandboxed',
        platform,
        mechanism: 'seatbelt',
        reason: 'available',
      }
    }
    if (settings.failIfUnavailable || !settings.allowUnsandboxedCommands) {
      return {
        kind: 'refuse',
        platform,
        reason: 'sandbox_required_but_unavailable',
      }
    }
    return {
      kind: 'permissionOnly',
      platform,
      reason: 'sandbox_unavailable_fallback',
    }
  }

  if (platform === 'win32') {
    return decideWindowsShellExecution(settings)
  }

  // Linux, openbsd, etc. — no OS sandbox in this phase. Mirror the macOS
  // unavailable branch so strict policy still refuses.
  if (settings.failIfUnavailable || !settings.allowUnsandboxedCommands) {
    return {
      kind: 'refuse',
      platform,
      reason: 'sandbox_required_but_unavailable',
    }
  }
  return {
    kind: 'permissionOnly',
    platform,
    reason: 'unsupported_platform',
  }
}
