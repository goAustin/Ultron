/**
 * Load-time guard: assert every registered `ModelEntry` has all capability
 * fields populated.
 *
 * Factored out of `registry.ts` so it can be unit-tested against hand-crafted
 * adapter fixtures without mutating the real `ADAPTERS` constant.
 */

import type { ProviderAdapter } from './types.js'

const REQUIRED_CAPABILITY_FIELDS = [
  'maxContextTokens',
  'maxOutputTokens',
  'supportsThinking',
  'supportsInterleavedThinking',
  'promptCacheModel',
] as const

export function assertCapabilitiesPopulated(
  adapters: readonly ProviderAdapter[],
): void {
  for (const a of adapters) {
    for (const m of a.models) {
      const missing = REQUIRED_CAPABILITY_FIELDS.filter(
        k => m[k] === undefined,
      )
      if (missing.length > 0) {
        throw new Error(
          `Adapter "${a.id}" model "${m.id}" is missing capability fields: ${missing.join(', ')}`,
        )
      }
    }
  }
}
