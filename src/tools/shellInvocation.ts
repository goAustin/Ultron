/**
 * Per-platform shell invocation choice.
 *
 *   - darwin / linux / *nix → `/bin/bash -c <command>`
 *   - native Windows         → `powershell.exe -Command <command>`
 *
 * Selection takes the platform as an argument (rather than reading
 * `process.platform`) so the `BashTool.call` path can branch off the
 * `ShellSandboxDecision.platform` it already has and stay testable
 * without stubbing globals.
 *
 * The flag-set returned here is the bare minimum: the executable and the
 * `-c`/`-Command` flag. Callers append additional flags (e.g.
 * PowerShell's `-NoProfile`) at the call site so this helper stays a
 * single string-pair.
 */

export type ShellInvocation = {
  readonly executable: string
  readonly argFlag: string
}

const POWERSHELL: ShellInvocation = {
  executable: 'powershell.exe',
  argFlag: '-Command',
}

const BASH: ShellInvocation = {
  executable: '/bin/bash',
  argFlag: '-c',
}

export function selectShellInvocation(platform: NodeJS.Platform): ShellInvocation {
  return platform === 'win32' ? POWERSHELL : BASH
}
