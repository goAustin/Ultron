/**
 * WebSearchTool — search the web for ranked results (Phase 6b).
 *
 * Backend selection is automatic at call time:
 *   - BRAVE_SEARCH_API_KEY env var → Brave
 *   - TAVILY_API_KEY env var      → Tavily
 *   - settings.json keys          → Brave or Tavily (opt-in fallback)
 *   - else                        → DuckDuckGo HTML (zero-config default)
 *
 * Quality varies by backend; the no-key default is intended for "did
 * this thing exist" / "find the docs" lookups. Users with stronger
 * needs upgrade by setting one env var.
 *
 * Permission posture: WebSearch.getDomain returns undefined — search
 * queries aren't host-scoped. Per-result host gating happens when the
 * model later calls WebFetch on a result link, flowing through the
 * existing 6a cascade. A whole-tool deny rule on `WebSearch` disables
 * the tool; that goes through the standard permission UX.
 */

import { buildTool } from '../core/tools/types.js'
import { resolveSearchBackend, type SearchResult } from '../web/searchBackend.js'

const DESCRIPTION = [
  'Search the web. Returns up to `limit` ranked results, each with',
  'title, url, and snippet. Read-only, anonymous. Backend (DuckDuckGo,',
  'Brave, or Tavily) is resolved automatically from environment variables',
  'and ~/.ultron/settings.json.',
].join(' ')

const MAX_QUERY_BYTES = 2048
const MAX_LIMIT = 20

export const WebSearchTool = buildTool({
  name: 'WebSearch',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query.',
      },
      limit: {
        type: 'number',
        description: 'Max number of results (1–20, default 10).',
      },
    },
    required: ['query'],
  },
  isMutating: false,
  isConcurrencySafe: () => true,

  async validateInput(input) {
    if (typeof input.query !== 'string' || input.query.trim() === '') {
      return { valid: false, message: 'query must be a non-empty string' }
    }
    if (Buffer.byteLength(input.query, 'utf8') > MAX_QUERY_BYTES) {
      return { valid: false, message: `query exceeds ${MAX_QUERY_BYTES} bytes` }
    }
    if (input.limit !== undefined) {
      if (typeof input.limit !== 'number' || !Number.isFinite(input.limit)) {
        return { valid: false, message: 'limit must be a finite number' }
      }
      if (input.limit < 1 || input.limit > MAX_LIMIT) {
        return { valid: false, message: `limit must be between 1 and ${MAX_LIMIT}` }
      }
    }
    return { valid: true }
  },

  async checkPermissions() {
    return { behavior: 'allow' }
  },

  async call(input, context, signal) {
    const query = input.query as string
    const limit = (input.limit as number | undefined) ?? 10

    const { backend, source } = resolveSearchBackend()

    // Announce backend resolution. The runtime dedups by event type, so
    // emitting on every call is fine; subscribers see at most one stderr
    // notice per session, plus one audit entry per emission.
    context.notify?.({
      type: 'web_backend_resolved',
      backend: backend.id,
      source,
    })

    try {
      const results = await backend.search(query, { signal, limit })
      return { content: formatResults(query, backend.id, results), isError: false }
    } catch (err) {
      if (signal.aborted) {
        return { content: '[aborted]', isError: true, errorKind: 'aborted' }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: msg, isError: true, errorKind: 'execution_error' }
    }
  },
})

export function formatResults(
  query: string,
  backendId: string,
  results: readonly SearchResult[],
): string {
  if (results.length === 0) {
    return `WebSearch: "${query}" (via ${backendId})\n\nNo results.`
  }
  const lines: string[] = [`WebSearch: "${query}" (via ${backendId})`, '']
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
