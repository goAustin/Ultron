import { describe, it, expect, vi } from 'vitest'
import { computeEffectiveAllowedTools, createSandboxContext, buildFilteredRegistry, SubagentScopeError } from './sandboxContext.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import type { AppState } from '../core/state.js'
import { createDefaultRegistry } from '../core/tools/registry.js'
import type { PermissionOptions } from '../core/permissions/types.js'
import type { AuditWriter } from '../audit/types.js'
import type { QueryEvent } from '../core/queryEvents.js'
import { toolUseId } from '../core/messages.js'

const noopWriter: AuditWriter = (() => {
  const make = (): AuditWriter => ({
    write: (_e: QueryEvent) => {},
    close: async () => {},
    withOrigin: () => make(),
  })
  return make()
})()

const defaultPermOpts: PermissionOptions = { headless: false, safetyChecks: [] }

// Synthetic parent ToolUseBlock.id for tests that don't care about the value.
// Phase 7c made this required on SandboxContextOptions; the test isn't a
// public SDK call site so the churn is fine.
const TEST_PARENT_TUID = toolUseId('tu_test_parent')

// ---------------------------------------------------------------------------
// computeEffectiveAllowedTools — pure logic; subagent ⊆ parent invariant.
// ---------------------------------------------------------------------------

describe('computeEffectiveAllowedTools', () => {
  it('passes through requested tools when parent is unscoped', () => {
    expect(computeEffectiveAllowedTools(['FileRead', 'Glob'], undefined)).toEqual(['FileRead', 'Glob'])
  })

  it('drops Agent even when parent is unscoped (no recursive subagents)', () => {
    expect(computeEffectiveAllowedTools(['FileRead', 'Agent'], undefined)).toEqual(['FileRead'])
  })

  it('intersects with parent scope so subagent cannot widen', () => {
    // Parent skill restricts to FileRead; subagent requests the default trio.
    // The subagent must not gain Glob or Grep just by forking.
    expect(
      computeEffectiveAllowedTools(['FileRead', 'Glob', 'Grep'], ['FileRead']),
    ).toEqual(['FileRead'])
  })

  it('empty parent scope yields empty effective list', () => {
    expect(computeEffectiveAllowedTools(['FileRead', 'Glob'], [])).toEqual([])
  })

  it('drops Agent regardless of parent scope (Agent ∈ parentScope cannot grant recursion)', () => {
    expect(computeEffectiveAllowedTools(['Agent'], ['Agent'])).toEqual([])
  })

  it('preserves request order for tools in both lists', () => {
    expect(
      computeEffectiveAllowedTools(['Grep', 'FileRead'], ['FileRead', 'Grep']),
    ).toEqual(['Grep', 'FileRead'])
  })
})

// ---------------------------------------------------------------------------
// createSandboxContext — agreement between filtered registry and
// scopedToolAllowlist; cleanup correctness.
// ---------------------------------------------------------------------------

describe('createSandboxContext', () => {
  it('scopedToolAllowlist matches the filtered registry exactly', () => {
    const parentRegistry = createDefaultRegistry()
    const sandbox = createSandboxContext({
      parentAppState: createStore<AppState>(getDefaultAppState()),
      parentToolRegistry: parentRegistry,
      parentSignal: new AbortController().signal,
      parentPermissionOpts: defaultPermOpts,
      parentAuditWriter: noopWriter,
      // Request includes Agent — should be dropped from BOTH the registry
      // AND the scope so an emitted Agent tool_use denies as agentScope.
      allowedTools: ['FileRead', 'Agent'],
      subagentId: 'sub-1',
      parentToolUseId: TEST_PARENT_TUID,
    })
    sandbox.cleanup()

    expect(sandbox.permissionOpts.scopedToolAllowlist).toEqual(['FileRead'])
    expect(sandbox.permissionOpts.scopeSource).toBe('agent')

    // Registry has FileRead and not Agent — agreement.
    expect(sandbox.toolRegistry.has('FileRead')).toBe(true)
    expect(sandbox.toolRegistry.has('Agent')).toBe(false)
  })

  it('intersects subagent allowedTools with parent scopedToolAllowlist', () => {
    const sandbox = createSandboxContext({
      parentAppState: createStore<AppState>(getDefaultAppState()),
      parentToolRegistry: createDefaultRegistry(),
      parentSignal: new AbortController().signal,
      // Parent already restricted (e.g. an active skill).
      parentPermissionOpts: { ...defaultPermOpts, scopedToolAllowlist: ['FileRead'] },
      parentAuditWriter: noopWriter,
      // Subagent requests default trio — must NOT widen parent.
      allowedTools: ['FileRead', 'Glob', 'Grep'],
      subagentId: 'sub-2',
      parentToolUseId: TEST_PARENT_TUID,
    })
    sandbox.cleanup()

    expect(sandbox.permissionOpts.scopedToolAllowlist).toEqual(['FileRead'])
    expect(sandbox.toolRegistry.has('FileRead')).toBe(true)
    expect(sandbox.toolRegistry.has('Glob')).toBe(false)
    expect(sandbox.toolRegistry.has('Grep')).toBe(false)
  })

  it('clones parent appState — child mutations do not affect parent', () => {
    const parent = createStore<AppState>({ ...getDefaultAppState(), permissionMode: 'default' })
    const sandbox = createSandboxContext({
      parentAppState: parent,
      parentToolRegistry: createDefaultRegistry(),
      parentSignal: new AbortController().signal,
      parentPermissionOpts: defaultPermOpts,
      parentAuditWriter: noopWriter,
      allowedTools: ['FileRead'],
      subagentId: 'sub-3',
      parentToolUseId: TEST_PARENT_TUID,
    })

    sandbox.appState.setState({ permissionMode: 'bypassPermissions' })
    expect(parent.getState().permissionMode).toBe('default')
    sandbox.cleanup()
  })

  it('parent abort cascades to sandbox abortController', () => {
    const parentAc = new AbortController()
    const sandbox = createSandboxContext({
      parentAppState: createStore<AppState>(getDefaultAppState()),
      parentToolRegistry: createDefaultRegistry(),
      parentSignal: parentAc.signal,
      parentPermissionOpts: defaultPermOpts,
      parentAuditWriter: noopWriter,
      allowedTools: ['FileRead'],
      subagentId: 'sub-4',
      parentToolUseId: TEST_PARENT_TUID,
    })

    expect(sandbox.abortController.signal.aborted).toBe(false)
    parentAc.abort()
    expect(sandbox.abortController.signal.aborted).toBe(true)
    sandbox.cleanup()
  })

  // Phase 7c — every subagent envelope must carry parentToolUseId so
  // downstream consumers can correlate child events back to the parent's
  // tool_call_started even under parallel fan-out.
  it('derives auditWriter via parentAuditWriter.withOrigin(subagentId, { parentToolUseId })', () => {
    const withOriginSpy = vi.fn((_origin: string, _opts?: { readonly parentToolUseId: import('../core/messages.js').ToolUseId }): AuditWriter => ({
      write: () => {},
      close: async () => {},
      withOrigin: () => { throw new Error('not chainable') },
    }))
    const parentWriter: AuditWriter = {
      write: () => {},
      close: async () => {},
      withOrigin: withOriginSpy,
    }
    const tuid = toolUseId('tu_xyz')
    const sandbox = createSandboxContext({
      parentAppState: createStore<AppState>(getDefaultAppState()),
      parentToolRegistry: createDefaultRegistry(),
      parentSignal: new AbortController().signal,
      parentPermissionOpts: defaultPermOpts,
      parentAuditWriter: parentWriter,
      allowedTools: ['FileRead'],
      subagentId: 'sub-correlate',
      parentToolUseId: tuid,
    })
    sandbox.cleanup()

    expect(withOriginSpy).toHaveBeenCalledTimes(1)
    expect(withOriginSpy).toHaveBeenCalledWith('sub-correlate', { parentToolUseId: tuid })
  })

  it('cleanup detaches the parent-abort listener (no leak)', () => {
    const parentAc = new AbortController()
    const sandbox = createSandboxContext({
      parentAppState: createStore<AppState>(getDefaultAppState()),
      parentToolRegistry: createDefaultRegistry(),
      parentSignal: parentAc.signal,
      parentPermissionOpts: defaultPermOpts,
      parentAuditWriter: noopWriter,
      allowedTools: ['FileRead'],
      subagentId: 'sub-5',
      parentToolUseId: TEST_PARENT_TUID,
    })
    sandbox.cleanup()

    // After cleanup, parent abort must not flip the (already detached) child
    // controller. We can't observe the listener directly; the contract is
    // that the controller state is whatever cleanup left it.
    parentAc.abort()
    // The sandbox controller had no listener, so it stays not-aborted.
    expect(sandbox.abortController.signal.aborted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildFilteredRegistry — defense-in-depth Agent exclusion.
// ---------------------------------------------------------------------------

describe('buildFilteredRegistry', () => {
  it('excludes Agent even if a caller bypassed computeEffectiveAllowedTools', () => {
    const parent = createDefaultRegistry()
    const filtered = buildFilteredRegistry(parent, ['FileRead', 'Agent'])
    expect(filtered.has('FileRead')).toBe(true)
    expect(filtered.has('Agent')).toBe(false)
  })

  it('silently drops names not present in the parent registry', () => {
    const parent = createDefaultRegistry()
    const filtered = buildFilteredRegistry(parent, ['FileRead', 'NonexistentTool'])
    expect(filtered.has('FileRead')).toBe(true)
    expect(filtered.has('NonexistentTool')).toBe(false)
  })

  // Phase 7b — read-only invariant: subagents must never carry a write-capable
  // tool. The `AgentTool.isConcurrencySafe = true` claim relies on this.
  it('throws SubagentScopeError when allowedTools includes FileWrite', () => {
    const parent = createDefaultRegistry()
    expect(() => buildFilteredRegistry(parent, ['FileWrite'])).toThrow(SubagentScopeError)
  })

  it('throws SubagentScopeError when allowedTools includes FileEdit', () => {
    const parent = createDefaultRegistry()
    expect(() => buildFilteredRegistry(parent, ['FileEdit'])).toThrow(SubagentScopeError)
  })

  it('throws SubagentScopeError when allowedTools includes Bash', () => {
    const parent = createDefaultRegistry()
    expect(() => buildFilteredRegistry(parent, ['Bash'])).toThrow(SubagentScopeError)
  })

  it('the SubagentScopeError carries the offending tool name', () => {
    const parent = createDefaultRegistry()
    try {
      buildFilteredRegistry(parent, ['FileRead', 'Bash'])
      expect.fail('expected SubagentScopeError')
    } catch (err) {
      expect(err).toBeInstanceOf(SubagentScopeError)
      expect((err as SubagentScopeError).toolName).toBe('Bash')
    }
  })

  it('default read-only allowlist passes', () => {
    const parent = createDefaultRegistry()
    const filtered = buildFilteredRegistry(parent, ['FileRead', 'Glob', 'Grep'])
    expect(filtered.has('FileRead')).toBe(true)
    expect(filtered.has('Glob')).toBe(true)
    expect(filtered.has('Grep')).toBe(true)
  })
})
