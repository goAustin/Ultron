/**
 * CLI approval prompt for tool permission requests.
 *
 * - formatApprovalPrompt() is pure (returns a string)
 * - promptForApproval() handles raw-mode terminal I/O with arrow-key selector
 * - TerminalIO is injectable for testability
 *
 * Phase 4·1 widened the signature with optional `opts.metadata` (Computer-Use
 * `SafetyMetadata`) and `opts.sessionLookup` (so the Computer branch can
 * render the current URL without parsing the reason string). Both are
 * optional — non-Computer call sites pass nothing and get the existing render.
 */

import type { SafetyMetadata } from '../core/permissions/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalAction = 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'

/**
 * Look up display information for a Computer-Use session id. Returned
 * synchronously because the prompt formatter is sync. Returns `null` when
 * the session has been closed or the id is unknown.
 */
export type SessionLookup = (
  sessionId: string,
) => { readonly url: string | null; readonly title: string | null } | null

export type FormatApprovalPromptOpts = {
  readonly metadata?: SafetyMetadata
  readonly sessionLookup?: SessionLookup
}

/** Injectable terminal I/O for testability. */
export type TerminalIO = {
  readonly input: NodeJS.ReadableStream
  readonly output: NodeJS.WritableStream
}

// ---------------------------------------------------------------------------
// Options for the selector
// ---------------------------------------------------------------------------

const OPTIONS: readonly { label: string; action: ApprovalAction }[] = [
  { label: 'Deny once', action: 'deny_once' },
  { label: 'Allow once', action: 'allow_once' },
  { label: 'Allow by rule', action: 'allow_by_rule' },
]

// ---------------------------------------------------------------------------
// Pure formatting
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(['FileRead', 'FileWrite', 'FileEdit'])
const MAX_INPUT_DISPLAY = 120

/**
 * Format the approval prompt header. Pure function — no I/O.
 * Does NOT include the selector options (those are rendered by promptForApproval).
 *
 * Phase 4·1: optional `opts.metadata` and `opts.sessionLookup` enable the
 * Computer-tool branch to render risk level + URL + nearby text without
 * parsing the reason string.
 */
export function formatApprovalPrompt(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  opts?: FormatApprovalPromptOpts,
): string {
  const lines: string[] = [
    '─── Permission Required ───',
    `Tool:    ${toolName}`,
  ]

  const inputDisplay = formatInputDisplay(toolName, input, opts)
  if (inputDisplay) {
    lines.push(inputDisplay)
  }

  // Computer-Use branch: render risk-level + nearby-text on dedicated lines
  // (the reason string is still appended below as the audit-trail line).
  if (toolName.startsWith('Computer') && opts?.metadata !== undefined) {
    const m = opts.metadata
    lines.push(`Risk:    level ${m.riskLevel} (${m.riskCategory})`)
    if (m.evidence?.nearbyText !== undefined) {
      lines.push(`Target:  «${truncate(m.evidence.nearbyText, MAX_INPUT_DISPLAY)}»`)
    }
    if (m.evidence?.fieldType !== undefined) {
      lines.push(`Field:   ${m.evidence.fieldType}`)
    }
  }

  lines.push(`Reason:  ${reason}`)

  return lines.join('\n')
}

function formatInputDisplay(
  toolName: string,
  input: Record<string, unknown>,
  opts?: FormatApprovalPromptOpts,
): string | null {
  if (FILE_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return `Path:    ${input.file_path}`
  }

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const cmd = truncate(input.command, MAX_INPUT_DISPLAY)
    return `Cmd:     ${cmd}`
  }

  if ((toolName === 'Grep' || toolName === 'Glob') && typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${input.path}` : ''
    return `Pattern: ${truncate(input.pattern + path, MAX_INPUT_DISPLAY)}`
  }

  // Phase 4·1 — Computer-Use branch
  if (toolName.startsWith('Computer') && typeof input.sessionId === 'string') {
    return formatComputerActionDisplay(toolName, input, opts?.sessionLookup)
  }

  // Generic fallback
  const json = JSON.stringify(input)
  if (json !== '{}') {
    return `Input:   ${truncate(json, MAX_INPUT_DISPLAY)}`
  }

  return null
}

function formatComputerActionDisplay(
  toolName: string,
  input: Record<string, unknown>,
  sessionLookup?: SessionLookup,
): string {
  const sessionId = input.sessionId as string
  const shortId = sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId
  const lookup = sessionLookup?.(sessionId) ?? null
  const sessionLine =
    lookup?.url !== null && lookup?.url !== undefined
      ? `Session: ${shortId} → ${lookup.url}`
      : `Session: ${shortId}`
  const actionSummary = computerActionSummary(toolName, input)
  return actionSummary !== null ? `${sessionLine}\nAction:  ${actionSummary}` : sessionLine
}

/**
 * One-line summary of a Computer-tool action, derived from its input. Shared
 * between the approval prompt (Phase 4·1) and the watch-mode renderer
 * (Phase 4·3) so both surfaces describe the same action identically.
 */
export function computerActionSummary(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'ComputerNavigate':
      return typeof input.url === 'string' ? `navigate(${truncate(input.url, MAX_INPUT_DISPLAY)})` : null
    case 'ComputerClick':
    case 'ComputerDoubleClick': {
      const verb = toolName === 'ComputerDoubleClick' ? 'double-click' : 'click'
      if (typeof input.x === 'number' && typeof input.y === 'number') {
        const button = typeof input.button === 'string' ? input.button : 'left'
        return `${verb}(${input.x.toFixed(2)}, ${input.y.toFixed(2)}) — ${button} button`
      }
      return verb
    }
    case 'ComputerType': {
      if (typeof input.text === 'string') {
        const txt =
          input.sensitive === true
            ? `<redacted ${input.text.length} chars>`
            : truncate(input.text, MAX_INPUT_DISPLAY)
        return `type(${txt})`
      }
      return 'type'
    }
    case 'ComputerKey':
      return typeof input.key === 'string' ? `key(${input.key})` : 'key'
    case 'ComputerScroll':
      return `scroll(dx=${input.deltaX ?? 0}, dy=${input.deltaY ?? 0})`
    case 'ComputerDrag':
      return typeof input.fromX === 'number' && typeof input.toX === 'number'
        ? `drag(${input.fromX}, ${input.fromY}) → (${input.toX}, ${input.toY})`
        : 'drag'
    case 'ComputerHandoffToUser':
      return typeof input.message === 'string' ? `handoff: ${truncate(input.message, MAX_INPUT_DISPLAY)}` : 'handoff'
    case 'ComputerStop':
      return 'stop session'
    case 'ComputerObserve':
      return 'observe (capture screenshot + ARIA)'
    case 'ComputerWait':
      return typeof input.ms === 'number' ? `wait(${input.ms}ms)` : 'wait'
    case 'ComputerStart':
      return typeof input.headless === 'boolean'
        ? `start session (headless: ${input.headless})`
        : 'start session'
    // Phase 4b — DOM-first action path. Renders without echoing locatorName;
    // ActAtom shows the input atomId + action.type only (no name). The
    // approval prompt + watch-mode share this formatter so both surfaces
    // stay redaction-safe.
    case 'ComputerObserveActions':
      return 'observe-actions (list interactive atoms)'
    case 'ComputerActAtom': {
      const atomId = typeof input.atomId === 'string' ? input.atomId : '?'
      const action = (input.action ?? {}) as { type?: string }
      const verb = action.type ?? '?'
      return `actAtom(${atomId} → ${verb})`
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Interactive prompt with arrow-key selector
// ---------------------------------------------------------------------------

/**
 * Show the approval prompt and let the user select an option.
 * Uses raw-mode terminal input with Up/Down arrows and Enter.
 * Default selection is "Deny once" (index 0 — safe default).
 *
 * @param io - Injectable terminal I/O. Defaults to process.stdin/stdout.
 * @param opts - Phase 4·1 — optional `metadata` (forwarded to
 *   `formatApprovalPrompt` for rich Computer rendering) and `sessionLookup`
 *   (so the Computer branch can show the current URL).
 */
export function promptForApproval(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
  io?: TerminalIO,
  opts?: FormatApprovalPromptOpts,
): Promise<ApprovalAction> {
  if (signal.aborted) return Promise.resolve('abort')

  const inputStream = (io?.input ?? process.stdin) as NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => void
    isTTY?: boolean
  }
  const outputStream = (io?.output ?? process.stdout) as NodeJS.WritableStream

  // On a real TTY, bytes that were buffered during a prior readline session
  // (most commonly the Enter the user pressed to submit the prompt) can be
  // flushed the instant we attach a 'data' listener. Drop anything that
  // arrives in this short window so a stale \r doesn't auto-confirm the
  // default "Deny once". Skipped for non-TTY streams (tests).
  const isTTY = inputStream.isTTY === true
  const STALE_INPUT_WINDOW_MS = 50
  const acceptKeysAt = isTTY ? Date.now() + STALE_INPUT_WINDOW_MS : 0

  return new Promise<ApprovalAction>((resolve) => {
    let selectedIndex = 0 // Default: Deny once
    let resolved = false

    // Keepalive: an unref'd stdin listener in some Node/TTY combinations
    // does not hold the event loop open. If stdin is the only live handle
    // and Node considers it idle, the process exits before the user can
    // respond. A no-op interval guarantees the loop stays alive until
    // cleanup runs.
    const keepalive = setInterval(() => { /* no-op */ }, 60_000)

    function cleanup() {
      if (resolved) return
      resolved = true
      clearInterval(keepalive)
      // Restore terminal state
      if (inputStream.setRawMode) {
        try { inputStream.setRawMode(false) } catch { /* ignore */ }
      }
      inputStream.removeListener('data', onKeypress)
      signal.removeEventListener('abort', onAbort)
    }

    function render() {
      // Clear previous selector lines and re-render
      const selectorLines = OPTIONS.map((opt, i) => {
        const marker = i === selectedIndex ? '>' : ' '
        return `  ${marker} ${opt.label}`
      })

      // Move cursor up to overwrite previous selector if re-rendering
      outputStream.write('\x1B[' + OPTIONS.length + 'A') // move up
      outputStream.write('\x1B[0J') // clear from cursor to end
      outputStream.write(selectorLines.join('\n') + '\n')
    }

    function initialRender() {
      const header = formatApprovalPrompt(toolName, input, reason, opts)
      outputStream.write('\n' + header + '\n\n')

      const selectorLines = OPTIONS.map((opt, i) => {
        const marker = i === selectedIndex ? '>' : ' '
        return `  ${marker} ${opt.label}`
      })
      outputStream.write(selectorLines.join('\n') + '\n')
    }

    function onAbort() {
      cleanup()
      resolve('abort')
    }

    function onKeypress(data: Buffer) {
      // Discard bytes that arrive before the stale-input window elapses —
      // these are almost always leftovers from the prior readline session.
      if (Date.now() < acceptKeysAt) return

      const key = data.toString()

      // Ctrl+C
      if (key === '\x03') {
        cleanup()
        resolve('abort')
        return
      }

      // Enter
      if (key === '\r' || key === '\n') {
        cleanup()
        resolve(OPTIONS[selectedIndex]!.action)
        return
      }

      // Arrow keys (escape sequences)
      if (key === '\x1B[A') {
        // Up
        if (selectedIndex > 0) {
          selectedIndex--
          render()
        }
        return
      }

      if (key === '\x1B[B') {
        // Down
        if (selectedIndex < OPTIONS.length - 1) {
          selectedIndex++
          render()
        }
        return
      }
    }

    signal.addEventListener('abort', onAbort, { once: true })

    // Enter raw mode if available (TTY)
    if (inputStream.setRawMode) {
      inputStream.setRawMode(true)
    }

    initialRender()

    inputStream.on('data', onKeypress)

    // Explicitly resume stdin — on some TTY/Node combinations, attaching
    // a 'data' listener alone isn't enough to put the stream back into
    // flowing mode after readline released it.
    if (typeof (inputStream as { resume?: () => void }).resume === 'function') {
      (inputStream as { resume: () => void }).resume()
    }
  })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 3) + '...'
}
