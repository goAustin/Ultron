/**
 * SDK public types — single import point for consumers.
 * Only stable, public types are re-exported here.
 */

// Message types
export type { Message, UserMessage, AssistantMessage, ContentBlock } from '../core/messages.js'

// Event types
export type { QueryEvent } from '../core/queryEvents.js'

// Terminal
export type { Terminal, TerminalReason } from '../core/queryTypes.js'

// Permission callback types (for custom askUser/logDecision implementations)
export type { AskUserFn, LogPermissionDecisionFn } from '../core/permissions/types.js'
export type { PermissionMode } from '../core/state.js'

// Engine
export type { QueryEngineConfig } from './QueryEngine.js'
