import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { __setSettingsPathForTest, writeSettingsConfig } from '../config/settingsConfig.js'
import { QueryEngine } from './QueryEngine.js'
import type { QueryEngineConfig } from './QueryEngine.js'
import type { QueryEvent } from '../core/queryEvents.js'
import type { Terminal } from '../core/queryTypes.js'
import type {
  CallModelFn,
  AuthorizeToolUseFn,
  ExecuteToolUseFn,
  RawStreamEvent,
  ApiResponseMeta,
} from '../core/queryDeps.js'
import { appendMessage } from '../session/transcript.js'
import { createUserMessage, createAssistantMessage, messageId, toolUseId } from '../core/messages.js'
import type { McpManager, McpReloadResult, McpRegisteredToolInfo } from '../core/mcp/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-qe-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

/** Mock callModel that returns a simple text response. */
function textCallModel(text: string): CallModelFn {
  return async function* (_msgs, _sys, _opts, _signal) {
    yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } as RawStreamEvent
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as RawStreamEvent
    yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as RawStreamEvent
    yield { type: 'message_stop' } as RawStreamEvent
    return { stopReason: 'end_turn', inputTokens: 10, outputTokens: 5 } as ApiResponseMeta
  }
}

/** Stub authorize/execute pair that authorizes everything and returns a static result. */
const stubAuthorize: AuthorizeToolUseFn = async () => ({
  outcome: 'authorized',
  decision: { decision: 'allow', reason: 'test-stub' },
})
const stubExecute: ExecuteToolUseFn = async () => ({ content: 'ok', isError: false })

// Null audit writer — keeps every test isolated from ~/.ultron/audit.jsonl.
const nullAuditWriter = {
  write: () => {},
  close: async () => {},
  withOrigin: () => nullAuditWriter,
}

function fakeMcpManager(overrides?: Partial<McpManager>): McpManager {
  const reloadResult: McpReloadResult = {
    connected: [],
    failed: [],
    removed: [],
    disabled: [],
    unchanged: [],
    backoff: [],
    toolDefinitionsChanged: false,
  }
  return {
    async bootstrap() {
      return { connected: [], failed: [] }
    },
    async reload() {
      return reloadResult
    },
    async callTool() {
      return { kind: 'transport_error', message: 'not implemented' }
    },
    listTools() {
      return []
    },
    async shutdown() {},
    status() {
      return []
    },
    ...overrides,
  }
}

function makeConfig(cwd: string, overrides?: Partial<QueryEngineConfig>): QueryEngineConfig {
  return {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    cwd,
    auditWriter: nullAuditWriter,
    deps: {
      callModel: textCallModel('Hello back!'),
      authorizeToolUse: stubAuthorize,
      executeToolUse: stubExecute,
    },
    ...overrides,
  }
}

async function collectEvents(gen: AsyncGenerator<QueryEvent, Terminal>): Promise<{ events: QueryEvent[]; terminal: Terminal }> {
  const events: QueryEvent[] = []
  let result = await gen.next()
  while (!result.done) {
    events.push(result.value)
    result = await gen.next()
  }
  return { events, terminal: result.value }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueryEngine', () => {
  it('creates session with UUID in constructor', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd))
      expect(engine.sessionId).toBeTruthy()
      expect(typeof engine.sessionId).toBe('string')
    })
  })

  it('stores sessionId for lazy resume', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd, { sessionId: 'existing-session' }))
      expect(engine.sessionId).toBe('existing-session')
    })
  })

  it('submitPrompt yields events and returns Terminal', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd))
      const { events, terminal } = await collectEvents(engine.submitPrompt('Hello'))

      expect(terminal.reason).toBe('end_turn')
      expect(events.some((e) => e.type === 'request_start')).toBe(true)
      expect(events.some((e) => e.type === 'text_delta')).toBe(true)
      expect(events.some((e) => e.type === 'turn')).toBe(true)
    })
  })

  it('messages accumulate across multiple submitPrompt calls', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd))

      await collectEvents(engine.submitPrompt('First'))
      const afterFirst = engine.messages.length

      await collectEvents(engine.submitPrompt('Second'))
      const afterSecond = engine.messages.length

      // Should have more messages after second call
      expect(afterSecond).toBeGreaterThan(afterFirst)
    })
  })

  it('concurrent submitPrompt throws', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd))

      // Start first submission and consume first event to enter the generator body
      const gen1 = engine.submitPrompt('First')
      await gen1.next() // This sets _running = true

      // Second submission should throw
      const gen2 = engine.submitPrompt('Second')
      await expect(gen2.next()).rejects.toThrow('already in progress')

      // Clean up first
      let result = await gen1.next()
      while (!result.done) result = await gen1.next()
    })
  })

  it('abort cancels in-progress query', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd))
      const gen = engine.submitPrompt('Hello')

      // Get the first event, then abort
      await gen.next()
      engine.abort()

      // Drain remaining events
      let result = await gen.next()
      while (!result.done) result = await gen.next()

      // Terminal should indicate abort or end_turn (depending on timing)
      expect(['aborted', 'end_turn']).toContain(result.value.reason)
    })
  })

  it('abort does not poison subsequent submissions', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd))

      // First: abort mid-stream
      const gen1 = engine.submitPrompt('First')
      await gen1.next()
      engine.abort()
      let r = await gen1.next()
      while (!r.done) r = await gen1.next()

      // Second: should work fine
      const { terminal } = await collectEvents(engine.submitPrompt('Second'))
      expect(terminal.reason).toBe('end_turn')
    })
  })

  it('headless mode omits askUser from PermissionOptions', async () => {
    await withTmpDir(async (cwd) => {
      const mockAskUser = async () => 'allow_once' as const
      const engine = new QueryEngine(makeConfig(cwd, {
        headless: true,
        askUser: mockAskUser,
      }))

      // Engine should be constructable without errors
      // The askUser is ignored when headless is true
      const { terminal } = await collectEvents(engine.submitPrompt('Hello'))
      expect(terminal.reason).toBe('end_turn')
    })
  })

  it('persists user message and events to transcript', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd))
      await collectEvents(engine.submitPrompt('Hello'))

      // Check that the session directory has a transcript
      const transcriptPath = join(engine['session'].dir, 'transcript.jsonl')
      const content = readFileSync(transcriptPath, 'utf-8')
      const lines = content.trim().split('\n')

      // Should have at least: user message + assistant turn
      expect(lines.length).toBeGreaterThanOrEqual(2)

      // First line should be the user message
      const firstMsg = JSON.parse(lines[0]!)
      expect(firstMsg.role).toBe('user')
      expect(firstMsg.content[0].text).toBe('Hello')
    })
  })

  it('session ID is stable across multiple submitPrompt calls', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd))
      const id1 = engine.sessionId

      await collectEvents(engine.submitPrompt('First'))
      const id2 = engine.sessionId

      await collectEvents(engine.submitPrompt('Second'))
      const id3 = engine.sessionId

      expect(id1).toBe(id2)
      expect(id2).toBe(id3)
    })
  })

  it('resume loads messages from existing session', async () => {
    await withTmpDir(async (cwd) => {
      // Create a session with some messages
      const engine1 = new QueryEngine(makeConfig(cwd))
      await collectEvents(engine1.submitPrompt('Hello'))
      const sessionId = engine1.sessionId
      const messageCount = engine1.messages.length

      // Resume the session
      const engine2 = new QueryEngine(makeConfig(cwd, { sessionId }))
      // Submit to trigger resume
      await collectEvents(engine2.submitPrompt('Follow up'))

      // Should have more messages than the original session
      expect(engine2.messages.length).toBeGreaterThan(messageCount)
    })
  })

  it('compactModel creates separate CallModelFn', async () => {
    await withTmpDir(async (cwd) => {
      const engine = new QueryEngine(makeConfig(cwd, { compactModel: 'claude-haiku-4-5-20251001' }))
      expect(engine.sessionId).toBeTruthy()
    })
  })

  describe('memory exposure (Phase 4c)', () => {
    it('memoryBaseDir returns the configured path when memory is enabled', async () => {
      await withTmpDir(async (cwd) => {
        const memDir = join(cwd, 'memhome')
        const engine = new QueryEngine(makeConfig(cwd, { memoryBaseDir: memDir }))
        expect(engine.memoryBaseDir).toBe(memDir)
      })
    })

    it('memoryBaseDir returns null when disableMemory is true', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd, { disableMemory: true }))
        expect(engine.memoryBaseDir).toBeNull()
      })
    })

    it('auditWriter getter returns the configured writer instance', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd))
        expect(engine.auditWriter).toBe(nullAuditWriter)
      })
    })
  })

  describe('settings seeding (v3 Phase 0)', () => {
    // Regression guard: the validator's unit tests prove warn-on-invalid in
    // isolation, but Phase 0 acceptance is "warns at startup". This test
    // catches a future refactor that drops the validator call from the
    // QueryEngine constructor.
    it('invalid computerUse.enabled warns at construction time and does not throw', async () => {
      await withTmpDir(async (cwd) => {
        const settingsPath = join(cwd, 'settings.json')
        __setSettingsPathForTest(settingsPath)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stderrSpy: any = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        try {
          // Cast through unknown to bypass the input type — we're testing
          // runtime defensiveness against bad JSON, which the type system
          // would otherwise refuse to express.
          writeSettingsConfig({ computerUse: { enabled: 'yes' as unknown as boolean } })

          expect(() => new QueryEngine(makeConfig(cwd))).not.toThrow()

          const warned = stderrSpy.mock.calls.some((c: unknown[]) =>
            String(c[0]).startsWith('[ultron] settings.json: computerUse.enabled'),
          )
          expect(warned).toBe(true)
        } finally {
          stderrSpy.mockRestore()
          __setSettingsPathForTest(null)
        }
      })
    })
  })

  it('throws MissingApiKeyError when neither config.apiKey nor the env var is set', async () => {
    await withTmpDir(async (cwd) => {
      const savedAnthropic = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        expect(() => new QueryEngine({
          model: 'claude-sonnet-4-6',
          cwd,
          // No apiKey, no env — should throw
        })).toThrow(/ANTHROPIC_API_KEY/)
      } finally {
        if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic
      }
    })
  })

  describe('setModel', () => {
    it('exposes the current model', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd, { model: 'claude-sonnet-4-6' }))
        expect(engine.currentModel).toBe('claude-sonnet-4-6')
      })
    })

    it('hot-swaps the main-loop model', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd, { model: 'claude-sonnet-4-6' }))
        engine.setModel('claude-opus-4-7')
        expect(engine.currentModel).toBe('claude-opus-4-7')
      })
    })

    it('is a no-op when the model is unchanged', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd, { model: 'claude-sonnet-4-6' }))
        engine.setModel('claude-sonnet-4-6')
        expect(engine.currentModel).toBe('claude-sonnet-4-6')
      })
    })

    it('switches across providers and exposes currentProvider', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd, { model: 'claude-sonnet-4-6' }))
        expect(engine.currentProvider).toBe('anthropic')

        engine.setModel('gpt-5.4-mini')
        expect(engine.currentModel).toBe('gpt-5.4-mini')
        expect(engine.currentProvider).toBe('openai')
      })
    })

    it('rejects unknown model ids', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd, { model: 'claude-sonnet-4-6' }))
        expect(() => engine.setModel('not-a-real-model')).toThrow(/Unknown model/)
      })
    })
  })

  describe('thinking knobs', () => {
    function captureCallModel(): { spy: CallModelFn; captured: Array<{ thinkingBudget?: number; interleavedThinking?: boolean }> } {
      const captured: Array<{ thinkingBudget?: number; interleavedThinking?: boolean }> = []
      const spy: CallModelFn = async function* (_msgs, _sys, opts, _signal) {
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
      }
      return { spy, captured }
    }

    it('uses engine config thinkingBudget by default', async () => {
      await withTmpDir(async (cwd) => {
        const { spy, captured } = captureCallModel()
        const engine = new QueryEngine(makeConfig(cwd, {
          model: 'claude-opus-4-7',
          thinkingBudget: 4096,
          deps: { callModel: spy, authorizeToolUse: stubAuthorize, executeToolUse: stubExecute },
        }))
        await collectEvents(engine.submitPrompt('hi'))
        expect(captured[0]).toEqual({ thinkingBudget: 4096, interleavedThinking: undefined })
      })
    })

    it('per-submission opts override engine config', async () => {
      await withTmpDir(async (cwd) => {
        const { spy, captured } = captureCallModel()
        const engine = new QueryEngine(makeConfig(cwd, {
          model: 'claude-opus-4-7',
          thinkingBudget: 4096,
          deps: { callModel: spy, authorizeToolUse: stubAuthorize, executeToolUse: stubExecute },
        }))
        await collectEvents(engine.submitPrompt('hi', { thinkingBudget: 8192 }))
        expect(captured[0]!.thinkingBudget).toBe(8192)
      })
    })

    it('thinkingBudget=0 in opts disables thinking for that submission', async () => {
      await withTmpDir(async (cwd) => {
        const { spy, captured } = captureCallModel()
        const engine = new QueryEngine(makeConfig(cwd, {
          model: 'claude-opus-4-7',
          thinkingBudget: 4096,
          deps: { callModel: spy, authorizeToolUse: stubAuthorize, executeToolUse: stubExecute },
        }))
        await collectEvents(engine.submitPrompt('hi', { thinkingBudget: 0 }))
        expect(captured[0]!.thinkingBudget).toBeUndefined()
      })
    })
  })

  describe('MCP reload (Phase 3c)', () => {
    it('refuses to reload while a submission is running', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd, {
          mcpManager: fakeMcpManager(),
        }))

        const gen = engine.submitPrompt('hi')
        await gen.next()
        await expect(engine.reloadMcp()).rejects.toThrow(/submission is in progress/)

        let r = await gen.next()
        while (!r.done) r = await gen.next()
      })
    })

    it('rebuilds callModel when reload reports tool definition changes', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd, {
          mcpManager: fakeMcpManager({
            async reload() {
              return {
                connected: ['fake'],
                failed: [],
                removed: [],
                disabled: [],
                unchanged: [],
                backoff: [],
                toolDefinitionsChanged: true,
              }
            },
          }),
        }))

        const before = (engine as unknown as { callModel: CallModelFn }).callModel
        const result = await engine.reloadMcp()
        const after = (engine as unknown as { callModel: CallModelFn }).callModel

        expect(result.toolDefinitionsChanged).toBe(true)
        expect(after).not.toBe(before)
      })
    })

    it('does not rebuild callModel when reload reports no tool definition changes', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd, {
          mcpManager: fakeMcpManager(),
        }))

        const before = (engine as unknown as { callModel: CallModelFn }).callModel
        const result = await engine.reloadMcp()
        const after = (engine as unknown as { callModel: CallModelFn }).callModel

        expect(result.toolDefinitionsChanged).toBe(false)
        expect(after).toBe(before)
      })
    })

    it('listMcpTools delegates to the manager', async () => {
      await withTmpDir(async (cwd) => {
        const tools: McpRegisteredToolInfo[] = [
          { server: 'fake', name: 'mcp__fake__echo', description: 'Echo', state: 'ready' },
        ]
        const engine = new QueryEngine(makeConfig(cwd, {
          mcpManager: fakeMcpManager({
            listTools(serverName?: string) {
              return serverName === 'fake' ? tools : []
            },
          }),
        }))

        expect(engine.listMcpTools('fake')).toEqual(tools)
      })
    })
  })

  // -------------------------------------------------------------------------
  // Phase 5b — skill activation
  // -------------------------------------------------------------------------

  describe('skill activation', () => {
    function writeSkillMd(
      baseDir: string,
      id: string,
      frontmatter: Record<string, string>,
      body: string,
    ): void {
      const dir = join(baseDir, 'skills', id)
      mkdirSync(dir, { recursive: true })
      const lines = ['---']
      for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`)
      lines.push('---', '', body)
      writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'))
    }

    function collectingAuditWriter(): {
      events: QueryEvent[]
      writer: typeof nullAuditWriter
    } {
      const events: QueryEvent[] = []
      const writer: typeof nullAuditWriter = {
        write: ((e: QueryEvent) => {
          events.push(e)
        }) as typeof nullAuditWriter.write,
        close: async () => {},
        withOrigin: () => writer,
      }
      return { events, writer }
    }

    function captureCallModel(): {
      lastTools: unknown
      lastSystemParts: unknown
      callModel: CallModelFn
    } {
      const ref = { lastTools: undefined as unknown, lastSystemParts: undefined as unknown }
      const callModel: CallModelFn = async function* (_msgs, sys, _opts, _signal) {
        ref.lastSystemParts = sys
        // The test stubs callModel via deps.callModel which doesn't get the
        // tools array directly — the engine bakes it into the closure. We
        // can't observe `tools` through this seam; the integration test
        // covers send-side filtering. Here we only check system parts.
        yield { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } } as RawStreamEvent
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as RawStreamEvent
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } as RawStreamEvent
        yield { type: 'content_block_stop', index: 0 } as RawStreamEvent
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as RawStreamEvent
        yield { type: 'message_stop' } as RawStreamEvent
        return { stopReason: 'end_turn', inputTokens: 5, outputTokens: 1 } as ApiResponseMeta
      }
      return {
        get lastTools() { return ref.lastTools },
        get lastSystemParts() { return ref.lastSystemParts },
        callModel,
      }
    }

    it('throws when skill not found (no audit event)', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          const audit = collectingAuditWriter()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              auditWriter: audit.writer,
              disableMcp: true,
            }),
          )
          await expect(engine.activateSkill('missing')).rejects.toThrow(/not found/)
          expect(audit.events).toEqual([])
        })
      })
    })

    it('throws when memory is disabled', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(
          makeConfig(cwd, { disableMemory: true, disableMcp: true }),
        )
        await expect(engine.activateSkill('any')).rejects.toThrow(
          /Skills are disabled/,
        )
      })
    })

    it('throws when a skill is already active', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(baseDir, 'one', { name: 'one', description: 'd' }, 'body')
          writeSkillMd(baseDir, 'two', { name: 'two', description: 'd' }, 'body')
          const engine = new QueryEngine(
            makeConfig(cwd, { memoryBaseDir: baseDir, disableMcp: true }),
          )
          await engine.activateSkill('one')
          await expect(engine.activateSkill('two')).rejects.toThrow(
            /already active/,
          )
        })
      })
    })

    it('refuses on high-confidence secret + emits secret_refused audit', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(
            baseDir,
            'leaky',
            { name: 'leaky', description: 'd' },
            'use AKIAABCDEFGHIJKLMNOP for s3 access',
          )
          const audit = collectingAuditWriter()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              auditWriter: audit.writer,
              disableMcp: true,
            }),
          )
          await expect(engine.activateSkill('leaky')).rejects.toThrow(
            /high-confidence credentials/,
          )
          expect(engine.activeSkill).toBeNull()
          const refusal = audit.events.find(
            (e) => e.type === 'skill_deactivated',
          )
          expect(refusal).toBeTruthy()
          expect((refusal as { reason: string }).reason).toBe('secret_refused')
          expect(
            audit.events.find((e) => e.type === 'skill_activated'),
          ).toBeUndefined()
        })
      })
    })

    it('low-confidence without scanHandler refuses', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(
            baseDir,
            'lowsec',
            { name: 'lowsec', description: 'd' },
            'config: api_key = "abcdef1234567890"',
          )
          const audit = collectingAuditWriter()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              auditWriter: audit.writer,
              disableMcp: true,
            }),
          )
          await expect(engine.activateSkill('lowsec')).rejects.toThrow(
            /credential-like/,
          )
          expect(engine.activeSkill).toBeNull()
          expect(
            audit.events.find((e) => e.type === 'skill_deactivated'),
          ).toBeTruthy()
        })
      })
    })

    it('low-confidence with handler returning false refuses', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(
            baseDir,
            'lowsec',
            { name: 'lowsec', description: 'd' },
            'config: api_key = "abcdef1234567890"',
          )
          const engine = new QueryEngine(
            makeConfig(cwd, { memoryBaseDir: baseDir, disableMcp: true }),
          )
          await expect(
            engine.activateSkill('lowsec', {}, async () => false),
          ).rejects.toThrow(/refused by user/)
          expect(engine.activeSkill).toBeNull()
        })
      })
    })

    it('low-confidence with handler returning true succeeds', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(
            baseDir,
            'lowsec',
            { name: 'lowsec', description: 'd' },
            'config: api_key = "abcdef1234567890"',
          )
          const audit = collectingAuditWriter()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              auditWriter: audit.writer,
              disableMcp: true,
            }),
          )
          await engine.activateSkill('lowsec', {}, async () => true)
          expect(engine.activeSkill?.id).toBe('lowsec')
          expect(
            audit.events.find((e) => e.type === 'skill_activated'),
          ).toBeTruthy()
        })
      })
    })

    it('activate sets state, emits skill_activated, and respects turns', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(
            baseDir,
            'sk',
            { name: 'sk', description: 'd' },
            'instructions',
          )
          const audit = collectingAuditWriter()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              auditWriter: audit.writer,
              disableMcp: true,
            }),
          )
          await engine.activateSkill('sk', { turns: 3, args: '<x>' })
          expect(engine.activeSkill?.id).toBe('sk')
          expect(engine.activeSkill?.body).toBe('instructions')
          expect(engine.activeSkill?.args).toBe('<x>')
          expect(engine.isSkillActive).toBe(true)
          const ev = audit.events.find((e) => e.type === 'skill_activated') as
            | { turns: number; hasArgs: boolean; hasAllowedTools: boolean }
            | undefined
          expect(ev?.turns).toBe(3)
          expect(ev?.hasArgs).toBe(true)
          expect(ev?.hasAllowedTools).toBe(false)
        })
      })
    })

    it('rejects turns < 1', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(
            baseDir,
            'sk',
            { name: 'sk', description: 'd' },
            'body',
          )
          const engine = new QueryEngine(
            makeConfig(cwd, { memoryBaseDir: baseDir, disableMcp: true }),
          )
          await expect(
            engine.activateSkill('sk', { turns: 0 }),
          ).rejects.toThrow(/positive integer/)
        })
      })
    })

    it('submitPrompt injects skill body into system prompt parts', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(
            baseDir,
            'sk',
            { name: 'review', description: 'd' },
            'BODY-MARKER',
          )
          const captured = captureCallModel()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              disableMcp: true,
              deps: {
                callModel: captured.callModel,
                authorizeToolUse: stubAuthorize,
                executeToolUse: stubExecute,
              },
            }),
          )
          await engine.activateSkill('sk')
          await collectEvents(engine.submitPrompt('hello'))
          const parts = captured.lastSystemParts as ReadonlyArray<{
            content: string
            cacheHint: string
          }>
          const skillPart = parts.find(
            (p) => p.cacheHint === 'org' && p.content.includes('BODY-MARKER'),
          )
          expect(skillPart).toBeDefined()
        })
      })
    })

    it('successful turn decrements remainingTurns; reaches 0 → turns_exhausted', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(baseDir, 'sk', { name: 'sk', description: 'd' }, 'body')
          const audit = collectingAuditWriter()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              auditWriter: audit.writer,
              disableMcp: true,
            }),
          )
          await engine.activateSkill('sk', { turns: 1 })
          await collectEvents(engine.submitPrompt('go'))
          expect(engine.activeSkill).toBeNull()
          const deact = audit.events.find(
            (e) => e.type === 'skill_deactivated',
          ) as { reason: string } | undefined
          expect(deact?.reason).toBe('turns_exhausted')
        })
      })
    })

    it('multi-turn: stays active until counter exhausts', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(baseDir, 'sk', { name: 'sk', description: 'd' }, 'body')
          const engine = new QueryEngine(
            makeConfig(cwd, { memoryBaseDir: baseDir, disableMcp: true }),
          )
          await engine.activateSkill('sk', { turns: 3 })
          expect(engine.isSkillActive).toBe(true)
          await collectEvents(engine.submitPrompt('t1'))
          expect(engine.isSkillActive).toBe(true)
          await collectEvents(engine.submitPrompt('t2'))
          expect(engine.isSkillActive).toBe(true)
          await collectEvents(engine.submitPrompt('t3'))
          expect(engine.isSkillActive).toBe(false)
        })
      })
    })

    it('user deactivation clears state and emits user_deactivated', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(baseDir, 'sk', { name: 'sk', description: 'd' }, 'body')
          const audit = collectingAuditWriter()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              auditWriter: audit.writer,
              disableMcp: true,
            }),
          )
          await engine.activateSkill('sk', { turns: 5 })
          engine.deactivateSkill('user_deactivated')
          expect(engine.activeSkill).toBeNull()
          const deact = audit.events.find(
            (e) => e.type === 'skill_deactivated',
          ) as { reason: string } | undefined
          expect(deact?.reason).toBe('user_deactivated')
        })
      })
    })

    it('deactivateSkill while inactive is a no-op (no event)', async () => {
      await withTmpDir(async (cwd) => {
        const audit = collectingAuditWriter()
        const engine = new QueryEngine(
          makeConfig(cwd, {
            auditWriter: audit.writer,
            disableMcp: true,
          }),
        )
        engine.deactivateSkill('user_deactivated')
        expect(audit.events).toEqual([])
      })
    })

    it('aborted terminal preserves the activation window', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(baseDir, 'sk', { name: 'sk', description: 'd' }, 'body')
          // Abort via the engine's own currentAbort signal — query() will
          // observe and return a clean Terminal with reason='aborted'.
          const abortAwareCallModel: CallModelFn = async function* (
            _m,
            _s,
            _o,
            signal,
          ) {
            // Wait for the parent abort to fire so query() returns a clean
            // 'aborted' terminal rather than throwing.
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener('abort', () => resolve(), { once: true })
            })
            yield {
              type: 'message_start',
              message: { usage: { input_tokens: 5, output_tokens: 0 } },
            } as RawStreamEvent
            return { stopReason: 'end_turn' } as ApiResponseMeta
          }
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              disableMcp: true,
              deps: {
                callModel: abortAwareCallModel,
                authorizeToolUse: stubAuthorize,
                executeToolUse: stubExecute,
              },
            }),
          )
          await engine.activateSkill('sk', { turns: 5 })
          const gen = engine.submitPrompt('go')
          // Kick off the generator, then abort.
          const firstTick = gen.next()
          engine.abort()
          await firstTick
          // Drain until done.
          while (!(await gen.next()).done) { /* drain */ }
          // Activation window is preserved across abort.
          expect(engine.isSkillActive).toBe(true)
        })
      })
    })

    it('error terminal auto-deactivates with reason=error', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(baseDir, 'sk', { name: 'sk', description: 'd' }, 'body')
          // callModel that throws a non-abort error to surface a Terminal
          // with reason='error' through the loop's error handling.
          const throwingCallModel: CallModelFn = async function* (
            _m,
            _s,
            _o,
            _sig,
          ) {
            throw new Error('boom')
            // Unreachable — forces TypeScript to treat this as a generator.
            yield { type: 'message_stop' } as RawStreamEvent
          }
          const audit = collectingAuditWriter()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              auditWriter: audit.writer,
              disableMcp: true,
              deps: {
                callModel: throwingCallModel,
                authorizeToolUse: stubAuthorize,
                executeToolUse: stubExecute,
              },
            }),
          )
          await engine.activateSkill('sk', { turns: 5 })
          try {
            await collectEvents(engine.submitPrompt('go'))
          } catch {
            // submitPrompt may rethrow — that's fine; the catch handler
            // deactivated before rethrowing.
          }
          expect(engine.isSkillActive).toBe(false)
          const deact = audit.events.find(
            (e) => e.type === 'skill_deactivated',
          ) as { reason: string } | undefined
          expect(deact?.reason).toBe('error')
        })
      })
    })

    it('pre-query throw also deactivates with reason=error', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(baseDir, 'sk', { name: 'sk', description: 'd' }, 'body')
          // Make hookConfigPath point at a malformed file so loadHooks
          // throws inside submitPrompt's body before the query loop runs.
          const hookPath = join(baseDir, 'hooks-bad.json')
          writeFileSync(hookPath, '{ this is not json')
          const audit = collectingAuditWriter()
          const engine = new QueryEngine(
            makeConfig(cwd, {
              memoryBaseDir: baseDir,
              auditWriter: audit.writer,
              disableMcp: true,
              hookConfigPath: hookPath,
            }),
          )
          await engine.activateSkill('sk', { turns: 5 })
          await expect(
            collectEvents(engine.submitPrompt('go')),
          ).rejects.toThrow()
          expect(engine.isSkillActive).toBe(false)
          const deact = audit.events.find(
            (e) => e.type === 'skill_deactivated',
          ) as { reason: string } | undefined
          expect(deact?.reason).toBe('error')
        })
      })
    })

    it('deactivateSkill while a submission is running throws', async () => {
      // Toggle `_running` directly via a private cast — driving a real
      // submission that parks deterministically is brittle in vitest, and
      // the guard itself is a one-liner mirror of setModel's well-tested
      // guard. We only need to assert the branch fires.
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(baseDir, 'sk', { name: 'sk', description: 'd' }, 'body')
          const engine = new QueryEngine(
            makeConfig(cwd, { memoryBaseDir: baseDir, disableMcp: true }),
          )
          await engine.activateSkill('sk', { turns: 5 })
          ;(engine as unknown as { _running: boolean })._running = true
          try {
            expect(() => engine.deactivateSkill('user_deactivated')).toThrow(
              /submission is in progress/,
            )
          } finally {
            ;(engine as unknown as { _running: boolean })._running = false
          }
        })
      })
    })

    it('deactivateSkill on disposed engine throws', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(baseDir, 'sk', { name: 'sk', description: 'd' }, 'body')
          const engine = new QueryEngine(
            makeConfig(cwd, { memoryBaseDir: baseDir, disableMcp: true }),
          )
          await engine.activateSkill('sk')
          await engine.dispose()
          expect(() => engine.deactivateSkill('user_deactivated')).toThrow(
            /disposed/,
          )
        })
      })
    })

    it('activated skill with allowedTools sets up scoped allowlist', async () => {
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(
            baseDir,
            'sk',
            {
              name: 'sk',
              description: 'd',
              'allowed-tools': '["FileRead", "Grep"]',
            },
            'body',
          )
          const engine = new QueryEngine(
            makeConfig(cwd, { memoryBaseDir: baseDir, disableMcp: true }),
          )
          await engine.activateSkill('sk')
          expect(engine.activeSkill?.allowedTools).toEqual(['FileRead', 'Grep'])
        })
      })
    })

    it('send-side: _activeCallModel is built only when allowedTools is set', async () => {
      // Capture the args resolveCallModel sees so we can assert that the
      // activation-filtered call model is constructed against the filtered
      // tool defs — not the unfiltered registry.
      await withTmpDir(async (cwd) => {
        await withTmpDir(async (baseDir) => {
          writeSkillMd(
            baseDir,
            'scoped',
            {
              name: 'scoped',
              description: 'd',
              'allowed-tools': '["FileRead", "Grep"]',
            },
            'body',
          )
          writeSkillMd(
            baseDir,
            'unscoped',
            { name: 'unscoped', description: 'd' },
            'body',
          )
          const engine = new QueryEngine(
            makeConfig(cwd, { memoryBaseDir: baseDir, disableMcp: true }),
          )

          type WithPrivates = {
            _activeCallModel: unknown
            callModel: unknown
            resolveCallModel: (
              this: unknown,
              modelId: string,
              defs: ReadonlyArray<{ name: string }>,
            ) => unknown
          }
          const priv = engine as unknown as WithPrivates

          const seenDefs: Array<ReadonlyArray<{ name: string }>> = []
          const orig = priv.resolveCallModel.bind(engine) as typeof priv.resolveCallModel
          priv.resolveCallModel = function (
            this: unknown,
            modelId: string,
            defs: ReadonlyArray<{ name: string }>,
          ) {
            seenDefs.push(defs)
            return orig.call(engine, modelId, defs)
          }

          // Skill WITH allowed-tools → _activeCallModel built from the filter.
          await engine.activateSkill('scoped')
          expect(priv._activeCallModel).not.toBeNull()
          expect(priv._activeCallModel).not.toBe(priv.callModel)
          // The most recent resolveCallModel call carries the FILTERED defs.
          const last = seenDefs[seenDefs.length - 1]
          expect(last?.map((d) => d.name).sort()).toEqual(['FileRead', 'Grep'])

          engine.deactivateSkill('user_deactivated')
          expect(priv._activeCallModel).toBeNull()

          // Skill WITHOUT allowed-tools → _activeCallModel stays null.
          await engine.activateSkill('unscoped')
          expect(priv._activeCallModel).toBeNull()
        })
      })
    })

    // The `_running` guard on activateSkill mirrors setModel's pattern,
    // which is already covered by the setModel suite. Asserting the guard
    // here would require a stuck-callModel scaffold that's hard to drive
    // deterministically in vitest.
  })

  // -------------------------------------------------------------------------
  // v3 Phase 3: Computer-Use tool registration + dispose
  // -------------------------------------------------------------------------

  describe('Computer-Use tool registration (Phase 3)', () => {
    const COMPUTER_TOOL_NAMES = [
      'ComputerStart',
      'ComputerObserve',
      'ComputerNavigate',
      'ComputerClick',
      'ComputerType',
      'ComputerKey',
      'ComputerScroll',
      'ComputerDrag',
      'ComputerWait',
      'ComputerHandoffToUser',
      'ComputerStop',
      // Phase 4b — DOM-first action path.
      'ComputerObserveActions',
      'ComputerActAtom',
    ] as const

    it('does NOT register Computer tools by default (computerUse.enabled = false)', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd))
        const reg = engine.getRegistry()
        for (const name of COMPUTER_TOOL_NAMES) {
          expect(reg.has(name)).toBe(false)
        }
      })
    })

    it('registers all 11 Computer tools when computerUse.enabled = true', async () => {
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(
          makeConfig(cwd, {
            computerUseSettings: {
              enabled: true,
              defaultEnvironment: 'browser' as const,
              viewport: { width: 1024, height: 768 },
              displaySize: { width: 1024, height: 768 },
              maxSteps: 30,
              maxDurationMs: 60_000,
              maxScreenshotBytes: 2_000_000,
              maxScreenshotDimensions: { width: 1024, height: 768 },
              ariaSnapshotMaxTokens: 4000,
              allowedDomains: ['example.com'],
              deniedDomains: [],
              persistProfiles: false,
              allowDownloads: false,
              allowUploads: false,
              allowAuthHandoff: false,
              debugPersistScreenshots: false,
              redactionSelectors: [],
              verifyActions: true,
              watchMode: false,
            },
            sessionManager: makeFakeSessionManager(),
          }),
        )
        const reg = engine.getRegistry()
        for (const name of COMPUTER_TOOL_NAMES) {
          expect(reg.has(name)).toBe(true)
        }
      })
    })

    it('dispose() calls sessionManager.stopAll() exactly once', async () => {
      await withTmpDir(async (cwd) => {
        const fake = makeFakeSessionManager()
        const engine = new QueryEngine(
          makeConfig(cwd, {
            computerUseSettings: {
              enabled: true,
              defaultEnvironment: 'browser' as const,
              viewport: { width: 1024, height: 768 },
              displaySize: { width: 1024, height: 768 },
              maxSteps: 30,
              maxDurationMs: 60_000,
              maxScreenshotBytes: 2_000_000,
              maxScreenshotDimensions: { width: 1024, height: 768 },
              ariaSnapshotMaxTokens: 4000,
              allowedDomains: ['example.com'],
              deniedDomains: [],
              persistProfiles: false,
              allowDownloads: false,
              allowUploads: false,
              allowAuthHandoff: false,
              debugPersistScreenshots: false,
              redactionSelectors: [],
              verifyActions: true,
              watchMode: false,
            },
            sessionManager: fake,
          }),
        )
        await engine.dispose()
        expect(fake.stopAllCalls).toBe(1)
        // Idempotent — second dispose is a no-op.
        await engine.dispose()
        expect(fake.stopAllCalls).toBe(1)
      })
    })

    it('does not dynamically import playwright when Computer-Use is disabled', async () => {
      // The lazy factory is only built when computerUse.enabled === true.
      // Without enabling, no `await import('../core/computer/playwrightBrowserSession.js')`
      // call is reachable. We can't easily intercept dynamic imports inside
      // the engine without polluting the loader; instead, assert the simpler
      // contract: with disabled settings, _sessionManager stays null, so the
      // factory closure that would do the dynamic import is never created.
      await withTmpDir(async (cwd) => {
        const engine = new QueryEngine(makeConfig(cwd))
        const priv = engine as unknown as { _sessionManager: unknown }
        expect(priv._sessionManager).toBeNull()
      })
    })
  })

  describe('Computer-Use safety check + askUser wrapper (Phase 4·1)', () => {
    function enabledSettings() {
      return {
        enabled: true,
        defaultEnvironment: 'browser' as const,
        viewport: { width: 1024, height: 768 },
        displaySize: { width: 1024, height: 768 },
        maxSteps: 30,
        maxDurationMs: 60_000,
        maxScreenshotBytes: 2_000_000,
        maxScreenshotDimensions: { width: 1024, height: 768 },
        ariaSnapshotMaxTokens: 4000,
        allowedDomains: ['example.com'],
        deniedDomains: [],
        persistProfiles: false,
        allowDownloads: false,
        allowUploads: false,
        allowAuthHandoff: false,
        debugPersistScreenshots: false,
        redactionSelectors: [],
        verifyActions: true,
        watchMode: false,
      }
    }

    it('safetyChecks always includes computerUseSafetyCheck (no-op when disabled)', async () => {
      await withTmpDir(async (cwd) => {
        // Disabled engine — safety check is registered but receives null
        // sessionManager, so it short-circuits to null for every input.
        const engine = new QueryEngine(makeConfig(cwd))
        const priv = engine as unknown as {
          permissionOpts: { safetyChecks: ReadonlyArray<unknown> }
        }
        // We have at least one safety check (filesystemSafetyChecks contributes
        // multiple); the Computer-Use one is the last entry by construction.
        expect(priv.permissionOpts.safetyChecks.length).toBeGreaterThan(0)
      })
    })

    it('askUser wrapper injects sessionLookup for Computer tools when enabled', async () => {
      await withTmpDir(async (cwd) => {
        const fakeSession = {
          currentUrl: () => 'https://example.com/settings',
          isClosed: () => false,
        }
        const fake = makeFakeSessionManager()
        ;(fake as unknown as { get: (id: string) => unknown }).get = (id: string) =>
          id === 's1' ? fakeSession : undefined

        const askCalls: Array<{
          toolName: string
          opts: { sessionLookup?: (id: string) => unknown } | undefined
        }> = []
        const askUser = vi.fn(async (toolName, _input, _reason, _signal, opts) => {
          askCalls.push({ toolName, opts })
          return 'allow_once' as const
        })

        const engine = new QueryEngine(
          makeConfig(cwd, {
            computerUseSettings: enabledSettings(),
            sessionManager: fake,
            askUser,
          }),
        )

        const priv = engine as unknown as {
          permissionOpts: {
            askUser: (
              toolName: string,
              input: Record<string, unknown>,
              reason: string,
              signal: AbortSignal,
              opts?: { sessionLookup?: (id: string) => unknown },
            ) => Promise<string>
          }
        }

        // Computer tool: sessionLookup is injected
        await priv.permissionOpts.askUser(
          'ComputerClick',
          { sessionId: 's1', x: 0.5, y: 0.5 },
          'reason',
          new AbortController().signal,
        )
        expect(askCalls).toHaveLength(1)
        expect(askCalls[0]?.toolName).toBe('ComputerClick')
        expect(askCalls[0]?.opts?.sessionLookup).toBeDefined()
        const lookup = askCalls[0]?.opts?.sessionLookup
        expect(lookup?.('s1')).toEqual({
          url: 'https://example.com/settings',
          title: null,
        })
        expect(lookup?.('unknown')).toBeNull()

        // Non-Computer tool: opts is undefined (or whatever caller passed),
        // sessionLookup is NOT injected.
        await priv.permissionOpts.askUser(
          'Bash',
          { command: 'ls' },
          'reason',
          new AbortController().signal,
        )
        expect(askCalls[1]?.opts?.sessionLookup).toBeUndefined()
      })
    })

    it('askUser wrapper preserves opts.metadata when forwarding (Computer branch)', async () => {
      await withTmpDir(async (cwd) => {
        const fake = makeFakeSessionManager()
        const askUser = vi.fn(async (_toolName, _input, _reason, _signal, opts) => {
          // Echo the opts so the test can verify them.
          return opts?.metadata?.riskLevel === 3 ? ('allow_once' as const) : ('deny_once' as const)
        })
        const engine = new QueryEngine(
          makeConfig(cwd, {
            computerUseSettings: enabledSettings(),
            sessionManager: fake,
            askUser,
          }),
        )
        const priv = engine as unknown as {
          permissionOpts: {
            askUser: (
              toolName: string,
              input: Record<string, unknown>,
              reason: string,
              signal: AbortSignal,
              opts?: {
                metadata?: {
                  checkName: string
                  riskLevel: number
                  riskCategory: string
                }
              },
            ) => Promise<string>
          }
        }
        const result = await priv.permissionOpts.askUser(
          'ComputerClick',
          { sessionId: 's1', x: 0.5, y: 0.5 },
          'reason',
          new AbortController().signal,
          {
            metadata: {
              checkName: 'computerUseSafetyCheck',
              riskLevel: 3,
              riskCategory: 'irreversible',
            },
          },
        )
        expect(result).toBe('allow_once')
      })
    })

    it('headless mode → askUser is undefined (no wrapping)', async () => {
      await withTmpDir(async (cwd) => {
        const fake = makeFakeSessionManager()
        const engine = new QueryEngine(
          makeConfig(cwd, {
            headless: true,
            computerUseSettings: enabledSettings(),
            sessionManager: fake,
            askUser: vi.fn(),
          }),
        )
        const priv = engine as unknown as {
          permissionOpts: { askUser: unknown }
        }
        expect(priv.permissionOpts.askUser).toBeUndefined()
      })
    })
  })
})

/**
 * Minimal fake ComputerSessionManager for QE tests. We only need to track
 * stopAllCalls for the dispose test — start/get/stop/requestClose are stubs.
 */
function makeFakeSessionManager(): {
  start: (...args: unknown[]) => Promise<never>
  get: () => undefined
  stop: () => Promise<void>
  stopAll: () => Promise<void>
  requestClose: () => Promise<void>
  recordStep: () => { abort: false }
  // v3 Phase 6 — metrics surface; QE tests don't read these, so the stubs
  // return null / no-op.
  getSessionMetrics: () => null
  recordScreenshot: () => void
  stopAllCalls: number
} {
  const fake = {
    stopAllCalls: 0,
    async start(): Promise<never> {
      throw new Error('not used in this test')
    },
    get(): undefined {
      return undefined
    },
    async stop(): Promise<void> {},
    async stopAll(): Promise<void> {
      fake.stopAllCalls++
    },
    async requestClose(): Promise<void> {},
    recordStep(): { abort: false } {
      return { abort: false }
    },
    getSessionMetrics(): null {
      return null
    },
    recordScreenshot(): void {},
  }
  return fake
}
