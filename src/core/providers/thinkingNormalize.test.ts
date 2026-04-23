import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  normalizeThinkingBudget,
  ANTHROPIC_THINKING_MIN,
} from './thinkingNormalize.js'
import { __resetWarnOnceForTesting } from './warnOnce.js'
import type { CapabilitySheet } from './types.js'

const opus: CapabilitySheet = {
  maxContextTokens: 1_000_000,
  maxOutputTokens: 128_000,
  supportsThinking: true,
  supportsInterleavedThinking: true,
  promptCacheModel: 'explicit',
}

const gpt: CapabilitySheet = {
  maxContextTokens: 1_000_000,
  maxOutputTokens: 128_000,
  supportsThinking: true,
  supportsInterleavedThinking: false,
  promptCacheModel: 'implicit',
}

const minimax: CapabilitySheet = {
  maxContextTokens: 256_000,
  maxOutputTokens: 16_384,
  supportsThinking: false,
  supportsInterleavedThinking: false,
  promptCacheModel: 'implicit',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any

describe('normalizeThinkingBudget', () => {
  beforeEach(() => {
    __resetWarnOnceForTesting()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('passes undefined through', () => {
    expect(normalizeThinkingBudget(undefined, 'm', opus)).toBeUndefined()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('treats 0 as disabled with no warning', () => {
    expect(normalizeThinkingBudget(0, 'opus', opus)).toBeUndefined()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('rejects negative numbers with a warning', () => {
    expect(normalizeThinkingBudget(-5, 'opus', opus)).toBeUndefined()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects NaN with a warning', () => {
    expect(normalizeThinkingBudget(Number.NaN, 'opus', opus)).toBeUndefined()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects Infinity with a warning', () => {
    expect(normalizeThinkingBudget(Infinity, 'opus', opus)).toBeUndefined()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('raises sub-1024 to the floor for explicit-thinking providers', () => {
    expect(normalizeThinkingBudget(500, 'opus', opus)).toBe(ANTHROPIC_THINKING_MIN)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps valid Anthropic budgets unchanged', () => {
    expect(normalizeThinkingBudget(4096, 'opus', opus)).toBe(4096)
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('passes sub-1024 through for OpenAI-shaped capabilities', () => {
    expect(normalizeThinkingBudget(500, 'gpt-5.4', gpt)).toBe(500)
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('passes through for non-thinking models without warning here', () => {
    // The adapter handles the warn-and-drop; normalization just passes the
    // raw value along so the adapter can do its capability check.
    expect(normalizeThinkingBudget(4096, 'minimax', minimax)).toBe(4096)
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})
