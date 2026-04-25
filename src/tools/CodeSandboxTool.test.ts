import { describe, expect, it, vi, beforeEach } from 'vitest'

import { CodeSandboxTool } from './CodeSandboxTool.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import type { AppState } from '../core/state.js'
import * as runtimeMod from '../sandbox/runtime.js'

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

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('CodeSandboxTool.validateInput', () => {
  const ctx = makeContext()

  it('rejects missing language', async () => {
    const r = await CodeSandboxTool.validateInput({ code: 'x' }, ctx)
    expect(r.valid).toBe(false)
  })

  it('rejects unsupported language', async () => {
    const r = await CodeSandboxTool.validateInput({ language: 'ruby', code: 'puts 1' }, ctx)
    expect(r.valid).toBe(false)
  })

  it('rejects empty code', async () => {
    const r = await CodeSandboxTool.validateInput({ language: 'python', code: '   ' }, ctx)
    expect(r.valid).toBe(false)
  })

  it('rejects non-string code', async () => {
    const r = await CodeSandboxTool.validateInput({ language: 'python', code: 42 }, ctx)
    expect(r.valid).toBe(false)
  })

  it('rejects negative timeoutMs', async () => {
    const r = await CodeSandboxTool.validateInput(
      { language: 'javascript', code: 'x', timeoutMs: -1 },
      ctx,
    )
    expect(r.valid).toBe(false)
  })

  it('rejects timeoutMs over MAX_TIMEOUT_MS', async () => {
    const r = await CodeSandboxTool.validateInput(
      { language: 'javascript', code: 'x', timeoutMs: 120_000 },
      ctx,
    )
    expect(r.valid).toBe(false)
  })

  it('accepts valid python input', async () => {
    const r = await CodeSandboxTool.validateInput(
      { language: 'python', code: 'print(1)' },
      ctx,
    )
    expect(r.valid).toBe(true)
  })

  it('accepts valid javascript input with optional timeoutMs', async () => {
    const r = await CodeSandboxTool.validateInput(
      { language: 'javascript', code: 'console.log(1)', timeoutMs: 5_000 },
      ctx,
    )
    expect(r.valid).toBe(true)
  })
})

describe('CodeSandboxTool.checkPermissions', () => {
  const ctx = makeContext()
  it('returns allow (cascade decides)', async () => {
    const r = await CodeSandboxTool.checkPermissions(
      { language: 'python', code: 'x' },
      ctx,
    )
    expect(r.behavior).toBe('allow')
  })
})

describe('CodeSandboxTool metadata', () => {
  it('is non-mutating and concurrency-safe', () => {
    expect(CodeSandboxTool.isMutating).toBe(false)
    expect(CodeSandboxTool.isConcurrencySafe?.({})).toBe(true)
  })

  it('exposes no spatial scope methods', () => {
    expect(CodeSandboxTool.getPath).toBeUndefined()
    expect(CodeSandboxTool.getDomain).toBeUndefined()
  })
})

describe('CodeSandboxTool.call', () => {
  it('formats stdout-only output (no stderr divider)', async () => {
    vi.spyOn(runtimeMod, 'runSandbox').mockResolvedValue({
      stdout: 'hi\n',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
    })
    const r = await CodeSandboxTool.call(
      { language: 'python', code: 'print("hi")' },
      makeContext(),
      new AbortController().signal,
    )
    expect(r.isError).toBe(false)
    expect(r.content).toBe('hi')
  })

  it('formats stdout + stderr with divider', async () => {
    vi.spyOn(runtimeMod, 'runSandbox').mockResolvedValue({
      stdout: 'hi\n',
      stderr: 'oops\n',
      truncated: false,
      timedOut: false,
      aborted: false,
    })
    const r = await CodeSandboxTool.call(
      { language: 'python', code: 'x' },
      makeContext(),
      new AbortController().signal,
    )
    expect(r.content).toBe('hi\n--- stderr ---\noops')
    expect(r.isError).toBe(false)
  })

  it('appends truncation marker when output capped', async () => {
    vi.spyOn(runtimeMod, 'runSandbox').mockResolvedValue({
      stdout: 'a',
      stderr: '',
      truncated: true,
      timedOut: false,
      aborted: false,
    })
    const r = await CodeSandboxTool.call(
      { language: 'javascript', code: 'x' },
      makeContext(),
      new AbortController().signal,
    )
    expect(r.content).toMatch(/\[output truncated at 64 KB\]/)
  })

  it('marks timeout result as execution_error with kill marker', async () => {
    vi.spyOn(runtimeMod, 'runSandbox').mockResolvedValue({
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: true,
      aborted: false,
      exitError: '[killed: wall-clock timeout 30000ms]',
    })
    const r = await CodeSandboxTool.call(
      { language: 'javascript', code: 'while(1){}' },
      makeContext(),
      new AbortController().signal,
    )
    expect(r.isError).toBe(true)
    expect(r.errorKind).toBe('execution_error')
    expect(r.content).toContain('[killed: wall-clock timeout')
  })

  it('marks aborted with errorKind aborted', async () => {
    vi.spyOn(runtimeMod, 'runSandbox').mockResolvedValue({
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: true,
      exitError: '[aborted]',
    })
    const r = await CodeSandboxTool.call(
      { language: 'javascript', code: 'x' },
      makeContext(),
      new AbortController().signal,
    )
    expect(r.isError).toBe(true)
    expect(r.errorKind).toBe('aborted')
  })

  it('formats raw exitError (not bracketed) with [error] prefix', async () => {
    vi.spyOn(runtimeMod, 'runSandbox').mockResolvedValue({
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
      exitError: 'ReferenceError: x is not defined',
    })
    const r = await CodeSandboxTool.call(
      { language: 'javascript', code: 'x' },
      makeContext(),
      new AbortController().signal,
    )
    expect(r.content).toBe('[error] ReferenceError: x is not defined')
    expect(r.errorKind).toBe('execution_error')
  })

  it('returns "(no output)" when nothing is produced and no error', async () => {
    vi.spyOn(runtimeMod, 'runSandbox').mockResolvedValue({
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
    })
    const r = await CodeSandboxTool.call(
      { language: 'python', code: 'x = 1' },
      makeContext(),
      new AbortController().signal,
    )
    expect(r.content).toBe('(no output)')
    expect(r.isError).toBe(false)
  })

  it('passes timeoutMs and signal through to runSandbox', async () => {
    const spy = vi.spyOn(runtimeMod, 'runSandbox').mockResolvedValue({
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
    })
    const ctrl = new AbortController()
    await CodeSandboxTool.call(
      { language: 'javascript', code: 'x', timeoutMs: 1234 },
      makeContext(),
      ctrl.signal,
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'javascript',
        code: 'x',
        timeoutMs: 1234,
        signal: ctrl.signal,
        maxOutputBytes: 64 * 1024,
      }),
    )
  })

  it('uses default timeout when not provided', async () => {
    const spy = vi.spyOn(runtimeMod, 'runSandbox').mockResolvedValue({
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
    })
    await CodeSandboxTool.call(
      { language: 'python', code: 'x' },
      makeContext(),
      new AbortController().signal,
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    )
  })
})
