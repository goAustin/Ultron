import { describe, it, expect } from 'vitest'

import {
  CONTEXT_WINDOW_TOKENS,
  RESERVED_OUTPUT_TOKENS,
  COMPACT_THRESHOLD_RATIO,
  getEffectiveContextWindow,
  getCompactThreshold,
  shouldCompact,
} from './tokenBudget.js'

describe('tokenBudget', () => {
  it('getEffectiveContextWindow = CONTEXT_WINDOW - RESERVED_OUTPUT', () => {
    expect(getEffectiveContextWindow()).toBe(
      CONTEXT_WINDOW_TOKENS - RESERVED_OUTPUT_TOKENS,
    )
  })

  it('getCompactThreshold = effective * ratio', () => {
    const expected = Math.floor(getEffectiveContextWindow() * COMPACT_THRESHOLD_RATIO)
    expect(getCompactThreshold()).toBe(expected)
  })

  it('shouldCompact returns true above threshold', () => {
    expect(shouldCompact(getCompactThreshold() + 1)).toBe(true)
  })

  it('shouldCompact returns false below threshold', () => {
    expect(shouldCompact(getCompactThreshold() - 1)).toBe(false)
  })

  it('shouldCompact returns true exactly at threshold', () => {
    expect(shouldCompact(getCompactThreshold())).toBe(true)
  })
})
