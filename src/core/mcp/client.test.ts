import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'

import { createMcpClient } from './client.js'
import type { StdioTransport } from './transportStdio.js'
import type { McpServerConfig } from './config.js'

/**
 * In-process fake transport driven by an EventEmitter. Tests script request/
 * response pairs without touching real subprocesses.
 */
type Handler = (req: { id: number | string; method: string; params: unknown }) => unknown | {
  error: { code: number; message: string }
}

type FakeOptions = {
  handlers?: Partial<Record<string, Handler>>
  // If true, responses are never sent — forces timeout.
  stall?: boolean
  // If set, exit after this many responses.
  exitAfter?: number
}

function fakeTransport(opts: FakeOptions = {}): StdioTransport & {
  simulateExit(code?: number | null): void
  emitLine(line: string): void
  sentFrames: string[]
} {
  const ee = new EventEmitter()
  const sentFrames: string[] = []
  let responseCount = 0

  const onLineHandlers: Array<(line: string) => void> = []
  const onExitHandlers: Array<(code: number | null, sig: NodeJS.Signals | null) => void> = []
  const onErrorHandlers: Array<(err: Error) => void> = []

  ee.on('line', (line: string) => {
    for (const cb of onLineHandlers) cb(line)
  })

  return {
    send(line: string) {
      sentFrames.push(line)
      let req: { id?: number | string; method: string; params: unknown }
      try {
        req = JSON.parse(line) as { id?: number | string; method: string; params: unknown }
      } catch {
        return
      }
      // Notifications have no id — nothing to respond to.
      if (req.id === undefined) return
      if (opts.stall) return
      const handler = opts.handlers?.[req.method]
      queueMicrotask(async () => {
        let responseObj: Record<string, unknown>
        if (!handler) {
          responseObj = {
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32601, message: 'Method not found' },
          }
        } else {
          // Allow handlers to return either a sync value or a Promise. When
          // a handler returns a Promise the response is sent only after it
          // resolves — that lets tests interleave progress notifications
          // before the final tools/call response.
          const raw = handler(req as { id: number | string; method: string; params: unknown })
          const result = raw instanceof Promise ? await raw : raw
          if (typeof result === 'object' && result !== null && 'error' in result) {
            responseObj = {
              jsonrpc: '2.0',
              id: req.id,
              error: (result as { error: { code: number; message: string } }).error,
            }
          } else {
            responseObj = { jsonrpc: '2.0', id: req.id, result }
          }
        }
        ee.emit('line', JSON.stringify(responseObj))
        responseCount++
        if (opts.exitAfter !== undefined && responseCount >= opts.exitAfter) {
          for (const cb of onExitHandlers) cb(0, null)
        }
      })
    },
    onLine(cb) {
      onLineHandlers.push(cb)
    },
    onError(cb) {
      onErrorHandlers.push(cb)
    },
    onExit(cb) {
      onExitHandlers.push(cb)
    },
    async close() {
      for (const cb of onExitHandlers) cb(0, 'SIGTERM')
    },
    simulateExit(code = 0) {
      for (const cb of onExitHandlers) cb(code, null)
    },
    emitLine(line: string) {
      ee.emit('line', line)
    },
    sentFrames,
  }
}

const noTimeoutCfg: McpServerConfig = { command: 'unused', timeoutMs: 60_000 }
const quickTimeoutCfg: McpServerConfig = { command: 'unused', timeoutMs: 50 }

describe('McpClient.connect', () => {
  it('performs initialize + tools/list happy path', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake' } }),
        'tools/list': () => ({
          tools: [
            { name: 'echo', description: 'Echo back', inputSchema: { type: 'object' } },
            { name: 'ping', inputSchema: { type: 'object' } },
          ],
        }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    expect(client.state).toBe('ready')
    const tools = client.listedTools()
    expect(tools).toHaveLength(2)
    expect(tools[0]).toEqual({ name: 'echo', description: 'Echo back', inputSchema: { type: 'object' } })
    expect(tools[1]).toEqual({ name: 'ping', inputSchema: { type: 'object' } })
  })

  it('drops invalid tool entries with a stderr warning', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({
          tools: [
            { name: 'good', inputSchema: { type: 'object' } },
            { inputSchema: { type: 'object' } }, // missing name
            { name: 'no-schema' }, // missing inputSchema
          ],
        }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    expect(client.listedTools().map(t => t.name)).toEqual(['good'])
  })

  it('fails with McpInitializeError if initialize returns an error response', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({ error: { code: -32000, message: 'not allowed' } }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await expect(client.connect(new AbortController().signal)).rejects.toThrow(/initialize failed/)
    expect(client.state).toBe('failed')
  })

  it('times out when the server never responds', async () => {
    const t = fakeTransport({ stall: true })
    const client = createMcpClient('fake', quickTimeoutCfg, t)
    await expect(client.connect(new AbortController().signal)).rejects.toThrow(/timed out/)
    expect(client.state).toBe('failed')
  })

  it('sends notifications/initialized after a successful initialize', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [] }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    const methods = t.sentFrames.map(f => (JSON.parse(f) as { method: string }).method)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
  })
})

describe('McpClient.callTool', () => {
  async function connected(handlers: FakeOptions['handlers']) {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        ...handlers,
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    return { client, transport: t }
  }

  it('returns ok on a successful call', async () => {
    const { client } = await connected({
      'tools/call': () => ({ content: [{ type: 'text', text: 'hello' }] }),
    })
    const res = await client.callTool('echo', { x: 1 }, new AbortController().signal)
    expect(res).toEqual({ kind: 'ok', content: 'hello', isError: false })
  })

  it('preserves isError from the server response', async () => {
    const { client } = await connected({
      'tools/call': () => ({ content: [{ type: 'text', text: 'bad' }], isError: true }),
    })
    const res = await client.callTool('echo', {}, new AbortController().signal)
    expect(res).toEqual({ kind: 'ok', content: 'bad', isError: true })
  })

  it('surfaces protocol_error on a server error response', async () => {
    const { client } = await connected({
      'tools/call': () => ({ error: { code: -32000, message: 'nope' } }),
    })
    const res = await client.callTool('echo', {}, new AbortController().signal)
    expect(res).toEqual({ kind: 'protocol_error', code: -32000, message: 'nope' })
  })

  it('returns timeout when the server stalls', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
      },
    })
    const client = createMcpClient('fake', { command: 'x', timeoutMs: 50 }, t)
    await client.connect(new AbortController().signal)
    // Override send so tools/call never gets a response.
    const origSend = t.send
    t.send = (line) => {
      const parsed = JSON.parse(line) as { method?: string }
      if (parsed.method === 'tools/call') return
      origSend.call(t, line)
    }
    const res = await client.callTool('echo', {}, new AbortController().signal)
    expect(res.kind).toBe('timeout')
  })

  it('returns aborted when the signal is aborted during the call', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    // Override send so tools/call never gets a response.
    const origSend = t.send
    t.send = (line) => {
      const parsed = JSON.parse(line) as { method?: string }
      if (parsed.method === 'tools/call') return
      origSend.call(t, line)
    }

    const ctrl = new AbortController()
    const promise = client.callTool('echo', {}, ctrl.signal)
    ctrl.abort()
    const res = await promise
    expect(res).toEqual({ kind: 'aborted' })
  })

  it('sends $/cancelRequest when an in-flight call is aborted (Phase 3b)', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    // Capture the tools/call id (it's the next request after initialize +
    // tools/list, so id=3), then stall.
    const origSend = t.send
    t.send = (line) => {
      const parsed = JSON.parse(line) as { method?: string }
      if (parsed.method === 'tools/call') {
        // Record the frame so the assertion can see it, but don't respond.
        t.sentFrames.push(line)
        return
      }
      origSend.call(t, line)
    }
    const ctrl = new AbortController()
    const callPromise = client.callTool('echo', { a: 1 }, ctrl.signal)
    ctrl.abort()
    const res = await callPromise
    expect(res).toEqual({ kind: 'aborted' })

    const cancelFrame = t.sentFrames.find((line) => {
      try {
        const obj = JSON.parse(line) as { method?: string }
        return obj.method === '$/cancelRequest'
      } catch {
        return false
      }
    })
    expect(cancelFrame).toBeDefined()
    const cancelObj = JSON.parse(cancelFrame!) as {
      jsonrpc: string
      method: string
      params: { id: number }
    }
    expect(cancelObj.jsonrpc).toBe('2.0')
    expect(cancelObj.method).toBe('$/cancelRequest')
    // Cancel id must match the original tools/call id.
    const toolsCallFrame = t.sentFrames.find((line) => {
      try {
        const obj = JSON.parse(line) as { method?: string }
        return obj.method === 'tools/call'
      } catch {
        return false
      }
    })
    const toolsCallId = (JSON.parse(toolsCallFrame!) as { id: number }).id
    expect(cancelObj.params.id).toBe(toolsCallId)
  })

  it('does not send $/cancelRequest when abort fires after the response already arrived', async () => {
    let resolveServer: ((v: unknown) => void) | null = null
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        'tools/call': () =>
          new Promise(r => {
            resolveServer = r as (v: unknown) => void
          }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    const ctrl = new AbortController()
    const callPromise = client.callTool('echo', {}, ctrl.signal)
    // Wait for the server handler to run (which captures resolveServer).
    while (!resolveServer) {
      await new Promise(r => setTimeout(r, 0))
    }
    // Let the server respond first.
    ;(resolveServer as (v: unknown) => void)({ content: [{ type: 'text', text: 'done' }] })
    const res = await callPromise
    expect(res.kind).toBe('ok')
    // Now abort after the call resolved. No $/cancelRequest should be sent.
    ctrl.abort()
    // Allow any microtasks to flush.
    await new Promise(r => setTimeout(r, 10))
    const cancelFrames = t.sentFrames.filter((line) => {
      try {
        return (JSON.parse(line) as { method?: string }).method === '$/cancelRequest'
      } catch {
        return false
      }
    })
    expect(cancelFrames).toHaveLength(0)
  })

  it('swallows transport send errors when sending $/cancelRequest on a closed transport', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    // Stall tools/call and make any later send throw.
    const origSend = t.send
    let stallActive = true
    t.send = (line) => {
      const parsed = JSON.parse(line) as { method?: string }
      if (parsed.method === 'tools/call') {
        // Record then stall.
        t.sentFrames.push(line)
        // After the tools/call is sent, make the transport throw on further sends.
        stallActive = true
        return
      }
      if (stallActive && parsed.method === '$/cancelRequest') {
        throw new Error('transport closed')
      }
      origSend.call(t, line)
    }
    const ctrl = new AbortController()
    const callPromise = client.callTool('echo', {}, ctrl.signal)
    ctrl.abort()
    // Must resolve {aborted} without propagating the send error.
    const res = await callPromise
    expect(res).toEqual({ kind: 'aborted' })
  })

  it('surfaces transport_error when the subprocess exits', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)

    // Make tools/call stall, then simulate exit.
    const origSend = t.send
    t.send = (line) => {
      const parsed = JSON.parse(line) as { method?: string }
      if (parsed.method === 'tools/call') return
      origSend.call(t, line)
    }
    const promise = client.callTool('echo', {}, new AbortController().signal)
    t.simulateExit(1)
    const res = await promise
    expect(res.kind).toBe('transport_error')
  })

  it('drops late responses for aborted requests without crashing', async () => {
    let resolveServer: ((v: unknown) => void) | null = null
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        'tools/call': () =>
          new Promise(r => {
            resolveServer = r as (v: unknown) => void
          }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    const ctrl = new AbortController()
    const p = client.callTool('echo', {}, ctrl.signal)
    ctrl.abort()
    const res = await p
    expect(res).toEqual({ kind: 'aborted' })
    // Late server response arrives after abort. Should not crash.
    const r = resolveServer as null | ((v: unknown) => void)
    if (r) r({ content: [{ type: 'text', text: 'late' }] })
    await new Promise(r => setTimeout(r, 20))
    expect(client.state).toBe('ready')
  })

  it('flattens image content blocks to a placeholder', async () => {
    const { client } = await connected({
      'tools/call': () => ({
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'text', text: 'after' },
        ],
      }),
    })
    const res = await client.callTool('echo', {}, new AbortController().signal)
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.content).toBe('before\n[image: image/png, 4 bytes]\nafter')
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 3d: progress notifications
// ---------------------------------------------------------------------------

describe('McpClient.callTool progress (Phase 3d)', () => {
  function findToolsCallFrame(frames: string[]): { id: number; params: { _meta?: { progressToken: string } } } | null {
    for (const f of frames) {
      try {
        const parsed = JSON.parse(f) as { method?: string; id: number; params: { _meta?: { progressToken: string } } }
        if (parsed.method === 'tools/call') return parsed
      } catch {
        // ignore
      }
    }
    return null
  }

  it('does NOT attach _meta.progressToken when no onProgress is provided', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        'tools/call': () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    await client.callTool('echo', { x: 1 }, new AbortController().signal)
    const frame = findToolsCallFrame(t.sentFrames)
    expect(frame).not.toBeNull()
    expect(frame!.params._meta).toBeUndefined()
  })

  it('attaches _meta.progressToken when onProgress is provided', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        'tools/call': () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)
    await client.callTool('echo', {}, new AbortController().signal, () => {})
    const frame = findToolsCallFrame(t.sentFrames)
    expect(frame).not.toBeNull()
    expect(frame!.params._meta).toBeDefined()
    expect(typeof frame!.params._meta!.progressToken).toBe('string')
  })

  it('routes notifications/progress to the registered sink with normalized fields', async () => {
    let resolveServer: ((v: unknown) => void) | null = null
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        'tools/call': () =>
          new Promise((r) => {
            resolveServer = r as (v: unknown) => void
          }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)

    const received: unknown[] = []
    const callPromise = client.callTool('echo', {}, new AbortController().signal, (p) => received.push(p))

    while (!resolveServer) {
      await new Promise((r) => setTimeout(r, 0))
    }
    const frame = findToolsCallFrame(t.sentFrames)
    const token = frame!.params._meta!.progressToken

    t.emitLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 1, total: 3, message: 'first' },
    }))
    t.emitLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 2 },
    }))

    ;(resolveServer as (v: unknown) => void)({ content: [{ type: 'text', text: 'done' }] })
    await callPromise

    expect(received).toEqual([
      { progress: 1, total: 3, message: 'first' },
      { progress: 2 },
    ])
  })

  it('drops progress notifications with unknown tokens silently', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        'tools/call': () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)

    const received: unknown[] = []
    // No call in flight — just inject a stray progress notification.
    t.emitLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'ghost', progress: 1 },
    }))
    expect(received).toEqual([])
    expect(client.state).toBe('ready')
  })

  it('drops late progress (after response resolved) silently', async () => {
    let resolveServer: ((v: unknown) => void) | null = null
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        'tools/call': () =>
          new Promise((r) => {
            resolveServer = r as (v: unknown) => void
          }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)

    const received: unknown[] = []
    const callPromise = client.callTool('echo', {}, new AbortController().signal, (p) => received.push(p))
    while (!resolveServer) {
      await new Promise((r) => setTimeout(r, 0))
    }
    const frame = findToolsCallFrame(t.sentFrames)
    const token = frame!.params._meta!.progressToken
    ;(resolveServer as (v: unknown) => void)({ content: [{ type: 'text', text: 'done' }] })
    await callPromise

    // After resolution, late progress for the same token must drop.
    t.emitLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 99 },
    }))
    expect(received).toEqual([])
  })

  it('drops progress arriving after abort silently', async () => {
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)

    // Stall tools/call.
    const origSend = t.send
    t.send = (line) => {
      const parsed = JSON.parse(line) as { method?: string }
      if (parsed.method === 'tools/call') {
        t.sentFrames.push(line)
        return
      }
      origSend.call(t, line)
    }

    const received: unknown[] = []
    const ctrl = new AbortController()
    const callPromise = client.callTool('echo', {}, ctrl.signal, (p) => received.push(p))
    const frame = findToolsCallFrame(t.sentFrames)
    const token = frame!.params._meta!.progressToken
    ctrl.abort()
    await callPromise

    t.emitLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 1 },
    }))
    expect(received).toEqual([])
  })

  it('cleans the sink after a successful call (no leak)', async () => {
    let callCount = 0
    let resolveFirst: ((v: unknown) => void) | null = null
    const t = fakeTransport({
      handlers: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        'tools/call': () => {
          callCount++
          if (callCount === 1) {
            return new Promise((r) => {
              resolveFirst = r as (v: unknown) => void
            })
          }
          return { content: [{ type: 'text', text: 'second' }] }
        },
      },
    })
    const client = createMcpClient('fake', noTimeoutCfg, t)
    await client.connect(new AbortController().signal)

    const received: unknown[] = []
    const firstPromise = client.callTool('echo', {}, new AbortController().signal, (p) => received.push(p))
    while (!resolveFirst) {
      await new Promise((r) => setTimeout(r, 0))
    }
    const token = findToolsCallFrame(t.sentFrames)!.params._meta!.progressToken
    ;(resolveFirst as (v: unknown) => void)({ content: [{ type: 'text', text: 'done' }] })
    await firstPromise

    // Second call has no onProgress sink and is unrelated to the first.
    // Sending a progress frame for the OLD token must drop silently.
    await client.callTool('echo', {}, new AbortController().signal)
    t.emitLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 50 },
    }))
    expect(received).toEqual([])
  })
})

