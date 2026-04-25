import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  joinSystemPromptParts,
  bucketReasoningEffort,
  createOpenAICompatibleCallModel,
} from './openaiAdapter.js'
import type { SystemPromptPart } from '../../context/systemPromptParts.js'
import type { CapabilitySheet } from './types.js'
import { __resetWarnOnceForTesting } from './warnOnce.js'

const chatCreateSpy = vi.fn()
const responsesCreateSpy = vi.fn()

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: chatCreateSpy } }
    responses = { create: responsesCreateSpy }
  }
  return { default: FakeOpenAI }
})

const gptCaps: CapabilitySheet = {
  maxContextTokens: 1_000_000,
  maxOutputTokens: 128_000,
  supportsThinking: true,
  supportsInterleavedThinking: false,
  promptCacheModel: 'implicit',
}

const minimaxCaps: CapabilitySheet = {
  maxContextTokens: 256_000,
  maxOutputTokens: 16_384,
  supportsThinking: false,
  supportsInterleavedThinking: false,
  promptCacheModel: 'implicit',
}

function emptyAsyncIter(): AsyncIterable<never> {
  return { [Symbol.asyncIterator]: async function* () { /* yield nothing */ } }
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) { /* drain */ }
}

describe('joinSystemPromptParts', () => {
  it('joins part content with double-newline separators (byte-identical to pre-1b)', () => {
    const parts: SystemPromptPart[] = [
      { content: 'section one', cacheHint: 'global' },
      { content: 'section two', cacheHint: 'global' },
      { content: 'current date', cacheHint: 'volatile' },
      { content: 'env info', cacheHint: 'volatile' },
    ]
    expect(joinSystemPromptParts(parts)).toBe(
      'section one\n\nsection two\n\ncurrent date\n\nenv info',
    )
  })

  it('ignores cacheHint — content order is the only signal', () => {
    const withHints: SystemPromptPart[] = [
      { content: 'a', cacheHint: 'global' },
      { content: 'b', cacheHint: 'volatile' },
    ]
    const withoutHints: SystemPromptPart[] = [
      { content: 'a' },
      { content: 'b' },
    ]
    expect(joinSystemPromptParts(withHints)).toBe(joinSystemPromptParts(withoutHints))
  })

  it('returns empty string for empty input', () => {
    expect(joinSystemPromptParts([])).toBe('')
  })

  it('preserves embedded newlines in individual parts verbatim', () => {
    const parts: SystemPromptPart[] = [
      { content: 'line 1\nline 2', cacheHint: 'global' },
      { content: 'line 3', cacheHint: 'volatile' },
    ]
    expect(joinSystemPromptParts(parts)).toBe('line 1\nline 2\n\nline 3')
  })
})

describe('bucketReasoningEffort', () => {
  it('returns "low" for budgets under 4096', () => {
    expect(bucketReasoningEffort(1)).toBe('low')
    expect(bucketReasoningEffort(2_000)).toBe('low')
    expect(bucketReasoningEffort(4_095)).toBe('low')
  })

  it('returns "medium" for budgets in [4096, 16384)', () => {
    expect(bucketReasoningEffort(4_096)).toBe('medium')
    expect(bucketReasoningEffort(8_000)).toBe('medium')
    expect(bucketReasoningEffort(16_383)).toBe('medium')
  })

  it('returns "high" for budgets >= 16384', () => {
    expect(bucketReasoningEffort(16_384)).toBe('high')
    expect(bucketReasoningEffort(20_000)).toBe('high')
    expect(bucketReasoningEffort(1_000_000)).toBe('high')
  })
})

describe('createOpenAICompatibleCallModel — thinking translation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    chatCreateSpy.mockReset()
    chatCreateSpy.mockResolvedValue(emptyAsyncIter())
    responsesCreateSpy.mockReset()
    responsesCreateSpy.mockResolvedValue(emptyAsyncIter())
    __resetWarnOnceForTesting()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('emits reasoning on native OpenAI Responses requests', async () => {
    const callModel = createOpenAICompatibleCallModel({
      apiKey: 'k',
      model: 'gpt-5.4',
      capabilities: gptCaps,
    })
    await drain({
      [Symbol.asyncIterator]: () => callModel(
        [],
        [{ content: 'preamble' }],
        { thinkingBudget: 8_000 },
        new AbortController().signal,
      ),
    })
    const body = responsesCreateSpy.mock.calls[0]![0]
    expect(body.reasoning).toEqual({ effort: 'medium' })
    expect(chatCreateSpy).not.toHaveBeenCalled()
  })

  it('uses Chat Completions for OpenAI-compatible base URLs', async () => {
    const callModel = createOpenAICompatibleCallModel({
      apiKey: 'k',
      model: 'gpt-5.4',
      baseUrl: 'https://example.test/v1',
      capabilities: gptCaps,
    })
    await drain({
      [Symbol.asyncIterator]: () => callModel(
        [],
        [{ content: 'preamble' }],
        { thinkingBudget: 8_000 },
        new AbortController().signal,
      ),
    })
    const body = chatCreateSpy.mock.calls[0]![0]
    expect(body.reasoning_effort).toBe('medium')
    expect(responsesCreateSpy).not.toHaveBeenCalled()
  })

  it('omits reasoning_effort + warns once on non-thinking models (MiniMax path)', async () => {
    const callModel = createOpenAICompatibleCallModel({
      apiKey: 'k',
      model: 'MiniMax-M2.7',
      baseUrl: 'https://api.minimaxi.com/v1',
      capabilities: minimaxCaps,
    })
    const run = () => drain({
      [Symbol.asyncIterator]: () => callModel(
        [],
        [{ content: 'preamble' }],
        { thinkingBudget: 4096 },
        new AbortController().signal,
      ),
    })
    await run()
    await run()
    // Two requests, neither carries reasoning_effort.
    expect(chatCreateSpy).toHaveBeenCalledTimes(2)
    expect(chatCreateSpy.mock.calls[0]![0].reasoning_effort).toBeUndefined()
    expect(chatCreateSpy.mock.calls[1]![0].reasoning_effort).toBeUndefined()
    // Exactly one stderr warning across the two calls.
    const warns = stderrSpy.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('thinkingBudget set'),
    )
    expect(warns.length).toBe(1)
  })

  it('warns once when interleavedThinking set on a model that does not support it', async () => {
    const callModel = createOpenAICompatibleCallModel({
      apiKey: 'k',
      model: 'gpt-5.4',
      capabilities: gptCaps,
    })
    await drain({
      [Symbol.asyncIterator]: () => callModel(
        [],
        [{ content: 'preamble' }],
        { interleavedThinking: true },
        new AbortController().signal,
      ),
    })
    const warns = stderrSpy.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('interleavedThinking'),
    )
    expect(warns.length).toBe(1)
  })

  it('omits reasoning_effort + sends no warn when no thinking knobs are set', async () => {
    const callModel = createOpenAICompatibleCallModel({
      apiKey: 'k',
      model: 'gpt-5.4',
      capabilities: gptCaps,
    })
    await drain({
      [Symbol.asyncIterator]: () => callModel(
        [],
        [{ content: 'preamble' }],
        {},
        new AbortController().signal,
      ),
    })
    const body = responsesCreateSpy.mock.calls[0]![0]
    expect(body.reasoning).toBeUndefined()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('sends function tools through Responses and converts streamed calls to tool_use events', async () => {
    responsesCreateSpy.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: 'call_1',
            name: 'Bash',
            arguments: '',
          },
        }
        yield {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'fc_1',
          delta: '{"command":"pwd"}',
        }
        yield {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: 'call_1',
            name: 'Bash',
            arguments: '{"command":"pwd"}',
          },
        }
        yield {
          type: 'response.completed',
          response: {
            output: [{ type: 'function_call' }],
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        }
      },
    })

    const callModel = createOpenAICompatibleCallModel({
      apiKey: 'k',
      model: 'gpt-5.4-mini',
      capabilities: gptCaps,
      tools: [{
        name: 'Bash',
        description: 'Run shell commands',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      }],
    })

    const events: unknown[] = []
    const gen = callModel(
      [],
      [{ content: 'preamble' }],
      { thinkingBudget: 8_000 },
      new AbortController().signal,
    )
    for await (const event of gen) events.push(event)

    const body = responsesCreateSpy.mock.calls[0]![0]
    expect(body.tools).toEqual([{
      type: 'function',
      name: 'Bash',
      description: 'Run shell commands',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
      strict: null,
    }])
    expect(body.reasoning).toEqual({ effort: 'medium' })
    expect(events).toContainEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'Bash', input: '' },
    })
    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
    })
    expect(events).toContainEqual({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } })
  })
})
