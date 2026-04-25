import { readFile } from 'node:fs/promises'

import { McpConfigError } from './errors.js'
import { isValidServerName } from './namespacing.js'

export type McpServerConfig = {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly disabled?: boolean
  readonly timeoutMs?: number
}

export type McpConfig = {
  readonly schemaVersion: 1
  readonly servers: Readonly<Record<string, McpServerConfig>>
}

export function emptyMcpConfig(): McpConfig {
  return { schemaVersion: 1, servers: {} }
}

export function sameMcpServerConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return canonicalizeServerConfig(a) === canonicalizeServerConfig(b)
}

/**
 * Load and validate ~/.ultron/mcp.json.
 *
 * - ENOENT → empty config (no MCP servers). Common case; silent.
 * - Parse / schema errors → thrown as McpConfigError.
 */
export async function loadMcpConfig(path: string): Promise<McpConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyMcpConfig()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new McpConfigError(`Invalid MCP config at ${path}: JSON parse failed: ${msg}`)
  }
  return validate(parsed, path)
}

function validate(value: unknown, path: string): McpConfig {
  if (!isPlainObject(value)) {
    throw new McpConfigError(`Invalid MCP config at ${path}: expected a JSON object`)
  }
  const v = value
  if (v.schemaVersion !== 1) {
    throw new McpConfigError(
      `Invalid MCP config at ${path}: schemaVersion must be 1, got ${JSON.stringify(v.schemaVersion)}`,
    )
  }
  if (!isPlainObject(v.servers)) {
    throw new McpConfigError(`Invalid MCP config at ${path}: "servers" must be an object`)
  }
  const servers = v.servers

  const out: Record<string, McpServerConfig> = {}
  for (const name of Object.keys(servers)) {
    if (!isValidServerName(name)) {
      throw new McpConfigError(
        `Invalid MCP config at ${path}: server name ${JSON.stringify(name)} must match /^[a-z0-9][a-z0-9-]{0,63}$/ (no underscores)`,
      )
    }
    out[name] = validateServer(servers[name], name, path)
  }

  return { schemaVersion: 1, servers: out }
}

function validateServer(value: unknown, serverName: string, path: string): McpServerConfig {
  const where = `servers.${serverName}`
  if (!isPlainObject(value)) {
    throw new McpConfigError(`Invalid MCP config at ${path}: ${where} must be an object`)
  }
  const s = value
  if (typeof s.command !== 'string' || s.command.length === 0) {
    throw new McpConfigError(
      `Invalid MCP config at ${path}: ${where}.command must be a non-empty string`,
    )
  }

  const cfg: Record<string, unknown> = { command: s.command }

  if (s.args !== undefined) {
    if (!Array.isArray(s.args) || !s.args.every(a => typeof a === 'string')) {
      throw new McpConfigError(
        `Invalid MCP config at ${path}: ${where}.args must be an array of strings`,
      )
    }
    cfg.args = s.args
  }

  if (s.env !== undefined) {
    if (!isPlainObject(s.env) || !Object.values(s.env).every(v => typeof v === 'string')) {
      throw new McpConfigError(
        `Invalid MCP config at ${path}: ${where}.env must be an object of string values`,
      )
    }
    cfg.env = s.env
  }

  if (s.cwd !== undefined) {
    if (typeof s.cwd !== 'string' || s.cwd.length === 0) {
      throw new McpConfigError(
        `Invalid MCP config at ${path}: ${where}.cwd must be a non-empty string`,
      )
    }
    cfg.cwd = s.cwd
  }

  if (s.disabled !== undefined) {
    if (typeof s.disabled !== 'boolean') {
      throw new McpConfigError(
        `Invalid MCP config at ${path}: ${where}.disabled must be a boolean`,
      )
    }
    cfg.disabled = s.disabled
  }

  if (s.timeoutMs !== undefined) {
    if (typeof s.timeoutMs !== 'number' || !Number.isInteger(s.timeoutMs) || s.timeoutMs <= 0) {
      throw new McpConfigError(
        `Invalid MCP config at ${path}: ${where}.timeoutMs must be a positive integer`,
      )
    }
    cfg.timeoutMs = s.timeoutMs
  }

  return cfg as McpServerConfig
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function canonicalizeServerConfig(cfg: McpServerConfig): string {
  return stableStringify({
    command: cfg.command,
    args: cfg.args ?? null,
    env: cfg.env ?? null,
    cwd: cfg.cwd ?? null,
    disabled: cfg.disabled ?? null,
    timeoutMs: cfg.timeoutMs ?? null,
  })
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
