/**
 * macOS-gated integration tests for the Seatbelt wrap.
 *
 * These tests actually shell out to `/usr/bin/sandbox-exec` and assert on
 * real kernel-enforced filesystem containment. They do not run on Linux
 * or Windows — Seatbelt is macOS-only.
 *
 * Each test runs the wrapped invocation directly via `execFile` so the
 * assertion surface is the real OS, not a BashTool double.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  buildSeatbeltArgv,
  detectSandboxExec,
  generateSeatbeltProfile,
} from './macosSeatbelt.js'
import { defaultShellSandboxSettings } from './settings.js'
import type { ShellSandboxSettings } from './types.js'

const execFileAsync = promisify(execFile)

const isDarwin = process.platform === 'darwin'

type RunResult = {
  stdout: string
  stderr: string
  code: number
}

async function runSandboxed(
  command: string,
  workspace: string,
  overrides?: Partial<ShellSandboxSettings>,
): Promise<RunResult> {
  const settings: ShellSandboxSettings = {
    ...defaultShellSandboxSettings,
    enabled: true,
    ...overrides,
    filesystem: {
      ...defaultShellSandboxSettings.filesystem,
      ...(overrides?.filesystem ?? {}),
    },
  }
  const { profile } = generateSeatbeltProfile({ workspace, settings })
  const { executable, args } = buildSeatbeltArgv(profile, command)

  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code: err && 'code' in err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        })
      },
    )
  })
}

describe.skipIf(!isDarwin)('macOS Seatbelt integration', () => {
  it('detects sandbox-exec is available', async () => {
    expect(await detectSandboxExec()).toBe(true)
  })

  it('verifies the sandbox-exec binary itself runs', async () => {
    // sandbox-exec without a profile prints usage and exits non-zero, but
    // the spawn itself must succeed for the rest of these tests to mean
    // anything. Catching the err lets us detect ENOENT vs. usage error.
    let spawned = true
    try {
      await execFileAsync('/usr/bin/sandbox-exec', [])
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') spawned = false
    }
    expect(spawned).toBe(true)
  })

  it('lets a sandboxed command write inside the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ultron-sandbox-ws-'))
    try {
      const target = join(workspace, 'inside.txt')
      const result = await runSandboxed(
        `printf hello > ${shellQuote(target)}`,
        workspace,
      )
      expect(result.code).toBe(0)
      expect(readFileSync(target, 'utf8')).toBe('hello')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('blocks writes to system paths like /etc', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ultron-sandbox-ws-'))
    try {
      // /etc is not in any allowlist (implicit or user). Write must fail.
      // Use a non-existent target so the test doesn't depend on /etc state.
      const target = '/etc/ultron-sandbox-should-not-exist'
      const result = await runSandboxed(
        `printf hello > ${shellQuote(target)} 2>&1`,
        workspace,
      )
      expect(result.code).not.toBe(0)
      let exists = true
      try {
        readFileSync(target, 'utf8')
      } catch {
        exists = false
      }
      expect(exists).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('honors deny precedence over allow for sensitive paths', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ultron-sandbox-ws-'))
    try {
      const target = join(workspace, '.env')
      const result = await runSandboxed(
        `printf SECRET > ${shellQuote(target)}`,
        workspace,
        {
          filesystem: {
            allowWrite: ['.'],
            denyWrite: [target],
            allowRead: ['.'],
            denyRead: [],
          },
        },
      )
      expect(result.code).not.toBe(0)
      let exists = true
      try {
        readFileSync(target, 'utf8')
      } catch {
        exists = false
      }
      expect(exists).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('blocks reads to paths listed in denyRead', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ultron-sandbox-ws-'))
    try {
      const secret = join(workspace, 'secret.txt')
      // Seed the file unsandboxed so the read is the only thing tested.
      execFile('/bin/sh', ['-c', `printf SECRET > ${shellQuote(secret)}`])
      // Wait for the seed to land before launching the sandboxed read.
      await new Promise((r) => setTimeout(r, 50))

      const result = await runSandboxed(
        `cat ${shellQuote(secret)}`,
        workspace,
        {
          filesystem: {
            allowWrite: ['.'],
            denyWrite: [],
            allowRead: ['.'],
            denyRead: [secret],
          },
        },
      )
      // Sandbox should block the read; cat exits non-zero.
      expect(result.code).not.toBe(0)
      expect(result.stdout).not.toContain('SECRET')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('runs basic read-only commands without surprise breakage', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ultron-sandbox-ws-'))
    try {
      const result = await runSandboxed('echo hello-from-sandbox', workspace)
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('hello-from-sandbox')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

/**
 * Minimal shell-safe quoting for paths inside test-generated bash commands.
 * Test-only; do not use in production paths.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}
