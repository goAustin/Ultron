import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Split `$EDITOR` (or `$VISUAL`) on whitespace into `[command, ...args]`.
 * Supports `code --wait`, `vim -n`, etc. Does NOT handle shell quoting —
 * for arguments that contain spaces, point `$EDITOR` at a wrapper script.
 */
function parseEditor(spec: string): readonly [string, readonly string[]] {
  const tokens = spec.trim().split(/\s+/).filter((t) => t.length > 0)
  const [cmd, ...args] = tokens
  return [cmd ?? 'vi', args]
}

export type EditInEditorOptions = {
  /** Override `$VISUAL` / `$EDITOR` resolution. Tests use this. */
  readonly editorSpec?: string
}

/**
 * Open a temp file prefilled with `initialText` in the user's editor and
 * wait for the editor to exit. Returns the saved contents on success, or
 * `null` when (a) the editor exited non-zero or (b) the file was unchanged
 * (treated as "user cancelled").
 *
 * The editor takes over the terminal via `stdio: 'inherit'`, so the caller
 * must close its readline before calling and recreate it afterwards — same
 * pattern as `src/ui/modelMenu.ts`.
 */
export async function editInEditor(
  initialText: string,
  suggestedExt = '.md',
  opts: EditInEditorOptions = {},
): Promise<string | null> {
  const spec = opts.editorSpec ?? process.env.VISUAL ?? process.env.EDITOR ?? 'vi'
  const [cmd, editorArgs] = parseEditor(spec)
  const dir = await mkdtemp(join(tmpdir(), 'ultron-memedit-'))
  const file = join(dir, `entry${suggestedExt}`)
  try {
    await writeFile(file, initialText, { encoding: 'utf8', mode: 0o600 })
    const code: number = await new Promise((resolve, reject) => {
      const child = spawn(cmd, [...editorArgs, file], { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (c) => resolve(c ?? 1))
    })
    if (code !== 0) return null
    const next = await readFile(file, 'utf8')
    return next === initialText ? null : next
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
