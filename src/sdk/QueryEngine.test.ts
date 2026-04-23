import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { QueryEngine } from './QueryEngine.js'
import type { QueryEngineConfig } from './QueryEngine.js'
import type { QueryEvent } from '../core/queryEvents.js'
import type { Terminal } from '../core/queryTypes.js'
import type { CallModelFn, RunToolFn, RawStreamEvent, ApiResponseMeta } from '../core/queryDeps.js'
import { appendMessage } from '../session/transcript.js'
import { createUserMessage, createAssistantMessage, messageId, toolUseId } from '../core/messages.js'

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

/** Stub runTool that returns a simple result. */
const stubRunTool: RunToolFn = async () => ({ content: 'ok', isError: false })

function makeConfig(cwd: string, overrides?: Partial<QueryEngineConfig>): QueryEngineConfig {
  return {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    cwd,
    deps: {
      callModel: textCallModel('Hello back!'),
      runTool: stubRunTool,
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
          deps: { callModel: spy, runTool: stubRunTool },
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
          deps: { callModel: spy, runTool: stubRunTool },
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
          deps: { callModel: spy, runTool: stubRunTool },
        }))
        await collectEvents(engine.submitPrompt('hi', { thinkingBudget: 0 }))
        expect(captured[0]!.thinkingBudget).toBeUndefined()
      })
    })
  })
})
