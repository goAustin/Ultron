/**
 * JSON-RPC 2.0 framing helpers.
 *
 * MCP over stdio uses newline-delimited JSON-RPC messages (no Content-Length
 * prefix). Each frame is a single JSON document terminated by '\n'.
 */

export type JsonRpcId = number | string

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcSuccess = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export type JsonRpcErrorObject = {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcErrorResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: JsonRpcErrorObject
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse

export function encodeRequest(id: JsonRpcId, method: string, params?: unknown): string {
  const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method }
  if (params !== undefined) msg.params = params
  return JSON.stringify(msg) + '\n'
}

export function encodeNotification(method: string, params?: unknown): string {
  const msg: JsonRpcNotification = { jsonrpc: '2.0', method }
  if (params !== undefined) msg.params = params
  return JSON.stringify(msg) + '\n'
}

/**
 * Parse a single line (frame). Returns null for anything that is not a valid
 * JSON-RPC 2.0 response or notification. Callers use the null to log a
 * warning and keep going without desyncing.
 */
export function parseFrame(line: string): JsonRpcResponse | JsonRpcNotification | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  const obj = parsed
  if (obj.jsonrpc !== '2.0') return null

  // Response (has id)
  if ('id' in obj && (typeof obj.id === 'number' || typeof obj.id === 'string')) {
    if ('result' in obj) {
      return { jsonrpc: '2.0', id: obj.id as JsonRpcId, result: obj.result }
    }
    if ('error' in obj && isPlainObject(obj.error)) {
      const err = obj.error
      if (typeof err.code !== 'number' || typeof err.message !== 'string') return null
      const errorObj: JsonRpcErrorObject = { code: err.code, message: err.message }
      if ('data' in err) errorObj.data = err.data
      return { jsonrpc: '2.0', id: obj.id as JsonRpcId, error: errorObj }
    }
    return null
  }

  // Notification (no id)
  if (typeof obj.method === 'string') {
    const n: JsonRpcNotification = { jsonrpc: '2.0', method: obj.method }
    if ('params' in obj) n.params = obj.params
    return n
  }

  return null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
