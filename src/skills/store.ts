/**
 * Skills store — typed on-disk SKILL.md bundles + regenerated index.
 *
 * Layout under `<baseDir>/skills/`:
 *   - `<id>/SKILL.md`   — one file per skill, mode 0o600
 *   - `<id>/...`        — arbitrary sibling files/dirs (assets/, scripts/,
 *                         references/, agents/) preserved untouched by the
 *                         store; 5a only manages SKILL.md and SKILL.md.tmp.
 *   - `SKILLS.md`       — regenerated index, one line per skill
 *
 * All mutations go through `atomicWrite` (tmp + fsync + rename + parent-dir
 * fsync) and serialize on a per-baseDir promise chain, so concurrent writes
 * from the same process land deterministically. SKILLS.md is never the source
 * of truth — every `listSkills` call reads the directory directly, and
 * mutations rebuild the index from that listing.
 *
 * Write gate in 5a rejects on ANY secret match (high or low confidence);
 * 5b loosens via `allowLowConfidenceSecrets` when the activation surface
 * brings an askUser hook.
 *
 * Skill-level caps count SKILL.md bytes only — sibling assets are not
 * metered by 5a (they're invisible to the store).
 */

import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AuditWriter } from '../audit/types.js'
import {
  makeSkillDeletedEvent,
  makeSkillWrittenEvent,
} from '../core/queryEventFactories.js'
import {
  canRoundTrip,
  isValidAllowedTool,
  isValidArgumentHint,
  parseSkillFile,
  serializeSkill,
  validateId,
  type Skill,
} from './skill.js'
import { detectSecrets, type SecretMatch } from '../memory/secretScanner.js'

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export const MAX_SKILL_BYTES = 64 * 1024
export const MAX_TOTAL_SKILL_BYTES = 4 * 1024 * 1024
export const MAX_SKILL_COUNT = 128

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class InvalidSkillIdError extends Error {
  constructor(readonly id: string) {
    super(`Invalid skill id: ${JSON.stringify(id)}`)
    this.name = 'InvalidSkillIdError'
  }
}

export class SkillTooLargeError extends Error {
  constructor(readonly bytes: number, readonly cap: number) {
    super(`Skill too large: ${bytes} bytes exceeds cap of ${cap}`)
    this.name = 'SkillTooLargeError'
  }
}

export class SkillsFullError extends Error {
  constructor(readonly totalBytes: number, readonly cap: number) {
    super(`Skills store full: ${totalBytes} bytes would exceed cap of ${cap}`)
    this.name = 'SkillsFullError'
  }
}

export class TooManySkillsError extends Error {
  constructor(readonly count: number, readonly cap: number) {
    super(`Too many skills: ${count} would exceed cap of ${cap}`)
    this.name = 'TooManySkillsError'
  }
}

export class SecretInSkillError extends Error {
  constructor(readonly matches: readonly SecretMatch[]) {
    const types = [...new Set(matches.map((m) => m.type))].join(', ')
    super(`Skill contains potential secrets: ${types}`)
    this.name = 'SecretInSkillError'
  }
}

export class SkillNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Skill not found: ${id}`)
    this.name = 'SkillNotFoundError'
  }
}

export class MalformedSkillError extends Error {
  constructor(readonly reason: string) {
    super(`Skill has unencodable content: ${reason}`)
    this.name = 'MalformedSkillError'
  }
}

// ---------------------------------------------------------------------------
// Per-baseDir mutation queue (separate from memory's)
// ---------------------------------------------------------------------------

const chains: Map<string, Promise<unknown>> = new Map()

function enqueue<T>(baseDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(baseDir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(
    baseDir,
    next.catch(() => undefined),
  )
  return next as Promise<T>
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const INDEX_NAME = 'SKILLS.md'
const SKILL_FILE = 'SKILL.md'
const TMP_SUFFIX = '.tmp'
const SKILL_TMP = `${SKILL_FILE}${TMP_SUFFIX}`

function skillsDir(baseDir: string): string {
  return join(baseDir, 'skills')
}

function skillDirPath(baseDir: string, id: string): string {
  return join(skillsDir(baseDir), id)
}

function skillFilePath(baseDir: string, id: string): string {
  return join(skillDirPath(baseDir, id), SKILL_FILE)
}

function indexPath(baseDir: string): string {
  return join(skillsDir(baseDir), INDEX_NAME)
}

// ---------------------------------------------------------------------------
// initSkillsDir
// ---------------------------------------------------------------------------

/**
 * Ensure the skills directory exists at 0o700 and sweep any orphaned
 * SKILL.md.tmp files from prior crashes. Does not touch (or count) empty
 * `<id>/` subdirectories — a user mid-authoring a skill may legitimately
 * have only `scripts/` staged.
 */
export async function initSkillsDir(baseDir: string): Promise<void> {
  const dir = skillsDir(baseDir)
  await mkdir(dir, { recursive: true })
  try {
    await chmod(dir, 0o700)
  } catch {
    // Best-effort — some filesystems (Windows, certain mounts) reject chmod.
  }

  // Sweep orphaned SKILL.md.tmp one level down.
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!validateId(name)) continue
    const tmpPath = join(dir, name, SKILL_TMP)
    try {
      await unlink(tmpPath)
    } catch {
      // Not present, or another process swept it.
    }
  }
}

// ---------------------------------------------------------------------------
// atomicWrite
// ---------------------------------------------------------------------------

async function atomicWrite(
  finalPath: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const tmpPath = `${finalPath}${TMP_SUFFIX}`
  const fd = await open(tmpPath, 'w', mode)
  try {
    await fd.write(bytes)
    await fd.sync()
  } finally {
    await fd.close()
  }
  await rename(tmpPath, finalPath)

  try {
    const dirFd = await open(dirname(finalPath), 'r')
    try {
      await dirFd.sync()
    } finally {
      await dirFd.close()
    }
  } catch {
    // ignore — some platforms disallow opening dirs for reading.
  }

  try {
    await chmod(finalPath, mode)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/**
 * Read a single skill by id. Returns null if `<id>/SKILL.md` does not exist.
 * Throws `MalformedSkillError` if the file exists but cannot be parsed.
 */
export async function readSkill(
  baseDir: string,
  id: string,
): Promise<Skill | null> {
  if (!validateId(id)) throw new InvalidSkillIdError(id)
  const path = skillFilePath(baseDir, id)
  let raw: string
  let fileStat: { birthtimeMs: number; mtimeMs: number }
  try {
    raw = await readFile(path, 'utf8')
    const s = await stat(path)
    fileStat = { birthtimeMs: s.birthtimeMs, mtimeMs: s.mtimeMs }
  } catch (err: unknown) {
    if (isEnoent(err)) return null
    throw err
  }
  const parsed = parseSkillFile(id, raw, fileStat)
  if (!parsed.ok) throw new MalformedSkillError(parsed.error)
  return parsed.skill
}

/**
 * List all skills in `<baseDir>/skills/`. Directory scan, one level deep:
 * each `<id>/SKILL.md` parses independently. Malformed files and skill dirs
 * without a SKILL.md are skipped (malformed → stderr warning; missing
 * SKILL.md → silent, since the user may be mid-authoring). Loose `.md`
 * files at the `skills/` root produce a one-off stderr warning.
 */
export async function listSkills(
  baseDir: string,
): Promise<readonly Skill[]> {
  const dir = skillsDir(baseDir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err: unknown) {
    if (isEnoent(err)) return []
    throw err
  }

  const skills: Skill[] = []
  for (const name of names) {
    if (name === INDEX_NAME) continue

    const fullPath = join(dir, name)
    let entryStat: Awaited<ReturnType<typeof stat>>
    try {
      entryStat = await stat(fullPath)
    } catch {
      continue
    }

    if (!entryStat.isDirectory()) {
      if (name.endsWith('.md')) {
        process.stderr.write(
          `Warning: loose .md file at skills/ root: ${name}. ` +
            `Move into a <id>/ directory as SKILL.md to be picked up.\n`,
        )
      }
      continue
    }

    if (!validateId(name)) continue

    const skillPath = join(fullPath, SKILL_FILE)
    let raw: string
    let fileStat: { birthtimeMs: number; mtimeMs: number }
    try {
      raw = await readFile(skillPath, 'utf8')
      const s = await stat(skillPath)
      fileStat = { birthtimeMs: s.birthtimeMs, mtimeMs: s.mtimeMs }
    } catch (err: unknown) {
      if (isEnoent(err)) continue // <id>/ without SKILL.md — silent skip.
      process.stderr.write(
        `Warning: failed to read skill ${name}: ${errMsg(err)}\n`,
      )
      continue
    }

    const parsed = parseSkillFile(name, raw, fileStat)
    if (!parsed.ok) {
      process.stderr.write(
        `Warning: skill ${name}/SKILL.md is malformed (${parsed.error}); skipping\n`,
      )
      continue
    }
    skills.push(parsed.skill)
  }

  return skills.slice().sort(compareSkills)
}

/**
 * Read the SKILLS.md index file. Returns empty string if not present.
 */
export async function readIndex(baseDir: string): Promise<string> {
  try {
    return await readFile(indexPath(baseDir), 'utf8')
  } catch (err: unknown) {
    if (isEnoent(err)) return ''
    throw err
  }
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export type WriteSkillOptions = {
  readonly allowLowConfidenceSecrets?: boolean
}

/**
 * Upsert a skill. Runs through: id validation → field round-trip + shape
 * checks → mkdir `<id>/` → serialize → cap check → secret scan → atomic
 * SKILL.md write → index rebuild → audit emission. `isNew` reflects whether
 * `<id>/SKILL.md` existed before this call.
 *
 * Sibling files and directories inside `<id>/` are untouched.
 */
export async function writeSkill(
  baseDir: string,
  skill: Skill,
  auditWriter: AuditWriter,
  opts: WriteSkillOptions = {},
): Promise<void> {
  return enqueue(baseDir, async () => {
    if (!validateId(skill.id)) throw new InvalidSkillIdError(skill.id)

    if (!canRoundTrip(skill.name) || !canRoundTrip(skill.description)) {
      throw new MalformedSkillError('name or description cannot be encoded')
    }
    if (skill.argumentHint !== undefined) {
      if (!canRoundTrip(skill.argumentHint)) {
        throw new MalformedSkillError('argument-hint cannot be encoded')
      }
      if (!isValidArgumentHint(skill.argumentHint)) {
        throw new MalformedSkillError('argument-hint is out of bounds')
      }
    }
    if (skill.allowedTools !== undefined) {
      for (const t of skill.allowedTools) {
        if (!isValidAllowedTool(t)) {
          throw new MalformedSkillError('allowed-tools entry is invalid')
        }
        if (!canRoundTrip(t)) {
          throw new MalformedSkillError('allowed-tools entry cannot be encoded')
        }
      }
    }

    await initSkillsDir(baseDir)

    const dirPath = skillDirPath(baseDir, skill.id)
    await mkdir(dirPath, { recursive: true })
    try {
      await chmod(dirPath, 0o700)
    } catch {
      // best-effort
    }

    const serialized = serializeSkill(skill)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_SKILL_BYTES) {
      throw new SkillTooLargeError(bytes, MAX_SKILL_BYTES)
    }

    const matches = detectSecrets(serialized)
    const relevant = opts.allowLowConfidenceSecrets
      ? matches.filter((m) => m.confidence === 'high')
      : matches
    if (relevant.length > 0) throw new SecretInSkillError(relevant)

    const existing = await listSkills(baseDir)
    const prior = existing.find((s) => s.id === skill.id)
    const isNew = prior === undefined

    const nextCount = isNew ? existing.length + 1 : existing.length
    if (nextCount > MAX_SKILL_COUNT) {
      throw new TooManySkillsError(nextCount, MAX_SKILL_COUNT)
    }

    const priorBytes = prior
      ? Buffer.byteLength(serializeSkill(prior), 'utf8')
      : 0
    const currentTotal = existing.reduce(
      (sum, s) => sum + Buffer.byteLength(serializeSkill(s), 'utf8'),
      0,
    )
    const nextTotal = currentTotal - priorBytes + bytes
    if (nextTotal > MAX_TOTAL_SKILL_BYTES) {
      throw new SkillsFullError(nextTotal, MAX_TOTAL_SKILL_BYTES)
    }

    await atomicWrite(
      skillFilePath(baseDir, skill.id),
      Buffer.from(serialized, 'utf8'),
      0o600,
    )

    const nextSkills = isNew
      ? [...existing, skill]
      : existing.map((s) => (s.id === skill.id ? skill : s))
    await writeIndex(baseDir, nextSkills)

    auditWriter.write(
      makeSkillWrittenEvent({
        id: skill.id,
        name: skill.name,
        bytes,
        hasAllowedTools: skill.allowedTools !== undefined,
        isNew,
      }),
    )
  })
}

/**
 * Delete a skill. Unlinks `<id>/SKILL.md`, then `rmdir`s the skill
 * directory iff it's empty (or contains only the leftover SKILL.md.tmp).
 * Sibling files/dirs — `assets/`, `scripts/`, etc. — cause the dir to be
 * left in place.
 *
 * Emits `skill_deleted` on success; `SkillNotFoundError` if SKILL.md is
 * absent.
 */
export async function deleteSkill(
  baseDir: string,
  id: string,
  auditWriter: AuditWriter,
): Promise<void> {
  return enqueue(baseDir, async () => {
    if (!validateId(id)) throw new InvalidSkillIdError(id)

    await initSkillsDir(baseDir)

    const skill = await readSkill(baseDir, id)
    if (skill === null) throw new SkillNotFoundError(id)

    try {
      await unlink(skillFilePath(baseDir, id))
    } catch (err: unknown) {
      if (isEnoent(err)) throw new SkillNotFoundError(id)
      throw err
    }

    // If only leftover SKILL.md.tmp remains, clean it and rmdir. Otherwise
    // leave the dir in place (user's assets survive).
    const dirPath = skillDirPath(baseDir, id)
    try {
      const remaining = await readdir(dirPath)
      if (remaining.length === 1 && remaining[0] === SKILL_TMP) {
        try {
          await unlink(join(dirPath, SKILL_TMP))
        } catch {
          // ignore
        }
      }
      const final = await readdir(dirPath)
      if (final.length === 0) {
        await rmdir(dirPath)
      }
    } catch {
      // If the directory disappeared or is unreadable, nothing to do.
    }

    const remaining = (await listSkills(baseDir)).filter((s) => s.id !== id)
    await writeIndex(baseDir, remaining)

    auditWriter.write(
      makeSkillDeletedEvent({ id: skill.id, name: skill.name }),
    )
  })
}

// ---------------------------------------------------------------------------
// Index rebuild
// ---------------------------------------------------------------------------

/**
 * Atomic SKILLS.md write. The caller must already hold the per-`baseDir`
 * mutation slot.
 */
async function writeIndex(
  baseDir: string,
  skills: readonly Skill[],
): Promise<void> {
  const sorted = skills.slice().sort(compareSkills)
  const lines = sorted.map(
    (s) => `- [${s.name}](${s.id}/${SKILL_FILE}) — ${s.description}`,
  )
  const body = lines.length === 0 ? '' : lines.join('\n') + '\n'
  await atomicWrite(indexPath(baseDir), Buffer.from(body, 'utf8'), 0o600)
}

/**
 * Regenerate `SKILLS.md` from current on-disk skills. No audit event —
 * skill files are unchanged; only the derived index is rewritten.
 */
export async function rebuildIndex(baseDir: string): Promise<void> {
  return enqueue(baseDir, async () => {
    await initSkillsDir(baseDir)
    const skills = await listSkills(baseDir)
    await writeIndex(baseDir, skills)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compareSkills(a: Skill, b: Skill): number {
  const n = a.name.localeCompare(b.name)
  if (n !== 0) return n
  return a.id.localeCompare(b.id)
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  )
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
