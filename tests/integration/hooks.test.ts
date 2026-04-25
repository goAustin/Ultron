/**
 * Integration test: Phase 2b user-configurable hooks.
 *
 * Drives a scripted QueryEngine.submitPrompt with a real hookConfig and asserts
 * audit-log ordering, input mutation, and effective-tool-use attachment zipping.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir, homedir } from 'os'

import { QueryEngine } from '../../src/sdk/QueryEngine.js'
import type { QueryEngineConfig } from '../../src/sdk/QueryEngine.js'
import type { QueryEvent } from '../../src/core/queryEvents.js'
import type { Terminal } from '../../src/core/queryTypes.js'
import type {
  CallModelFn,
  AuthorizeToolUseFn,
  ExecuteToolUseFn,
  GetAttachmentsFn,
  RawStreamEvent,
  ApiResponseMeta,
} from '../../src/core/queryDeps.js'
import { createAuditWriter } from '../../src/audit/auditLog.js'
import type { HookConfig } from '../../src/hooks/types.js'

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/hooks')
const script = (name: string): string => resolve(FIXTURES, name)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-hooks-integ-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function readAuditLines(auditDir: string): Record<string, unknown>[] {
  const file = join(auditDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  const contents = readFileSync(file, 'utf8')
  return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function toolUseThenTextCallModel(input: Record<string, unknown> = { command: 'ls /' }): CallModelFn {
  let turn = 0
  const inputJson = JSON.stringify(input)
  return async function* () {
    turn++
    if (turn === 1) {
      yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu-1', name: 'Bash', input: '' },
      } as RawStreamEvent
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: inputJson },
      } as RawStreamEvent
      yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as RawStreamEvent
      yield { type: 'message_stop' } as RawStreamEvent
      return { stopReason: 'end_turn', inputTokens: 10, outputTokens: 5 } as ApiResponseMeta
    }
    yield { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } } as RawStreamEvent
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason: 'end_turn', inputTokens: 12, outputTokens: 3 } as ApiResponseMeta
  }
}

async function drain(gen: AsyncGenerator<QueryEvent, Terminal>): Promise<Terminal> {
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  return r.value
}

function makeConfig(
  cwd: string,
  auditDir: string,
  hookConfig: HookConfig,
  overrides?: Partial<QueryEngineConfig>,
): QueryEngineConfig {
  return {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    cwd,
    auditWriter: createAuditWriter({ dir: auditDir }),
    hookConfig,
    ...overrides,
  }
}

const allowAuthorize: AuthorizeToolUseFn = async () => ({
  outcome: 'authorized',
  decision: { decision: 'allow', reason: 'auto-allow' },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hooks integration', () => {
  it('block hook: permission_decision → hook_started → hook_finished(block) → tool_result; no tool_call_*', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        const execute: ExecuteToolUseFn = async () => {
          throw new Error('execute must not be called when a pre-hook blocks')
        }

        const hookConfig: HookConfig = {
          schemaVersion: 1,
          hooks: {
            PreToolUse: [{ matcher: 'Bash', command: script('exit-2.sh') }],
            PostToolUse: [],
          },
        }

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, hookConfig, {
            deps: {
              callModel: toolUseThenTextCallModel(),
              authorizeToolUse: allowAuthorize,
              executeToolUse: execute,
            },
          }),
        )
        await drain(engine.submitPrompt('run bash'))
        await (engine as unknown as { auditWriter: { close: () => Promise<void> } }).auditWriter.close()

        const lines = readAuditLines(auditDir)
        const types = lines.map((l) => String(l.type))

        const decisionIdx = types.indexOf('permission_decision')
        const startedIdx = types.indexOf('hook_started')
        const finishedIdx = types.indexOf('hook_finished')
        const resultIdx = types.indexOf('tool_result')

        expect(decisionIdx).toBeGreaterThan(-1)
        expect(startedIdx).toBeGreaterThan(decisionIdx)
        expect(finishedIdx).toBeGreaterThan(startedIdx)
        expect(resultIdx).toBeGreaterThan(finishedIdx)

        // Critical: no execution happened.
        expect(types).not.toContain('tool_call_started')
        expect(types).not.toContain('tool_call_finished')

        const finished = lines.find((l) => l.type === 'hook_finished')
        expect(finished?.outcome).toBe('block')
        expect(finished?.decisionReason).toBe('denied')
      })
    })
  })

  it('mutation hook: tool_call_started.input reflects the mutated value', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        const seen: Array<Record<string, unknown>> = []
        const execute: ExecuteToolUseFn = async (toolUse) => {
          seen.push(toolUse.input)
          return { content: 'ran', isError: false }
        }

        const hookConfig: HookConfig = {
          schemaVersion: 1,
          hooks: {
            PreToolUse: [{ matcher: 'Bash', command: script('mutate-input.sh') }],
            PostToolUse: [],
          },
        }

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, hookConfig, {
            deps: {
              callModel: toolUseThenTextCallModel({ command: 'ls /', original: true }),
              authorizeToolUse: allowAuthorize,
              executeToolUse: execute,
            },
          }),
        )
        await drain(engine.submitPrompt('run bash'))
        await (engine as unknown as { auditWriter: { close: () => Promise<void> } }).auditWriter.close()

        // The tool saw the mutated input.
        expect(seen).toEqual([{ foo: 'bar' }])

        // The on-disk tool_call_started reflects the mutated input too.
        const lines = readAuditLines(auditDir)
        const started = lines.find((l) => l.type === 'tool_call_started')
        expect(started?.input).toEqual({ foo: 'bar' })
      })
    })
  })

  it('effective-tool-use zipping: getAttachments receives mutated input', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        const capturedExecutions: Array<{ toolUse: unknown; result: unknown }> = []
        const getAttachments: GetAttachmentsFn = async (executions) => {
          for (const e of executions) capturedExecutions.push({ toolUse: e.toolUse, result: e.result })
          return []
        }

        const hookConfig: HookConfig = {
          schemaVersion: 1,
          hooks: {
            PreToolUse: [{ matcher: 'Bash', command: script('mutate-input.sh') }],
            PostToolUse: [],
          },
        }

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, hookConfig, {
            deps: {
              callModel: toolUseThenTextCallModel({ command: 'ls /', original: true }),
              authorizeToolUse: allowAuthorize,
              executeToolUse: async () => ({ content: 'ran', isError: false }),
              getAttachments,
            },
          }),
        )
        await drain(engine.submitPrompt('run bash'))

        expect(capturedExecutions).toHaveLength(1)
        const tu = capturedExecutions[0]!.toolUse as { input: Record<string, unknown> }
        // The effective-tool-use that went into attachments is the hook-mutated
        // one, NOT the original { command: 'ls /', original: true }.
        expect(tu.input).toEqual({ foo: 'bar' })
      })
    })
  })

  it('post hook appends additionalContext to tool result content', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        const hookConfig: HookConfig = {
          schemaVersion: 1,
          hooks: {
            PreToolUse: [],
            PostToolUse: [{ matcher: '*', command: script('post-additional-context.sh') }],
          },
        }

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, hookConfig, {
            deps: {
              callModel: toolUseThenTextCallModel(),
              authorizeToolUse: allowAuthorize,
              executeToolUse: async () => ({ content: 'orig', isError: false }),
            },
          }),
        )
        await drain(engine.submitPrompt('run bash'))
        await (engine as unknown as { auditWriter: { close: () => Promise<void> } }).auditWriter.close()

        const lines = readAuditLines(auditDir)
        const finished = lines.find((l) => l.type === 'tool_call_finished')
        expect(finished?.resultPreview).toBe('orig\n\nnote')
      })
    })
  })

  it('never touches ~/.ultron when hookConfig + auditWriter are injected', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        const homeAuditFile = join(homedir(), '.ultron', 'audit.jsonl')
        const homeHooksFile = join(homedir(), '.ultron', 'hooks.json')
        const auditSizeBefore = existsSync(homeAuditFile) ? statSync(homeAuditFile).size : 0
        const hooksMtimeBefore = existsSync(homeHooksFile) ? statSync(homeHooksFile).mtimeMs : null

        const hookConfig: HookConfig = {
          schemaVersion: 1,
          hooks: { PreToolUse: [], PostToolUse: [] },
        }

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, hookConfig, {
            deps: {
              callModel: toolUseThenTextCallModel(),
              authorizeToolUse: allowAuthorize,
              executeToolUse: async () => ({ content: 'ok', isError: false }),
            },
          }),
        )
        await drain(engine.submitPrompt('hello'))
        await (engine as unknown as { auditWriter: { close: () => Promise<void> } }).auditWriter.close()

        const auditSizeAfter = existsSync(homeAuditFile) ? statSync(homeAuditFile).size : 0
        const hooksMtimeAfter = existsSync(homeHooksFile) ? statSync(homeHooksFile).mtimeMs : null
        expect(auditSizeAfter).toBe(auditSizeBefore)
        expect(hooksMtimeAfter).toBe(hooksMtimeBefore)
      })
    })
  })
})
