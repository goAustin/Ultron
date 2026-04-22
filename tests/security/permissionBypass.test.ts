/**
 * Security tests — permission bypass attempts through the full runToolUse() boundary.
 *
 * Every test builds a real ToolUseContext with real tools and real permission rules,
 * then calls runToolUse() — the actual tool execution pipeline.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { runToolUse } from '../../src/core/tools/runToolUse.js'
import { createDefaultRegistry } from '../../src/core/tools/registry.js'
import { createToolUseContext } from '../../src/core/tools/context.js'
import { createStore, getDefaultAppState } from '../../src/core/state.js'
import { toolUseId } from '../../src/core/messages.js'
import { filesystemSafetyChecks } from '../../src/core/permissions/filesystem.js'
import type { ToolUseBlock } from '../../src/core/messages.js'
import type { PermissionMode } from '../../src/core/state.js'
import type { PermissionRule, PermissionOptions } from '../../src/core/permissions/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-sec-perm-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId('tu-sec'), name, input }
}

function makeContext(opts: {
  permissionMode?: PermissionMode
  rules?: PermissionRule[]
  workingDirectories?: string[]
}) {
  return createToolUseContext({
    appState: createStore({
      ...getDefaultAppState(),
      permissionMode: opts.permissionMode ?? 'default',
      permissionRules: opts.rules ?? [],
      workingDirectories: opts.workingDirectories ?? [],
    }),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createDefaultRegistry(),
  })
}

function makePermOpts(headless = false): PermissionOptions {
  return {
    headless,
    safetyChecks: [...filesystemSafetyChecks],
  }
}

const signal = new AbortController().signal

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('permission bypass — through runToolUse boundary', () => {
  it('deny rule blocks regardless of mode', async () => {
    await withTmpDir(async (dir) => {
      const filePath = join(dir, 'blocked.txt')
      writeFileSync(filePath, 'content')

      const ctx = makeContext({
        permissionMode: 'bypassPermissions',
        rules: [{ toolName: 'FileRead', behavior: 'deny', path: filePath, source: 'userSettings' }],
        workingDirectories: [dir],
      })

      const result = await runToolUse(
        makeToolUse('FileRead', { file_path: filePath }),
        ctx,
        signal,
        makePermOpts(),
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('permission_denied')
    })
  })

  it('deny rule blocks in default mode too', async () => {
    await withTmpDir(async (dir) => {
      const filePath = join(dir, 'secret.txt')
      writeFileSync(filePath, 'secret')

      const ctx = makeContext({
        permissionMode: 'default',
        rules: [{ toolName: 'FileRead', behavior: 'deny', path: filePath, source: 'userSettings' }],
        workingDirectories: [dir],
      })

      const result = await runToolUse(
        makeToolUse('FileRead', { file_path: filePath }),
        ctx,
        signal,
        makePermOpts(),
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('permission_denied')
    })
  })

  it('dangerous path triggers safety check even in bypassPermissions', async () => {
    await withTmpDir(async (dir) => {
      // Create a .bashrc inside the working directory
      const bashrc = join(dir, '.bashrc')
      writeFileSync(bashrc, 'export PATH=...')

      const { statSync } = await import('fs')
      const mtime = statSync(bashrc).mtimeMs

      const ctx = makeContext({
        permissionMode: 'bypassPermissions',
        workingDirectories: [dir],
      })
      // Populate readFileState so validation passes
      ctx.readFileState.set(bashrc, { content: 'export PATH=...', mtime })

      const result = await runToolUse(
        makeToolUse('FileEdit', {
          file_path: bashrc,
          old_string: 'export PATH=...',
          new_string: 'export PATH=malicious',
        }),
        ctx,
        signal,
        makePermOpts(),
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('permission_ask')
    })
  })

  it('headless mode denies rather than silently executing', async () => {
    await withTmpDir(async (dir) => {
      const filePath = join(dir, 'newfile.txt')

      const ctx = makeContext({
        permissionMode: 'default',
        workingDirectories: [dir],
      })

      // FileWrite in default mode would normally prompt — headless should deny
      const result = await runToolUse(
        makeToolUse('FileWrite', { file_path: filePath, content: 'hello' }),
        ctx,
        signal,
        makePermOpts(true), // headless
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('permission_denied')
    })
  })

  it('ask rule overrides mode-based auto-approve', async () => {
    await withTmpDir(async (dir) => {
      const filePath = join(dir, 'askme.txt')
      writeFileSync(filePath, 'original')

      const { statSync } = await import('fs')
      const mtime = statSync(filePath).mtimeMs

      const ctx = makeContext({
        permissionMode: 'acceptEdits', // would normally auto-approve edits
        rules: [{ toolName: 'FileEdit', behavior: 'ask', path: filePath, source: 'userSettings' }],
        workingDirectories: [dir],
      })

      // Read the file first with correct mtime
      ctx.readFileState.set(filePath, { content: 'original', mtime })

      const result = await runToolUse(
        makeToolUse('FileEdit', {
          file_path: filePath,
          old_string: 'original',
          new_string: 'modified',
        }),
        ctx,
        signal,
        makePermOpts(),
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('permission_ask')
    })
  })

  it('allowed tool succeeds with isError false', async () => {
    await withTmpDir(async (dir) => {
      const filePath = join(dir, 'readable.txt')
      writeFileSync(filePath, 'hello world')

      const ctx = makeContext({
        permissionMode: 'bypassPermissions',
        workingDirectories: [dir],
      })

      const result = await runToolUse(
        makeToolUse('FileRead', { file_path: filePath }),
        ctx,
        signal,
        makePermOpts(),
      )

      expect(result.isError).toBe(false)
      expect(result.content).toContain('hello world')
    })
  })
})
