/**
 * CodeSandboxTool — execute ephemeral Python or JavaScript snippets in a
 * WASM-bound sandbox. Each call spawns a fresh `worker_threads.Worker` running
 * QuickJS (for JS) or Pyodide (for Python). No host filesystem, no shell, no
 * Node globals reach the snippet. See `docs/phase6c-v2-design.md`.
 *
 * Permission model: tool-name-only rules (no path/domain). The cascade asks
 * on first call; user accepts → session rule for `CodeSandbox`. Skill
 * `allowed-tools: ['CodeSandbox']` works via exact-name match.
 */

import { buildTool } from '../core/tools/types.js'
import { runSandbox, type SandboxLanguage } from '../sandbox/runtime.js'

const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 60_000

const DESCRIPTION = [
  'Execute ephemeral Python or JavaScript code in an isolated WASM sandbox.',
  'No filesystem, network, or shell access. Each call is fresh; nothing',
  'persists between invocations. Use `print()` (Python) or `console.log()`',
  '(JavaScript) for output. Stdout and stderr are captured and capped at',
  '64 KB total each.',
].join(' ')

export const CodeSandboxTool = buildTool({
  name: 'CodeSandbox',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        enum: ['python', 'javascript'],
        description: 'Snippet language',
      },
      code: {
        type: 'string',
        description: 'Snippet to execute',
      },
      timeoutMs: {
        type: 'number',
        description: `Wall-clock timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
      },
    },
    required: ['language', 'code'],
  },
  isMutating: false,
  isConcurrencySafe: () => true,

  async validateInput(input) {
    if (input.language !== 'python' && input.language !== 'javascript') {
      return { valid: false, message: 'language must be "python" or "javascript"' }
    }
    if (typeof input.code !== 'string' || input.code.trim() === '') {
      return { valid: false, message: 'code must be a non-empty string' }
    }
    if (input.timeoutMs !== undefined) {
      if (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs)) {
        return { valid: false, message: 'timeoutMs must be a finite number' }
      }
      if (input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS) {
        return { valid: false, message: `timeoutMs must be in (0, ${MAX_TIMEOUT_MS}]` }
      }
    }
    return { valid: true }
  },

  async checkPermissions() {
    return { behavior: 'allow' }
  },

  async call(input, _context, signal) {
    const language = input.language as SandboxLanguage
    const code = input.code as string
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : DEFAULT_TIMEOUT_MS

    const r = await runSandbox({
      language,
      code,
      timeoutMs,
      signal,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })

    const parts: string[] = []
    if (r.stdout) parts.push(r.stdout.replace(/\n$/, ''))
    if (r.stderr) {
      if (parts.length > 0) parts.push('--- stderr ---')
      parts.push(r.stderr.replace(/\n$/, ''))
    }
    if (r.exitError !== undefined) {
      parts.push(r.exitError.startsWith('[') ? r.exitError : `[error] ${r.exitError}`)
    }
    if (r.truncated) {
      parts.push(`[output truncated at ${MAX_OUTPUT_BYTES / 1024} KB]`)
    }

    const content = parts.length > 0 ? parts.join('\n') : '(no output)'

    if (r.aborted) {
      return { content, isError: true, errorKind: 'aborted' as const }
    }
    if (r.exitError !== undefined) {
      return { content, isError: true, errorKind: 'execution_error' as const }
    }
    return { content, isError: false }
  },
})
