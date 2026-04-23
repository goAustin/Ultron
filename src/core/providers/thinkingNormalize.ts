/**
 * Engine-boundary normalization for the generic `thinkingBudget` knob.
 *
 * Anthropic's SDK enforces `budget_tokens >= 1024` (per the SDK's
 * `ThinkingConfigEnabled` doc); a user passing `thinkingBudget: 1` would 4xx.
 * OpenAI's `reasoning_effort` accepts any positive number but tiny values
 * bucket meaninglessly. Normalize once here so adapters always receive
 * `undefined` or a valid number — they never re-validate.
 */

import type { CapabilitySheet } from './types.js'
import { warnOnce } from './warnOnce.js'

export const ANTHROPIC_THINKING_MIN = 1024

export function normalizeThinkingBudget(
  raw: number | undefined,
  modelId: string,
  capabilities: CapabilitySheet,
): number | undefined {
  if (raw === undefined || raw === 0) return undefined
  if (!Number.isFinite(raw) || raw < 0) {
    warnOnce(
      `normalize:${modelId}`,
      `thinkingBudget=${raw} is invalid; ignoring.`,
    )
    return undefined
  }
  if (!capabilities.supportsThinking) {
    // Adapter still warns at request time with provider-specific phrasing.
    return raw
  }
  // Currently-shipped Anthropic models all advertise promptCacheModel:'explicit'.
  // The simplest rule that catches the SDK floor is "round up to 1024 with a
  // one-time warn" for any explicit-thinking provider.
  if (
    raw < ANTHROPIC_THINKING_MIN &&
    capabilities.promptCacheModel === 'explicit'
  ) {
    warnOnce(
      `normalize:${modelId}`,
      `thinkingBudget=${raw} below Anthropic minimum (${ANTHROPIC_THINKING_MIN}); raising.`,
    )
    return ANTHROPIC_THINKING_MIN
  }
  return raw
}
