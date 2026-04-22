/**
 * Interactive model selector — arrow keys + Enter to confirm, Esc to cancel.
 *
 * Shows every model from every registered provider in one grouped list
 * (Cursor-style). Group headers are non-selectable; arrow navigation skips them.
 *
 * Raw-mode handoff mirrors permissionPrompt.ts: stale-input window, keepalive
 * interval, explicit stdin resume. A short debounce on bare Esc disambiguates
 * it from arrow-key escape sequences that arrive byte-split.
 */

import { allModels, listProviders } from '../core/providers/registry.js'
import type { ModelEntry, ProviderId } from '../core/providers/types.js'

export type TerminalIO = {
  readonly input: NodeJS.ReadableStream
  readonly output: NodeJS.WritableStream
}

const STALE_INPUT_WINDOW_MS = 50
const ESC_DEBOUNCE_MS = 50

export function formatModelMenuHeader(): string {
  return `─── Select model ───  ↑/↓ navigate · Enter confirm · Esc cancel`
}

/** One visual row in the menu: either a dim provider group header or a selectable model. */
type Row =
  | { kind: 'header'; providerDisplayName: string }
  | { kind: 'model'; entry: ModelEntry }

function buildRows(): Row[] {
  const rows: Row[] = []
  const groups = new Map<ProviderId, { displayName: string; models: ModelEntry[] }>()

  for (const adapter of listProviders()) {
    groups.set(adapter.id, { displayName: adapter.displayName, models: [] })
  }
  for (const entry of allModels()) {
    const g = groups.get(entry.provider)
    if (g) g.models.push(entry)
  }

  for (const group of groups.values()) {
    if (group.models.length === 0) continue
    rows.push({ kind: 'header', providerDisplayName: group.displayName })
    for (const entry of group.models) rows.push({ kind: 'model', entry })
  }
  return rows
}

/** Returns indices (into `rows`) of every selectable (model) row, in order. */
function selectableIndices(rows: readonly Row[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => { if (r.kind === 'model') out.push(i) })
  return out
}

/**
 * Show the model submenu. Resolves to the chosen model id, or null if the
 * user pressed Esc / Ctrl+C. Defaults the cursor to `currentModel` if present
 * so Enter-on-open is a no-op confirmation of the active model.
 */
export function promptForModel(
  currentModel: string,
  io?: TerminalIO,
): Promise<string | null> {
  const rows = buildRows()
  const selectable = selectableIndices(rows)

  const inputStream = (io?.input ?? process.stdin) as NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => void
    isTTY?: boolean
  }
  const outputStream = (io?.output ?? process.stdout) as NodeJS.WritableStream

  const isTTY = inputStream.isTTY === true
  const acceptKeysAt = isTTY ? Date.now() + STALE_INPUT_WINDOW_MS : 0

  return new Promise<string | null>((resolve) => {
    if (selectable.length === 0) {
      resolve(null)
      return
    }

    // Cursor indexes into `selectable`, not `rows`.
    const initialCursor = selectable.findIndex(i => {
      const row = rows[i]
      return row?.kind === 'model' && row.entry.id === currentModel
    })
    let cursor = Math.max(0, initialCursor)

    let resolved = false
    let escTimer: NodeJS.Timeout | null = null

    const keepalive = setInterval(() => { /* no-op */ }, 60_000)

    function cleanup() {
      if (resolved) return
      resolved = true
      if (escTimer) {
        clearTimeout(escTimer)
        escTimer = null
      }
      clearInterval(keepalive)
      if (inputStream.setRawMode) {
        try { inputStream.setRawMode(false) } catch { /* ignore */ }
      }
      inputStream.removeListener('data', onKeypress)
    }

    function renderRows(): string[] {
      const cursorRowIdx = selectable[cursor]
      return rows.map((row, i) => {
        if (row.kind === 'header') {
          // Dim header, non-selectable
          return `  \x1B[2m${row.providerDisplayName}\x1B[0m`
        }
        const marker = i === cursorRowIdx ? '>' : ' '
        const current = row.entry.id === currentModel ? ' (current)' : ''
        const desc = row.entry.description ? ` — ${row.entry.description}` : ''
        return `    ${marker} ${row.entry.label}${current}${desc}`
      })
    }

    function initialRender() {
      outputStream.write('\n' + formatModelMenuHeader() + '\n\n')
      outputStream.write(renderRows().join('\n') + '\n')
    }

    function render() {
      outputStream.write('\x1B[' + rows.length + 'A')
      outputStream.write('\x1B[0J')
      outputStream.write(renderRows().join('\n') + '\n')
    }

    function confirmSelection() {
      const rowIdx = selectable[cursor]!
      const row = rows[rowIdx]!
      if (row.kind !== 'model') {
        cleanup()
        resolve(null)
        return
      }
      cleanup()
      resolve(row.entry.id)
    }

    function cancel() {
      cleanup()
      resolve(null)
    }

    function onKeypress(data: Buffer) {
      if (Date.now() < acceptKeysAt) return

      if (escTimer) {
        clearTimeout(escTimer)
        escTimer = null
      }

      const key = data.toString()

      if (key === '\x03') { cancel(); return }              // Ctrl+C
      if (key === '\r' || key === '\n') { confirmSelection(); return }

      if (key === '\x1B[A') {
        if (cursor > 0) { cursor--; render() }
        return
      }
      if (key === '\x1B[B') {
        if (cursor < selectable.length - 1) { cursor++; render() }
        return
      }

      if (key === '\x1B') {
        escTimer = setTimeout(cancel, ESC_DEBOUNCE_MS)
        return
      }
    }

    if (inputStream.setRawMode) inputStream.setRawMode(true)

    initialRender()

    inputStream.on('data', onKeypress)

    if (typeof (inputStream as { resume?: () => void }).resume === 'function') {
      (inputStream as { resume: () => void }).resume()
    }
  })
}
