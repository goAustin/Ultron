/**
 * Phase 5b: `/skill` slash command.
 *
 * Subcommands:
 *   /skill                       — print SKILLS.md
 *   /skill list                  — table of skills
 *   /skill show <id>             — render one skill via serializeSkill
 *   /skill activate <id> [--turns N] [args...] — open an activation window
 *   /skill deactivate            — close the active window (if any)
 *   /skill help                  — usage
 *
 * Bare-id activation (`/skill <id> ...`) is intentionally NOT supported:
 * it would shadow subcommand routing and break the convention shared with
 * `/memory`, `/mcp`, and `/model`.
 */

import { listSkills, readIndex, readSkill } from '../skills/store.js'
import { serializeSkill, validateId } from '../skills/skill.js'
import { summarizeMatches } from '../skills/router.js'
import type { ActiveSkill } from '../skills/router.js'
import type { SecretMatch } from '../memory/secretScanner.js'
import { confirmYesNo as defaultConfirmYesNo } from './confirmPrompt.js'

// ---------------------------------------------------------------------------
// Engine-facing surface
// ---------------------------------------------------------------------------

export type ActivateSkillOpts = {
  readonly turns?: number
  readonly args?: string
}

export type SkillScanHandler = (
  matches: readonly SecretMatch[],
) => Promise<boolean>

export type SkillEngine = {
  readonly memoryBaseDir: string | null
  readonly activeSkill: ActiveSkill | null
  readonly isSkillActive: boolean
  activateSkill(
    id: string,
    opts?: ActivateSkillOpts,
    scanHandler?: SkillScanHandler,
  ): Promise<void>
  deactivateSkill(reason: 'user_deactivated'): void
}

export type SkillCommandIo = {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly confirmYesNo?: typeof defaultConfirmYesNo
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TURNS_MAX = 100
const LIST_CAP = 50

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleSkillCommand(
  input: string,
  engine: SkillEngine,
  io: SkillCommandIo,
): Promise<void> {
  const baseDir = engine.memoryBaseDir
  if (baseDir === null) {
    io.stdout.write('[skill] disabled in this engine (memory off)\n')
    return
  }

  const trimmed = input.trim()
  const rest = trimmed === '/skill' ? '' : trimmed.slice('/skill '.length)
  const tokens = rest.trim().length === 0 ? [] : rest.trim().split(/\s+/)
  const subcommand = tokens[0] ?? ''
  const args = tokens.slice(1)

  const confirmFn = io.confirmYesNo ?? defaultConfirmYesNo
  const ctx: SubCtx = {
    baseDir,
    stdout: io.stdout,
    stderr: io.stderr,
    confirmYesNo: confirmFn,
    engine,
  }

  try {
    switch (subcommand) {
      case '':
        await showIndex(ctx)
        return
      case 'list':
        await listCmd(ctx)
        return
      case 'show':
        await showCmd(ctx, args)
        return
      case 'activate':
        await activateCmd(ctx, args)
        return
      case 'deactivate':
        deactivateCmd(ctx)
        return
      case 'help':
        writeHelp(ctx)
        return
      default:
        io.stderr.write(`[skill] unknown subcommand "${subcommand}"\n`)
        writeHelp(ctx)
        return
    }
  } catch (err: unknown) {
    io.stderr.write(`[skill] ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

// ---------------------------------------------------------------------------
// Subcommand context
// ---------------------------------------------------------------------------

type SubCtx = {
  readonly baseDir: string
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly confirmYesNo: typeof defaultConfirmYesNo
  readonly engine: SkillEngine
}

// ---------------------------------------------------------------------------
// /skill (default) — print the index
// ---------------------------------------------------------------------------

async function showIndex(ctx: SubCtx): Promise<void> {
  const raw = await readIndex(ctx.baseDir)
  if (raw.trim().length === 0) {
    ctx.stdout.write('(no skills)\n')
    return
  }
  ctx.stdout.write(raw.endsWith('\n') ? raw : `${raw}\n`)
}

// ---------------------------------------------------------------------------
// /skill list
// ---------------------------------------------------------------------------

async function listCmd(ctx: SubCtx): Promise<void> {
  const skills = await listSkills(ctx.baseDir)
  if (skills.length === 0) {
    ctx.stdout.write('(no skills)\n')
    return
  }

  const shown = skills.slice(0, LIST_CAP)
  const idWidth = Math.max(2, ...shown.map((s) => s.id.length))
  const nameWidth = Math.max(4, ...shown.map((s) => s.name.length))

  const pad = (s: string, n: number): string =>
    s.length >= n ? s : s + ' '.repeat(n - s.length)

  ctx.stdout.write(
    `${pad('id', idWidth)}  ${pad('name', nameWidth)}  argHint  allowedTools\n`,
  )
  for (const s of shown) {
    const argHint = s.argumentHint !== undefined ? 'yes' : 'no '
    const tools =
      s.allowedTools !== undefined ? String(s.allowedTools.length) : '-'
    ctx.stdout.write(
      `${pad(s.id, idWidth)}  ${pad(s.name, nameWidth)}  ${argHint}      ${tools}\n`,
    )
  }
  if (skills.length > LIST_CAP) {
    ctx.stdout.write(
      `… (${skills.length - LIST_CAP} more)\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// /skill show <id>
// ---------------------------------------------------------------------------

async function showCmd(ctx: SubCtx, args: readonly string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    ctx.stderr.write('[skill] usage: /skill show <id>\n')
    return
  }
  if (!validateId(id)) {
    ctx.stderr.write(`[skill] invalid id "${id}"\n`)
    return
  }
  const skill = await readSkill(ctx.baseDir, id)
  if (skill === null) {
    ctx.stderr.write(`[skill] skill "${id}" not found\n`)
    return
  }
  ctx.stdout.write(serializeSkill(skill))
}

// ---------------------------------------------------------------------------
// /skill activate <id> [--turns N] [args...]
// ---------------------------------------------------------------------------

async function activateCmd(
  ctx: SubCtx,
  args: readonly string[],
): Promise<void> {
  const id = args[0]
  if (!id) {
    ctx.stderr.write('[skill] usage: /skill activate <id> [--turns N] [args...]\n')
    return
  }
  if (!validateId(id)) {
    ctx.stderr.write(`[skill] invalid id "${id}"\n`)
    return
  }

  // Parse --turns N (only honored when it's the literal first token after id).
  let turns = 1
  let argTokens = args.slice(1)
  if (argTokens[0] === '--turns') {
    const raw = argTokens[1]
    const n = raw === undefined ? NaN : Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > TURNS_MAX) {
      ctx.stderr.write(
        `[skill] --turns must be an integer 1..${TURNS_MAX}\n`,
      )
      return
    }
    turns = n
    argTokens = argTokens.slice(2)
  }
  const skillArgs = argTokens.join(' ')

  const scanHandler: SkillScanHandler = (matches) =>
    ctx.confirmYesNo(
      `Skill body matches credential-like patterns: ${summarizeMatches(matches)}. Activate anyway?`,
      { defaultNo: true },
    )

  await ctx.engine.activateSkill(
    id,
    { turns, args: skillArgs },
    scanHandler,
  )
  ctx.stdout.write(`skill "${id}" activated for ${turns} turn(s)\n`)
}

// ---------------------------------------------------------------------------
// /skill deactivate
// ---------------------------------------------------------------------------

function deactivateCmd(ctx: SubCtx): void {
  if (!ctx.engine.isSkillActive) {
    ctx.stdout.write('(no active skill)\n')
    return
  }
  const id = ctx.engine.activeSkill?.id
  ctx.engine.deactivateSkill('user_deactivated')
  ctx.stdout.write(`skill "${id}" deactivated\n`)
}

// ---------------------------------------------------------------------------
// /skill help
// ---------------------------------------------------------------------------

function writeHelp(ctx: SubCtx): void {
  const lines = [
    'Skill management:',
    '  /skill                                       — print SKILLS.md',
    '  /skill list                                  — list available skills',
    '  /skill show <id>                             — print one skill',
    '  /skill activate <id> [--turns N] [args...]   — open an activation window',
    '  /skill deactivate                            — close the active window',
    '  /skill help                                  — this message',
    '',
    'Skills are user-authored in $EDITOR; Ultron does not provide /skill new',
    'or /skill edit. Place files at ~/.ultron/skills/<id>/SKILL.md.',
    `Activation window defaults to 1 turn; max ${TURNS_MAX}.`,
    'Skill ids that look like subcommands (list, show, activate, deactivate,',
    'help) must be invoked with /skill activate <id>.',
  ]
  for (const line of lines) ctx.stdout.write(`${line}\n`)
}
