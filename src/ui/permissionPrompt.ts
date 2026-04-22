/**
 * CLI approval prompt for tool permission requests.
 *
 * - formatApprovalPrompt() is pure (returns a string)
 * - promptForApproval() handles raw-mode terminal I/O with arrow-key selector
 * - TerminalIO is injectable for testability
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalAction = 'allow_once' | 'deny_once' | 'allow_by_rule' | 'abort'

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
 */
export function formatApprovalPrompt(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
): string {
  const lines: string[] = [
    '─── Permission Required ───',
    `Tool:   ${toolName}`,
  ]

  const inputDisplay = formatInputDisplay(toolName, input)
  if (inputDisplay) {
    lines.push(inputDisplay)
  }

  lines.push(`Reason: ${reason}`)

  return lines.join('\n')
}

function formatInputDisplay(toolName: string, input: Record<string, unknown>): string | null {
  if (FILE_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return `Path:   ${input.file_path}`
  }

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const cmd = truncate(input.command, MAX_INPUT_DISPLAY)
    return `Cmd:    ${cmd}`
  }

  if ((toolName === 'Grep' || toolName === 'Glob') && typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${input.path}` : ''
    return `Pattern: ${truncate(input.pattern + path, MAX_INPUT_DISPLAY)}`
  }

  // Generic fallback
  const json = JSON.stringify(input)
  if (json !== '{}') {
    return `Input:  ${truncate(json, MAX_INPUT_DISPLAY)}`
  }

  return null
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
 */
export function promptForApproval(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
  io?: TerminalIO,
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
      const header = formatApprovalPrompt(toolName, input, reason)
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
