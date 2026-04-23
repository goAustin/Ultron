import { describe, it, expect, vi } from 'vitest'
import { partitionIntoBatches, runToolBatch, runWithConcurrencyLimit } from './toolOrchestration.js'
import { createAuthorizeToolUseFn, createExecuteToolUseFn } from './toolExecution.js'
import { buildTool } from './types.js'
import type { Tool } from './types.js'
import type { ToolUseContext } from './context.js'
import { createToolUseContext } from './context.js'
import { createToolRegistry } from './registry.js'
import type { ToolRegistry } from './registry.js'
import { createStore, getDefaultAppState } from '../state.js'
import type { ToolUseBlock } from '../messages.js'
import { toolUseId } from '../messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tuCounter = 0
function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId(`tu-${++tuCounter}`), name, input }
}

function makeTool(name: string, opts: { safe?: boolean; delay?: number; result?: string } = {}): Tool {
  return buildTool({
    name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    call: async () => {
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay))
      return { content: opts.result ?? `${name}-ok`, isError: false }
    },
    ...(opts.safe ? { isConcurrencySafe: () => true } : {}),
  })
}

/** Default context uses bypassPermissions so pipeline tests are not blocked by the engine fallback. */
function makeContext(tools: Tool[]): ToolUseContext {
  const registry = createToolRegistry()
  for (const t of tools) registry.register(t)
  return createToolUseContext({
    appState: createStore({
      ...getDefaultAppState(),
      permissionMode: 'bypassPermissions' as import('../../core/state.js').PermissionMode,
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

// ---------------------------------------------------------------------------
// partitionIntoBatches
// ---------------------------------------------------------------------------

describe('partitionIntoBatches', () => {
  function registryWith(tools: Tool[]): ToolRegistry {
    const r = createToolRegistry()
    for (const t of tools) r.register(t)
    return r
  }

  it('groups consecutive safe tools into one concurrent batch', () => {
    const tools = [makeTool('A', { safe: true }), makeTool('B', { safe: true })]
    const registry = registryWith(tools)
    const batches = partitionIntoBatches(
      [makeToolUse('A'), makeToolUse('B')],
      registry,
    )
    expect(batches).toHaveLength(1)
    expect(batches[0].concurrent).toBe(true)
    expect(batches[0].toolUses).toHaveLength(2)
  })

  it('isolates unsafe tools into serial batches', () => {
    const tools = [makeTool('X')]
    const registry = registryWith(tools)
    const batches = partitionIntoBatches([makeToolUse('X')], registry)
    expect(batches).toHaveLength(1)
    expect(batches[0].concurrent).toBe(false)
    expect(batches[0].toolUses).toHaveLength(1)
  })

  it('partitions mixed safe/unsafe into correct batches', () => {
    const tools = [
      makeTool('R1', { safe: true }),
      makeTool('R2', { safe: true }),
      makeTool('W', { safe: false }),
      makeTool('R3', { safe: true }),
    ]
    const registry = registryWith(tools)
    const batches = partitionIntoBatches(
      [makeToolUse('R1'), makeToolUse('R2'), makeToolUse('W'), makeToolUse('R3')],
      registry,
    )
    expect(batches).toHaveLength(3)
    expect(batches[0].concurrent).toBe(true)
    expect(batches[0].toolUses).toHaveLength(2)
    expect(batches[1].concurrent).toBe(false)
    expect(batches[1].toolUses).toHaveLength(1)
    expect(batches[2].concurrent).toBe(true)
    expect(batches[2].toolUses).toHaveLength(1)
  })

  it('treats unknown tools as unsafe', () => {
    const registry = registryWith([])
    const batches = partitionIntoBatches([makeToolUse('Unknown')], registry)
    expect(batches).toHaveLength(1)
    expect(batches[0].concurrent).toBe(false)
  })

  it('returns empty for empty input', () => {
    const registry = registryWith([])
    expect(partitionIntoBatches([], registry)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// runToolBatch
// ---------------------------------------------------------------------------

describe('runToolBatch', () => {
  it('runs all tools and returns paired results', async () => {
    const tools = [makeTool('A'), makeTool('B')]
    const ctx = makeContext(tools)
    const toolUses = [makeToolUse('A'), makeToolUse('B')]
    const results = await runToolBatch(toolUses, ctx, makeSignal())
    expect(results).toHaveLength(2)
    expect(results[0].result.content).toBe('A-ok')
    expect(results[1].result.content).toBe('B-ok')
  })

  it('preserves toolUseId association', async () => {
    const tools = [makeTool('X')]
    const ctx = makeContext(tools)
    const tu = makeToolUse('X')
    const results = await runToolBatch([tu], ctx, makeSignal())
    expect(results[0].toolUseId).toBe(tu.id)
  })

  it('returns error for unknown tools without crashing', async () => {
    const ctx = makeContext([])
    const results = await runToolBatch([makeToolUse('Ghost')], ctx, makeSignal())
    expect(results).toHaveLength(1)
    expect(results[0].result.isError).toBe(true)
    expect(results[0].result.content).toContain('tool_not_found')
  })

  it('runs concurrent-safe tools in parallel', async () => {
    // Two safe tools with a 50ms delay each — if serial, ~100ms; if parallel, ~50ms
    const tools = [
      makeTool('S1', { safe: true, delay: 50 }),
      makeTool('S2', { safe: true, delay: 50 }),
    ]
    const ctx = makeContext(tools)
    const toolUses = [makeToolUse('S1'), makeToolUse('S2')]

    const start = Date.now()
    const results = await runToolBatch(toolUses, ctx, makeSignal())
    const elapsed = Date.now() - start

    expect(results).toHaveLength(2)
    expect(results[0].result.isError).toBe(false)
    expect(results[1].result.isError).toBe(false)
    // Should be closer to 50ms than 100ms (allow margin for CI)
    expect(elapsed).toBeLessThan(90)
  })

  it('runs unsafe tools serially', async () => {
    const order: string[] = []
    const tools = [
      buildTool({
        name: 'W1',
        inputSchema: { type: 'object', properties: {}, required: [] },
        call: async () => { order.push('W1'); return { content: 'ok', isError: false } },
      }),
      buildTool({
        name: 'W2',
        inputSchema: { type: 'object', properties: {}, required: [] },
        call: async () => { order.push('W2'); return { content: 'ok', isError: false } },
      }),
    ]
    const ctx = makeContext(tools)
    await runToolBatch([makeToolUse('W1'), makeToolUse('W2')], ctx, makeSignal())
    expect(order).toEqual(['W1', 'W2'])
  })

  it('returns abort results when signal already aborted', async () => {
    const tools = [makeTool('A')]
    const ctx = makeContext(tools)
    const results = await runToolBatch([makeToolUse('A')], ctx, makeSignal(true))
    expect(results).toHaveLength(1)
    expect(results[0].result.isError).toBe(true)
    expect(results[0].result.content).toContain('aborted')
  })

  it('aborts remaining tools in later batches', async () => {
    const ac = new AbortController()
    const tools = [
      buildTool({
        name: 'Aborter',
        inputSchema: { type: 'object', properties: {}, required: [] },
        call: async () => {
          ac.abort()
          return { content: 'done', isError: false }
        },
      }),
      makeTool('Never'),
    ]
    const ctx = makeContext(tools)
    const results = await runToolBatch(
      [makeToolUse('Aborter'), makeToolUse('Never')],
      ctx,
      ac.signal,
    )
    expect(results).toHaveLength(2)
    expect(results[0].result.content).toBe('done')
    expect(results[1].result.isError).toBe(true)
    expect(results[1].result.content).toContain('aborted')
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit
// ---------------------------------------------------------------------------

describe('runWithConcurrencyLimit', () => {
  it('runs all tasks and returns settled results', async () => {
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ]
    const results = await runWithConcurrencyLimit(tasks, 10)
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
  })

  it('respects concurrency limit', async () => {
    let concurrent = 0
    let maxConcurrent = 0

    const makeTask = () => async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 10))
      concurrent--
      return 'done'
    }

    const tasks = Array.from({ length: 6 }, makeTask)
    await runWithConcurrencyLimit(tasks, 2)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('handles rejections without crashing', async () => {
    const tasks = [
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('ok2'),
    ]
    const results = await runWithConcurrencyLimit(tasks, 10)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' })
    expect(results[1].status).toBe('rejected')
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'ok2' })
  })

  it('handles empty task list', async () => {
    const results = await runWithConcurrencyLimit([], 10)
    expect(results).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Authorize + execute adapters (replace Phase 1 createRunToolFn)
// ---------------------------------------------------------------------------

describe('createAuthorizeToolUseFn + createExecuteToolUseFn', () => {
  it('authorize→execute returns the same result as the pre-split path', async () => {
    const tool = makeTool('Echo', { result: 'hello' })
    const ctx = makeContext([tool])
    const authorize = createAuthorizeToolUseFn(ctx)
    const execute = createExecuteToolUseFn(ctx)

    const auth = await authorize(makeToolUse('Echo'), makeSignal())
    expect(auth.outcome).toBe('authorized')
    const result = await execute(makeToolUse('Echo'), makeSignal())
    expect(result).toEqual({ content: 'hello', isError: false })
  })

  it('returns a precondition_failed outcome for an unknown tool', async () => {
    const ctx = makeContext([])
    const authorize = createAuthorizeToolUseFn(ctx)

    const auth = await authorize(makeToolUse('Missing'), makeSignal())
    expect(auth.outcome).toBe('precondition_failed')
    if (auth.outcome === 'precondition_failed') {
      expect(auth.syntheticResult.isError).toBe(true)
      expect(auth.syntheticResult.errorKind).toBe('tool_not_found')
    }
  })
})
