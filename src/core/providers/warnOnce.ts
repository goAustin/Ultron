/**
 * Per-process deduplicated warning sink.
 *
 * Used by adapters and the engine to surface "you set X but the model can't do
 * X" without spamming stderr on every submission. Each unique `key` emits at
 * most one line per process lifetime.
 *
 * Key shape convention:
 *   - `thinking:<modelId>`     — thinking budget on a non-thinking model
 *   - `interleaved:<modelId>`  — interleaved-thinking on a model without it
 *   - `normalize:<modelId>`    — input normalization adjusted/dropped a value
 */

const warned = new Set<string>()

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  process.stderr.write(`[ultron] ${message}\n`)
}

/** Test-only: clear the dedup set so warning tests aren't order-dependent. */
export function __resetWarnOnceForTesting(): void {
  warned.clear()
}
