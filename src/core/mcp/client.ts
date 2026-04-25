import {
  encodeRequest,
  encodeNotification,
  parseFrame,
  type JsonRpcId,
  type JsonRpcResponse,
} from './jsonrpc.js'
import type { StdioTransport } from './transportStdio.js'
import type { McpServerConfig } from './config.js'
import type { ToolProgressInput } from '../tools/context.js'
import { McpInitializeError, McpProtocolError, McpTransportError } from './errors.js'

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const MCP_PROTOCOL_VERSION = '2024-11-05'
export const CLIENT_INFO = { name: 'ultron', version: '0.1.0' } as const

export type McpClientState = 'idle' | 'connecting' | 'ready' | 'closed' | 'failed'

export type McpToolDescriptor = {
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
}

export type McpToolCallResult =
  | { kind: 'ok'; content: string; isError: boolean }
  | { kind: 'transport_error'; message: string }
  | { kind: 'protocol_error'; code: number; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'aborted' }

export interface McpClient {
  readonly serverName: string
  readonly state: McpClientState
  readonly lastError: Error | null
  connect(signal: AbortSignal): Promise<void>
  listedTools(): readonly McpToolDescriptor[]
  callTool(
    name: string,
    args: unknown,
    signal: AbortSignal,
    onProgress?: (progress: ToolProgressInput) => void,
  ): Promise<McpToolCallResult>
  close(): Promise<void>
}

type Pending = {
  resolve(value: JsonRpcResponse): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

export function createMcpClient(
  serverName: string,
  cfg: McpServerConfig,
  transport: StdioTransport,
): McpClient {
  let state: McpClientState = 'idle'
  let lastError: Error | null = null
  let nextId = 1
  const pending = new Map<JsonRpcId, Pending>()
  let tools: McpToolDescriptor[] = []
  const requestTimeoutMs = cfg.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  // Phase 3d: per-call progress sinks keyed by progressToken. Lifetime is
  // bounded by the originating tools/call — every termination path
  // (resolve, reject, timeout, abort, transport exit) deletes the entry.
  let progressTokenCounter = 0
  const progressSinks = new Map<string, (p: ToolProgressInput) => void>()

  transport.onLine((line) => {
    const frame = parseFrame(line)
    if (frame === null) {
      // Malformed frame — log and keep going; do not desync.
      process.stderr.write(
        `[mcp] server "${serverName}" sent unparseable frame (${line.length} bytes)\n`,
      )
      return
    }
    // Notification (no id) — dispatch by method.
    if (!('id' in frame)) {
      if (frame.method === 'notifications/progress') {
        dispatchProgress(frame.params)
      }
      // Unknown notification — silently drop. Resources/prompts are out of
      // scope for 3d.
      return
    }
    const entry = pending.get(frame.id)
    if (!entry) {
      // Late response (e.g., after an abort). Silently drop.
      return
    }
    pending.delete(frame.id)
    clearTimeout(entry.timer)
    entry.resolve(frame)
  })

  function dispatchProgress(params: unknown): void {
    if (!isPlainObject(params)) return
    const token = params.progressToken
    if (typeof token !== 'string' && typeof token !== 'number') return
    const sink = progressSinks.get(String(token))
    if (!sink) return // unknown / late — silently drop
    const progress = typeof params.progress === 'number' ? params.progress : 0
    const total = typeof params.total === 'number' ? params.total : undefined
    const message = typeof params.message === 'string' ? params.message : undefined
    const input: ToolProgressInput = {
      progress,
      ...(total !== undefined && { total }),
      ...(message !== undefined && { message }),
    }
    sink(input)
  }

  transport.onError((err) => {
    lastError = err
  })

  transport.onExit(() => {
    const wasActive = state !== 'closed'
    state = wasActive ? 'failed' : state
    // Reject every in-flight request. Their reject handlers already clear
    // their own progress sinks; this map.clear is defensive for any sink
    // whose owning call hasn't been registered in `pending` yet.
    const snapshot = [...pending.entries()]
    pending.clear()
    for (const [, entry] of snapshot) {
      clearTimeout(entry.timer)
      entry.reject(new McpTransportError(serverName, 'Transport exited'))
    }
    progressSinks.clear()
  })

  function request(method: string, params: unknown): Promise<JsonRpcResponse> {
    if (state === 'closed' || state === 'failed') {
      return Promise.reject(new McpTransportError(serverName, `Client is ${state}`))
    }
    const id = nextId++
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new McpProtocolError(serverName, `Request "${method}" timed out`))
      }, requestTimeoutMs)
      pending.set(id, { resolve, reject, timer })
      transport.send(encodeRequest(id, method, params))
    })
  }

  async function connect(signal: AbortSignal): Promise<void> {
    if (state !== 'idle') {
      throw new McpInitializeError(serverName, `Cannot connect from state "${state}"`)
    }
    state = 'connecting'

    const onAbort = (): void => {
      // Clear pending on abort so promises don't hang.
      const snapshot = [...pending.entries()]
      pending.clear()
      for (const [, entry] of snapshot) {
        clearTimeout(entry.timer)
        entry.reject(new McpInitializeError(serverName, 'Aborted during connect'))
      }
    }
    if (signal.aborted) {
      onAbort()
      throw new McpInitializeError(serverName, 'Aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const initResp = await request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      })
      if ('error' in initResp) {
        throw new McpInitializeError(
          serverName,
          `initialize failed: ${initResp.error.message} (code ${initResp.error.code})`,
        )
      }

      transport.send(encodeNotification('notifications/initialized'))

      const listResp = await request('tools/list', {})
      if ('error' in listResp) {
        throw new McpInitializeError(
          serverName,
          `tools/list failed: ${listResp.error.message} (code ${listResp.error.code})`,
        )
      }

      tools = extractToolDescriptors(listResp.result, serverName)
      state = 'ready'
    } catch (err) {
      state = 'failed'
      lastError = err instanceof Error ? err : new Error(String(err))
      throw err
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function callTool(
    name: string,
    args: unknown,
    signal: AbortSignal,
    onProgress?: (progress: ToolProgressInput) => void,
  ): Promise<McpToolCallResult> {
    if (state !== 'ready') {
      return { kind: 'transport_error', message: `Client is ${state}` }
    }

    const id = nextId++

    // Phase 3d: only attach a progressToken when the caller actually wants
    // progress. Saves the server from emitting work nobody listens to.
    let progressToken: string | undefined
    if (onProgress) {
      progressToken = `p${++progressTokenCounter}`
      progressSinks.set(progressToken, onProgress)
    }
    const cleanupSink = (): void => {
      if (progressToken !== undefined) progressSinks.delete(progressToken)
    }

    const params: Record<string, unknown> = { name, arguments: args }
    if (progressToken !== undefined) {
      params._meta = { progressToken }
    }

    return new Promise<McpToolCallResult>((resolve) => {
      const onAbort = (): void => {
        // `pending.has(id)` is the settled-gate: if the response already
        // arrived, the entry was cleared and we must NOT send a cancel
        // for a completed call. Otherwise, fire-and-forget $/cancelRequest
        // so the server can stop compute. Transport may be closed — swallow.
        const entry = pending.get(id)
        if (entry) {
          pending.delete(id)
          clearTimeout(entry.timer)
          try {
            transport.send(encodeNotification('$/cancelRequest', { id }))
          } catch {
            // transport already closed; fire-and-forget contract preserved.
          }
        }
        signal.removeEventListener('abort', onAbort)
        cleanupSink()
        resolve({ kind: 'aborted' })
      }

      if (signal.aborted) {
        cleanupSink()
        resolve({ kind: 'aborted' })
        return
      }

      const timer = setTimeout(() => {
        pending.delete(id)
        signal.removeEventListener('abort', onAbort)
        cleanupSink()
        resolve({
          kind: 'timeout',
          message: `tools/call "${name}" timed out after ${requestTimeoutMs}ms`,
        })
      }, requestTimeoutMs)

      pending.set(id, {
        resolve(frame) {
          signal.removeEventListener('abort', onAbort)
          cleanupSink()
          if ('error' in frame) {
            resolve({
              kind: 'protocol_error',
              code: frame.error.code,
              message: frame.error.message,
            })
            return
          }
          resolve(flattenCallResult(frame.result))
        },
        reject(err) {
          signal.removeEventListener('abort', onAbort)
          cleanupSink()
          if (err instanceof McpTransportError) {
            resolve({ kind: 'transport_error', message: err.message })
          } else {
            resolve({ kind: 'transport_error', message: err.message })
          }
        },
        timer,
      })

      signal.addEventListener('abort', onAbort, { once: true })
      transport.send(encodeRequest(id, 'tools/call', params))
    })
  }

  async function close(): Promise<void> {
    if (state === 'closed') return
    state = 'closed'
    const snapshot = [...pending.entries()]
    pending.clear()
    for (const [, entry] of snapshot) {
      clearTimeout(entry.timer)
      entry.reject(new McpTransportError(serverName, 'Client closed'))
    }
    progressSinks.clear()
    await transport.close()
  }

  const client: McpClient = {
    serverName,
    get state() {
      return state
    },
    get lastError() {
      return lastError
    },
    connect,
    listedTools() {
      return tools
    },
    callTool,
    close,
  }

  return client
}

function extractToolDescriptors(result: unknown, serverName: string): McpToolDescriptor[] {
  if (!isPlainObject(result) || !Array.isArray(result.tools)) return []
  const out: McpToolDescriptor[] = []
  for (const [i, entry] of result.tools.entries()) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || entry.inputSchema === undefined) {
      process.stderr.write(
        `[mcp] server "${serverName}" tool #${i} dropped: missing name or inputSchema\n`,
      )
      continue
    }
    const desc: McpToolDescriptor = {
      name: entry.name,
      inputSchema: entry.inputSchema,
      ...(typeof entry.description === 'string' && { description: entry.description }),
    }
    out.push(desc)
  }
  return out
}

function flattenCallResult(result: unknown): McpToolCallResult {
  if (!isPlainObject(result)) {
    return { kind: 'ok', content: '', isError: false }
  }
  const isError = result.isError === true
  if (!Array.isArray(result.content)) {
    return { kind: 'ok', content: '', isError }
  }
  const parts: string[] = []
  for (const block of result.content) {
    if (!isPlainObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      const mediaType = typeof block.mimeType === 'string' ? block.mimeType : 'unknown'
      const size = typeof block.data === 'string' ? block.data.length : 0
      parts.push(`[image: ${mediaType}, ${size} bytes]`)
    } else if (typeof block.type === 'string') {
      parts.push(`[${block.type} block]`)
    }
  }
  return { kind: 'ok', content: parts.join('\n'), isError }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
