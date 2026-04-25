import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export type ConfirmYesNoOptions = {
  /** When true (default), pressing Enter means "no"; otherwise "yes". */
  readonly defaultNo?: boolean
  /** Override stdin for tests. Defaults to `process.stdin`. */
  readonly input?: NodeJS.ReadableStream | Readable
  /** Override stdout for tests. Defaults to `process.stdout`. */
  readonly output?: NodeJS.WritableStream | Writable
}

/**
 * One-shot yes/no prompt. The caller must close any enclosing readline
 * before calling and recreate it afterwards — this helper owns stdin
 * briefly via its own `createInterface` call.
 */
export async function confirmYesNo(
  question: string,
  opts: ConfirmYesNoOptions = {},
): Promise<boolean> {
  const defaultNo = opts.defaultNo ?? true
  const rl = createInterface({
    input: (opts.input as NodeJS.ReadableStream) ?? process.stdin,
    output: (opts.output as NodeJS.WritableStream) ?? process.stdout,
  })
  const hint = defaultNo ? '[y/N]' : '[Y/n]'
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${question} ${hint} `, resolve)
  })
  rl.close()
  const trimmed = answer.trim().toLowerCase()
  if (trimmed === '') return !defaultNo
  return trimmed === 'y' || trimmed === 'yes'
}
