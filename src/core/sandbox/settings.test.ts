import { describe, expect, it } from 'vitest'

import {
  defaultShellSandboxSettings,
  mergeShellSandboxSettings,
  resolveSandboxPaths,
} from './settings.js'
import type { ShellSandboxSettings } from './types.js'

describe('defaultShellSandboxSettings', () => {
  it('enables sandbox on darwin and win32, disables elsewhere', () => {
    const expected =
      process.platform === 'darwin' || process.platform === 'win32'
    expect(defaultShellSandboxSettings.enabled).toBe(expected)
  })

  it('does not auto-allow bash even when sandboxed', () => {
    expect(defaultShellSandboxSettings.autoAllowBashIfSandboxed).toBe(false)
  })

  it('protects ultron settings and common secret paths', () => {
    expect(defaultShellSandboxSettings.filesystem.denyWrite).toContain('.ultron/settings')
    expect(defaultShellSandboxSettings.filesystem.denyWrite).toContain('.env')
    expect(defaultShellSandboxSettings.filesystem.denyWrite).toContain('.ssh')
  })
})

describe('resolveSandboxPaths', () => {
  const home = '/Users/test'
  const workspace = '/Users/test/projects/app'

  it('passes absolute paths through unchanged', () => {
    expect(resolveSandboxPaths(['/etc/hosts'], workspace, home)).toEqual(['/etc/hosts'])
  })

  it('resolves "~/" against the home directory', () => {
    expect(resolveSandboxPaths(['~/.aws'], workspace, home)).toEqual(['/Users/test/.aws'])
  })

  it('treats "." and "./" as workspace-only (not home)', () => {
    expect(resolveSandboxPaths(['.'], workspace, home)).toEqual([workspace])
    expect(resolveSandboxPaths(['./'], workspace, home)).toEqual([workspace])
  })

  it('expands bare relative paths to BOTH home and workspace', () => {
    const out = resolveSandboxPaths(['.env'], workspace, home)
    expect(out).toContain('/Users/test/.env')
    expect(out).toContain('/Users/test/projects/app/.env')
    expect(out).toHaveLength(2)
  })

  it('handles nested bare relative paths', () => {
    const out = resolveSandboxPaths(['.ultron/settings'], workspace, home)
    expect(out).toContain('/Users/test/.ultron/settings')
    expect(out).toContain('/Users/test/projects/app/.ultron/settings')
  })

  it('deduplicates when home and workspace happen to coincide', () => {
    const out = resolveSandboxPaths(['.env'], '/Users/test', '/Users/test')
    expect(out).toEqual(['/Users/test/.env'])
  })

  it('skips empty entries', () => {
    expect(resolveSandboxPaths([''], workspace, home)).toEqual([])
  })

  it('mixes all four path forms in one call', () => {
    const out = resolveSandboxPaths(
      ['/etc/hosts', '~/.aws', '.', '.env'],
      workspace,
      home,
    )
    expect(out).toEqual(
      expect.arrayContaining([
        '/etc/hosts',
        '/Users/test/.aws',
        workspace,
        '/Users/test/.env',
        '/Users/test/projects/app/.env',
      ]),
    )
  })
})

describe('mergeShellSandboxSettings', () => {
  const base: ShellSandboxSettings = {
    enabled: false,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
    excludedCommands: [],
    filesystem: {
      allowWrite: ['default-allow'],
      denyWrite: ['default-deny'],
      allowRead: [],
      denyRead: [],
    },
    network: { allowedDomains: [] },
  }

  it('returns the base unchanged when input is undefined', () => {
    expect(mergeShellSandboxSettings(undefined, base)).toBe(base)
  })

  it('overlays only the keys present in the input', () => {
    const out = mergeShellSandboxSettings({ failIfUnavailable: true }, base)
    expect(out.failIfUnavailable).toBe(true)
    expect(out.enabled).toBe(false)
    expect(out.filesystem.allowWrite).toEqual(['default-allow'])
  })

  it('replaces array leaves wholesale when provided', () => {
    const out = mergeShellSandboxSettings(
      { filesystem: { denyWrite: ['custom.secret'] } },
      base,
    )
    expect(out.filesystem.denyWrite).toEqual(['custom.secret'])
    // Other filesystem keys preserved from base
    expect(out.filesystem.allowWrite).toEqual(['default-allow'])
  })

  it('handles network.allowedDomains as a leaf', () => {
    const out = mergeShellSandboxSettings(
      { network: { allowedDomains: ['github.com'] } },
      base,
    )
    expect(out.network.allowedDomains).toEqual(['github.com'])
  })

  it('uses defaultShellSandboxSettings as the base when omitted', () => {
    const out = mergeShellSandboxSettings({ failIfUnavailable: true })
    expect(out.failIfUnavailable).toBe(true)
    expect(out.allowUnsandboxedCommands).toBe(
      defaultShellSandboxSettings.allowUnsandboxedCommands,
    )
  })
})
