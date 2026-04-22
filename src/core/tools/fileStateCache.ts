/**
 * Named operations on ReadFileState for stale-edit detection.
 *
 * FileReadTool calls markRead() after every read.
 * FileWriteTool and FileEditTool call hasBeenRead()/getReadState() to
 * enforce prior-read requirements and detect stale overwrites.
 *
 * All paths must be absolute. Callers are responsible for resolving.
 */

import type { ReadFileState } from './context.js'

export function markRead(
  state: ReadFileState,
  filePath: string,
  content: string,
  mtime: number,
): void {
  state.set(filePath, { content, mtime })
}

export function hasBeenRead(state: ReadFileState, filePath: string): boolean {
  return state.has(filePath)
}

export function getReadState(
  state: ReadFileState,
  filePath: string,
): { content: string; mtime: number } | undefined {
  return state.get(filePath)
}
