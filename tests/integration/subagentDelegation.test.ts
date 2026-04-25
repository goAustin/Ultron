/**
 * Integration test: subagent delegation.
 *
 * Verifies the full AgentTool → forkSubagent → query() round-trip.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { createForkSubagent } from '../../src/agents/runAgent.js'
import { createAgentTool } from '../../src/agents/agentTool.js'
import { createToolUseContext } from '../../src/core/tools/context.js'
import { createDefaultRegistry } from '../../src/core/tools/registry.js'
import { createStore, getDefaultAppState } from '../../src/core/state.js'
import type { AppState } from '../../src/core/state.js'
import type { CallModelFn, RawStreamEvent, ApiResponseMeta } from '../../src/core/queryDeps.js'
import type { AuditWriter } from '../../src/audit/types.js'

// Null writer for tests — events are thrown away.
const nullAuditWriter: AuditWriter = {
  write: () => {},
  close: async () => {},
  withOrigin: () => nullAuditWriter,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-subagent-integ-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function textCallModel(text: string): CallModelFn {
  return async function* () {
    yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason: 'end_turn', inputTokens: 10, outputTokens: 5 } as ApiResponseMeta
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subagent delegation', () => {
  it('AgentTool calls forkSubagent and returns subagent result', async () => {
    await withTmpDir(async (dir) => {
      const callModel = textCallModel('I found 3 TypeScript files.')
      const parentAppState = createStore<AppState>(getDefaultAppState())

      const forkSubagent = createForkSubagent({
        callModel,
        compactCallModel: callModel,
        parentToolRegistry: createDefaultRegistry(),
        parentAppState,
        parentSystemPromptParts: [{ content: 'You are a test assistant.', cacheHint: 'global' }],
        parentSignal: new AbortController().signal,
        cwd: dir,
        sessionDir: dir,
        permissionOpts: { headless: false, safetyChecks: [] },
        auditWriter: nullAuditWriter,
      })

      const context = createToolUseContext({
        appState: parentAppState,
        abortController: new AbortController(),
        messages: [],
        toolRegistry: createDefaultRegistry(),
        forkSubagent,
      })

      const agentTool = createAgentTool()
      const result = await agentTool.call(
        { prompt: 'Find all TypeScript files' },
        context,
        new AbortController().signal,
      )

      expect(result.isError).toBe(false)
      expect(result.content).toBe('I found 3 TypeScript files.')
    })
  })

  it('subagent state is isolated from parent', async () => {
    await withTmpDir(async (dir) => {
      const parentAppState = createStore<AppState>({
        ...getDefaultAppState(),
        permissionMode: 'default',
      })

      const forkSubagent = createForkSubagent({
        callModel: textCallModel('Done'),
        compactCallModel: textCallModel('compact'),
        parentToolRegistry: createDefaultRegistry(),
        parentAppState,
        parentSystemPromptParts: [{ content: 'Test', cacheHint: 'global' }],
        parentSignal: new AbortController().signal,
        cwd: dir,
        sessionDir: dir,
        permissionOpts: { headless: false, safetyChecks: [] },
        auditWriter: nullAuditWriter,
      })

      await forkSubagent('Do something')

      // Parent state should be unchanged
      expect(parentAppState.getState().permissionMode).toBe('default')
    })
  })

  it('subagent transcript is persisted to agents/ subdirectory', async () => {
    await withTmpDir(async (dir) => {
      const forkSubagent = createForkSubagent({
        callModel: textCallModel('Result text'),
        compactCallModel: textCallModel('compact'),
        parentToolRegistry: createDefaultRegistry(),
        parentAppState: createStore<AppState>(getDefaultAppState()),
        parentSystemPromptParts: [{ content: 'Test', cacheHint: 'global' }],
        parentSignal: new AbortController().signal,
        cwd: dir,
        sessionDir: dir,
        permissionOpts: { headless: false, safetyChecks: [] },
        auditWriter: nullAuditWriter,
      })

      const result = await forkSubagent('Research task')

      const agentDir = join(dir, 'agents', result.subagentId)
      expect(existsSync(join(agentDir, 'transcript.jsonl'))).toBe(true)
    })
  })

  it('parent abort cascades to subagent', async () => {
    await withTmpDir(async (dir) => {
      const parentAc = new AbortController()
      parentAc.abort() // abort immediately

      const forkSubagent = createForkSubagent({
        callModel: textCallModel('Should not see this'),
        compactCallModel: textCallModel('compact'),
        parentToolRegistry: createDefaultRegistry(),
        parentAppState: createStore<AppState>(getDefaultAppState()),
        parentSystemPromptParts: [{ content: 'Test', cacheHint: 'global' }],
        parentSignal: parentAc.signal,
        cwd: dir,
        sessionDir: dir,
        permissionOpts: { headless: false, safetyChecks: [] },
        auditWriter: nullAuditWriter,
      })

      const result = await forkSubagent('This should abort')
      expect(result.terminal.reason).toBe('aborted')
    })
  })
})
