/**
 * Phase 4·3 — opt-in CLI watch-mode renderer for Computer-Use events.
 *
 * `computerUse.watchMode: true` AND `process.stderr.isTTY` → the CLI
 * constructs a renderer once and calls `handle(ev)` for every QueryEvent
 * yielded by `engine.submitPrompt`. The renderer filters internally to
 * Computer-tool events and writes one line per event to stderr, narrating
 * what the model is doing in the browser without polluting stdout.
 *
 * Three event types are rendered:
 *   - `permission_decision` — the cascade emits this with the final
 *     allow/deny outcome. When `safetyMetadata` is present (computer safety
 *     check fired), the line includes the risk level. URL is resolved
 *     synchronously via the injected sessionLookup.
 *   - `tool_call_started` — fires after authorization. Renders a "start"
 *     line with the action summary derived from the tool's input (reuses
 *     `computerActionSummary` from `permissionPrompt.ts` so prompt + watch
 *     describe the action identically).
 *   - `tool_call_finished` — outcome + elapsed duration.
 *
 * The actual emission order is:
 *   permission_decision (allow|deny) → tool_call_started → tool_call_finished
 *
 * Non-Computer events are ignored. When `isTTY === false` the renderer is a
 * no-op (no spam in non-interactive logs / piped stderr).
 *
 * **Why a fan-out, not an engine subscriber:** there is no reusable
 * `engine.queryEvents` stream — events are yielded by the async generator
 * inside `submitPrompt`. The CLI's existing `for await` loop already iterates
 * every event; watch-mode plugs in there with one line.
 */

import type { QueryEvent } from '../core/queryEvents.js'
import { computerActionSummary, type SessionLookup } from './permissionPrompt.js'

export type WatchModeRenderer = {
  readonly handle: (ev: QueryEvent) => void
  readonly detach: () => void
}

export type CreateWatchModeOpts = {
  /** Where to write rendered lines. Defaults to `process.stderr`. */
  readonly output?: NodeJS.WritableStream
  /**
   * When `false`, `handle` is a no-op. Defaults to `(output as any).isTTY`
   * when `output` is a TTY-capable stream (e.g., process.stderr), otherwise
   * `false`. Pass an explicit value to override (tests pass `true`).
   */
  readonly isTTY?: boolean
  /**
   * Optional sessionLookup so the renderer can show the current URL alongside
   * Computer events. When absent, the URL field is omitted (best-effort —
   * watch-mode never crashes on a missing lookup).
   */
  readonly sessionLookup?: SessionLookup
}

const NAME_COL_WIDTH = 24 // widest is `ComputerHandoffToUser` (21 chars) + padding
const ACTION_COL_WIDTH = 9 // `ask L<n>`, `allow`, `deny`, `start`, `finish`

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function shortenSessionId(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId
}

function shortenHost(url: string | null): string {
  if (url === null) return ''
  try {
    const u = new URL(url)
    return u.host
  } catch {
    return ''
  }
}

function lookupUrl(
  input: Record<string, unknown>,
  sessionLookup: SessionLookup | undefined,
): string | null {
  if (sessionLookup === undefined) return null
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : null
  if (sessionId === null) return null
  return sessionLookup(sessionId)?.url ?? null
}

function renderHeader(
  toolName: string,
  action: string,
  input: Record<string, unknown>,
  sessionLookup: SessionLookup | undefined,
): string {
  const name = `[${pad(toolName, NAME_COL_WIDTH - 2)}]`
  const act = pad(action, ACTION_COL_WIDTH)
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : null
  const url = lookupUrl(input, sessionLookup)
  const host = shortenHost(url)
  const sessionPart =
    sessionId !== null ? `${shortenSessionId(sessionId)}${host !== '' ? ` → ${host}` : ''}` : ''
  return sessionPart === '' ? `${name} ${act}` : `${name} ${act} ${sessionPart}`
}

export function createComputerWatchMode(opts: CreateWatchModeOpts = {}): WatchModeRenderer {
  const output = opts.output ?? process.stderr
  // Default-detect TTY from the stream when not explicitly overridden. Streams
  // like process.stderr expose `isTTY: boolean | undefined`; piped streams
  // expose `undefined` which falses out.
  const isTTY = opts.isTTY ?? Boolean((output as { isTTY?: boolean }).isTTY)
  const sessionLookup = opts.sessionLookup

  let detached = false

  const writeLine = (line: string): void => {
    if (!isTTY || detached) return
    output.write(line + '\n')
  }

  return {
    handle(ev: QueryEvent): void {
      if (!isTTY || detached) return

      switch (ev.type) {
        case 'permission_decision': {
          if (!ev.toolName.startsWith('Computer')) return
          const meta = ev.safetyMetadata
          const levelTag = meta !== undefined ? ` L${meta.riskLevel}` : ''
          // The cascade emits exactly one permission_decision per tool call
          // with the FINAL outcome — `decision` is allow|deny. We embed the
          // risk level (when known) so a single line tells the user "this
          // was assessed as level N and the outcome was X."
          const action = `${ev.decision}${levelTag}`
          const userPart = ev.userResponse !== undefined ? ` (${ev.userResponse})` : ''
          // Prefer the structured metadata reason for the trailing fragment;
          // falls back to the cascade reason string.
          const tail =
            meta !== undefined
              ? ` ${ev.reason}${userPart}`
              : ` ${ev.reason}${userPart}`
          writeLine(renderHeader(ev.toolName, action, ev.input, sessionLookup) + tail)
          return
        }
        case 'tool_call_started': {
          if (!ev.toolName.startsWith('Computer')) return
          const summary = computerActionSummary(ev.toolName, ev.input) ?? ''
          const tail = summary !== '' ? ` ${summary}` : ''
          writeLine(renderHeader(ev.toolName, 'start', ev.input, sessionLookup) + tail)
          return
        }
        case 'tool_call_finished': {
          if (!ev.toolName.startsWith('Computer')) return
          // tool_call_finished doesn't carry input, so URL/session columns
          // are blank — the preceding `start` line already showed them.
          const name = `[${pad(ev.toolName, NAME_COL_WIDTH - 2)}]`
          const act = pad('finish', ACTION_COL_WIDTH)
          const tail = ` ${ev.outcome} (${ev.durationMs}ms)`
          writeLine(`${name} ${act}${tail}`)
          return
        }
        default:
          return
      }
    },
    detach(): void {
      detached = true
    },
  }
}
