/**
 * Session lifecycle — create, resume, and list sessions.
 *
 * Sessions are stored under ~/.ultron/sessions/<uuid>/.
 * Each session has a transcript.jsonl file managed by transcript.ts.
 * Sessions are only visible to listSessions() after the first message
 * is persisted (directory created lazily by appendMessage).
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'

import type { Message } from '../core/messages.js'
import { readTranscript } from './transcript.js'
import { checkTranscriptSize } from '../memory/localMemoryGuard.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionInfo = {
  readonly id: string
  readonly dir: string
  readonly createdAt: number
  readonly messageCount: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSIONS_BASE_DIR = join(homedir(), '.ultron', 'sessions')

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new session with a UUID.
 * Does NOT create the directory — that happens on first appendMessage().
 * The session is not visible to listSessions() until a message is persisted.
 */
export function createSession(): SessionInfo {
  const id = randomUUID()
  return {
    id,
    dir: join(SESSIONS_BASE_DIR, id),
    createdAt: Date.now(),
    messageCount: 0,
  }
}

/**
 * Resume a session by loading its transcript.
 * Returns messages from the last compact boundary forward (inclusive).
 * If no compact boundary exists, all messages are returned.
 * Throws if the session has no transcript.
 */
export async function resumeSession(
  sessionId: string,
): Promise<{ info: SessionInfo; messages: Message[] }> {
  const dir = join(SESSIONS_BASE_DIR, sessionId)

  // Pre-read size check — warn before loading large transcripts
  const sizeCheck = checkTranscriptSize(join(dir, 'transcript.jsonl'))
  if (!sizeCheck.ok) {
    process.stderr.write(
      `Warning: session transcript is large (${(sizeCheck.bytes / 1024 / 1024).toFixed(1)} MB). Loading may be slow.\n`,
    )
  }

  const allMessages = await readTranscript(dir)

  if (allMessages.length === 0) {
    throw new Error(`Session ${sessionId} has no transcript or does not exist`)
  }

  // Find last compact boundary (scan backwards)
  let boundaryIndex = -1
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i]!.flags?.isCompactBoundary) {
      boundaryIndex = i
      break
    }
  }

  // Inclusive: boundary message is the summary the model needs
  const messages = boundaryIndex >= 0
    ? allMessages.slice(boundaryIndex)
    : allMessages

  const info: SessionInfo = {
    id: sessionId,
    dir,
    createdAt: allMessages[0]!.timestamp,
    messageCount: allMessages.length,
  }

  return { info, messages }
}

/**
 * List sessions that have transcripts, sorted by creation time (most recent first).
 * Sessions without transcript files are not listed.
 */
export async function listSessions(): Promise<SessionInfo[]> {
  let entries: string[]
  try {
    entries = await readdir(SESSIONS_BASE_DIR)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return []
    }
    throw err
  }

  const results: SessionInfo[] = []

  for (const entry of entries) {
    const dir = join(SESSIONS_BASE_DIR, entry)
    const transcriptPath = join(dir, 'transcript.jsonl')

    try {
      const fileStat = await stat(transcriptPath)
      if (!fileStat.isFile()) continue

      // Read first line to get createdAt
      const content = await readFile(transcriptPath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim() !== '')
      if (lines.length === 0) continue

      let createdAt: number
      try {
        const firstMsg = JSON.parse(lines[0]!)
        createdAt = typeof firstMsg.timestamp === 'number' ? firstMsg.timestamp : 0
      } catch {
        createdAt = 0
      }

      results.push({
        id: entry,
        dir,
        createdAt,
        messageCount: lines.length,
      })
    } catch {
      // Skip entries that can't be read
      continue
    }
  }

  // Sort by creation time, most recent first
  results.sort((a, b) => b.createdAt - a.createdAt)

  return results
}
