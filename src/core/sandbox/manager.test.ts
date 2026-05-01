import { describe, expect, it, beforeEach, vi } from 'vitest'

import { commandMatchesExcluded, decideShellExecution } from './manager.js'
import { defaultShellSandboxSettings } from './settings.js'
import type { ShellSandboxSettings } from './types.js'

// macosSeatbelt's `detectSandboxExec` reads from the real filesystem;
// mock it so decision tests stay fast and deterministic.
vi.mock('./macosSeatbelt.js', () => ({
  detectSandboxExec: vi.fn(),
}))

import { detectSandboxExec } from './macosSeatbelt.js'

const detectMock = detectSandboxExec as unknown as ReturnType<typeof vi.fn>

const baseSettings: ShellSandboxSettings = {
  ...defaultShellSandboxSettings,
  enabled: true,
  excludedCommands: [],
}

beforeEach(() => {
  detectMock.mockReset()
})

describe('commandMatchesExcluded', () => {
  it('returns false when the excluded list is empty', () => {
    expect(commandMatchesExcluded('rm -rf /', [])).toBe(false)
  })

  it('matches the bare verb', () => {
    expect(commandMatchesExcluded('rm -rf /', ['rm'])).toBe(true)
    expect(commandMatchesExcluded('vim file', ['rm'])).toBe(false)
  })

  it('matches a two-word git/npm/node/tsc subcommand', () => {
    expect(commandMatchesExcluded('git push origin main', ['git push'])).toBe(true)
    expect(commandMatchesExcluded('git status', ['git push'])).toBe(false)
    expect(commandMatchesExcluded('npm install left-pad', ['npm install'])).toBe(true)
  })

  it('does not substring-match', () => {
    expect(commandMatchesExcluded('npm test', ['rm'])).toBe(false)
  })

  it('handles leading whitespace', () => {
    expect(commandMatchesExcluded('   rm foo', ['rm'])).toBe(true)
  })
})

describe('decideShellExecution', () => {
  describe('sandbox disabled', () => {
    it('returns permissionOnly with sandbox_disabled', async () => {
      const decision = await decideShellExecution({
        settings: { ...baseSettings, enabled: false },
        command: 'echo hi',
        platform: 'darwin',
      })
      expect(decision.kind).toBe('permissionOnly')
      expect(decision.reason).toBe('sandbox_disabled')
    })
  })

  describe('darwin', () => {
    it('returns sandboxed when sandbox-exec is available', async () => {
      detectMock.mockResolvedValueOnce(true)
      const decision = await decideShellExecution({
        settings: baseSettings,
        command: 'echo hi',
        platform: 'darwin',
      })
      expect(decision.kind).toBe('sandboxed')
      if (decision.kind === 'sandboxed') {
        expect(decision.mechanism).toBe('seatbelt')
        expect(decision.reason).toBe('available')
      }
    })

    it('returns permissionOnly with sandbox_unavailable_fallback when sandbox-exec is missing and fallback is allowed', async () => {
      detectMock.mockResolvedValueOnce(false)
      const decision = await decideShellExecution({
        settings: { ...baseSettings, allowUnsandboxedCommands: true },
        command: 'echo hi',
        platform: 'darwin',
      })
      expect(decision.kind).toBe('permissionOnly')
      expect(decision.reason).toBe('sandbox_unavailable_fallback')
    })

    it('refuses when sandbox-exec is missing and failIfUnavailable is true', async () => {
      detectMock.mockResolvedValueOnce(false)
      const decision = await decideShellExecution({
        settings: { ...baseSettings, failIfUnavailable: true },
        command: 'echo hi',
        platform: 'darwin',
      })
      expect(decision.kind).toBe('refuse')
      expect(decision.reason).toBe('sandbox_required_but_unavailable')
    })

    it('refuses when sandbox-exec is missing and unsandboxed is disallowed', async () => {
      detectMock.mockResolvedValueOnce(false)
      const decision = await decideShellExecution({
        settings: { ...baseSettings, allowUnsandboxedCommands: false },
        command: 'echo hi',
        platform: 'darwin',
      })
      expect(decision.kind).toBe('refuse')
      expect(decision.reason).toBe('sandbox_required_but_unavailable')
    })
  })

  describe('win32', () => {
    it('returns permissionOnly with native_windows_unsupported when fallback is allowed', async () => {
      const decision = await decideShellExecution({
        settings: baseSettings,
        command: 'dir',
        platform: 'win32',
      })
      expect(decision.kind).toBe('permissionOnly')
      expect(decision.reason).toBe('native_windows_unsupported')
    })

    it('refuses when failIfUnavailable is true', async () => {
      const decision = await decideShellExecution({
        settings: { ...baseSettings, failIfUnavailable: true },
        command: 'dir',
        platform: 'win32',
      })
      expect(decision.kind).toBe('refuse')
      expect(decision.reason).toBe('native_windows_unsupported')
    })

    it('refuses when allowUnsandboxedCommands is false', async () => {
      const decision = await decideShellExecution({
        settings: { ...baseSettings, allowUnsandboxedCommands: false },
        command: 'dir',
        platform: 'win32',
      })
      expect(decision.kind).toBe('refuse')
      expect(decision.reason).toBe('native_windows_unsupported')
    })

    it('returns permissionOnly with sandbox_disabled when not enabled', async () => {
      const decision = await decideShellExecution({
        settings: { ...baseSettings, enabled: false },
        command: 'dir',
        platform: 'win32',
      })
      expect(decision.kind).toBe('permissionOnly')
      expect(decision.reason).toBe('sandbox_disabled')
    })
  })

  describe('excludedCommands', () => {
    it('routes excluded command to refuse when failIfUnavailable is true', async () => {
      const decision = await decideShellExecution({
        settings: {
          ...baseSettings,
          excludedCommands: ['rm'],
          failIfUnavailable: true,
        },
        command: 'rm -rf /',
        platform: 'darwin',
      })
      expect(decision.kind).toBe('refuse')
      expect(decision.reason).toBe('command_excluded')
    })

    it('routes excluded command to permissionOnly under default policy', async () => {
      const decision = await decideShellExecution({
        settings: { ...baseSettings, excludedCommands: ['rm'] },
        command: 'rm -rf /',
        platform: 'darwin',
      })
      expect(decision.kind).toBe('permissionOnly')
      expect(decision.reason).toBe('sandbox_disabled')
    })

    it('does not match when the verb differs', async () => {
      detectMock.mockResolvedValueOnce(true)
      const decision = await decideShellExecution({
        settings: { ...baseSettings, excludedCommands: ['rm'] },
        command: 'echo hi',
        platform: 'darwin',
      })
      expect(decision.kind).toBe('sandboxed')
    })
  })

  describe('linux and other platforms', () => {
    it('returns permissionOnly with unsupported_platform when fallback allowed', async () => {
      const decision = await decideShellExecution({
        settings: baseSettings,
        command: 'echo hi',
        platform: 'linux',
      })
      expect(decision.kind).toBe('permissionOnly')
      expect(decision.reason).toBe('unsupported_platform')
    })

    it('refuses on unsupported platform under strict policy', async () => {
      const decision = await decideShellExecution({
        settings: { ...baseSettings, failIfUnavailable: true },
        command: 'echo hi',
        platform: 'linux',
      })
      expect(decision.kind).toBe('refuse')
      expect(decision.reason).toBe('sandbox_required_but_unavailable')
    })
  })
})
