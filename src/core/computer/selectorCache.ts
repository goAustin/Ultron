/**
 * v3 Phase 4b: per-session atom-cache type + builder.
 *
 * `SessionAtomCache` is the in-memory record `BrowserSession.setAtomCache` /
 * `lookupAtom` / `currentAtomCache` operate on. One cache per session at a
 * time — replaced wholesale by the next `ComputerObserveActions`. AtomIds
 * are scoped to the snapshot they were assigned in; holding multiple
 * historical caches would invite the model to act on stale snapshot ids.
 *
 * Cleared on `ComputerStop` / `BrowserSession.close()` / `BrowserSession.navigate()`.
 *
 * See `docs/ultron_v3/v3-phase4b-design.md`.
 */

import type { AriaTreeSnapshot, BoundingBox } from './ariaSnapshot.js'
import { assignAtomIds, type AtomEntry } from './atomResolver.js'

export type SessionAtomCache = {
  readonly url: string
  readonly ariaHash: string
  readonly entries: ReadonlyMap<string /* atomId */, AtomEntry>
}

export type BuildAtomCacheOptions = {
  /**
   * Bboxes returned by `BrowserSession.getSensitiveRegions(redactionSelectors)`.
   * Forwarded to `assignAtomIds` so user `redactionSelectors` flow into
   * `AtomEntry.displayName` the same way they flow into the screenshot
   * redactor. Optional — when absent, redaction relies on `isSensitiveNode`
   * alone.
   */
  readonly sensitiveRegions?: readonly BoundingBox[]
}

/**
 * Build a `SessionAtomCache` from a snapshot + the page's current URL.
 * Assigns atomIds via `assignAtomIds` and indexes them by `atomId` for O(1)
 * `lookupAtom` reads.
 */
export function buildAtomCache(
  snapshot: AriaTreeSnapshot,
  url: string,
  opts?: BuildAtomCacheOptions,
): SessionAtomCache {
  const entries = assignAtomIds(snapshot, opts?.sensitiveRegions ? { sensitiveRegions: opts.sensitiveRegions } : undefined)
  const map = new Map<string, AtomEntry>()
  for (const e of entries) map.set(e.atomId, e)
  return { url, ariaHash: snapshot.hash, entries: map }
}
