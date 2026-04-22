/**
 * Per-user config at `~/.ultron/config.json`.
 *
 * Currently stores `lastModel` — the id of the model the user last picked via
 * `/model`, so it sticks across restarts. Never throws: missing/corrupt files
 * return `{}`; write failures surface a single stderr warning.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type UserConfig = {
  lastModel?: string
}

const CONFIG_DIR = join(homedir(), '.ultron')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

/** Override for tests. Undefined means "use default ~/.ultron/config.json". */
let pathOverride: string | null = null

/** Test-only: redirect reads/writes to a different path. Pass null to restore default. */
export function __setConfigPathForTest(path: string | null): void {
  pathOverride = path
}

function resolvePath(): string {
  return pathOverride ?? CONFIG_PATH
}

export function readUserConfig(): UserConfig {
  const path = resolvePath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as UserConfig
    return {}
  } catch {
    process.stderr.write(`[ultron] warning: ${path} is not valid JSON; ignoring.\n`)
    return {}
  }
}

export function writeUserConfig(partial: Partial<UserConfig>): void {
  const path = resolvePath()
  const merged: UserConfig = { ...readUserConfig(), ...partial }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[ultron] warning: could not persist config to ${path}: ${msg}\n`)
  }
}
