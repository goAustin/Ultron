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

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: chatCreateSpy } }
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
      { content: 'section one', cacheHint: 'static' },
      { content: 'section two', cacheHint: 'static' },
      { content: 'current date', cacheHint: 'volatile' },
      { content: 'env info', cacheHint: 'volatile' },
    ]
    expect(joinSystemPromptParts(parts)).toBe(
      'section one\n\nsection two\n\ncurrent date\n\nenv info',
    )
  })

  it('ignores cacheHint — content order is the only signal', () => {
    const withHints: SystemPromptPart[] = [
      { content: 'a', cacheHint: 'static' },
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
      { content: 'line 1\nline 2', cacheHint: 'static' },
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
    __resetWarnOnceForTesting()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('emits reasoning_effort on thinking-capable models', async () => {
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
    const body = chatCreateSpy.mock.calls[0]![0]
    expect(body.reasoning_effort).toBe('medium')
  })

  it('omits reasoning_effort + warns once on non-thinking models (MiniMax path)', async () => {
    const callModel = createOpenAICompatibleCallModel({
      apiKey: 'k',
      model: 'MiniMax-M2.7',
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
    const body = chatCreateSpy.mock.calls[0]![0]
    expect(body.reasoning_effort).toBeUndefined()
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})
