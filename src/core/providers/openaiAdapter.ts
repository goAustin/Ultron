/**
 * OpenAI-compatible provider adapter — for OpenAI and OpenRouter-style endpoints.
 *
 * `callModel` receives messages in Anthropic-shaped wire format (produced by
 * `toApiMessages` in `./anthropicAdapter.ts`) and converts them to OpenAI's
 * format, then translates OpenAI streaming chunks back to the internal
 * `RawStreamEvent` union so the rest of the system (StreamAccumulator,
 * query.ts) works unchanged.
 */

import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions.js'

import type {
  CallModelFn,
  CallModelOptions,
  ApiResponseMeta,
  RawStreamEvent,
} from '../queryDeps.js'
import type { ApiToolDefinition } from '../tools/registry.js'
import type { ProviderAdapter, ModelEntry, CreateCallModelOptions } from './types.js'

// ---------------------------------------------------------------------------
// Anthropic MessageParam → OpenAI ChatCompletionMessageParam conversion
// ---------------------------------------------------------------------------

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'image'; source: unknown }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

function anthropicToOpenAI(
  messages: unknown[],
  systemPrompt: string,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const raw of messages) {
    const msg = raw as AnthropicMessage

    if (msg.role === 'user') {
      const textParts: string[] = []
      const toolResults: { tool_call_id: string; content: string }[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool_result') {
          toolResults.push({
            tool_call_id: block.tool_use_id,
            content: block.content ?? '',
          })
        }
      }

      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_call_id,
          content: tr.content,
        })
      }

      if (textParts.length > 0) {
        result.push({ role: 'user', content: textParts.join('\n') })
      }
    } else if (msg.role === 'assistant') {
      let textContent = ''
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
        }
      }

      const assistantMsg: ChatCompletionMessageParam = {
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      }
      result.push(assistantMsg)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Tool definition conversion
// ---------------------------------------------------------------------------

function toOpenAITools(tools: readonly ApiToolDefinition[]): ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }))
}

// ---------------------------------------------------------------------------
// OpenAI stream → RawStreamEvent conversion
// ---------------------------------------------------------------------------

type StreamState = {
  blockIndex: number
  textBlockStarted: boolean
  toolCallBlockIndex: Map<number, number>
  stopReason: string | null
  inputTokens: number | undefined
  outputTokens: number | undefined
}

function* convertChunkToEvents(
  chunk: ChatCompletionChunk,
  state: StreamState,
): Generator<RawStreamEvent> {
  if (chunk.usage) {
    state.inputTokens = chunk.usage.prompt_tokens
    state.outputTokens = chunk.usage.completion_tokens
  }

  const choice = chunk.choices?.[0]
  if (!choice) return

  const delta = choice.delta

  if (delta?.content) {
    if (!state.textBlockStarted) {
      yield {
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: { type: 'text', text: '' },
      }
      state.textBlockStarted = true
    }
    yield {
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: { type: 'text_delta', text: delta.content },
    }
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0

      if (tc.id && tc.function?.name) {
        if (state.textBlockStarted) {
          yield { type: 'content_block_stop', index: state.blockIndex }
          state.blockIndex++
          state.textBlockStarted = false
        }

        state.toolCallBlockIndex.set(idx, state.blockIndex)

        yield {
          type: 'content_block_start',
          index: state.blockIndex,
          content_block: {
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: '',
          },
        }
      }

      if (tc.function?.arguments) {
        const blockIdx = state.toolCallBlockIndex.get(idx) ?? state.blockIndex
        yield {
          type: 'content_block_delta',
          index: blockIdx,
          delta: {
            type: 'input_json_delta',
            partial_json: tc.function.arguments,
          },
        }
      }
    }
  }

  if (choice.finish_reason) {
    if (state.textBlockStarted) {
      yield { type: 'content_block_stop', index: state.blockIndex }
      state.blockIndex++
      state.textBlockStarted = false
    }
    for (const [, blockIdx] of state.toolCallBlockIndex) {
      yield { type: 'content_block_stop', index: blockIdx }
    }

    const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use'
      : choice.finish_reason === 'length' ? 'max_tokens'
      : 'end_turn'
    state.stopReason = stopReason
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible callModel factory (shared across OpenAI + any compatible
// endpoint — Minimax, OpenRouter, Together, etc.)
// ---------------------------------------------------------------------------

/**
 * Builds a `CallModelFn` for any endpoint that speaks the OpenAI Chat
 * Completions API. Callers pass their own default `baseUrl` in the options;
 * if omitted, points at `api.openai.com`.
 */
export function createOpenAICompatibleCallModel(opts: CreateCallModelOptions): CallModelFn {
  const { apiKey, model, baseUrl, tools } = opts
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl ?? 'https://api.openai.com/v1',
  })

  const openaiTools = tools?.length ? toOpenAITools(tools) : undefined

  return async function* callModel(
    messages: unknown[],
    systemPrompt: string,
    callOpts: CallModelOptions,
    signal: AbortSignal,
  ): AsyncGenerator<RawStreamEvent, ApiResponseMeta> {
    const openaiMessages = anthropicToOpenAI(messages, systemPrompt)

    const stream = await client.chat.completions.create({
      model,
      max_completion_tokens: callOpts.maxOutputTokens ?? 4096,
      messages: openaiMessages,
      ...(openaiTools && { tools: openaiTools }),
      stream: true,
      stream_options: { include_usage: true },
    }, { signal })

    const state: StreamState = {
      blockIndex: 0,
      textBlockStarted: false,
      toolCallBlockIndex: new Map(),
      stopReason: null,
      inputTokens: undefined,
      outputTokens: undefined,
    }

    yield {
      type: 'message_start',
      message: { usage: undefined },
    } as RawStreamEvent

    for await (const chunk of stream) {
      if (chunk.usage) {
        state.inputTokens = chunk.usage.prompt_tokens
        state.outputTokens = chunk.usage.completion_tokens
      }

      for (const event of convertChunkToEvents(chunk, state)) {
        yield event
      }
    }

    yield {
      type: 'message_delta',
      delta: { stop_reason: state.stopReason ?? 'end_turn' },
      usage: state.outputTokens !== undefined ? { output_tokens: state.outputTokens } : undefined,
    } as RawStreamEvent

    yield { type: 'message_stop' } as RawStreamEvent

    return {
      stopReason: state.stopReason ?? 'end_turn',
      model,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
    }
  }
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

const MODELS: readonly ModelEntry[] = [
  { id: 'gpt-5.4', provider: 'openai', label: 'GPT-5.4', description: 'Highest capability' },
  { id: 'gpt-5.4-mini', provider: 'openai', label: 'GPT-5.4 Mini', description: 'Balanced' },
  { id: 'gpt-5.4-nano', provider: 'openai', label: 'GPT-5.4 Nano', description: 'Fastest, cheapest' },
]

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  displayName: 'OpenAI',
  envKeyName: 'OPENAI_API_KEY',
  models: MODELS,
  createCallModel: createOpenAICompatibleCallModel,
}
