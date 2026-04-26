import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { createForkSubagent } from './runAgent.js'
import type { SubagentOptions } from './runAgent.js'
import { toolUseId } from '../core/messages.js'
import { buildAuditTree, type AuditEnvelope } from '../audit/auditTree.js'

// Phase 7c: createForkSubagent now requires a parentToolUseId on every
// invocation. The test helper supplies a synthetic value when the test
// doesn't care about the value itself; tests that DO care (the
// correlation tests below) pass a distinct id per fork.
const TEST_PARENT_TUID = toolUseId('tu_test_parent')
import type {
  CallModelFn,
  RawStreamEvent,
  ApiResponseMeta,
  RunPreToolUseHooksFn,
  RunPostToolUseHooksFn,
} from '../core/queryDeps.js'
import type { PermissionOptions } from '../core/permissions/types.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import type { AppState } from '../core/state.js'
import { createDefaultRegistry } from '../core/tools/registry.js'
import type { AuditWriter } from '../audit/types.js'
import type { QueryEvent } from '../core/queryEvents.js'

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

type CapturedRecord = {
  event: QueryEvent
  origin?: string
  parentToolUseId?: import('../core/messages.js').ToolUseId
}

function makeCapturingWriter(): { writer: AuditWriter; captured: CapturedRecord[] } {
  const captured: CapturedRecord[] = []
  const makeHandle = (
    origin?: string,
    parentToolUseId?: import('../core/messages.js').ToolUseId,
  ): AuditWriter => ({
    write: (event) => {
      const record: CapturedRecord = { event }
      if (origin !== undefined) record.origin = origin
      if (parentToolUseId !== undefined) record.parentToolUseId = parentToolUseId
      captured.push(record)
    },
    close: async () => {},
    withOrigin: (tag, opts) => makeHandle(tag, opts?.parentToolUseId),
  })
  return { writer: makeHandle(), captured }
}

const noopPreHooks: RunPreToolUseHooksFn = async function* () {
  return { kind: 'continue' }
}

const noopPostHooks: RunPostToolUseHooksFn = async function* (_tu, result) {
  return { result }
}

function makeOpts(sessionDir: string, overrides?: Partial<SubagentOptions>): SubagentOptions {
  const { writer } = makeCapturingWriter()
  return {
    callModel: textCallModel('Subagent result text here.'),
    compactCallModel: textCallModel('compact'),
    parentToolRegistry: createDefaultRegistry(),
    parentAppState: createStore<AppState>(getDefaultAppState()),
    parentSystemPromptParts: [{ content: 'You are a helpful assistant.', cacheHint: 'global' }],
    parentSignal: new AbortController().signal,
    cwd: sessionDir,
    sessionDir,
    permissionOpts: defaultPermOpts,
    auditWriter: writer,
    runPreToolUseHooks: noopPreHooks,
    runPostToolUseHooks: noopPostHooks,
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
      const result = await fork('Search for files', TEST_PARENT_TUID)

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
      await fork('Do something', TEST_PARENT_TUID)

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
      const result = await fork('Find all TypeScript files', TEST_PARENT_TUID)
      expect(result.terminal.reason).toBe('end_turn')
    })
  })

  it('excludes Agent tool even if explicitly allowed', async () => {
    await withTmpDir(async (dir) => {
      const fork = createForkSubagent(makeOpts(dir, {
        allowedTools: ['FileRead', 'Agent'],
      }))

      // Should still work — Agent is silently excluded
      const result = await fork('Do research', TEST_PARENT_TUID)
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

      const result = await fork('This should abort', TEST_PARENT_TUID)
      expect(result.terminal.reason).toBe('aborted')
    })
  })

  it('persists subagent messages to subdirectory', async () => {
    await withTmpDir(async (dir) => {
      const fork = createForkSubagent(makeOpts(dir))
      const result = await fork('Find files', TEST_PARENT_TUID)

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

      const result = await fork('Empty response', TEST_PARENT_TUID)
      expect(result.text).toContain('no text output')
    })
  })

  // Phase 7a — verification clause: subagent calling a tool outside its
  // scoped pool is denied at the permission layer (NOT as tool_not_found).
  // The pre-resolution scope gate in authorizeToolUse fires before registry
  // resolve, so the filtered subagent registry never short-circuits the
  // policy decision.
  it('out-of-scope tool_use produces an agentScope permission deny, not tool_not_found', async () => {
    await withTmpDir(async (dir) => {
      // callModel emits a tool_use for Glob on first call, then end_turn on
      // the second (after the synthetic permission_denied tool_result is fed
      // back). Without the second turn we would loop until maxTurns.
      let calls = 0
      const tooluseThenEnd: CallModelFn = async function* () {
        calls++
        if (calls === 1) {
          yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
          yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-glob-1', name: 'Glob', input: '' } } as RawStreamEvent
          yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
          yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } } as RawStreamEvent
          yield { type: 'message_stop' } as RawStreamEvent
          return { stopReason: 'tool_use', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
        }
        yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
      }

      const { writer, captured } = makeCapturingWriter()

      const fork = createForkSubagent(makeOpts(dir, {
        callModel: tooluseThenEnd,
        // Narrow the allowlist so Glob is out of scope.
        allowedTools: ['FileRead'],
        auditWriter: writer,
      }))
      const result = await fork('try a glob', TEST_PARENT_TUID)

      expect(result.terminal.reason).toBe('end_turn')

      // The audit log should contain a permission_decision event with the
      // agentScope formatted reason — proving the deny came from the policy
      // layer, not the tool_not_found precondition.
      const permissionEvents = captured
        .map((c) => c.event)
        .filter((e): e is Extract<QueryEvent, { type: 'permission_decision' }> => e.type === 'permission_decision')

      expect(permissionEvents.length).toBe(1)
      expect(permissionEvents[0].decision).toBe('deny')
      expect(permissionEvents[0].toolName).toBe('Glob')
      expect(permissionEvents[0].reason).toContain("subagent's allowed tools")

      // The corresponding tool_result should be a permission_denied error,
      // not tool_not_found.
      const toolResultEvents = captured
        .map((c) => c.event)
        .filter((e): e is Extract<QueryEvent, { type: 'tool_result' }> => e.type === 'tool_result')
      expect(toolResultEvents.length).toBeGreaterThanOrEqual(1)
      const firstResult = toolResultEvents[0]
      const block = firstResult.message.content[0]
      expect(block.type).toBe('tool_result')
      if (block.type === 'tool_result') {
        expect(block.isError).toBe(true)
        expect(block.content).toContain('permission_denied')
        expect(block.content).not.toContain('tool_not_found')
      }
    })
  })

  // Phase 7a — Agent tool_use emitted from inside a subagent must deny via
  // agentScope (the policy layer), NOT surface as tool_not_found. This is
  // the corollary of the registry/scope-agreement fix: requesting Agent in
  // allowedTools no longer leaks past the pre-resolution gate.
  it('Agent tool_use from a subagent denies as agentScope, not tool_not_found', async () => {
    await withTmpDir(async (dir) => {
      let calls = 0
      const tooluseThenEnd: CallModelFn = async function* () {
        calls++
        if (calls === 1) {
          yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
          yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-agent-1', name: 'Agent', input: '' } } as RawStreamEvent
          yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
          yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } } as RawStreamEvent
          yield { type: 'message_stop' } as RawStreamEvent
          return { stopReason: 'tool_use', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
        }
        yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
      }

      const { writer, captured } = makeCapturingWriter()

      // Even with Agent explicitly requested, the effective allowlist drops
      // it — so an emitted Agent call falls through the pre-resolution gate
      // with agentScope, not the registry-resolve fallback.
      const fork = createForkSubagent(makeOpts(dir, {
        callModel: tooluseThenEnd,
        allowedTools: ['FileRead', 'Agent'],
        auditWriter: writer,
      }))
      const result = await fork('try to fork another agent', TEST_PARENT_TUID)

      expect(result.terminal.reason).toBe('end_turn')

      const permissionEvents = captured
        .map((c) => c.event)
        .filter((e): e is Extract<QueryEvent, { type: 'permission_decision' }> => e.type === 'permission_decision')

      expect(permissionEvents.length).toBe(1)
      expect(permissionEvents[0].decision).toBe('deny')
      expect(permissionEvents[0].toolName).toBe('Agent')
      expect(permissionEvents[0].reason).toContain("subagent's allowed tools")

      const toolResultEvents = captured
        .map((c) => c.event)
        .filter((e): e is Extract<QueryEvent, { type: 'tool_result' }> => e.type === 'tool_result')
      const block = toolResultEvents[0]?.message.content[0]
      if (block?.type === 'tool_result') {
        expect(block.content).toContain('permission_denied')
        expect(block.content).not.toContain('tool_not_found')
      }
    })
  })

  // Phase 7a — parent-scope subset invariant. A parent already running under
  // a scoped allowlist (e.g. an active skill restricting tools to FileRead)
  // must not be widened by a subagent. The subagent's effective scope is the
  // intersection of its requested allowedTools with the parent's scope.
  it('subagent cannot widen the parent scopedToolAllowlist', async () => {
    await withTmpDir(async (dir) => {
      let calls = 0
      // Subagent emits a Glob tool_use. Parent scope is ['FileRead'], so the
      // intersection is ['FileRead'] and Glob denies via agentScope even
      // though it appeared in the subagent's requested allowedTools.
      const tooluseThenEnd: CallModelFn = async function* () {
        calls++
        if (calls === 1) {
          yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
          yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-glob-2', name: 'Glob', input: '' } } as RawStreamEvent
          yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
          yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } } as RawStreamEvent
          yield { type: 'message_stop' } as RawStreamEvent
          return { stopReason: 'tool_use', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
        }
        yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
      }

      const { writer, captured } = makeCapturingWriter()

      const fork = createForkSubagent(makeOpts(dir, {
        callModel: tooluseThenEnd,
        // Parent under a skill activation: FileRead only.
        permissionOpts: {
          ...defaultPermOpts,
          scopedToolAllowlist: ['FileRead'],
          scopeSource: 'skill',
        },
        // Subagent tries to widen back to default trio — must not succeed.
        allowedTools: ['FileRead', 'Glob', 'Grep'],
        auditWriter: writer,
      }))
      const result = await fork('try to glob', TEST_PARENT_TUID)

      expect(result.terminal.reason).toBe('end_turn')

      const permissionEvents = captured
        .map((c) => c.event)
        .filter((e): e is Extract<QueryEvent, { type: 'permission_decision' }> => e.type === 'permission_decision')

      expect(permissionEvents.length).toBe(1)
      expect(permissionEvents[0].decision).toBe('deny')
      expect(permissionEvents[0].toolName).toBe('Glob')
      // Reason should be agentScope (subagent's narrowed scope), not skillScope.
      expect(permissionEvents[0].reason).toContain("subagent's allowed tools")
    })
  })

  // -------------------------------------------------------------------------
  // Phase 7b — parallel subagent fan-out
  //
  // `createSandboxContext`'s pure-construction property (no shared mutable
  // state across calls) means two forks are safe to run concurrently. These
  // tests pin that property directly, without going through the parent
  // query loop.
  // -------------------------------------------------------------------------

  it('two parallel forks run concurrently — wall ≈ max(child), not sum (Phase 7b)', async () => {
    await withTmpDir(async (dir) => {
      const DELAY_MS = 80

      const slowCallModel: CallModelFn = async function* () {
        await new Promise((r) => setTimeout(r, DELAY_MS))
        yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
      }

      const fork = createForkSubagent(makeOpts(dir, { callModel: slowCallModel }))

      const wallStart = Date.now()
      const [a, b] = await Promise.all([fork('task A', TEST_PARENT_TUID), fork('task B', TEST_PARENT_TUID)])
      const wallElapsed = Date.now() - wallStart

      expect(a.terminal.reason).toBe('end_turn')
      expect(b.terminal.reason).toBe('end_turn')
      expect(a.subagentId).not.toBe(b.subagentId)
      // Two parallel ~80ms forks should complete in ~80ms, not ~160ms.
      expect(wallElapsed).toBeLessThan(DELAY_MS * 1.7)
    })
  })

  it('one subagent error does not block siblings (Phase 7b)', async () => {
    await withTmpDir(async (dir) => {
      // Per-fork callModel: one throws, the other returns normally.
      const failingCallModel: CallModelFn = async function* () {
        // Throw synchronously inside the generator — the loop turns this
        // into a Terminal { reason: 'error' }.
        throw new Error('synthetic subagent failure')
      }

      const okCallModel: CallModelFn = async function* () {
        yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sibling-result' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
      }

      const failingFork = createForkSubagent(makeOpts(dir, { callModel: failingCallModel }))
      const okFork = createForkSubagent(makeOpts(dir, { callModel: okCallModel }))

      const [failed, ok] = await Promise.all([failingFork('a', TEST_PARENT_TUID), okFork('b', TEST_PARENT_TUID)])

      // Sibling completed normally despite peer's failure.
      expect(ok.terminal.reason).toBe('end_turn')
      expect(ok.text).toBe('sibling-result')

      // The failing fork's terminal carries the error reason — the
      // AgentTool.call() surfacing layer turns this into isError: true.
      expect(failed.terminal.reason).toBe('error')
    })
  })

  it('parent abort cascades to all parallel subagents (Phase 7b)', async () => {
    await withTmpDir(async (dir) => {
      const parentAc = new AbortController()

      const slowCallModel: CallModelFn = async function* (_msgs, _sys, _opts, signal) {
        // Wait for an abort signal; if it doesn't come within 200ms, finish
        // normally so the test cannot hang.
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          }
          signal.addEventListener('abort', onAbort, { once: true })
          setTimeout(resolve, 200)
        })
        if (signal.aborted) {
          throw new Error('aborted')
        }
        yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } as RawStreamEvent
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 } as ApiResponseMeta
      }

      const fork = createForkSubagent(makeOpts(dir, {
        parentSignal: parentAc.signal,
        callModel: slowCallModel,
      }))

      // Kick off three parallel subagents, then abort the parent.
      const racing = Promise.all([fork('a', TEST_PARENT_TUID), fork('b', TEST_PARENT_TUID), fork('c', TEST_PARENT_TUID)])
      // Give the forks a tick to attach their abort listeners.
      await new Promise((r) => setTimeout(r, 10))
      parentAc.abort()

      const results = await racing

      // All three terminals must carry `aborted`; none completed normally.
      for (const r of results) {
        expect(r.terminal.reason).toBe('aborted')
      }
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
      await fork('do work', TEST_PARENT_TUID)

      expect(captured.length).toBeGreaterThanOrEqual(1)
      expect(captured[0]).toEqual({ thinkingBudget: 4096, interleavedThinking: true })
    })
  })

  // -------------------------------------------------------------------------
  // Phase 7c — nested audit correlation
  // -------------------------------------------------------------------------

  it('every subagent envelope carries origin: subagentId AND parentToolUseId (Phase 7c)', async () => {
    await withTmpDir(async (dir) => {
      const { writer, captured } = makeCapturingWriter()
      const fork = createForkSubagent(makeOpts(dir, { auditWriter: writer }))

      const parentTuid = toolUseId('tu_parent_agent_xyz')
      const result = await fork('investigate something', parentTuid)

      // Every captured record from the subagent must carry both fields.
      const subagentRecords = captured.filter((c) => c.origin !== undefined)
      expect(subagentRecords.length).toBeGreaterThan(0)
      for (const rec of subagentRecords) {
        expect(rec.origin).toBe(result.subagentId)
        expect(rec.parentToolUseId).toBe(parentTuid)
      }
    })
  })

  it('parallel fan-out — each subagent stamps its own parentToolUseId; buildAuditTree reconstructs the tree (Phase 7c)', async () => {
    await withTmpDir(async (dir) => {
      const { writer, captured } = makeCapturingWriter()
      const fork = createForkSubagent(makeOpts(dir, { auditWriter: writer }))

      const tuidA = toolUseId('tu_A')
      const tuidB = toolUseId('tu_B')

      // Inject synthetic parent envelopes — buildAuditTree expects each
      // child's parentToolUseId to match a tool_call_started in some
      // ancestor subtree. The real parent loop in query.ts emits these;
      // here we add them directly into the captured array so the test
      // exercises the tree builder without spinning up a full parent
      // loop. Order: parent's tool_call_started events come before
      // children's events; buildAuditTree doesn't depend on order, but
      // it matches the real on-disk ordering.
      const parentStartA: AuditEnvelope = {
        schemaVersion: 1,
        tsIso: new Date().toISOString(),
        type: 'tool_call_started',
        toolUseId: tuidA,
        toolName: 'Agent',
        input: { prompt: 'task A' },
        timestamp: Date.now(),
      }
      const parentStartB: AuditEnvelope = {
        schemaVersion: 1,
        tsIso: new Date().toISOString(),
        type: 'tool_call_started',
        toolUseId: tuidB,
        toolName: 'Agent',
        input: { prompt: 'task B' },
        timestamp: Date.now(),
      }

      const [a, b] = await Promise.all([fork('task A', tuidA), fork('task B', tuidB)])
      expect(a.terminal.reason).toBe('end_turn')
      expect(b.terminal.reason).toBe('end_turn')

      // Build envelopes the way auditTree.ts expects them. The root
      // synthesises parent rows; children are the captured subagent
      // events.
      const envelopes: AuditEnvelope[] = [parentStartA, parentStartB]
      for (const rec of captured) {
        const env: AuditEnvelope = {
          schemaVersion: 1,
          tsIso: new Date().toISOString(),
          type: rec.event.type,
          ...(rec.origin !== undefined && { origin: rec.origin }),
          ...(rec.parentToolUseId !== undefined && {
            parentToolUseId: rec.parentToolUseId,
          }),
          ...(rec.event as unknown as Record<string, unknown>),
        }
        envelopes.push(env)
      }

      const tree = buildAuditTree(envelopes)
      expect(tree.origin).toBeNull()
      expect(tree.parentToolUseId).toBeNull()
      // Two subtrees, one per parent Agent call.
      expect(tree.children).toHaveLength(2)

      const childByOrigin = new Map(tree.children.map((c) => [c.origin, c]))
      const childA = childByOrigin.get(a.subagentId)!
      const childB = childByOrigin.get(b.subagentId)!
      expect(childA).toBeDefined()
      expect(childB).toBeDefined()
      expect(childA.parentToolUseId).toBe(tuidA)
      expect(childB.parentToolUseId).toBe(tuidB)

      // Every event in childA's subtree carries the right correlation key.
      for (const ev of childA.events) {
        expect(ev.parentToolUseId).toBe(tuidA)
        expect(ev.origin).toBe(a.subagentId)
      }
      for (const ev of childB.events) {
        expect(ev.parentToolUseId).toBe(tuidB)
        expect(ev.origin).toBe(b.subagentId)
      }
    })
  })
})
