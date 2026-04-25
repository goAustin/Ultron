/**
 * streamToolUse — callback→yield bridge for side-channel tool progress.
 *
 * Phase 3d: tools (today, MCP) may invoke `ctx.onProgress(...)` mid-call.
 * `executeToolUse` still returns a single `Promise<ToolResult>`, so the query
 * loop wraps each call in this generator. Every `onProgress(...)` call becomes
 * one `ToolProgressEvent` yielded into the QueryEvent stream; the awaited
 * `ToolResult` becomes the generator's return value.
 *
 * Progress is observability, not transcript: events flow only on the
 * QueryEvent stream and are never inserted into the message array, so
 * `normalizeMessages`, compaction, and on-disk persistence never see them.
 */

import type { ToolUseBlock } from '../messages.js'
import type { ToolResult } from './types.js'
import type { ToolProgressInput } from './context.js'
import type { ExecuteToolUseFn } from '../queryDeps.js'
import type { ToolProgressEvent } from '../queryEvents.js'
import { makeToolProgressEvent } from '../queryEventFactories.js'

const PROGRESS_QUEUE_CAP = 1000

type Item =
  | { kind: 'progress'; event: ToolProgressEvent }
  | { kind: 'done'; result: ToolResult }
  | { kind: 'error'; error: unknown }

export async function* streamToolUse(
  toolUse: ToolUseBlock,
  signal: AbortSignal,
  executeToolUse: ExecuteToolUseFn,
): AsyncGenerator<ToolProgressEvent, ToolResult> {
  const queue: Item[] = []
  let waker: (() => void) | null = null
  const wake = (): void => {
    const w = waker
    waker = null
    if (w) w()
  }

  let dropped = 0

  const onProgress = (p: ToolProgressInput): void => {
    if (queue.length >= PROGRESS_QUEUE_CAP) {
      if (dropped === 0) {
        process.stderr.write(
          `[mcp] progress queue overflow on ${toolUse.id}; dropping further events\n`,
        )
        queue.push({
          kind: 'progress',
          event: makeToolProgressEvent({
            toolUseId: toolUse.id,
            progress: 0,
            total: null,
            message: 'progress queue overflow; further events dropped',
          }),
        })
        wake()
      }
      dropped++
      return
    }
    queue.push({
      kind: 'progress',
      event: makeToolProgressEvent({
        toolUseId: toolUse.id,
        progress: p.progress,
        total: p.total ?? null,
        message: p.message ?? null,
      }),
    })
    wake()
  }

  executeToolUse(toolUse, signal, onProgress).then(
    (result) => {
      queue.push({ kind: 'done', result })
      wake()
    },
    (error) => {
      queue.push({ kind: 'error', error })
      wake()
    },
  )

  while (true) {
    while (queue.length === 0) {
      await new Promise<void>((resolve) => {
        waker = resolve
      })
    }
    const item = queue.shift()!
    if (item.kind === 'progress') {
      yield item.event
    } else if (item.kind === 'done') {
      return item.result
    } else {
      throw item.error
    }
  }
}
