/**
 * Integration test: Phase 6c CodeSandbox end-to-end through runToolUse.
 *
 * Drives `tool_use` through authorizeToolUse + executeToolUse to exercise:
 *   - First call asks; allow_by_rule persists a tool-name-only session rule
 *   - Second call with persisted rule does not prompt
 *   - Tool-name deny rule blocks even under bypassPermissions
 *   - Skill scope: allowedTools without CodeSandbox denies; with it permits
 *   - allow_once authorizes without persisting a rule and executes
 *
 * Uses the real CodeSandbox runtime (QuickJS in a worker) so the cascade
 * decision is proven against the actual tool execution path. Snippets
 * are tiny (`console.log('ok')`) so each call adds ~100ms.
 */

import { describe, it, expect } from 'vitest'

import { authorizeToolUse, executeToolUse } from '../../src/core/tools/runToolUse.js'
import { createToolUseContext } from '../../src/core/tools/context.js'
import { createToolRegistry } from '../../src/core/tools/registry.js'
import { createStore, getDefaultAppState } from '../../src/core/state.js'
import type { AppState } from '../../src/core/state.js'
import type { PermissionRule, PermissionOptions } from '../../src/core/permissions/types.js'
import type { ToolUseBlock } from '../../src/core/messages.js'
import { toolUseId } from '../../src/core/messages.js'
import { CodeSandboxTool } from '../../src/tools/CodeSandboxTool.js'

let tuCounter = 0
function makeToolUse(input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId(`tu-${++tuCounter}`), name: 'CodeSandbox', input }
}

function makeContext(stateOverrides: Partial<AppState> = {}) {
  const registry = createToolRegistry()
  registry.register(CodeSandboxTool)
  return createToolUseContext({
    appState: createStore({ ...getDefaultAppState(), ...stateOverrides }),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: registry,
  })
}

const helloJs = { language: 'javascript', code: `console.log('ok')` }

describe('CodeSandbox integration — runToolUse end-to-end', () => {
  it('first call asks; allow_by_rule persists a tool-name-only session rule', async () => {
    const ctx = makeContext()
    let askCount = 0
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => {
        askCount++
        return 'allow_by_rule'
      },
    }

    const tu = makeToolUse(helloJs)
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('authorized')
    if (auth.outcome === 'authorized') {
      expect(auth.decision.userResponse).toBe('allow_by_rule')
      expect(auth.decision.ruleCreated).toEqual({
        toolName: 'CodeSandbox',
        behavior: 'allow',
        source: 'session',
      })
    }
    expect(askCount).toBe(1)
    expect(ctx.appState.getState().permissionRules).toHaveLength(1)

    const result = await executeToolUse(tu, ctx, new AbortController().signal)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('ok')
  }, 15_000)

  it('second call with persisted rule does not prompt', async () => {
    const rules: PermissionRule[] = [
      { toolName: 'CodeSandbox', behavior: 'allow', source: 'session' },
    ]
    const ctx = makeContext({ permissionRules: rules })
    let askCount = 0
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => {
        askCount++
        return 'allow_once'
      },
    }
    const tu = makeToolUse(helloJs)
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('authorized')
    expect(askCount).toBe(0)
  })

  it('tool-name deny rule blocks even under bypassPermissions', async () => {
    const rules: PermissionRule[] = [
      { toolName: 'CodeSandbox', behavior: 'deny', source: 'userSettings' },
    ]
    const ctx = makeContext({ permissionRules: rules, permissionMode: 'bypassPermissions' })
    const tu = makeToolUse(helloJs)
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal)
    expect(auth.outcome).toBe('denied')
  })

  it('skill scope without CodeSandbox in allowedTools denies', async () => {
    const ctx = makeContext()
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      scopedToolAllowlist: ['FileRead'],
    }
    const tu = makeToolUse(helloJs)
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('denied')
    if (auth.outcome === 'denied') {
      expect(auth.decision.reason).toContain("active skill's allowed-tools")
    }
  })

  it('skill scope with CodeSandbox in allowedTools permits', async () => {
    const rules: PermissionRule[] = [
      { toolName: 'CodeSandbox', behavior: 'allow', source: 'session' },
    ]
    const ctx = makeContext({ permissionRules: rules })
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      scopedToolAllowlist: ['CodeSandbox'],
    }
    const tu = makeToolUse(helloJs)
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('authorized')
  })

  it('allow_once authorizes without persisting a rule and executes', async () => {
    const ctx = makeContext()
    const opts: PermissionOptions = {
      headless: false,
      safetyChecks: [],
      askUser: async () => 'allow_once',
    }
    const tu = makeToolUse(helloJs)
    const auth = await authorizeToolUse(tu, ctx, new AbortController().signal, opts)
    expect(auth.outcome).toBe('authorized')
    if (auth.outcome === 'authorized') {
      expect(auth.decision.ruleCreated).toBeUndefined()
    }
    expect(ctx.appState.getState().permissionRules).toEqual([])

    const result = await executeToolUse(tu, ctx, new AbortController().signal)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('ok')
  }, 15_000)
})
