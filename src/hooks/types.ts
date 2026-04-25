/**
 * Phase 2b — user-configurable shell-command hooks.
 *
 * Hooks are declared in ~/.ultron/hooks.json and run as subprocesses around
 * tool execution. PreToolUse hooks can block or mutate input; PostToolUse
 * hooks can append additional context to the tool result.
 */

import type { ToolResult } from '../core/tools/types.js'

export type HookEventName = 'PreToolUse' | 'PostToolUse'

export type HookDefinition = {
  readonly matcher: string
  readonly command: string
  readonly timeout?: number
}

export type HookConfig = {
  readonly schemaVersion: 1
  readonly hooks: {
    readonly PreToolUse: readonly HookDefinition[]
    readonly PostToolUse: readonly HookDefinition[]
  }
}

// Result of invoking a single hook subprocess. Discriminated on `outcome` so
// that the "block path is typed" invariant holds: every branch with `reason`
// also carries `outcome: 'block'`.
export type HookInvocationResult =
  | {
      readonly outcome: 'ok'
      readonly exitCode: 0
      readonly updatedInput?: Record<string, unknown>
      readonly additionalContext?: string
      readonly stderrPreview: string
      readonly durationMs: number
      readonly outputTruncated: boolean
    }
  | {
      readonly outcome: 'block'
      readonly reason: string
      readonly exitCode: 0 | 2
      readonly stderrPreview: string
      readonly durationMs: number
      readonly outputTruncated: boolean
    }
  | {
      readonly outcome: 'error'
      readonly exitCode?: number
      readonly stderrPreview: string
      readonly durationMs: number
      readonly outputTruncated: boolean
    }
  | {
      readonly outcome: 'timeout'
      readonly stderrPreview: string
      readonly durationMs: number
      readonly outputTruncated: boolean
    }

// Outcome of the PreToolUse hook chain, consumed by the query loop.
export type PreHookOutcome =
  | { readonly kind: 'continue'; readonly updatedInput?: Record<string, unknown> }
  | { readonly kind: 'block'; readonly syntheticResult: ToolResult }

// Outcome of the PostToolUse hook chain. Post hooks can only augment the
// result content; they cannot block.
export type PostHookOutcome = {
  readonly result: ToolResult
}

// Context passed to hook orchestrators. The config is loaded once per engine
// instance and shared across all tool calls (including subagents).
export type HookContext = {
  readonly sessionId: string
  readonly cwd: string
  readonly hookConfig: HookConfig
}

export function emptyHookConfig(): HookConfig {
  return {
    schemaVersion: 1,
    hooks: { PreToolUse: [], PostToolUse: [] },
  }
}
