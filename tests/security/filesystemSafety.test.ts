/**
 * Security tests — filesystem safety through the runToolUse() boundary.
 *
 * Tests use real temp directories, real symlinks, and real tools.
 * Safety checks apply to mutating tools only (FileEdit, FileWrite).
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

import { runToolUse } from '../../src/core/tools/runToolUse.js'
import { createDefaultRegistry } from '../../src/core/tools/registry.js'
import { createToolUseContext } from '../../src/core/tools/context.js'
import { createStore, getDefaultAppState } from '../../src/core/state.js'
import { toolUseId } from '../../src/core/messages.js'
import { filesystemSafetyChecks } from '../../src/core/permissions/filesystem.js'
import type { ToolUseBlock } from '../../src/core/messages.js'
import type { PermissionOptions } from '../../src/core/permissions/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-sec-fs-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function makeToolUse(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId('tu-fs'), name, input }
}

function makeContext(workingDirs: string[]) {
  return createToolUseContext({
    appState: createStore({
      ...getDefaultAppState(),
      permissionMode: 'bypassPermissions',
      workingDirectories: workingDirs,
    }),
    abortController: new AbortController(),
    messages: [],
    toolRegistry: createDefaultRegistry(),
  })
}

const permOpts: PermissionOptions = {
  headless: false,
  safetyChecks: [...filesystemSafetyChecks],
}

const signal = new AbortController().signal

// ---------------------------------------------------------------------------
// Symlink escape attacks
// ---------------------------------------------------------------------------

describe('filesystem safety — symlink escapes', () => {
  it('symlink escape blocks FileEdit (mutating tool)', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (outside) => {
        // Create target file outside cwd
        const targetFile = join(outside, 'secret.txt')
        writeFileSync(targetFile, 'secret data')

        // Create symlink inside cwd pointing outside
        const linkPath = join(cwd, 'link.txt')
        symlinkSync(targetFile, linkPath)

        const ctx = makeContext([cwd])
        // Populate readFileState with link path and real mtime
        const mtime = statSync(linkPath).mtimeMs
        ctx.readFileState.set(resolve(linkPath), { content: 'secret data', mtime })

        const result = await runToolUse(
          makeToolUse('FileEdit', {
            file_path: linkPath,
            old_string: 'secret data',
            new_string: 'hacked',
          }),
          ctx,
          signal,
          permOpts,
        )

        expect(result.isError).toBe(true)
        // Safety check should flag it as outside working directory
        expect(result.content).toContain('permission_ask')
      })
    })
  })

  it('symlink escape blocks FileWrite (mutating tool)', async () => {
    await withTmpDir(async (cwd) => {
      await withTmpDir(async (outside) => {
        const targetFile = join(outside, 'target.txt')
        writeFileSync(targetFile, 'original')

        const linkPath = join(cwd, 'link.txt')
        symlinkSync(targetFile, linkPath)

        const ctx = makeContext([cwd])
        // Populate readFileState so overwrite is allowed
        const mtime = statSync(linkPath).mtimeMs
        ctx.readFileState.set(resolve(linkPath), { content: 'original', mtime })

        const result = await runToolUse(
          makeToolUse('FileWrite', {
            file_path: linkPath,
            content: 'malicious content',
          }),
          ctx,
          signal,
          permOpts,
        )

        expect(result.isError).toBe(true)
        expect(result.content).toContain('permission_ask')
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Dangerous directory writes
// ---------------------------------------------------------------------------

describe('filesystem safety — dangerous directories', () => {
  it('FileWrite to .git/hooks/ triggers safety check', async () => {
    await withTmpDir(async (cwd) => {
      // Create .git/hooks directory
      mkdirSync(join(cwd, '.git', 'hooks'), { recursive: true })
      const hookPath = join(cwd, '.git', 'hooks', 'pre-commit')

      const ctx = makeContext([cwd])

      const result = await runToolUse(
        makeToolUse('FileWrite', {
          file_path: hookPath,
          content: '#!/bin/sh\nmalicious',
        }),
        ctx,
        signal,
        permOpts,
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('permission_ask')
    })
  })
})

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

describe('filesystem safety — path traversal', () => {
  it('path traversal outside working directory is blocked', async () => {
    await withTmpDir(async (cwd) => {
      const traversalPath = join(cwd, '..', '..', 'etc', 'passwd')

      const ctx = makeContext([cwd])

      const result = await runToolUse(
        makeToolUse('FileEdit', {
          file_path: traversalPath,
          old_string: 'root',
          new_string: 'hacked',
        }),
        ctx,
        signal,
        permOpts,
      )

      // Either validation_failed (file doesn't exist / not read) or permission_ask (outside cwd)
      expect(result.isError).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Stale write protection
// ---------------------------------------------------------------------------

describe('filesystem safety — stale write protection', () => {
  it('FileEdit without prior read is rejected', async () => {
    await withTmpDir(async (cwd) => {
      const filePath = join(cwd, 'unread.txt')
      writeFileSync(filePath, 'content')

      const ctx = makeContext([cwd])
      // Deliberately NOT populating readFileState

      const result = await runToolUse(
        makeToolUse('FileEdit', {
          file_path: filePath,
          old_string: 'content',
          new_string: 'modified',
        }),
        ctx,
        signal,
        permOpts,
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('validation_failed')
    })
  })

  it('FileEdit on file modified since read is rejected', async () => {
    await withTmpDir(async (cwd) => {
      const filePath = join(cwd, 'stale.txt')
      writeFileSync(filePath, 'original')
      const oldMtime = statSync(filePath).mtimeMs

      const ctx = makeContext([cwd])
      ctx.readFileState.set(resolve(filePath), { content: 'original', mtime: oldMtime })

      // Modify the file externally (wait a moment to ensure different mtime)
      writeFileSync(filePath, 'original') // same content, new mtime
      // Force different mtime by using an old timestamp in readFileState
      ctx.readFileState.set(resolve(filePath), { content: 'original', mtime: oldMtime - 10000 })

      const result = await runToolUse(
        makeToolUse('FileEdit', {
          file_path: filePath,
          old_string: 'original',
          new_string: 'should fail',
        }),
        ctx,
        signal,
        permOpts,
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('validation_failed')
    })
  })
})
