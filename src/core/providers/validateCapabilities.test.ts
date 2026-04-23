import { describe, it, expect } from 'vitest'

import type { ProviderAdapter, ModelEntry } from './types.js'
import { assertCapabilitiesPopulated } from './validateCapabilities.js'

const goodModel: ModelEntry = {
  id: 'good-1',
  provider: 'fake',
  label: 'Good Model',
  description: 'populated',
  maxContextTokens: 100_000,
  maxOutputTokens: 10_000,
  supportsThinking: false,
  supportsInterleavedThinking: false,
  promptCacheModel: 'implicit',
}

function makeAdapter(id: string, models: readonly ModelEntry[]): ProviderAdapter {
  return {
    id,
    displayName: id,
    envKeyName: `${id.toUpperCase()}_API_KEY`,
    models,
    // Not exercised by the validator.
    createCallModel: (() => { throw new Error('unused') }) as ProviderAdapter['createCallModel'],
  }
}

describe('assertCapabilitiesPopulated', () => {
  it('does not throw when every model has all capability fields populated', () => {
    const adapter = makeAdapter('fake', [goodModel])
    expect(() => assertCapabilitiesPopulated([adapter])).not.toThrow()
  })

  it('does not throw for an empty list of adapters', () => {
    expect(() => assertCapabilitiesPopulated([])).not.toThrow()
  })

  it('does not throw for an adapter with no models', () => {
    const adapter = makeAdapter('fake', [])
    expect(() => assertCapabilitiesPopulated([adapter])).not.toThrow()
  })

  it('throws naming adapter id, model id, and the missing field', () => {
    const broken: ModelEntry = { ...goodModel, id: 'broken-1' }
    // Strip one field to simulate a forgetful adapter author.
    delete (broken as unknown as Record<string, unknown>).maxContextTokens
    const adapter = makeAdapter('offender', [broken])

    let caught: Error | undefined
    try {
      assertCapabilitiesPopulated([adapter])
    } catch (e) {
      caught = e as Error
    }

    expect(caught).toBeDefined()
    expect(caught!.message).toContain('offender')
    expect(caught!.message).toContain('broken-1')
    expect(caught!.message).toContain('maxContextTokens')
  })

  it('lists all missing fields in a single message', () => {
    const broken: ModelEntry = { ...goodModel, id: 'broken-2' }
    delete (broken as unknown as Record<string, unknown>).maxOutputTokens
    delete (broken as unknown as Record<string, unknown>).supportsThinking
    delete (broken as unknown as Record<string, unknown>).promptCacheModel
    const adapter = makeAdapter('offender', [broken])

    let caught: Error | undefined
    try {
      assertCapabilitiesPopulated([adapter])
    } catch (e) {
      caught = e as Error
    }

    expect(caught).toBeDefined()
    expect(caught!.message).toContain('maxOutputTokens')
    expect(caught!.message).toContain('supportsThinking')
    expect(caught!.message).toContain('promptCacheModel')
  })
})
