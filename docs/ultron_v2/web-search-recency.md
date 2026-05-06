# WebSearch Recency Filter (Step A)

## Context

A user transcript ("find the latest Jensen Huang interview") surfaced a
freshness gap: the model used `WebSearch`, accepted a result published
~11 months earlier, and treated it as the "latest" interview. The model
in question (gpt-5.4-mini) is not strong at applying its own freshness
discipline, and the tool surface does not currently expose any way to
constrain results by date — so even an instructed model would have no
lever to pull.

This change closes the gap by:
1. Exposing a typed `recency` parameter on `WebSearch`.
2. Plumbing it through every backend that supports a date filter.
3. Adding a system-prompt rule so the model defaults to setting it on
   "latest / newest / recent / current" queries.

A follow-up "Step B" (out of scope here) would also extract per-result
publish dates from Brave/Tavily and surface them in the result text so
the model can rank by date. Step A on its own is sufficient to fix the
reported case: the API itself will exclude stale results.

## Backend support

| Backend | Mechanism | Where |
| --- | --- | --- |
| Tavily | `time_range: "day" \| "week" \| "month" \| "year"` in the JSON request body | `src/web/backends/tavily.ts:56` |
| Brave | `freshness=pd \| pw \| pm \| py` URL param | `src/web/backends/brave.ts:55` |
| DuckDuckGo | No native filter; HTML scraping endpoint accepts a Google-style `after:YYYY-MM-DD` operator we prepend to the query | `src/web/backends/duckduckgo.ts:47` |

DuckDuckGo's `after:` operator is best-effort — DDG honors it but does
not document it. It is materially better than ignoring `recency`
entirely (which would silently produce stale results on the zero-config
default backend).

## File plan

| File | Change |
| --- | --- |
| `src/web/searchBackend.ts` | Add `Recency` type alias and optional `recency` field on `SearchOptions` |
| `src/tools/WebSearchTool.ts` | Add `recency` to input schema, validate, thread into `backend.search` |
| `src/web/backends/tavily.ts` | When `opts.recency` set, add `time_range` to JSON body |
| `src/web/backends/brave.ts` | Map `day→pd / week→pw / month→pm / year→py`, append `freshness` URL param |
| `src/web/backends/duckduckgo.ts` | When `opts.recency` set, prepend `after:YYYY-MM-DD` (computed against `Date.now()`) to the query |
| `src/context/systemPrompt.ts` | New `webSearchGuidanceSection()` with the routing rule |
| `src/tools/WebSearchTool.test.ts` | Validation cases + threading via mock backend |
| `src/web/backends/duckduckgo.test.ts` | Assert `after:` operator is appended for each recency value |

## System-prompt rule

Slotted into `usingToolsSection` (always-on, not gated on Computer-Use):

> For "latest / newest / recent / current / today / this week" queries,
> set `WebSearch.recency` (default to `month`; narrow to `week` or `day`
> when the user is more specific). After the search, sanity-check that
> titles/snippets reference dates within that window before reporting an
> answer.

## Verification

```bash
npm run typecheck
npm run test
npx vitest run src/tools/WebSearchTool.test.ts
npx vitest run src/web/backends/duckduckgo.test.ts
```

Manual end-to-end: prompt the same model with "find the latest Jensen
Huang interview" — expect `WebSearch` to be called with
`recency: "month"` (visible in the transcript) and results to fall
inside the last 30 days.
