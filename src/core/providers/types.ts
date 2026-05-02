/**
 * Provider abstraction — the contract every model provider implements.
 *
 * A `ProviderAdapter` bundles metadata (display name, env-var for keys, model
 * catalog) with a factory that produces a `CallModelFn`. The registry
 * (`./registry.ts`) keys adapters by `id` and lets callers resolve the right
 * adapter from a model id alone, so cross-provider model switches work live.
 */

import type { ApiToolDefinition } from '../tools/registry.js'
import type { CallModelFn } from '../queryDeps.js'

export type ProviderId = 'anthropic' | 'openai' | (string & {})

export type ModelEntry = {
  readonly id: string            // e.g. 'claude-opus-4-7'
  readonly provider: ProviderId
  readonly label: string         // e.g. 'Claude Opus 4.7'
  readonly description: string   // e.g. 'Highest capability'

  // Capability metadata — populated by every adapter; see docs/phase1a-v2-design.md.
  readonly maxContextTokens: number
  readonly maxOutputTokens: number
  readonly supportsThinking: boolean
  readonly supportsInterleavedThinking: boolean
  readonly promptCacheModel: 'explicit' | 'implicit' | 'none'
  // v3 Phase 1: model can receive image inputs (tool-result screenshots,
  // user-message images). Phase 3 will gate Computer-Use tool registration
  // on this. See docs/ultron_v3/v3-phase1-design.md.
  readonly supportsVision: boolean
}

export type CapabilitySheet = Pick<
  ModelEntry,
  | 'maxContextTokens'
  | 'maxOutputTokens'
  | 'supportsThinking'
  | 'supportsInterleavedThinking'
  | 'promptCacheModel'
  | 'supportsVision'
>

export type CreateCallModelOptions = {
  readonly apiKey: string
  readonly model: string
  readonly baseUrl?: string
  readonly tools?: readonly ApiToolDefinition[]
  readonly capabilities: CapabilitySheet
}

export type ProviderAdapter = {
  readonly id: ProviderId
  readonly displayName: string   // used as group header in the /model picker
  readonly envKeyName: string    // e.g. 'ANTHROPIC_API_KEY'
  readonly models: readonly ModelEntry[]
  readonly createCallModel: (opts: CreateCallModelOptions) => CallModelFn
}

export class UnknownModelError extends Error {
  constructor(modelId: string) {
    super(`Unknown model: "${modelId}". Not registered with any provider adapter.`)
    this.name = 'UnknownModelError'
  }
}

export class MissingApiKeyError extends Error {
  readonly envKeyName: string
  constructor(envKeyName: string) {
    super(`Missing ${envKeyName}. Set the env var and retry.`)
    this.name = 'MissingApiKeyError'
    this.envKeyName = envKeyName
  }
}
