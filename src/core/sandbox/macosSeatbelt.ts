/**
 * macOS Seatbelt integration.
 *
 *   - `detectSandboxExec`     — verifies `/usr/bin/sandbox-exec` exists. Cached
 *                                across calls (a missing binary is not going
 *                                to materialize mid-process).
 *   - `generateSeatbeltProfile` — builds an inline profile from structured
 *                                policy. Allows everything by default,
 *                                denies all writes, then re-allows writes
 *                                inside the workspace, the OS temp area,
 *                                and `/dev` (needed for tty/null/pipe
 *                                writes from common shell utilities). Final
 *                                deny pass for sensitive paths — Seatbelt
 *                                evaluates rules top-to-bottom and the last
 *                                match wins, so this gives `denyWrite`
 *                                strict precedence over `allowWrite`.
 *   - `buildSeatbeltArgv`     — assembles the argv shape the doc commits to:
 *                                `sandbox-exec -p <profile> /bin/bash -c <cmd>`,
 *                                each piece a separate argv entry so no
 *                                shell metacharacter handling is required
 *                                from Ultron.
 *
 * Apple has marked `sandbox-exec` deprecated since macOS 10.x; it still
 * ships on 14/15. If a future release removes it, `detectSandboxExec`
 * returns false and the manager routes to `permissionOnly` or `refuse`.
 */

import { access } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { resolveSandboxPaths } from './settings.js'
import type { ShellSandboxSettings } from './types.js'

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

let cachedAvailability: boolean | null = null

export async function detectSandboxExec(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability
  try {
    await access(SANDBOX_EXEC_PATH)
    cachedAvailability = true
  } catch {
    cachedAvailability = false
  }
  return cachedAvailability
}

export function __resetSandboxAvailabilityCacheForTest(): void {
  cachedAvailability = null
}

export type SeatbeltProfileInput = {
  readonly workspace: string
  readonly settings: ShellSandboxSettings
}

export type SeatbeltProfileOutput = {
  readonly profile: string
  readonly writableRoots: readonly string[]
  readonly deniedWrites: readonly string[]
  readonly deniedReads: readonly string[]
}

export function generateSeatbeltProfile(input: SeatbeltProfileInput): SeatbeltProfileOutput {
  const { workspace, settings } = input

  const userAllowWrites = resolveSandboxPaths(settings.filesystem.allowWrite, workspace)
  const denyWrites = resolveSandboxPaths(settings.filesystem.denyWrite, workspace)
  const denyReads = resolveSandboxPaths(settings.filesystem.denyRead, workspace)

  // Implicit always-allowed write paths so common shell utilities don't break:
  //   - `tmpdir()`             — Node's resolved per-user temp
  //   - `/private/tmp`         — `/tmp` resolves to this on macOS
  //   - `/private/var/folders` — macOS per-user cache/temp area
  //   - `/dev`                 — tty, null, urandom, pipes
  const implicitAllowWrites = [
    tmpdir(),
    '/private/tmp',
    '/private/var/folders',
    '/dev',
  ]

  // Seatbelt's `(subpath ...)` is a literal string match against the kernel's
  // canonical path. macOS aliases `/var` → `/private/var` and `/tmp` →
  // `/private/tmp` via firmlinks, so an allow on `/var/folders` does NOT
  // cover an access logged as `/private/var/folders`. Canonicalize once
  // here so allow and deny rules speak in the same path form the kernel
  // actually sees.
  const writableRoots = Array.from(
    new Set([...implicitAllowWrites, ...userAllowWrites].map(canonicalize)),
  )
  const deniedWrites = denyWrites.map(canonicalize)
  const deniedReads = denyReads.map(canonicalize)

  const lines: string[] = []
  lines.push('(version 1)')
  lines.push('(allow default)')
  lines.push('(deny file-write*)')
  for (const p of writableRoots) {
    lines.push(`(allow file-write* (subpath ${quote(p)}))`)
  }
  for (const p of deniedWrites) {
    lines.push(`(deny file-write* (subpath ${quote(p)}))`)
  }
  // Reads stay broadly allowed by `(allow default)` (shell startup needs to
  // read /bin, /usr, dyld caches, etc.) — flipping to deny-default for
  // reads is too aggressive for v1. Deny rules for `denyRead` paths come
  // last so last-match-wins gives them precedence over the default allow.
  for (const p of deniedReads) {
    lines.push(`(deny file-read* (subpath ${quote(p)}))`)
  }

  return {
    profile: lines.join('\n'),
    writableRoots,
    deniedWrites,
    deniedReads,
  }
}

/**
 * Resolve symlinks and macOS firmlink aliases to the kernel's canonical
 * form. When the path itself doesn't exist (e.g., a deny target for a
 * file that hasn't been created), walk up to the deepest existing
 * ancestor, realpath that, and re-join the missing tail — otherwise a
 * deny rule for `<workspace>/.env` written as `/var/folders/.../.env`
 * silently misses the kernel's `/private/var/folders/.../.env` access.
 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    // Pass — fall through to ancestor walk
  }
  const tail: string[] = []
  let current = p
  while (current !== '/' && current !== '') {
    const parent = dirname(current)
    if (parent === current) break
    tail.unshift(basename(current))
    current = parent
    try {
      const real = realpathSync(current)
      return join(real, ...tail)
    } catch {
      // Keep walking up.
    }
  }
  return p
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export type SeatbeltArgv = {
  readonly executable: string
  readonly args: readonly string[]
}

export function buildSeatbeltArgv(profile: string, command: string): SeatbeltArgv {
  return {
    executable: SANDBOX_EXEC_PATH,
    args: ['-p', profile, '/bin/bash', '-c', command],
  }
}
