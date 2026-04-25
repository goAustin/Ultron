/**
 * WebSearch backend abstraction (Phase 6b).
 *
 * Backends are resolved at tool-call time, not at boot — keys can be set
 * after engine start. Resolution order (first match wins):
 *
 *   1. BRAVE_SEARCH_API_KEY env var       → Brave
 *   2. TAVILY_API_KEY env var             → Tavily
 *   3. settings.json webSearch.apiKeys.*  → Brave or Tavily (opt-in fallback)
 *   4. fallthrough                        → DuckDuckGo HTML (no key)
 *
 * Env-var-first ensures the documented "set one variable" UX is the
 * primary path. Settings-file fallback exists so `/web setup` does not
 * have to direct users to edit shell init files. Settings keys are
 * plaintext at rest; the file is mode 0600 (see settingsConfig.ts).
 */

import { readSettingsConfig } from '../config/settingsConfig.js'
import { createDuckDuckGoBackend } from './backends/duckduckgo.js'
import { createBraveBackend } from './backends/brave.js'
import { createTavilyBackend } from './backends/tavily.js'

export type SearchResult = {
  readonly title: string
  /**
   * Result destination URL. For DuckDuckGo, this is the unwrapped target
   * (after percent-decoding `uddg`), not the wrapper redirect URL.
   */
  readonly url: string
  readonly snippet: string
  /**
   * False when the backend could not extract the real target (e.g. DDG
   * returned a non-redirect link). Callers may surface or filter these.
   */
  readonly unwrapped?: boolean
}

export type SearchBackendId = 'duckduckgo' | 'brave' | 'tavily'
export type SearchBackendSource = 'env' | 'settings' | 'default'

export type SearchOptions = {
  readonly signal: AbortSignal
  readonly limit?: number
}

export type SearchBackend = {
  readonly id: SearchBackendId
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>
}

export type ResolvedBackend = {
  readonly backend: SearchBackend
  readonly source: SearchBackendSource
}

/**
 * Resolve the active backend based on env vars + settings.json fallback.
 * Env-var-first: if both env and settings have a Brave key, env wins.
 */
export function resolveSearchBackend(): ResolvedBackend {
  const envBrave = process.env.BRAVE_SEARCH_API_KEY?.trim()
  if (envBrave) {
    return { backend: createBraveBackend(envBrave), source: 'env' }
  }

  const envTavily = process.env.TAVILY_API_KEY?.trim()
  if (envTavily) {
    return { backend: createTavilyBackend(envTavily), source: 'env' }
  }

  const settings = readSettingsConfig()
  const settingsBrave = settings.webSearch?.apiKeys?.brave?.trim()
  if (settingsBrave) {
    return { backend: createBraveBackend(settingsBrave), source: 'settings' }
  }

  const settingsTavily = settings.webSearch?.apiKeys?.tavily?.trim()
  if (settingsTavily) {
    return { backend: createTavilyBackend(settingsTavily), source: 'settings' }
  }

  return { backend: createDuckDuckGoBackend(), source: 'default' }
}
