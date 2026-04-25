import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadHooks } from './loadHooks.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultron-hooks-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadHooks', () => {
  it('returns empty config on ENOENT', async () => {
    const cfg = await loadHooks(join(dir, 'does-not-exist.json'))
    expect(cfg).toEqual({
      schemaVersion: 1,
      hooks: { PreToolUse: [], PostToolUse: [] },
    })
  })

  it('parses a well-formed config', async () => {
    const file = join(dir, 'hooks.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PreToolUse: [{ matcher: 'Bash', command: '/tmp/lint.sh', timeout: 30000 }],
          PostToolUse: [{ matcher: '*', command: '/tmp/log.sh' }],
        },
      }),
    )
    const cfg = await loadHooks(file)
    expect(cfg.hooks.PreToolUse).toHaveLength(1)
    expect(cfg.hooks.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      command: '/tmp/lint.sh',
      timeout: 30000,
    })
    expect(cfg.hooks.PostToolUse[0]?.matcher).toBe('*')
  })

  it('throws on malformed JSON', async () => {
    const file = join(dir, 'hooks.json')
    await writeFile(file, '{ invalid')
    await expect(loadHooks(file)).rejects.toThrow(/JSON parse failed/)
  })

  it('rejects unknown event name', async () => {
    const file = join(dir, 'hooks.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        hooks: { Stop: [{ matcher: '*', command: '/tmp/x.sh' }] },
      }),
    )
    await expect(loadHooks(file)).rejects.toThrow(/unknown event "Stop"/)
  })

  it('rejects case-mismatched event name', async () => {
    const file = join(dir, 'hooks.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        hooks: { preToolUse: [] },
      }),
    )
    await expect(loadHooks(file)).rejects.toThrow(/unknown event "preToolUse"/)
  })

  it('rejects missing command', async () => {
    const file = join(dir, 'hooks.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        hooks: { PreToolUse: [{ matcher: 'Bash' }] },
      }),
    )
    await expect(loadHooks(file)).rejects.toThrow(/command must be a non-empty string/)
  })

  it('rejects non-positive timeout', async () => {
    const file = join(dir, 'hooks.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        hooks: { PreToolUse: [{ matcher: 'Bash', command: 'x', timeout: 0 }] },
      }),
    )
    await expect(loadHooks(file)).rejects.toThrow(/positive integer/)
  })

  it('rejects wrong schemaVersion', async () => {
    const file = join(dir, 'hooks.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 2,
        hooks: { PreToolUse: [], PostToolUse: [] },
      }),
    )
    await expect(loadHooks(file)).rejects.toThrow(/schemaVersion must be 1/)
  })

  it('stores ~ verbatim in command field', async () => {
    const file = join(dir, 'hooks.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        hooks: { PreToolUse: [{ matcher: 'Bash', command: '~/scripts/x.sh' }] },
      }),
    )
    const cfg = await loadHooks(file)
    expect(cfg.hooks.PreToolUse[0]?.command).toBe('~/scripts/x.sh')
  })
})
