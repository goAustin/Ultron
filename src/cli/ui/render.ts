/**
 * Pure formatters that turn theme + content into ready-to-write strings.
 *
 * Every function returns the full string (including any trailing newline) so
 * callers can compose them via simple `output.write(…)` calls. None of them
 * touch process.stdout directly. There is no background painting — the
 * palette is tuned for legibility on the terminal's native bg.
 */

import type { Theme } from './themes.js'

const DEFAULT_WIDTH = 80
const MAX_WIDTH = 100
const MIN_WIDTH = 40

export function resolveWidth(stream?: { columns?: number }): number {
  const cols = stream?.columns
  if (typeof cols !== 'number' || !Number.isFinite(cols) || cols <= 0) return DEFAULT_WIDTH
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, cols))
}

/** Visible length of a string after stripping CSI/SGR escapes. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

/** Truncate from the left, prefixing an ellipsis. Used for long cwd paths. */
export function truncateLeft(s: string, max: number): string {
  if (max <= 1) return s.slice(-Math.max(1, max))
  if (s.length <= max) return s
  return '…' + s.slice(s.length - (max - 1))
}

// ---------------------------------------------------------------------------
// Session header — the strip rendered at the very top of a session.
// ---------------------------------------------------------------------------

export type SessionHeaderOpts = {
  readonly name?: string
  readonly model: string
  readonly cwd: string
  readonly width?: number
}

export function renderSessionHeader(theme: Theme, opts: SessionHeaderOpts): string {
  const width = opts.width ?? DEFAULT_WIDTH
  const name = opts.name ?? 'ultron'
  const left = `${theme.bold('fg', name)} ${theme.style('faint', '·')} ${theme.style('faint', opts.model)}`
  const leftVisible = visibleLength(left)
  const cwdMax = Math.max(8, width - leftVisible - 2)
  const cwd = theme.style('faint', truncateLeft(opts.cwd, cwdMax))
  const cwdVisible = visibleLength(cwd)
  const padCount = Math.max(1, width - leftVisible - cwdVisible)
  const top = `${left}${' '.repeat(padCount)}${cwd}`
  const rule = theme.style('rule', '─'.repeat(width))
  return `${top}\n${rule}\n`
}

// ---------------------------------------------------------------------------
// Welcome banner — first-run greeting with a 2-col command grid.
//
// Mirrors the design's `gridTemplateColumns: '1fr 1fr'` × 3 rows. Hint pairs
// flow column-major so the layout reads top-to-bottom-then-right just like
// the React CSS Grid.
// ---------------------------------------------------------------------------

const WELCOME_HINTS: readonly (readonly [string, string])[] = [
  ['ask',     'just type a question'],
  ['/run',    'run a shell command'],
  ['/read',   'open a file'],
  ['/web',    'search the web'],
  ['/help',   'see everything'],
  ['ctrl-c',  'cancel · ctrl-d quit'],
]

const HINT_CMD_PAD = 8

function renderHintGrid(
  theme: Theme,
  hints: readonly (readonly [string, string])[],
  width: number,
): string {
  const rows = Math.ceil(hints.length / 2)
  const colWidth = Math.floor((width - 4) / 2)
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    const left = hints[r]
    const right = hints[r + rows]
    const leftCell = left ? formatHintCell(theme, left[0], left[1], colWidth) : ''
    const rightCell = right ? formatHintCell(theme, right[0], right[1], colWidth) : ''
    lines.push(`  ${leftCell}  ${rightCell}`.replace(/\s+$/, ''))
  }
  return lines.join('\n') + '\n'
}

function formatHintCell(theme: Theme, cmd: string, hint: string, cellWidth: number): string {
  const cmdPart = theme.style('accent', cmd.padEnd(HINT_CMD_PAD, ' '))
  const hintBudget = Math.max(0, cellWidth - HINT_CMD_PAD - 2)
  const hintTrimmed = hint.length > hintBudget ? hint.slice(0, Math.max(0, hintBudget - 1)) + '…' : hint
  return `${cmdPart}  ${theme.style('dim', hintTrimmed)}`
}

export function renderWelcome(theme: Theme, opts: { readonly width?: number } = {}): string {
  const width = opts.width ?? DEFAULT_WIDTH
  const hello = theme.bold('fg', 'Hello.')
  const ultronWord = theme.bold('fg', 'ultron')
  const tagline = `I'm ${ultronWord}${theme.style('dim', " — a small assistant that lives in your terminal.")}`
  const blurb = theme.style(
    'dim',
    'I can run commands, read & write files, look things up on\nthe web, and explain code.',
  )
  const grid = renderHintGrid(theme, WELCOME_HINTS, width)
  return [hello, tagline, blurb, '', grid].join('\n')
}

// ---------------------------------------------------------------------------
// Help block — shown on /help. Same hint styling as the welcome card,
// but lists the slash commands the CLI actually wires up.
// ---------------------------------------------------------------------------

const HELP_HINTS: readonly (readonly [string, string])[] = [
  ['ask',          'just type a question'],
  ['/init',        'create ULTRON.md in the current directory'],
  ['/model',       'switch model'],
  ['/theme',       'switch theme (light · dark)'],
  ['/glyph',       'change prompt glyph (❯ $ ~ ▸)'],
  ['/memory',      'manage saved memory'],
  ['/skill',       'manage skills'],
  ['/web',         'search the web'],
  ['/mcp status',  'mcp server health'],
  ['/session',     'show session id'],
  ['/clear',       'clear the screen'],
  ['/help',        'show this list'],
  ['/quit',        'quit'],
  ['esc',          'cancel a streaming reply'],
]

export function renderHelp(theme: Theme): string {
  const lines = HELP_HINTS.map(([cmd, hint]) => {
    const padded = cmd.padEnd(14, ' ')
    return `  ${theme.style('accent', padded)}  ${theme.style('dim', hint)}`
  }).join('\n')
  return `${theme.style('faint', 'commands')}\n${lines}\n`
}

// ---------------------------------------------------------------------------
// Prompt line — the user-typed line, rendered for echo / replay.
// ---------------------------------------------------------------------------

export function renderPromptLine(theme: Theme, glyph: string, text: string): string {
  return `${theme.style('accent', glyph)} ${theme.style('user', text)}\n`
}

/**
 * Build the bare readline prompt string (glyph + space). The CLI passes this
 * into `rl.question()` — readline computes column width from this string.
 */
export function readlinePrompt(theme: Theme, glyph: string): string {
  return `${theme.style('accent', glyph)} `
}

// ---------------------------------------------------------------------------
// Assistant reply header — the small "ULTRON" label that precedes a Say.
// ---------------------------------------------------------------------------

export function renderReplyHeader(theme: Theme, name = 'ultron'): string {
  return `${theme.style('dim', name.toUpperCase())}\n`
}

// ---------------------------------------------------------------------------
// Tool card — bordered, status-dotted block describing a tool call.
// ---------------------------------------------------------------------------

export type ToolStatus = 'running' | 'done' | 'error'

export type ToolHeaderOpts = {
  readonly kind: string
  readonly name: string
  readonly status: ToolStatus
  readonly time?: string
  readonly width?: number
}

function statusRole(status: ToolStatus): 'accent2' | 'dim' | 'error' {
  switch (status) {
    case 'running': return 'accent2'
    case 'error':   return 'error'
    case 'done':    return 'dim'
  }
}

export function renderToolHeader(theme: Theme, opts: ToolHeaderOpts): string {
  const width = opts.width ?? DEFAULT_WIDTH
  const dot = theme.style(statusRole(opts.status), '●')
  const kind = theme.style('faint', opts.kind.toUpperCase())
  const sep = theme.style('faint', '·')
  const name = theme.style('dim', opts.name)
  const left = `  ${dot} ${kind} ${sep} ${name}`
  if (!opts.time) return `${left}\n`
  const time = theme.style('faint', opts.time)
  const leftVisible = visibleLength(left)
  const timeVisible = visibleLength(time)
  const pad = Math.max(2, width - leftVisible - timeVisible)
  return `${left}${' '.repeat(pad)}${time}\n`
}

/** Indent a body block under a tool header. Each line gets a 4-space prefix. */
export function renderToolBody(
  theme: Theme,
  body: string,
  role: 'fg' | 'dim' | 'faint' | 'error' = 'dim',
): string {
  if (body.length === 0) return ''
  const trimmed = body.replace(/\n+$/, '')
  return trimmed.split('\n').map((l) => `    ${theme.style(role, l)}`).join('\n') + '\n'
}
