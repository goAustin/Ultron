/**
 * Local guard for ~/.ultron/ — transcript size checking and base directory
 * permission enforcement for sessions, memory, and skills.
 */

import { statSync } from 'node:fs'
import { chmod, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Soft cap for transcript files. Warn but still load. */
export const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024 // 10 MB

// ---------------------------------------------------------------------------
// Transcript size check
// ---------------------------------------------------------------------------

/**
 * Check transcript file size via stat(). Returns { ok, bytes }.
 * ok is true if the file is within the cap or doesn't exist.
 * Never throws.
 */
export function checkTranscriptSize(
  transcriptPath: string,
): { ok: boolean; bytes: number } {
  try {
    const s = statSync(transcriptPath)
    return { ok: s.size <= MAX_TRANSCRIPT_BYTES, bytes: s.size }
  } catch {
    // File doesn't exist or can't be stat'd — treat as ok
    return { ok: true, bytes: 0 }
  }
}

// ---------------------------------------------------------------------------
// Base directory permissions
// ---------------------------------------------------------------------------

/**
 * Enforce owner-only permissions (0o700) on the base Ultron directories.
 * Targets baseDir (~/.ultron/), baseDir/sessions/, baseDir/memory/, and
 * baseDir/skills/. Best-effort — warns to stderr on failure, never throws.
 */
export async function enforceBaseDirectoryPermissions(
  baseDir: string,
): Promise<void> {
  const dirs = [
    baseDir,
    join(baseDir, 'sessions'),
    join(baseDir, 'memory'),
    join(baseDir, 'skills'),
  ]

  for (const dir of dirs) {
    try {
      // Ensure directory exists before chmod
      await mkdir(dir, { recursive: true })
      await chmod(dir, 0o700)
    } catch (err: unknown) {
      process.stderr.write(
        `Warning: failed to set permissions on ${dir}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
}
