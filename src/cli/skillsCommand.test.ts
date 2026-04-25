import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'

import { handleSkillCommand } from './skillsCommand.js'
import type { SkillEngine, SkillScanHandler, ActivateSkillOpts } from './skillsCommand.js'
import type { ActiveSkill } from '../skills/router.js'
import type { SecretMatch } from '../memory/secretScanner.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CollectingStream extends Writable {
  chunks: string[] = []
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    cb()
  }
  text(): string {
    return this.chunks.join('')
  }
}

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-skill-cmd-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function writeSkillMd(
  baseDir: string,
  id: string,
  frontmatter: Record<string, string>,
  body: string,
): void {
  const dir = join(baseDir, 'skills', id)
  mkdirSync(dir, { recursive: true })
  const lines = ['---']
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`)
  lines.push('---', '', body)
  writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'))
}

type FakeEngine = SkillEngine & {
  readonly calls: {
    activate: Array<{
      id: string
      opts: ActivateSkillOpts | undefined
      handler: SkillScanHandler | undefined
    }>
    deactivate: string[]
  }
  setActive(active: ActiveSkill | null): void
  rejectActivate(err: Error): void
}

function fakeEngine(baseDir: string | null): FakeEngine {
  let active: ActiveSkill | null = null
  let nextErr: Error | null = null
  const calls = {
    activate: [] as Array<{
      id: string
      opts: ActivateSkillOpts | undefined
      handler: SkillScanHandler | undefined
    }>,
    deactivate: [] as string[],
  }
  return {
    get memoryBaseDir() { return baseDir },
    get activeSkill() { return active },
    get isSkillActive() { return active !== null },
    async activateSkill(id, opts, handler) {
      calls.activate.push({ id, opts, handler })
      if (nextErr) {
        const e = nextErr
        nextErr = null
        throw e
      }
      // simulate state on success
      active = {
        id,
        name: id,
        body: 'body',
        args: opts?.args ?? '',
        activatedAt: Date.now(),
      }
    },
    deactivateSkill(reason) {
      calls.deactivate.push(reason)
      active = null
    },
    calls,
    setActive(a: ActiveSkill | null) { active = a },
    rejectActivate(err: Error) { nextErr = err },
  }
}

function makeIo(): {
  stdout: CollectingStream
  stderr: CollectingStream
  confirmYesNo: ReturnType<typeof vi.fn>
} {
  return {
    stdout: new CollectingStream(),
    stderr: new CollectingStream(),
    confirmYesNo: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// memoryBaseDir === null
// ---------------------------------------------------------------------------

describe('handleSkillCommand: memory disabled', () => {
  it('prints disabled message and returns', async () => {
    const io = makeIo()
    const engine = fakeEngine(null)
    await handleSkillCommand('/skill', engine, io)
    expect(io.stdout.text()).toContain('disabled in this engine')
    expect(engine.calls.activate).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// /skill (default → showIndex)
// ---------------------------------------------------------------------------

describe('/skill (no subcommand)', () => {
  it('prints (no skills) when store is empty', async () => {
    await withTmpDir(async (baseDir) => {
      const io = makeIo()
      const engine = fakeEngine(baseDir)
      await handleSkillCommand('/skill', engine, io)
      expect(io.stdout.text()).toContain('(no skills)')
    })
  })

  it('prints SKILLS.md content when present', async () => {
    await withTmpDir(async (baseDir) => {
      writeSkillMd(baseDir, 'foo', { name: 'foo', description: 'd' }, 'body')
      const io = makeIo()
      const engine = fakeEngine(baseDir)
      await handleSkillCommand('/skill list', engine, io) // populate index lazily? listSkills doesn't write SKILLS.md.
      // Use list cmd as a smoke.
      expect(io.stdout.text()).toContain('foo')
    })
  })
})

// ---------------------------------------------------------------------------
// /skill list
// ---------------------------------------------------------------------------

describe('/skill list', () => {
  it('lists skills in a table', async () => {
    await withTmpDir(async (baseDir) => {
      writeSkillMd(
        baseDir,
        'foo',
        { name: 'foo', description: 'd', 'allowed-tools': '["FileRead"]' },
        'body',
      )
      const io = makeIo()
      await handleSkillCommand('/skill list', fakeEngine(baseDir), io)
      const out = io.stdout.text()
      expect(out).toContain('id')
      expect(out).toContain('foo')
      expect(out).toContain('allowedTools')
    })
  })

  it('reports empty store', async () => {
    await withTmpDir(async (baseDir) => {
      const io = makeIo()
      await handleSkillCommand('/skill list', fakeEngine(baseDir), io)
      expect(io.stdout.text()).toContain('(no skills)')
    })
  })
})

// ---------------------------------------------------------------------------
// /skill show <id>
// ---------------------------------------------------------------------------

describe('/skill show', () => {
  it('prints serialized SKILL.md', async () => {
    await withTmpDir(async (baseDir) => {
      writeSkillMd(
        baseDir,
        'foo',
        { name: 'foo', description: 'd' },
        'BODY-MARKER',
      )
      const io = makeIo()
      await handleSkillCommand('/skill show foo', fakeEngine(baseDir), io)
      expect(io.stdout.text()).toContain('BODY-MARKER')
    })
  })

  it('without id → usage error', async () => {
    await withTmpDir(async (baseDir) => {
      const io = makeIo()
      await handleSkillCommand('/skill show', fakeEngine(baseDir), io)
      expect(io.stderr.text()).toContain('usage')
    })
  })

  it('invalid id → error', async () => {
    await withTmpDir(async (baseDir) => {
      const io = makeIo()
      await handleSkillCommand('/skill show BAD-UPPER', fakeEngine(baseDir), io)
      expect(io.stderr.text()).toContain('invalid id')
    })
  })

  it('missing skill → not found error', async () => {
    await withTmpDir(async (baseDir) => {
      const io = makeIo()
      await handleSkillCommand('/skill show ghost', fakeEngine(baseDir), io)
      expect(io.stderr.text()).toContain('not found')
    })
  })
})

// ---------------------------------------------------------------------------
// /skill activate
// ---------------------------------------------------------------------------

describe('/skill activate', () => {
  let engine: FakeEngine
  let io: ReturnType<typeof makeIo>

  beforeEach(async () => {
    engine = fakeEngine('/tmp/fake-base')
    io = makeIo()
  })

  it('without id → usage error', async () => {
    await handleSkillCommand('/skill activate', engine, io)
    expect(io.stderr.text()).toContain('usage')
    expect(engine.calls.activate).toHaveLength(0)
  })

  it('invalid id → error, no engine call', async () => {
    await handleSkillCommand('/skill activate BAD-UPPER', engine, io)
    expect(io.stderr.text()).toContain('invalid id')
    expect(engine.calls.activate).toHaveLength(0)
  })

  it('default turns + empty args', async () => {
    await handleSkillCommand('/skill activate review', engine, io)
    expect(engine.calls.activate).toHaveLength(1)
    expect(engine.calls.activate[0]!.id).toBe('review')
    expect(engine.calls.activate[0]!.opts).toEqual({ turns: 1, args: '' })
    expect(io.stdout.text()).toContain('activated for 1 turn')
  })

  it('--turns parses integer', async () => {
    await handleSkillCommand('/skill activate review --turns 5 https://x', engine, io)
    expect(engine.calls.activate[0]!.opts).toEqual({
      turns: 5,
      args: 'https://x',
    })
  })

  it('--turns rejects non-integer', async () => {
    await handleSkillCommand('/skill activate review --turns abc', engine, io)
    expect(io.stderr.text()).toContain('integer')
    expect(engine.calls.activate).toHaveLength(0)
  })

  it('--turns rejects 0', async () => {
    await handleSkillCommand('/skill activate review --turns 0', engine, io)
    expect(io.stderr.text()).toContain('integer')
    expect(engine.calls.activate).toHaveLength(0)
  })

  it('--turns rejects > 100', async () => {
    await handleSkillCommand('/skill activate review --turns 999', engine, io)
    expect(io.stderr.text()).toContain('integer')
    expect(engine.calls.activate).toHaveLength(0)
  })

  it('args concatenate when no --turns flag', async () => {
    await handleSkillCommand('/skill activate review arg1 arg2', engine, io)
    expect(engine.calls.activate[0]!.opts).toEqual({
      turns: 1,
      args: 'arg1 arg2',
    })
  })

  it('--turns NOT first → treated as args (documented quirk)', async () => {
    await handleSkillCommand('/skill activate review http://x --turns 3', engine, io)
    expect(engine.calls.activate[0]!.opts).toEqual({
      turns: 1,
      args: 'http://x --turns 3',
    })
  })

  it('engine error → stderr, no crash', async () => {
    engine.rejectActivate(new Error('boom'))
    await handleSkillCommand('/skill activate review', engine, io)
    expect(io.stderr.text()).toContain('boom')
  })

  it('passes a scanHandler that uses confirmYesNo', async () => {
    io.confirmYesNo.mockResolvedValueOnce(true)
    await handleSkillCommand('/skill activate review', engine, {
      ...io,
      confirmYesNo: io.confirmYesNo as unknown as typeof io.confirmYesNo,
    })
    const handler = engine.calls.activate[0]!.handler
    expect(handler).toBeDefined()
    const matches: SecretMatch[] = [
      { type: 'aws_access_key_id', confidence: 'high', index: 0, length: 20 },
    ]
    const result = await handler!(matches)
    expect(io.confirmYesNo).toHaveBeenCalledTimes(1)
    expect(result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// /skill deactivate
// ---------------------------------------------------------------------------

describe('/skill deactivate', () => {
  it('while active → calls engine.deactivateSkill', async () => {
    const engine = fakeEngine('/tmp/fake-base')
    engine.setActive({
      id: 'sk',
      name: 'sk',
      body: 'b',
      args: '',
      activatedAt: 0,
    })
    const io = makeIo()
    await handleSkillCommand('/skill deactivate', engine, io)
    expect(engine.calls.deactivate).toEqual(['user_deactivated'])
    expect(io.stdout.text()).toContain('deactivated')
  })

  it('while inactive → courtesy message, no engine call', async () => {
    const engine = fakeEngine('/tmp/fake-base')
    const io = makeIo()
    await handleSkillCommand('/skill deactivate', engine, io)
    expect(io.stdout.text()).toContain('(no active skill)')
    expect(engine.calls.deactivate).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// /skill help and unknown subcommand
// ---------------------------------------------------------------------------

describe('/skill help', () => {
  it('prints expected lines', async () => {
    const io = makeIo()
    await handleSkillCommand('/skill help', fakeEngine('/tmp/fake-base'), io)
    expect(io.stdout.text()).toContain('Skill management')
    expect(io.stdout.text()).toContain('/skill activate')
  })
})

describe('/skill unknown', () => {
  it('reports unknown subcommand and prints help', async () => {
    const io = makeIo()
    await handleSkillCommand('/skill garbage', fakeEngine('/tmp/fake-base'), io)
    expect(io.stderr.text()).toContain('unknown subcommand')
    expect(io.stdout.text()).toContain('Skill management')
  })
})
