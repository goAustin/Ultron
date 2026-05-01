/**
 * Shell-OS sandbox types.
 *
 * Distinct from `src/sandbox/runtime.ts` (the in-process WASM CodeSandbox
 * runtime). This module describes the second enforcement layer for shell
 * commands spawned by `BashTool` — currently macOS Seatbelt only.
 */

export type ShellSandboxSettings = {
  readonly enabled: boolean
  readonly failIfUnavailable: boolean
  readonly autoAllowBashIfSandboxed: boolean
  readonly allowUnsandboxedCommands: boolean
  readonly excludedCommands: readonly string[]
  readonly filesystem: {
    readonly allowWrite: readonly string[]
    readonly denyWrite: readonly string[]
    readonly allowRead: readonly string[]
    readonly denyRead: readonly string[]
  }
  readonly network: {
    readonly allowedDomains: readonly string[]
  }
}

/**
 * Decision returned by `decideShellExecution`. The `mechanism` discriminator
 * on `sandboxed` leaves room for future Linux/Bubblewrap or Windows
 * Job-Object mechanisms without rewriting consumers.
 */
export type ShellSandboxDecision =
  | {
      readonly kind: 'sandboxed'
      readonly platform: NodeJS.Platform
      readonly mechanism: 'seatbelt'
      readonly reason: 'available'
    }
  | {
      readonly kind: 'permissionOnly'
      readonly platform: NodeJS.Platform
      readonly reason:
        | 'native_windows_unsupported'
        | 'sandbox_disabled'
        | 'sandbox_unavailable_fallback'
        | 'unsupported_platform'
    }
  | {
      readonly kind: 'refuse'
      readonly platform: NodeJS.Platform
      readonly reason:
        | 'sandbox_required_but_unavailable'
        | 'command_excluded'
        | 'native_windows_unsupported'
    }

export type ShellSandboxAudit = {
  readonly sandboxEnabled: boolean
  readonly executionKind: 'sandboxed' | 'permissionOnly' | 'refused'
  readonly platform: NodeJS.Platform
  readonly reason: string
  readonly writableRoots: readonly string[]
  readonly deniedRoots: readonly string[]
  readonly networkMode: 'notControlled' | 'denyAll' | 'proxyAllowlist'
}

/**
 * Deep-optional shape for `~/.ultron/settings.json` and SDK callers. Every
 * leaf is independently optional so a user can persist
 * `{ failIfUnavailable: true }` without having to also serialize the full
 * filesystem allowlist. `mergeShellSandboxSettings` folds this onto
 * `defaultShellSandboxSettings` to produce the runtime value stored in
 * `AppState.shellSandbox`.
 */
export type ShellSandboxSettingsInput = {
  enabled?: boolean
  failIfUnavailable?: boolean
  autoAllowBashIfSandboxed?: boolean
  allowUnsandboxedCommands?: boolean
  excludedCommands?: string[]
  filesystem?: {
    allowWrite?: string[]
    denyWrite?: string[]
    allowRead?: string[]
    denyRead?: string[]
  }
  network?: {
    allowedDomains?: string[]
  }
}
