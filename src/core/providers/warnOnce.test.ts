import { describe, it, expect, beforeEach, vi } from 'vitest'
import { warnOnce, __resetWarnOnceForTesting } from './warnOnce.js'

// vi.spyOn(process.stderr, 'write') — keep the spy loosely typed; the SDK's
// MockInstance generic doesn't accept the method overload shape directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any

describe('warnOnce', () => {
  beforeEach(() => {
    __resetWarnOnceForTesting()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('emits one stderr line for a fresh key', () => {
    warnOnce('thinking:opus', 'budget unsupported')
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0]![0]).toBe('[ultron] budget unsupported\n')
  })

  it('suppresses repeat calls with the same key', () => {
    warnOnce('thinking:opus', 'first')
    warnOnce('thinking:opus', 'second')
    warnOnce('thinking:opus', 'third')
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('treats different keys independently', () => {
    warnOnce('thinking:opus', 'a')
    warnOnce('interleaved:opus', 'b')
    warnOnce('thinking:haiku', 'c')
    expect(stderrSpy).toHaveBeenCalledTimes(3)
  })

  it('reset hook re-arms a previously-warned key', () => {
    warnOnce('thinking:opus', 'first')
    __resetWarnOnceForTesting()
    warnOnce('thinking:opus', 'second')
    expect(stderrSpy).toHaveBeenCalledTimes(2)
  })
})
