import { describe, it, expect, vi } from 'vitest'
import { runToolUse } from './runToolUse.js'
import { buildTool } from './types.js'
import type { Tool, ToolResult } from './types.js'
import type { ToolUseContext } from './context.js'
import { createToolUseContext } from './context.js'
import { createToolRegistry } from './registry.js'
import { createStore, getDefaultAppState } from '../state.js'
import type { PermissionOptions } from '../permissions/types.js'
import type { ToolUseBlock } from '../messages.js'
import { toolUseId } from '../messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId('tu-1'), name, input }
}

/** Default context uses bypassPermissions so pipeline tests are not blocked by the engine fallback. */
function makeContext(tools: Tool[] = [], opts?: { permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' }): ToolUseContext {
  const registry = createToolRegistry()
  for (const t of tools) registry.register(t)
  return createToolUseContext({
    appState: createStore({
      ...getDefaultAppState(),
      permissionMode: opts?.permissionMode ?? 'bypassPermissions',
    }),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: registry,
  })
}

function makeSignal(aborted = false): AbortSignal {
  const ac = new AbortController()
  if (aborted) ac.abort()
  return ac.signal
}

function okTool(name = 'TestTool'): Tool {
  return buildTool({
    name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    call: async () => ({ content: 'ok', isError: false }),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runToolUse', () => {
  it('returns tool_not_found for unknown tool', async () => {
    const ctx = makeContext()
    const result = await runToolUse(makeToolUse('Ghost'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('tool_not_found')
    expect(result.content).toContain('Ghost')
  })

  it('returns successful result for valid tool', async () => {
    const tool = okTool()
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('TestTool'), ctx, makeSignal())
    expect(result).toEqual({ content: 'ok', isError: false })
  })

  it('returns validation_failed when validateInput rejects', async () => {
    const tool = buildTool({
      name: 'Strict',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      validateInput: async () => ({ valid: false, message: 'missing required field' }),
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('Strict'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('validation_failed')
    expect(result.content).toContain('missing required field')
  })

  it('does not call tool.call when validation fails', async () => {
    const callFn = vi.fn(async () => ({ content: 'called', isError: false }))
    const tool = buildTool({
      name: 'Guarded',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
      validateInput: async () => ({ valid: false, message: 'nope' }),
    })
    const ctx = makeContext([tool])
    await runToolUse(makeToolUse('Guarded'), ctx, makeSignal())
    expect(callFn).not.toHaveBeenCalled()
  })

  it('returns permission_denied when checkPermissions denies', async () => {
    const tool = buildTool({
      name: 'Locked',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      checkPermissions: async () => ({ behavior: 'deny', message: 'not allowed' }),
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('Locked'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('permission_denied')
    expect(result.content).toContain('not allowed')
  })

  it('returns permission_ask when checkPermissions asks (no UI)', async () => {
    const tool = buildTool({
      name: 'NeedsApproval',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      checkPermissions: async () => ({ behavior: 'ask', message: 'confirm edit?' }),
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('NeedsApproval'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('permission_ask')
    expect(result.content).toContain('confirm edit?')
  })

  it('does not call tool.call when permission denied', async () => {
    const callFn = vi.fn(async () => ({ content: 'called', isError: false }))
    const tool = buildTool({
      name: 'Locked',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
      checkPermissions: async () => ({ behavior: 'deny', message: 'no' }),
    })
    const ctx = makeContext([tool])
    await runToolUse(makeToolUse('Locked'), ctx, makeSignal())
    expect(callFn).not.toHaveBeenCalled()
  })

  it('catches tool.call errors and returns execution_error', async () => {
    const tool = buildTool({
      name: 'Crasher',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => { throw new Error('boom') },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('Crasher'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('execution_error')
    expect(result.content).toContain('boom')
  })

  it('catches validateInput errors and returns validation_failed', async () => {
    const tool = buildTool({
      name: 'BadValidator',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      validateInput: async () => { throw new Error('validator crashed') },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('BadValidator'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('validation_failed')
    expect(result.content).toContain('validator crashed')
  })

  it('catches checkPermissions errors and returns permission_denied', async () => {
    const tool = buildTool({
      name: 'BadPerms',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      checkPermissions: async () => { throw new Error('perms crashed') },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('BadPerms'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('permission_denied')
    expect(result.content).toContain('perms crashed')
  })

  // ---------------------------------------------------------------------------
  // Abort tests
  // ---------------------------------------------------------------------------

  it('returns abort result when signal already aborted', async () => {
    const tool = okTool()
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('TestTool'), ctx, makeSignal(true))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('aborted')
  })

  it('does not call tool.call when signal already aborted', async () => {
    const callFn = vi.fn(async () => ({ content: 'called', isError: false }))
    const tool = buildTool({
      name: 'NeverCalled',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
    })
    const ctx = makeContext([tool])
    await runToolUse(makeToolUse('NeverCalled'), ctx, makeSignal(true))
    expect(callFn).not.toHaveBeenCalled()
  })

  it('returns abort result when aborted after validation', async () => {
    const ac = new AbortController()
    const tool = buildTool({
      name: 'SlowPerms',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      validateInput: async () => {
        // Abort during validation — next checkpoint catches it
        ac.abort()
        return { valid: true as const }
      },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('SlowPerms'), ctx, ac.signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('aborted')
  })

  it('returns abort result when aborted after permissions', async () => {
    const ac = new AbortController()
    const tool = buildTool({
      name: 'SlowCall',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      checkPermissions: async () => {
        // Abort during permission check — next checkpoint catches it
        ac.abort()
        return { behavior: 'allow' as const }
      },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('SlowCall'), ctx, ac.signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('aborted')
  })

  it('passes input through to tool.call', async () => {
    const callFn = vi.fn(async () => ({ content: 'ok', isError: false }))
    const tool = buildTool({
      name: 'Echo',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
    })
    const ctx = makeContext([tool])
    const input = { file_path: '/tmp/test.txt', content: 'hello' }
    await runToolUse(makeToolUse('Echo', input), ctx, makeSignal())
    expect(callFn).toHaveBeenCalledWith(input, ctx, expect.any(AbortSignal))
  })

  it('passes signal through to tool.call', async () => {
    const signal = makeSignal()
    const callFn = vi.fn(async (_input: Record<string, unknown>, _ctx: unknown, s: AbortSignal) => {
      expect(s).toBe(signal)
      return { content: 'ok', isError: false }
    })
    const tool = buildTool({
      name: 'SignalCheck',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
    })
    const ctx = makeContext([tool])
    await runToolUse(makeToolUse('SignalCheck'), ctx, signal)
    expect(callFn).toHaveBeenCalled()
  })
})
