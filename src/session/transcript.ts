/**
 * Transcript persistence — JSONL read/write for session messages.
 *
 * Each line in the transcript file is one JSON-serialized Message.
 * Branded types (MessageId, ToolUseId) are strings at runtime and
 * round-trip through JSON natively. Deserialization strictly validates
 * each content block discriminant and re-brands IDs.
 */

import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { enforceBaseDirectoryPermissions } from '../memory/localMemoryGuard.js'

import type { Message, ContentBlock } from '../core/messages.js'
import { messageId, toolUseId } from '../core/messages.js'
import type { QueryEvent } from '../core/queryEvents.js'

const TRANSCRIPT_FILENAME = 'transcript.jsonl'

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeMessage(message: Message): string {
  return JSON.stringify(message)
}

// ---------------------------------------------------------------------------
// Deserialization — strict validation
// ---------------------------------------------------------------------------

export function deserializeMessage(line: string): Message {
  const raw = JSON.parse(line)

  // Top-level validation
  if (raw.role !== 'user' && raw.role !== 'assistant') {
    throw new Error(`Invalid message role: ${raw.role}`)
  }
  if (typeof raw.id !== 'string') {
    throw new Error('Message missing id')
  }
  if (typeof raw.timestamp !== 'number') {
    throw new Error('Message missing timestamp')
  }
  if (!Array.isArray(raw.content)) {
    throw new Error('Message missing content array')
  }

  // Validate and reconstruct content blocks
  const content: ContentBlock[] = raw.content.map(validateContentBlock)

  // Validate flags if present
  if (raw.flags !== undefined && (typeof raw.flags !== 'object' || raw.flags === null)) {
    throw new Error('Message flags must be an object')
  }

  return {
    id: messageId(raw.id),
    timestamp: raw.timestamp,
    role: raw.role,
    content,
    ...(raw.flags && { flags: raw.flags }),
  } as Message
}

function validateContentBlock(block: unknown): ContentBlock {
  if (typeof block !== 'object' || block === null || !('type' in block)) {
    throw new Error('Content block missing type')
  }

  const b = block as Record<string, unknown>

  switch (b.type) {
    case 'text':
      if (typeof b.text !== 'string') {
        throw new Error('Text block missing text field')
      }
      return { type: 'text', text: b.text }

    case 'tool_use':
      if (typeof b.id !== 'string') throw new Error('tool_use block missing id')
      if (typeof b.name !== 'string') throw new Error('tool_use block missing name')
      if (typeof b.input !== 'object' || b.input === null) {
        throw new Error('tool_use block missing input')
      }
      return {
        type: 'tool_use',
        id: toolUseId(b.id as string),
        name: b.name as string,
        input: b.input as Record<string, unknown>,
      }

    case 'tool_result':
      if (typeof b.toolUseId !== 'string') {
        throw new Error('tool_result block missing toolUseId')
      }
      if (typeof b.content !== 'string') {
        throw new Error('tool_result block missing content')
      }
      if (typeof b.isError !== 'boolean') {
        throw new Error('tool_result block missing isError')
      }
      return {
        type: 'tool_result',
        toolUseId: toolUseId(b.toolUseId as string),
        content: b.content as string,
        isError: b.isError as boolean,
      }

    case 'thinking':
      if (typeof b.thinking !== 'string') {
        throw new Error('thinking block missing thinking')
      }
      if (typeof b.signature !== 'string') {
        throw new Error('thinking block missing signature')
      }
      return { type: 'thinking', thinking: b.thinking, signature: b.signature }

    case 'redacted_thinking':
      return { type: 'redacted_thinking' }

    case 'image':
      if (typeof b.mediaType !== 'string') {
        throw new Error('image block missing mediaType')
      }
      if (typeof b.data !== 'string') {
        throw new Error('image block missing data')
      }
      return { type: 'image', mediaType: b.mediaType, data: b.data }

    default:
      throw new Error(`Unknown content block type: ${b.type}`)
  }
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Append a message to the transcript file. Creates the directory on first call.
 * Returns true on success, false on failure (after warning to stderr).
 */
export async function appendMessage(
  sessionDir: string,
  message: Message,
): Promise<boolean> {
  try {
    await mkdir(sessionDir, { recursive: true })
    await enforceBaseDirectoryPermissions(join(homedir(), '.ultron'))
    await appendFile(
      join(sessionDir, TRANSCRIPT_FILENAME),
      serializeMessage(message) + '\n',
    )
    return true
  } catch (err: unknown) {
    process.stderr.write(
      `Warning: failed to persist message: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return false
  }
}

/**
 * Read all messages from a transcript file.
 * - ENOENT → []
 * - Trailing malformed line: skipped silently (crash artifact)
 * - Mid-file malformed line: warned to stderr, skipped
 */
export async function readTranscript(sessionDir: string): Promise<Message[]> {
  let raw: string
  try {
    raw = await readFile(join(sessionDir, TRANSCRIPT_FILENAME), 'utf-8')
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return []
    }
    throw err
  }

  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  const messages: Message[] = []

  for (let i = 0; i < lines.length; i++) {
    try {
      messages.push(deserializeMessage(lines[i]!))
    } catch (err: unknown) {
      const isTrailing = i === lines.length - 1
      if (!isTrailing) {
        process.stderr.write(
          `Warning: corrupt transcript line ${i + 1}: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
      // Skip the line in both cases
    }
  }

  return messages
}

// ---------------------------------------------------------------------------
// Event → Message extraction
// ---------------------------------------------------------------------------

/**
 * Extract the persistable Message from a QueryEvent.
 * Returns null for streaming/control events that should not be persisted.
 */
export function getEventMessage(event: QueryEvent): Message | null {
  switch (event.type) {
    case 'turn':
      return event.message
    case 'tool_result':
      return event.message
    case 'attachment':
      return event.message
    default:
      return null
  }
}
