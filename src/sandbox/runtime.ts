/**
 * Sandbox runtime — `runSandbox(opts)` is the single entrypoint used by
 * `CodeSandboxTool`. Each call spawns a fresh `worker_threads.Worker` via
 * the inline-eval form (BOOTSTRAP_SOURCE), races wall-clock + abort + worker
 * message, and unconditionally terminates the worker on settle.
 *
 * The WASM-bound interpreter (QuickJS for JS, Pyodide for Python) lives
 * inside the worker — see `workerBootstrap.ts`. The boundary is: V8 isolate
 * (worker_threads) wrapping a WASM heap (the interpreter). No Node globals
 * leak into user code.
 */

import { Worker, type WorkerOptions } from 'worker_threads'
import { BOOTSTRAP_SOURCE } from './workerBootstrap.js'

export type SandboxLanguage = 'python' | 'javascript'

export interface SandboxOpts {
  readonly language: SandboxLanguage
  readonly code: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly maxOutputBytes: number
}

export interface SandboxResult {
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly exitError?: string
}

const WORKER_OPTIONS: WorkerOptions = {
  eval: true,
  env: {},
  execArgv: [],
  resourceLimits: { maxOldGenerationSizeMb: 256 },
}

export async function runSandbox(opts: SandboxOpts): Promise<SandboxResult> {
  if (opts.signal.aborted) {
    return {
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: true,
      exitError: '[aborted]',
    }
  }

  const worker = new Worker(BOOTSTRAP_SOURCE, WORKER_OPTIONS)

  return new Promise<SandboxResult>((resolve) => {
    let settled = false

    const settle = (result: SandboxResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      opts.signal.removeEventListener('abort', onAbort)
      worker.removeAllListeners()
      void worker.terminate()
      resolve(result)
    }

    const killWith = (reason: 'timeout' | 'abort'): void => {
      settle({
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: reason === 'timeout',
        aborted: reason === 'abort',
        exitError:
          reason === 'timeout'
            ? `[killed: wall-clock timeout ${opts.timeoutMs}ms]`
            : '[aborted]',
      })
    }

    const timeoutHandle = setTimeout(() => killWith('timeout'), opts.timeoutMs)
    const onAbort = (): void => killWith('abort')
    opts.signal.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (msg: Record<string, unknown>) => {
      settle({
        stdout: typeof msg.stdout === 'string' ? msg.stdout : '',
        stderr: typeof msg.stderr === 'string' ? msg.stderr : '',
        truncated: Boolean(msg.truncated),
        timedOut: false,
        aborted: false,
        ...(typeof msg.exitError === 'string' && { exitError: msg.exitError }),
      })
    })

    worker.on('error', (err: Error) => {
      settle({
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        aborted: false,
        exitError: err.message,
      })
    })

    worker.postMessage({
      language: opts.language,
      code: opts.code,
      maxOutputBytes: opts.maxOutputBytes,
    })
  })
}
