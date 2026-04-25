/**
 * Anthropic provider adapter — the ONLY file that imports `@anthropic-ai/sdk`.
 *
 * Exports a `ProviderAdapter` (for the registry) plus two pieces of the
 * "wire format" reused by the rest of the system:
 *   - `toApiMessages` — converts internal Messages → Anthropic-shaped params,
 *     which the core loop uses as its neutral currency across providers.
 *   - `StreamAccumulator` — consumes `RawStreamEvent`s into an `AssistantMessage`.
 *     Not Anthropic-specific (operates on the abstract event union), but lives
 *     here for historical reasons — other providers' adapters synthesize those
 *     same events and feed them through the same accumulator (see `openaiAdapter.ts`
 *     and `../query.ts`).
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageParam,
  ContentBlockParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  ImageBlockParam,
  ThinkingBlockParam,
  RedactedThinkingBlockParam,
  Tool as AnthropicToolDef,
} from '@anthropic-ai/sdk/resources/messages.js'

import type {
  Message,
  ContentBlock,
  AssistantMessage,
  MessageId,
} from '../messages.js'
import {
  toolUseId,
  createAssistantMessage,
} from '../messages.js'
import type {
  CallModelFn,
  CallModelOptions,
  ApiResponseMeta,
  RawStreamEvent,
} from '../queryDeps.js'
import type { SystemPromptPart } from '../../context/systemPromptParts.js'
import type { ProviderAdapter, ModelEntry, CreateCallModelOptions } from './types.js'
import { CONTEXT_1M, CONTEXT_200K, OUTPUT_128K, OUTPUT_64K } from './capabilityMetadata.js'
import { warnOnce } from './warnOnce.js'

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'
const THINKING_MAX_TOKENS_HEADROOM = 1024

// ---------------------------------------------------------------------------
// Internal → API conversion
// ---------------------------------------------------------------------------

function contentBlockToApi(block: ContentBlock): ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text } satisfies TextBlockParam
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id as string,
        name: block.name,
        input: block.input,
      } satisfies ToolUseBlockParam
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId as string,
        content: block.content,
        is_error: block.isError || undefined,
      } satisfies ToolResultBlockParam
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: block.data,
        },
      } satisfies ImageBlockParam
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      } satisfies ThinkingBlockParam
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: '' } satisfies RedactedThinkingBlockParam
  }
}

export function toApiMessages(messages: readonly Message[]): MessageParam[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content.map(contentBlockToApi),
  }))
}

// ---------------------------------------------------------------------------
// System field construction (cache-hint aware)
// ---------------------------------------------------------------------------

/**
 * Translate `SystemPromptPart[]` into Anthropic's `system` field.
 *
 * Models with `promptCacheModel === 'explicit'` receive a `TextBlockParam[]`
 * with up to two `cache_control: {type: 'ephemeral'}` breakpoints:
 *
 *   Pass 1 — last non-empty `'global'` part (Ultron preamble boundary).
 *   Pass 2 — last non-empty `'org'` part (memory / skills boundary).
 *
 * The two scans are independent and can't collide (`'global'` and `'org'`
 * are disjoint on the type). The split lets memory mutations invalidate
 * only the org-segment cache while leaving the preamble cache intact.
 *
 * If neither pass marks a part (all-volatile or empty input), fall back to
 * a single joined string — byte-identical to non-explicit behavior.
 *
 * Anthropic allows up to 4 `cache_control` breakpoints; we use 2.
 */
export function buildAnthropicSystemField(
  parts: readonly SystemPromptPart[],
  promptCacheModel: ModelEntry['promptCacheModel'],
): string | TextBlockParam[] {
  if (promptCacheModel !== 'explicit') {
    return parts.map(p => p.content).join('\n\n')
  }

  const blocks: TextBlockParam[] = parts.map(p => ({
    type: 'text',
    text: p.content,
  }))

  let marked = false

  // Pass 1 — last non-empty 'global' part gets a cache breakpoint.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.cacheHint === 'global' && part.content.length > 0) {
      blocks[i] = { ...blocks[i]!, cache_control: { type: 'ephemeral' } }
      marked = true
      break
    }
  }

  // Pass 2 — last non-empty 'org' part gets a second cache breakpoint.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.cacheHint === 'org' && part.content.length > 0) {
      blocks[i] = { ...blocks[i]!, cache_control: { type: 'ephemeral' } }
      marked = true
      break
    }
  }

  // No breakpoint candidate — fall back to joined string (same as non-explicit).
  if (!marked) return parts.map(p => p.content).join('\n\n')

  return blocks
}

// ---------------------------------------------------------------------------
// API stream → Internal conversion
// ---------------------------------------------------------------------------

type AccumulatingBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; inputJson: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking' }

/**
 * Stateful accumulator that processes raw stream events and builds
 * internal ContentBlocks. Call `push()` for each event, then `build()`
 * to produce the final AssistantMessage.
 */
export class StreamAccumulator {
  private blocks: AccumulatingBlock[] = []
  private stopReason: string | null = null
  private model: string | undefined = undefined
  private inputTokens: number | undefined = undefined
  private outputTokens: number | undefined = undefined

  push(event: RawStreamEvent): void {
    switch (event.type) {
      case 'content_block_start': {
        const cb = event.content_block
        switch (cb.type) {
          case 'text':
            this.blocks[event.index] = { type: 'text', text: cb.text }
            break
          case 'tool_use':
            this.blocks[event.index] = {
              type: 'tool_use',
              id: cb.id,
              name: cb.name,
              inputJson: '',
            }
            break
          case 'thinking':
            this.blocks[event.index] = {
              type: 'thinking',
              thinking: cb.thinking,
              signature: '',
            }
            break
          case 'redacted_thinking':
            this.blocks[event.index] = { type: 'redacted_thinking' }
            break
        }
        break
      }
      case 'content_block_delta': {
        const block = this.blocks[event.index]
        if (!block) break
        const delta = event.delta
        switch (delta.type) {
          case 'text_delta':
            if (block.type === 'text') block.text += delta.text
            break
          case 'input_json_delta':
            if (block.type === 'tool_use') block.inputJson += delta.partial_json
            break
          case 'thinking_delta':
            if (block.type === 'thinking') block.thinking += delta.thinking
            break
          case 'signature_delta':
            if (block.type === 'thinking') block.signature = delta.signature
            break
        }
        break
      }
      case 'content_block_stop':
        break
      case 'message_start':
        if (event.message.usage) {
          this.inputTokens = event.message.usage.input_tokens
          this.outputTokens = event.message.usage.output_tokens
        }
        break
      case 'message_delta':
        this.stopReason = event.delta.stop_reason
        if (event.usage) {
          this.outputTokens = event.usage.output_tokens
        }
        break
      case 'message_stop':
        break
    }
  }

  build(id: MessageId, timestamp?: number): AssistantMessage {
    const content: ContentBlock[] = this.blocks.map((block): ContentBlock => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text }
        case 'tool_use':
          return {
            type: 'tool_use',
            id: toolUseId(block.id),
            name: block.name,
            input: block.inputJson ? JSON.parse(block.inputJson) : {},
          }
        case 'thinking':
          return {
            type: 'thinking',
            thinking: block.thinking,
            signature: block.signature,
          }
        case 'redacted_thinking':
          return { type: 'redacted_thinking' }
      }
    })

    return createAssistantMessage(content, {
      id,
      timestamp,
      flags: {
        stopReason: this.stopReason ?? undefined,
        model: this.model,
        ...(this.stopReason === 'max_tokens' && {
          isApiError: true,
          apiErrorKind: 'max_output_tokens' as const,
        }),
      },
    })
  }

  getStopReason(): string | null {
    return this.stopReason
  }

  getMeta(): ApiResponseMeta {
    return {
      stopReason: this.stopReason,
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    }
  }
}

// ---------------------------------------------------------------------------
// Production callModel implementation
// ---------------------------------------------------------------------------

function createAnthropicCallModel(opts: CreateCallModelOptions): CallModelFn {
  const { apiKey, model, baseUrl, tools, capabilities } = opts
  const client = new Anthropic({ apiKey, ...(baseUrl && { baseURL: baseUrl }) })

  const anthropicTools: AnthropicToolDef[] | undefined = tools?.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as AnthropicToolDef['input_schema'],
  }))

  return async function* callModel(
    messages: unknown[],
    systemPromptParts: readonly SystemPromptPart[],
    callOpts: CallModelOptions,
    signal: AbortSignal,
  ): AsyncGenerator<RawStreamEvent, ApiResponseMeta> {
    const systemField = buildAnthropicSystemField(systemPromptParts, capabilities.promptCacheModel)

    // Capability-gated thinking translation. Engine-side normalization
    // (thinkingNormalize.ts) already enforces ≥1024 for explicit-thinking
    // providers, so the value flowing in is either undefined or valid.
    let thinkingConfig: { type: 'enabled'; budget_tokens: number } | undefined
    if (callOpts.thinkingBudget && callOpts.thinkingBudget > 0) {
      if (capabilities.supportsThinking) {
        thinkingConfig = {
          type: 'enabled',
          budget_tokens: callOpts.thinkingBudget,
        }
      } else {
        warnOnce(
          `thinking:${model}`,
          `thinkingBudget set but model ${model} does not support thinking; ignoring.`,
        )
      }
    }

    // Interleaved thinking is the only knob that requires the beta endpoint.
    let useBetaStream = false
    if (callOpts.interleavedThinking) {
      if (capabilities.supportsInterleavedThinking) {
        useBetaStream = true
      } else {
        warnOnce(
          `interleaved:${model}`,
          `interleavedThinking set but model ${model} does not support it; ignoring.`,
        )
      }
    }

    // Anthropic enforces max_tokens > thinking.budget_tokens. Bump to a safe
    // margin when thinking is enabled.
    const baseMaxTokens = callOpts.maxOutputTokens ?? 16_384
    const max_tokens = thinkingConfig
      ? Math.max(baseMaxTokens, thinkingConfig.budget_tokens + THINKING_MAX_TOKENS_HEADROOM)
      : baseMaxTokens

    const commonBody = {
      model,
      max_tokens,
      system: systemField,
      messages: messages as MessageParam[],
      ...(anthropicTools?.length && { tools: anthropicTools }),
      ...(thinkingConfig && { thinking: thinkingConfig }),
    }

    // Branch on stream factory. Both endpoints accept the same body fields we
    // use; only the beta endpoint accepts the `betas` header. Cast through
    // `unknown` because the SDK's Beta* type aliases differ from the non-beta
    // ones structurally even though the fields we send are identical.
    const stream = useBetaStream
      ? client.beta.messages.stream(
          {
            ...commonBody,
            betas: [INTERLEAVED_THINKING_BETA],
          } as unknown as Parameters<typeof client.beta.messages.stream>[0],
          { signal },
        )
      : client.messages.stream(commonBody, { signal })

    let stopReason: string | null = null
    let outputTokens: number | undefined
    let inputTokens: number | undefined

    for await (const event of stream) {
      const raw = event as unknown as RawStreamEvent
      yield raw

      if (raw.type === 'message_start' && raw.message.usage) {
        inputTokens = raw.message.usage.input_tokens
        outputTokens = raw.message.usage.output_tokens
      }
      if (raw.type === 'message_delta') {
        stopReason = raw.delta.stop_reason
        if (raw.usage) outputTokens = raw.usage.output_tokens
      }
    }

    return {
      stopReason,
      model,
      inputTokens,
      outputTokens,
    }
  }
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

const MODELS: readonly ModelEntry[] = [
  {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    label: 'Claude Opus 4.7',
    description: 'Highest capability',
    maxContextTokens: CONTEXT_1M,
    maxOutputTokens: OUTPUT_128K,
    supportsThinking: true,
    supportsInterleavedThinking: true,
    promptCacheModel: 'explicit',
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    description: 'Balanced',
    maxContextTokens: CONTEXT_1M,
    maxOutputTokens: OUTPUT_64K,
    supportsThinking: true,
    supportsInterleavedThinking: true,
    promptCacheModel: 'explicit',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    description: 'Fastest, cheapest',
    maxContextTokens: CONTEXT_200K,
    maxOutputTokens: OUTPUT_64K,
    supportsThinking: true,
    supportsInterleavedThinking: false,
    promptCacheModel: 'explicit',
  },
]

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  displayName: 'Anthropic',
  envKeyName: 'ANTHROPIC_API_KEY',
  models: MODELS,
  createCallModel: createAnthropicCallModel,
}
