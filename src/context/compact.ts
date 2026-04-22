/**
 * Compaction — summarize old messages to free context space.
 *
 * createCompactFn() returns a CompactFn that:
 * 1. Finds a safe split point preserving complete exchanges
 * 2. Summarizes older messages via a model call
 * 3. Validates the summary
 * 4. Returns [boundary, ...recentMessages]
 */

import type { Message, ContentBlock, MessageId } from '../core/messages.js'
import { createUserMessage, getToolUseBlocks } from '../core/messages.js'
import type { CallModelFn, CompactFn } from '../core/queryDeps.js'
import { StreamAccumulator } from '../core/providers/anthropicAdapter.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum acceptable summary length in characters. */
export const MIN_SUMMARY_LENGTH = 50

/** Max output tokens for the summarization call. */
export const SUMMARIZATION_MAX_TOKENS = 16_384

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a CompactFn that summarizes old messages via the given model caller.
 *
 * @param compactCallModel - A pre-configured CallModelFn for summarization.
 *   Model choice belongs in dependency wiring, not here.
 * @param uuid - UUID generator for creating the boundary message ID.
 */
export function createCompactFn(
  compactCallModel: CallModelFn,
  uuid: () => MessageId,
): CompactFn {
  return async (messages: Message[]): Promise<Message[]> => {
    const splitIndex = findCompactSplitPoint(messages)
    if (splitIndex === -1) {
      throw new Error('Nothing to compact: conversation is a single exchange')
    }

    const toSummarize = messages.slice(0, splitIndex)
    const toKeep = messages.slice(splitIndex)

    const prompt = buildSummarizationPrompt(toSummarize)

    // Call the model to summarize
    const summary = await callForSummary(compactCallModel, prompt, uuid)

    // Validate output
    if (summary.trim().length < MIN_SUMMARY_LENGTH) {
      throw new Error(
        `Compaction produced unusable summary (${summary.trim().length} chars, need >= ${MIN_SUMMARY_LENGTH})`,
      )
    }

    return buildCompactedMessages(summary, toKeep, uuid)
  }
}

// ---------------------------------------------------------------------------
// Split point — find where to divide old vs. recent
// ---------------------------------------------------------------------------

/**
 * Find the index where recent context begins. Everything before this index
 * gets summarized. Returns -1 if the entire history is a single exchange
 * (nothing to compact).
 *
 * Walks backwards to find complete exchange boundaries. An exchange is:
 * user → assistant → (tool_result messages for that assistant's tool_use blocks).
 * Never splits between an assistant tool_use and its tool_result.
 */
export function findCompactSplitPoint(messages: readonly Message[]): number {
  if (messages.length <= 1) return -1

  // Walk backwards to find the start of the last complete exchange.
  // An exchange starts with a user message. We need to find the second-to-last
  // exchange boundary to keep at least the last complete exchange.

  // First, find the start of the current (last) exchange by walking back
  // past any tool_result user messages to find the "real" user turn.
  let i = messages.length - 1

  // Walk backwards past the tail: we're looking for exchange boundaries.
  // An exchange boundary is a user message that is NOT a tool_result carrier.
  const exchangeStarts: number[] = []

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]!
    if (msg.role === 'user' && !isToolResultOnly(msg)) {
      exchangeStarts.push(idx)
    }
  }

  // Need at least 2 exchanges: one to summarize, one to keep
  if (exchangeStarts.length < 2) return -1

  // The split point is at the start of the last exchange
  // (keep the last exchange, summarize everything before it)
  const lastExchangeStart = exchangeStarts[exchangeStarts.length - 1]!

  // But we also need to make sure we're not splitting inside a tool trajectory.
  // Walk backwards from lastExchangeStart to ensure we're not splitting between
  // an assistant's tool_use and its tool_result.
  // The user message at lastExchangeStart should NOT be a tool_result carrier —
  // we already filtered those out above. So lastExchangeStart is safe.

  // If summarizing 0 messages, nothing to compact
  if (lastExchangeStart === 0) return -1

  return lastExchangeStart
}

// ---------------------------------------------------------------------------
// Summarization prompt
// ---------------------------------------------------------------------------

/**
 * Build a text representation of messages for the summarization model.
 */
export function buildSummarizationPrompt(messages: readonly Message[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    for (const block of msg.content) {
      lines.push(renderBlock(msg.role, block))
    }
  }

  return lines.join('\n\n')
}

// ---------------------------------------------------------------------------
// Compacted message construction
// ---------------------------------------------------------------------------

/**
 * Build the compacted message array: [boundary, ...recentMessages].
 */
export function buildCompactedMessages(
  summary: string,
  recentMessages: readonly Message[],
  uuid: () => MessageId,
): Message[] {
  const boundary = createUserMessage(summary, {
    id: uuid(),
    flags: { isCompactBoundary: true },
  })

  return [boundary, ...recentMessages]
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Check if a user message contains only tool_result blocks. */
function isToolResultOnly(msg: Message): boolean {
  return (
    msg.role === 'user' &&
    msg.content.length > 0 &&
    msg.content.every((b) => b.type === 'tool_result')
  )
}

/** Render a single content block as text for the summarization prompt. */
function renderBlock(role: string, block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return `[${role}] ${block.text}`
    case 'tool_use':
      return `[${role}] Tool call: ${block.name}(${JSON.stringify(block.input)})`
    case 'tool_result':
      return `[tool_result] ${block.isError ? '(error) ' : ''}${block.content}`
    case 'thinking':
      return `[thinking] ${block.thinking}`
    case 'image':
      return `[${role}] (image)`
    case 'redacted_thinking':
      return `[redacted_thinking]`
  }
}

const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summarizer. Summarize the following conversation transcript concisely but thoroughly. Preserve:

- Key decisions made and their rationale
- File paths, function names, and code structures discussed
- Tool actions taken and their outcomes (success/failure)
- Current task state and what the user is trying to accomplish
- Any unresolved issues or next steps

The summary will replace the original messages in the conversation history, so the model reading it must have enough context to continue the work. Write in past tense. Do not include pleasantries or filler.`

/** Call the model with the summarization prompt and collect the full response. */
async function callForSummary(
  callModel: CallModelFn,
  conversationText: string,
  uuid: () => MessageId,
): Promise<string> {
  const accumulator = new StreamAccumulator()
  const abortController = new AbortController()

  const stream = callModel(
    [{ role: 'user', content: [{ type: 'text', text: conversationText }] }],
    SUMMARIZATION_SYSTEM_PROMPT,
    { maxOutputTokens: SUMMARIZATION_MAX_TOKENS },
    abortController.signal,
  )

  for await (const event of { [Symbol.asyncIterator]: () => stream }) {
    accumulator.push(event)
  }

  const message = accumulator.build(uuid())

  // Extract text from the response
  const textBlocks = message.content.filter(
    (b): b is { type: 'text'; text: string } => b.type === 'text',
  )

  return textBlocks.map((b) => b.text).join('\n')
}
