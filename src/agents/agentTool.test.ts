import { describe, it, expect } from 'vitest'

import { createAgentTool, AGENT_TOOL_NAME } from './agentTool.js'
import type { ToolUseContext } from '../core/tools/context.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import type { AppState } from '../core/state.js'
import { createToolRegistry } from '../core/tools/registry.js'
import type { SubagentResult } from './runAgent.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(forkSubagent?: (prompt: string) => Promise<SubagentResult>): ToolUseContext {
  return createToolUseContext({
    appState: createStore<AppState>(getDefaultAppState()),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createToolRegistry(),
    forkSubagent,
  })
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
})
