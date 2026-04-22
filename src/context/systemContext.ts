/**
 * System context — git snapshot and environment info.
 *
 * Cached by cwd so multiple calls with the same directory return the same result.
 * Git commands use execFile (not exec) with timeouts for safety.
 */

import { execFile as execFileCb } from 'node:child_process'
import { basename } from 'node:path'
import { platform, type as osType, release } from 'node:os'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

const MAX_STATUS_CHARS = 2000
const GIT_TIMEOUT = 5_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SystemContext = {
  gitStatus: string | null
  envInfo: string
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, Promise<SystemContext>>()

export function clearSystemContextCache(cwd?: string): void {
  if (cwd) cache.delete(cwd)
  else cache.clear()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getSystemContext(cwd: string): Promise<SystemContext> {
  const existing = cache.get(cwd)
  if (existing) return existing

  const promise = buildSystemContext(cwd)
  cache.set(cwd, promise)
  return promise
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function buildSystemContext(cwd: string): Promise<SystemContext> {
  const gitStatus = await getGitSnapshot(cwd)
  const isGit = gitStatus !== null
  const envInfo = getEnvInfo(cwd, isGit)
  return { gitStatus, envInfo }
}

/** Run a git command, returning stdout trimmed. Returns null on any error. */
async function gitCmd(
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', args, { cwd, timeout: GIT_TIMEOUT })
    return stdout.trim()
  } catch {
    return null
  }
}

async function getGitSnapshot(cwd: string): Promise<string | null> {
  // Check if this is a git repo
  const isGit = await gitCmd(['rev-parse', '--is-inside-work-tree'], cwd)
  if (isGit !== 'true') return null

  const [branch, userName, status, log, defaultBranch] = await Promise.all([
    gitCmd(['--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    gitCmd(['config', 'user.name'], cwd),
    gitCmd(['--no-optional-locks', 'status', '--short'], cwd),
    gitCmd(['--no-optional-locks', 'log', '--oneline', '-n', '5'], cwd),
    gitCmd(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd),
  ])

  // Truncate long status
  let displayStatus = status ?? '(clean)'
  if (displayStatus.length > MAX_STATUS_CHARS) {
    displayStatus =
      displayStatus.substring(0, MAX_STATUS_CHARS) +
      '\n... (truncated, run git status for full output)'
  }
  if (!displayStatus) displayStatus = '(clean)'

  const lines = [
    'This is the git status at the start of the conversation. It will not update during the conversation.',
    '',
    `Current branch: ${branch ?? 'unknown'}`,
  ]
  if (defaultBranch) lines.push(`Default branch: ${defaultBranch}`)
  if (userName) lines.push(`Git user: ${userName}`)
  lines.push(`Status:\n${displayStatus}`)
  lines.push(`Recent commits:\n${log ?? '(none)'}`)

  return lines.join('\n')
}

function getEnvInfo(cwd: string, isGit: boolean): string {
  const shell = basename(process.env.SHELL ?? 'unknown')
  const osVersion = `${osType()} ${release()}`

  return [
    '# Environment',
    ` - Working directory: ${cwd}`,
    ` - Is a git repository: ${isGit}`,
    ` - Platform: ${platform()}`,
    ` - Shell: ${shell}`,
    ` - OS Version: ${osVersion}`,
  ].join('\n')
}
