/**
 * Integration test: Phase 4b memory tools.
 *
 * Drives scripted QueryEngine.submitPrompt turns through the real
 * permission cascade + audit spine, asserting that memory tools:
 *  - write entries to disk with the expected perms + metadata-only audit
 *  - get denied by memorySecretSafetyCheck on high-confidence secrets
 *    without ever invoking askUser or the store
 *  - get asked by memorySecretSafetyCheck on low-confidence secrets and
 *    proceed to the store write when the user allows
 *  - read list entries via MemoryRead and surface them in tool_result
 *  - round-trip via MemoryEdit with createdAt preserved and two audit
 *    rows (isNew true, then false)
 */

import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { QueryEngine } from '../../src/sdk/QueryEngine.js'
import type { QueryEngineConfig } from '../../src/sdk/QueryEngine.js'
import type { QueryEvent } from '../../src/core/queryEvents.js'
import type { Terminal } from '../../src/core/queryTypes.js'
import type {
  CallModelFn,
  RawStreamEvent,
  ApiResponseMeta,
} from '../../src/core/queryDeps.js'
import { createAuditWriter } from '../../src/audit/auditLog.js'
import type { AskUserFn } from '../../src/core/permissions/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-memtools-integ-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function readAuditLines(auditDir: string): Record<string, unknown>[] {
  const file = join(auditDir, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function drain(gen: AsyncGenerator<QueryEvent, Terminal>): Promise<Terminal> {
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  return r.value
}

/**
 * Scripted model: first turn emits one tool_use for `toolName` with the
 * given JSON input; second turn emits a short text body + end_turn.
 */
function toolUseThenText(toolName: string, input: Record<string, unknown>): CallModelFn {
  let turn = 0
  const inputJson = JSON.stringify(input)
  return async function* () {
    turn++
    if (turn === 1) {
      yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `tu-${turn}`, name: toolName, input: '' },
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

/**
 * Scripted model: two tool_use turns (different ids), then a text turn.
 */
function twoToolUsesThenText(
  first: { toolName: string; input: Record<string, unknown> },
  second: { toolName: string; input: Record<string, unknown> },
): CallModelFn {
  let turn = 0
  return async function* () {
    turn++
    if (turn === 1 || turn === 2) {
      const { toolName, input } = turn === 1 ? first : second
      const inputJson = JSON.stringify(input)
      yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `tu-${turn}`, name: toolName, input: '' },
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

function makeConfig(
  cwd: string,
  auditDir: string,
  memoryBaseDir: string,
  callModel: CallModelFn,
  overrides?: Partial<QueryEngineConfig>,
): QueryEngineConfig {
  return {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    cwd,
    auditWriter: createAuditWriter({ dir: auditDir }),
    memoryBaseDir,
    permissionMode: 'acceptEdits',
    deps: { callModel },
    ...overrides,
  }
}

async function closeEngineAudit(engine: QueryEngine): Promise<void> {
  await (
    engine as unknown as { auditWriter: { close: () => Promise<void> } }
  ).auditWriter.close()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('memory tools integration', () => {
  it('MemoryWrite happy path: entry on disk + one metadata-only audit row', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        await withTmpDir(async (memDir) => {
          const callModel = toolUseThenText('MemoryWrite', {
            id: 'profile',
            type: 'user',
            name: 'Profile',
            description: 'user prefs',
            content: 'I like tabs.',
          })
          const engine = new QueryEngine(
            makeConfig(cwd, auditDir, memDir, callModel),
          )
          await drain(engine.submitPrompt('save preference'))
          await closeEngineAudit(engine)

          const entryPath = join(memDir, 'memory', 'profile.md')
          expect(existsSync(entryPath)).toBe(true)
          expect(statSync(entryPath).mode & 0o777).toBe(0o600)

          const lines = readAuditLines(auditDir)
          const writes = lines.filter((l) => l.type === 'memory_entry_written')
          expect(writes).toHaveLength(1)
          const ev = writes[0]
          expect(ev.id).toBe('profile')
          expect(ev.entryType).toBe('user')
          expect(ev.name).toBe('Profile')
          expect(ev.isNew).toBe(true)
          expect(typeof ev.bytes).toBe('number')
          // No body content leaks into the audit row
          expect(JSON.stringify(ev)).not.toContain('I like tabs.')

          // tool_call_started + tool_call_finished both appear for MemoryWrite
          const toolEvents = lines.filter(
            (l) =>
              (l.type === 'tool_call_started' ||
                l.type === 'tool_call_finished') &&
              l.toolName === 'MemoryWrite',
          )
          expect(toolEvents.length).toBeGreaterThanOrEqual(2)
        })
      })
    })
  })

  it('MemoryWrite with high-confidence secret: safety check denies without invoking askUser', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        await withTmpDir(async (memDir) => {
          let askUserCalled = 0
          const askUser: AskUserFn = async () => {
            askUserCalled++
            return 'allow_once'
          }
          const callModel = toolUseThenText('MemoryWrite', {
            id: 'profile',
            type: 'user',
            name: 'Profile',
            description: 'user prefs',
            content: 'key: AKIAIOSFODNN7EXAMPLE',
          })
          const engine = new QueryEngine(
            makeConfig(cwd, auditDir, memDir, callModel, {
              permissionMode: 'default',
              askUser,
            }),
          )
          await drain(engine.submitPrompt('save preference'))
          await closeEngineAudit(engine)

          expect(askUserCalled).toBe(0)
          const entryPath = join(memDir, 'memory', 'profile.md')
          expect(existsSync(entryPath)).toBe(false)

          const lines = readAuditLines(auditDir)
          expect(
            lines.filter((l) => l.type === 'memory_entry_written'),
          ).toHaveLength(0)
          const decision = lines.find(
            (l) =>
              l.type === 'permission_decision' && l.toolName === 'MemoryWrite',
          )
          expect(decision).toBeDefined()
          expect(decision!.decision).toBe('deny')
        })
      })
    })
  })

  it('MemoryWrite with low-confidence secret: askUser allow_once → store succeeds', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        await withTmpDir(async (memDir) => {
          let askUserCalled = 0
          let askUserMessage = ''
          const askUser: AskUserFn = async (_tool, _input, reason) => {
            askUserCalled++
            askUserMessage = reason
            return 'allow_once'
          }
          const callModel = toolUseThenText('MemoryWrite', {
            id: 'profile',
            type: 'user',
            name: 'Profile',
            description: 'user prefs',
            content: 'password = "s3cretPassword12345"',
          })
          const engine = new QueryEngine(
            makeConfig(cwd, auditDir, memDir, callModel, {
              permissionMode: 'default',
              askUser,
            }),
          )
          await drain(engine.submitPrompt('save preference'))
          await closeEngineAudit(engine)

          expect(askUserCalled).toBe(1)
          expect(askUserMessage).toContain('potential secrets')

          const entryPath = join(memDir, 'memory', 'profile.md')
          expect(existsSync(entryPath)).toBe(true)

          const lines = readAuditLines(auditDir)
          expect(
            lines.filter((l) => l.type === 'memory_entry_written'),
          ).toHaveLength(1)
          const decision = lines.find(
            (l) =>
              l.type === 'permission_decision' && l.toolName === 'MemoryWrite',
          )
          expect(decision).toBeDefined()
          expect(decision!.userResponse).toBe('allow_once')
        })
      })
    })
  })

  it('MemoryRead list shows a previously written entry', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        await withTmpDir(async (memDir) => {
          const callModel = twoToolUsesThenText(
            {
              toolName: 'MemoryWrite',
              input: {
                id: 'profile',
                type: 'user',
                name: 'Profile',
                description: 'user prefs',
                content: 'I like tabs.',
              },
            },
            { toolName: 'MemoryRead', input: { mode: 'list' } },
          )
          const engine = new QueryEngine(
            makeConfig(cwd, auditDir, memDir, callModel),
          )

          const toolResults: string[] = []
          const gen = engine.submitPrompt('save + list')
          for await (const ev of gen) {
            if (
              ev.type === 'tool_call_finished' &&
              ev.toolName === 'MemoryRead'
            ) {
              toolResults.push(ev.resultPreview)
            }
          }
          await closeEngineAudit(engine)

          expect(toolResults.length).toBeGreaterThan(0)
          expect(toolResults.join('\n')).toContain('Profile')
        })
      })
    })
  })

  it('MemoryEdit round-trip: createdAt preserved; two audit rows (isNew true, then false)', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        await withTmpDir(async (memDir) => {
          const callModel = twoToolUsesThenText(
            {
              toolName: 'MemoryWrite',
              input: {
                id: 'profile',
                type: 'user',
                name: 'Profile',
                description: 'user prefs',
                content: 'hello foo world',
              },
            },
            {
              toolName: 'MemoryEdit',
              input: {
                id: 'profile',
                old_string: 'foo',
                new_string: 'bar',
              },
            },
          )
          const engine = new QueryEngine(
            makeConfig(cwd, auditDir, memDir, callModel),
          )
          await drain(engine.submitPrompt('write then edit'))
          await closeEngineAudit(engine)

          const entryPath = join(memDir, 'memory', 'profile.md')
          const body = readFileSync(entryPath, 'utf8')
          expect(body).toContain('hello bar world')
          expect(body).not.toContain('hello foo world')

          const lines = readAuditLines(auditDir)
          const writes = lines
            .filter((l) => l.type === 'memory_entry_written')
            .map((l) => ({ id: l.id, isNew: l.isNew }))
          expect(writes).toEqual([
            { id: 'profile', isNew: true },
            { id: 'profile', isNew: false },
          ])
        })
      })
    })
  })

  it('MemoryEdit on missing id: execution_error tool result; no audit write', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (auditDir) => {
        await withTmpDir(async (memDir) => {
          const callModel = toolUseThenText('MemoryEdit', {
            id: 'ghost',
            content: 'anything',
          })
          const engine = new QueryEngine(
            makeConfig(cwd, auditDir, memDir, callModel),
          )

          const toolResults: { outcome: string; resultPreview: string }[] = []
          const gen = engine.submitPrompt('edit missing')
          for await (const ev of gen) {
            if (
              ev.type === 'tool_call_finished' &&
              ev.toolName === 'MemoryEdit'
            ) {
              toolResults.push({
                outcome: ev.outcome,
                resultPreview: ev.resultPreview,
              })
            }
          }
          await closeEngineAudit(engine)

          expect(toolResults).toHaveLength(1)
          expect(toolResults[0].outcome).toBe('error')
          expect(toolResults[0].resultPreview).toContain('does not exist')

          const lines = readAuditLines(auditDir)
          expect(
            lines.filter((l) => l.type === 'memory_entry_written'),
          ).toHaveLength(0)
        })
      })
    })
  })
})
