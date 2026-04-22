import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  renderAttachment,
  getInitialAttachments,
  buildGetAttachments,
} from './attachments.js'
import { clearUserContextCache } from './userContext.js'
import { clearSystemContextCache } from './systemContext.js'
import type { Attachment, ToolExecution } from './attachmentTypes.js'
import type { ToolUseBlock } from '../core/messages.js'
import { toolUseId } from '../core/messages.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-attach-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'file.txt'), 'hello')
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
}

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: toolUseId('tu_' + name), name, input }
}

function makeExecution(name: string, input: Record<string, unknown> = {}, isError = false): ToolExecution {
  return {
    toolUse: makeToolUse(name, input),
    result: { content: isError ? 'Error' : 'OK', isError },
  }
}

afterEach(() => {
  clearUserContextCache()
  clearSystemContextCache()
})

// ---------------------------------------------------------------------------
// renderAttachment
// ---------------------------------------------------------------------------

describe('renderAttachment', () => {
  it('renders git_status', () => {
    const text = renderAttachment({ type: 'git_status', status: 'Current branch: main' })
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('</system-reminder>')
    expect(text).toContain('Git status has been updated')
    expect(text).toContain('Current branch: main')
  })

  it('renders project_instructions', () => {
    const text = renderAttachment({ type: 'project_instructions', content: 'Build with npm' })
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('Project instructions (CLAUDE.md) have been updated')
    expect(text).toContain('Build with npm')
  })

  it('renders file_change', () => {
    const text = renderAttachment({ type: 'file_change', path: '/foo/bar.ts', action: 'edited' })
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('File edited: /foo/bar.ts')
  })

  it('renders date_change', () => {
    const text = renderAttachment({ type: 'date_change', newDate: '2026-01-15' })
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('Today\'s date is now 2026-01-15')
  })
})

// ---------------------------------------------------------------------------
// getInitialAttachments
// ---------------------------------------------------------------------------

describe('getInitialAttachments', () => {
  it('returns git_status and project_instructions in git repo with CLAUDE.md', async () => {
    await withTmpDir(async (dir) => {
      initGitRepo(dir)
      writeFileSync(join(dir, 'CLAUDE.md'), 'My rules')

      const msgs = await getInitialAttachments(dir)
      expect(msgs.length).toBe(2)

      const texts = msgs.map((m) => {
        const block = m.content[0]
        return block?.type === 'text' ? block.text : ''
      })

      expect(texts.some((t) => t.includes('Git status'))).toBe(true)
      expect(texts.some((t) => t.includes('My rules'))).toBe(true)
    })
  })

  it('returns only git_status in git repo without CLAUDE.md', async () => {
    await withTmpDir(async (dir) => {
      initGitRepo(dir)

      const msgs = await getInitialAttachments(dir)
      expect(msgs.length).toBe(1)

      const block = msgs[0]!.content[0]
      const text = block?.type === 'text' ? block.text : ''
      expect(text).toContain('Git status')
    })
  })

  it('returns only project_instructions in non-git dir with CLAUDE.md', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'CLAUDE.md'), 'Instructions here')

      const msgs = await getInitialAttachments(dir)
      expect(msgs.length).toBe(1)

      const block = msgs[0]!.content[0]
      const text = block?.type === 'text' ? block.text : ''
      expect(text).toContain('Instructions here')
    })
  })
})

// ---------------------------------------------------------------------------
// buildGetAttachments — detection
// ---------------------------------------------------------------------------

describe('buildGetAttachments', () => {
  it('returns empty array when no executions', async () => {
    await withTmpDir(async (dir) => {
      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([])
      expect(msgs).toEqual([])
    })
  })

  it('returns empty array when only read tools ran', async () => {
    await withTmpDir(async (dir) => {
      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([
        makeExecution('FileRead', { file_path: '/tmp/foo' }),
        makeExecution('Glob', { pattern: '*.ts' }),
        makeExecution('Grep', { pattern: 'hello' }),
      ])
      expect(msgs).toEqual([])
    })
  })

  it('returns file_change after successful FileEdit', async () => {
    await withTmpDir(async (dir) => {
      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([
        makeExecution('FileEdit', { file_path: '/tmp/foo.ts' }),
      ])

      const texts = msgs.map((m) => {
        const b = m.content[0]
        return b?.type === 'text' ? b.text : ''
      })
      expect(texts.some((t) => t.includes('File edited: /tmp/foo.ts'))).toBe(true)
    })
  })

  it('returns file_change with action created after FileWrite', async () => {
    await withTmpDir(async (dir) => {
      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([
        makeExecution('FileWrite', { file_path: '/tmp/new.ts' }),
      ])

      const texts = msgs.map((m) => {
        const b = m.content[0]
        return b?.type === 'text' ? b.text : ''
      })
      expect(texts.some((t) => t.includes('File created: /tmp/new.ts'))).toBe(true)
    })
  })

  it('does not return attachments for failed tool results', async () => {
    await withTmpDir(async (dir) => {
      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([
        makeExecution('FileEdit', { file_path: '/tmp/fail.ts' }, true),
      ])
      expect(msgs).toEqual([])
    })
  })

  it('returns git_status after write tool in git repo', async () => {
    await withTmpDir(async (dir) => {
      initGitRepo(dir)

      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([
        makeExecution('FileEdit', { file_path: join(dir, 'file.txt') }),
      ])

      const texts = msgs.map((m) => {
        const b = m.content[0]
        return b?.type === 'text' ? b.text : ''
      })
      expect(texts.some((t) => t.includes('Git status has been updated'))).toBe(true)
    })
  })

  it('does not return git_status in non-git directory', async () => {
    await withTmpDir(async (dir) => {
      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([
        makeExecution('FileWrite', { file_path: join(dir, 'x.txt') }),
      ])

      const texts = msgs.map((m) => {
        const b = m.content[0]
        return b?.type === 'text' ? b.text : ''
      })
      expect(texts.every((t) => !t.includes('Git status'))).toBe(true)
    })
  })

  it('returns project_instructions when CLAUDE.md was modified', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'CLAUDE.md'), 'Updated rules')

      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([
        makeExecution('FileEdit', { file_path: join(dir, 'CLAUDE.md') }),
      ])

      const texts = msgs.map((m) => {
        const b = m.content[0]
        return b?.type === 'text' ? b.text : ''
      })
      expect(texts.some((t) => t.includes('Project instructions (CLAUDE.md) have been updated'))).toBe(true)
      expect(texts.some((t) => t.includes('Updated rules'))).toBe(true)
    })
  })

  it('Bash triggers git_status but not file_change', async () => {
    await withTmpDir(async (dir) => {
      initGitRepo(dir)

      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([
        makeExecution('Bash', { command: 'echo hello > file.txt' }),
      ])

      const texts = msgs.map((m) => {
        const b = m.content[0]
        return b?.type === 'text' ? b.text : ''
      })
      // Should have git status
      expect(texts.some((t) => t.includes('Git status has been updated'))).toBe(true)
      // Should NOT have file_change
      expect(texts.every((t) => !t.includes('File edited:') && !t.includes('File created:'))).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Date and message shape
// ---------------------------------------------------------------------------

describe('date and message shape', () => {
  it('does not emit date_change on first call (initialized to current date)', async () => {
    await withTmpDir(async (dir) => {
      const getAttachments = buildGetAttachments(dir)
      const msgs = await getAttachments([
        makeExecution('FileWrite', { file_path: join(dir, 'x.txt') }),
      ])

      const texts = msgs.map((m) => {
        const b = m.content[0]
        return b?.type === 'text' ? b.text : ''
      })
      expect(texts.every((t) => !t.includes('date has changed'))).toBe(true)
    })
  })

  it('messages have flags.isAttachment === true', async () => {
    await withTmpDir(async (dir) => {
      const msgs = await getInitialAttachments(dir)
      // Non-git, no CLAUDE.md → empty. Create CLAUDE.md for a result.
      writeFileSync(join(dir, 'CLAUDE.md'), 'rules')
      clearUserContextCache()
      const msgs2 = await getInitialAttachments(dir)

      expect(msgs2.length).toBeGreaterThan(0)
      for (const msg of msgs2) {
        expect(msg.flags?.isAttachment).toBe(true)
      }
    })
  })

  it('messages contain system-reminder wrapped text', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, 'CLAUDE.md'), 'rules')

      const msgs = await getInitialAttachments(dir)
      for (const msg of msgs) {
        const block = msg.content[0]
        const text = block?.type === 'text' ? block.text : ''
        expect(text).toContain('<system-reminder>')
        expect(text).toContain('</system-reminder>')
      }
    })
  })
})
