/**
 * Filesystem safety checks for the permission engine.
 *
 * Three SafetyCheck implementations:
 *   - dangerousPathSafetyCheck — flags writes to shell rc files, git metadata, etc.
 *   - workingDirectorySafetyCheck — flags writes outside configured working directories
 *   - secretContentSafetyCheck — flags writes containing credential patterns (from contentSafety.ts)
 *
 * Path checks only fire for mutating tools (tool.isMutating !== false).
 * Path checks return 'ask' — the user can approve if intended.
 * Secret check returns 'deny' (high confidence) or 'ask' (low confidence).
 * All sit at step 4 of the cascade — non-bypassable, even in bypassPermissions mode.
 *
 * Symlink-aware: checks both the original path and the realpath-resolved path.
 * For nonexistent files, resolves the nearest existing ancestor directory.
 *
 * SafetyCheck is synchronous. realpathSync is acceptable for a local-first CLI tool.
 * TOCTOU gap: a symlink could change between check and use. Acceptable for a
 * single-user assistant where the threat model is "prevent the model from
 * accidentally touching sensitive files."
 */

import { realpathSync } from 'fs'
import path from 'path'

import type { SafetyCheck, PermissionDecision } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Files that can execute code or exfiltrate data on shell startup or git operations.
 */
export const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
] as const

/**
 * Directories containing sensitive configuration or executable files.
 * - .git — repository internals, hooks can execute code
 * - .vscode — tasks.json and launch.json can execute arbitrary commands
 * - .idea — JetBrains run configs can execute commands
 * - .claude — Ultron's own config; self-preservation
 * - .ultron — session data; self-preservation
 */
export const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  '.claude',
  '.ultron',
] as const

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/**
 * Normalize macOS-specific symlink aliases.
 * /private/var → /var, /private/tmp → /tmp.
 * Without this, realpath on macOS produces /private/tmp/... which won't match
 * a working directory of /tmp/...
 */
export function normalizeMacOSPath(filePath: string): string {
  return filePath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
}

/**
 * Returns all paths that should be checked for a given input path.
 * Includes the original absolute path and, if different, the realpath-resolved path.
 * For nonexistent files, resolves the nearest existing ancestor to catch
 * symlink escapes through parent directories.
 */
export function getPathsToCheck(inputPath: string): string[] {
  const absolute = path.resolve(inputPath)
  const results = new Set<string>([absolute])

  try {
    const resolved = realpathSync(absolute)
    results.add(resolved)
  } catch {
    // File doesn't exist — resolve nearest existing ancestor
    let current = path.dirname(absolute)
    let remaining = path.basename(absolute)

    while (current !== path.dirname(current)) {
      try {
        const resolvedParent = realpathSync(current)
        const resolvedFull = path.join(resolvedParent, remaining)
        results.add(resolvedFull)
        break
      } catch {
        remaining = path.join(path.basename(current), remaining)
        current = path.dirname(current)
      }
    }
  }

  return [...results]
}

/**
 * Check if a path targets a dangerous file or directory.
 * Case-insensitive comparison against the dangerous names only —
 * the rest of the path is not lowercased.
 */
export function isDangerousPath(filePath: string): boolean {
  const absolute = path.resolve(filePath)
  const segments = absolute.split(path.sep)

  // Check each segment against dangerous directories (case-insensitive)
  for (const segment of segments) {
    const lower = segment.toLowerCase()
    for (const dir of DANGEROUS_DIRECTORIES) {
      if (lower === dir.toLowerCase()) {
        return true
      }
    }
  }

  // Check filename against dangerous files (case-insensitive)
  const fileName = segments.at(-1)
  if (fileName) {
    const lowerFileName = fileName.toLowerCase()
    for (const file of DANGEROUS_FILES) {
      if (lowerFileName === file.toLowerCase()) {
        return true
      }
    }
  }

  return false
}

/**
 * Check if a path is within a directory. Case-preserving — no blanket lowercasing.
 * Handles macOS /private/var and /private/tmp aliasing.
 */
export function isWithinDirectory(filePath: string, directory: string): boolean {
  const absolutePath = normalizeMacOSPath(path.resolve(filePath))
  const absoluteDir = normalizeMacOSPath(path.resolve(directory))

  const relative = path.relative(absoluteDir, absolutePath)

  // Same path
  if (relative === '') return true

  // Outside if relative path goes up (..) or is absolute
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false

  return true
}

// ---------------------------------------------------------------------------
// Safety check implementations
// ---------------------------------------------------------------------------

/**
 * Flags mutating tools targeting dangerous files/directories.
 * Returns 'ask' so the user can approve if intended.
 */
export const dangerousPathSafetyCheck: SafetyCheck = (tool, input, _context) => {
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
      } satisfies PermissionDecision
    }
  }

  return null
}

/**
 * Flags mutating tools targeting paths outside configured working directories.
 * Returns 'ask' so the user can approve if intended.
 * Returns null (no opinion) when workingDirectories is empty.
 */
export const workingDirectorySafetyCheck: SafetyCheck = (tool, input, context) => {
  if (tool.isMutating === false) return null

  const filePath = tool.getPath?.(input)
  if (!filePath) return null

  const workingDirs = context.appState.getState().workingDirectories
  if (workingDirs.length === 0) return null

  const pathsToCheck = getPathsToCheck(filePath)
  const resolvedWorkingDirs = workingDirs.flatMap(getPathsToCheck)

  const allInside = pathsToCheck.every((p) =>
    resolvedWorkingDirs.some((wd) => isWithinDirectory(p, wd)),
  )

  if (!allInside) {
    return {
      behavior: 'ask',
      reason: {
        type: 'safetyCheck',
        message: `${filePath} is outside the allowed working directories`,
      },
    } satisfies PermissionDecision
  }

  return null
}

import { secretContentSafetyCheck } from '../../memory/contentSafety.js'

/**
 * All safety checks, in order. Plug into permissionOpts.safetyChecks.
 */
export const filesystemSafetyChecks: readonly SafetyCheck[] = [
  dangerousPathSafetyCheck,
  workingDirectorySafetyCheck,
  secretContentSafetyCheck,
]
