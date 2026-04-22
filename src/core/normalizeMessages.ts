import type {
  Message,
  UserMessage,
  AssistantMessage,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolUseId,
} from './messages.js'
import { createUserMessage, messageId } from './messages.js'

// ---------------------------------------------------------------------------
// Step 1: Strip meta messages
// ---------------------------------------------------------------------------

export function stripMetaMessages(messages: readonly Message[]): Message[] {
  return messages.filter((m) => !m.flags?.isMeta)
}

// ---------------------------------------------------------------------------
// Step 2: Ensure every tool_use has a matching tool_result
// ---------------------------------------------------------------------------

export function ensureToolResultPairing(
  messages: Message[],
  uuidFn: () => string = () => crypto.randomUUID(),
): Message[] {
  // Collect all tool_use IDs from assistant messages
  const pendingToolUseIds = new Set<ToolUseId>()
  const result: Message[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          pendingToolUseIds.add(block.id)
        }
      }
      result.push(msg)
    } else {
      // User message — check which tool results it satisfies
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          pendingToolUseIds.delete(block.toolUseId)
        }
      }
      result.push(msg)

      // After processing this user message, inject synthetic results
      // for any tool_uses that are still pending and should have been
      // paired by now (i.e., the next message is assistant or end-of-list).
      // We only inject if there are pending IDs and the next message
      // would be an assistant message (or we're at the end).
    }
  }

  // Any remaining unpaired tool_uses get synthetic error results at the end
  if (pendingToolUseIds.size > 0) {
    for (const id of pendingToolUseIds) {
      result.push(
        createUserMessage(
          [
            {
              type: 'tool_result',
              toolUseId: id,
              content: 'Tool result missing — this tool call was not executed.',
              isError: true,
            },
          ],
          { id: messageId(uuidFn()) },
        ),
      )
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Step 3: Strip orphaned tool results
// ---------------------------------------------------------------------------

export function stripOrphanedToolResults(messages: readonly Message[]): Message[] {
  // Collect all tool_use IDs
  const toolUseIds = new Set<ToolUseId>()
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolUseIds.add(block.id)
        }
      }
    }
  }

  return messages.map((msg) => {
    if (msg.role !== 'user') return msg

    const filtered = msg.content.filter((block) => {
      if (block.type !== 'tool_result') return true
      return toolUseIds.has(block.toolUseId)
    })

    // If all content was stripped, drop the message entirely
    if (filtered.length === 0) return null

    // If nothing changed, return as-is
    if (filtered.length === msg.content.length) return msg

    return { ...msg, content: filtered }
  }).filter((m): m is Message => m !== null)
}

// ---------------------------------------------------------------------------
// Step 4: Enforce role alternation
// ---------------------------------------------------------------------------

export function enforceRoleAlternation(messages: readonly Message[]): Message[] {
  if (messages.length === 0) return []

  const result: Message[] = [messages[0]!]

  for (let i = 1; i < messages.length; i++) {
    const current = messages[i]!
    const previous = result[result.length - 1]!

    if (current.role === previous.role) {
      // Merge content into the previous message
      const merged: Message = {
        ...previous,
        content: [...previous.content, ...current.content],
      }
      result[result.length - 1] = merged
    } else {
      result.push(current)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Step 5: Strip thinking blocks from older turns
// ---------------------------------------------------------------------------

export function stripStaleThinkingBlocks(messages: readonly Message[]): Message[] {
  // Find the last assistant message index — thinking blocks in that
  // trajectory (and its immediately preceding tool results) are preserved.
  // Everything older gets thinking stripped.

  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }

  // Find the start of the current trajectory: walk backwards from
  // lastAssistantIdx through alternating tool_result(user)/assistant pairs.
  let trajectoryStart = lastAssistantIdx
  if (trajectoryStart > 0) {
    for (let i = lastAssistantIdx - 1; i >= 0; i--) {
      const msg = messages[i]!
      if (msg.role === 'user' && msg.content.every((b) => b.type === 'tool_result')) {
        trajectoryStart = i
        // Check if there's an assistant message before this tool_result
        if (i > 0 && messages[i - 1]!.role === 'assistant') {
          trajectoryStart = i - 1
          i-- // skip the assistant we just claimed
        }
      } else {
        break
      }
    }
  }

  return messages.map((msg, idx) => {
    if (idx >= trajectoryStart) return msg
    if (msg.role !== 'assistant') return msg

    const hasThinking = msg.content.some(
      (b) => b.type === 'thinking' || b.type === 'redacted_thinking',
    )
    if (!hasThinking) return msg

    const filtered = msg.content.filter(
      (b) => b.type !== 'thinking' && b.type !== 'redacted_thinking',
    )

    // If stripping thinking leaves the message empty, keep a placeholder
    if (filtered.length === 0) {
      return { ...msg, content: [{ type: 'text' as const, text: '' }] }
    }

    return { ...msg, content: filtered }
  })
}

// ---------------------------------------------------------------------------
// Composed pipeline
// ---------------------------------------------------------------------------

export function normalizeMessages(
  messages: readonly Message[],
  uuidFn?: () => string,
): Message[] {
  let result = stripMetaMessages(messages)
  result = ensureToolResultPairing(result, uuidFn)
  result = stripOrphanedToolResults(result)
  result = enforceRoleAlternation(result)
  result = stripStaleThinkingBlocks(result)
  return result
}
