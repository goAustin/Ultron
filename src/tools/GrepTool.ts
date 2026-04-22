/**
 * GrepTool — search file contents by regex pattern.
 *
 * Read-only, concurrent-safe. Shells out to grep -rn.
 * macOS/Linux only. Not portable to Windows.
 */

import { execFile } from 'child_process'
import path from 'path'

import { buildTool } from '../core/tools/types.js'

const MAX_BUFFER = 100 * 1024 // 100 KB

export const GrepTool = buildTool({
  name: 'Grep',
  description: 'Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in' },
      glob: { type: 'string', description: 'Glob pattern to filter files' },
    },
    required: ['pattern'],
  },
  isMutating: false,
  isConcurrencySafe: () => true,

  async validateInput(input) {
    if (typeof input.pattern !== 'string' || input.pattern.trim() === '') {
      return { valid: false, message: 'pattern must be a non-empty string' }
    }
    try {
      new RegExp(input.pattern as string)
    } catch {
      return { valid: false, message: `Invalid regex pattern: ${input.pattern}` }
    }
    return { valid: true }
  },

  async call(input, _context, signal) {
    const pattern = input.pattern as string
    const basePath = input.path ? path.resolve(input.path as string) : process.cwd()

    const args: string[] = ['-rn']
    if (typeof input.glob === 'string' && input.glob.trim() !== '') {
      args.push(`--include=${input.glob}`)
    }
    args.push(pattern, basePath)

    return new Promise((resolve) => {
      execFile('grep', args, { maxBuffer: MAX_BUFFER, signal }, (err, stdout, stderr) => {
        if (err) {
          // Exit code 1 = no matches (not an error)
          const exitCode = (err as Error & { code?: number | string }).code
          if (exitCode === 1 || exitCode === '1') {
            resolve({ content: 'No matches found.', isError: false })
            return
          }
          // Abort
          if (signal.aborted) {
            resolve({ content: '[aborted] Search interrupted', isError: true })
            return
          }
          // Actual error (exit code 2+, or other failure)
          resolve({ content: stderr || err.message, isError: true })
          return
        }
        resolve({ content: stdout, isError: false })
      })
    })
  },
})
