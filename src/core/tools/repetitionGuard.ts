/**
 * Tool-call repetition guard.
 *
 * Catches the failure mode where the model re-issues the same tool call
 * with structurally similar input across many turns (e.g., clicking near
 * the same coordinates, or repeatedly trying to act on a stale atomId)
 * without observable progress. Without this guard, such loops only stop
 * at the model's TPM rate limit.
 *
 * Lives at the `runToolUse` boundary so it works across every tool, not
 * just Computer-Use. The session-level no-progress detector
 * (`SessionManager.recordStep`) handles in-session progress; this guard
 * catches loops that the session detector misses (e.g., when a side
 * signal like a video preview's pHash keeps varying, defeating the
 * "all available signals stalled" rule).
 *
 * The state is `context.messages` itself — we walk back through the
 * conversation rather than maintaining a parallel ring. The window is
 * shallow (last N tool_use blocks), so the cost is O(N) per call.
 */

import type { Message, ToolUseBlock } from '../messages.js'

/** Coords within this normalized distance count as "the same place". */
const COORD_TOLERANCE = 0.02

/** How many recent prior tool_use blocks to consider. */
const DEFAULT_WINDOW = 9

/** Trip when current + N prior matches reach this total. */
const DEFAULT_TRIP_TOTAL = 4

export type RepetitionCheck =
  | { tripped: false }
  | { tripped: true; reason: string }

export type RepetitionGuardOptions = {
  readonly window?: number
  readonly tripTotal?: number
}

export function checkToolRepetition(
  toolUse: ToolUseBlock,
  messages: readonly Message[],
  options: RepetitionGuardOptions = {},
): RepetitionCheck {
  const window = options.window ?? DEFAULT_WINDOW
  const tripTotal = options.tripTotal ?? DEFAULT_TRIP_TOTAL

  const priorBlocks = collectRecentToolUseBlocks(messages, window, toolUse.id)

  let matches = 0
  for (const prior of priorBlocks) {
    if (prior.name !== toolUse.name) continue
    if (inputsAreSimilar(toolUse.name, toolUse.input, prior.input)) matches++
  }

  const total = matches + 1
  if (total < tripTotal) return { tripped: false }

  return {
    tripped: true,
    reason:
      `Tool-call repetition guard: \`${toolUse.name}\` was invoked ${total} times ` +
      `with structurally similar input in the last ${priorBlocks.length + 1} tool calls ` +
      `without observable progress. Re-plan: refresh context, hand off to the user via ` +
      `ComputerHandoffToUser, or use OpenInBrowser if the user wants to consume the page themselves.`,
  }
}

/**
 * Walk messages newest-first, collect tool_use blocks (newest-first), stop
 * at `limit`. Skips the in-flight `currentId` if it has already been written
 * to messages by the time we run.
 */
function collectRecentToolUseBlocks(
  messages: readonly Message[],
  limit: number,
  currentId: string,
): ToolUseBlock[] {
  const out: ToolUseBlock[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = msg.content
    for (let j = content.length - 1; j >= 0 && out.length < limit; j--) {
      const block = content[j]
      if (block.type !== 'tool_use') continue
      if (block.id === currentId) continue
      out.push(block)
    }
  }
  return out
}

function inputsAreSimilar(
  toolName: string,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  // Coordinate-based Computer-Use tools: compare normalized x/y. The model
  // routinely jiggles coordinates by a pixel or two between identical-intent
  // clicks, so an exact JSON match is too strict here.
  if (toolName === 'ComputerClick') {
    return numbersNear(a.x, b.x) && numbersNear(a.y, b.y)
  }
  if (toolName === 'ComputerScroll') {
    return numbersNear(a.x, b.x) && numbersNear(a.y, b.y)
  }
  if (toolName === 'ComputerDrag') {
    return (
      numbersNear(a.fromX, b.fromX) &&
      numbersNear(a.fromY, b.fromY) &&
      numbersNear(a.toX, b.toX) &&
      numbersNear(a.toY, b.toY)
    )
  }
  // Atom-based action: same atomId is the strong signal. Different actions
  // (click vs fill) on the same atom are still a loop because the atom is
  // what the model can't move past.
  if (toolName === 'ComputerActAtom') {
    return typeof a.atomId === 'string' && a.atomId === b.atomId
  }
  // Default — exact canonical match. Catches retried WebFetch/WebSearch with
  // the same query, ComputerNavigate to the same URL, etc.
  return canonicalize(a) === canonicalize(b)
}

function numbersNear(a: unknown, b: unknown): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') return false
  // Tiny FP slack — `0.303 - 0.283` evaluates to 0.020000000000000018 in
  // IEEE 754, which would falsely fail an exact `<= 0.02` check.
  return Math.abs(a - b) <= COORD_TOLERANCE + 1e-9
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']'
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return (
    '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalize(v)).join(',') + '}'
  )
}
