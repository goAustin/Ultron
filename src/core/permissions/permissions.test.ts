import { describe, it, expect, vi } from 'vitest'
import { hasPermissionsToUseTool, formatDecisionMessage } from './permissions.js'
import type { PermissionRule, PermissionOptions, PermissionDecision, SafetyCheck } from './types.js'
import { DEFAULT_PERMISSION_OPTIONS } from './types.js'
import { buildTool } from '../tools/types.js'
import type { Tool } from '../tools/types.js'
import type { ToolUseContext } from '../tools/context.js'
import { createToolUseContext } from '../tools/context.js'
import { createToolRegistry } from '../tools/registry.js'
import { createStore, getDefaultAppState } from '../state.js'
import type { AppState, PermissionMode } from '../state.js'
import type { ToolUseBlock } from '../messages.js'
import { toolUseId } from '../messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tuCounter = 0
function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId(`tu-${++tuCounter}`), name, input }
}

function simpleTool(name: string, opts: { path?: string; domain?: string } = {}): Tool {
  return buildTool({
    name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    call: async () => ({ content: 'ok', isError: false }),
    ...(opts.path !== undefined ? { getPath: () => opts.path! } : {}),
    ...(opts.domain !== undefined ? { getDomain: () => opts.domain! } : {}),
  })
}

// MCP-sourced simple tool for wildcard tests — the registry rejects `mcp__`
// names without source:'mcp'.
function simpleMcpTool(name: string): Tool {
  return {
    name,
    description: 'mcp test tool',
    inputSchema: { type: 'object', properties: {}, required: [] },
    source: 'mcp',
    isMutating: true,
    async validateInput() { return { valid: true } },
    async checkPermissions() { return { behavior: 'allow' } },
    async call() { return { content: 'ok', isError: false } },
  }
}

function makeContext(
  tools: Tool[],
  stateOverrides?: Partial<AppState>,
): ToolUseContext {
  const registry = createToolRegistry()
  for (const t of tools) registry.register(t)
  return createToolUseContext({
    appState: createStore({ ...getDefaultAppState(), ...stateOverrides }),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: registry,
  })
}

function opts(overrides?: Partial<PermissionOptions>): PermissionOptions {
  return { ...DEFAULT_PERMISSION_OPTIONS, ...overrides }
}

// ---------------------------------------------------------------------------
// Step 1: Deny rules always win
// ---------------------------------------------------------------------------

describe('deny rules', () => {
  it('deny rule blocks even with no other constraints', async () => {
    const tool = simpleTool('FileWrite')
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'deny', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({ type: 'rule', rule: rules[0] })
  })

  it('deny rule wins over bypassPermissions mode', async () => {
    const tool = simpleTool('FileWrite')
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'deny', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions', permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('deny')
  })

  it('deny rule with path only matches that path', async () => {
    const tool = simpleTool('FileWrite', { path: '/etc/passwd' })
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'deny', path: '/etc/passwd', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('deny')
  })

  it('deny rule with path does not match different path', async () => {
    const tool = simpleTool('FileWrite', { path: '/tmp/safe.txt' })
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'deny', path: '/etc/passwd', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions', permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// Step 2: Ask rules override bypass
// ---------------------------------------------------------------------------

describe('ask rules', () => {
  it('ask rule produces ask decision', async () => {
    const tool = simpleTool('Bash')
    const rules: PermissionRule[] = [
      { toolName: 'Bash', behavior: 'ask', source: 'projectSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Bash'), ctx, opts())
    expect(decision.behavior).toBe('ask')
    expect(decision.reason).toEqual({ type: 'rule', rule: rules[0] })
  })

  it('ask rule overrides bypassPermissions mode', async () => {
    const tool = simpleTool('Bash')
    const rules: PermissionRule[] = [
      { toolName: 'Bash', behavior: 'ask', source: 'session' },
    ]
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions', permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Bash'), ctx, opts())
    expect(decision.behavior).toBe('ask')
  })
})

// ---------------------------------------------------------------------------
// Step 3: Tool-specific permission checks
// ---------------------------------------------------------------------------

describe('tool-specific permission checks', () => {
  it('tool deny is respected', async () => {
    const tool = buildTool({
      name: 'Dangerous',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      checkPermissions: async () => ({ behavior: 'deny', message: 'blocked by tool' }),
    })
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Dangerous'), ctx, opts())
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({ type: 'toolCheck', message: 'blocked by tool' })
  })

  it('tool ask is respected', async () => {
    const tool = buildTool({
      name: 'NeedsApproval',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      checkPermissions: async () => ({ behavior: 'ask', message: 'confirm this?' }),
    })
    const ctx = makeContext([tool])
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('NeedsApproval'), ctx, opts())
    expect(decision.behavior).toBe('ask')
    expect(decision.reason).toEqual({ type: 'toolCheck', message: 'confirm this?' })
  })

  it('tool allow continues through cascade', async () => {
    const tool = buildTool({
      name: 'Safe',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      checkPermissions: async () => ({ behavior: 'allow' }),
    })
    // default mode, no rules → falls through to ask
    const ctx = makeContext([tool])
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Safe'), ctx, opts())
    expect(decision.behavior).toBe('ask')
    expect(decision.reason).toEqual({ type: 'fallback' })
  })

  it('tool checkPermissions crash is treated as deny', async () => {
    const tool = buildTool({
      name: 'Crasher',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      checkPermissions: async () => { throw new Error('perms exploded') },
    })
    const ctx = makeContext([tool])
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Crasher'), ctx, opts())
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({ type: 'toolCheck', message: 'perms exploded' })
  })
})

// ---------------------------------------------------------------------------
// Step 4: Safety checks (non-bypassable)
// ---------------------------------------------------------------------------

describe('safety checks', () => {
  it('safety check deny blocks even in bypassPermissions', async () => {
    const tool = simpleTool('FileWrite')
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const safetyCheck: SafetyCheck = () => ({
      behavior: 'deny',
      reason: { type: 'safetyCheck', message: 'protected path' },
    })
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('FileWrite'), ctx, opts({ safetyChecks: [safetyCheck] }),
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({ type: 'safetyCheck', message: 'protected path' })
  })

  it('safety check ask prompts even in bypassPermissions', async () => {
    const tool = simpleTool('FileWrite')
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const safetyCheck: SafetyCheck = () => ({
      behavior: 'ask',
      reason: { type: 'safetyCheck', message: 'sensitive file' },
    })
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('FileWrite'), ctx, opts({ safetyChecks: [safetyCheck] }),
    )
    expect(decision.behavior).toBe('ask')
  })

  it('safety check returning null has no effect', async () => {
    const tool = simpleTool('FileWrite')
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const safetyCheck: SafetyCheck = () => null
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('FileWrite'), ctx, opts({ safetyChecks: [safetyCheck] }),
    )
    expect(decision.behavior).toBe('allow')
    expect(decision.reason).toEqual({ type: 'mode', mode: 'bypassPermissions' })
  })

  it('first non-null safety check wins', async () => {
    const tool = simpleTool('FileWrite')
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const check1: SafetyCheck = () => null
    const check2: SafetyCheck = () => ({
      behavior: 'ask',
      reason: { type: 'safetyCheck', message: 'from check2' },
    })
    const check3: SafetyCheck = () => ({
      behavior: 'deny',
      reason: { type: 'safetyCheck', message: 'from check3' },
    })
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('FileWrite'), ctx,
      opts({ safetyChecks: [check1, check2, check3] }),
    )
    expect(decision.behavior).toBe('ask')
    expect(decision.reason).toEqual({ type: 'safetyCheck', message: 'from check2' })
  })
})

// ---------------------------------------------------------------------------
// Step 5: Mode-based resolution
// ---------------------------------------------------------------------------

describe('mode-based resolution', () => {
  it('bypassPermissions auto-allows when no rules or safety blocks', async () => {
    const tool = simpleTool('FileRead')
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileRead'), ctx, opts())
    expect(decision.behavior).toBe('allow')
    expect(decision.reason).toEqual({ type: 'mode', mode: 'bypassPermissions' })
  })

  it('acceptEdits allows file tools (with getPath)', async () => {
    const tool = simpleTool('FileWrite', { path: '/tmp/file.txt' })
    const ctx = makeContext([tool], { permissionMode: 'acceptEdits' })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('allow')
    expect(decision.reason).toEqual({ type: 'mode', mode: 'acceptEdits' })
  })

  it('acceptEdits falls through for non-file tools (no getPath)', async () => {
    const tool = simpleTool('Bash') // no getPath
    const ctx = makeContext([tool], { permissionMode: 'acceptEdits' })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Bash'), ctx, opts())
    expect(decision.behavior).toBe('ask')
    expect(decision.reason).toEqual({ type: 'fallback' })
  })

  it('default mode falls through to ask', async () => {
    const tool = simpleTool('FileRead')
    const ctx = makeContext([tool], { permissionMode: 'default' })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileRead'), ctx, opts())
    expect(decision.behavior).toBe('ask')
    expect(decision.reason).toEqual({ type: 'fallback' })
  })
})

// ---------------------------------------------------------------------------
// Step 6: Explicit allow rules
// ---------------------------------------------------------------------------

describe('allow rules', () => {
  it('allow rule matches in default mode', async () => {
    const tool = simpleTool('FileRead')
    const rules: PermissionRule[] = [
      { toolName: 'FileRead', behavior: 'allow', source: 'session' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileRead'), ctx, opts())
    expect(decision.behavior).toBe('allow')
    expect(decision.reason).toEqual({ type: 'rule', rule: rules[0] })
  })

  it('allow rule with path only matches that path', async () => {
    const tool = simpleTool('FileWrite', { path: '/tmp/ok.txt' })
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'allow', path: '/tmp/ok.txt', source: 'session' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('allow')
  })

  it('allow rule with wrong path does not match', async () => {
    const tool = simpleTool('FileWrite', { path: '/tmp/other.txt' })
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'allow', path: '/tmp/ok.txt', source: 'session' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('ask') // fallback
  })
})

// ---------------------------------------------------------------------------
// Step 7: Fallback
// ---------------------------------------------------------------------------

describe('fallback', () => {
  it('no rules, default mode → ask with fallback reason', async () => {
    const tool = simpleTool('Unknown')
    const ctx = makeContext([tool])
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Unknown'), ctx, opts())
    expect(decision.behavior).toBe('ask')
    expect(decision.reason).toEqual({ type: 'fallback' })
  })
})

// ---------------------------------------------------------------------------
// Headless escalation
// ---------------------------------------------------------------------------

describe('headless escalation', () => {
  it('ask → deny in headless mode with preserved reason', async () => {
    const tool = simpleTool('Bash')
    const ctx = makeContext([tool]) // default mode → fallback ask
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('Bash'), ctx, opts({ headless: true }),
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({
      type: 'headlessEscalation',
      original: { type: 'fallback' },
    })
  })

  it('allow is not affected by headless', async () => {
    const tool = simpleTool('FileRead')
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('FileRead'), ctx, opts({ headless: true }),
    )
    expect(decision.behavior).toBe('allow')
  })

  it('deny is not affected by headless', async () => {
    const tool = simpleTool('Blocked')
    const rules: PermissionRule[] = [
      { toolName: 'Blocked', behavior: 'deny', source: 'cliArg' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('Blocked'), ctx, opts({ headless: true }),
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.reason.type).toBe('rule') // not headlessEscalation
  })

  it('tool ask → headless escalation preserves tool reason', async () => {
    const tool = buildTool({
      name: 'NeedsApproval',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      checkPermissions: async () => ({ behavior: 'ask', message: 'confirm?' }),
    })
    const ctx = makeContext([tool])
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('NeedsApproval'), ctx, opts({ headless: true }),
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({
      type: 'headlessEscalation',
      original: { type: 'toolCheck', message: 'confirm?' },
    })
  })
})

// ---------------------------------------------------------------------------
// Rule matching edge cases
// ---------------------------------------------------------------------------

describe('rule matching', () => {
  it('rule for different tool name does not match', async () => {
    const tool = simpleTool('FileRead')
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'deny', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions', permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileRead'), ctx, opts())
    expect(decision.behavior).toBe('allow') // not denied
  })

  it('rule with path does not match tool without getPath', async () => {
    const tool = simpleTool('Bash') // no getPath
    const rules: PermissionRule[] = [
      { toolName: 'Bash', behavior: 'deny', path: '/etc/passwd', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions', permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Bash'), ctx, opts())
    expect(decision.behavior).toBe('allow') // rule doesn't match, bypass kicks in
  })

  it('rule without path matches any invocation of that tool', async () => {
    const tool = simpleTool('FileWrite', { path: '/any/path' })
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'deny', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Wildcard rules (Phase 3b)
// ---------------------------------------------------------------------------

describe('wildcard rules', () => {
  it('suffix-* rule matches MCP namespace', async () => {
    const tool = simpleMcpTool('mcp__fake__echo')
    const rules: PermissionRule[] = [
      { toolName: 'mcp__fake__*', behavior: 'allow', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('mcp__fake__echo'), ctx, opts())
    expect(decision.behavior).toBe('allow')
    expect(decision.reason).toEqual({ type: 'rule', rule: rules[0] })
  })

  it('suffix-* rule does not match unrelated tool', async () => {
    const tool = simpleTool('Bash')
    const rules: PermissionRule[] = [
      { toolName: 'mcp__fake__*', behavior: 'allow', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Bash'), ctx, opts())
    // falls through to fallback ask
    expect(decision.behavior).toBe('ask')
    expect(decision.reason).toEqual({ type: 'fallback' })
  })

  it('prefix strictness: mcp__fake__* does not match mcp__fake2__foo', async () => {
    const tool = simpleMcpTool('mcp__fake2__foo')
    const rules: PermissionRule[] = [
      { toolName: 'mcp__fake__*', behavior: 'allow', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('mcp__fake2__foo'), ctx, opts())
    expect(decision.behavior).toBe('ask')
  })

  it('mcp__* matches any MCP tool', async () => {
    const toolA = simpleMcpTool('mcp__a__x')
    const toolB = simpleMcpTool('mcp__b__y')
    const rules: PermissionRule[] = [
      { toolName: 'mcp__*', behavior: 'allow', source: 'userSettings' },
    ]
    const ctxA = makeContext([toolA], { permissionRules: rules })
    const decisionA = await hasPermissionsToUseTool(toolA, makeToolUse('mcp__a__x'), ctxA, opts())
    expect(decisionA.behavior).toBe('allow')

    const ctxB = makeContext([toolB], { permissionRules: rules })
    const decisionB = await hasPermissionsToUseTool(toolB, makeToolUse('mcp__b__y'), ctxB, opts())
    expect(decisionB.behavior).toBe('allow')
  })

  it('non-MCP wildcard: File* matches FileRead and FileWrite', async () => {
    const toolR = simpleTool('FileRead')
    const toolW = simpleTool('FileWrite')
    const rules: PermissionRule[] = [
      { toolName: 'File*', behavior: 'allow', source: 'userSettings' },
    ]
    const ctxR = makeContext([toolR], { permissionRules: rules })
    const decisionR = await hasPermissionsToUseTool(toolR, makeToolUse('FileRead'), ctxR, opts())
    expect(decisionR.behavior).toBe('allow')

    const ctxW = makeContext([toolW], { permissionRules: rules })
    const decisionW = await hasPermissionsToUseTool(toolW, makeToolUse('FileWrite'), ctxW, opts())
    expect(decisionW.behavior).toBe('allow')
  })

  it('bare * fails closed — matches nothing', async () => {
    const tool = simpleMcpTool('mcp__fake__echo')
    const rules: PermissionRule[] = [
      { toolName: '*', behavior: 'allow', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('mcp__fake__echo'), ctx, opts())
    expect(decision.behavior).toBe('ask')
    expect(decision.reason).toEqual({ type: 'fallback' })
  })

  it('deny wildcard beats allow wildcard', async () => {
    const tool = simpleMcpTool('mcp__fake__echo')
    const rules: PermissionRule[] = [
      { toolName: 'mcp__*', behavior: 'allow', source: 'userSettings' },
      { toolName: 'mcp__fake__*', behavior: 'deny', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('mcp__fake__echo'), ctx, opts())
    expect(decision.behavior).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Domain rules (Phase 6a)
// ---------------------------------------------------------------------------

describe('domain rules', () => {
  it('exact-host rule matches when getDomain returns that host', async () => {
    const tool = simpleTool('WebFetch', { domain: 'github.com' })
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'session' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('WebFetch'), ctx, opts())
    expect(decision.behavior).toBe('allow')
    expect(decision.reason).toEqual({ type: 'rule', rule: rules[0] })
  })

  it('exact-host rule does not match a different host', async () => {
    const tool = simpleTool('WebFetch', { domain: 'gist.github.com' })
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'session' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('WebFetch'), ctx, opts())
    expect(decision.behavior).toBe('ask') // falls through
  })

  it('*.suffix rule matches a subdomain', async () => {
    const tool = simpleTool('WebFetch', { domain: 'gist.github.com' })
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: '*.github.com', source: 'session' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('WebFetch'), ctx, opts())
    expect(decision.behavior).toBe('allow')
  })

  it('*.suffix rule does not match the apex', async () => {
    const tool = simpleTool('WebFetch', { domain: 'github.com' })
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: '*.github.com', source: 'session' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('WebFetch'), ctx, opts())
    expect(decision.behavior).toBe('ask')
  })

  it('domain rule does not match a tool that does not expose getDomain', async () => {
    const tool = simpleTool('FileRead', { path: '/foo' }) // no getDomain
    const rules: PermissionRule[] = [
      { toolName: 'FileRead', behavior: 'allow', domain: 'github.com', source: 'session' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileRead'), ctx, opts())
    expect(decision.behavior).toBe('ask') // domain match fails, falls through
  })

  it('rule with both path and domain requires both to match', async () => {
    const tool = simpleTool('Hybrid', { path: '/foo', domain: 'github.com' })
    const rulesBoth: PermissionRule[] = [
      { toolName: 'Hybrid', behavior: 'allow', path: '/foo', domain: 'github.com', source: 'session' },
    ]
    const ctxBoth = makeContext([tool], { permissionRules: rulesBoth })
    const decisionBoth = await hasPermissionsToUseTool(tool, makeToolUse('Hybrid'), ctxBoth, opts())
    expect(decisionBoth.behavior).toBe('allow')

    const wrongHost = simpleTool('Hybrid', { path: '/foo', domain: 'evil.com' })
    const ctxWrong = makeContext([wrongHost], { permissionRules: rulesBoth })
    const decisionWrong = await hasPermissionsToUseTool(wrongHost, makeToolUse('Hybrid'), ctxWrong, opts())
    expect(decisionWrong.behavior).toBe('ask')
  })

  it('domain deny wins over domain allow for the same host', async () => {
    const tool = simpleTool('WebFetch', { domain: 'github.com' })
    const rules: PermissionRule[] = [
      { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'session' },
      { toolName: 'WebFetch', behavior: 'deny', domain: 'github.com', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('WebFetch'), ctx, opts())
    expect(decision.behavior).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Decision priority ordering
// ---------------------------------------------------------------------------

describe('cascade priority', () => {
  it('deny rule beats allow rule', async () => {
    const tool = simpleTool('FileWrite')
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'allow', source: 'session' },
      { toolName: 'FileWrite', behavior: 'deny', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('deny')
  })

  it('ask rule beats allow rule and bypass mode', async () => {
    const tool = simpleTool('FileWrite')
    const rules: PermissionRule[] = [
      { toolName: 'FileWrite', behavior: 'allow', source: 'session' },
      { toolName: 'FileWrite', behavior: 'ask', source: 'projectSettings' },
    ]
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions', permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('FileWrite'), ctx, opts())
    expect(decision.behavior).toBe('ask')
  })

  it('deny rule beats tool-specific allow', async () => {
    const tool = buildTool({
      name: 'Guarded',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: async () => ({ content: 'ok', isError: false }),
      checkPermissions: async () => ({ behavior: 'allow' }),
    })
    const rules: PermissionRule[] = [
      { toolName: 'Guarded', behavior: 'deny', source: 'cliArg' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(tool, makeToolUse('Guarded'), ctx, opts())
    expect(decision.behavior).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Every decision has a reason
// ---------------------------------------------------------------------------

describe('structured reasons', () => {
  it('every decision has a reason field', async () => {
    const tool = simpleTool('A')
    const modes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions']
    for (const mode of modes) {
      const ctx = makeContext([tool], { permissionMode: mode })
      const decision = await hasPermissionsToUseTool(tool, makeToolUse('A'), ctx, opts())
      expect(decision.reason).toBeDefined()
      expect(typeof decision.reason.type).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// Step 1.5: Skill scope (Phase 5b)
// ---------------------------------------------------------------------------

describe('skill scope (scopedToolAllowlist)', () => {
  it('tool in allowlist falls through cascade (no deny here)', async () => {
    const tool = simpleTool('FileRead')
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('FileRead'), ctx,
      opts({ scopedToolAllowlist: ['FileRead', 'Grep'] }),
    )
    // Falls through to mode bypass → allow.
    expect(decision.behavior).toBe('allow')
    expect(decision.reason).toEqual({ type: 'mode', mode: 'bypassPermissions' })
  })

  it('tool NOT in allowlist denies with skillScope reason', async () => {
    const tool = simpleTool('Bash')
    const ctx = makeContext([tool])
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('Bash'), ctx,
      opts({ scopedToolAllowlist: ['FileRead', 'Grep'] }),
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({
      type: 'skillScope',
      toolName: 'Bash',
      allowed: ['FileRead', 'Grep'],
    })
  })

  it('empty allowlist denies every tool', async () => {
    const tool = simpleTool('FileRead')
    const ctx = makeContext([tool])
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('FileRead'), ctx,
      opts({ scopedToolAllowlist: [] }),
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({
      type: 'skillScope',
      toolName: 'FileRead',
      allowed: [],
    })
  })

  it('undefined allowlist is a no-op (default cascade applies)', async () => {
    const tool = simpleTool('Bash')
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('Bash'), ctx,
      opts({ scopedToolAllowlist: undefined }),
    )
    // No skill scope → bypass mode allows.
    expect(decision.behavior).toBe('allow')
    expect(decision.reason).toEqual({ type: 'mode', mode: 'bypassPermissions' })
  })

  it('explicit user deny rule beats skill scope (defense in depth)', async () => {
    const tool = simpleTool('FileRead')
    const rules: PermissionRule[] = [
      { toolName: 'FileRead', behavior: 'deny', source: 'userSettings' },
    ]
    const ctx = makeContext([tool], { permissionRules: rules })
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('FileRead'), ctx,
      opts({ scopedToolAllowlist: ['FileRead'] }),
    )
    // Step 1 (explicit deny) wins over step 1.5 (skill scope allows it).
    expect(decision.behavior).toBe('deny')
    expect(decision.reason.type).toBe('rule')
  })

  it('skill scope beats bypassPermissions mode', async () => {
    const tool = simpleTool('Bash')
    const ctx = makeContext([tool], { permissionMode: 'bypassPermissions' })
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('Bash'), ctx,
      opts({ scopedToolAllowlist: ['FileRead'] }),
    )
    // Step 1.5 fires before step 5 (mode bypass).
    expect(decision.behavior).toBe('deny')
    expect(decision.reason).toEqual({
      type: 'skillScope',
      toolName: 'Bash',
      allowed: ['FileRead'],
    })
  })

  it('headless escalation does NOT apply to skillScope deny', async () => {
    const tool = simpleTool('Bash')
    const ctx = makeContext([tool])
    const decision = await hasPermissionsToUseTool(
      tool, makeToolUse('Bash'), ctx,
      opts({ headless: true, scopedToolAllowlist: ['FileRead'] }),
    )
    // Already a deny, not an ask — pass through unchanged.
    expect(decision.behavior).toBe('deny')
    expect(decision.reason.type).toBe('skillScope')
  })
})

// ---------------------------------------------------------------------------
// formatDecisionMessage
// ---------------------------------------------------------------------------

describe('formatDecisionMessage', () => {
  it('formats rule reason', () => {
    const msg = formatDecisionMessage({
      behavior: 'deny',
      reason: { type: 'rule', rule: { toolName: 'Bash', behavior: 'deny', source: 'userSettings' } },
    })
    expect(msg).toContain('deny')
    expect(msg).toContain('userSettings')
    expect(msg).toContain('Bash')
  })

  it('formats headless escalation', () => {
    const msg = formatDecisionMessage({
      behavior: 'deny',
      reason: { type: 'headlessEscalation', original: { type: 'fallback' } },
    })
    expect(msg).toContain('headless')
  })

  it('formats skillScope', () => {
    const msg = formatDecisionMessage({
      behavior: 'deny',
      reason: { type: 'skillScope', toolName: 'Bash', allowed: ['FileRead', 'Grep'] },
    })
    expect(msg).toContain("active skill's allowed-tools")
    expect(msg).toContain('FileRead, Grep')
  })

  it('formats fallback', () => {
    const msg = formatDecisionMessage({
      behavior: 'ask',
      reason: { type: 'fallback' },
    })
    expect(msg).toContain('approval')
  })

  it('formats rule with domain only', () => {
    const msg = formatDecisionMessage({
      behavior: 'allow',
      reason: { type: 'rule', rule: { toolName: 'WebFetch', behavior: 'allow', domain: 'github.com', source: 'session' } },
    })
    expect(msg).toContain('WebFetch')
    expect(msg).toContain('github.com')
  })

  it('formats rule with both path and domain', () => {
    const msg = formatDecisionMessage({
      behavior: 'allow',
      reason: { type: 'rule', rule: { toolName: 'Hybrid', behavior: 'allow', path: '/foo', domain: 'github.com', source: 'session' } },
    })
    expect(msg).toContain('/foo')
    expect(msg).toContain('github.com')
  })
})
