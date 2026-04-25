import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'

import { createMcpManager } from './manager.js'
import { createToolRegistry } from '../tools/registry.js'
import type { StdioTransport } from './transportStdio.js'
import type { McpConfig } from './config.js'

/**
 * Builds a fake stdio transport factory that can be configured per-server
 * via the command field. The manager calls spawnTransport with the config's
 * command/args/env; we use `command` as a lookup key to pick behavior.
 */
function buildSpawn(scripts: Record<string, {
  initialize?: () => unknown
  'tools/list'?: () => unknown
  'tools/call'?: (params: { name: string; arguments: unknown }) => unknown
  failInitialize?: boolean
  stall?: boolean
}>) {
  const closed: Record<string, boolean> = {}
  const factory = (args: { command: string }): StdioTransport => {
    const cfg = scripts[args.command] ?? {}
    const ee = new EventEmitter()
    const lineCbs: Array<(line: string) => void> = []
    const exitCbs: Array<(code: number | null, sig: NodeJS.Signals | null) => void> = []
    const errorCbs: Array<(err: Error) => void> = []
    ee.on('line', (l: string) => {
      for (const cb of lineCbs) cb(l)
    })
    closed[args.command] = false
    return {
      send(line) {
        if (cfg.stall) return
        let req: { id?: number | string; method: string; params: unknown }
        try {
          req = JSON.parse(line) as { id?: number | string; method: string; params: unknown }
        } catch {
          return
        }
        if (req.id === undefined) return
        queueMicrotask(() => {
          let response: Record<string, unknown>
          if (req.method === 'initialize') {
            if (cfg.failInitialize) {
              response = { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'nope' } }
            } else {
              response = {
                jsonrpc: '2.0',
                id: req.id,
                result: cfg.initialize?.() ?? {},
              }
            }
          } else if (req.method === 'tools/list') {
            response = { jsonrpc: '2.0', id: req.id, result: cfg['tools/list']?.() ?? { tools: [] } }
          } else if (req.method === 'tools/call') {
            response = {
              jsonrpc: '2.0',
              id: req.id,
              result: cfg['tools/call']?.(req.params as { name: string; arguments: unknown }) ?? {},
            }
          } else {
            response = { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }
          }
          ee.emit('line', JSON.stringify(response))
        })
      },
      onLine(cb) {
        lineCbs.push(cb)
      },
      onError(cb) {
        errorCbs.push(cb)
      },
      onExit(cb) {
        exitCbs.push(cb)
      },
      async close() {
        closed[args.command] = true
        for (const cb of exitCbs) cb(0, 'SIGTERM')
      },
    }
  }
  return { factory, closed }
}

function cfgFrom(serverName: string, command: string): McpConfig {
  return {
    schemaVersion: 1,
    servers: { [serverName]: { command } },
  }
}

function buildReconnectSpawn(scripts: Array<{
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>
  callText?: string
}>) {
  const spawned: Array<{ simulateExit(): void; sentFrames: string[] }> = []
  let spawnCount = 0
  const factory = (): StdioTransport => {
    const script = scripts[Math.min(spawnCount, scripts.length - 1)]!
    spawnCount++
    const ee = new EventEmitter()
    const lineCbs: Array<(line: string) => void> = []
    const exitCbs: Array<(code: number | null, sig: NodeJS.Signals | null) => void> = []
    const sentFrames: string[] = []
    ee.on('line', (l: string) => {
      for (const cb of lineCbs) cb(l)
    })
    const handle = {
      simulateExit() {
        for (const cb of exitCbs) cb(1, null)
      },
      sentFrames,
    }
    spawned.push(handle)
    return {
      send(line) {
        sentFrames.push(line)
        let req: { id?: number | string; method: string; params: unknown }
        try {
          req = JSON.parse(line) as { id?: number | string; method: string; params: unknown }
        } catch {
          return
        }
        if (req.id === undefined) return
        queueMicrotask(() => {
          let response: Record<string, unknown>
          if (req.method === 'initialize') {
            response = { jsonrpc: '2.0', id: req.id, result: {} }
          } else if (req.method === 'tools/list') {
            response = { jsonrpc: '2.0', id: req.id, result: { tools: script.tools } }
          } else if (req.method === 'tools/call') {
            response = {
              jsonrpc: '2.0',
              id: req.id,
              result: { content: [{ type: 'text', text: script.callText ?? 'ok' }] },
            }
          } else {
            response = { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'nope' } }
          }
          ee.emit('line', JSON.stringify(response))
        })
      },
      onLine(cb) {
        lineCbs.push(cb)
      },
      onError() {},
      onExit(cb) {
        exitCbs.push(cb)
      },
      async close() {
        for (const cb of exitCbs) cb(0, 'SIGTERM')
      },
    }
  }
  return {
    factory,
    spawned,
    spawnCount: () => spawnCount,
  }
}

describe('McpManager.bootstrap', () => {
  it('registers tools from a single successful server', async () => {
    const { factory } = buildSpawn({
      nodeA: {
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
      },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    const result = await mgr.bootstrap({
      config: cfgFrom('github', 'nodeA'),
      registry,
      signal: new AbortController().signal,
    })
    expect(result.connected).toEqual(['github'])
    expect(result.failed).toEqual([])
    expect(registry.has('mcp__github__echo')).toBe(true)
  })

  it('bootstraps multiple servers in parallel', async () => {
    const { factory } = buildSpawn({
      A: { 'tools/list': () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }) },
      B: { 'tools/list': () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }) },
      C: { 'tools/list': () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }) },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    const result = await mgr.bootstrap({
      config: {
        schemaVersion: 1,
        servers: {
          sa: { command: 'A' },
          sb: { command: 'B' },
          sc: { command: 'C' },
        },
      },
      registry,
      signal: new AbortController().signal,
    })
    expect([...result.connected].sort()).toEqual(['sa', 'sb', 'sc'])
    expect(registry.has('mcp__sa__t')).toBe(true)
    expect(registry.has('mcp__sb__t')).toBe(true)
    expect(registry.has('mcp__sc__t')).toBe(true)
  })

  it('a failing server does not block the others', async () => {
    const { factory } = buildSpawn({
      good: { 'tools/list': () => ({ tools: [{ name: 'g', inputSchema: { type: 'object' } }] }) },
      bad: { failInitialize: true },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    const result = await mgr.bootstrap({
      config: {
        schemaVersion: 1,
        servers: {
          goodServer: { command: 'good' },
          badServer: { command: 'bad' },
        },
      },
      registry,
      signal: new AbortController().signal,
    })
    expect(result.connected).toEqual(['goodServer'])
    expect(result.failed.map(f => f.server)).toEqual(['badServer'])
    expect(registry.has('mcp__goodServer__g')).toBe(true)
  })

  it('skips disabled servers', async () => {
    const { factory } = buildSpawn({
      only: { 'tools/list': () => ({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] }) },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    const result = await mgr.bootstrap({
      config: {
        schemaVersion: 1,
        servers: {
          on: { command: 'only' },
          off: { command: 'only', disabled: true },
        },
      },
      registry,
      signal: new AbortController().signal,
    })
    expect(result.connected).toEqual(['on'])
    expect(registry.has('mcp__on__x')).toBe(true)
    expect(registry.has('mcp__off__x')).toBe(false)
  })

  it('drops tools whose inputSchema has no valid top-level type', async () => {
    const { factory } = buildSpawn({
      svr: {
        'tools/list': () => ({
          tools: [
            { name: 'good', inputSchema: { type: 'object' } },
            { name: 'wrapped', inputSchema: { type: 'string' } },
            { name: 'bad', inputSchema: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
          ],
        }),
      },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: cfgFrom('s', 'svr'),
      registry,
      signal: new AbortController().signal,
    })
    expect(registry.has('mcp__s__good')).toBe(true)
    // type:"string" now wraps into an object schema (Phase 3b)
    expect(registry.has('mcp__s__wrapped')).toBe(true)
    // anyOf at top level is still unsupported
    expect(registry.has('mcp__s__bad')).toBe(false)
  })
})

describe('McpManager.shutdown', () => {
  it('unregisters every tool and closes every client', async () => {
    const { factory, closed } = buildSpawn({
      A: { 'tools/list': () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }) },
      B: { 'tools/list': () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }) },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: {
        schemaVersion: 1,
        servers: { sa: { command: 'A' }, sb: { command: 'B' } },
      },
      registry,
      signal: new AbortController().signal,
    })
    expect(registry.size).toBe(2)
    await mgr.shutdown()
    expect(registry.size).toBe(0)
    expect(closed.A).toBe(true)
    expect(closed.B).toBe(true)
  })

  it('is idempotent', async () => {
    const { factory } = buildSpawn({
      A: { 'tools/list': () => ({ tools: [] }) },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: cfgFrom('s', 'A'),
      registry,
      signal: new AbortController().signal,
    })
    await mgr.shutdown()
    await mgr.shutdown() // should not throw
  })

  it('status reflects connected servers; empty after shutdown', async () => {
    const { factory } = buildSpawn({
      A: { 'tools/list': () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }) },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: cfgFrom('s', 'A'),
      registry,
      signal: new AbortController().signal,
    })
    const beforeShutdown = mgr.status()
    expect(beforeShutdown).toHaveLength(1)
    expect(beforeShutdown[0].state).toBe('ready')
    expect(beforeShutdown[0].toolCount).toBe(1)
    expect(beforeShutdown[0].lastError).toBeNull()
    await mgr.shutdown()
    expect(mgr.status()).toEqual([])
  })
})

describe('McpManager.status (Phase 3b: tracks all configured servers)', () => {
  it('includes failed servers with lastError populated', async () => {
    const { factory } = buildSpawn({
      good: { 'tools/list': () => ({ tools: [{ name: 'g', inputSchema: { type: 'object' } }] }) },
      bad: { failInitialize: true },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: {
        schemaVersion: 1,
        servers: {
          goodServer: { command: 'good' },
          badServer: { command: 'bad' },
        },
      },
      registry,
      signal: new AbortController().signal,
    })
    const statuses = mgr.status()
    expect(statuses).toHaveLength(2)
    const good = statuses.find(s => s.server === 'goodServer')!
    const bad = statuses.find(s => s.server === 'badServer')!
    expect(good.state).toBe('ready')
    expect(good.toolCount).toBe(1)
    expect(good.lastError).toBeNull()
    expect(bad.state).toBe('failed')
    expect(bad.toolCount).toBe(0)
    expect(bad.lastError).toContain('nope')
  })

  it('includes disabled servers with state:"idle" and lastError:"(disabled)"', async () => {
    const { factory } = buildSpawn({
      only: { 'tools/list': () => ({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] }) },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: {
        schemaVersion: 1,
        servers: {
          on: { command: 'only' },
          off: { command: 'only', disabled: true },
        },
      },
      registry,
      signal: new AbortController().signal,
    })
    const statuses = mgr.status()
    expect(statuses).toHaveLength(2)
    const off = statuses.find(s => s.server === 'off')!
    expect(off.state).toBe('idle')
    expect(off.toolCount).toBe(0)
    expect(off.lastError).toBe('(disabled)')
  })

  it('during bootstrap, rows are in "connecting" state before Promise resolves', async () => {
    // Use `stall: true` so the fake transport doesn't respond — bootstrap
    // stays in flight. Also bypass the initialize timeout by overriding it
    // via server config.
    const { factory } = buildSpawn({
      slow: { stall: true },
    })
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    const bootstrapPromise = mgr.bootstrap({
      config: {
        schemaVersion: 1,
        // Short timeout so the test doesn't actually wait 30s; we check
        // status() *before* awaiting the promise anyway.
        servers: { sa: { command: 'slow', timeoutMs: 50 } },
      },
      registry,
      signal: new AbortController().signal,
    })
    // The row exists immediately after the synchronous for-loop that
    // pre-populates tracked; we can assert on it before awaiting.
    const mid = mgr.status()
    expect(mid).toHaveLength(1)
    expect(mid[0].state).toBe('connecting')
    // Let the bootstrap resolve so it doesn't leak a pending promise.
    await bootstrapPromise
    expect(mgr.status()[0].state).toBe('failed')
  })
})

describe('McpManager reconnect/reload (Phase 3c)', () => {
  it('reconnects on the next call when descriptors are unchanged', async () => {
    const { factory, spawned, spawnCount } = buildReconnectSpawn([
      { tools: [{ name: 't', inputSchema: { type: 'object' } }], callText: 'first' },
      { tools: [{ name: 't', inputSchema: { type: 'object' } }], callText: 'second' },
    ])
    const mgr = createMcpManager({
      spawnTransport: factory,
      reconnectPolicy: { initialDelayMs: 0, maxDelayMs: 0, maxAttempts: 2 },
    })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: cfgFrom('s', 'cmd'),
      registry,
      signal: new AbortController().signal,
    })

    spawned[0].simulateExit()
    const res = await mgr.callTool({
      serverName: 's',
      toolName: 't',
      input: {},
      signal: new AbortController().signal,
    })

    expect(res).toEqual({ kind: 'ok', content: 'second', isError: false })
    expect(spawnCount()).toBe(2)
    expect(registry.has('mcp__s__t')).toBe(true)
    expect(mgr.status()[0].state).toBe('ready')
  })

  it('fails reconnect without mutating the registry when descriptors changed', async () => {
    const { factory, spawned } = buildReconnectSpawn([
      { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
      { tools: [{ name: 'changed', inputSchema: { type: 'object' } }] },
    ])
    const mgr = createMcpManager({
      spawnTransport: factory,
      reconnectPolicy: { initialDelayMs: 0, maxDelayMs: 0, maxAttempts: 2 },
    })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: cfgFrom('s', 'cmd'),
      registry,
      signal: new AbortController().signal,
    })

    spawned[0].simulateExit()
    const res = await mgr.callTool({
      serverName: 's',
      toolName: 't',
      input: {},
      signal: new AbortController().signal,
    })

    expect(res.kind).toBe('transport_error')
    if (res.kind === 'transport_error') {
      expect(res.message).toContain('MCP tool set changed')
    }
    expect(registry.has('mcp__s__t')).toBe(true)
    expect(registry.has('mcp__s__changed')).toBe(false)
    expect(mgr.status()[0].state).toBe('failed')
  })

  it('reload reports unchanged failed servers still in backoff', async () => {
    let t = 1_000
    const { factory, spawned } = buildReconnectSpawn([
      { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
    ])
    const mgr = createMcpManager({
      spawnTransport: factory,
      reconnectPolicy: { initialDelayMs: 5_000, maxDelayMs: 5_000, maxAttempts: 2 },
      now: () => t,
    })
    const registry = createToolRegistry()
    const config = cfgFrom('s', 'cmd')
    await mgr.bootstrap({
      config,
      registry,
      signal: new AbortController().signal,
    })
    t = 2_000
    spawned[0].simulateExit()

    const result = await mgr.reload({
      config,
      registry,
      signal: new AbortController().signal,
    })

    expect(result.unchanged).toEqual(['s'])
    expect(result.backoff).toHaveLength(1)
    expect(result.backoff[0].server).toBe('s')
    expect(result.backoff[0].nextRetryAt).toBe(7_000)
  })

  it('reload reconciles descriptor changes and reports toolDefinitionsChanged', async () => {
    const { factory } = buildReconnectSpawn([
      { tools: [{ name: 'a', inputSchema: { type: 'object' } }] },
      { tools: [{ name: 'b', inputSchema: { type: 'object' } }] },
    ])
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: cfgFrom('s', 'old'),
      registry,
      signal: new AbortController().signal,
    })

    const result = await mgr.reload({
      config: cfgFrom('s', 'new'),
      registry,
      signal: new AbortController().signal,
    })

    expect(result.toolDefinitionsChanged).toBe(true)
    expect(registry.has('mcp__s__a')).toBe(false)
    expect(registry.has('mcp__s__b')).toBe(true)
  })
})

describe('McpManager.callTool progress (Phase 3d)', () => {
  it('forwards onProgress through to client.callTool (request includes _meta.progressToken)', async () => {
    const { factory, spawned } = buildReconnectSpawn([
      { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
    ])
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: cfgFrom('s', 'cmd'),
      registry,
      signal: new AbortController().signal,
    })

    await mgr.callTool({
      serverName: 's',
      toolName: 't',
      input: {},
      signal: new AbortController().signal,
      onProgress: () => {},
    })

    const frames = spawned[0].sentFrames.map((f) => JSON.parse(f) as { method?: string; params?: { _meta?: { progressToken: string } } })
    const callFrame = frames.find((f) => f.method === 'tools/call')
    expect(callFrame).toBeDefined()
    expect(callFrame!.params!._meta).toBeDefined()
    expect(typeof callFrame!.params!._meta!.progressToken).toBe('string')
  })

  it('omits _meta.progressToken when no onProgress is supplied', async () => {
    const { factory, spawned } = buildReconnectSpawn([
      { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
    ])
    const mgr = createMcpManager({ spawnTransport: factory })
    const registry = createToolRegistry()
    await mgr.bootstrap({
      config: cfgFrom('s', 'cmd'),
      registry,
      signal: new AbortController().signal,
    })

    await mgr.callTool({
      serverName: 's',
      toolName: 't',
      input: {},
      signal: new AbortController().signal,
    })

    const frames = spawned[0].sentFrames.map((f) => JSON.parse(f) as { method?: string; params?: { _meta?: unknown } })
    const callFrame = frames.find((f) => f.method === 'tools/call')
    expect(callFrame).toBeDefined()
    expect(callFrame!.params!._meta).toBeUndefined()
  })
})
