import { describe, it, expect, vi } from 'vitest'
import { runToolUse, authorizeToolUse, executeToolUse } from './runToolUse.js'
import { buildTool } from './types.js'
import type { Tool, ToolResult } from './types.js'
import type { ToolUseContext } from './context.js'
import { createToolUseContext } from './context.js'
import { createToolRegistry } from './registry.js'
import { createStore, getDefaultAppState } from '../state.js'
import type { PermissionOptions, SafetyCheck } from '../permissions/types.js'
import type { ToolUseBlock } from '../messages.js'
import { toolUseId } from '../messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId('tu-1'), name, input }
}

/** Default context uses bypassPermissions so pipeline tests are not blocked by the engine fallback. */
function makeContext(tools: Tool[] = [], opts?: { permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' }): ToolUseContext {
  const registry = createToolRegistry()
  for (const t of tools) registry.register(t)
  return createToolUseContext({
    appState: createStore({
      ...getDefaultAppState(),
      permissionMode: opts?.permissionMode ?? 'bypassPermissions',
    }),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: registry,
  })
}

function makeSignal(aborted = false): AbortSignal {
  const ac = new AbortController()
  if (aborted) ac.abort()
  return ac.signal
}

function okTool(name = 'TestTool'): Tool {
  return buildTool({
    name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    call: async () => ({ content: 'ok', isError: false }),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runToolUse', () => {
  it('returns tool_not_found for unknown tool', async () => {
    const ctx = makeContext()
    const result = await runToolUse(makeToolUse('Ghost'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('tool_not_found')
    expect(result.content).toContain('Ghost')
  })

  it('returns successful result for valid tool', async () => {
    const tool = okTool()
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('TestTool'), ctx, makeSignal())
    expect(result).toEqual({ content: 'ok', isError: false })
  })

  it('returns validation_failed when validateInput rejects', async () => {
    const tool = buildTool({
      name: 'Strict',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      validateInput: async () => ({ valid: false, message: 'missing required field' }),
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('Strict'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('validation_failed')
    expect(result.content).toContain('missing required field')
  })

  it('does not call tool.call when validation fails', async () => {
    const callFn = vi.fn(async () => ({ content: 'called', isError: false }))
    const tool = buildTool({
      name: 'Guarded',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
      validateInput: async () => ({ valid: false, message: 'nope' }),
    })
    const ctx = makeContext([tool])
    await runToolUse(makeToolUse('Guarded'), ctx, makeSignal())
    expect(callFn).not.toHaveBeenCalled()
  })

  it('returns permission_denied when checkPermissions denies', async () => {
    const tool = buildTool({
      name: 'Locked',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      checkPermissions: async () => ({ behavior: 'deny', message: 'not allowed' }),
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('Locked'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('permission_denied')
    expect(result.content).toContain('not allowed')
  })

  it('returns permission_ask when checkPermissions asks (no UI)', async () => {
    const tool = buildTool({
      name: 'NeedsApproval',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      checkPermissions: async () => ({ behavior: 'ask', message: 'confirm edit?' }),
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('NeedsApproval'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('permission_ask')
    expect(result.content).toContain('confirm edit?')
  })

  it('does not call tool.call when permission denied', async () => {
    const callFn = vi.fn(async () => ({ content: 'called', isError: false }))
    const tool = buildTool({
      name: 'Locked',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
      checkPermissions: async () => ({ behavior: 'deny', message: 'no' }),
    })
    const ctx = makeContext([tool])
    await runToolUse(makeToolUse('Locked'), ctx, makeSignal())
    expect(callFn).not.toHaveBeenCalled()
  })

  it('catches tool.call errors and returns execution_error', async () => {
    const tool = buildTool({
      name: 'Crasher',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => { throw new Error('boom') },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('Crasher'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('execution_error')
    expect(result.content).toContain('boom')
  })

  it('catches validateInput errors and returns validation_failed', async () => {
    const tool = buildTool({
      name: 'BadValidator',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      validateInput: async () => { throw new Error('validator crashed') },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('BadValidator'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('validation_failed')
    expect(result.content).toContain('validator crashed')
  })

  it('catches checkPermissions errors and returns permission_denied', async () => {
    const tool = buildTool({
      name: 'BadPerms',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      checkPermissions: async () => { throw new Error('perms crashed') },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('BadPerms'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('permission_denied')
    expect(result.content).toContain('perms crashed')
  })

  // ---------------------------------------------------------------------------
  // Abort tests
  // ---------------------------------------------------------------------------

  it('returns abort result when signal already aborted', async () => {
    const tool = okTool()
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('TestTool'), ctx, makeSignal(true))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('aborted')
  })

  it('does not call tool.call when signal already aborted', async () => {
    const callFn = vi.fn(async () => ({ content: 'called', isError: false }))
    const tool = buildTool({
      name: 'NeverCalled',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
    })
    const ctx = makeContext([tool])
    await runToolUse(makeToolUse('NeverCalled'), ctx, makeSignal(true))
    expect(callFn).not.toHaveBeenCalled()
  })

  it('returns abort result when aborted after validation', async () => {
    const ac = new AbortController()
    const tool = buildTool({
      name: 'SlowPerms',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      validateInput: async () => {
        // Abort during validation — next checkpoint catches it
        ac.abort()
        return { valid: true as const }
      },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('SlowPerms'), ctx, ac.signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('aborted')
  })

  it('returns abort result when aborted after permissions', async () => {
    const ac = new AbortController()
    const tool = buildTool({
      name: 'SlowCall',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'should not reach', isError: false }),
      checkPermissions: async () => {
        // Abort during permission check — next checkpoint catches it
        ac.abort()
        return { behavior: 'allow' as const }
      },
    })
    const ctx = makeContext([tool])
    const result = await runToolUse(makeToolUse('SlowCall'), ctx, ac.signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('aborted')
  })

  it('passes input through to tool.call', async () => {
    const callFn = vi.fn(async () => ({ content: 'ok', isError: false }))
    const tool = buildTool({
      name: 'Echo',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
    })
    const ctx = makeContext([tool])
    const input = { file_path: '/tmp/test.txt', content: 'hello' }
    await runToolUse(makeToolUse('Echo', input), ctx, makeSignal())
    expect(callFn).toHaveBeenCalledWith(input, ctx, expect.any(AbortSignal))
  })

  it('passes signal through to tool.call', async () => {
    const signal = makeSignal()
    const callFn = vi.fn(async (_input: Record<string, unknown>, _ctx: unknown, s: AbortSignal) => {
      expect(s).toBe(signal)
      return { content: 'ok', isError: false }
    })
    const tool = buildTool({
      name: 'SignalCheck',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: callFn,
    })
    const ctx = makeContext([tool])
    await runToolUse(makeToolUse('SignalCheck'), ctx, signal)
    expect(callFn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// authorize/execute split (Phase 2a)
// ---------------------------------------------------------------------------

describe('authorizeToolUse', () => {
  it('returns authorized on auto-allow', async () => {
    const ctx = makeContext([okTool()])
    const auth = await authorizeToolUse(makeToolUse('TestTool'), ctx, makeSignal())
    expect(auth.outcome).toBe('authorized')
    if (auth.outcome === 'authorized') {
      expect(auth.decision.decision).toBe('allow')
    }
  })

  it('returns precondition_failed with tool_not_found synthetic for unknown tool', async () => {
    const ctx = makeContext([])
    const auth = await authorizeToolUse(makeToolUse('Missing'), ctx, makeSignal())
    expect(auth.outcome).toBe('precondition_failed')
    if (auth.outcome === 'precondition_failed') {
      expect(auth.syntheticResult.errorKind).toBe('tool_not_found')
    }
  })

  // Phase 7a — pre-resolution scope gate. The gate fires BEFORE registry
  // resolve, so an out-of-scope tool name produces a permission deny instead
  // of `tool_not_found`. This is the regression-guard that proves a filtered
  // subagent registry surfaces out-of-scope calls as policy decisions, not
  // precondition failures.
  it('returns denied with agentScope reason BEFORE resolve when tool is outside scopedToolAllowlist (agent)', async () => {
    // Registry intentionally does NOT contain `Glob` — mirrors a filtered
    // subagent registry. With no scope opts, this would surface as
    // tool_not_found; with scope opts, the pre-resolution gate denies first.
    const ctx = makeContext([okTool('FileRead')])
    const permissionOpts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      scopedToolAllowlist: ['FileRead'],
      scopeSource: 'agent',
    }
    const auth = await authorizeToolUse(makeToolUse('Glob'), ctx, makeSignal(), permissionOpts)
    expect(auth.outcome).toBe('denied')
    if (auth.outcome === 'denied') {
      expect(auth.syntheticResult.errorKind).toBe('permission_denied')
      expect(auth.decision.decision).toBe('deny')
      expect(auth.decision.reason).toContain("subagent's allowed tools")
    }
  })

  it('returns denied with skillScope reason BEFORE resolve when tool is outside scopedToolAllowlist (default skill)', async () => {
    const ctx = makeContext([okTool('FileRead')])
    const permissionOpts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      scopedToolAllowlist: ['FileRead'],
      // scopeSource omitted → defaults to skillScope behavior
    }
    const auth = await authorizeToolUse(makeToolUse('Glob'), ctx, makeSignal(), permissionOpts)
    expect(auth.outcome).toBe('denied')
    if (auth.outcome === 'denied') {
      expect(auth.syntheticResult.errorKind).toBe('permission_denied')
      expect(auth.decision.reason).toContain("active skill's allowed-tools")
    }
  })

  it('pre-resolution gate is a no-op when scopedToolAllowlist is undefined', async () => {
    const ctx = makeContext([])
    const permissionOpts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
    }
    const auth = await authorizeToolUse(makeToolUse('Missing'), ctx, makeSignal(), permissionOpts)
    // Falls through to the normal resolve step → tool_not_found.
    expect(auth.outcome).toBe('precondition_failed')
    if (auth.outcome === 'precondition_failed') {
      expect(auth.syntheticResult.errorKind).toBe('tool_not_found')
    }
  })

  // Phase 7a + post-7c fix — the pre-resolution gate must not steal the
  // cascade's explicit-deny precedence when the tool resolves. With a skill
  // scope active and a user deny rule for an out-of-scope tool that IS in
  // the (unfiltered) parent registry, the audit reason must be `rule`, not
  // `skillScope`. Otherwise the cascade invariant in permissions.ts:65-79
  // — "explicit deny wins over scope" — is silently violated.
  it('explicit user deny rule wins over skillScope when the tool is resolvable (cascade invariant)', async () => {
    const tool = okTool('Glob') // tool IS in the registry — parent's view.
    const ctx = makeContext([tool])
    // Inject the deny rule onto AppState so the cascade picks it up at step 1.
    const rules = ctx.appState.getState().permissionRules
    ctx.appState.setState({
      permissionRules: [
        ...rules,
        { toolName: 'Glob', behavior: 'deny', source: 'userSettings' },
      ],
    })
    const permissionOpts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      scopedToolAllowlist: ['FileRead'], // skill restricts; Glob is out of scope.
      // scopeSource omitted → default skill semantics.
    }
    const auth = await authorizeToolUse(makeToolUse('Glob'), ctx, makeSignal(), permissionOpts)
    expect(auth.outcome).toBe('denied')
    if (auth.outcome === 'denied') {
      // Cascade reason wins; reason text refers to the rule, not the scope.
      expect(auth.decision.reason).not.toContain("active skill's allowed-tools")
      expect(auth.decision.reason).not.toContain("subagent's allowed tools")
      expect(auth.decision.reason).toContain('rule')
    }
  })

  it('returns precondition_failed with validation_failed synthetic', async () => {
    const tool = buildTool({
      name: 'Strict',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'nope', isError: false }),
      validateInput: async () => ({ valid: false, message: 'missing field' }),
    })
    const ctx = makeContext([tool])
    const auth = await authorizeToolUse(makeToolUse('Strict'), ctx, makeSignal())
    expect(auth.outcome).toBe('precondition_failed')
    if (auth.outcome === 'precondition_failed') {
      expect(auth.syntheticResult.errorKind).toBe('validation_failed')
    }
  })

  it('returns denied with permission_denied synthetic on engine deny', async () => {
    const tool = buildTool({
      name: 'Locked',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'x', isError: false }),
      checkPermissions: async () => ({ behavior: 'deny', message: 'nope' }),
    })
    const ctx = makeContext([tool])
    const auth = await authorizeToolUse(makeToolUse('Locked'), ctx, makeSignal())
    expect(auth.outcome).toBe('denied')
    if (auth.outcome === 'denied') {
      expect(auth.syntheticResult.errorKind).toBe('permission_denied')
      expect(auth.decision.decision).toBe('deny')
    }
  })

  it('returns precondition_failed with aborted synthetic when signal is already aborted', async () => {
    const ctx = makeContext([okTool()])
    const auth = await authorizeToolUse(makeToolUse('TestTool'), ctx, makeSignal(true))
    expect(auth.outcome).toBe('precondition_failed')
    if (auth.outcome === 'precondition_failed') {
      expect(auth.syntheticResult.errorKind).toBe('aborted')
    }
  })

  it('records allow_by_rule userResponse and ruleCreated on ask path', async () => {
    const tool = buildTool({
      name: 'Ask',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      checkPermissions: async () => ({ behavior: 'ask', message: 'confirm?' }),
    })
    const ctx = makeContext([tool], { permissionMode: 'default' })
    const permissionOpts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => 'allow_by_rule',
    }
    const auth = await authorizeToolUse(makeToolUse('Ask'), ctx, makeSignal(), permissionOpts)
    expect(auth.outcome).toBe('authorized')
    if (auth.outcome === 'authorized') {
      expect(auth.decision.userResponse).toBe('allow_by_rule')
      expect(auth.decision.ruleCreated?.toolName).toBe('Ask')
    }
  })

  describe('allow_by_rule scope construction (Phase 6a)', () => {
    function askingTool(specOverrides: {
      name: string
      getPath?: (input: Record<string, unknown>) => string
      getDomain?: (input: Record<string, unknown>) => string | undefined
    }) {
      return buildTool({
        ...specOverrides,
        inputSchema: { type: 'object', properties: {}, required: [] },
        call: async () => ({ content: 'ok', isError: false }),
        checkPermissions: async () => ({ behavior: 'ask', message: 'confirm?' }),
      })
    }

    const allowByRuleOpts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => 'allow_by_rule',
    }

    it('rule includes path when getPath defined', async () => {
      const tool = askingTool({ name: 'PathOnly', getPath: () => '/p' })
      const ctx = makeContext([tool])
      const auth = await authorizeToolUse(makeToolUse('PathOnly'), ctx, makeSignal(), allowByRuleOpts)
      if (auth.outcome === 'authorized') {
        expect(auth.decision.ruleCreated).toEqual({
          toolName: 'PathOnly',
          behavior: 'allow',
          path: '/p',
          source: 'session',
        })
      }
    })

    it('rule includes domain when getDomain defined', async () => {
      const tool = askingTool({ name: 'DomOnly', getDomain: () => 'github.com' })
      const ctx = makeContext([tool])
      const auth = await authorizeToolUse(makeToolUse('DomOnly'), ctx, makeSignal(), allowByRuleOpts)
      if (auth.outcome === 'authorized') {
        expect(auth.decision.ruleCreated).toEqual({
          toolName: 'DomOnly',
          behavior: 'allow',
          domain: 'github.com',
          source: 'session',
        })
      }
    })

    it('rule includes both path and domain when both defined', async () => {
      const tool = askingTool({ name: 'Both', getPath: () => '/p', getDomain: () => 'github.com' })
      const ctx = makeContext([tool])
      const auth = await authorizeToolUse(makeToolUse('Both'), ctx, makeSignal(), allowByRuleOpts)
      if (auth.outcome === 'authorized') {
        expect(auth.decision.ruleCreated).toEqual({
          toolName: 'Both',
          behavior: 'allow',
          path: '/p',
          domain: 'github.com',
          source: 'session',
        })
      }
    })

    it('rule is tool-name only when neither getPath nor getDomain defined', async () => {
      const tool = askingTool({ name: 'Bare' })
      const ctx = makeContext([tool])
      const auth = await authorizeToolUse(makeToolUse('Bare'), ctx, makeSignal(), allowByRuleOpts)
      if (auth.outcome === 'authorized') {
        expect(auth.decision.ruleCreated).toEqual({
          toolName: 'Bare',
          behavior: 'allow',
          source: 'session',
        })
      }
    })

    it('refuses to construct rule when domain-bearing tool returns undefined and no path', async () => {
      const tool = askingTool({ name: 'NoDomain', getDomain: () => undefined })
      const ctx = makeContext([tool])
      const auth = await authorizeToolUse(makeToolUse('NoDomain'), ctx, makeSignal(), allowByRuleOpts)
      if (auth.outcome === 'authorized') {
        expect(auth.decision.ruleCreated).toBeUndefined()
        // user response still recorded for audit
        expect(auth.decision.userResponse).toBe('allow_by_rule')
      }
      // and no rule was added to AppState
      expect(ctx.appState.getState().permissionRules).toEqual([])
    })

    it('refuses to construct rule when getDomain returns invalid pattern and no path', async () => {
      const tool = askingTool({ name: 'BadDomain', getDomain: () => 'not a host' })
      const ctx = makeContext([tool])
      const auth = await authorizeToolUse(makeToolUse('BadDomain'), ctx, makeSignal(), allowByRuleOpts)
      if (auth.outcome === 'authorized') {
        expect(auth.decision.ruleCreated).toBeUndefined()
      }
      expect(ctx.appState.getState().permissionRules).toEqual([])
    })

    it('falls back to path-scoped rule when getDomain returns undefined but getPath does not', async () => {
      const tool = askingTool({
        name: 'PathBackup',
        getPath: () => '/p',
        getDomain: () => undefined,
      })
      const ctx = makeContext([tool])
      const auth = await authorizeToolUse(makeToolUse('PathBackup'), ctx, makeSignal(), allowByRuleOpts)
      if (auth.outcome === 'authorized') {
        expect(auth.decision.ruleCreated).toEqual({
          toolName: 'PathBackup',
          behavior: 'allow',
          path: '/p',
          source: 'session',
        })
      }
    })
  })
})

describe('safetyMetadata threading (Phase 4·1)', () => {
  // SafetyCheck that mimics computerUseSafetyCheck — emits typed metadata
  const sensitiveCheck: SafetyCheck = (tool) => {
    if (tool.name !== 'PretendComputer') return null
    return {
      behavior: 'ask',
      reason: {
        type: 'safetyCheck',
        message: 'sensitive action',
        metadata: {
          checkName: 'computerUseSafetyCheck',
          riskLevel: 3,
          riskCategory: 'irreversible',
          evidence: { nearbyText: 'Delete account' },
        },
      },
    }
  }

  it('threads safetyMetadata from a safetyCheck-ask through to AuthorizeDecisionPayload', async () => {
    const tool = okTool('PretendComputer')
    const ctx = makeContext([tool])
    const askSpy = vi.fn<
      (
        toolName: string,
        input: Record<string, unknown>,
        reason: string,
        signal: AbortSignal,
        opts?: { metadata?: unknown },
      ) => Promise<'allow_once'>
    >(async () => 'allow_once' as const)
    const permissionOpts: PermissionOptions = {
      headless: false,
      safetyChecks: [sensitiveCheck],
      askUser: askSpy,
    }
    const auth = await authorizeToolUse(
      makeToolUse('PretendComputer'),
      ctx,
      makeSignal(),
      permissionOpts,
    )
    expect(auth.outcome).toBe('authorized')
    if (auth.outcome === 'authorized') {
      expect(auth.decision.safetyMetadata).toEqual({
        checkName: 'computerUseSafetyCheck',
        riskLevel: 3,
        riskCategory: 'irreversible',
        evidence: { nearbyText: 'Delete account' },
      })
    }
    // askUser receives metadata as the 5th-arg opts.
    expect(askSpy).toHaveBeenCalledTimes(1)
    const askArgs = askSpy.mock.calls[0]!
    expect(askArgs[4]).toMatchObject({
      metadata: { riskLevel: 3, riskCategory: 'irreversible' },
    })
  })

  it('threads safetyMetadata through headless escalation (fix #4)', async () => {
    // Without the recursive unwrap in extractSafetyMetadata, headless mode
    // wraps the original safetyCheck reason in headlessEscalation and the
    // riskLevel disappears from audit.
    const tool = okTool('PretendComputer')
    const ctx = makeContext([tool])
    const permissionOpts: PermissionOptions = {
      headless: true, // forces ask → deny escalation
      safetyChecks: [sensitiveCheck],
    }
    const auth = await authorizeToolUse(
      makeToolUse('PretendComputer'),
      ctx,
      makeSignal(),
      permissionOpts,
    )
    expect(auth.outcome).toBe('denied')
    if (auth.outcome === 'denied') {
      expect(auth.decision.decision).toBe('deny')
      // Critical: metadata must survive headlessEscalation wrapping.
      expect(auth.decision.safetyMetadata).toEqual({
        checkName: 'computerUseSafetyCheck',
        riskLevel: 3,
        riskCategory: 'irreversible',
        evidence: { nearbyText: 'Delete account' },
      })
    }
  })

  it('non-safetyCheck reasons get undefined safetyMetadata', async () => {
    const tool = okTool('Foo')
    const ctx = makeContext([tool])
    // Add an explicit ask rule → reason.type === 'rule', no metadata
    ctx.appState.setState({
      permissionRules: [{ toolName: 'Foo', behavior: 'ask', source: 'userSettings' }],
    })
    const permissionOpts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => 'allow_once' as const,
    }
    const auth = await authorizeToolUse(makeToolUse('Foo'), ctx, makeSignal(), permissionOpts)
    if (auth.outcome === 'authorized') {
      expect(auth.decision.safetyMetadata).toBeUndefined()
    }
  })
})

describe('executeToolUse', () => {
  it('runs tool.call without checking permissions (caller authorizes)', async () => {
    const tool = okTool()
    const ctx = makeContext([tool])
    const result = await executeToolUse(makeToolUse('TestTool'), ctx, makeSignal())
    expect(result).toEqual({ content: 'ok', isError: false })
  })

  it('returns tool_not_found when the tool is not registered', async () => {
    const ctx = makeContext([])
    const result = await executeToolUse(makeToolUse('Ghost'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('tool_not_found')
  })

  it('wraps thrown errors as execution_error', async () => {
    const tool = buildTool({
      name: 'Crash',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => { throw new Error('boom') },
    })
    const ctx = makeContext([tool])
    const result = await executeToolUse(makeToolUse('Crash'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('execution_error')
  })

  it('returns aborted when signal is already aborted', async () => {
    const tool = okTool()
    const ctx = makeContext([tool])
    const result = await executeToolUse(makeToolUse('TestTool'), ctx, makeSignal(true))
    expect(result.errorKind).toBe('aborted')
  })

  it('re-validates input (2b contract): returns validation_failed on rejection', async () => {
    const call = vi.fn().mockResolvedValue({ content: 'should not run', isError: false })
    const tool = buildTool({
      name: 'ValidateOnly',
      inputSchema: { type: 'object', properties: {}, required: [] },
      validateInput: async () => ({ valid: false, message: 'bad input' }),
      call,
    })
    const ctx = makeContext([tool])
    const result = await executeToolUse(makeToolUse('ValidateOnly'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('validation_failed')
    expect(call).not.toHaveBeenCalled()
  })

  it('re-validates input (2b contract): catches thrown validator errors', async () => {
    const tool = buildTool({
      name: 'ValidatorBoom',
      inputSchema: { type: 'object', properties: {}, required: [] },
      validateInput: async () => { throw new Error('validator crashed') },
      call: async () => ({ content: 'unreachable', isError: false }),
    })
    const ctx = makeContext([tool])
    const result = await executeToolUse(makeToolUse('ValidatorBoom'), ctx, makeSignal())
    expect(result.isError).toBe(true)
    expect(result.errorKind).toBe('validation_failed')
  })

  // -------------------------------------------------------------------------
  // Phase 7c — per-call rebind of forkSubagent
  // -------------------------------------------------------------------------

  it('binds the per-call forkSubagent from engineForkSubagent, capturing the parent toolUse.id', async () => {
    const captured: { prompt: string; parentToolUseId: string }[] = []

    // Tool that consumes the per-call unary forkSubagent and asserts it
    // ends up calling engineForkSubagent with both args.
    const toolThatForks: Tool = buildTool({
      name: 'TestForker',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async (_input, ctx) => {
        if (!ctx.forkSubagent) {
          return { content: 'no fork available', isError: true }
        }
        await ctx.forkSubagent('test-prompt')
        return { content: 'ok', isError: false }
      },
    })

    const registry = createToolRegistry()
    registry.register(toolThatForks)

    const ctx = createToolUseContext({
      appState: createStore({
        ...getDefaultAppState(),
        permissionMode: 'bypassPermissions' as const,
      } as import('../state.js').AppState),
      abortController: new AbortController(),
      messages: [],
      toolRegistry: registry,
      engineForkSubagent: async (prompt, parentToolUseId) => {
        captured.push({ prompt, parentToolUseId })
        return {
          text: '',
          terminal: { reason: 'end_turn', messages: [] },
          subagentId: 'sub-1',
        }
      },
    })

    const tu: ToolUseBlock = {
      type: 'tool_use',
      id: toolUseId('tu_seven_c_parent'),
      name: 'TestForker',
      input: {},
    }
    const result = await executeToolUse(tu, ctx, makeSignal())

    expect(result.isError).toBe(false)
    expect(captured).toEqual([
      { prompt: 'test-prompt', parentToolUseId: 'tu_seven_c_parent' },
    ])

    // The static context never carries forkSubagent — only the per-call
    // callContext does. (This is the contract that prevents any tool from
    // accidentally reading a stale unary fn outside its own call.)
    expect(ctx.forkSubagent).toBeUndefined()
    expect(ctx.engineForkSubagent).toBeDefined()
  })

  it('per-call forkSubagent is undefined when engineForkSubagent is unset', async () => {
    const toolReadingFork: Tool = buildTool({
      name: 'TestForker',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async (_input, ctx) => ({
        content: ctx.forkSubagent ? 'has-fork' : 'no-fork',
        isError: false,
      }),
    })
    const ctx = makeContext([toolReadingFork])
    // engineForkSubagent not set → callContext.forkSubagent must stay undefined.
    const result = await executeToolUse(makeToolUse('TestForker'), ctx, makeSignal())
    expect(result.content).toBe('no-fork')
  })
})
