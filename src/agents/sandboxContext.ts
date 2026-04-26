/**
 * Sandbox context — pure construction of the isolated execution surface a
 * forked subagent runs against. Phase 7a's named primitive: extracted from
 * `runAgent.ts` so Phase 7b (parallel fan-out) and Phase 7c (nested audit
 * correlation) have a stable seam to extend.
 *
 * No I/O, no event streaming, no transcript writing. Returns the bundle of
 * state the fork loop needs:
 *
 * - Cloned `AppState` (mutations isolated from parent).
 * - Fresh `ReadFileState`.
 * - Filtered `ToolRegistry` containing only `allowedTools` (`Agent` is
 *   always excluded to prevent recursive subagents).
 * - `AbortController` linked to the parent signal — parent abort cascades
 *   to the child immediately.
 * - `permissionOpts` carrying `scopedToolAllowlist` + `scopeSource: 'agent'`
 *   so the cascade and the pre-resolution gate in `authorizeToolUse` both
 *   deny out-of-scope calls with `agentScope` reason.
 * - `auditWriter` derived from the parent via `withOrigin(subagentId)` so
 *   the parent's audit log carries provenance for every event.
 * - `cleanup()` detaches the parent-abort listener; callers invoke it from
 *   their `finally` block so failed runs don't leak listeners.
 */

import type { Store, AppState } from '../core/state.js'
import { createStore } from '../core/state.js'
import type { ToolRegistry } from '../core/tools/registry.js'
import { createToolRegistry } from '../core/tools/registry.js'
import type { ReadFileState } from '../core/tools/context.js'
import type { PermissionOptions } from '../core/permissions/types.js'
import type { AuditWriter } from '../audit/types.js'
import type { ToolUseId } from '../core/messages.js'

const AGENT_TOOL_NAME = 'Agent'

/**
 * Thrown by `buildFilteredRegistry` when a caller's `allowedTools` resolves
 * to a write-capable tool. Subagents must remain read-only by construction
 * so that `AgentTool.isConcurrencySafe = true` is provably correct under any
 * caller wiring (Phase 7b). The `DEFAULT_ALLOWED_TOOLS` set passes; the
 * invariant only bites callers who explicitly tried to widen.
 */
export class SubagentScopeError extends Error {
  readonly toolName: string
  constructor(toolName: string) {
    super(
      `Subagent allowedTools cannot include write-capable tool "${toolName}" — subagents are read-only by construction`,
    )
    this.name = 'SubagentScopeError'
    this.toolName = toolName
  }
}

export type SandboxContext = {
  readonly appState: Store<AppState>
  readonly readFileState: ReadFileState
  readonly toolRegistry: ToolRegistry
  readonly abortController: AbortController
  readonly permissionOpts: PermissionOptions
  readonly auditWriter: AuditWriter
  readonly cleanup: () => void
}

export type SandboxContextOptions = {
  readonly parentAppState: Store<AppState>
  readonly parentToolRegistry: ToolRegistry
  readonly parentSignal: AbortSignal
  readonly parentPermissionOpts: PermissionOptions
  readonly parentAuditWriter: AuditWriter
  readonly allowedTools: readonly string[]
  readonly subagentId: string
  /**
   * `ToolUseBlock.id` of the parent's `Agent` tool_use that's spawning
   * this subagent (Phase 7c). Stamped onto every audit envelope the
   * subagent emits so downstream consumers can correlate child events
   * back to the parent-side `tool_call_started`. Required: the only
   * caller is `createForkSubagent`, which always knows it.
   */
  readonly parentToolUseId: ToolUseId
}

export function createSandboxContext(opts: SandboxContextOptions): SandboxContext {
  // Compute the effective allowed-tools list ONCE, then use it for both the
  // filtered registry and the `scopedToolAllowlist` carried on the
  // permission opts. Two reasons it must be one list:
  //
  //   1. Parent-scope subset invariant. If the parent is already inside a
  //      scoped activation (a skill restricting the parent to ['FileRead'],
  //      or — in a future Phase 7b/7c nested fork — a parent subagent with
  //      its own scope), the subagent's effective scope must be the
  //      intersection. A naive `scopedToolAllowlist: opts.allowedTools`
  //      would let a subagent widen the parent's scope.
  //   2. Registry/scope agreement. The filtered registry always drops
  //      `Agent` (no recursive subagents). If the scope list still contained
  //      `Agent`, an emitted Agent tool_use would pass the pre-resolution
  //      gate and surface as `tool_not_found` instead of an `agentScope`
  //      deny — defeating the verification clause.
  const effectiveAllowedTools = computeEffectiveAllowedTools(
    opts.allowedTools,
    opts.parentPermissionOpts.scopedToolAllowlist,
  )

  // Synchronous construction first — none of these are expected to throw,
  // but if any do we don't want a leaked abort listener.
  const appState = createStore<AppState>({ ...opts.parentAppState.getState() })
  const readFileState: ReadFileState = new Map()
  const toolRegistry = buildFilteredRegistry(opts.parentToolRegistry, effectiveAllowedTools)
  const permissionOpts: PermissionOptions = {
    ...opts.parentPermissionOpts,
    scopedToolAllowlist: effectiveAllowedTools,
    scopeSource: 'agent',
  }
  const auditWriter = opts.parentAuditWriter.withOrigin(opts.subagentId, {
    parentToolUseId: opts.parentToolUseId,
  })

  // Linked abort — parent abort cascades to child. Attach LAST so an
  // exception during the synchronous setup above can never leak the listener
  // (no `try { addEventListener } catch { removeEventListener }` dance
  // needed if registration is the final step).
  const abortController = new AbortController()
  if (opts.parentSignal.aborted) {
    abortController.abort()
  }
  const onParentAbort = () => abortController.abort()
  opts.parentSignal.addEventListener('abort', onParentAbort, { once: true })
  const cleanup = () => {
    opts.parentSignal.removeEventListener('abort', onParentAbort)
  }

  return {
    appState,
    readFileState,
    toolRegistry,
    abortController,
    permissionOpts,
    auditWriter,
    cleanup,
  }
}

/**
 * Compute the subagent's effective allowed-tools list.
 *
 * - Excludes `Agent` (no recursive subagents).
 * - Intersects with `parentScope` when the parent is already running under a
 *   scoped allowlist, so the subagent can never widen the parent's scope.
 *   When `parentScope` is undefined the parent is unscoped and the
 *   intersection is the identity.
 *
 * Exported for unit testing — kept pure (no I/O, no allocations beyond the
 * returned array) so the property "subagent ⊆ parent" can be exhaustively
 * verified.
 */
export function computeEffectiveAllowedTools(
  requested: readonly string[],
  parentScope: readonly string[] | undefined,
): readonly string[] {
  const effective: string[] = []
  for (const name of requested) {
    if (name === AGENT_TOOL_NAME) continue
    if (parentScope !== undefined && !parentScope.includes(name)) continue
    effective.push(name)
  }
  return effective
}

/**
 * Build a filtered tool registry containing only the named tools.
 *
 * - Always excludes `Agent` (defense in depth — `computeEffectiveAllowedTools`
 *   already drops it, but an external caller could pass an unfiltered list).
 * - Asserts every retained tool has `isReadOnly === true`. Throws
 *   `SubagentScopeError` otherwise. This is the load-bearing invariant
 *   that makes `AgentTool.isConcurrencySafe = true` provably correct
 *   regardless of `SubagentOptions.allowedTools` configuration: if the
 *   subagent registry is non-mutating, parallel subagents cannot race on
 *   shared filesystem/process state.
 * - Names absent from `parentRegistry` are silently dropped (preserves the
 *   prior behavior — the parent decides what's available; the subagent
 *   surface is at most a subset).
 */
export function buildFilteredRegistry(
  parentRegistry: ToolRegistry,
  allowedTools: readonly string[],
): ToolRegistry {
  const filtered = createToolRegistry()
  for (const name of allowedTools) {
    if (name === AGENT_TOOL_NAME) continue
    const tool = parentRegistry.get(name)
    if (!tool) continue
    if (tool.isReadOnly !== true) {
      throw new SubagentScopeError(name)
    }
    filtered.register(tool)
  }
  return filtered
}
