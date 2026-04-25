import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'

import type { HookDefinition, HookInvocationResult } from './types.js'

export const MAX_HOOK_STDOUT_BYTES = 1_048_576 // 1 MB
export const MAX_HOOK_STDERR_BYTES = 65_536 // 64 KB
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000

/**
 * Run a single hook subprocess.
 *
 * Protocol (mirrors Claude Code's hook harness):
 * - stdin: single JSON line, EOF.
 * - stdout: empty (ok) or a JSON object with optional fields.
 * - exit code 2: block; stderr becomes the reason.
 * - exit code 0 + `{"decision":"block"}` on stdout: also block.
 * - any other non-zero: error (logged, but does NOT block the tool call).
 *
 * Never throws. Every failure mode returns a typed HookInvocationResult.
 */
export async function runHook(
  def: HookDefinition,
  stdinPayload: unknown,
  signal: AbortSignal,
): Promise<HookInvocationResult> {
  const started = Date.now()
  const timeout = def.timeout ?? DEFAULT_HOOK_TIMEOUT_MS
  const expandedCommand = expandHome(def.command)

  let child: ChildProcess
  try {
    child = spawn(expandedCommand, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    })
  } catch (err) {
    return {
      outcome: 'error',
      stderrPreview: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      durationMs: Date.now() - started,
      outputTruncated: false,
    }
  }

  // Write stdin and close. Swallow EPIPE — the child may exit before we finish writing.
  if (child.stdin) {
    child.stdin.on('error', () => {})
    try {
      child.stdin.end(JSON.stringify(stdinPayload))
    } catch {
      // nothing — we'll get the exit signal below
    }
  }

  const collected = await collectChildCapped(
    child,
    MAX_HOOK_STDOUT_BYTES,
    MAX_HOOK_STDERR_BYTES,
    signal,
    timeout,
  )

  const durationMs = Date.now() - started
  const { exitCode, stdout, stderr, outputTruncated, spawnError, timedOut } = collected
  const stderrPreview = stderr.slice(0, 200)
  const common = { stderrPreview, durationMs, outputTruncated }

  // Spawn failure (e.g. shell couldn't resolve the command).
  if (spawnError) {
    return {
      outcome: 'error',
      stderrPreview: spawnError.message.slice(0, 200),
      durationMs,
      outputTruncated,
    }
  }

  if (signal.aborted) return { outcome: 'error', ...common }
  if (timedOut) return { outcome: 'timeout', ...common }

  // Exit code 2 — block, reason from stderr.
  if (exitCode === 2) {
    return {
      outcome: 'block',
      reason: stderr.trim() || '(no reason given)',
      exitCode: 2,
      ...common,
    }
  }

  // Any other non-zero — error, does NOT block.
  if (exitCode !== 0) {
    return {
      outcome: 'error',
      exitCode: exitCode ?? undefined,
      ...common,
    }
  }

  // exit 0 — parse stdout if any.
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return { outcome: 'ok', exitCode: 0, ...common }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Non-JSON stdout on exit-0 is tolerated: pass-through.
    return { outcome: 'ok', exitCode: 0, ...common }
  }

  const fields = extractHookFields(parsed)

  // Stdout-declared block → outcome:'block'. Load-bearing: the orchestrator
  // only short-circuits on outcome === 'block'.
  if (fields.decision === 'block') {
    return {
      outcome: 'block',
      reason: fields.reason ?? '(no reason given)',
      exitCode: 0,
      ...common,
    }
  }

  return {
    outcome: 'ok',
    exitCode: 0,
    ...(fields.updatedInput !== undefined && { updatedInput: fields.updatedInput }),
    ...(fields.additionalContext !== undefined && { additionalContext: fields.additionalContext }),
    ...common,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHome(cmd: string): string {
  if (cmd.startsWith('~/')) return `${homedir()}/${cmd.slice(2)}`
  if (cmd === '~') return homedir()
  return cmd
}

type CollectedChildOutput = {
  exitCode: number | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  spawnError?: Error
  timedOut: boolean
}

function collectChildCapped(
  child: ChildProcess,
  maxStdoutBytes: number,
  maxStderrBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CollectedChildOutput> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let spawnError: Error | undefined
    let settled = false
    let timedOut = false

    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        outputTruncated: truncated,
        timedOut,
        ...(spawnError && { spawnError }),
      })
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const remaining = maxStdoutBytes - stdoutBytes
        if (remaining <= 0) {
          truncated = true
          return
        }
        if (chunk.length > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining))
          stdoutBytes += remaining
          truncated = true
        } else {
          stdoutChunks.push(chunk)
          stdoutBytes += chunk.length
        }
      })
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const remaining = maxStderrBytes - stderrBytes
        if (remaining <= 0) {
          truncated = true
          return
        }
        if (chunk.length > remaining) {
          stderrChunks.push(chunk.subarray(0, remaining))
          stderrBytes += remaining
          truncated = true
        } else {
          stderrChunks.push(chunk)
          stderrBytes += chunk.length
        }
      })
    }

    child.on('error', (err) => {
      spawnError = err
    })

    child.on('close', (code) => {
      settle(code)
    })

    // Both abort and timeout send SIGKILL and settle synchronously. Shell
    // wrappers can swallow SIGTERM; SIGKILL cannot be trapped, so the
    // process group dies and the 'close' event fires (eventually) — but we
    // settle the promise immediately either way so the caller does not hang
    // on orphaned shells. See Phase 2b design Risk #2.
    const killAndSettle = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already exited
      }
      settle(null)
    }

    const onAbort = (): void => {
      killAndSettle()
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      killAndSettle()
    }, timeoutMs)

    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

type HookResponseFields = {
  decision?: 'block'
  reason?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string
}

function extractHookFields(parsed: unknown): HookResponseFields {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {}
  }
  const o = parsed as Record<string, unknown>
  const out: HookResponseFields = {}
  if (o.decision === 'block') out.decision = 'block'
  if (typeof o.reason === 'string') out.reason = o.reason
  if (typeof o.updatedInput === 'object' && o.updatedInput !== null && !Array.isArray(o.updatedInput)) {
    out.updatedInput = o.updatedInput as Record<string, unknown>
  }
  if (typeof o.additionalContext === 'string') out.additionalContext = o.additionalContext
  return out
}
