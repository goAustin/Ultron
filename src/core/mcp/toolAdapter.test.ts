import { describe, it, expect } from 'vitest'
import { createMcpTool } from './toolAdapter.js'
import type { McpToolCallResult } from './client.js'
import type { McpCallToolGateway } from './toolAdapter.js'
import { createToolUseContext } from '../tools/context.js'
import { createStore, getDefaultAppState } from '../state.js'
import { createToolRegistry } from '../tools/registry.js'

function fakeGateway(
  tool: string,
  result: McpToolCallResult | Promise<McpToolCallResult>,
): McpCallToolGateway {
  return async ({ toolName }): Promise<McpToolCallResult> => {
    if (toolName !== tool) throw new Error(`unexpected tool ${toolName}`)
    return result
  }
}

// Gateway that records the last `arguments` passed to callTool so wrap/unwrap
// round-trips can be asserted.
function recordingGateway(
  result: McpToolCallResult,
): { gateway: McpCallToolGateway; calls: { lastArgs: unknown; count: number } } {
  const calls = { lastArgs: undefined as unknown, count: 0 }
  const gateway: McpCallToolGateway = async ({ input }): Promise<McpToolCallResult> => {
    calls.lastArgs = input
    calls.count++
    return result
  }
  return { gateway, calls }
}

function fakeCtx() {
  return createToolUseContext({
    appState: createStore(getDefaultAppState()),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createToolRegistry(),
  })
}

const descriptorObject = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
} as const

describe('createMcpTool', () => {
  it('returns null when inputSchema has no valid top-level type (e.g. anyOf)', () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'x', inputSchema: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      fallbackIndex: 0,
      callToolGateway: fakeGateway('x', { kind: 'ok', content: '', isError: false }),
    })
    expect(tool).toBeNull()
  })

  it('returns null when inputSchema is missing', () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'x', inputSchema: undefined },
      fallbackIndex: 0,
      callToolGateway: fakeGateway('x', { kind: 'ok', content: '', isError: false }),
    })
    expect(tool).toBeNull()
  })

  it('produces a qualified name with mcp__<server>__<tool>', () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'ok', content: 'x', isError: false }),
    })!
    expect(tool.name).toBe('mcp__fake__echo')
  })

  it('sanitizes the tool name', () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'read-file', inputSchema: { type: 'object' } },
      fallbackIndex: 0,
      callToolGateway: fakeGateway('read-file', { kind: 'ok', content: 'x', isError: false }),
    })!
    expect(tool.name).toBe('mcp__fake__read_file')
  })

  it('sets source=mcp, namespace=serverName, isMutating=true', () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'ok', content: '', isError: false }),
    })!
    expect(tool.source).toBe('mcp')
    expect(tool.namespace).toBe('fake')
    expect(tool.isMutating).toBe(true)
    expect(tool.getPath).toBeUndefined()
    expect(tool.isConcurrencySafe).toBeUndefined()
  })

  it('validateInput is permissive', async () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'ok', content: '', isError: false }),
    })!
    const ctx = fakeCtx()
    expect(await tool.validateInput({}, ctx)).toEqual({ valid: true })
  })

  it('checkPermissions returns allow (so cascade can match session rules)', async () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'ok', content: '', isError: false }),
    })!
    const ctx = fakeCtx()
    expect(await tool.checkPermissions({}, ctx)).toEqual({ behavior: 'allow' })
  })

  it('maps ok result to ToolResult', async () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'ok', content: 'hi', isError: false }),
    })!
    const ctx = fakeCtx()
    const result = await tool.call({ msg: 'hi' }, ctx, new AbortController().signal)
    expect(result).toEqual({ content: 'hi', isError: false })
  })

  it('preserves isError on ok results', async () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'ok', content: 'oops', isError: true }),
    })!
    const ctx = fakeCtx()
    const result = await tool.call({}, ctx, new AbortController().signal)
    expect(result).toEqual({ content: 'oops', isError: true })
  })

  it('maps transport_error to execution_error', async () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'transport_error', message: 'dead' }),
    })!
    const ctx = fakeCtx()
    const result = await tool.call({}, ctx, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('execution_error')
    expect(result.content).toContain('dead')
  })

  it('maps protocol_error to execution_error', async () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'protocol_error', code: -32000, message: 'bad' }),
    })!
    const ctx = fakeCtx()
    const result = await tool.call({}, ctx, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('execution_error')
  })

  it('maps timeout to execution_error', async () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'timeout', message: 'slow' }),
    })!
    const ctx = fakeCtx()
    const result = await tool.call({}, ctx, new AbortController().signal)
    expect(result.errorKind).toBe('execution_error')
  })

  it('maps aborted to an abort result', async () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: fakeGateway('echo', { kind: 'aborted' }),
    })!
    const ctx = fakeCtx()
    const result = await tool.call({}, ctx, new AbortController().signal)
    expect(result.errorKind).toBe('aborted')
  })

  it('uses fallback description when descriptor omits it', () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'x', inputSchema: { type: 'object' } },
      fallbackIndex: 0,
      callToolGateway: fakeGateway('x', { kind: 'ok', content: '', isError: false }),
    })!
    expect(tool.description).toBe('(MCP tool from fake)')
  })
})

describe('schema wrapping (Phase 3b)', () => {
  it('wraps type:"string" into an object schema with `value` property', () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'shout', inputSchema: { type: 'string' } },
      fallbackIndex: 0,
      callToolGateway: fakeGateway('shout', { kind: 'ok', content: '', isError: false }),
    })!
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['value'],
      additionalProperties: false,
    })
    expect((tool.inputSchema as Record<string, Record<string, unknown>>).properties).toEqual({
      value: { type: 'string' },
    })
  })

  it('augments description when wrapping', () => {
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'shout', description: 'Shout loud', inputSchema: { type: 'string' } },
      fallbackIndex: 0,
      callToolGateway: fakeGateway('shout', { kind: 'ok', content: '', isError: false }),
    })!
    expect(tool.description).toContain('Shout loud')
    expect(tool.description).toContain('`value` argument')
  })

  it('unwraps input.value before calling client for type:"string"', async () => {
    const { gateway, calls } = recordingGateway({ kind: 'ok', content: 'HELLO', isError: false })
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'shout', inputSchema: { type: 'string' } },
      fallbackIndex: 0,
      callToolGateway: gateway,
    })!
    const ctx = fakeCtx()
    await tool.call({ value: 'hello' }, ctx, new AbortController().signal)
    expect(calls.lastArgs).toBe('hello')
  })

  it('unwraps input.value for type:"array"', async () => {
    const { gateway, calls } = recordingGateway({ kind: 'ok', content: '', isError: false })
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'sum', inputSchema: { type: 'array', items: { type: 'number' } } },
      fallbackIndex: 0,
      callToolGateway: gateway,
    })!
    const ctx = fakeCtx()
    await tool.call({ value: [1, 2, 3] }, ctx, new AbortController().signal)
    expect(calls.lastArgs).toEqual([1, 2, 3])
  })

  it('object schemas pass through unchanged (no wrap)', async () => {
    const { gateway, calls } = recordingGateway({ kind: 'ok', content: '', isError: false })
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: gateway,
    })!
    // description not augmented
    expect(tool.description).toBe('Echo')
    const ctx = fakeCtx()
    await tool.call({ msg: 'hi' }, ctx, new AbortController().signal)
    // forwarded raw, not unwrapped
    expect(calls.lastArgs).toEqual({ msg: 'hi' })
  })

  it('wraps type:"boolean" and type:"number"', () => {
    const t1 = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'flag', inputSchema: { type: 'boolean' } },
      fallbackIndex: 0,
      callToolGateway: fakeGateway('flag', { kind: 'ok', content: '', isError: false }),
    })
    expect(t1).not.toBeNull()
    const t2 = createMcpTool({
      serverName: 'fake',
      descriptor: { name: 'n', inputSchema: { type: 'number' } },
      fallbackIndex: 0,
      callToolGateway: fakeGateway('n', { kind: 'ok', content: '', isError: false }),
    })
    expect(t2).not.toBeNull()
  })
})

describe('progress passthrough (Phase 3d)', () => {
  it('forwards ctx.onProgress to the gateway when present', async () => {
    let receivedSink: unknown = 'unset'
    const gateway: McpCallToolGateway = async ({ onProgress }) => {
      receivedSink = onProgress
      return { kind: 'ok', content: '', isError: false }
    }
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: gateway,
    })!
    const ctx = createToolUseContext({
      appState: createStore(getDefaultAppState()),
      abortController: new AbortController(),
      messages: [],
      toolRegistry: createToolRegistry(),
      onProgress: () => {},
    })
    await tool.call({ msg: 'hi' }, ctx, new AbortController().signal)
    expect(typeof receivedSink).toBe('function')
  })

  it('omits onProgress from gateway args when ctx has no sink', async () => {
    let argsSeen: { onProgress?: unknown } | null = null
    const gateway: McpCallToolGateway = async (args) => {
      argsSeen = args as { onProgress?: unknown }
      return { kind: 'ok', content: '', isError: false }
    }
    const tool = createMcpTool({
      serverName: 'fake',
      descriptor: descriptorObject,
      fallbackIndex: 0,
      callToolGateway: gateway,
    })!
    const ctx = fakeCtx()
    await tool.call({ msg: 'hi' }, ctx, new AbortController().signal)
    expect(argsSeen).not.toBeNull()
    expect(argsSeen!.onProgress).toBeUndefined()
  })
})
