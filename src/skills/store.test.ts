import { describe, it, expect, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AuditWriter } from '../audit/types.js'
import type { QueryEvent } from '../core/queryEvents.js'
import {
  deleteSkill,
  initSkillsDir,
  InvalidSkillIdError,
  listSkills,
  MAX_SKILL_BYTES,
  MAX_SKILL_COUNT,
  MAX_TOTAL_SKILL_BYTES,
  MalformedSkillError,
  readSkill,
  rebuildIndex,
  SecretInSkillError,
  SkillNotFoundError,
  SkillTooLargeError,
  SkillsFullError,
  TooManySkillsError,
  writeSkill,
} from './store.js'
import type { Skill } from './skill.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-skillstore-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function collectingAudit(): {
  writer: AuditWriter
  events: QueryEvent[]
} {
  const events: QueryEvent[] = []
  const writer: AuditWriter = {
    write: (e) => {
      events.push(e)
    },
    close: () => Promise.resolve(),
    withOrigin: () => {
      throw new Error('not supported in test')
    },
  }
  return { writer, events }
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  const t = Date.parse('2026-04-24T00:00:00.000Z')
  return {
    schemaVersion: 1,
    id: 'sample-skill',
    name: 'sample',
    description: 'a sample skill for tests',
    content: 'Skill instructions body.',
    createdAt: t,
    updatedAt: t,
    ...overrides,
  }
}

const IS_WINDOWS = process.platform === 'win32'

// ---------------------------------------------------------------------------
// initSkillsDir
// ---------------------------------------------------------------------------

describe('initSkillsDir', () => {
  it('creates the skills directory at 0o700', async () => {
    await withTmpDir(async (dir) => {
      await initSkillsDir(dir)
      const skStat = statSync(join(dir, 'skills'))
      expect(skStat.isDirectory()).toBe(true)
      if (!IS_WINDOWS) {
        expect(skStat.mode & 0o777).toBe(0o700)
      }
    })
  })

  it('is idempotent', async () => {
    await withTmpDir(async (dir) => {
      await initSkillsDir(dir)
      await initSkillsDir(dir)
      expect(statSync(join(dir, 'skills')).isDirectory()).toBe(true)
    })
  })

  it('sweeps orphaned SKILL.md.tmp one level down', async () => {
    await withTmpDir(async (dir) => {
      await initSkillsDir(dir)
      const ghostDir = join(dir, 'skills', 'ghost-skill')
      mkdirSync(ghostDir, { recursive: true })
      writeFileSync(join(ghostDir, 'SKILL.md.tmp'), 'garbage')
      await initSkillsDir(dir)
      const remaining = await readdir(ghostDir)
      expect(remaining).not.toContain('SKILL.md.tmp')
    })
  })

  it('leaves empty <id>/ directories alone (mid-authoring user)', async () => {
    await withTmpDir(async (dir) => {
      await initSkillsDir(dir)
      const inProg = join(dir, 'skills', 'in-progress')
      mkdirSync(join(inProg, 'scripts'), { recursive: true })
      await initSkillsDir(dir)
      expect(statSync(inProg).isDirectory()).toBe(true)
      expect(statSync(join(inProg, 'scripts')).isDirectory()).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// writeSkill — happy path
// ---------------------------------------------------------------------------

describe('writeSkill happy path', () => {
  it('writes SKILL.md at 0o600, dir at 0o700, rebuilds SKILLS.md', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({ id: 'review-pr', name: 'review-pr' })
      await writeSkill(dir, s, audit.writer)

      const skillFile = join(dir, 'skills', 'review-pr', 'SKILL.md')
      expect(statSync(skillFile).isFile()).toBe(true)
      if (!IS_WINDOWS) {
        expect(statSync(skillFile).mode & 0o777).toBe(0o600)
        expect(statSync(join(dir, 'skills', 'review-pr')).mode & 0o777).toBe(
          0o700,
        )
      }

      const index = statSync(join(dir, 'skills', 'SKILLS.md'))
      expect(index.isFile()).toBe(true)

      expect(audit.events).toHaveLength(1)
      const ev = audit.events[0]!
      expect(ev.type).toBe('skill_written')
      if (ev.type === 'skill_written') {
        expect(ev.id).toBe('review-pr')
        expect(ev.isNew).toBe(true)
        expect(ev.hasAllowedTools).toBe(false)
      }
    })
  })

  it('preserves hand-placed sibling files', async () => {
    await withTmpDir(async (dir) => {
      await initSkillsDir(dir)
      const s = makeSkill({ id: 'review-pr' })
      const skillSubdir = join(dir, 'skills', 'review-pr')
      mkdirSync(join(skillSubdir, 'assets'), { recursive: true })
      writeFileSync(join(skillSubdir, 'assets', 'notes.txt'), 'hand-placed')

      const audit = collectingAudit()
      await writeSkill(dir, s, audit.writer)

      expect(statSync(join(skillSubdir, 'assets', 'notes.txt')).isFile()).toBe(true)
    })
  })

  it('upsert: second write has isNew:false and reflects new bytes', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s1 = makeSkill({ content: 'original' })
      await writeSkill(dir, s1, audit.writer)
      const s2 = { ...s1, content: 'updated content is longer than original' }
      await writeSkill(dir, s2, audit.writer)

      expect(audit.events).toHaveLength(2)
      expect(
        audit.events[0]!.type === 'skill_written'
          ? audit.events[0]!.isNew
          : null,
      ).toBe(true)
      expect(
        audit.events[1]!.type === 'skill_written'
          ? audit.events[1]!.isNew
          : null,
      ).toBe(false)
    })
  })

  it('allowed-tools on skill → audit hasAllowedTools:true', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({ allowedTools: ['FileRead'] })
      await writeSkill(dir, s, audit.writer)
      expect(audit.events).toHaveLength(1)
      const ev = audit.events[0]!
      if (ev.type === 'skill_written') {
        expect(ev.hasAllowedTools).toBe(true)
      }
    })
  })

  it('readSkill returns written skill byte-exact', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({
        allowedTools: ['FileRead', 'Bash'],
        argumentHint: '<pr-url>',
      })
      await writeSkill(dir, s, audit.writer)
      const got = await readSkill(dir, s.id)
      expect(got).toEqual(s)
    })
  })
})

// ---------------------------------------------------------------------------
// writeSkill — caps
// ---------------------------------------------------------------------------

describe('writeSkill caps', () => {
  it('rejects oversized SKILL.md with SkillTooLargeError', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const huge = 'x'.repeat(MAX_SKILL_BYTES + 1)
      const s = makeSkill({ content: huge })
      await expect(writeSkill(dir, s, audit.writer)).rejects.toBeInstanceOf(
        SkillTooLargeError,
      )
    })
  })

  it('rejects (MAX_SKILL_COUNT + 1)th skill with TooManySkillsError', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      // Write up to the cap.
      for (let i = 0; i < MAX_SKILL_COUNT; i++) {
        const id = `skill-${i.toString().padStart(3, '0')}`
        await writeSkill(dir, makeSkill({ id, name: id }), audit.writer)
      }
      const over = makeSkill({ id: 'skill-over', name: 'skill-over' })
      await expect(writeSkill(dir, over, audit.writer)).rejects.toBeInstanceOf(
        TooManySkillsError,
      )
    })
  }, 30000)

  it('rejects aggregate-byte overflow with SkillsFullError', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      // Each skill near its own cap; aggregate crosses MAX_TOTAL_SKILL_BYTES.
      const bigContent = 'x'.repeat(MAX_SKILL_BYTES - 500)
      const perSkillBytes = MAX_SKILL_BYTES
      const n = Math.ceil(MAX_TOTAL_SKILL_BYTES / perSkillBytes) + 1
      let i = 0
      for (; i < n - 1; i++) {
        const id = `big-${i.toString().padStart(3, '0')}`
        await writeSkill(
          dir,
          makeSkill({ id, name: id, content: bigContent }),
          audit.writer,
        )
      }
      const overflow = makeSkill({
        id: `big-${i.toString().padStart(3, '0')}`,
        name: 'over',
        content: bigContent,
      })
      await expect(writeSkill(dir, overflow, audit.writer)).rejects.toBeInstanceOf(
        SkillsFullError,
      )
    })
  }, 30000)

  it('upsert that shrinks a skill near aggregate cap succeeds', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const big = 'x'.repeat(30_000)
      const s = makeSkill({ id: 'upserted', content: big })
      await writeSkill(dir, s, audit.writer)
      const smaller = { ...s, content: 'tiny' }
      await writeSkill(dir, smaller, audit.writer)
      const got = await readSkill(dir, 'upserted')
      expect(got?.content).toBe('tiny')
    })
  })
})

// ---------------------------------------------------------------------------
// writeSkill — secret gate
// ---------------------------------------------------------------------------

describe('writeSkill secret gate', () => {
  it('rejects high-confidence secret regardless of opts', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({
        content: 'AWS key: AKIAIOSFODNN7EXAMPLE',
      })
      await expect(writeSkill(dir, s, audit.writer)).rejects.toBeInstanceOf(
        SecretInSkillError,
      )
      await expect(
        writeSkill(dir, s, audit.writer, { allowLowConfidenceSecrets: true }),
      ).rejects.toBeInstanceOf(SecretInSkillError)
    })
  })

  it('rejects low-confidence by default', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({
        content: 'config: api_key = "abcdef1234567890"',
      })
      await expect(writeSkill(dir, s, audit.writer)).rejects.toBeInstanceOf(
        SecretInSkillError,
      )
    })
  })

  it('allows low-confidence with allowLowConfidenceSecrets: true', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({
        content: 'config: api_key = "abcdef1234567890"',
      })
      await writeSkill(dir, s, audit.writer, {
        allowLowConfidenceSecrets: true,
      })
      expect(audit.events).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// writeSkill — malformed input
// ---------------------------------------------------------------------------

describe('writeSkill malformed', () => {
  it('rejects invalid id', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({ id: 'BAD-UPPER' })
      await expect(writeSkill(dir, s, audit.writer)).rejects.toBeInstanceOf(
        InvalidSkillIdError,
      )
    })
  })

  it('rejects allowed-tools with empty string element', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({ allowedTools: [''] })
      await expect(writeSkill(dir, s, audit.writer)).rejects.toBeInstanceOf(
        MalformedSkillError,
      )
    })
  })

  it('rejects allowed-tools with newline embedded', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({ allowedTools: ['a\nb'] })
      await expect(writeSkill(dir, s, audit.writer)).rejects.toBeInstanceOf(
        MalformedSkillError,
      )
    })
  })

  it('rejects argument-hint with newline', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({ argumentHint: 'a\nb' })
      await expect(writeSkill(dir, s, audit.writer)).rejects.toBeInstanceOf(
        MalformedSkillError,
      )
    })
  })
})

// ---------------------------------------------------------------------------
// readSkill
// ---------------------------------------------------------------------------

describe('readSkill', () => {
  it('returns null when SKILL.md absent', async () => {
    await withTmpDir(async (dir) => {
      expect(await readSkill(dir, 'missing')).toBe(null)
    })
  })

  it('throws MalformedSkillError on corrupt SKILL.md', async () => {
    await withTmpDir(async (dir) => {
      await initSkillsDir(dir)
      const skillDir = join(dir, 'skills', 'corrupt')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), 'not valid frontmatter')
      await expect(readSkill(dir, 'corrupt')).rejects.toBeInstanceOf(
        MalformedSkillError,
      )
    })
  })

  it('throws InvalidSkillIdError on bad id', async () => {
    await withTmpDir(async (dir) => {
      await expect(readSkill(dir, 'BAD')).rejects.toBeInstanceOf(
        InvalidSkillIdError,
      )
    })
  })
})

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

describe('listSkills', () => {
  it('returns empty list when skills/ does not exist', async () => {
    await withTmpDir(async (dir) => {
      expect(await listSkills(dir)).toEqual([])
    })
  })

  it('sorts by name then id', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      await writeSkill(dir, makeSkill({ id: 'a', name: 'zeta' }), audit.writer)
      await writeSkill(dir, makeSkill({ id: 'b', name: 'alpha' }), audit.writer)
      await writeSkill(dir, makeSkill({ id: 'c', name: 'beta' }), audit.writer)
      const skills = await listSkills(dir)
      expect(skills.map((s) => s.name)).toEqual(['alpha', 'beta', 'zeta'])
    })
  })

  it('skips SKILLS.md and directories with invalid ids', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      await writeSkill(dir, makeSkill({ id: 'valid', name: 'v' }), audit.writer)
      // Hand-create a subdir with an invalid id.
      const badDir = join(dir, 'skills', 'BAD-ID')
      mkdirSync(badDir, { recursive: true })
      writeFileSync(join(badDir, 'SKILL.md'), '---\nname: bad\ndescription: bad\n---\n')
      const skills = await listSkills(dir)
      expect(skills.map((s) => s.id)).toEqual(['valid'])
    })
  })

  it('silently skips <id>/ directories with no SKILL.md (mid-authoring)', async () => {
    await withTmpDir(async (dir) => {
      await initSkillsDir(dir)
      const inProg = join(dir, 'skills', 'in-progress')
      mkdirSync(join(inProg, 'scripts'), { recursive: true })
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      const skills = await listSkills(dir)
      expect(skills).toEqual([])
      // Must not warn about the in-progress dir — expected state.
      const warnedAboutInProg = stderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('in-progress'),
      )
      expect(warnedAboutInProg).toBe(false)
      stderrSpy.mockRestore()
    })
  })

  it('warns on loose .md files at skills/ root', async () => {
    await withTmpDir(async (dir) => {
      await initSkillsDir(dir)
      writeFileSync(join(dir, 'skills', 'loose.md'), 'some content')
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      await listSkills(dir)
      const warned = stderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('loose.md'),
      )
      expect(warned).toBe(true)
      stderrSpy.mockRestore()
    })
  })

  it('warns on malformed SKILL.md and skips it', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      await writeSkill(dir, makeSkill({ id: 'good', name: 'good' }), audit.writer)
      const badDir = join(dir, 'skills', 'bad-skill')
      mkdirSync(badDir, { recursive: true })
      writeFileSync(join(badDir, 'SKILL.md'), 'garbage not frontmatter')
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      const skills = await listSkills(dir)
      expect(skills.map((s) => s.id)).toEqual(['good'])
      const warned = stderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('malformed'),
      )
      expect(warned).toBe(true)
      stderrSpy.mockRestore()
    })
  })
})

// ---------------------------------------------------------------------------
// deleteSkill
// ---------------------------------------------------------------------------

describe('deleteSkill', () => {
  it('removes SKILL.md and rmdirs empty skill directory', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({ id: 'to-delete' })
      await writeSkill(dir, s, audit.writer)
      const skillDir = join(dir, 'skills', 'to-delete')
      expect(statSync(skillDir).isDirectory()).toBe(true)

      await deleteSkill(dir, 'to-delete', audit.writer)

      // Directory should be rmdir'd.
      expect(() => statSync(skillDir)).toThrow()
      expect(audit.events).toHaveLength(2)
      const del = audit.events[1]!
      expect(del.type).toBe('skill_deleted')
      if (del.type === 'skill_deleted') {
        expect(del.id).toBe('to-delete')
        expect(del.name).toBe(s.name)
      }
    })
  })

  it('leaves <id>/ with sibling assets intact', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const s = makeSkill({ id: 'has-assets' })
      await writeSkill(dir, s, audit.writer)
      const skillDir = join(dir, 'skills', 'has-assets')
      mkdirSync(join(skillDir, 'assets'), { recursive: true })
      writeFileSync(join(skillDir, 'assets', 'data.bin'), 'userfile')

      await deleteSkill(dir, 'has-assets', audit.writer)

      expect(statSync(join(skillDir, 'assets', 'data.bin')).isFile()).toBe(true)
      expect(statSync(skillDir).isDirectory()).toBe(true)
    })
  })

  it('throws SkillNotFoundError when absent', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      await expect(
        deleteSkill(dir, 'never-existed', audit.writer),
      ).rejects.toBeInstanceOf(SkillNotFoundError)
    })
  })
})

// ---------------------------------------------------------------------------
// rebuildIndex
// ---------------------------------------------------------------------------

describe('rebuildIndex', () => {
  it('regenerates SKILLS.md from on-disk skills without audit events', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      await writeSkill(dir, makeSkill({ id: 'a', name: 'a' }), audit.writer)
      await writeSkill(dir, makeSkill({ id: 'b', name: 'b' }), audit.writer)

      // Corrupt the index.
      await writeFile(join(dir, 'skills', 'SKILLS.md'), 'stale garbage')

      const beforeCount = audit.events.length
      await rebuildIndex(dir)
      expect(audit.events.length).toBe(beforeCount) // no audit emitted

      const contents = (
        await import('node:fs/promises')
      ).readFile(join(dir, 'skills', 'SKILLS.md'), 'utf8')
      await expect(contents).resolves.toContain('- [a](a/SKILL.md)')
      await expect(contents).resolves.toContain('- [b](b/SKILL.md)')
    })
  })
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('concurrency', () => {
  it('two parallel writeSkill calls to different ids both land', async () => {
    await withTmpDir(async (dir) => {
      const audit = collectingAudit()
      const p1 = writeSkill(dir, makeSkill({ id: 'one', name: 'one' }), audit.writer)
      const p2 = writeSkill(dir, makeSkill({ id: 'two', name: 'two' }), audit.writer)
      await Promise.all([p1, p2])
      const skills = await listSkills(dir)
      expect(skills.map((s) => s.id).sort()).toEqual(['one', 'two'])
      expect(audit.events).toHaveLength(2)
    })
  })
})
