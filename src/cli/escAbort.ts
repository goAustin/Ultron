/**
 * ESC-to-abort listener for the interactive REPL.
 *
 * Installs a raw-mode `data` listener on stdin that fires `onEsc` when the
 * user presses bare ESC. Distinguishes bare ESC from arrow-key escape
 * sequences (`\x1B[A`, etc.) via a 50 ms debounce — the same constant used
 * by `src/ui/modelMenu.ts`.
 *
 * Returns a controller with `pause`, `resume`, and `detach`. Sub-prompts
 * that own raw mode for their own keyhandling (`promptForApproval`,
 * `promptForModel`) call `pause` on entry and `resume` on exit so their
 * setRawMode toggling does not leave us in cooked mode for the rest of
 * the agent run.
 *
 * Non-TTY stdin (piped / redirected) is a no-op: ESC is never delivered
 * as a single byte, raw mode is unsupported, and bare-ESC abort would
 * just confuse scripts.
 */

const ESC_DEBOUNCE_MS = 50

export type EscAbortController = {
  /** Detach the listener and release raw mode. Idempotent. */
  pause: () => void
  /** Re-attach the listener and re-enable raw mode. Idempotent. */
  resume: () => void
  /** Permanent teardown — restores prior raw-mode state. Idempotent. */
  detach: () => void
}

type RawStdin = NodeJS.ReadableStream & {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => unknown
}

export function installEscAbort(
  onEsc: () => void,
  io?: { stdin?: NodeJS.ReadableStream },
): EscAbortController {
  const stdin = (io?.stdin ?? process.stdin) as RawStdin
  const isTTY = stdin.isTTY === true
  const wasRaw = stdin.isRaw === true

  let attached = false
  let detached = false
  let escTimer: NodeJS.Timeout | null = null

  const fire = (): void => {
    escTimer = null
    onEsc()
  }

  const onData = (buf: Buffer): void => {
    if (escTimer) {
      clearTimeout(escTimer)
      escTimer = null
    }
    const k = buf.toString('utf8')
    if (k === '\x1B') {
      escTimer = setTimeout(fire, ESC_DEBOUNCE_MS)
    }
  }

  const attach = (): void => {
    if (attached || detached) return
    if (isTTY && stdin.setRawMode) {
      try { stdin.setRawMode(true) } catch { /* ignore */ }
    }
    stdin.on('data', onData)
    if (typeof stdin.resume === 'function') stdin.resume()
    attached = true
  }

  const detachListener = (): void => {
    if (!attached) return
    if (escTimer) {
      clearTimeout(escTimer)
      escTimer = null
    }
    stdin.off('data', onData)
    attached = false
  }

  attach()

  return {
    pause(): void {
      detachListener()
      if (isTTY && stdin.setRawMode) {
        try { stdin.setRawMode(wasRaw) } catch { /* ignore */ }
      }
    },
    resume(): void {
      if (detached) return
      attach()
    },
    detach(): void {
      if (detached) return
      detached = true
      detachListener()
      if (isTTY && stdin.setRawMode) {
        try { stdin.setRawMode(wasRaw) } catch { /* ignore */ }
      }
    },
  }
}
