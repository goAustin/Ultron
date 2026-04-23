/**
 * Provider registry — the single point that maps model ids and provider ids
 * to the concrete `ProviderAdapter` instances.
 *
 * Adding a new provider is a two-line change:
 *   1. Write the adapter file (`newProviderAdapter.ts`) exporting a `ProviderAdapter`.
 *   2. Add it to the `ADAPTERS` map below.
 * No other file needs to change.
 */

import type { ProviderAdapter, ProviderId, ModelEntry, CapabilitySheet } from './types.js'
import { UnknownModelError } from './types.js'
import { anthropicAdapter } from './anthropicAdapter.js'
import { openaiAdapter } from './openaiAdapter.js'
import { minimaxAdapter } from './minimaxAdapter.js'
import { assertCapabilitiesPopulated } from './validateCapabilities.js'

const ADAPTERS: Readonly<Record<string, ProviderAdapter>> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  minimax: minimaxAdapter,
}

// Trip at import time if any registered model is missing capability metadata.
assertCapabilitiesPopulated(Object.values(ADAPTERS))

/** Returns the adapter for a provider id, or throws if the id is unknown. */
export function getAdapter(id: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[id]
  if (!adapter) {
    throw new Error(`Unknown provider: "${id}". Known: ${Object.keys(ADAPTERS).join(', ')}`)
  }
  return adapter
}

/** Resolves a model id to its adapter + catalog entry. Throws `UnknownModelError` if the id isn't registered with any provider. */
export function resolveModel(modelId: string): { adapter: ProviderAdapter; entry: ModelEntry } {
  for (const adapter of Object.values(ADAPTERS)) {
    const entry = adapter.models.find(m => m.id === modelId)
    if (entry) return { adapter, entry }
  }
  throw new UnknownModelError(modelId)
}

/** All models across all registered providers, preserving per-adapter order. */
export function allModels(): readonly ModelEntry[] {
  return Object.values(ADAPTERS).flatMap(a => a.models)
}

/** All registered adapters (ordered by insertion into `ADAPTERS`). */
export function listProviders(): readonly ProviderAdapter[] {
  return Object.values(ADAPTERS)
}

/** Resolves a model id to its capability sheet. Throws `UnknownModelError` if the id isn't registered. */
export function resolveCapabilities(modelId: string): CapabilitySheet {
  const { entry } = resolveModel(modelId)
  return {
    maxContextTokens: entry.maxContextTokens,
    maxOutputTokens: entry.maxOutputTokens,
    supportsThinking: entry.supportsThinking,
    supportsInterleavedThinking: entry.supportsInterleavedThinking,
    promptCacheModel: entry.promptCacheModel,
  }
}
