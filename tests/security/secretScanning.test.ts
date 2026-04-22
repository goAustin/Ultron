/**
 * Security test: secret scanning through the full permission boundary.
 *
 * Tests that FileWrite/FileEdit with credential patterns are blocked
 * end-to-end through runToolUse() → permission cascade → secretContentSafetyCheck.
 */

import { describe, it, expect } from 'vitest'

import { runToolUse } from '../../src/core/tools/runToolUse.js'
import { createToolUseContext } from '../../src/core/tools/context.js'
import { createDefaultRegistry } from '../../src/core/tools/registry.js'
import { createStore, getDefaultAppState } from '../../src/core/state.js'
import type { AppState } from '../../src/core/state.js'
import { toolUseId } from '../../src/core/messages.js'
import type { ToolUseBlock } from '../../src/core/messages.js'
import { filesystemSafetyChecks } from '../../src/core/permissions/filesystem.js'
import type { PermissionOptions } from '../../src/core/permissions/types.js'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-secret-sec-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function makeContext(cwd: string, readFileState?: Map<string, { content: string; mtime: number }>) {
  return createToolUseContext({
    appState: createStore<AppState>({
      ...getDefaultAppState(),
      permissionMode: 'bypassPermissions',
      workingDirectories: [cwd],
    }),
    abortController: new AbortController(),
    messages: [],
    readFileState: readFileState ?? new Map(),
    toolRegistry: createDefaultRegistry(),
  })
}

const permOpts: PermissionOptions = {
  headless: true,
  safetyChecks: [...filesystemSafetyChecks],
}

function fileWriteToolUse(filePath: string, content: string): ToolUseBlock {
  return {
    type: 'tool_use',
    id: toolUseId('tu-1'),
    name: 'FileWrite',
    input: { file_path: filePath, content },
  }
}

function fileEditToolUse(filePath: string, oldString: string, newString: string): ToolUseBlock {
  return {
    type: 'tool_use',
    id: toolUseId('tu-1'),
    name: 'FileEdit',
    input: { file_path: filePath, old_string: oldString, new_string: newString },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('secret scanning through permission boundary', () => {
  it('blocks FileWrite containing an AWS key (high confidence → deny)', async () => {
    await withTmpDir(async (cwd) => {
      const filePath = join(cwd, 'config.env')
      const context = makeContext(cwd)

      const result = await runToolUse(
        fileWriteToolUse(filePath, 'AWS_KEY=AKIAIOSFODNN7EXAMPLE'),
        context,
        new AbortController().signal,
        permOpts,
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('aws_access_key_id')
    })
  })

  it('blocks FileWrite containing a private key header', async () => {
    await withTmpDir(async (cwd) => {
      const filePath = join(cwd, 'key.pem')
      const context = makeContext(cwd)

      const result = await runToolUse(
        fileWriteToolUse(filePath, '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'),
        context,
        new AbortController().signal,
        permOpts,
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('private_key')
    })
  })

  it('blocks FileEdit when post-edit content contains a secret', async () => {
    await withTmpDir(async (cwd) => {
      const filePath = join(cwd, 'config.ts')
      const originalContent = 'const key = "placeholder"'
      writeFileSync(filePath, originalContent)

      const { statSync } = await import('fs')
      const mtime = statSync(filePath).mtimeMs

      const readFileState = new Map([
        [filePath, { content: originalContent, mtime }],
      ])
      const context = makeContext(cwd, readFileState)

      const result = await runToolUse(
        fileEditToolUse(filePath, 'placeholder', 'AKIAIOSFODNN7EXAMPLE'),
        context,
        new AbortController().signal,
        permOpts,
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('aws_access_key_id')
    })
  })

  it('allows FileWrite with normal content', async () => {
    await withTmpDir(async (cwd) => {
      const filePath = join(cwd, 'hello.txt')
      const context = makeContext(cwd)

      const result = await runToolUse(
        fileWriteToolUse(filePath, 'Hello, world!'),
        context,
        new AbortController().signal,
        permOpts,
      )

      expect(result.isError).toBe(false)
    })
  })

  it('does not scan FileRead operations', async () => {
    await withTmpDir(async (cwd) => {
      const filePath = join(cwd, 'secrets.env')
      writeFileSync(filePath, 'AWS_KEY=AKIAIOSFODNN7EXAMPLE')

      const context = makeContext(cwd)

      const result = await runToolUse(
        {
          type: 'tool_use',
          id: toolUseId('tu-1'),
          name: 'FileRead',
          input: { file_path: filePath },
        },
        context,
        new AbortController().signal,
        permOpts,
      )

      // FileRead should succeed — secret scanning only applies to writes
      expect(result.isError).toBe(false)
      expect(result.content).toContain('AKIAIOSFODNN7EXAMPLE')
    })
  })
})
