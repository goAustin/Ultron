import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, symlinkSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  DANGEROUS_FILES,
  DANGEROUS_DIRECTORIES,
  normalizeMacOSPath,
  getPathsToCheck,
  isDangerousPath,
  isWithinDirectory,
  dangerousPathSafetyCheck,
  workingDirectorySafetyCheck,
  filesystemSafetyChecks,
} from './filesystem.js'
import type { SafetyCheck } from './types.js'
import { DEFAULT_PERMISSION_OPTIONS } from './types.js'
import { buildTool } from '../tools/types.js'
import type { Tool } from '../tools/types.js'
import type { ToolUseContext } from '../tools/context.js'
import { createToolUseContext } from '../tools/context.js'
import { createToolRegistry } from '../tools/registry.js'
import { createStore, getDefaultAppState } from '../state.js'
import type { AppState } from '../state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, opts: { path?: string; isMutating?: boolean } = {}): Tool {
  return buildTool({
    name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    call: async () => ({ content: 'ok', isError: false }),
    ...(opts.isMutating !== undefined ? { isMutating: opts.isMutating } : {}),
    ...(opts.path !== undefined ? { getPath: () => opts.path! } : {}),
  })
}

function makeContext(stateOverrides?: Partial<AppState>): ToolUseContext {
  return createToolUseContext({
    appState: createStore({ ...getDefaultAppState(), ...stateOverrides }),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createToolRegistry(),
  })
}

/** Create a temp directory for symlink tests. Cleaned up after use. */
function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-fs-test-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// normalizeMacOSPath
// ---------------------------------------------------------------------------

describe('normalizeMacOSPath', () => {
  it('normalizes /private/var/ to /var/', () => {
    expect(normalizeMacOSPath('/private/var/folders/x')).toBe('/var/folders/x')
  })

  it('normalizes /private/tmp to /tmp', () => {
    expect(normalizeMacOSPath('/private/tmp/file.txt')).toBe('/tmp/file.txt')
  })

  it('normalizes /private/tmp at end of path', () => {
    expect(normalizeMacOSPath('/private/tmp')).toBe('/tmp')
  })

  it('does not normalize unrelated /private paths', () => {
    expect(normalizeMacOSPath('/private/etc/hosts')).toBe('/private/etc/hosts')
  })
})

// ---------------------------------------------------------------------------
// isDangerousPath
// ---------------------------------------------------------------------------

describe('isDangerousPath', () => {
  it('detects shell rc files', () => {
    expect(isDangerousPath('/home/user/.bashrc')).toBe(true)
    expect(isDangerousPath('/home/user/.zshrc')).toBe(true)
    expect(isDangerousPath('/home/user/.profile')).toBe(true)
    expect(isDangerousPath('/home/user/.bash_profile')).toBe(true)
    expect(isDangerousPath('/home/user/.zprofile')).toBe(true)
  })

  it('detects git config files', () => {
    expect(isDangerousPath('/home/user/.gitconfig')).toBe(true)
    expect(isDangerousPath('/repo/.gitmodules')).toBe(true)
  })

  it('detects dangerous directories', () => {
    expect(isDangerousPath('/repo/.git/config')).toBe(true)
    expect(isDangerousPath('/repo/.git/hooks/pre-commit')).toBe(true)
    expect(isDangerousPath('/repo/.vscode/tasks.json')).toBe(true)
    expect(isDangerousPath('/repo/.idea/runConfigurations/test.xml')).toBe(true)
    expect(isDangerousPath('/repo/.claude/settings.json')).toBe(true)
  })

  it('detects case variations', () => {
    expect(isDangerousPath('/repo/.Git/config')).toBe(true)
    expect(isDangerousPath('/repo/.GIT/hooks/pre-commit')).toBe(true)
    expect(isDangerousPath('/home/user/.BASHRC')).toBe(true)
    expect(isDangerousPath('/repo/.VSCode/settings.json')).toBe(true)
  })

  it('does not flag normal files', () => {
    expect(isDangerousPath('/repo/src/main.ts')).toBe(false)
    expect(isDangerousPath('/repo/package.json')).toBe(false)
    expect(isDangerousPath('/repo/README.md')).toBe(false)
  })

  it('does not flag files that partially match dangerous names', () => {
    expect(isDangerousPath('/repo/src/.gitkeep')).toBe(false)
    expect(isDangerousPath('/repo/bashrc-backup')).toBe(false)
  })

  it('detects deeply nested dangerous dirs', () => {
    expect(isDangerousPath('/repo/subdir/nested/.git/config')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isWithinDirectory
// ---------------------------------------------------------------------------

describe('isWithinDirectory', () => {
  it('returns true for a file inside the directory', () => {
    expect(isWithinDirectory('/repo/src/main.ts', '/repo')).toBe(true)
  })

  it('returns true for exact same path', () => {
    expect(isWithinDirectory('/repo', '/repo')).toBe(true)
  })

  it('returns true for a deeply nested file', () => {
    expect(isWithinDirectory('/repo/a/b/c/d.ts', '/repo')).toBe(true)
  })

  it('returns false for a path outside the directory', () => {
    expect(isWithinDirectory('/other/file.ts', '/repo')).toBe(false)
  })

  it('returns false for traversal', () => {
    expect(isWithinDirectory('/repo/../etc/passwd', '/repo')).toBe(false)
  })

  it('handles macOS /private/tmp normalization', () => {
    expect(isWithinDirectory('/private/tmp/workdir/file.ts', '/tmp/workdir')).toBe(true)
  })

  it('handles macOS /private/var normalization', () => {
    expect(isWithinDirectory('/private/var/folders/x/file', '/var/folders/x')).toBe(true)
  })

  it('does not confuse prefix-sharing paths', () => {
    // /repo-other is not inside /repo
    expect(isWithinDirectory('/repo-other/file.ts', '/repo')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getPathsToCheck — symlink resolution
// ---------------------------------------------------------------------------

describe('getPathsToCheck', () => {
  it('returns absolute path for a nonexistent file', () => {
    const paths = getPathsToCheck('/nonexistent/path/file.txt')
    expect(paths).toContain('/nonexistent/path/file.txt')
    expect(paths.length).toBeGreaterThanOrEqual(1)
  })

  it('deduplicates when realpath equals original', () => {
    withTmpDir((dir) => {
      // dir itself exists and its realpath may equal the original
      const paths = getPathsToCheck(dir)
      // Should contain the original (possibly normalized by realpath)
      expect(paths.length).toBeGreaterThanOrEqual(1)
      // No duplicates
      expect(new Set(paths).size).toBe(paths.length)
    })
  })

  it('resolves symlinks to different paths', () => {
    withTmpDir((dir) => {
      const target = join(dir, 'target')
      mkdirSync(target)
      const link = join(dir, 'link')
      symlinkSync(target, link)

      const paths = getPathsToCheck(join(link, 'file.txt'))
      // Should include both the link-based path and the target-based path
      expect(paths.length).toBe(2)
      expect(paths.some((p) => p.includes('link'))).toBe(true)
      expect(paths.some((p) => p.includes('target'))).toBe(true)
    })
  })

  it('resolves nearest existing ancestor for nonexistent files under symlinked parents', () => {
    withTmpDir((dir) => {
      const target = join(dir, 'target')
      mkdirSync(target)
      const link = join(dir, 'link')
      symlinkSync(target, link)

      // file.txt doesn't exist, but link/ is a symlink to target/
      const paths = getPathsToCheck(join(link, 'file.txt'))
      expect(paths.some((p) => p.includes('target'))).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// dangerousPathSafetyCheck
// ---------------------------------------------------------------------------

describe('dangerousPathSafetyCheck', () => {
  const ctx = makeContext()

  it('returns ask for mutating tool targeting dangerous file', () => {
    const tool = makeTool('FileWrite', { path: '/home/user/.bashrc', isMutating: true })
    const result = dangerousPathSafetyCheck(tool, {}, ctx)
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('ask')
    expect(result!.reason.type).toBe('safetyCheck')
  })

  it('returns ask for mutating tool targeting dangerous directory', () => {
    const tool = makeTool('FileWrite', { path: '/repo/.git/config', isMutating: true })
    const result = dangerousPathSafetyCheck(tool, {}, ctx)
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('ask')
  })

  it('returns null for read-only tool targeting dangerous file', () => {
    const tool = makeTool('FileRead', { path: '/home/user/.bashrc', isMutating: false })
    const result = dangerousPathSafetyCheck(tool, {}, ctx)
    expect(result).toBeNull()
  })

  it('returns null for tool without getPath', () => {
    const tool = makeTool('Bash', { isMutating: true })
    const result = dangerousPathSafetyCheck(tool, {}, ctx)
    expect(result).toBeNull()
  })

  it('returns null for mutating tool targeting safe file', () => {
    const tool = makeTool('FileWrite', { path: '/repo/src/main.ts', isMutating: true })
    const result = dangerousPathSafetyCheck(tool, {}, ctx)
    expect(result).toBeNull()
  })

  it('treats undefined isMutating as mutating (conservative)', () => {
    const tool = makeTool('FileWrite', { path: '/home/user/.bashrc' })
    const result = dangerousPathSafetyCheck(tool, {}, ctx)
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('ask')
  })

  it('catches symlinks to dangerous files', () => {
    withTmpDir((dir) => {
      const dangerousTarget = join(dir, '.bashrc')
      // Create the target file
      require('fs').writeFileSync(dangerousTarget, 'export PATH=...')
      const link = join(dir, 'innocent.txt')
      symlinkSync(dangerousTarget, link)

      const tool = makeTool('FileWrite', { path: link, isMutating: true })
      const result = dangerousPathSafetyCheck(tool, {}, ctx)
      expect(result).not.toBeNull()
      expect(result!.behavior).toBe('ask')
    })
  })

  it('includes meaningful message in reason', () => {
    const tool = makeTool('FileWrite', { path: '/repo/.git/hooks/pre-commit', isMutating: true })
    const result = dangerousPathSafetyCheck(tool, {}, ctx)
    expect(result).not.toBeNull()
    expect((result!.reason as { message: string }).message).toContain('sensitive file')
    expect((result!.reason as { message: string }).message).toContain('.git/hooks/pre-commit')
  })
})

// ---------------------------------------------------------------------------
// workingDirectorySafetyCheck
// ---------------------------------------------------------------------------

describe('workingDirectorySafetyCheck', () => {
  it('returns null when no working directories configured', () => {
    const ctx = makeContext({ workingDirectories: [] })
    const tool = makeTool('FileWrite', { path: '/anywhere/file.ts', isMutating: true })
    const result = workingDirectorySafetyCheck(tool, {}, ctx)
    expect(result).toBeNull()
  })

  it('returns null for path inside working directory', () => {
    const ctx = makeContext({ workingDirectories: ['/repo'] })
    const tool = makeTool('FileWrite', { path: '/repo/src/main.ts', isMutating: true })
    const result = workingDirectorySafetyCheck(tool, {}, ctx)
    expect(result).toBeNull()
  })

  it('returns ask for path outside working directory', () => {
    const ctx = makeContext({ workingDirectories: ['/repo'] })
    const tool = makeTool('FileWrite', { path: '/etc/hosts', isMutating: true })
    const result = workingDirectorySafetyCheck(tool, {}, ctx)
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('ask')
  })

  it('returns null for read-only tool outside working directory', () => {
    const ctx = makeContext({ workingDirectories: ['/repo'] })
    const tool = makeTool('FileRead', { path: '/etc/hosts', isMutating: false })
    const result = workingDirectorySafetyCheck(tool, {}, ctx)
    expect(result).toBeNull()
  })

  it('returns null for tool without getPath', () => {
    const ctx = makeContext({ workingDirectories: ['/repo'] })
    const tool = makeTool('Bash', { isMutating: true })
    const result = workingDirectorySafetyCheck(tool, {}, ctx)
    expect(result).toBeNull()
  })

  it('allows path inside any of multiple working directories', () => {
    const ctx = makeContext({ workingDirectories: ['/repo', '/other'] })
    const tool = makeTool('FileWrite', { path: '/other/file.ts', isMutating: true })
    const result = workingDirectorySafetyCheck(tool, {}, ctx)
    expect(result).toBeNull()
  })

  it('catches symlink escape from working directory', () => {
    withTmpDir((dir) => {
      const inside = join(dir, 'repo')
      mkdirSync(inside)
      const outside = join(dir, 'outside')
      mkdirSync(outside)
      const link = join(inside, 'escape')
      symlinkSync(outside, link)

      const ctx = makeContext({ workingDirectories: [inside] })
      const tool = makeTool('FileWrite', { path: join(link, 'file.ts'), isMutating: true })
      const result = workingDirectorySafetyCheck(tool, {}, ctx)
      expect(result).not.toBeNull()
      expect(result!.behavior).toBe('ask')
    })
  })

  it('includes meaningful message in reason', () => {
    const ctx = makeContext({ workingDirectories: ['/repo'] })
    const tool = makeTool('FileWrite', { path: '/etc/passwd', isMutating: true })
    const result = workingDirectorySafetyCheck(tool, {}, ctx)
    expect(result).not.toBeNull()
    expect((result!.reason as { message: string }).message).toContain('outside the allowed working directories')
  })
})

// ---------------------------------------------------------------------------
// filesystemSafetyChecks — convenience export
// ---------------------------------------------------------------------------

describe('filesystemSafetyChecks', () => {
  it('contains all safety checks', () => {
    expect(filesystemSafetyChecks).toHaveLength(4)
    expect(filesystemSafetyChecks).toContain(dangerousPathSafetyCheck)
    expect(filesystemSafetyChecks).toContain(workingDirectorySafetyCheck)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('root path is outside a specific working directory', () => {
    const ctx = makeContext({ workingDirectories: ['/repo'] })
    const tool = makeTool('FileWrite', { path: '/', isMutating: true })
    const result = workingDirectorySafetyCheck(tool, {}, ctx)
    expect(result).not.toBeNull()
    expect(result!.behavior).toBe('ask')
  })

  it('home directory files are not inherently dangerous', () => {
    expect(isDangerousPath('/home/user/projects/app.ts')).toBe(false)
  })

  it('trailing slash does not affect containment', () => {
    expect(isWithinDirectory('/repo/file.ts', '/repo/')).toBe(true)
    expect(isWithinDirectory('/repo/file.ts/', '/repo')).toBe(true)
  })
})
