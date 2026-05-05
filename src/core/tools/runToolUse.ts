/**
 * Single tool execution pipeline — split for Phase 2a, contract widened in 2b.
 *
 * `authorizeToolUse` runs resolve → validate → permissions (engine) → askUser
 * and returns either `{outcome: 'authorized', decision}` or
 * `{outcome: 'denied', decision, syntheticResult}`. It never runs `tool.call`.
 *
 * `executeToolUse` runs tool.call after an input re-validation pass. The
 * re-validation is a deliberate 2b change to the original "call only" contract:
 * PreToolUse hooks can mutate tool_input between authorization and execution,
 * and un-validated mutated input would surprise tool implementations in hard-
 * to-debug ways. Validation is cheap and idempotent for unchanged input.
 * Permissions are NOT re-checked — the caller still owns authorization.
 *
 * `runToolUse` is kept as a compatibility wrapper: authorize → execute, with
 * the same external semantics as before 2a (returns a single `ToolResult`).
 *
 * No exceptions escape any of these — every path returns a typed value.
 */

import type { ToolUseBlock } from '../messages.js'
import type { Tool, ToolResult } from './types.js'
import type { ToolUseContext, ToolProgressInput } from './context.js'
import type {
  PermissionDecisionReason,
  PermissionOptions,
  PermissionRule,
  SafetyMetadata,
} from '../permissions/types.js'
import type {
  AuthorizeDecisionPayload,
  AuthorizeToolOutcome,
} from '../queryDeps.js'
import { DEFAULT_PERMISSION_OPTIONS } from '../permissions/types.js'
import {
  hasPermissionsToUseTool,
  formatDecisionMessage,
  checkScopedAllowlist,
} from '../permissions/permissions.js'
import { isValidDomainPattern } from '../../web/domainPolicy.js'
import { makeErrorResult, makeAbortResult, checkAbort } from './toolExecution.js'
import { checkToolRepetition } from './repetitionGuard.js'

// ---------------------------------------------------------------------------
// authorizeToolUse — resolve + validate + permissions + askUser
// ---------------------------------------------------------------------------

export async function authorizeToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
  permissionOpts: PermissionOptions = DEFAULT_PERMISSION_OPTIONS,
): Promise<AuthorizeToolOutcome> {
  // 1. Check abort — NOT a policy decision; fails the precondition.
  if (signal.aborted) {
    return precondition(makeAbortResult())
  }

  // 2. Resolve tool — NOT a policy decision (when found).
  //
  //    Phase 7a + post-7c fix: the pre-resolution scope gate fires ONLY when
  //    the tool can't be resolved from the registry. Two cases:
  //
  //    (a) Subagent (filtered registry) — out-of-scope tools aren't in the
  //        registry; the gate converts what would otherwise surface as
  //        `tool_not_found` into a proper `agentScope` policy decision.
  //
  //    (b) Parent under a skill activation (unfiltered registry) — the tool
  //        IS in the registry. We MUST fall through to the cascade so
  //        explicit user deny rules win over `skillScope`, preserving the
  //        cascade invariant in `permissions.ts:65-79` (explicit deny → step
  //        1 wins over scope → step 1.5). The cascade contains the same
  //        `checkScopedAllowlist` call at step 1.5; both paths share the
  //        helper, so the deny shape is identical.
  //
  //    The earlier "pre-resolution gate fires unconditionally" structure
  //    short-circuited the cascade and silently demoted explicit-deny
  //    audit reasons to scope reasons in case (b).
  const tool = context.toolRegistry.get(toolUse.name)
  if (!tool) {
    const scopeDecision = checkScopedAllowlist(toolUse.name, permissionOpts)
    if (scopeDecision !== null) {
      const reason = formatDecisionMessage(scopeDecision)
      return denied(
        { decision: 'deny', reason },
        makeErrorResult('permission_denied', reason),
      )
    }
    return precondition(
      makeErrorResult('tool_not_found', `Tool "${toolUse.name}" not found`),
    )
  }

  // 3. Validate input — NOT a policy decision.
  try {
    const validation = await tool.validateInput(toolUse.input, context)
    if (!validation.valid) {
      return precondition(makeErrorResult('validation_failed', validation.message))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return precondition(makeErrorResult('validation_failed', msg))
  }

  // 4. Check abort — still pre-permission, not a policy decision.
  if (signal.aborted) {
    return precondition(makeAbortResult())
  }

  // 5. Check permissions via engine — this is the actual policy decision.
  const decision = await hasPermissionsToUseTool(tool, toolUse, context, permissionOpts)

  // Phase 4·1: structured metadata from a `safetyCheck` reason (Computer-Use
  // risk classifier) rides through the cascade. Captured once here so every
  // exit path gets the same payload.
  //
  // Headless mode wraps the original `safetyCheck` reason in
  // `headlessEscalation` (`permissions.ts:39-44`), so we recursively unwrap
  // to find the underlying safety metadata. Without this unwrap, a
  // headless-denied dangerous action's audit row would lose its riskLevel.
  const safetyMetadata = extractSafetyMetadata(decision.reason)

  if (decision.behavior === 'deny') {
    const reason = formatDecisionMessage(decision)
    return denied(
      {
        decision: 'deny',
        reason,
        ...(safetyMetadata && { safetyMetadata }),
      },
      makeErrorResult('permission_denied', reason),
    )
  }

  if (decision.behavior === 'ask') {
    const reason = formatDecisionMessage(decision)

    if (!permissionOpts.askUser) {
      // No prompt function — preserve permission_ask for external handling.
      // This IS a policy-adjacent outcome: the engine asked, nobody answered,
      // so it's recorded as a deny on the permission event stream.
      return denied(
        { decision: 'ask', reason, ...(safetyMetadata && { safetyMetadata }) },
        makeErrorResult('permission_ask', reason),
      )
    }

    const response = await permissionOpts.askUser(
      toolUse.name,
      toolUse.input,
      reason,
      signal,
      safetyMetadata !== undefined ? { metadata: safetyMetadata } : undefined,
    )

    const ruleCreated: PermissionRule | undefined =
      response === 'allow_by_rule'
        ? buildAllowByRule(toolUse.name, tool, toolUse.input)
        : undefined

    const payload: AuthorizeDecisionPayload = {
      decision: 'ask',
      reason,
      userResponse: response,
      ...(ruleCreated && { ruleCreated }),
      ...(safetyMetadata && { safetyMetadata }),
    }

    if (response === 'abort') {
      return denied(payload, makeAbortResult())
    }

    if (response === 'deny_once') {
      return denied(
        payload,
        makeErrorResult('permission_denied', `User denied: ${reason}`),
      )
    }

    if (response === 'allow_by_rule' && ruleCreated) {
      // Persist exact-match rule to AppState for this session
      const currentRules = context.appState.getState().permissionRules
      context.appState.setState({ permissionRules: [...currentRules, ruleCreated] })
    }

    // Domain-prompt UX — invoke the approval hook for tools that scope to a
    // host. The QueryEngine wires this to update the Computer-Use
    // SessionManager's per-session overlay (allow_once + allow_by_rule) and
    // persist `allowedDomains` for `allow_by_rule`. Errors are warned but
    // do not block the call the user just authorized.
    if (
      (response === 'allow_once' || response === 'allow_by_rule') &&
      permissionOpts.approvedDomainHook !== undefined
    ) {
      const rawHost = tool.getDomain?.(toolUse.input)
      if (typeof rawHost === 'string' && rawHost.length > 0) {
        try {
          await permissionOpts.approvedDomainHook({
            toolName: toolUse.name,
            input: toolUse.input,
            host: rawHost,
            response,
          })
        } catch (err) {
          process.stderr.write(
            `[ultron] warning: approvedDomainHook failed for ${toolUse.name}: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      }
    }

    // allow_once or allow_by_rule — fall through to authorized
    return { outcome: 'authorized', decision: payload }
  }

  // behavior === 'allow'
  return {
    outcome: 'authorized',
    decision: {
      decision: 'allow',
      reason: formatDecisionMessage(decision),
      ...(safetyMetadata && { safetyMetadata }),
    },
  }
}

// ---------------------------------------------------------------------------
// buildAllowByRule — construct a session-scoped allow rule for `allow_by_rule`
//
// Defensive escape: when a tool advertises domain scope (`getDomain` defined)
// but the resolution returns nothing or fails the pattern check, refuse to
// construct an over-broad tool-name-only rule. Returning undefined here means
// the user's `allow_by_rule` answer is recorded but no rule lands in AppState
// — semantically equivalent to `allow_once` for that turn, with the user
// response preserved on the audit envelope.
// ---------------------------------------------------------------------------

function buildAllowByRule(
  toolName: string,
  tool: Tool,
  input: Record<string, unknown>,
): PermissionRule | undefined {
  const path = tool.getPath?.(input)
  const rawDomain = tool.getDomain?.(input)
  const domain = rawDomain !== undefined && isValidDomainPattern(rawDomain)
    ? rawDomain
    : undefined

  // Domain-bearing tool with no usable scope: refuse to construct an
  // over-broad rule. (If the tool also exposes a path that resolved, fall
  // through to a path-scoped rule — that's still a narrow scope.)
  if (tool.getDomain !== undefined && domain === undefined && path === undefined) {
    return undefined
  }

  return {
    toolName,
    behavior: 'allow',
    ...(path !== undefined && { path }),
    ...(domain !== undefined && { domain }),
    source: 'session',
  }
}

// ---------------------------------------------------------------------------
// executeToolUse — re-validate input, then tool.call
// ---------------------------------------------------------------------------

export async function executeToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
  onProgress?: (progress: ToolProgressInput) => void,
): Promise<ToolResult> {
  // Abort check immediately before dispatch — prevents racing into execution after cancel.
  const aborted = checkAbort(signal)
  if (aborted) return aborted

  const tool = context.toolRegistry.get(toolUse.name)
  if (!tool) {
    return makeErrorResult('tool_not_found', `Tool "${toolUse.name}" not found`)
  }

  // Phase 3d: per-call context that carries the progress sink (if any). The
  // shared context stays immutable; concurrent tool calls in a future
  // parallel-execution model wouldn't race on this field.
  //
  // Phase 7c: also rebind `engineForkSubagent` (widened, set by the engine)
  // into the per-call unary `forkSubagent` view AgentTool consumes. The
  // closure captures `toolUse.id` so subagent audit envelopes stamp the
  // correct parent correlation id even under parallel `Agent` fan-out
  // (Phase 7b). Always allocate the shallow copy in this code path — cheap,
  // and avoids a second branch when both onProgress and engineForkSubagent
  // are set.
  const callContext: ToolUseContext = {
    ...context,
    ...(onProgress && { onProgress }),
    ...(context.engineForkSubagent && {
      forkSubagent: (prompt: string) =>
        context.engineForkSubagent!(prompt, toolUse.id),
    }),
  }

  // Phase 2b: re-validate before tool.call. Protects tool implementations
  // from PreToolUse-hook-mutated input that no longer matches the schema.
  // Cheap; idempotent on unchanged input.
  try {
    const validation = await tool.validateInput(toolUse.input, callContext)
    if (!validation.valid) {
      return makeErrorResult('validation_failed', validation.message)
    }
  } catch (err) {
    return makeErrorResult(
      'validation_failed',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Tool-call repetition guard. Catches loops the session-level detector
  // (`SessionManager.recordStep`) misses — e.g., a YouTube auto-preview
  // that keeps the screenshot pHash varying so the "all available signals
  // stalled" fallback never fires, or any non-Computer-Use loop.
  const repetition = checkToolRepetition(toolUse, callContext.messages)
  if (repetition.tripped) {
    return makeErrorResult('execution_error', repetition.reason)
  }

  try {
    return await tool.call(toolUse.input, callContext, signal)
  } catch (err) {
    return makeErrorResult(
      'execution_error',
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ---------------------------------------------------------------------------
// runToolUse — compatibility wrapper: authorize then execute
// ---------------------------------------------------------------------------

export async function runToolUse(
  toolUse: ToolUseBlock,
  context: ToolUseContext,
  signal: AbortSignal,
  permissionOpts: PermissionOptions = DEFAULT_PERMISSION_OPTIONS,
): Promise<ToolResult> {
  const auth = await authorizeToolUse(toolUse, context, signal, permissionOpts)
  if (auth.outcome !== 'authorized') return auth.syntheticResult
  return executeToolUse(toolUse, context, signal)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function denied(
  decision: AuthorizeDecisionPayload,
  syntheticResult: ToolResult,
): AuthorizeToolOutcome {
  return { outcome: 'denied', decision, syntheticResult }
}

function precondition(syntheticResult: ToolResult): AuthorizeToolOutcome {
  return { outcome: 'precondition_failed', syntheticResult }
}

/**
 * Phase 4·1 — recursively unwrap a `PermissionDecisionReason` to find a
 * `safetyCheck.metadata` payload. Headless mode wraps the original safety
 * reason in `{ type: 'headlessEscalation', original: ... }`; without this
 * helper, headless-denied dangerous actions would lose their structured
 * audit metadata.
 */
function extractSafetyMetadata(
  reason: PermissionDecisionReason,
): SafetyMetadata | undefined {
  if (reason.type === 'safetyCheck') return reason.metadata
  if (reason.type === 'headlessEscalation') return extractSafetyMetadata(reason.original)
  return undefined
}
