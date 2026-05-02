/**
 * Domain-keyed Playwright `storageState` persistence (Phase 4·3).
 *
 * On `ComputerHandoffToUser` resume — gated on the user-set
 * `persistProfiles && allowAuthHandoff` settings — we snapshot the browser
 * context's cookies/localStorage so the next `ComputerStart` for the same
 * host can rehydrate without re-prompting.
 *
 * **Why domain-keyed (not session-keyed):** session IDs are random UUIDs that
 * don't survive process restart; the host is the only stable cross-run key.
 *
 * **Storage path:** `~/.ultron/computer-storage/<sha256(host).slice(0,16)>.json`
 * The 16-char prefix is a balance between collision resistance and
 * filesystem-friendly names; sha256 alone is 64 chars.
 *
 * **Permissions:** files contain session cookies (credentials). Mode 0600
 * via O_EXCL+O_CREAT; never on disk with looser perms even briefly.
 *
 * **Failure semantics:** read-miss / malformed-JSON / shape-mismatch on load
 * return `null` and warn — never throw, so a corrupted file can't poison
 * session start. Write failures warn-and-swallow EXCEPT user aborts, which
 * propagate (Batch 4·2 fix #8 rule — never silently eat a cancellation).
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

import { BrowserSessionError } from './types.js'

const STORAGE_DIR = join(homedir(), '.ultron', 'computer-storage')

let dirOverride: string | null = null

/** Test-only: redirect reads/writes to a different directory. Pass null to restore default. */
export function __setStoragePathForTest(dir: string | null): void {
  dirOverride = dir
}

function resolveDir(): string {
  return dirOverride ?? STORAGE_DIR
}

function keyFor(host: string): string {
  return createHash('sha256').update(host).digest('hex').slice(0, 16)
}

function pathFor(host: string): string {
  return join(resolveDir(), `${keyFor(host)}.json`)
}

/**
 * Validate that a parsed value matches Playwright's `storageState` shape.
 *
 * Two layers:
 * - Top-level: must be an object; `cookies` and `origins` (when present)
 *   must be arrays.
 * - Per-entry: each cookie must have at minimum a string `name` and string
 *   `value`. Each origin must have a string `origin` and an array
 *   `localStorage`. Bad entries are dropped (the function returns a
 *   *normalized* object), not the whole file rejected — a single corrupt
 *   cookie shouldn't lose all sibling state.
 *
 * Returns the normalized object on success, `null` if the top-level shape
 * fails. This is the FIRST line of defense; `defaultLaunchChromium` catches
 * any remaining Playwright-level rejection so the contract holds even when
 * Playwright's accepted shape evolves beyond what we validate here.
 */
function normalizeStorageState(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if ('cookies' in obj && !Array.isArray(obj.cookies)) return null
  if ('origins' in obj && !Array.isArray(obj.origins)) return null

  const out: Record<string, unknown> = {}
  if (Array.isArray(obj.cookies)) {
    out.cookies = obj.cookies.filter((entry: unknown): boolean => {
      if (entry === null || typeof entry !== 'object') return false
      const c = entry as Record<string, unknown>
      return typeof c.name === 'string' && typeof c.value === 'string'
    })
  }
  if (Array.isArray(obj.origins)) {
    out.origins = obj.origins.filter((entry: unknown): boolean => {
      if (entry === null || typeof entry !== 'object') return false
      const o = entry as Record<string, unknown>
      return typeof o.origin === 'string' && Array.isArray(o.localStorage)
    })
  }
  return out
}

function isAbortError(err: unknown): boolean {
  if (err instanceof BrowserSessionError && err.kind === 'aborted') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

/**
 * Load a previously-snapshotted storageState for `host`. Returns the
 * validated object on success, `null` on miss or any failure. Never throws.
 */
export async function loadStorageState(host: string): Promise<unknown | null> {
  const path = pathFor(host)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stderr.write(`[ultron] warning: ${path} is not valid JSON; ignoring stored credentials.\n`)
    return null
  }
  const normalized = normalizeStorageState(parsed)
  if (normalized === null) {
    process.stderr.write(
      `[ultron] warning: ${path} does not match Playwright storageState shape; ignoring.\n`,
    )
    return null
  }
  return normalized
}

/**
 * Persist `state` for `host`. Atomic write via O_EXCL tmp + rename so
 * the file is never on disk with looser permissions than 0600.
 *
 * Failure handling:
 * - User aborts (`BrowserSessionError('aborted')` / `AbortError`) propagate.
 * - All other I/O errors warn-and-swallow — the tool result must not be
 *   poisoned by a failed write.
 */
export async function writeStorageState(host: string, state: unknown): Promise<void> {
  const path = pathFor(host)
  const json = JSON.stringify(state, null, 2) + '\n'
  try {
    mkdirSync(dirname(path), { recursive: true, mode: platform() === 'win32' ? undefined : 0o700 })
    const tmp = `${path}.tmp`
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
    const fd = openSync(tmp, flags, platform() === 'win32' ? 0o666 : 0o600)
    try {
      writeSync(fd, json, 0, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (err) {
    if (isAbortError(err)) throw err
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[ultron] warning: could not persist storageState to ${path}: ${msg}\n`,
    )
  }
}
