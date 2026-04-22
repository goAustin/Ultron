/**
 * Permission decision audit log.
 *
 * Structured JSONL logging for every permission decision.
 * Append-only, never read by the application — purely for audit.
 */

import { mkdir, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PermissionRule, LogPermissionDecisionFn } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionLogEntry = {
  readonly timestamp: number
  readonly toolName: string
  readonly inputSummary: string
  readonly decision: 'allow' | 'deny' | 'ask'
  readonly reason: string
  readonly userResponse?: 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'
  readonly ruleCreated?: PermissionRule
}

// ---------------------------------------------------------------------------
// Input summarization
// ---------------------------------------------------------------------------

const MAX_SUMMARY_LENGTH = 120

const FILE_TOOLS = new Set(['FileRead', 'FileWrite', 'FileEdit'])

/**
 * Summarize tool input for logging.
 * Returns file_path for file tools, command prefix for Bash,
 * or truncated JSON for others.
 */
export function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  if (FILE_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return input.file_path
  }

  if (toolName === 'Bash' && typeof input.command === 'string') {
    return truncate(input.command, MAX_SUMMARY_LENGTH)
  }

  if ((toolName === 'Grep' || toolName === 'Glob') && typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${input.path}` : ''
    return truncate(`${input.pattern}${path}`, MAX_SUMMARY_LENGTH)
  }

  return truncate(JSON.stringify(input), MAX_SUMMARY_LENGTH)
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

const DEFAULT_LOG_DIR = join(homedir(), '.ultron')
const LOG_FILENAME = 'permissions.jsonl'

/**
 * Create a production permission logger that appends JSONL to disk.
 * Never throws — swallows errors with stderr warning.
 */
export function createPermissionLogger(logDir?: string): LogPermissionDecisionFn {
  const dir = logDir ?? DEFAULT_LOG_DIR
  const logPath = join(dir, LOG_FILENAME)

  return async (entry: PermissionLogEntry): Promise<void> => {
    try {
      await mkdir(dir, { recursive: true })
      await appendFile(logPath, JSON.stringify(entry) + '\n')
    } catch (err: unknown) {
      process.stderr.write(
        `Warning: failed to log permission decision: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 3) + '...'
}
