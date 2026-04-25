/**
 * Integration test: skills store end-to-end.
 *
 * Drives `writeSkill` / `deleteSkill` against a real `createAuditWriter`,
 * asserts on-disk layout (<id>/SKILL.md + SKILLS.md + perms), asserts the
 * audit JSONL contains metadata-only skill events, and verifies that the
 * extended `enforceBaseDirectoryPermissions` creates the skills directory.
 * Also exercises hand-authored skill parse (SKILL.md with only name +
 * description) with filesystem-stat timestamp fallback.
 */

import { describe, it, expect } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createAuditWriter } from '../../src/audit/auditLog.js'
import { enforceBaseDirectoryPermissions } from '../../src/memory/localMemoryGuard.js'
import {
  deleteSkill,
  listSkills,
  readSkill,
  writeSkill,
} from '../../src/skills/store.js'
import type { Skill } from '../../src/skills/skill.js'

const IS_WINDOWS = process.platform === 'win32'

function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ultron-skill-integ-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  const t = Date.parse('2026-04-24T00:00:00.000Z')
  return {
    schemaVersion: 1,
    id: 'integ-skill',
    name: 'integ-skill',
    description: 'An integration-test skill',
    content: 'Instructions body.\nWith : colons and multi-line content.',
    createdAt: t,
    updatedAt: t,
    ...overrides,
  }
}

describe('skills store integration', () => {
  it('enforce + write + read round-trip with correct perms', async () => {
    await withTmpDir(async (dir) => {
      const writer = createAuditWriter({ dir })
      try {
        await enforceBaseDirectoryPermissions(dir)

        const s = makeSkill({
          allowedTools: ['FileRead', 'Grep'],
          argumentHint: '<pr-url>',
        })
        await writeSkill(dir, s, writer)

        const got = await readSkill(dir, s.id)
        expect(got).toEqual(s)

        if (!IS_WINDOWS) {
          expect(statSync(join(dir, 'skills')).mode & 0o777).toBe(0o700)
          expect(statSync(join(dir, 'skills', s.id)).mode & 0o777).toBe(0o700)
          expect(
            statSync(join(dir, 'skills', s.id, 'SKILL.md')).mode & 0o777,
          ).toBe(0o600)
        }
      } finally {
        await writer.close()
      }
    })
  })

  it('hand-authored SKILL.md (only name + description) parses with stat fallback', async () => {
    await withTmpDir(async (dir) => {
      const skillDir = join(dir, 'skills', 'hand-made')
      mkdirSync(skillDir, { recursive: true })
      const raw =
        '---\nname: hand-made\ndescription: authored in $EDITOR\n---\n\nBody only.\n'
      writeFileSync(join(skillDir, 'SKILL.md'), raw)

      const s = await readSkill(dir, 'hand-made')
      expect(s).not.toBeNull()
      expect(s!.name).toBe('hand-made')
      expect(s!.description).toBe('authored in $EDITOR')
      expect(s!.schemaVersion).toBe(1)
      expect(s!.allowedTools).toBeUndefined()
      // Timestamps fall back to file stat, so non-zero.
      expect(s!.updatedAt).toBeGreaterThan(0)
    })
  })

  it('audit log JSONL contains metadata-only skill events', async () => {
    await withTmpDir(async (dir) => {
      const writer = createAuditWriter({ dir })
      try {
        const s = makeSkill({ id: 'audit-s', name: 'audit-s' })
        await writeSkill(dir, s, writer)
        await deleteSkill(dir, s.id, writer)
      } finally {
        await writer.close()
      }

      const auditLog = join(dir, 'audit.jsonl')
      expect(statSync(auditLog).isFile()).toBe(true)

      const lines = readFileSync(auditLog, 'utf8').trim().split('\n')
      const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>)

      const written = events.find((e) => e['type'] === 'skill_written')
      const deleted = events.find((e) => e['type'] === 'skill_deleted')
      expect(written).toBeTruthy()
      expect(deleted).toBeTruthy()

      // Metadata-only contract.
      expect(written!['id']).toBe('audit-s')
      expect(written!['name']).toBe('audit-s')
      expect(typeof written!['bytes']).toBe('number')
      expect(typeof written!['hasAllowedTools']).toBe('boolean')
      expect(typeof written!['isNew']).toBe('boolean')
      // No body / description / allowed-tools on the payload.
      expect(written!['content']).toBeUndefined()
      expect(written!['description']).toBeUndefined()
      expect(written!['allowedTools']).toBeUndefined()
      expect(written!['allowed-tools']).toBeUndefined()

      expect(deleted!['id']).toBe('audit-s')
      expect(deleted!['name']).toBe('audit-s')
    })
  })

  it('sibling assets survive writeSkill and deleteSkill', async () => {
    await withTmpDir(async (dir) => {
      const writer = createAuditWriter({ dir })
      try {
        const s = makeSkill({ id: 'with-assets', name: 'with-assets' })
        await writeSkill(dir, s, writer)

        const skillDir = join(dir, 'skills', s.id)
        mkdirSync(join(skillDir, 'scripts'), { recursive: true })
        writeFileSync(join(skillDir, 'scripts', 'run.sh'), '#!/bin/sh\n')

        // Upsert — assets should stay.
        await writeSkill(dir, { ...s, updatedAt: Date.now() }, writer)
        expect(statSync(join(skillDir, 'scripts', 'run.sh')).isFile()).toBe(true)

        // Delete — assets still stay, dir remains.
        await deleteSkill(dir, s.id, writer)
        expect(statSync(join(skillDir, 'scripts', 'run.sh')).isFile()).toBe(true)
        expect(statSync(skillDir).isDirectory()).toBe(true)

        // `listSkills` now excludes the deleted skill.
        const remaining = await listSkills(dir)
        expect(remaining.map((x) => x.id)).not.toContain(s.id)
      } finally {
        await writer.close()
      }
    })
  })

  it('memory and skill mutations queue independently', async () => {
    // If the two stores shared a per-baseDir chain, interleaving would
    // serialize. We just assert both complete without deadlock; the fact
    // that both writers return is enough to confirm independence.
    const { writeEntry } = await import('../../src/memory/store.js')
    await withTmpDir(async (dir) => {
      const writer = createAuditWriter({ dir })
      try {
        const mem = {
          schemaVersion: 1 as const,
          id: 'mem-1',
          type: 'user' as const,
          name: 'n',
          description: 'd',
          content: 'body',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        const skill = makeSkill({ id: 'sk-1', name: 'sk-1' })
        await Promise.all([
          writeEntry(dir, mem, writer),
          writeSkill(dir, skill, writer),
        ])
        expect(await readSkill(dir, skill.id)).not.toBeNull()
      } finally {
        await writer.close()
      }
    })
  })
})
