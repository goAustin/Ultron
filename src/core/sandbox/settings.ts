/**
 * Shell-sandbox settings: defaults + path-resolution helper.
 *
 * The path resolver implements the rules from `docs/sandbox-os-implementation.md`:
 *   - absolute path        → used as-is
 *   - "~/<rest>"           → home-relative
 *   - "."  or "./"          → workspace only (special case; bare "." in a shell
 *                              context means "here", not "home")
 *   - bare relative path   → expands to BOTH `<HOME>/<entry>` and
 *                              `<workspace>/<entry>`, deduplicated
 *
 * Seatbelt requires absolute paths; resolution must happen before profile
 * generation, once per decision (never re-resolved inside the generator).
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type {
  ShellSandboxSettings,
  ShellSandboxSettingsInput,
} from './types.js'

// Enabled on darwin (real Seatbelt) and win32 (permission-only fallback so
// the "not OS-sandboxed on Windows" warning actually surfaces). Disabled on
// other platforms — there is no sandbox mechanism, so reaching the
// `sandbox_disabled` branch keeps audit and UX clean. Users on those
// platforms can opt in to the unsupported-platform warning by setting
// `enabled: true` themselves.
export const defaultShellSandboxSettings: ShellSandboxSettings = {
  enabled: process.platform === 'darwin' || process.platform === 'win32',
  failIfUnavailable: false,
  autoAllowBashIfSandboxed: false,
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  filesystem: {
    allowWrite: ['.'],
    denyWrite: ['.ultron/settings', '.ultron/skills', '.env', '.ssh'],
    allowRead: ['.'],
    denyRead: [],
  },
  network: {
    allowedDomains: [],
  },
}

/**
 * Fold a partial input from settings.json (or an SDK caller) onto a
 * baseline `ShellSandboxSettings`. Each leaf falls back to the base when
 * unset; arrays in the input replace the baseline arrays wholesale (same
 * semantic the existing settings file uses for `permissionRules` and
 * `webPolicy.allowlist`).
 *
 * `base` defaults to `defaultShellSandboxSettings`. Callers seeding
 * AppState pass `undefined` as the input when the user hasn't written any
 * shell-sandbox settings — the function returns `base` unchanged in that
 * case rather than constructing an identical object.
 */
export function mergeShellSandboxSettings(
  input: ShellSandboxSettingsInput | undefined,
  base: ShellSandboxSettings = defaultShellSandboxSettings,
): ShellSandboxSettings {
  if (input === undefined) return base
  return {
    enabled: input.enabled ?? base.enabled,
    failIfUnavailable: input.failIfUnavailable ?? base.failIfUnavailable,
    autoAllowBashIfSandboxed:
      input.autoAllowBashIfSandboxed ?? base.autoAllowBashIfSandboxed,
    allowUnsandboxedCommands:
      input.allowUnsandboxedCommands ?? base.allowUnsandboxedCommands,
    excludedCommands: input.excludedCommands ?? base.excludedCommands,
    filesystem: {
      allowWrite: input.filesystem?.allowWrite ?? base.filesystem.allowWrite,
      denyWrite: input.filesystem?.denyWrite ?? base.filesystem.denyWrite,
      allowRead: input.filesystem?.allowRead ?? base.filesystem.allowRead,
      denyRead: input.filesystem?.denyRead ?? base.filesystem.denyRead,
    },
    network: {
      allowedDomains:
        input.network?.allowedDomains ?? base.network.allowedDomains,
    },
  }
}

export function resolveSandboxPaths(
  entries: readonly string[],
  workspace: string,
  home: string = homedir(),
): string[] {
  const out = new Set<string>()
  for (const entry of entries) {
    if (entry === '') continue
    if (entry === '.' || entry === './') {
      out.add(workspace)
      continue
    }
    if (isAbsolute(entry)) {
      out.add(entry)
      continue
    }
    if (entry.startsWith('~/')) {
      out.add(join(home, entry.slice(2)))
      continue
    }
    out.add(join(home, entry))
    out.add(join(workspace, entry))
  }
  return Array.from(out)
}
