import { describe, it, expect } from 'vitest'

import { allModels, getAdapter, listProviders, resolveCapabilities, resolveModel } from './registry.js'
import { UnknownModelError } from './types.js'

describe('provider registry', () => {
  it('registers anthropic, openai, and minimax adapters', () => {
    const ids = listProviders().map(a => a.id)
    expect(ids).toContain('anthropic')
    expect(ids).toContain('openai')
    expect(ids).toContain('minimax')
  })

  it('getAdapter returns the matching adapter', () => {
    expect(getAdapter('anthropic').envKeyName).toBe('ANTHROPIC_API_KEY')
    expect(getAdapter('openai').envKeyName).toBe('OPENAI_API_KEY')
    expect(getAdapter('minimax').envKeyName).toBe('MINIMAX_API_KEY')
  })

  it('getAdapter throws on unknown provider id', () => {
    expect(() => getAdapter('gemini')).toThrow(/Unknown provider/)
  })

  it('resolveModel finds minimax models', () => {
    const { adapter, entry } = resolveModel('MiniMax-M2.7')
    expect(adapter.id).toBe('minimax')
    expect(entry.id).toBe('MiniMax-M2.7')
    expect(entry.provider).toBe('minimax')
  })

  it('resolveModel finds anthropic models', () => {
    const { adapter, entry } = resolveModel('claude-sonnet-4-6')
    expect(adapter.id).toBe('anthropic')
    expect(entry.id).toBe('claude-sonnet-4-6')
    expect(entry.provider).toBe('anthropic')
  })

  it('resolveModel finds openai models', () => {
    const { adapter, entry } = resolveModel('gpt-5.4-mini')
    expect(adapter.id).toBe('openai')
    expect(entry.id).toBe('gpt-5.4-mini')
    expect(entry.provider).toBe('openai')
  })

  it('resolveModel throws UnknownModelError for unregistered ids', () => {
    expect(() => resolveModel('not-a-real-model')).toThrow(UnknownModelError)
  })

  it('allModels merges every adapter\'s catalog', () => {
    const all = allModels()
    const providers = listProviders()
    const expectedTotal = providers.reduce((n, a) => n + a.models.length, 0)

    for (const adapter of providers) {
      expect(all.filter(m => m.provider === adapter.id).length).toBe(adapter.models.length)
    }
    expect(all.length).toBe(expectedTotal)
  })

  it('every model in allModels has a stable id, provider, label, description', () => {
    for (const m of allModels()) {
      expect(m.id).toBeTruthy()
      expect(m.provider).toBeTruthy()
      expect(m.label).toBeTruthy()
      expect(typeof m.description).toBe('string')
    }
  })

  it('every model in allModels has all capability fields populated', () => {
    for (const m of allModels()) {
      expect(typeof m.maxContextTokens).toBe('number')
      expect(m.maxContextTokens).toBeGreaterThan(0)
      expect(typeof m.maxOutputTokens).toBe('number')
      expect(m.maxOutputTokens).toBeGreaterThan(0)
      expect(typeof m.supportsThinking).toBe('boolean')
      expect(typeof m.supportsInterleavedThinking).toBe('boolean')
      expect(['explicit', 'implicit', 'none']).toContain(m.promptCacheModel)
    }
  })

  it('resolveCapabilities returns the expected sheet for claude-opus-4-7', () => {
    expect(resolveCapabilities('claude-opus-4-7')).toEqual({
      maxContextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      supportsInterleavedThinking: true,
      promptCacheModel: 'explicit',
    })
  })

  it('resolveCapabilities returns implicit caching for gpt-5.4-mini', () => {
    const sheet = resolveCapabilities('gpt-5.4-mini')
    expect(sheet.maxContextTokens).toBe(400_000)
    expect(sheet.supportsThinking).toBe(true)
    expect(sheet.supportsInterleavedThinking).toBe(false)
    expect(sheet.promptCacheModel).toBe('implicit')
  })

  it('resolveCapabilities marks MiniMax-M2.7 as non-thinking with implicit caching', () => {
    const sheet = resolveCapabilities('MiniMax-M2.7')
    expect(sheet.supportsThinking).toBe(false)
    expect(sheet.supportsInterleavedThinking).toBe(false)
    expect(sheet.promptCacheModel).toBe('implicit')
  })

  it('resolveCapabilities throws UnknownModelError for unregistered ids', () => {
    expect(() => resolveCapabilities('not-a-real-model')).toThrow(UnknownModelError)
  })
})
