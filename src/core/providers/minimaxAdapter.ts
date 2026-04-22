/**
 * MiniMax provider adapter.
 *
 * MiniMax's chat endpoint is OpenAI-compatible, so this adapter is a thin
 * wrapper around `createOpenAICompatibleCallModel` from `./openaiAdapter.ts`
 * with MiniMax-specific metadata (env var, base URL default, model catalog).
 */

import type { ProviderAdapter, ModelEntry, CreateCallModelOptions } from './types.js'
import { createOpenAICompatibleCallModel } from './openaiAdapter.js'

const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1'

const MODELS: readonly ModelEntry[] = [
  { id: 'MiniMax-M2.7', provider: 'minimax', label: 'MiniMax M2.7', description: 'Latest' },
]

export const minimaxAdapter: ProviderAdapter = {
  id: 'minimax',
  displayName: 'MiniMax',
  envKeyName: 'MINIMAX_API_KEY',
  models: MODELS,
  createCallModel: (opts: CreateCallModelOptions) => createOpenAICompatibleCallModel({
    ...opts,
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
  }),
}
