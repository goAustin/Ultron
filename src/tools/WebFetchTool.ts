/**
 * WebFetchTool — fetch the contents of an HTTPS URL.
 *
 * Read-only, GET-only, anonymous. HTTPS-only. Domain-scoped permissions
 * via the cascade's `findMatchingRules` (Phase 6a).
 *
 * The tool is a thin wrapper around `fetchWeb` from `src/web/fetcher.ts`.
 * The interesting choice in this file is the `checkPolicy` closure passed
 * to the fetcher: it consults the same `findMatchingRules` the cascade
 * uses, so first-hop and redirect-hop policy checks share semantics with
 * the authorization step. No hand-rolled rule filtering.
 */

import { buildTool } from '../core/tools/types.js'
import { findMatchingRules } from '../core/permissions/permissions.js'
import { extractHost } from '../web/domainPolicy.js'
import { fetchWeb } from '../web/fetcher.js'
import { htmlToText } from '../web/htmlToText.js'

const DESCRIPTION = [
  'Fetch the contents of an HTTPS URL. Returns the response body as text',
  '(HTML stripped). Read-only, no JavaScript execution. Subject to per-host',
  'permission rules.',
].join(' ')

export const WebFetchTool = buildTool({
  name: 'WebFetch',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full HTTPS URL to fetch (must start with https://)',
      },
    },
    required: ['url'],
  },
  isMutating: false,
  isConcurrencySafe: () => true,
  getDomain: (input) => {
    const url = typeof input.url === 'string' ? input.url : ''
    return extractHost(url) ?? undefined
  },

  async validateInput(input) {
    if (typeof input.url !== 'string' || input.url.trim() === '') {
      return { valid: false, message: 'url must be a non-empty string' }
    }
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      return { valid: false, message: 'url is not a valid URL' }
    }
    if (parsed.protocol !== 'https:') {
      return { valid: false, message: 'only https:// URLs are supported' }
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return { valid: false, message: 'URLs with userinfo are not supported' }
    }
    if (/^localhost$|\.local$|\.internal$/i.test(parsed.hostname)) {
      return {
        valid: false,
        message: 'localhost / .local / .internal hosts are not supported',
      }
    }
    return { valid: true }
  },

  async checkPermissions(input) {
    const url = typeof input.url === 'string' ? input.url : ''
    const host = extractHost(url)
    if (host === null) return { behavior: 'deny', message: 'invalid URL' }
    return { behavior: 'allow' }
  },

  async call(input, context, signal) {
    const url = input.url as string
    const appState = context.appState

    // Reuse cascade rule order: deny > ask > allow > fallback ask. Mirrors
    // permissions.ts:65,89,135,142 so a redirect re-check produces the same
    // decision the cascade would.
    //
    // Used by fetchWeb on REDIRECT hops only — the first hop is trusted
    // because the cascade already authorized this exact input.
    const checkPolicy = (host: string): 'allow' | 'deny' | 'ask' => {
      const rules = appState.getState().permissionRules
      const matching = findMatchingRules(rules, 'WebFetch', undefined, host)
      if (matching.find((r) => r.behavior === 'deny')) return 'deny'
      if (matching.find((r) => r.behavior === 'ask')) return 'ask'
      if (matching.find((r) => r.behavior === 'allow')) return 'allow'
      return 'ask'
    }

    try {
      const result = await fetchWeb(url, {
        signal,
        checkPolicy,
      })

      const isHtml = /^(text\/html|application\/xhtml\+xml)\b/i.test(result.contentType)
      const body = isHtml ? htmlToText(result.body) : result.body

      const lines: string[] = [`URL: ${url}`]
      if (result.redirectChain.length > 1) {
        lines.push(`Followed redirects: ${result.redirectChain.join(' \u2192 ')}`)
      }
      lines.push(`Status: ${result.status}`)
      lines.push(`Content-Type: ${result.contentType}`)
      lines.push('')
      lines.push(body)
      if (result.truncated) lines.push('[truncated at 5 MB]')

      return { content: lines.join('\n'), isError: false }
    } catch (err) {
      if (signal.aborted) {
        return { content: '[aborted]', isError: true, errorKind: 'aborted' }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: msg, isError: true, errorKind: 'execution_error' }
    }
  },
})
