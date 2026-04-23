import { describe, it, expect, vi, beforeEach } from 'vitest'

import { buildAnthropicSystemField, anthropicAdapter } from './anthropicAdapter.js'
import type { SystemPromptPart } from '../../context/systemPromptParts.js'
import type { CapabilitySheet } from './types.js'
import { __resetWarnOnceForTesting } from './warnOnce.js'

// Module-level mock state — captured by the vi.mock factory below.
const messagesStreamSpy = vi.fn()
const betaMessagesStreamSpy = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { stream: messagesStreamSpy }
    beta = { messages: { stream: betaMessagesStreamSpy } }
  }
  return { default: FakeAnthropic }
})

const opusCaps: CapabilitySheet = {
  maxContextTokens: 1_000_000,
  maxOutputTokens: 128_000,
  supportsThinking: true,
  supportsInterleavedThinking: true,
  promptCacheModel: 'explicit',
}

const haikuCaps: CapabilitySheet = {
  maxContextTokens: 200_000,
  maxOutputTokens: 64_000,
  supportsThinking: true,
  supportsInterleavedThinking: false,
  promptCacheModel: 'explicit',
}

// Empty async iterator — neither test reads stream output, only the request shape.
function fakeStream(): AsyncIterable<never> {
  return { [Symbol.asyncIterator]: async function* () { /* yield nothing */ } }
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) { /* drain */ }
}

describe('buildAnthropicSystemField', () => {
  const parts: SystemPromptPart[] = [
    { content: 'preamble 1', cacheHint: 'static' },
    { content: 'preamble 2', cacheHint: 'static' },
    { content: 'preamble 3', cacheHint: 'static' },
    { content: 'current date', cacheHint: 'volatile' },
    { content: 'env info', cacheHint: 'volatile' },
  ]

  it('returns a TextBlockParam[] for explicit prompt cache models', () => {
    const field = buildAnthropicSystemField(parts, 'explicit')
    expect(Array.isArray(field)).toBe(true)
    const arr = field as Array<{ type: string; text: string }>
    expect(arr.length).toBe(parts.length)
    for (let i = 0; i < arr.length; i++) {
      expect(arr[i]!.type).toBe('text')
      expect(arr[i]!.text).toBe(parts[i]!.content)
    }
  })

  it('attaches cache_control to exactly one block (the last static part)', () => {
    const field = buildAnthropicSystemField(parts, 'explicit') as Array<{
      type: string
      text: string
      cache_control?: { type: string }
    }>
    const withControl = field.filter(b => b.cache_control !== undefined)
    expect(withControl.length).toBe(1)
    // Last static part is at index 2 ('preamble 3')
    expect(field[2]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(field[2]!.text).toBe('preamble 3')
    // Volatile parts never carry cache_control
    expect(field[3]!.cache_control).toBeUndefined()
    expect(field[4]!.cache_control).toBeUndefined()
  })

  it('returns a joined string for implicit prompt cache models', () => {
    const field = buildAnthropicSystemField(parts, 'implicit')
    expect(typeof field).toBe('string')
    expect(field).toBe(parts.map(p => p.content).join('\n\n'))
  })

  it('returns a joined string for promptCacheModel: "none"', () => {
    const field = buildAnthropicSystemField(parts, 'none')
    expect(typeof field).toBe('string')
    expect(field).toBe(parts.map(p => p.content).join('\n\n'))
  })

  it('falls back to joined string when no static part exists', () => {
    const allVolatile: SystemPromptPart[] = [
      { content: 'a', cacheHint: 'volatile' },
      { content: 'b', cacheHint: 'volatile' },
    ]
    const field = buildAnthropicSystemField(allVolatile, 'explicit')
    expect(typeof field).toBe('string')
    expect(field).toBe('a\n\nb')
  })

  it('skips empty static parts when selecting the cache breakpoint', () => {
    const withEmptyLast: SystemPromptPart[] = [
      { content: 'real static', cacheHint: 'static' },
      { content: '', cacheHint: 'static' },
      { content: 'volatile', cacheHint: 'volatile' },
    ]
    const field = buildAnthropicSystemField(withEmptyLast, 'explicit') as Array<{
      type: string
      text: string
      cache_control?: { type: string }
    }>
    expect(field[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(field[1]!.cache_control).toBeUndefined()
  })
})

describe('anthropicAdapter.createCallModel — thinking + interleaved', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    messagesStreamSpy.mockReset()
    betaMessagesStreamSpy.mockReset()
    messagesStreamSpy.mockReturnValue(fakeStream())
    betaMessagesStreamSpy.mockReturnValue(fakeStream())
    __resetWarnOnceForTesting()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('emits thinking body field on Opus when thinkingBudget is set', async () => {
    const callModel = anthropicAdapter.createCallModel({
      apiKey: 'k',
      model: 'claude-opus-4-7',
      capabilities: opusCaps,
    })
    await drain({
      [Symbol.asyncIterator]: () => callModel(
        [],
        [{ content: 'preamble', cacheHint: 'static' }],
        { thinkingBudget: 4096 },
        new AbortController().signal,
      ),
    })
    expect(messagesStreamSpy).toHaveBeenCalledTimes(1)
    expect(betaMessagesStreamSpy).not.toHaveBeenCalled()
    const body = messagesStreamSpy.mock.calls[0]![0]
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
    // Anthropic requires max_tokens > thinking.budget_tokens; we add headroom.
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096 + 1024)
  })

  it('routes through beta.messages.stream when interleaving requested + capable', async () => {
    const callModel = anthropicAdapter.createCallModel({
      apiKey: 'k',
      model: 'claude-opus-4-7',
      capabilities: opusCaps,
    })
    await drain({
      [Symbol.asyncIterator]: () => callModel(
        [],
        [{ content: 'preamble', cacheHint: 'static' }],
        { thinkingBudget: 4096, interleavedThinking: true },
        new AbortController().signal,
      ),
    })
    expect(betaMessagesStreamSpy).toHaveBeenCalledTimes(1)
    expect(messagesStreamSpy).not.toHaveBeenCalled()
    const body = betaMessagesStreamSpy.mock.calls[0]![0]
    expect(body.betas).toEqual(['interleaved-thinking-2025-05-14'])
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
  })

  it('stays on non-beta stream and warns once when interleaving unsupported (Haiku)', async () => {
    const callModel = anthropicAdapter.createCallModel({
      apiKey: 'k',
      model: 'claude-haiku-4-5-20251001',
      capabilities: haikuCaps,
    })
    const run = () => drain({
      [Symbol.asyncIterator]: () => callModel(
        [],
        [{ content: 'preamble', cacheHint: 'static' }],
        { thinkingBudget: 4096, interleavedThinking: true },
        new AbortController().signal,
      ),
    })
    await run()
    await run()
    expect(messagesStreamSpy).toHaveBeenCalledTimes(2)
    expect(betaMessagesStreamSpy).not.toHaveBeenCalled()
    // Both calls still carry the thinking body — supportsThinking is true.
    expect(messagesStreamSpy.mock.calls[0]![0].thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
    // Exactly one stderr warning across both calls.
    const warns = stderrSpy.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('interleavedThinking'),
    )
    expect(warns.length).toBe(1)
  })

  it('produces a body byte-identical to pre-1c when thinkingBudget is omitted', async () => {
    const callModel = anthropicAdapter.createCallModel({
      apiKey: 'k',
      model: 'claude-opus-4-7',
      capabilities: opusCaps,
    })
    await drain({
      [Symbol.asyncIterator]: () => callModel(
        [],
        [{ content: 'preamble', cacheHint: 'static' }],
        {},
        new AbortController().signal,
      ),
    })
    const body = messagesStreamSpy.mock.calls[0]![0]
    expect(body.thinking).toBeUndefined()
    expect(body.max_tokens).toBe(16_384) // default
  })
})
