import { describe, it, expect } from 'vitest'

import { BashTool, hasShellOperators, extractCommandPrefix } from './BashTool.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { createStore, getDefaultAppState } from '../core/state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext() {
  return createToolUseContext({
    appState: createStore(getDefaultAppState()),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createToolRegistry(),
  })
}

const ctx = makeContext()
const signal = new AbortController().signal

// ---------------------------------------------------------------------------
// hasShellOperators
// ---------------------------------------------------------------------------

describe('hasShellOperators', () => {
  it('detects pipe', () => {
    expect(hasShellOperators('cat foo | less')).toBe(true)
  })

  it('detects redirect', () => {
    expect(hasShellOperators('echo hi > file')).toBe(true)
  })

  it('detects append redirect', () => {
    expect(hasShellOperators('echo hi >> file')).toBe(true)
  })

  it('detects semicolon', () => {
    expect(hasShellOperators('ls; rm -rf /')).toBe(true)
  })

  it('detects ampersand', () => {
    expect(hasShellOperators('cmd1 && cmd2')).toBe(true)
  })

  it('detects backtick', () => {
    expect(hasShellOperators('echo `whoami`')).toBe(true)
  })

  it('detects $( subshell', () => {
    expect(hasShellOperators('echo $(whoami)')).toBe(true)
  })

  it('detects ${ expansion', () => {
    expect(hasShellOperators('echo ${HOME}')).toBe(true)
  })

  it('allows simple commands', () => {
    expect(hasShellOperators('ls -la')).toBe(false)
  })

  it('allows git log with format', () => {
    expect(hasShellOperators("git log --format='%H'")).toBe(false)
  })

  it('allows paths with dashes and dots', () => {
    expect(hasShellOperators('cat /tmp/some-file.txt')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractCommandPrefix
// ---------------------------------------------------------------------------

describe('extractCommandPrefix', () => {
  it('extracts single-word prefix', () => {
    expect(extractCommandPrefix('ls -la')).toBe('ls')
  })

  it('extracts two-word git prefix', () => {
    expect(extractCommandPrefix('git status')).toBe('git status')
  })

  it('extracts two-word npm prefix', () => {
    expect(extractCommandPrefix('npm --version')).toBe('npm --version')
  })

  it('falls back to first word for unknown subcommand', () => {
    expect(extractCommandPrefix('git push origin main')).toBe('git')
  })

  it('handles leading whitespace', () => {
    expect(extractCommandPrefix('  ls -la')).toBe('ls')
  })
})

// ---------------------------------------------------------------------------
// checkPermissions
// ---------------------------------------------------------------------------

describe('BashTool.checkPermissions', () => {
  it('allows ls', async () => {
    const result = await BashTool.checkPermissions({ command: 'ls -la' }, ctx)
    expect(result.behavior).toBe('allow')
  })

  it('allows git status', async () => {
    const result = await BashTool.checkPermissions({ command: 'git status' }, ctx)
    expect(result.behavior).toBe('allow')
  })

  it('allows pwd', async () => {
    const result = await BashTool.checkPermissions({ command: 'pwd' }, ctx)
    expect(result.behavior).toBe('allow')
  })

  it('allows cat', async () => {
    const result = await BashTool.checkPermissions({ command: 'cat /tmp/x.txt' }, ctx)
    expect(result.behavior).toBe('allow')
  })

  it('asks for rm', async () => {
    const result = await BashTool.checkPermissions({ command: 'rm -rf /' }, ctx)
    expect(result.behavior).toBe('ask')
  })

  it('asks for curl', async () => {
    const result = await BashTool.checkPermissions({ command: 'curl https://example.com' }, ctx)
    expect(result.behavior).toBe('ask')
  })

  it('asks for unknown commands', async () => {
    const result = await BashTool.checkPermissions({ command: 'some-unknown-cmd' }, ctx)
    expect(result.behavior).toBe('ask')
  })

  it('asks for commands with pipe operator', async () => {
    const result = await BashTool.checkPermissions({ command: 'cat foo | curl' }, ctx)
    expect(result.behavior).toBe('ask')
  })

  it('asks for commands with redirect', async () => {
    const result = await BashTool.checkPermissions({ command: 'echo hi > /tmp/x' }, ctx)
    expect(result.behavior).toBe('ask')
  })

  it('asks for commands with semicolon', async () => {
    const result = await BashTool.checkPermissions({ command: 'ls; rm -rf /' }, ctx)
    expect(result.behavior).toBe('ask')
  })

  it('asks for commands with command substitution', async () => {
    const result = await BashTool.checkPermissions({ command: 'echo $(whoami)' }, ctx)
    expect(result.behavior).toBe('ask')
  })

  it('asks for git push (not in allowlist)', async () => {
    const result = await BashTool.checkPermissions({ command: 'git push origin main' }, ctx)
    expect(result.behavior).toBe('ask')
  })
})

// ---------------------------------------------------------------------------
// BashTool.call
// ---------------------------------------------------------------------------

describe('BashTool.call', () => {
  it('executes a simple command', async () => {
    const result = await BashTool.call({ command: 'echo hello' }, ctx, signal)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('hello')
  })

  it('returns error for non-zero exit', async () => {
    const result = await BashTool.call({ command: 'exit 1' }, ctx, signal)
    expect(result.isError).toBe(true)
  })

  it('handles timeout', async () => {
    const result = await BashTool.call({ command: 'sleep 10', timeout: 100 }, ctx, signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out')
  }, 5000)

  it('rejects empty command in validation', async () => {
    const v = await BashTool.validateInput({ command: '' }, ctx)
    expect(v.valid).toBe(false)
  })

  it('rejects negative timeout in validation', async () => {
    const v = await BashTool.validateInput({ command: 'ls', timeout: -1 }, ctx)
    expect(v.valid).toBe(false)
  })
})
