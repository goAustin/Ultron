/**
 * User context — reads project instructions (CLAUDE.md) from the working directory.
 *
 * Cached by cwd so multiple calls with the same directory return the same result.
 * The current date is NOT included here — it is computed fresh on each call
 * to buildSystemPromptParts() to avoid stale dates across midnight.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, Promise<string | null>>()

export function clearUserContextCache(cwd?: string): void {
  if (cwd) cache.delete(cwd)
  else cache.clear()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read project instructions from CLAUDE.md in the given directory.
 * Returns `null` if the file does not exist or is empty.
 * Result is cached by cwd for the lifetime of the process (or until cleared).
 */
export function getProjectInstructions(cwd: string): Promise<string | null> {
  const existing = cache.get(cwd)
  if (existing) return existing

  const promise = readProjectInstructions(cwd)
  cache.set(cwd, promise)
  return promise
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function readProjectInstructions(cwd: string): Promise<string | null> {
  try {
    const content = await readFile(join(cwd, 'CLAUDE.md'), 'utf-8')
    return content.trim() || null
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    process.stderr.write(
      `Warning: failed to read CLAUDE.md: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return null
  }
}
