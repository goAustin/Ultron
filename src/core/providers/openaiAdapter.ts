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
  ChatCompletionContentPart,
} from 'openai/resources/chat/completions.js'
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
  Tool as ResponseTool,
} from 'openai/resources/responses/responses.js'

import type {
  CallModelFn,
  CallModelOptions,
  ApiResponseMeta,
  RawStreamEvent,
} from '../queryDeps.js'
import type { SystemPromptPart } from '../../context/systemPromptParts.js'
import type { ApiToolDefinition } from '../tools/registry.js'
import type { ProviderAdapter, ModelEntry, CreateCallModelOptions } from './types.js'
import { CONTEXT_1M, CONTEXT_400K, OUTPUT_128K } from './capabilityMetadata.js'
import { warnOnce } from './warnOnce.js'

// Bucketed mapping from generic thinkingBudget (tokens) → reasoning_effort.
// Boundaries are < (strict), so 4096 → 'medium' and 16_384 → 'high'.
const REASONING_LOW_MAX = 4096
const REASONING_MEDIUM_MAX = 16_384

export function bucketReasoningEffort(budget: number): 'low' | 'medium' | 'high' {
  if (budget < REASONING_LOW_MAX) return 'low'
  if (budget < REASONING_MEDIUM_MAX) return 'medium'
  return 'high'
}

// ---------------------------------------------------------------------------
// Anthropic MessageParam → OpenAI ChatCompletionMessageParam conversion
// ---------------------------------------------------------------------------

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }

function imageDataUrl(source: { media_type: string; data: string }): string {
  return `data:${source.media_type};base64,${source.data}`
}

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

export function joinSystemPromptParts(parts: readonly SystemPromptPart[]): string {
  return parts.map(p => p.content).join('\n\n')
}

function anthropicToOpenAI(
  messages: unknown[],
  systemPromptParts: readonly SystemPromptPart[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  const systemContent = joinSystemPromptParts(systemPromptParts)
  if (systemContent) {
    result.push({ role: 'system', content: systemContent })
  }

  for (const raw of messages) {
    const msg = raw as AnthropicMessage

    if (msg.role === 'user') {
      // Chat Completions requires every `tool` response to follow the
      // assistant tool_calls turn directly — interleaving a `user` message
      // between tool responses for a multi-call turn is rejected by the API.
      // So we do two passes: emit all tool responses first, then any user
      // text/image content. Order within each group is preserved, which keeps
      // image_A before image_B aligned with tool_A before tool_B for parallel
      // results.
      const userContent: ChatCompletionContentPart[] = []
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          result.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.content ?? '',
          })
        }
      }
      for (const block of msg.content) {
        if (block.type === 'text') {
          userContent.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          userContent.push({
            type: 'image_url',
            image_url: { url: imageDataUrl(block.source) },
          })
        }
      }
      if (userContent.length > 0) {
        result.push({ role: 'user', content: userContent })
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

function anthropicToResponsesInput(messages: unknown[]): ResponseInput {
  const result: ResponseInput = []

  for (const raw of messages) {
    const msg = raw as AnthropicMessage

    if (msg.role === 'user') {
      // Stream-emit. function_call_output is string-only (OpenAI Responses
      // spec), so an accompanying screenshot must be a sibling user
      // input_image item — emitted right after the tool_result it belongs to.
      let pendingText: string[] = []
      const flushText = () => {
        if (pendingText.length > 0) {
          result.push({ role: 'user', content: pendingText.join('\n') })
          pendingText = []
        }
      }

      for (const block of msg.content) {
        if (block.type === 'text') {
          pendingText.push(block.text)
        } else if (block.type === 'tool_result') {
          flushText()
          result.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: block.content ?? '',
          })
        } else if (block.type === 'image') {
          flushText()
          result.push({
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_image',
              image_url: imageDataUrl(block.source),
              detail: 'auto',
            }],
          })
        }
      }
      flushText()
    } else if (msg.role === 'assistant') {
      let textContent = ''

      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text
        }
      }

      if (textContent) {
        result.push({ role: 'assistant', content: textContent })
      }

      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          result.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
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

function toResponsesTools(tools: readonly ApiToolDefinition[]): ResponseTool[] {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema as Record<string, unknown>,
    strict: null,
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

type ResponsesStreamState = {
  blockIndex: number
  textBlockStarted: boolean
  functionCallBlockIndex: Map<number, number>
  closedFunctionCallBlocks: Set<number>
  stopReason: string | null
  inputTokens: number | undefined
  outputTokens: number | undefined
}

function closeResponsesTextBlock(state: ResponsesStreamState): RawStreamEvent | null {
  if (!state.textBlockStarted) return null
  const event: RawStreamEvent = { type: 'content_block_stop', index: state.blockIndex }
  state.blockIndex++
  state.textBlockStarted = false
  return event
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

function* convertResponseEventToEvents(
  event: ResponseStreamEvent,
  state: ResponsesStreamState,
): Generator<RawStreamEvent> {
  switch (event.type) {
    case 'response.output_text.delta': {
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
        delta: { type: 'text_delta', text: event.delta },
      }
      return
    }

    case 'response.content_part.done': {
      if (event.part.type === 'output_text') {
        const stop = closeResponsesTextBlock(state)
        if (stop) yield stop
      }
      return
    }

    case 'response.output_item.added': {
      if (event.item.type !== 'function_call') return

      const stop = closeResponsesTextBlock(state)
      if (stop) yield stop

      state.functionCallBlockIndex.set(event.output_index, state.blockIndex)
      yield {
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: {
          type: 'tool_use',
          id: event.item.call_id,
          name: event.item.name,
          input: '',
        },
      }

      if (event.item.arguments) {
        yield {
          type: 'content_block_delta',
          index: state.blockIndex,
          delta: { type: 'input_json_delta', partial_json: event.item.arguments },
        }
      }

      state.blockIndex++
      return
    }

    case 'response.function_call_arguments.delta': {
      const blockIdx = state.functionCallBlockIndex.get(event.output_index)
      if (blockIdx === undefined) return
      yield {
        type: 'content_block_delta',
        index: blockIdx,
        delta: { type: 'input_json_delta', partial_json: event.delta },
      }
      return
    }

    case 'response.output_item.done': {
      if (event.item.type !== 'function_call') return
      const blockIdx = state.functionCallBlockIndex.get(event.output_index)
      if (blockIdx === undefined || state.closedFunctionCallBlocks.has(blockIdx)) return
      state.closedFunctionCallBlocks.add(blockIdx)
      yield { type: 'content_block_stop', index: blockIdx }
      return
    }

    case 'response.completed': {
      state.inputTokens = event.response.usage?.input_tokens
      state.outputTokens = event.response.usage?.output_tokens
      const stop = closeResponsesTextBlock(state)
      if (stop) yield stop

      for (const [, blockIdx] of state.functionCallBlockIndex) {
        if (state.closedFunctionCallBlocks.has(blockIdx)) continue
        state.closedFunctionCallBlocks.add(blockIdx)
        yield { type: 'content_block_stop', index: blockIdx }
      }

      state.stopReason = event.response.output.some(item => item.type === 'function_call')
        ? 'tool_use'
        : 'end_turn'
      return
    }

    case 'response.incomplete': {
      state.inputTokens = event.response.usage?.input_tokens
      state.outputTokens = event.response.usage?.output_tokens
      state.stopReason = event.response.incomplete_details?.reason === 'max_output_tokens'
        ? 'max_tokens'
        : 'end_turn'
      return
    }

    case 'response.failed': {
      const message = event.response.error?.message ?? 'OpenAI Responses request failed'
      throw new Error(message)
    }

    case 'error':
      throw new Error(event.message)
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
  const { apiKey, model, baseUrl, tools, capabilities } = opts
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl ?? 'https://api.openai.com/v1',
  })

  const openaiTools = tools?.length ? toOpenAITools(tools) : undefined
  const responsesTools = tools?.length ? toResponsesTools(tools) : undefined
  const useResponsesApi = baseUrl === undefined

  return async function* callModel(
    messages: unknown[],
    systemPromptParts: readonly SystemPromptPart[],
    callOpts: CallModelOptions,
    signal: AbortSignal,
  ): AsyncGenerator<RawStreamEvent, ApiResponseMeta> {
    // Capability-gated thinking → reasoning_effort translation.
    let reasoningEffort: 'low' | 'medium' | 'high' | undefined
    if (callOpts.thinkingBudget && callOpts.thinkingBudget > 0) {
      if (capabilities.supportsThinking) {
        reasoningEffort = bucketReasoningEffort(callOpts.thinkingBudget)
      } else {
        warnOnce(
          `thinking:${model}`,
          `thinkingBudget set but model ${model} does not support thinking; ignoring.`,
        )
      }
    }

    // Interleaved thinking is an Anthropic-only beta today; warn and drop on
    // any OpenAI-shaped endpoint.
    if (callOpts.interleavedThinking && !capabilities.supportsInterleavedThinking) {
      warnOnce(
        `interleaved:${model}`,
        `interleavedThinking set but model ${model} does not support it; ignoring.`,
      )
    }

    if (useResponsesApi) {
      const request: ResponseCreateParamsStreaming = {
        model,
        max_output_tokens: callOpts.maxOutputTokens ?? 4096,
        instructions: joinSystemPromptParts(systemPromptParts) || null,
        input: anthropicToResponsesInput(messages),
        ...(responsesTools && { tools: responsesTools }),
        ...(reasoningEffort && { reasoning: { effort: reasoningEffort } }),
        store: false,
        stream: true,
        stream_options: { include_obfuscation: false },
      }

      const stream = await client.responses.create(request, { signal })

      const state: ResponsesStreamState = {
        blockIndex: 0,
        textBlockStarted: false,
        functionCallBlockIndex: new Map(),
        closedFunctionCallBlocks: new Set(),
        stopReason: null,
        inputTokens: undefined,
        outputTokens: undefined,
      }

      yield {
        type: 'message_start',
        message: { usage: undefined },
      } as RawStreamEvent

      for await (const event of stream) {
        for (const rawEvent of convertResponseEventToEvents(event, state)) {
          yield rawEvent
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

    const openaiMessages = anthropicToOpenAI(messages, systemPromptParts)
    const stream = await client.chat.completions.create({
      model,
      max_completion_tokens: callOpts.maxOutputTokens ?? 4096,
      messages: openaiMessages,
      ...(openaiTools && { tools: openaiTools }),
      ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
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
  {
    id: 'gpt-5.4',
    provider: 'openai',
    label: 'GPT-5.4',
    description: 'Highest capability',
    maxContextTokens: CONTEXT_1M,
    maxOutputTokens: OUTPUT_128K,
    supportsThinking: true,
    supportsInterleavedThinking: false,
    promptCacheModel: 'implicit',
    supportsVision: true,
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    label: 'GPT-5.4 Mini',
    description: 'Balanced',
    maxContextTokens: CONTEXT_400K,
    maxOutputTokens: OUTPUT_128K,
    supportsThinking: true,
    supportsInterleavedThinking: false,
    promptCacheModel: 'implicit',
    supportsVision: true,
  },
  {
    id: 'gpt-5.4-nano',
    provider: 'openai',
    label: 'GPT-5.4 Nano',
    description: 'Fastest, cheapest',
    maxContextTokens: CONTEXT_400K,
    maxOutputTokens: OUTPUT_128K,
    supportsThinking: true,
    supportsInterleavedThinking: false,
    promptCacheModel: 'implicit',
    supportsVision: true,
  },
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
