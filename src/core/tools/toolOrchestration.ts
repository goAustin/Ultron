/**
 * Batch tool orchestration with concurrency support.
 *
 * Status: infrastructure, not yet wired into query.ts.
 * query.ts currently iterates tools serially via createRunToolFn().
 * This module will be wired in when query.ts adopts batch execution.
 */

import type { ToolUseBlock } from '../messages.js'
import type { ToolResult } from './types.js'
import type { ToolUseContext } from './context.js'
import type { ToolRegistry } from './registry.js'
import type { ToolResultPair } from './toolExecution.js'
import type { PermissionOptions } from '../permissions/types.js'
import { makeAbortResult, checkAbort } from './toolExecution.js'
import { runToolUse } from './runToolUse.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_CONCURRENCY = 10

// ---------------------------------------------------------------------------
// Batch type
// ---------------------------------------------------------------------------

export type Batch = {
  concurrent: boolean
  toolUses: ToolUseBlock[]
}

// ---------------------------------------------------------------------------
// Partitioning
// ---------------------------------------------------------------------------

/**
 * Groups consecutive concurrency-safe tools into concurrent batches.
 * Non-safe tools get isolated single-element serial batches.
 * Tools with no isConcurrencySafe method are treated as unsafe.
 */
export function partitionIntoBatches(
  toolUses: readonly ToolUseBlock[],
  registry: ToolRegistry,
): Batch[] {
  const batches: Batch[] = []

  for (const toolUse of toolUses) {
    const tool = registry.get(toolUse.name)
    const safe = tool?.isConcurrencySafe?.(toolUse.input) === true

    if (safe) {
      // Append to current concurrent batch or start a new one
      const last = batches[batches.length - 1]
      if (last && last.concurrent) {
        last.toolUses.push(toolUse)
      } else {
        batches.push({ concurrent: true, toolUses: [toolUse] })
      }
    } else {
      batches.push({ concurrent: false, toolUses: [toolUse] })
    }
  }

  return batches
}

// ---------------------------------------------------------------------------
// Batch execution
// ---------------------------------------------------------------------------

export async function runToolBatch(
  toolUses: readonly ToolUseBlock[],
  context: ToolUseContext,
  signal: AbortSignal,
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
  permissionOpts?: PermissionOptions,
): Promise<ToolResultPair[]> {
  const batches = partitionIntoBatches(toolUses, context.toolRegistry)
  const results: ToolResultPair[] = []

  for (const batch of batches) {
    // Check abort between batches
    const aborted = checkAbort(signal)
    if (aborted) {
      // All remaining tools in this and subsequent batches get abort results
      for (const remaining of batch.toolUses) {
        results.push({ toolUseId: remaining.id, result: makeAbortResult() })
      }
      // Fill remaining batches
      const batchIdx = batches.indexOf(batch)
      for (let i = batchIdx + 1; i < batches.length; i++) {
        for (const remaining of batches[i].toolUses) {
          results.push({ toolUseId: remaining.id, result: makeAbortResult() })
        }
      }
      break
    }

    if (batch.concurrent && batch.toolUses.length > 1) {
      const batchResults = await runConcurrent(batch.toolUses, context, signal, maxConcurrency, permissionOpts)
      results.push(...batchResults)
    } else {
      // Serial: one tool at a time
      for (const toolUse of batch.toolUses) {
        const abortCheck = checkAbort(signal)
        if (abortCheck) {
          results.push({ toolUseId: toolUse.id, result: makeAbortResult() })
          continue
        }
        const result = await runToolUse(toolUse, context, signal, permissionOpts)
        results.push({ toolUseId: toolUse.id, result })
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Concurrent execution with concurrency limit
// ---------------------------------------------------------------------------

async function runConcurrent(
  toolUses: ToolUseBlock[],
  context: ToolUseContext,
  signal: AbortSignal,
  maxConcurrency: number,
  permissionOpts?: PermissionOptions,
): Promise<ToolResultPair[]> {
  const tasks = toolUses.map(
    (toolUse) => () => runToolUse(toolUse, context, signal, permissionOpts),
  )

  const settled = await runWithConcurrencyLimit(tasks, maxConcurrency)

  return toolUses.map((toolUse, i) => {
    const s = settled[i]
    const result: ToolResult =
      s.status === 'fulfilled'
        ? s.value
        : makeAbortResult() // rejected promises shouldn't happen (runToolUse catches), but defensive
    return { toolUseId: toolUse.id, result }
  })
}

// ---------------------------------------------------------------------------
// Semaphore-based concurrency limiter
// ---------------------------------------------------------------------------

export async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      try {
        const value = await tasks[idx]()
        results[idx] = { status: 'fulfilled', value }
      } catch (reason) {
        results[idx] = { status: 'rejected', reason }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => worker(),
  )
  await Promise.all(workers)

  return results
}
