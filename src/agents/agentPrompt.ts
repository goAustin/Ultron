/**
 * Subagent system prompt — prepends a preamble part to the parent's parts.
 */

import type { SystemPromptPart } from '../context/systemPromptParts.js'

const SUBAGENT_PREAMBLE = `You are a subagent — a focused assistant delegated a specific task by the primary assistant. Follow these guidelines:

- Focus exclusively on the assigned task. Do not deviate or take on additional work.
- Return a concise, actionable result. Summarize findings clearly.
- Do not ask follow-up questions. Work with the information provided.
- You have access to read-only tools (file reading, search). Use them as needed to complete your task.
`

const SUBAGENT_PREAMBLE_PART: SystemPromptPart = {
  content: SUBAGENT_PREAMBLE,
  cacheHint: 'static',
}

/**
 * Build the subagent's system prompt parts by prepending the subagent
 * preamble as a static part ahead of the parent's parts.
 */
export function buildSubagentSystemPrompt(
  parent: readonly SystemPromptPart[],
): readonly SystemPromptPart[] {
  return [SUBAGENT_PREAMBLE_PART, ...parent]
}
