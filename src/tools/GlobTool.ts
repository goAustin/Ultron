/**
 * GlobTool — find files by glob pattern.
 *
 * Read-only, concurrent-safe. Uses Node 22+ fs.globSync.
 * Runtime requirement: Node 22+.
 */

import { globSync } from 'fs'
import path from 'path'

import { buildTool } from '../core/tools/types.js'

const MAX_RESULTS = 1000

export const GlobTool = buildTool({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns matching file paths. Use this instead of find or ls.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match files against' },
      path: { type: 'string', description: 'Directory to search in' },
    },
    required: ['pattern'],
  },
  isMutating: false,
  isConcurrencySafe: () => true,

  async validateInput(input) {
    if (typeof input.pattern !== 'string' || input.pattern.trim() === '') {
      return { valid: false, message: 'pattern must be a non-empty string' }
    }
    return { valid: true }
  },

  async call(input) {
    const pattern = input.pattern as string
    const basePath = input.path ? path.resolve(input.path as string) : process.cwd()

    let matches: string[]
    try {
      matches = globSync(pattern, { cwd: basePath })
    } catch (err: unknown) {
      return { content: `Glob error: ${(err as Error).message}`, isError: true }
    }

    if (matches.length === 0) {
      return { content: 'No matches found.', isError: false }
    }

    const capped = matches.slice(0, MAX_RESULTS)
    const result = capped.join('\n')
    const suffix = matches.length > MAX_RESULTS
      ? `\n... (${matches.length - MAX_RESULTS} more results truncated)`
      : ''

    return { content: result + suffix, isError: false }
  },
})
