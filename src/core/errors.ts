export class PromptTooLongError extends Error {
  readonly code = 'PROMPT_TOO_LONG' as const
  constructor(message = 'Prompt exceeds the model context window') {
    super(message)
    this.name = 'PromptTooLongError'
  }
}

export class MaxOutputTokensError extends Error {
  readonly code = 'MAX_OUTPUT_TOKENS' as const
  constructor(message = 'Response exceeded the maximum output token limit') {
    super(message)
    this.name = 'MaxOutputTokensError'
  }
}

export class AbortedError extends Error {
  readonly code = 'ABORTED' as const
  constructor(message = 'Operation was aborted') {
    super(message)
    this.name = 'AbortedError'
  }
}
