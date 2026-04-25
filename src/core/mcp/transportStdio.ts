import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/**
 * Stdio transport for an MCP server subprocess.
 *
 * Writes newline-delimited frames to the child's stdin; splits the child's
 * stdout on newlines and emits each complete line via onLine. Transport
 * errors (spawn failure, bounded stderr bursts) flow through onError.
 *
 * close(graceMs) sends SIGTERM, waits up to graceMs for a clean exit, then
 * SIGKILLs. Matches the shape of src/hooks/runHook.ts's killAndSettle.
 */

export type StdioTransport = {
  send(line: string): void
  onLine(cb: (line: string) => void): void
  onError(cb: (err: Error) => void): void
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
  close(graceMs?: number): Promise<void>
}

export type SpawnStdioTransportArgs = {
  command: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
  cwd?: string
}

export const DEFAULT_CLOSE_GRACE_MS = 2000
const STDERR_RING_BYTES = 16_384

export function spawnStdioTransport(args: SpawnStdioTransportArgs): StdioTransport {
  const lineHandlers: Array<(line: string) => void> = []
  const errorHandlers: Array<(err: Error) => void> = []
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []

  let closed = false
  let stdoutBuffer = ''

  const mergedEnv = { ...process.env, ...(args.env ?? {}) }

  let child: ChildProcess
  try {
    child = spawn(args.command, [...args.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mergedEnv as NodeJS.ProcessEnv,
      ...(args.cwd !== undefined && { cwd: args.cwd }),
    })
  } catch (err) {
    // Return a transport that immediately emits error+exit so the caller's
    // connect() sees a transport failure instead of throwing from spawn.
    const e = err instanceof Error ? err : new Error(String(err))
    queueMicrotask(() => {
      for (const cb of errorHandlers) cb(e)
      for (const cb of exitHandlers) cb(null, null)
    })
    return {
      send: () => {},
      onLine: (cb) => void lineHandlers.push(cb),
      onError: (cb) => void errorHandlers.push(cb),
      onExit: (cb) => void exitHandlers.push(cb),
      close: async () => {},
    }
  }

  if (child.stdout) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      let nl: number
      while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, nl)
        stdoutBuffer = stdoutBuffer.slice(nl + 1)
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        if (trimmed.length === 0) continue
        for (const cb of lineHandlers) cb(trimmed)
      }
    })
  }

  // Bounded stderr ring. Avoids unbounded memory from a chatty server.
  let stderrRing = ''
  if (child.stderr) {
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrRing += chunk
      if (stderrRing.length > STDERR_RING_BYTES) {
        stderrRing = stderrRing.slice(-STDERR_RING_BYTES)
      }
    })
  }

  child.on('error', (err) => {
    for (const cb of errorHandlers) cb(err)
  })

  child.on('exit', (code, signal) => {
    if (stderrRing.length > 0) {
      const snapshot = stderrRing
      stderrRing = ''
      for (const cb of errorHandlers) {
        cb(new Error(`stderr: ${snapshot}`))
      }
    }
    for (const cb of exitHandlers) cb(code, signal)
  })

  if (child.stdin) {
    child.stdin.on('error', () => {
      // Swallow EPIPE — we handle disconnect via 'exit'.
    })
  }

  return {
    send(line: string): void {
      if (closed || !child.stdin || child.stdin.destroyed) return
      const withNewline = line.endsWith('\n') ? line : line + '\n'
      try {
        child.stdin.write(withNewline)
      } catch {
        // Swallow; the exit handler will surface the failure.
      }
    },
    onLine(cb: (line: string) => void): void {
      lineHandlers.push(cb)
    },
    onError(cb: (err: Error) => void): void {
      errorHandlers.push(cb)
    },
    onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
      exitHandlers.push(cb)
    },
    close(graceMs = DEFAULT_CLOSE_GRACE_MS): Promise<void> {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
          return
        }
        let settled = false
        const done = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        child.once('exit', done)
        try {
          child.stdin?.end()
        } catch {
          // ignore
        }
        try {
          child.kill('SIGTERM')
        } catch {
          // already gone
          done()
          return
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
          done()
        }, graceMs)
      })
    },
  }
}
