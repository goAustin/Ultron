/**
 * Integration test: audit spine end-to-end.
 *
 * Drives a scripted QueryEngine.submitPrompt through the full pipeline and
 * asserts on-disk JSONL lines, ordering invariants, redaction, and rotation.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

import { QueryEngine } from '../../src/sdk/QueryEngine.js'
import type { QueryEngineConfig } from '../../src/sdk/QueryEngine.js'
import type { QueryEvent } from '../../src/core/queryEvents.js'
import type { Terminal } from '../../src/core/queryTypes.js'
import type {
  CallModelFn,
  AuthorizeToolUseFn,
  ExecuteToolUseFn,
  RawStreamEvent,
  ApiResponseMeta,
} from '../../src/core/queryDeps.js'
import { createAuditWriter } from '../../src/audit/auditLog.js'
import {
  makeToolCallStartedEvent,
  makeToolCallFinishedEvent,
} from '../../src/core/queryEventFactories.js'
import { toolUseId } from '../../src/core/messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-audit-integ-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function readAuditLines(auditDir: string): Record<string, unknown>[] {
  const file = join(auditDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  const contents = readFileSync(file, 'utf8')
  return contents.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Synthesize a scripted stream that announces one tool_use block then ends. */
function toolUseThenTextCallModel(): CallModelFn {
  let turn = 0
  return async function* () {
    turn++
    if (turn === 1) {
      yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu-1', name: 'Echo', input: '' },
      } as RawStreamEvent
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"msg":"hi"}' },
      } as RawStreamEvent
      yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as RawStreamEvent
      yield { type: 'message_stop' } as RawStreamEvent
      return { stopReason: 'end_turn', inputTokens: 10, outputTokens: 5 } as ApiResponseMeta
    }
    // Turn 2 — plain text closing the loop
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
  overrides?: Partial<QueryEngineConfig>,
): QueryEngineConfig {
  return {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    cwd,
    auditWriter: createAuditWriter({ dir: auditDir }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit spine integration', () => {
  it('end-to-end auto-allow: writes permission_decision → tool_call_started → tool_result → tool_call_finished', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        const authorize: AuthorizeToolUseFn = async () => ({
          outcome: 'authorized',
          decision: { decision: 'allow', reason: 'auto-allow' },
        })
        const execute: ExecuteToolUseFn = async () => ({ content: 'ok', isError: false })

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            deps: {
              callModel: toolUseThenTextCallModel(),
              authorizeToolUse: authorize,
              executeToolUse: execute,
            },
          }),
        )
        const terminal = await drain(engine.submitPrompt('do the thing'))
        expect(terminal.reason).toBe('end_turn')

        // Let the audit writer finish draining.
        await (engine as unknown as { auditWriter: { close: () => Promise<void> } }).auditWriter.close()

        const lines = readAuditLines(auditDir)
        const types = lines.map(l => String(l.type))

        // Event filter: no text_delta, no thinking_delta, no tool_use_start
        expect(types).not.toContain('text_delta')
        expect(types).not.toContain('thinking_delta')
        expect(types).not.toContain('tool_use_start')

        // Ordering around the tool call for tu-1
        const decisionIdx = types.indexOf('permission_decision')
        const startedIdx = types.indexOf('tool_call_started')
        const finishedIdx = types.indexOf('tool_call_finished')
        const resultIdx = types.indexOf('tool_result')

        expect(decisionIdx).toBeGreaterThan(-1)
        expect(startedIdx).toBeGreaterThan(decisionIdx)
        expect(finishedIdx).toBeGreaterThan(startedIdx)
        expect(resultIdx).toBeGreaterThan(startedIdx)
      })
    })
  })

  it('deny path: no tool_call_started / tool_call_finished lands on disk', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        const authorize: AuthorizeToolUseFn = async () => ({
          outcome: 'denied',
          decision: { decision: 'deny', reason: 'policy' },
          syntheticResult: {
            content: '[permission_denied] policy',
            isError: true,
            errorKind: 'permission_denied',
          },
        })
        const execute: ExecuteToolUseFn = async () => {
          throw new Error('execute must not be called on deny')
        }

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            deps: {
              callModel: toolUseThenTextCallModel(),
              authorizeToolUse: authorize,
              executeToolUse: execute,
            },
          }),
        )
        await drain(engine.submitPrompt('do the thing'))
        await (engine as unknown as { auditWriter: { close: () => Promise<void> } }).auditWriter.close()

        const lines = readAuditLines(auditDir)
        const types = lines.map(l => String(l.type))

        expect(types).toContain('permission_decision')
        expect(types).toContain('tool_result')
        expect(types).not.toContain('tool_call_started')
        expect(types).not.toContain('tool_call_finished')

        const decision = lines.find(l => l.type === 'permission_decision')
        expect(decision?.decision).toBe('deny')
      })
    })
  })

  it('never touches ~/.ultron when auditWriter is injected', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        const homeAuditFile = join(homedir(), '.ultron', 'audit.jsonl')
        const sizeBefore = existsSync(homeAuditFile) ? statSync(homeAuditFile).size : 0

        const authorize: AuthorizeToolUseFn = async () => ({
          outcome: 'authorized',
          decision: { decision: 'allow', reason: 'ok' },
        })
        const execute: ExecuteToolUseFn = async () => ({ content: 'ok', isError: false })

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            deps: {
              callModel: toolUseThenTextCallModel(),
              authorizeToolUse: authorize,
              executeToolUse: execute,
            },
          }),
        )
        await drain(engine.submitPrompt('hello'))
        await (engine as unknown as { auditWriter: { close: () => Promise<void> } }).auditWriter.close()

        const sizeAfter = existsSync(homeAuditFile) ? statSync(homeAuditFile).size : 0
        expect(sizeAfter).toBe(sizeBefore)
      })
    })
  })

  it('precondition failures do NOT emit a permission_decision event', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        const authorize: AuthorizeToolUseFn = async () => ({
          outcome: 'precondition_failed',
          syntheticResult: {
            content: '[validation_failed] missing input',
            isError: true,
            errorKind: 'validation_failed',
          },
        })
        const execute: ExecuteToolUseFn = async () => {
          throw new Error('execute must not be called on precondition_failed')
        }

        const engine = new QueryEngine(
          makeConfig(cwd, auditDir, {
            deps: {
              callModel: toolUseThenTextCallModel(),
              authorizeToolUse: authorize,
              executeToolUse: execute,
            },
          }),
        )
        await drain(engine.submitPrompt('bad input'))
        await (engine as unknown as { auditWriter: { close: () => Promise<void> } }).auditWriter.close()

        const lines = readAuditLines(auditDir)
        const types = lines.map(l => String(l.type))

        // Precondition failure surfaces ONLY as a tool_result; not as a policy event.
        expect(types).not.toContain('permission_decision')
        expect(types).not.toContain('tool_call_started')
        expect(types).not.toContain('tool_call_finished')
        expect(types).toContain('tool_result')
      })
    })
  })

  it('real-I/O rotation at 1 MB cap', async () => {
    await withTmpDir(async (auditDir) => {
      const writer = createAuditWriter({ dir: auditDir, maxBytes: 1024 * 1024, keep: 3 })
      const tu = { type: 'tool_use' as const, id: toolUseId('tu-1'), name: 'Bulk', input: { blob: 'a'.repeat(4000) } }

      // Each event is ~4.5KB after serialization; 300 iterations ≈ 1.35MB → triggers rotation.
      for (let i = 0; i < 300; i++) {
        writer.write(makeToolCallStartedEvent(tu))
        writer.write(makeToolCallFinishedEvent(tu, { content: 'ok', isError: false }, 1))
      }
      await writer.close()

      const files = readdirSync(auditDir).filter(f => f.startsWith('audit.jsonl'))
      expect(files).toContain('audit.jsonl')
      expect(files).toContain('audit.jsonl.1')

      const freshSize = statSync(join(auditDir, 'audit.jsonl')).size
      expect(freshSize).toBeLessThan(1024 * 1024)
    })
  })
})
