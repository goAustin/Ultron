import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export type PromptTextOptions = {
  /** Override stdin for tests. Defaults to process.stdin. */
  readonly input?: NodeJS.ReadableStream | Readable
  /** Override stdout for tests. Defaults to process.stdout. */
  readonly output?: NodeJS.WritableStream | Writable
  /**
   * When true, characters typed at the prompt are not echoed (suitable
   * for API keys / passwords). The returned string is still the typed
   * value; only the terminal display is suppressed. Implemented via a
   * muted writable wrapper around `output`, so callers don't need raw-
   * mode handling. No-op when output is not a TTY (tests).
   */
  readonly mask?: boolean
}

/**
 * One-shot free-text prompt. The caller must close any enclosing readline
 * before calling and recreate it afterwards — this helper owns stdin
 * briefly via its own createInterface call.
 *
 * Returns the line as typed (no trim — caller decides). The trailing
 * newline is consumed by readline.
 */
export async function promptText(
  question: string,
  opts: PromptTextOptions = {},
): Promise<string> {
  const baseInput = (opts.input as NodeJS.ReadableStream) ?? process.stdin
  const baseOutput = (opts.output as NodeJS.WritableStream) ?? process.stdout

  if (opts.mask) {
    // Write the question first, then mute the output so the typed key
    // does not appear on screen. The user sees the prompt and an empty
    // line; pressing Enter still ends the read.
    baseOutput.write(question)
    const muted = new MutedWritable(baseOutput)
    const rl = createInterface({ input: baseInput, output: muted, terminal: true })
    const answer = await new Promise<string>((resolve) => {
      rl.question('', resolve)
    })
    rl.close()
    baseOutput.write('\n')
    return answer
  }

  const rl = createInterface({ input: baseInput, output: baseOutput })
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve)
  })
  rl.close()
  return answer
}

import { Writable as NodeWritable } from 'node:stream'

class MutedWritable extends NodeWritable {
  constructor(private readonly inner: NodeJS.WritableStream) {
    super()
  }
  override _write(_chunk: Buffer, _enc: string, cb: () => void) {
    // Drop all writes (including readline's character echo) so typed
    // characters never reach the terminal. Newline at end is provided
    // by the caller after the prompt resolves.
    cb()
  }
  // readline checks for `columns` to format prompts; pass-through.
  get columns(): number | undefined {
    return (this.inner as { columns?: number }).columns
  }
}
