import { describe, it, expect, vi } from 'vitest'

import { createAgentTool, AGENT_TOOL_NAME } from './agentTool.js'
import type { ToolUseContext } from '../core/tools/context.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import type { AppState } from '../core/state.js'
import { createToolRegistry } from '../core/tools/registry.js'
import type { SubagentResult, EngineForkSubagentFn, ForkSubagentFn } from './runAgent.js'
import { toolUseId } from '../core/messages.js'
import type { ToolUseBlock, ToolUseId } from '../core/messages.js'
import { executeToolUse } from '../core/tools/runToolUse.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a per-call ToolUseContext as `executeToolUse` would — accepting a
 * unary `forkSubagent` directly so the existing tests that drive
 * `tool.call()` outside the executor continue to read naturally. Phase 7c
 * still has its own test below that exercises the engine → per-call
 * rebind path through `executeToolUse`.
 */
function makeContext(forkSubagent?: ForkSubagentFn): ToolUseContext {
  const base = createToolUseContext({
    appState: createStore<AppState>(getDefaultAppState()),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createToolRegistry(),
  })
  return forkSubagent ? { ...base, forkSubagent } : base
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentTool', () => {
  const tool = createAgentTool()

  it('has the correct name', () => {
    expect(tool.name).toBe(AGENT_TOOL_NAME)
  })

  it('validates prompt is non-empty', async () => {
    const ctx = makeContext()

    const empty = await tool.validateInput({ prompt: '' }, ctx)
    expect(empty.valid).toBe(false)

    const missing = await tool.validateInput({}, ctx)
    expect(missing.valid).toBe(false)

    const valid = await tool.validateInput({ prompt: 'Find files' }, ctx)
    expect(valid.valid).toBe(true)
  })

  it('auto-approves permissions', async () => {
    const ctx = makeContext()
    const result = await tool.checkPermissions({ prompt: 'test' }, ctx)
    expect(result.behavior).toBe('allow')
  })

  it('returns error if forkSubagent not in context', async () => {
    const ctx = makeContext() // no forkSubagent
    const result = await tool.call({ prompt: 'test' }, ctx, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not available')
  })

  it('calls forkSubagent with prompt and returns text result', async () => {
    const mockFork = async (prompt: string): Promise<SubagentResult> => ({
      text: `Result for: ${prompt}`,
      terminal: { reason: 'end_turn', messages: [] },
      subagentId: 'sub-123',
    })

    const ctx = makeContext(mockFork)
    const result = await tool.call({ prompt: 'Find all .ts files' }, ctx, new AbortController().signal)

    expect(result.isError).toBe(false)
    expect(result.content).toBe('Result for: Find all .ts files')
  })

  it('declares isReadOnly so the subagent registry invariant accepts it', () => {
    expect(tool.isReadOnly).toBe(true)
  })

  it('declares isConcurrencySafe so multiple Agent tool_uses fan out (Phase 7b)', () => {
    expect(tool.isConcurrencySafe?.({ prompt: 'anything' })).toBe(true)
  })

  it('surfaces subagent terminal errors as isError: true', async () => {
    const mockFork = async (): Promise<SubagentResult> => ({
      text: 'subagent crashed mid-investigation',
      terminal: {
        reason: 'error',
        messages: [],
        error: new Error('boom'),
      },
      subagentId: 'sub-err',
    })

    const ctx = makeContext(mockFork)
    const result = await tool.call({ prompt: 'investigate' }, ctx, new AbortController().signal)

    expect(result.isError).toBe(true)
    expect(result.content).toBe('subagent crashed mid-investigation')
  })

  // Phase 7c — when AgentTool runs through executeToolUse, the per-call
  // rebind should curry the parent ToolUseBlock.id into the unary
  // forkSubagent the tool consumes.
  it('engineForkSubagent receives parent ToolUseBlock.id when AgentTool runs through executeToolUse', async () => {
    const captured: { prompt: string; parentToolUseId: ToolUseId }[] = []
    const engineFork: EngineForkSubagentFn = async (prompt, parentToolUseId) => {
      captured.push({ prompt, parentToolUseId })
      return {
        text: 'engine-fork-result',
        terminal: { reason: 'end_turn', messages: [] },
        subagentId: 'sub-engine',
      }
    }

    const registry = createToolRegistry()
    registry.register(tool)
    const ctx = createToolUseContext({
      appState: createStore<AppState>(getDefaultAppState()),
      abortController: new AbortController(),
      messages: [],
      toolRegistry: registry,
      engineForkSubagent: engineFork,
    })

    const tu: ToolUseBlock = {
      type: 'tool_use',
      id: toolUseId('tu_parent_agent_call'),
      name: AGENT_TOOL_NAME,
      input: { prompt: 'investigate X' },
    }

    const result = await executeToolUse(tu, ctx, new AbortController().signal)

    expect(result.isError).toBe(false)
    expect(result.content).toBe('engine-fork-result')
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual({
      prompt: 'investigate X',
      parentToolUseId: toolUseId('tu_parent_agent_call'),
    })
  })

  // Defense-in-depth: when only the unary forkSubagent is set on the
  // per-call context (the path AgentTool's call() actually exercises), the
  // tool returns the fork's text without ever seeing the engine fn.
  it('AgentTool.call drives the unary forkSubagent set on the per-call context', async () => {
    const fork = vi.fn(async (prompt: string): Promise<SubagentResult> => ({
      text: `unary: ${prompt}`,
      terminal: { reason: 'end_turn', messages: [] },
      subagentId: 'sub-unary',
    }))
    const ctx = makeContext(fork)
    const result = await tool.call({ prompt: 'work' }, ctx, new AbortController().signal)
    expect(result.content).toBe('unary: work')
    expect(fork).toHaveBeenCalledWith('work')
  })

  it('treats end_turn / aborted / max_turns terminals as non-error', async () => {
    for (const reason of ['end_turn', 'aborted', 'max_turns'] as const) {
      const mockFork = async (): Promise<SubagentResult> => ({
        text: `terminal ${reason}`,
        terminal: { reason, messages: [] } as SubagentResult['terminal'],
        subagentId: `sub-${reason}`,
      })

      const ctx = makeContext(mockFork)
      const result = await tool.call({ prompt: 'x' }, ctx, new AbortController().signal)

      expect(result.isError).toBe(false)
    }
  })
})
