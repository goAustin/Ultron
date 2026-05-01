import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PassThrough } from 'node:stream'

import { installEscAbort } from './escAbort.js'

type FakeStdin = PassThrough & {
  isTTY: boolean
  isRaw: boolean
  setRawMode: (mode: boolean) => FakeStdin
  rawModeCalls: boolean[]
}

function fakeStdin(opts?: { isTTY?: boolean; initialRaw?: boolean }): FakeStdin {
  const stream = new PassThrough() as FakeStdin
  stream.isTTY = opts?.isTTY ?? true
  stream.isRaw = opts?.initialRaw ?? false
  stream.rawModeCalls = []
  stream.setRawMode = (mode: boolean) => {
    stream.rawModeCalls.push(mode)
    stream.isRaw = mode
    return stream
  }
  return stream
}

describe('installEscAbort', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onEsc after debounce on bare ESC', () => {
    const stdin = fakeStdin()
    const onEsc = vi.fn()
    const ctrl = installEscAbort(onEsc, { stdin })

    stdin.write(Buffer.from('\x1B'))
    expect(onEsc).not.toHaveBeenCalled()

    vi.advanceTimersByTime(50)
    expect(onEsc).toHaveBeenCalledTimes(1)

    ctrl.detach()
  })

  it('does not fire on arrow-key escape sequences', () => {
    const stdin = fakeStdin()
    const onEsc = vi.fn()
    const ctrl = installEscAbort(onEsc, { stdin })

    stdin.write(Buffer.from('\x1B[A'))
    vi.advanceTimersByTime(100)
    expect(onEsc).not.toHaveBeenCalled()

    stdin.write(Buffer.from('\x1B[B'))
    vi.advanceTimersByTime(100)
    expect(onEsc).not.toHaveBeenCalled()

    ctrl.detach()
  })

  it('does not fire on arrow-key sequences delivered as a single byte then bracket', () => {
    // Some terminals deliver the sequence byte-split; ensure the trailing
    // bytes cancel the pending fire before the debounce expires.
    const stdin = fakeStdin()
    const onEsc = vi.fn()
    const ctrl = installEscAbort(onEsc, { stdin })

    stdin.write(Buffer.from('\x1B'))
    vi.advanceTimersByTime(20)
    stdin.write(Buffer.from('[A'))
    vi.advanceTimersByTime(100)
    expect(onEsc).not.toHaveBeenCalled()

    ctrl.detach()
  })

  it('enables raw mode on install and restores prior state on detach', () => {
    const stdin = fakeStdin({ initialRaw: false })
    const ctrl = installEscAbort(() => {}, { stdin })

    expect(stdin.rawModeCalls).toEqual([true])
    expect(stdin.isRaw).toBe(true)

    ctrl.detach()
    expect(stdin.rawModeCalls).toEqual([true, false])
    expect(stdin.isRaw).toBe(false)
  })

  it('preserves prior raw=true state on detach', () => {
    const stdin = fakeStdin({ initialRaw: true })
    const ctrl = installEscAbort(() => {}, { stdin })

    ctrl.detach()
    // Last setRawMode call should be `true` (the original state)
    expect(stdin.rawModeCalls.at(-1)).toBe(true)
  })

  it('pause removes the data listener', () => {
    const stdin = fakeStdin()
    const ctrl = installEscAbort(() => {}, { stdin })

    expect(stdin.listenerCount('data')).toBe(1)
    ctrl.pause()
    expect(stdin.listenerCount('data')).toBe(0)

    ctrl.detach()
  })

  it('resume re-attaches the listener and fires onEsc on subsequent ESC', () => {
    const stdin = fakeStdin()
    const onEsc = vi.fn()
    const ctrl = installEscAbort(onEsc, { stdin })

    ctrl.pause()
    expect(stdin.listenerCount('data')).toBe(0)
    ctrl.resume()
    expect(stdin.listenerCount('data')).toBe(1)

    stdin.write(Buffer.from('\x1B'))
    vi.advanceTimersByTime(50)
    expect(onEsc).toHaveBeenCalledTimes(1)

    ctrl.detach()
  })

  it('resume re-enables raw mode after a sub-prompt turned it off', () => {
    const stdin = fakeStdin({ initialRaw: false })
    const ctrl = installEscAbort(() => {}, { stdin })

    // Simulate a sub-prompt: pause, then it toggles raw mode itself,
    // and on its cleanup leaves raw=false.
    ctrl.pause()
    stdin.setRawMode(true)
    stdin.setRawMode(false)
    expect(stdin.isRaw).toBe(false)

    ctrl.resume()
    expect(stdin.isRaw).toBe(true)

    ctrl.detach()
  })

  it('detach is idempotent', () => {
    const stdin = fakeStdin()
    const ctrl = installEscAbort(() => {}, { stdin })
    ctrl.detach()
    const callsBefore = stdin.rawModeCalls.length
    ctrl.detach()
    expect(stdin.rawModeCalls.length).toBe(callsBefore)
  })

  it('resume after detach is a no-op', () => {
    const stdin = fakeStdin()
    const onEsc = vi.fn()
    const ctrl = installEscAbort(onEsc, { stdin })
    ctrl.detach()
    ctrl.resume()

    stdin.write(Buffer.from('\x1B'))
    vi.advanceTimersByTime(100)
    expect(onEsc).not.toHaveBeenCalled()
  })

  it('skips raw-mode toggling on non-TTY stdin', () => {
    const stdin = fakeStdin({ isTTY: false })
    const ctrl = installEscAbort(() => {}, { stdin })
    expect(stdin.rawModeCalls).toEqual([])
    ctrl.detach()
    expect(stdin.rawModeCalls).toEqual([])
  })

  it('fires only once when multiple ESC bytes arrive in succession', () => {
    const stdin = fakeStdin()
    const onEsc = vi.fn()
    const ctrl = installEscAbort(onEsc, { stdin })

    stdin.write(Buffer.from('\x1B'))
    vi.advanceTimersByTime(20)
    // Second ESC arrives before debounce of first fires — second should
    // re-arm the timer, replacing the first. Net effect: one fire.
    stdin.write(Buffer.from('\x1B'))
    vi.advanceTimersByTime(50)
    expect(onEsc).toHaveBeenCalledTimes(1)

    ctrl.detach()
  })
})
