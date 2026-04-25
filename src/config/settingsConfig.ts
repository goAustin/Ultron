/**
 * Per-user settings at `~/.ultron/settings.json` (Phase 6b).
 *
 * Stores the durable web policy: API keys for paid search backends,
 * domain allow/denylists, and persisted permission rules. Loaded once at
 * engine init and seeded into AppState; mutations from `/web` slash
 * subcommands flow back here.
 *
 * Read/write is sync (mirrors `userConfig.ts`). Schema is *nested*, so
 * the merge is per-field — a shallow `{...prev, ...partial}` would erase
 * sibling nested keys (writing `webSearch.apiKeys.brave` would clobber
 * `webSearch.apiKeys.tavily`). The merge handles each field explicitly.
 *
 * The file may carry plaintext API keys, so writes set mode 0600 on the
 * tmp file *before* the atomic rename. Never throws on read; write
 * failures emit one stderr warning.
 */

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

import type { PermissionRule } from '../core/permissions/types.js'

export type SettingsConfig = {
  schemaVersion?: 1
  webSearch?: {
    apiKeys?: {
      brave?: string
      tavily?: string
    }
  }
  webPolicy?: {
    allowlist?: string[]
    denylist?: string[]
  }
  permissionRules?: PermissionRule[]
}

const SETTINGS_DIR = join(homedir(), '.ultron')
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json')

let pathOverride: string | null = null

/** Test-only: redirect reads/writes to a different path. Pass null to restore default. */
export function __setSettingsPathForTest(path: string | null): void {
  pathOverride = path
}

function resolvePath(): string {
  return pathOverride ?? SETTINGS_PATH
}

export function readSettingsConfig(): SettingsConfig {
  const path = resolvePath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as SettingsConfig
    return {}
  } catch {
    process.stderr.write(`[ultron] warning: ${path} is not valid JSON; ignoring.\n`)
    return {}
  }
}

/**
 * Schema-aware deep-ish merge. Per-field strategy:
 * - `webSearch.apiKeys.{brave,tavily}` — spread-merge (writing one preserves the other).
 * - `webPolicy.{allowlist,denylist}` — replace each array if present in partial.
 * - `permissionRules` — replace if present.
 * - Top-level keys absent from `partial` are preserved untouched.
 */
function mergeSettings(prev: SettingsConfig, partial: SettingsConfig): SettingsConfig {
  const next: SettingsConfig = { ...prev }

  if (partial.schemaVersion !== undefined) {
    next.schemaVersion = partial.schemaVersion
  }

  if (partial.webSearch !== undefined) {
    const prevApiKeys = prev.webSearch?.apiKeys ?? {}
    const partApiKeys = partial.webSearch.apiKeys ?? {}
    next.webSearch = {
      ...(prev.webSearch ?? {}),
      ...partial.webSearch,
      apiKeys: { ...prevApiKeys, ...partApiKeys },
    }
  }

  if (partial.webPolicy !== undefined) {
    next.webPolicy = {
      ...(prev.webPolicy ?? {}),
      ...partial.webPolicy,
    }
  }

  if (partial.permissionRules !== undefined) {
    next.permissionRules = partial.permissionRules
  }

  return next
}

export function writeSettingsConfig(partial: SettingsConfig): void {
  const path = resolvePath()
  const merged = mergeSettings(readSettingsConfig(), partial)
  const json = JSON.stringify(merged, null, 2) + '\n'
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    // Open with O_EXCL + mode 0600 so the file is never on disk with looser
    // permissions (a chmod-after-write window can leak plaintext keys under
    // a permissive umask). On Windows the mode arg is ignored.
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
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[ultron] warning: could not persist settings to ${path}: ${msg}\n`)
  }
}
