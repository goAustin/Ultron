import { readFile } from 'node:fs/promises'

import type { HookConfig, HookDefinition } from './types.js'
import { emptyHookConfig } from './types.js'

/**
 * Load and validate the user's ~/.ultron/hooks.json.
 *
 * - ENOENT → empty config (no hooks). Common case; silent.
 * - Parse / schema errors → thrown loudly. A misconfigured file must never
 *   silently disable hooks.
 */
export async function loadHooks(path: string): Promise<HookConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyHookConfig()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid hooks config at ${path}: JSON parse failed: ${msg}`)
  }
  return validateHookConfig(parsed, path)
}

const ALLOWED_EVENT_NAMES = new Set(['PreToolUse', 'PostToolUse'])

function validateHookConfig(value: unknown, path: string): HookConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid hooks config at ${path}: expected a JSON object`)
  }
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== 1) {
    throw new Error(
      `Invalid hooks config at ${path}: schemaVersion must be 1, got ${JSON.stringify(v.schemaVersion)}`,
    )
  }
  if (!isPlainObject(v.hooks)) {
    throw new Error(`Invalid hooks config at ${path}: "hooks" must be an object`)
  }
  const hooks = v.hooks as Record<string, unknown>

  for (const key of Object.keys(hooks)) {
    if (!ALLOWED_EVENT_NAMES.has(key)) {
      throw new Error(
        `Invalid hooks config at ${path}: unknown event "${key}" (allowed: PreToolUse, PostToolUse)`,
      )
    }
  }

  const pre = validateDefList(hooks.PreToolUse, 'PreToolUse', path)
  const post = validateDefList(hooks.PostToolUse, 'PostToolUse', path)

  return {
    schemaVersion: 1,
    hooks: { PreToolUse: pre, PostToolUse: post },
  }
}

function validateDefList(
  value: unknown,
  eventName: string,
  path: string,
): readonly HookDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`Invalid hooks config at ${path}: hooks.${eventName} must be an array`)
  }
  return value.map((entry, i) => validateDef(entry, eventName, i, path))
}

function validateDef(
  value: unknown,
  eventName: string,
  index: number,
  path: string,
): HookDefinition {
  const where = `hooks.${eventName}[${index}]`
  if (!isPlainObject(value)) {
    throw new Error(`Invalid hooks config at ${path}: ${where} must be an object`)
  }
  const e = value as Record<string, unknown>
  if (typeof e.matcher !== 'string' || e.matcher.length === 0) {
    throw new Error(`Invalid hooks config at ${path}: ${where}.matcher must be a non-empty string`)
  }
  if (typeof e.command !== 'string' || e.command.length === 0) {
    throw new Error(`Invalid hooks config at ${path}: ${where}.command must be a non-empty string`)
  }
  if (e.timeout !== undefined) {
    if (typeof e.timeout !== 'number' || !Number.isInteger(e.timeout) || e.timeout <= 0) {
      throw new Error(
        `Invalid hooks config at ${path}: ${where}.timeout must be a positive integer (ms)`,
      )
    }
  }
  return {
    matcher: e.matcher,
    command: e.command,
    ...(e.timeout !== undefined && { timeout: e.timeout as number }),
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
