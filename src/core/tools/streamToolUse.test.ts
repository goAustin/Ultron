import { describe, it, expect } from 'vitest'
import { streamToolUse } from './streamToolUse.js'
import type { ExecuteToolUseFn } from '../queryDeps.js'
import type { ToolProgressInput } from './context.js'
import type { ToolResult } from './types.js'
import type { ToolProgressEvent } from '../queryEvents.js'
import type { ToolUseBlock } from '../messages.js'
import { toolUseId } from '../messages.js'

const TU: ToolUseBlock = {
  type: 'tool_use',
  id: toolUseId('tu-stream-1'),
  name: 'Demo',
  input: {},
}

const OK: ToolResult = { content: 'final', isError: false }

function makeSignal(aborted = false): AbortSignal {
  const ac = new AbortController()
  if (aborted) ac.abort()
  return ac.signal
}

async function collect(
  gen: AsyncGenerator<ToolProgressEvent, ToolResult>,
): Promise<{ events: ToolProgressEvent[]; result: ToolResult }> {
  const events: ToolProgressEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, result: next.value }
}

describe('streamToolUse', () => {
  it('returns the awaited ToolResult when no progress is emitted', async () => {
    const exec: ExecuteToolUseFn = async () => OK
    const { events, result } = await collect(streamToolUse(TU, makeSignal(), exec))
    expect(events).toEqual([])
    expect(result).toBe(OK)
  })

  it('yields one tool_progress event per onProgress call, in order', async () => {
    const exec: ExecuteToolUseFn = async (_tu, _signal, onProgress) => {
      onProgress?.({ progress: 1, total: 3, message: 'step 1' })
      onProgress?.({ progress: 2, total: 3, message: 'step 2' })
      onProgress?.({ progress: 3, total: 3, message: 'step 3' })
      return OK
    }
    const { events, result } = await collect(streamToolUse(TU, makeSignal(), exec))
    expect(events.length).toBe(3)
    expect(events.map((e) => e.progress)).toEqual([1, 2, 3])
    expect(events.map((e) => e.message)).toEqual(['step 1', 'step 2', 'step 3'])
    expect(events.every((e) => e.toolUseId === TU.id && e.type === 'tool_progress')).toBe(true)
    expect(events.every((e) => e.total === 3)).toBe(true)
    expect(result).toBe(OK)
  })

  it('normalizes missing total/message to null', async () => {
    const exec: ExecuteToolUseFn = async (_tu, _signal, onProgress) => {
      onProgress?.({ progress: 7 })
      return OK
    }
    const { events } = await collect(streamToolUse(TU, makeSignal(), exec))
    expect(events.length).toBe(1)
    expect(events[0].progress).toBe(7)
    expect(events[0].total).toBe(null)
    expect(events[0].message).toBe(null)
  })

  it('rethrows when executeToolUse rejects', async () => {
    const boom = new Error('exec blew up')
    const exec: ExecuteToolUseFn = async () => {
      throw boom
    }
    const gen = streamToolUse(TU, makeSignal(), exec)
    await expect(gen.next()).rejects.toBe(boom)
  })

  it('still yields any progress emitted before rejection', async () => {
    const boom = new Error('exec blew up')
    const exec: ExecuteToolUseFn = async (_tu, _signal, onProgress) => {
      onProgress?.({ progress: 1, message: 'before crash' })
      throw boom
    }
    const gen = streamToolUse(TU, makeSignal(), exec)
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect((first.value as ToolProgressEvent).progress).toBe(1)
    await expect(gen.next()).rejects.toBe(boom)
  })

  it('interleaves progress emitted asynchronously with completion', async () => {
    let emit: ((p: ToolProgressInput) => void) | null = null
    const exec: ExecuteToolUseFn = (_tu, _signal, onProgress) =>
      new Promise<ToolResult>((resolve) => {
        emit = onProgress!
        // Emit progress on a microtask, then resolve on a later macrotask.
        queueMicrotask(() => {
          emit!({ progress: 1 })
          emit!({ progress: 2 })
          setTimeout(() => resolve(OK), 5)
        })
      })

    const { events, result } = await collect(streamToolUse(TU, makeSignal(), exec))
    expect(events.map((e) => e.progress)).toEqual([1, 2])
    expect(result).toBe(OK)
  })

  it('caps the queue at 1000 events and emits a single overflow sentinel', async () => {
    const exec: ExecuteToolUseFn = async (_tu, _signal, onProgress) => {
      // 1000 events fill the queue; the 1001st triggers the sentinel; the
      // 1002nd is silently dropped.
      for (let i = 0; i < 1002; i++) {
        onProgress?.({ progress: i })
      }
      return OK
    }
    const { events, result } = await collect(streamToolUse(TU, makeSignal(), exec))
    // Up to 1000 normal events + 1 sentinel = 1001 total.
    expect(events.length).toBe(1001)
    expect(events[1000].message).toContain('overflow')
    expect(result).toBe(OK)
  })

  it('produces no events for a no-op tool', async () => {
    const exec: ExecuteToolUseFn = async () => ({ content: 'silent', isError: false })
    const { events } = await collect(streamToolUse(TU, makeSignal(), exec))
    expect(events).toEqual([])
  })
})
