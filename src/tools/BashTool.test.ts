import { describe, it, expect } from 'vitest'

import {
  BashTool,
  annotateUnsandboxed,
  buildBashExecutionPlan,
  checkBashPermissions,
  hasShellOperators,
  extractCommandPrefix,
  maybeAppendSandboxHint,
  resolveBashCwd,
} from './BashTool.js'
import { createToolUseContext } from '../core/tools/context.js'
import { createToolRegistry } from '../core/tools/registry.js'
import { createStore, getDefaultAppState } from '../core/state.js'
import { defaultShellSandboxSettings } from '../core/sandbox/settings.js'
import type { ShellSandboxDecision } from '../core/sandbox/types.js'

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

  it.skipIf(process.platform !== 'darwin')(
    'on macOS, appends the sandbox hint when Seatbelt blocks a write',
    async () => {
      // Default sandbox settings deny writes outside the workspace and
      // /etc is never in any allowlist — the bash redirect below should
      // fail with "Operation not permitted", and BashTool should append
      // the hint pointing at settings.json.
      const result = await BashTool.call(
        { command: 'echo hi > /etc/ultron-sandbox-hint-test 2>&1' },
        ctx,
        signal,
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('[ultron hint]')
      expect(result.content).toContain('~/.ultron/settings.json')
    },
  )
})

// ---------------------------------------------------------------------------
// buildBashExecutionPlan — platform branch
// ---------------------------------------------------------------------------

describe('buildBashExecutionPlan', () => {
  const cwd = '/Users/test/proj'

  it('uses /bin/bash -c for permissionOnly on darwin', () => {
    const decision: ShellSandboxDecision = {
      kind: 'permissionOnly',
      platform: 'darwin',
      reason: 'sandbox_disabled',
    }
    const plan = buildBashExecutionPlan(
      decision,
      'echo hi',
      defaultShellSandboxSettings,
      cwd,
    )
    expect(plan.executable).toBe('/bin/bash')
    expect(plan.args).toEqual(['-c', 'echo hi'])
  })

  it('uses /bin/bash -c for permissionOnly on linux', () => {
    const decision: ShellSandboxDecision = {
      kind: 'permissionOnly',
      platform: 'linux',
      reason: 'unsupported_platform',
    }
    const plan = buildBashExecutionPlan(
      decision,
      'echo hi',
      defaultShellSandboxSettings,
      cwd,
    )
    expect(plan.executable).toBe('/bin/bash')
    expect(plan.args).toEqual(['-c', 'echo hi'])
  })

  it('uses powershell.exe -NoProfile -Command for permissionOnly on win32', () => {
    const decision: ShellSandboxDecision = {
      kind: 'permissionOnly',
      platform: 'win32',
      reason: 'native_windows_unsupported',
    }
    const plan = buildBashExecutionPlan(
      decision,
      'Get-ChildItem',
      defaultShellSandboxSettings,
      cwd,
    )
    expect(plan.executable).toBe('powershell.exe')
    expect(plan.args).toEqual(['-NoProfile', '-Command', 'Get-ChildItem'])
  })

  it('passes the user command as a single argv entry on win32', () => {
    const decision: ShellSandboxDecision = {
      kind: 'permissionOnly',
      platform: 'win32',
      reason: 'native_windows_unsupported',
    }
    const malicious = 'Write-Output hi; Remove-Item C:\\'
    const plan = buildBashExecutionPlan(
      decision,
      malicious,
      defaultShellSandboxSettings,
      cwd,
    )
    expect(plan.args[plan.args.length - 1]).toBe(malicious)
  })

  it('uses sandbox-exec for sandboxed decisions on darwin', () => {
    const decision: ShellSandboxDecision = {
      kind: 'sandboxed',
      platform: 'darwin',
      mechanism: 'seatbelt',
      reason: 'available',
    }
    const plan = buildBashExecutionPlan(
      decision,
      'echo hi',
      defaultShellSandboxSettings,
      cwd,
    )
    expect(plan.executable).toBe('/usr/bin/sandbox-exec')
    expect(plan.args[0]).toBe('-p')
    expect(plan.args[plan.args.length - 1]).toBe('echo hi')
  })
})

// ---------------------------------------------------------------------------
// annotateUnsandboxed — surfaces a warning when sandbox didn't apply
// ---------------------------------------------------------------------------

describe('annotateUnsandboxed', () => {
  it('prepends a Windows-specific warning for native_windows_unsupported', () => {
    const decision: ShellSandboxDecision = {
      kind: 'permissionOnly',
      platform: 'win32',
      reason: 'native_windows_unsupported',
    }
    const out = annotateUnsandboxed(decision, 'C:\\Users')
    expect(out).toContain('native Windows containment is not implemented')
    expect(out).toContain('C:\\Users')
  })

  it('prepends a macOS-specific warning for sandbox_unavailable_fallback', () => {
    const decision: ShellSandboxDecision = {
      kind: 'permissionOnly',
      platform: 'darwin',
      reason: 'sandbox_unavailable_fallback',
    }
    const out = annotateUnsandboxed(decision, 'hello')
    expect(out).toContain('sandbox-exec is unavailable')
    expect(out).toContain('hello')
  })

  it('prepends an unsupported-platform warning for unsupported_platform', () => {
    const decision: ShellSandboxDecision = {
      kind: 'permissionOnly',
      platform: 'linux',
      reason: 'unsupported_platform',
    }
    const out = annotateUnsandboxed(decision, 'hello')
    expect(out).toContain('this platform has no supported sandbox mechanism')
  })

  it('does NOT add a warning when the user explicitly disabled the sandbox', () => {
    const decision: ShellSandboxDecision = {
      kind: 'permissionOnly',
      platform: 'darwin',
      reason: 'sandbox_disabled',
    }
    expect(annotateUnsandboxed(decision, 'hello')).toBe('hello')
  })

  it('does NOT add a warning for sandboxed decisions', () => {
    const decision: ShellSandboxDecision = {
      kind: 'sandboxed',
      platform: 'darwin',
      mechanism: 'seatbelt',
      reason: 'available',
    }
    expect(annotateUnsandboxed(decision, 'hello')).toBe('hello')
  })

  it('emits the warning standalone when output is empty', () => {
    const decision: ShellSandboxDecision = {
      kind: 'permissionOnly',
      platform: 'win32',
      reason: 'native_windows_unsupported',
    }
    const out = annotateUnsandboxed(decision, '')
    expect(out).toContain('native Windows')
    expect(out).not.toMatch(/\n\s*$/)
  })
})

// ---------------------------------------------------------------------------
// checkBashPermissions — platform-aware permission helper
// ---------------------------------------------------------------------------

describe('checkBashPermissions', () => {
  it('allows ls on darwin', () => {
    expect(checkBashPermissions('ls -la', 'darwin').behavior).toBe('allow')
  })

  it('allows ls on linux', () => {
    expect(checkBashPermissions('ls -la', 'linux').behavior).toBe('allow')
  })

  it('asks for ls on win32 — PowerShell aliases traverse providers', () => {
    expect(checkBashPermissions('ls -la', 'win32').behavior).toBe('ask')
  })

  it('asks for cat on win32 (Get-Content reaches Variable:, Env:, Cert:)', () => {
    expect(checkBashPermissions('cat foo.txt', 'win32').behavior).toBe('ask')
  })

  it('asks for ls Env: on win32 — even without operators, providers leak', () => {
    expect(checkBashPermissions('ls Env:', 'win32').behavior).toBe('ask')
  })

  it('asks for git status on win32 (no auto-allow)', () => {
    expect(checkBashPermissions('git status', 'win32').behavior).toBe('ask')
  })

  it('asks for shell-operator commands on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(checkBashPermissions('ls | grep foo', platform).behavior).toBe('ask')
      expect(checkBashPermissions('echo $(whoami)', platform).behavior).toBe('ask')
    }
  })
})

// ---------------------------------------------------------------------------
// resolveBashCwd — prefers workingDirectories[0], falls back to process.cwd
// ---------------------------------------------------------------------------

describe('maybeAppendSandboxHint', () => {
  const sandboxed: ShellSandboxDecision = {
    kind: 'sandboxed',
    platform: 'darwin',
    mechanism: 'seatbelt',
    reason: 'available',
  }
  const permissionOnly: ShellSandboxDecision = {
    kind: 'permissionOnly',
    platform: 'darwin',
    reason: 'sandbox_unavailable_fallback',
  }
  const refuse: ShellSandboxDecision = {
    kind: 'refuse',
    platform: 'darwin',
    reason: 'sandbox_required_but_unavailable',
  }

  it('appends a hint when sandboxed and output contains "Operation not permitted"', () => {
    const out = maybeAppendSandboxHint(
      sandboxed,
      "open('/etc/foo'): Operation not permitted",
    )
    expect(out).toContain('[ultron hint]')
    expect(out).toContain('~/.ultron/settings.json')
  })

  it('appends a hint for "Permission denied"', () => {
    const out = maybeAppendSandboxHint(sandboxed, 'cat: foo: Permission denied')
    expect(out).toContain('[ultron hint]')
  })

  it('appends a hint for EACCES', () => {
    const out = maybeAppendSandboxHint(
      sandboxed,
      "Error: EACCES: permission denied, open '/etc/foo'",
    )
    expect(out).toContain('[ultron hint]')
  })

  it('appends a hint for EPERM', () => {
    const out = maybeAppendSandboxHint(sandboxed, 'EPERM: operation failed')
    expect(out).toContain('[ultron hint]')
  })

  it('does NOT add a hint for unrelated errors under sandboxed', () => {
    const out = maybeAppendSandboxHint(sandboxed, 'syntax error near token')
    expect(out).not.toContain('[ultron hint]')
    expect(out).toBe('syntax error near token')
  })

  it('does NOT add a hint when decision is permissionOnly', () => {
    const out = maybeAppendSandboxHint(
      permissionOnly,
      'Operation not permitted',
    )
    expect(out).not.toContain('[ultron hint]')
  })

  it('does NOT add a hint when decision is refuse', () => {
    const out = maybeAppendSandboxHint(refuse, 'Operation not permitted')
    expect(out).not.toContain('[ultron hint]')
  })

  it('returns empty output unchanged', () => {
    expect(maybeAppendSandboxHint(sandboxed, '')).toBe('')
  })

  it('preserves the original output before the hint', () => {
    const out = maybeAppendSandboxHint(sandboxed, 'EACCES: open /etc/foo')
    expect(out.startsWith('EACCES: open /etc/foo')).toBe(true)
  })
})

describe('resolveBashCwd', () => {
  it('prefers workingDirectories[0] when set', () => {
    const state = { ...getDefaultAppState(), workingDirectories: ['/some/project'] }
    expect(resolveBashCwd(state)).toBe('/some/project')
  })

  it('uses the first entry when multiple are configured', () => {
    const state = {
      ...getDefaultAppState(),
      workingDirectories: ['/first', '/second'],
    }
    expect(resolveBashCwd(state)).toBe('/first')
  })

  it('falls back to process.cwd() when workingDirectories is empty', () => {
    expect(resolveBashCwd(getDefaultAppState())).toBe(process.cwd())
  })
})
