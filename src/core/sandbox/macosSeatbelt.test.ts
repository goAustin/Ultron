import { describe, expect, it } from 'vitest'

import {
  buildSeatbeltArgv,
  generateSeatbeltProfile,
} from './macosSeatbelt.js'
import { defaultShellSandboxSettings } from './settings.js'
import type { ShellSandboxSettings } from './types.js'

const baseSettings: ShellSandboxSettings = {
  ...defaultShellSandboxSettings,
  filesystem: {
    allowWrite: ['.'],
    denyWrite: [],
    allowRead: ['.'],
    denyRead: [],
  },
}

describe('generateSeatbeltProfile', () => {
  it('begins with version 1 and allow default', () => {
    const { profile } = generateSeatbeltProfile({
      workspace: '/Users/test/proj',
      settings: baseSettings,
    })
    const lines = profile.split('\n')
    expect(lines[0]).toBe('(version 1)')
    expect(lines[1]).toBe('(allow default)')
    expect(lines[2]).toBe('(deny file-write*)')
  })

  it('includes the workspace as a writable root', () => {
    const { profile, writableRoots } = generateSeatbeltProfile({
      workspace: '/Users/test/proj',
      settings: baseSettings,
    })
    expect(writableRoots).toContain('/Users/test/proj')
    expect(profile).toContain('(allow file-write* (subpath "/Users/test/proj"))')
  })

  it('always includes /dev so tty/null/pipe writes are not blocked', () => {
    const { writableRoots } = generateSeatbeltProfile({
      workspace: '/Users/test/proj',
      settings: baseSettings,
    })
    expect(writableRoots).toContain('/dev')
  })

  it('always includes the temp area for shell utilities', () => {
    const { writableRoots } = generateSeatbeltProfile({
      workspace: '/Users/test/proj',
      settings: baseSettings,
    })
    expect(writableRoots).toContain('/private/tmp')
    expect(writableRoots).toContain('/private/var/folders')
  })

  it('places deny rules AFTER allow rules so deny precedence holds', () => {
    const settings: ShellSandboxSettings = {
      ...baseSettings,
      filesystem: {
        allowWrite: ['/Users/test/proj'],
        denyWrite: ['/Users/test/proj/.env'],
        allowRead: [],
        denyRead: [],
      },
    }
    const { profile } = generateSeatbeltProfile({
      workspace: '/Users/test/proj',
      settings,
    })
    const allowIdx = profile.indexOf(
      '(allow file-write* (subpath "/Users/test/proj"))',
    )
    const denyIdx = profile.indexOf(
      '(deny file-write* (subpath "/Users/test/proj/.env"))',
    )
    expect(allowIdx).toBeGreaterThan(-1)
    expect(denyIdx).toBeGreaterThan(allowIdx)
  })

  it('escapes quotes and backslashes in paths', () => {
    const settings: ShellSandboxSettings = {
      ...baseSettings,
      filesystem: {
        allowWrite: ['/weird/path with "quote"'],
        denyWrite: [],
        allowRead: [],
        denyRead: [],
      },
    }
    const { profile } = generateSeatbeltProfile({
      workspace: '/Users/test/proj',
      settings,
    })
    expect(profile).toContain(
      '(allow file-write* (subpath "/weird/path with \\"quote\\""))',
    )
  })

  it('expands bare deny paths to both workspace and home variants', () => {
    const settings: ShellSandboxSettings = {
      ...baseSettings,
      filesystem: {
        allowWrite: [],
        denyWrite: ['.env'],
        allowRead: [],
        denyRead: [],
      },
    }
    const { profile, deniedWrites } = generateSeatbeltProfile({
      workspace: '/Users/test/proj',
      settings,
    })
    // Two denied write roots: home/.env and workspace/.env
    expect(deniedWrites).toHaveLength(2)
    for (const root of deniedWrites) {
      expect(profile).toContain(`(deny file-write* (subpath "${root}"))`)
    }
  })

  it('emits file-read* deny rules for denyRead entries', () => {
    const settings: ShellSandboxSettings = {
      ...baseSettings,
      filesystem: {
        allowWrite: [],
        denyWrite: [],
        allowRead: [],
        denyRead: ['.ssh', '/etc/passwd'],
      },
    }
    const { profile, deniedReads } = generateSeatbeltProfile({
      workspace: '/Users/test/proj',
      settings,
    })
    // .ssh resolves to home/.ssh + workspace/.ssh; /etc/passwd is absolute
    expect(deniedReads.length).toBeGreaterThanOrEqual(2)
    for (const root of deniedReads) {
      expect(profile).toContain(`(deny file-read* (subpath "${root}"))`)
    }
  })

  it('places read denies AFTER (allow default) so deny precedence holds', () => {
    const settings: ShellSandboxSettings = {
      ...baseSettings,
      filesystem: {
        allowWrite: [],
        denyWrite: [],
        allowRead: [],
        // Use a path that doesn't exist (no firmlink rewriting on canonicalize).
        denyRead: ['/no-such-path-xyz/secret'],
      },
    }
    const { profile } = generateSeatbeltProfile({
      workspace: '/Users/test/proj',
      settings,
    })
    const allowDefaultIdx = profile.indexOf('(allow default)')
    const denyReadIdx = profile.indexOf(
      '(deny file-read* (subpath "/no-such-path-xyz/secret"))',
    )
    expect(allowDefaultIdx).toBeGreaterThan(-1)
    expect(denyReadIdx).toBeGreaterThan(allowDefaultIdx)
  })
})

describe('buildSeatbeltArgv', () => {
  it('passes profile and command as separate argv entries', () => {
    const { executable, args } = buildSeatbeltArgv('(version 1)', 'echo hello')
    expect(executable).toBe('/usr/bin/sandbox-exec')
    expect(args).toEqual(['-p', '(version 1)', '/bin/bash', '-c', 'echo hello'])
  })

  it('does not interpolate metacharacters from the user command', () => {
    const malicious = "echo hi; rm -rf $HOME"
    const { args } = buildSeatbeltArgv('(version 1)', malicious)
    // The full command stays as one argv entry — bash interprets it, not the
    // shell that spawns sandbox-exec.
    expect(args[args.length - 1]).toBe(malicious)
  })
})
