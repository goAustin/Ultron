import type { Message } from './messages.js'
import type { QueryDeps } from './queryDeps.js'

// ---------------------------------------------------------------------------
// Query parameters — input to query()
// ---------------------------------------------------------------------------

export type QueryParams = {
  readonly messages: Message[]
  readonly systemPrompt: string
  readonly deps?: Partial<QueryDeps>
  readonly signal?: AbortSignal
  readonly maxTurns?: number                // safety limit, default 100
  readonly maxOutputTokensOverride?: number
}

// ---------------------------------------------------------------------------
// Loop state — mutable state carried between iterations
// ---------------------------------------------------------------------------

export type ContinueReason =
  | 'next_turn'
  | 'max_output_tokens_recovery'
  | 'max_output_tokens_escalate'
  | 'prompt_too_long_compact'

export type LoopState = {
  messages: Message[]
  maxOutputTokensRecoveryCount: number
  maxOutputTokensOverride: number | undefined
  hasAttemptedCompact: boolean
  lastInputTokens: number | undefined
  turnCount: number
  transition: ContinueReason | undefined
}

// ---------------------------------------------------------------------------
// Terminal — return value from query()
// ---------------------------------------------------------------------------

export type TerminalReason =
  | 'end_turn'
  | 'max_turns'
  | 'aborted'
  | 'error'

export type Terminal = {
  readonly reason: TerminalReason
  readonly messages: readonly Message[]
  readonly error?: Error
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TURNS = 100
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
export const ESCALATED_MAX_OUTPUT_TOKENS = 64_000
