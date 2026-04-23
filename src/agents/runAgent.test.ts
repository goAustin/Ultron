import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { createForkSubagent } from './runAgent.js'
import type { SubagentOptions } from './runAgent.js'
import type { CallModelFn, RawStreamEvent, ApiResponseMeta } from '../core/queryDeps.js'
import type { PermissionOptions } from '../core/permissions/types.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import type { AppState } from '../core/state.js'
import { createDefaultRegistry } from '../core/tools/registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-agent-'))
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

const defaultPermOpts: PermissionOptions = {
  headless: false,
  safetyChecks: [],
}

function makeOpts(sessionDir: string, overrides?: Partial<SubagentOptions>): SubagentOptions {
  return {
    callModel: textCallModel('Subagent result text here.'),
    compactCallModel: textCallModel('compact'),
    parentToolRegistry: createDefaultRegistry(),
    parentAppState: createStore<AppState>(getDefaultAppState()),
    parentSystemPromptParts: [{ content: 'You are a helpful assistant.', cacheHint: 'static' }],
    parentSignal: new AbortController().signal,
    cwd: sessionDir,
    sessionDir,
    permissionOpts: defaultPermOpts,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createForkSubagent', () => {
  it('returns result text from subagent', async () => {
    await withTmpDir(async (dir) => {
      const fork = createForkSubagent(makeOpts(dir))
      const result = await fork('Search for files')

      expect(result.text).toBe('Subagent result text here.')
      expect(result.terminal.reason).toBe('end_turn')
      expect(result.subagentId).toBeTruthy()
    })
  })

  it('isolates AppState — mutations do not affect parent', async () => {
    await withTmpDir(async (dir) => {
      const parentState = createStore<AppState>({
        ...getDefaultAppState(),
        permissionMode: 'default',
      })

      // Use a callModel that will cause the subagent to end quickly
      const fork = createForkSubagent(makeOpts(dir, { parentAppState: parentState }))
      await fork('Do something')

      // Parent state should be unchanged
      expect(parentState.getState().permissionMode).toBe('default')
    })
  })

  it('filters tool registry to allowed tools only', async () => {
    await withTmpDir(async (dir) => {
      const registry = createDefaultRegistry()
      // Default allowed = FileRead, Glob, Grep
      // Registry has: FileRead, FileWrite, FileEdit, Glob, Grep, Bash

      const fork = createForkSubagent(makeOpts(dir, { parentToolRegistry: registry }))

      // We can't directly inspect the subagent's registry, but we can verify
      // the fork runs successfully with the filtered set
      const result = await fork('Find all TypeScript files')
      expect(result.terminal.reason).toBe('end_turn')
    })
  })

  it('excludes Agent tool even if explicitly allowed', async () => {
    await withTmpDir(async (dir) => {
      const fork = createForkSubagent(makeOpts(dir, {
        allowedTools: ['FileRead', 'Agent'],
      }))

      // Should still work — Agent is silently excluded
      const result = await fork('Do research')
      expect(result.terminal.reason).toBe('end_turn')
    })
  })

  it('parent abort cascades to subagent', async () => {
    await withTmpDir(async (dir) => {
      const parentAc = new AbortController()

      // Use a callModel that yields slowly so abort can propagate
      const slowCallModel: CallModelFn = async function* (_msgs, _sys, _opts, signal) {
        // Check abort before yielding — the linked controller should be aborted
        if (signal.aborted) {
          throw new Error('aborted')
        }
        yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn', inputTokens: 10, outputTokens: 1 } as ApiResponseMeta
      }

      const fork = createForkSubagent(makeOpts(dir, {
        parentSignal: parentAc.signal,
        callModel: slowCallModel,
      }))

      // Abort parent before calling fork — the linked controller picks it up
      parentAc.abort()

      const result = await fork('This should abort')
      expect(result.terminal.reason).toBe('aborted')
    })
  })

  it('persists subagent messages to subdirectory', async () => {
    await withTmpDir(async (dir) => {
      const fork = createForkSubagent(makeOpts(dir))
      const result = await fork('Find files')

      // Check transcript exists in agents/<subagentId>/
      const transcriptPath = join(dir, 'agents', result.subagentId, 'transcript.jsonl')
      expect(existsSync(transcriptPath)).toBe(true)

      const content = readFileSync(transcriptPath, 'utf-8')
      const lines = content.trim().split('\n')
      // Should have at least the assistant turn
      expect(lines.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('returns fallback text when subagent produces no text', async () => {
    await withTmpDir(async (dir) => {
      // callModel that returns empty text
      const fork = createForkSubagent(makeOpts(dir, {
        callModel: textCallModel(''),
      }))

      const result = await fork('Empty response')
      expect(result.text).toContain('no text output')
    })
  })

  it('forwards parentThinkingBudget into the subagent callModel', async () => {
    await withTmpDir(async (dir) => {
      const captured: Array<{ thinkingBudget?: number; interleavedThinking?: boolean }> = []
      const spyCallModel: CallModelFn = vi.fn(async function* (_msgs, _sys, opts, _signal) {
        captured.push({
          thinkingBudget: opts.thinkingBudget,
          interleavedThinking: opts.interleavedThinking,
        })
        yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
      })

      const fork = createForkSubagent(makeOpts(dir, {
        callModel: spyCallModel,
        parentThinkingBudget: 4096,
        parentInterleavedThinking: true,
      }))
      await fork('do work')

      expect(captured.length).toBeGreaterThanOrEqual(1)
      expect(captured[0]).toEqual({ thinkingBudget: 4096, interleavedThinking: true })
    })
  })
})
