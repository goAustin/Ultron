/**
 * Native Windows shell-sandbox policy.
 *
 * Phase intent (from `docs/sandbox-os-implementation.md`): Windows is *never*
 * treated as OS-sandboxed in this phase. The decision is permission-only or
 * refuse — no AppContainer, no Job Objects, no low-integrity tokens. A
 * dedicated module keeps this honest and gives a single seam to upgrade
 * later if real Windows containment lands.
 */

import type { ShellSandboxDecision, ShellSandboxSettings } from './types.js'

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
