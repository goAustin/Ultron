/**
 * Integration test: Phase 3a — end-to-end MCP stdio client.
 *
 * Uses an in-process fake stdio transport (EventEmitter-backed) so no real
 * subprocess is spawned. Drives a QueryEngine with a scripted callModel that
 * calls the fake MCP tool, and asserts:
 *   1. The MCP tool is registered after first submitPrompt (and via init()).
 *   2. getToolDefinitions() includes it (proves the rebuilt callModel sees it).
 *   3. Permission cascade: first call asks, `allow_by_rule` creates a session
 *      rule, subsequent calls are auto-approved (no askUser invocation).
 *   4. dispose() closes the transport, is idempotent, and makes subsequent
 *      submitPrompt calls reject.
 *   5. Subagents with default allowedTools do NOT see MCP tools.
 */

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { QueryEngine } from '../../src/sdk/QueryEngine.js'
import type { QueryEngineConfig } from '../../src/sdk/QueryEngine.js'
import { DEFAULT_ALLOWED_TOOLS } from '../../src/agents/runAgent.js'
import { MCP_TOOL_PREFIX } from '../../src/core/mcp/index.js'
import type { QueryEvent } from '../../src/core/queryEvents.js'
import type { Terminal } from '../../src/core/queryTypes.js'
import type {
  CallModelFn,
  RawStreamEvent,
  ApiResponseMeta,
} from '../../src/core/queryDeps.js'
import type { AskUserFn, PermissionRule } from '../../src/core/permissions/types.js'
import type { Store, AppState } from '../../src/core/state.js'
import type { StdioTransport } from '../../src/core/mcp/transportStdio.js'
import type { SpawnTransportFn } from '../../src/core/mcp/index.js'
import type { McpConfig } from '../../src/core/mcp/config.js'
import { createAuditWriter } from '../../src/audit/auditLog.js'
import { getToolDefinitions } from '../../src/core/tools/registry.js'

// ---------------------------------------------------------------------------
// Fake MCP stdio transport factory
// ---------------------------------------------------------------------------

type FakeCallContext = {
  /** Inject a server-to-client frame (typically a notifications/progress). */
  emitLine: (line: string) => void
  /** The full request params (`_meta.progressToken`, `arguments`, etc.). */
  params: { name: string; arguments: unknown; _meta?: { progressToken?: string } }
}

type FakeServerScript = {
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>
  onCall: (
    args: { name: string; arguments: unknown },
    ctx?: FakeCallContext,
  ) => unknown | Promise<unknown>
}

function buildFakeSpawn(script: FakeServerScript, opts?: {
  stallToolsCall?: boolean
  failInitialize?: boolean
}): {
  spawn: SpawnTransportFn
  closed: () => boolean
  sentFrames: () => string[]
} {
  let wasClosed = false
  const sentFrames: string[] = []
  const spawn: SpawnTransportFn = () => {
    const ee = new EventEmitter()
    const lineCbs: Array<(line: string) => void> = []
    const exitCbs: Array<(code: number | null, sig: NodeJS.Signals | null) => void> = []
    const errorCbs: Array<(err: Error) => void> = []
    ee.on('line', (l: string) => {
      for (const cb of lineCbs) cb(l)
    })
    const transport: StdioTransport = {
      send(line) {
        sentFrames.push(line)
        let req: { id?: number | string; method: string; params: unknown }
        try {
          req = JSON.parse(line) as { id?: number | string; method: string; params: unknown }
        } catch {
          return
        }
        if (req.id === undefined) return
        // Optionally stall tools/call so the client can be aborted.
        if (opts?.stallToolsCall && req.method === 'tools/call') return
        queueMicrotask(async () => {
          let response: Record<string, unknown>
          if (req.method === 'initialize') {
            if (opts?.failInitialize) {
              response = {
                jsonrpc: '2.0',
                id: req.id,
                error: { code: -32000, message: 'nope' },
              }
            } else {
              response = {
                jsonrpc: '2.0',
                id: req.id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: {},
                  serverInfo: { name: 'fake', version: '0.0.0' },
                },
              }
            }
          } else if (req.method === 'tools/list') {
            response = { jsonrpc: '2.0', id: req.id, result: { tools: script.tools } }
          } else if (req.method === 'tools/call') {
            const params = req.params as FakeCallContext['params']
            const callCtx: FakeCallContext = {
              emitLine: (line) => ee.emit('line', line),
              params,
            }
            const raw = script.onCall(
              { name: params.name, arguments: params.arguments },
              callCtx,
            )
            const result = raw instanceof Promise ? await raw : raw
            response = { jsonrpc: '2.0', id: req.id, result }
          } else {
            response = {
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32601, message: 'Method not found' },
            }
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
        wasClosed = true
        for (const cb of exitCbs) cb(0, 'SIGTERM')
      },
    }
    return transport
  }
  return { spawn, closed: () => wasClosed, sentFrames: () => sentFrames }
}

// ---------------------------------------------------------------------------
// Fake callModel that emits one tool_use then a text response
// ---------------------------------------------------------------------------

function mcpToolUseThenText(toolName: string, toolInput: object): CallModelFn {
  let turn = 0
  return async function* () {
    turn++
    if (turn === 1) {
      yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `tu-${turn}`, name: toolName, input: '' },
      } as RawStreamEvent
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
      } as RawStreamEvent
      yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 5 },
      } as RawStreamEvent
      yield { type: 'message_stop' } as RawStreamEvent
      return { stopReason: 'tool_use', inputTokens: 10, outputTokens: 5 } as ApiResponseMeta
    }
    yield { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } } as RawStreamEvent
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'done' },
    } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 },
    } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason: 'end_turn', inputTokens: 12, outputTokens: 3 } as ApiResponseMeta
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drain(gen: AsyncGenerator<QueryEvent, Terminal>): Promise<Terminal> {
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  return r.value
}

function collectEvents(events: QueryEvent[]): string[] {
  return events.map(e => e.type)
}

async function collect(gen: AsyncGenerator<QueryEvent, Terminal>): Promise<{
  events: QueryEvent[]
  terminal: Terminal
}> {
  const events: QueryEvent[] = []
  let r = await gen.next()
  while (!r.done) {
    events.push(r.value)
    r = await gen.next()
  }
  return { events, terminal: r.value }
}

function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-mcp-integ-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function makeConfig(cwd: string, auditDir: string, overrides?: Partial<QueryEngineConfig>): QueryEngineConfig {
  return {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    cwd,
    auditWriter: createAuditWriter({ dir: auditDir }),
    hookConfig: { schemaVersion: 1, hooks: { PreToolUse: [], PostToolUse: [] } },
    ...overrides,
  }
}

const echoConfig: McpConfig = {
  schemaVersion: 1,
  servers: { fake: { command: 'node', args: [] } },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP integration', () => {
  it('init() registers MCP tools; getToolDefinitions exposes them', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        const { spawn } = buildFakeSpawn({
          tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
          onCall: () => ({ content: [{ type: 'text', text: 'pong' }] }),
        })
        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: echoConfig,
            mcpSpawnTransport: spawn,
          }),
        )
        await engine.init()

        const registry = engine.getRegistry()
        expect(registry.has('mcp__fake__echo')).toBe(true)

        const names = getToolDefinitions(registry).map(d => d.name)
        expect(names).toContain('mcp__fake__echo')

        await engine.dispose()
      })
    })
  })

  it('permission cascade: allow_by_rule creates session rule; subsequent calls skip askUser', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        const { spawn } = buildFakeSpawn({
          tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          onCall: () => ({ content: [{ type: 'text', text: 'pong' }] }),
        })

        let askCount = 0
        const askUser: AskUserFn = async () => {
          askCount++
          return 'allow_by_rule'
        }

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: echoConfig,
            mcpSpawnTransport: spawn,
            askUser,
            deps: {
              callModel: mcpToolUseThenText('mcp__fake__echo', { x: 1 }),
            },
          }),
        )

        await drain(engine.submitPrompt('first'))
        expect(askCount).toBe(1)

        // Rebuild the scripted callModel for the second submit so turn counting restarts.
        ;(engine as unknown as { callModel: CallModelFn }).callModel = mcpToolUseThenText(
          'mcp__fake__echo',
          { x: 2 },
        )
        await drain(engine.submitPrompt('second'))
        expect(askCount).toBe(1) // no new prompt — session rule matched

        await engine.dispose()
      })
    })
  })

  it('dispose() closes the transport, is idempotent, and blocks subsequent submitPrompt', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        const { spawn, closed } = buildFakeSpawn({
          tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          onCall: () => ({ content: [] }),
        })
        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: echoConfig,
            mcpSpawnTransport: spawn,
          }),
        )
        await engine.init()
        expect(closed()).toBe(false)
        await engine.dispose()
        expect(closed()).toBe(true)
        await engine.dispose() // idempotent

        await expect(drain(engine.submitPrompt('x'))).rejects.toThrow(/disposed/)
      })
    })
  })

  it('MCP tool calls emit permission_decision → tool_call_started → tool_call_finished → tool_result', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        const { spawn } = buildFakeSpawn({
          tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          onCall: () => ({ content: [{ type: 'text', text: 'pong' }] }),
        })
        const askUser: AskUserFn = async () => 'allow_once'
        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: echoConfig,
            mcpSpawnTransport: spawn,
            askUser,
            deps: {
              callModel: mcpToolUseThenText('mcp__fake__echo', { x: 1 }),
            },
          }),
        )
        const { events } = await collect(engine.submitPrompt('go'))
        const types = collectEvents(events)
        const decisionIdx = types.indexOf('permission_decision')
        const startedIdx = types.indexOf('tool_call_started')
        const finishedIdx = types.indexOf('tool_call_finished')
        const resultIdx = types.indexOf('tool_result')
        expect(decisionIdx).toBeGreaterThan(-1)
        expect(startedIdx).toBeGreaterThan(decisionIdx)
        expect(finishedIdx).toBeGreaterThan(startedIdx)
        expect(resultIdx).toBeGreaterThan(finishedIdx)
        await engine.dispose()
      })
    })
  })

  it('default subagent allowedTools does not include any MCP tool name', () => {
    // Subagents restrict tools to FileRead/Glob/Grep by default (runAgent.ts:84).
    // This test pins that invariant so a future change to the default cannot
    // silently expose MCP tools to subagents.
    for (const name of DEFAULT_ALLOWED_TOOLS) {
      expect(name.startsWith(MCP_TOOL_PREFIX)).toBe(false)
    }
  })

  // -------------------------------------------------------------------------
  // Phase 3b: operability slice
  // -------------------------------------------------------------------------

  it('aborting an in-flight tools/call sends $/cancelRequest with the original id', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        const { spawn, sentFrames } = buildFakeSpawn(
          {
            tools: [{ name: 'slow', inputSchema: { type: 'object' } }],
            onCall: () => ({ content: [] }),
          },
          { stallToolsCall: true },
        )
        const askUser: AskUserFn = async () => 'allow_once'
        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: echoConfig,
            mcpSpawnTransport: spawn,
            askUser,
            deps: {
              callModel: mcpToolUseThenText('mcp__fake__slow', { x: 1 }),
            },
          }),
        )

        const gen = engine.submitPrompt('go')
        // Drive the generator until the tools/call frame has been sent to the
        // fake transport, then trigger the engine's internal abort so the
        // adapter's signal fires.
        const eventsPromise = (async () => {
          const events: QueryEvent[] = []
          let r = await gen.next()
          while (!r.done) {
            events.push(r.value)
            r = await gen.next()
          }
          return { events, terminal: r.value }
        })()

        // Wait until tools/call has been sent to the server.
        while (!sentFrames().some((line) => {
          try { return (JSON.parse(line) as { method?: string }).method === 'tools/call' }
          catch { return false }
        })) {
          await new Promise(r => setTimeout(r, 5))
        }
        // Abort the engine's currently-running query.
        const internalAbort = (engine as unknown as { currentAbort: AbortController | null }).currentAbort
        internalAbort?.abort()

        await eventsPromise

        const cancelFrame = sentFrames().find((line) => {
          try { return (JSON.parse(line) as { method?: string }).method === '$/cancelRequest' }
          catch { return false }
        })
        expect(cancelFrame).toBeDefined()
        const cancelObj = JSON.parse(cancelFrame!) as {
          jsonrpc: string
          method: string
          params: { id: number }
        }
        const toolsCallFrame = sentFrames().find((line) => {
          try { return (JSON.parse(line) as { method?: string }).method === 'tools/call' }
          catch { return false }
        })!
        const toolsCallId = (JSON.parse(toolsCallFrame) as { id: number }).id
        expect(cancelObj.params.id).toBe(toolsCallId)

        await engine.dispose()
      })
    })
  })

  it('status reports failed servers alongside connected ones', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        // Two separate spawn factories so each server gets its own transport
        // behavior. The real spawnStdioTransport is keyed on `command`; here
        // we route by serverName in the manager, not by command, so we need
        // a single factory that distinguishes by command.
        let transportCount = 0
        const sentFramesAll: string[] = []
        const spawn: SpawnTransportFn = (args) => {
          transportCount++
          const isGood = args.command === 'good'
          const ee = new EventEmitter()
          const lineCbs: Array<(line: string) => void> = []
          const exitCbs: Array<(code: number | null, sig: NodeJS.Signals | null) => void> = []
          ee.on('line', (l: string) => { for (const cb of lineCbs) cb(l) })
          return {
            send(line) {
              sentFramesAll.push(line)
              let req: { id?: number | string; method: string; params: unknown }
              try { req = JSON.parse(line) as { id?: number | string; method: string; params: unknown } }
              catch { return }
              if (req.id === undefined) return
              queueMicrotask(() => {
                let response: Record<string, unknown>
                if (req.method === 'initialize') {
                  if (!isGood) {
                    response = { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'nope' } }
                  } else {
                    response = { jsonrpc: '2.0', id: req.id, result: {} }
                  }
                } else if (req.method === 'tools/list') {
                  response = {
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { tools: [{ name: 'g', inputSchema: { type: 'object' } }] },
                  }
                } else {
                  response = { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'mno' } }
                }
                ee.emit('line', JSON.stringify(response))
              })
            },
            onLine(cb) { lineCbs.push(cb) },
            onError() {},
            onExit(cb) { exitCbs.push(cb) },
            async close() { for (const cb of exitCbs) cb(0, 'SIGTERM') },
          }
        }

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: {
              schemaVersion: 1,
              servers: {
                good: { command: 'good' },
                bad: { command: 'bad' },
              },
            },
            mcpSpawnTransport: spawn,
          }),
        )
        await engine.init()
        expect(transportCount).toBe(2)

        const statuses = engine.getMcpStatus()
        expect(statuses).toHaveLength(2)
        const good = statuses.find(s => s.server === 'good')!
        const bad = statuses.find(s => s.server === 'bad')!
        expect(good.state).toBe('ready')
        expect(good.toolCount).toBe(1)
        expect(bad.state).toBe('failed')
        expect(bad.toolCount).toBe(0)
        expect(bad.lastError).toContain('nope')

        await engine.dispose()
      })
    })
  })

  it('wildcard rule mcp__fake__* auto-allows without prompting', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        const { spawn } = buildFakeSpawn({
          tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          onCall: () => ({ content: [{ type: 'text', text: 'pong' }] }),
        })
        let askCount = 0
        const askUser: AskUserFn = async () => {
          askCount++
          return 'allow_once'
        }
        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: echoConfig,
            mcpSpawnTransport: spawn,
            askUser,
            deps: {
              callModel: mcpToolUseThenText('mcp__fake__echo', { x: 1 }),
            },
          }),
        )

        // Pre-seed a wildcard allow rule before the first submit.
        const appState = (engine as unknown as { appState: Store<AppState> }).appState
        const rule: PermissionRule = {
          toolName: 'mcp__fake__*',
          behavior: 'allow',
          source: 'userSettings',
        }
        appState.setState({ permissionRules: [rule] })

        await drain(engine.submitPrompt('go'))
        expect(askCount).toBe(0)

        await engine.dispose()
      })
    })
  })

  it('schema wrap end-to-end: fake declares type:"string", server sees raw string', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        let receivedArgs: unknown = null
        const { spawn } = buildFakeSpawn({
          tools: [
            { name: 'shout', inputSchema: { type: 'string' } },
          ],
          onCall: (params) => {
            receivedArgs = params.arguments
            return { content: [{ type: 'text', text: String(params.arguments).toUpperCase() }] }
          },
        })
        const askUser: AskUserFn = async () => 'allow_once'
        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: echoConfig,
            mcpSpawnTransport: spawn,
            askUser,
            deps: {
              callModel: mcpToolUseThenText('mcp__fake__shout', { value: 'hello' }),
            },
          }),
        )

        await drain(engine.submitPrompt('go'))
        // The server must receive the raw string, not the wrapper object.
        expect(receivedArgs).toBe('hello')

        await engine.dispose()
      })
    })
  })

  it('malformed mcpConfigPath causes submitPrompt to reject with McpConfigError', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        const bad = join(cwd, 'mcp.json')
        const { writeFileSync } = await import('node:fs')
        writeFileSync(bad, '{ not json')
        const { spawn } = buildFakeSpawn({
          tools: [],
          onCall: () => ({ content: [] }),
        })
        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfigPath: bad,
            mcpSpawnTransport: spawn,
          }),
        )
        await expect(engine.init()).rejects.toThrow(/JSON parse failed/)
        await engine.dispose()
      })
    })
  })

  it('Phase 3d: server progress notifications surface as side-channel tool_progress events', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        const { spawn } = buildFakeSpawn({
          tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          onCall: (_args, ctx) => {
            const token = ctx?.params._meta?.progressToken
            if (token) {
              ctx!.emitLine(JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: token, progress: 1, total: 3, message: 'step 1' },
              }))
              ctx!.emitLine(JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: token, progress: 2, total: 3, message: 'step 2' },
              }))
            }
            return { content: [{ type: 'text', text: 'final' }] }
          },
        })

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: echoConfig,
            mcpSpawnTransport: spawn,
            askUser: async () => 'allow_once',
            deps: {
              callModel: mcpToolUseThenText('mcp__fake__echo', { x: 1 }),
            },
          }),
        )

        const { events, terminal } = await collect(engine.submitPrompt('go'))

        // Side-channel assertions: progress events present, correlated by toolUseId.
        const progressEvents = events.filter((e) => e.type === 'tool_progress')
        expect(progressEvents).toHaveLength(2)
        const startEvent = events.find((e) => e.type === 'tool_call_started')
        expect(startEvent).toBeDefined()
        const expectedToolUseId = (startEvent as { toolUseId: string }).toolUseId
        expect(progressEvents.every((e) => (e as { toolUseId: string }).toolUseId === expectedToolUseId)).toBe(true)
        expect(progressEvents.map((e) => ({
          progress: (e as { progress: number }).progress,
          total: (e as { total: number }).total,
          message: (e as { message: string }).message,
        }))).toEqual([
          { progress: 1, total: 3, message: 'step 1' },
          { progress: 2, total: 3, message: 'step 2' },
        ])

        // Ordering: progress events appear between tool_call_started and tool_call_finished.
        const startIdx = events.findIndex((e) => e.type === 'tool_call_started')
        const finishIdx = events.findIndex((e) => e.type === 'tool_call_finished')
        const firstProgressIdx = events.findIndex((e) => e.type === 'tool_progress')
        const lastProgressIdx = events.map((e) => e.type).lastIndexOf('tool_progress')
        expect(startIdx).toBeLessThan(firstProgressIdx)
        expect(lastProgressIdx).toBeLessThan(finishIdx)

        // Constraint: the persisted message history contains exactly the
        // tool_use + tool_result, never any progress data.
        for (const msg of terminal.messages) {
          for (const block of (msg as { content: Array<{ type: string }> }).content) {
            expect(block.type).not.toBe('tool_progress')
          }
        }

        // The tool_result block carries only the server's final content.
        const toolResultEvent = events.find((e) => e.type === 'tool_result')
        expect(toolResultEvent).toBeDefined()
        const trMsg = (toolResultEvent as { message: { content: Array<{ type: string; content: string; isError: boolean }> } }).message
        expect(trMsg.content).toHaveLength(1)
        expect(trMsg.content[0].type).toBe('tool_result')
        expect(trMsg.content[0].content).toBe('final')
        expect(trMsg.content[0].isError).toBe(false)

        await engine.dispose()
      })
    })
  })

  it('Phase 3d: tools that emit no progress produce no tool_progress events', async () => {
    await withTmp(async (cwd) => {
      await withTmp(async (auditDir) => {
        const { spawn } = buildFakeSpawn({
          tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          onCall: () => ({ content: [{ type: 'text', text: 'silent' }] }),
        })
        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            mcpConfig: echoConfig,
            mcpSpawnTransport: spawn,
            askUser: async () => 'allow_once',
            deps: {
              callModel: mcpToolUseThenText('mcp__fake__echo', { x: 1 }),
            },
          }),
        )
        const { events } = await collect(engine.submitPrompt('go'))
        expect(events.filter((e) => e.type === 'tool_progress')).toHaveLength(0)
        await engine.dispose()
      })
    })
  })
})
