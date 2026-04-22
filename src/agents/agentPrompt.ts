/**
 * Subagent system prompt — prepends a preamble to the parent's system prompt.
 */

const SUBAGENT_PREAMBLE = `You are a subagent — a focused assistant delegated a specific task by the primary assistant. Follow these guidelines:

- Focus exclusively on the assigned task. Do not deviate or take on additional work.
- Return a concise, actionable result. Summarize findings clearly.
- Do not ask follow-up questions. Work with the information provided.
- You have access to read-only tools (file reading, search). Use them as needed to complete your task.
`

/**
 * Build the system prompt for a subagent by prepending the subagent preamble
 * to the parent's static system prompt.
 */
export function buildSubagentSystemPrompt(parentSystemPrompt: string): string {
  return SUBAGENT_PREAMBLE + '\n' + parentSystemPrompt
}
