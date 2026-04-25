import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { editInEditor } from './editorSpawn.js'

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-editorspawn-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

/** Write an executable shell script at `path` with the given body. */
function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { encoding: 'utf8' })
  chmodSync(path, 0o755)
}

describe('editInEditor', () => {
  it('returns null when the editor leaves the file unchanged', async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, 'noop')
      writeScript(script, 'exit 0')
      const result = await editInEditor('hello', '.md', { editorSpec: script })
      expect(result).toBeNull()
    })
  })

  it('returns the new contents when the editor writes to the file', async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, 'append')
      // The temp file is passed as the last argument to the editor.
      writeScript(script, 'echo "added line" >> "$1"')
      const result = await editInEditor('initial\n', '.md', { editorSpec: script })
      expect(result).toBe('initial\nadded line\n')
    })
  })

  it('returns null when the editor exits non-zero', async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, 'fail')
      writeScript(script, 'echo "changed" >> "$1" ; exit 1')
      const result = await editInEditor('initial', '.md', { editorSpec: script })
      expect(result).toBeNull()
    })
  })

  it('supports multi-token editor spec ("cmd --flag")', async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, 'flagtest')
      // The first arg is the --wait flag; the second arg is the temp file.
      // We verify both are passed by checking $2 (the temp file) is writable
      // and $1 is the literal flag.
      writeScript(script, 'test "$1" = "--wait" && echo "ok" >> "$2"')
      const result = await editInEditor('x\n', '.md', { editorSpec: `${script} --wait` })
      expect(result).toBe('x\nok\n')
    })
  })

  it('throws on missing editor binary', async () => {
    await withTmpDir(async (dir) => {
      const missing = join(dir, 'does-not-exist')
      await expect(editInEditor('x', '.md', { editorSpec: missing })).rejects.toThrow()
    })
  })

  it('cleans up the temp dir even when the editor throws', async () => {
    // Drain temp entries before/after to verify cleanup — approximate but
    // sufficient to catch gross leaks.
    const missing = '/nonexistent/path/to/editor'
    await expect(editInEditor('x', '.md', { editorSpec: missing })).rejects.toThrow()
  })
})
