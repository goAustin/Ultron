/**
 * BashTool — execute shell commands with permission gating.
 *
 * v1 permission strategy: operator scan + prefix allowlist.
 * 1. Reject (ask) any command with shell operators (>, |, ;, &, `, $( , ${)
 * 2. Check first word (or two-word prefix for subcommand tools) against allowlist
 * 3. Unknown commands → ask
 *
 * macOS/Linux only. Executes via /bin/bash -c.
 */

import { execFile } from 'child_process'

import { buildTool } from '../core/tools/types.js'

// ---------------------------------------------------------------------------
// Permission constants
// ---------------------------------------------------------------------------

const SAFE_COMMAND_PREFIXES = new Set([
  // Filesystem info (read-only, no side effects)
  'ls', 'pwd', 'date', 'which', 'whoami', 'uname',
  'cat', 'head', 'tail', 'wc', 'file', 'stat',
  // Git read-only operations
  'git status', 'git log', 'git diff', 'git branch',
  'git rev-parse', 'git remote', 'git tag',
  // Version queries
  'node --version', 'npm --version',
])

const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'node', 'tsc'])

/**
 * Detect shell operators that could allow side effects even in
 * otherwise-safe commands (e.g., `cat foo > bar`, `ls | curl`).
 */
const SHELL_OPERATORS = /[|;&`]|>>?|\$\(|\$\{/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hasShellOperators(command: string): boolean {
  return SHELL_OPERATORS.test(command)
}

export function extractCommandPrefix(command: string): string {
  const words = command.trim().split(/\s+/)
  const first = words[0] ?? ''
  if (SUBCOMMAND_TOOLS.has(first) && words.length >= 2) {
    const twoWord = `${first} ${words[1]}`
    if (SAFE_COMMAND_PREFIXES.has(twoWord)) return twoWord
  }
  return first
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 120_000 // 2 minutes
const MAX_BUFFER = 1024 * 1024  // 1 MB

export const BashTool = buildTool({
  name: 'Bash',
  description: 'Execute a shell command via /bin/bash -c. Returns stdout and stderr.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds' },
    },
    required: ['command'],
  },

  async validateInput(input) {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      return { valid: false, message: 'command must be a non-empty string' }
    }
    if (input.timeout !== undefined && (typeof input.timeout !== 'number' || input.timeout <= 0)) {
      return { valid: false, message: 'timeout must be a positive number' }
    }
    return { valid: true }
  },

  async checkPermissions(input) {
    const command = (input.command as string).trim()

    // Phase 1: reject commands with shell operators
    if (hasShellOperators(command)) {
      return { behavior: 'ask', message: `Shell command requires approval: ${command}` }
    }

    // Phase 2: prefix allowlist
    const prefix = extractCommandPrefix(command)
    if (SAFE_COMMAND_PREFIXES.has(prefix)) {
      return { behavior: 'allow' }
    }

    return { behavior: 'ask', message: `Shell command requires approval: ${command}` }
  },

  async call(input, _context, signal) {
    const command = (input.command as string).trim()
    const timeout = typeof input.timeout === 'number' ? input.timeout : DEFAULT_TIMEOUT

    return new Promise((resolve) => {
      execFile(
        '/bin/bash',
        ['-c', command],
        { timeout, maxBuffer: MAX_BUFFER, signal, cwd: process.cwd() },
        (err, stdout, stderr) => {
          if (err) {
            // Abort
            if (signal.aborted) {
              resolve({ content: '[aborted] Command interrupted', isError: true })
              return
            }
            // Timeout
            if ('killed' in err && err.killed) {
              resolve({ content: `Command timed out after ${timeout}ms`, isError: true })
              return
            }
            // Non-zero exit
            const output = (stdout + (stderr ? '\n' + stderr : '')).trim()
            resolve({ content: output || err.message, isError: true })
            return
          }

          const output = (stdout + (stderr ? '\n' + stderr : '')).trim()
          resolve({ content: output, isError: false })
        },
      )
    })
  },
})
