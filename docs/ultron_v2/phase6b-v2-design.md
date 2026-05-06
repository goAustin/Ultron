# Phase 6b Design: WebSearch + `/web` Slash + Settings.json Seeding

## Status

Pre-implementation. Approved plan: `~/.claude/plans/now-make-a-plan-pure-dream.md`.

## Context

Phase 6a paved the **domain-policy substrate**: `PermissionRule.domain`, `Tool.getDomain`, `findMatchingRules(rules, toolName, toolPath, toolHost)`, and one concrete consumer — `WebFetchTool`. 6a deliberately left three things to 6b:

1. **A second consumer** of the domain seam (`WebSearchTool`) — proves the seam is generic, not WebFetch-shaped.
2. **An imperative rule-management surface** (`/web` slash command). Today the only path for a domain rule into AppState is `allow_by_rule` during a tool prompt. Users need a way to add, remove, and inspect rules ahead of time, plus a way to make rules durable across restarts.
3. **Boot-time persistence.** Session-scoped rules vanish on restart; `~/.ultron/settings.json` is the durable store, loaded once at engine init.

**The user-stated design driver:** *"make configurations simple. A user trying web search for the first time should not need to set anything up."*

That single line is the entire shape of this phase. WebSearch must work with zero configuration. Any backend choice that requires an API key for first use is disqualified as the default. Better backends are a deliberate upgrade, not a prerequisite.

## Goals

1. WebSearch returns useful results on a fresh install — no env var, no edited file, no signup.
2. Users who want better quality opt in by setting one env var. Backend selection is automatic and obvious.
3. Domain rules created during a session can be made durable with one flag (`--persist`).
4. Persisted rules survive engine restart and seed `appState.permissionRules` at boot.
5. The `/web` command is the single entry point for inspecting and editing web policy without leaving Ultron.

## Non-goals (mirrors v2-ROADMAP §6b "Does NOT do")

- Browser automation.
- Authenticated fetch (still anonymous-only, GET-only — same posture as 6a).
- Multiple search providers active simultaneously. One backend at a time, resolved at tool-call time.
- Defense against PreToolUse hook URL rewrites (deferred per 6a — cross-tool re-auth-on-mutation is a future phase).
- Robots.txt respect, custom request headers, POST/PUT/DELETE.
- Settings-file schema migration. v1 schema only; future versions will gate on `schemaVersion`.

## First-time UX (the load-bearing decision)

### Backend resolution order

Evaluated at every WebSearch call (not at boot — keys can be set after engine starts). First match wins:

| # | Source | Backend |
|---|---|---|
| 1 | `BRAVE_SEARCH_API_KEY` env var | Brave Search API |
| 2 | `TAVILY_API_KEY` env var | Tavily |
| 3 | `webSearch.apiKeys.brave` in `~/.ultron/settings.json` | Brave *(opt-in fallback only)* |
| 4 | `webSearch.apiKeys.tavily` in `~/.ultron/settings.json` | Tavily *(opt-in fallback only)* |
| 5 | (none of the above) | DuckDuckGo HTML endpoint *(default; no key)* |

The env var **is** the configuration. There is no `WEBSEARCH_PROVIDER=brave` selector — if the user wants Brave, they set one variable.

### Why DuckDuckGo as the no-key default

| Backend | Free tier | API key | Rate limit | Verdict |
|---|---|---|---|---|
| Brave Search | 2000 q/mo | yes | hard cap | excellent quality but disqualified as default |
| Tavily | 1000 q/mo | yes | hard cap | AI-tuned, also disqualified |
| Bing | 1000 q/mo | yes | hard cap | disqualified |
| Google CSE | 100 q/day | yes | hard cap | disqualified |
| DuckDuckGo HTML | unlimited | **no** | soft (per-IP throttle) | **default** |
| DuckDuckGo Instant Answer API | unlimited | no | soft | too narrow (Wikipedia-style only) |

DDG HTML is the only no-key option that returns a usable ranked result list. Quality is below Brave/Tavily but adequate for "did this thing exist" / "find the docs" / "what's the canonical URL" lookups. Users with stronger needs upgrade.

The HTML endpoint is `https://html.duckduckgo.com/html/?q=<query>`. It is intended for accessibility / no-JS clients — not deeply ToS-sensitive in the way the JSON API is. Reasonable polite-client behavior (User-Agent, no high-volume bursts) is sufficient. If DDG starts blocking the endpoint at any point, the upgrade path (env var → Brave) is one line for the user.

### Security note on settings-file API keys

`~/.ultron/settings.json` is **plaintext at rest**. The settings-file fallback (rows 3 and 4 above) exists only because `/web setup` would otherwise be forced to direct users to edit shell init files — a worse experience for users who don't routinely edit `~/.zshrc`. To keep the convenience without dropping all guardrails:

- Persistence is **opt-in**, never default.
- The `/web setup` flow recommends env vars first and presents settings-file persistence as a less-safe alternative.
- The persistence prompt defaults to **No**.
- The file is written with mode `0600` (owner read/write only). `chmodSync` runs on the tmp file *before* the atomic rename so the file is never on disk with broader permissions.

Env vars remain the strongly preferred path. The settings-file path exists so the answer to "how do I configure web search" is never "open this file in a text editor."

### First-time message

Printed once per session on the first WebSearch invocation when DDG is selected:

```
[WebSearch] Using DuckDuckGo (no API key set). For higher quality results,
set BRAVE_SEARCH_API_KEY (free tier: brave.com/search/api) or TAVILY_API_KEY
(free tier: tavily.com), then restart Ultron.
```

The notice does not include the user's query or any key material. Dedup is via a session-scoped flag — see "Event emission mechanism" below.

### `/web setup` interactive flow

```
$ /web setup
Web search backend selection:
  [1] DuckDuckGo (no key, default)        ← currently active
  [2] Brave  (recommended: 'export BRAVE_SEARCH_API_KEY=...' in your shell)
  [3] Tavily (recommended: 'export TAVILY_API_KEY=...' in your shell)
Choice [1-3, default 1]: 2

Recommended: paste this into your shell rc file and restart:
  export BRAVE_SEARCH_API_KEY="..."

Or persist to ~/.ultron/settings.json (plaintext at rest, mode 0600)?
This is convenient but less safe than an env var. [y/N]: y
Paste key: ********
✓ Saved with mode 0600. Restart Ultron to use Brave.
```

Default answer for the persistence prompt is **No**.

## Architecture overview

```
┌─────────────────┐      ┌──────────────────────────────────┐
│ WebSearchTool   │─────▶│ resolveSearchBackend()           │
│ (call())        │      │  reads env vars, falls back to   │
└─────────────────┘      │  settings.json, else DuckDuckGo  │
        │                └──────────────────────────────────┘
        │                              │
        │                              ▼
        │                ┌──────────────────────────────────┐
        │                │ SearchBackend                    │
        │                │   { id, search(query, opts) }    │
        │                └──────────────────────────────────┘
        │                              │
        │                ┌─────────────┼─────────────┐
        │                ▼             ▼             ▼
        │           duckduckgo       brave        tavily
        │                │
        │                ▼
        │          fetchWeb (6a) → htmlToText (6a) → uddg unwrap
        │
        └─▶ getDomain(input) returns undefined.
            Search queries aren't host-scoped; per-result host
            gating happens when the model invokes WebFetch on a
            result.url, flowing through the existing 6a cascade.

┌─────────────────────────────────────────────────────────────┐
│ /web slash command                                          │
│   [bare] | search <q> | list | rules | help                 │
│   allow <host> [--persist] | deny <host> [--persist]        │
│   remove <host>                                             │
│   setup (interactive backend chooser)                       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ ~/.ultron/settings.json (new, mode 0600)                    │
│   { schemaVersion: 1,                                       │
│     webSearch: { apiKeys: { brave?, tavily? } },            │
│     webPolicy: { allowlist: string[], denylist: string[] }, │
│     permissionRules: PermissionRule[]   ← seeded at boot    │
│   }                                                         │
└─────────────────────────────────────────────────────────────┘
```

## Key design decisions

### `WebSearch.getDomain` returns `undefined`

A search query is not host-scoped. There is no single host that "the search" targets — DDG/Brave/Tavily resolve queries on their own domain, and the user-meaningful hosts are in the *results*. Domain rules created via `/web allow <host>` therefore apply to **`WebFetch`**, not to `WebSearch`. The flow is:

1. Model calls `WebSearch{query}` → tool runs against the configured backend (DDG by default) → returns a list of `{title, url, snippet}`.
2. Model decides to read a result → calls `WebFetch{url}` → 6a cascade fires with `getDomain` returning the result's host → host-scoped rules apply.

A whole-tool rule on WebSearch (e.g. *"deny WebSearch entirely"*) is a non-domain rule: `{toolName: 'WebSearch', behavior: 'deny'}`. This goes through the standard permission UX, not `/web` — `/web` is specifically a *web policy* surface (per-host rules), not a *tool toggle* surface.

### No new cascade steps

WebSearch participates by being in the registry. The cascade is unchanged. WebSearch is subject to:
- a deny rule on `WebSearch` (admin disables the tool);
- a skill's `allowed-tools` (Phase 5b) — if the active skill doesn't list WebSearch, calls deny;
- the standard ask-on-first-use flow (since `checkPermissions` returns `{behavior:'allow'}` and there's no domain to match, the cascade falls through to fallback-ask the first time).

### Settings file is durable; AppState is runtime

Two-layer split:

| Layer | Lives | Mutated by | Survives restart |
|---|---|---|---|
| `appState.permissionRules` | memory | `allow_by_rule`, `/web allow` | no |
| `~/.ultron/settings.json::permissionRules` | disk | `/web allow --persist`, `/web deny --persist`, `/web remove` | yes |

Boot reads settings → seeds AppState. `allow_by_rule` (pressing the prompt button) writes session-only — matches today's behavior. `--persist` is the explicit promotion from session → durable.

### Env-var-first, settings-file is opt-in fallback

Mirrors how provider keys work today (`ANTHROPIC_API_KEY` etc., `src/core/providers/types.ts:46-52`). When both sources disagree, env wins — there is no surprise where the user thinks they updated their key but the engine still uses the old one.

### DuckDuckGo HTML uses existing `fetchWeb` + `htmlToText`

Reuse, don't reimplement. SSRF protection, DNS-class block, redirect re-check, content-type allowlist, 30 s wall-clock timeout, 5 MB body cap — all from 6a's fetcher. Free.

### DDG redirect URL unwrapping (critical correctness point)

DDG's HTML endpoint wraps every result href as:

```
https://duckduckgo.com/l/?uddg=<percent-encoded-target>&rut=...
```

If the backend reports `result.url = 'https://duckduckgo.com/l/?uddg=...'` to the tool's caller, two things break:

1. **The model sees opaque URLs** — every result starts `https://duckduckgo.com/l/...`, which is uninformative.
2. **WebFetch domain rules are useless** — the model calls `WebFetch{url}` with the wrapper URL, `getDomain` returns `duckduckgo.com`, and any host-scoped rule the user wrote (`/web deny evil.com`) cannot fire because the wrapper URL doesn't carry `evil.com`.

The backend must extract and percent-decode `uddg` so `result.url` is the actual destination. If `uddg` is absent or unparseable for a given result (DDG sometimes returns a few "non-redirect" links), the parser falls back to the wrapper URL and flags `unwrapped: false` — never silently keeps a wrapper as if it were the target.

### Event emission mechanism

Tools today have no general event channel. `ToolUseContext` exposes `appState`, `toolRegistry`, etc. — nothing for emitting one-time notices or audit events from inside a tool. Phase 6b extends `ToolUseContext` with a single method:

```typescript
notify(event: NotifyEvent): void
```

`NotifyEvent` is a typed discriminated union; the only initial member is:

```typescript
{ type: 'web_backend_resolved'; backend: 'duckduckgo' | 'brave' | 'tavily'; source: 'env' | 'settings' | 'default' }
```

The CLI runtime threads a `notify` implementation that:

1. Emits the corresponding `QueryEvent` through the audit spine (so `auditLog.ts` records it).
2. Renders user-facing one-time notices to stderr if the event type warrants it.
3. Dedups via a per-session `Set<string>` keyed by `event.type` (the one-shot semantics of `web_backend_resolved` is enforced here, not in the tool — keeps the tool side stateless).

Tests pass a no-op `notify`. This keeps tools pure (no direct `process.stderr` writes, no direct audit-log access) while giving them a sanctioned channel for cross-cutting events.

## Settings.json schema

```typescript
type SettingsConfig = {
  schemaVersion?: 1
  webSearch?: {
    apiKeys?: {
      brave?: string
      tavily?: string
    }
  }
  webPolicy?: {
    allowlist?: string[]    // host or *.suffix patterns
    denylist?: string[]
  }
  permissionRules?: PermissionRule[]
}
```

Example after a user runs `/web allow github.com --persist`:

```json
{
  "schemaVersion": 1,
  "permissionRules": [
    {
      "toolName": "WebFetch",
      "behavior": "allow",
      "domain": "github.com",
      "source": "userSettings"
    }
  ]
}
```

Example after `/web setup` writes a Brave key:

```json
{
  "schemaVersion": 1,
  "webSearch": { "apiKeys": { "brave": "BSA..." } }
}
```

Both fields can coexist; the schema is additive.

## Schema-aware merge (not shallow)

`userConfig.ts`'s shallow merge would erase nested siblings. If the user has `webSearch.apiKeys.tavily` set and we do a shallow merge to write `webSearch.apiKeys.brave`, the shallow merge replaces the entire `webSearch` object and `tavily` is lost.

`writeSettingsConfig(partial: DeepPartial<SettingsConfig>)` uses **per-field strategy**:

| Field | Strategy on write |
|---|---|
| `webSearch.apiKeys.{brave,tavily}` | spread-merge — writing one preserves the other |
| `webPolicy.{allowlist,denylist}` | replace the array if present in partial; leave alone if absent |
| `permissionRules` | replace the array if present in partial; leave alone if absent |
| Top-level keys absent from partial | preserved untouched |

The merge function is small (one function in `settingsConfig.ts`, no dep on a deep-merge library). Tests cover the key non-clobber cases.

## Boot-time seeding

In `src/sdk/QueryEngine.ts` constructor, after AppState is created (~L246):

```typescript
const settings = readSettingsConfig()
const seededRules = validateAndNormalizeRules(settings.permissionRules ?? [])
const seededFromPolicy = compileWebPolicy(settings.webPolicy)
const allRules = dedupeRules([...seededRules, ...seededFromPolicy])
if (allRules.length > 0) {
  this.appState.setState({ permissionRules: allRules })
}
```

### `validateAndNormalizeRules` contract

Boot must never throw. Each entry:

- Validate: `behavior ∈ {allow, deny, ask}`, `source ∈ PermissionRuleSource`, `toolName` non-empty string, `domain` (if present) passes `isValidDomainPattern`, `path` (if present) non-empty string.
- Normalize: lowercase `domain`, trim `toolName`, default missing `source` to `'userSettings'`.
- On invalid entry: emit one stderr warning naming the offending field, skip the entry, continue.

### `compileWebPolicy`

Translates `webPolicy.{allowlist,denylist}` to domain-scoped rules over `WebFetch`:

- `allowlist: ['github.com']` → `[{toolName:'WebFetch', behavior:'allow', domain:'github.com', source:'userSettings'}]`
- `denylist: ['evil.com', '*.tracker.com']` → corresponding deny rules

Each entry validated via `isValidDomainPattern`, lowercased. Invalid entries warn + skip.

### `dedupeRules`

Removes duplicates by `(toolName, behavior, path?, domain?)` tuple. Preserves order — first occurrence wins. This guards against:

- A `permissionRules` entry that duplicates a `webPolicy.allowlist` entry.
- Repeated `/web allow github.com --persist` invocations.

## URL canonicalization (lives in this phase per roadmap)

These tests verify the policy layer can't be bypassed by URL trickery. Most are inherited from 6a's `validateInput` posture; documented here because the roadmap explicitly assigns them to 6b.

| Input | Behavior | Why |
|---|---|---|
| `https://github.com@evil.com/x` | `validateInput` rejects ("URLs with userinfo are not supported") | Userinfo can confuse host extraction; reject upstream |
| `https://gіthub.com` (Cyrillic 'і') | `extractHost` returns the IDN host as-is; rule `github.com` does not match | Documented: punycode/IDN match is the user's responsibility — Ultron doesn't auto-canonicalize, since silent canonicalization would surprise users who genuinely want to allow a Cyrillic-named host |
| `https://github.com/%2e%2e/foo` | percent-decodes to `..` in path; host layer unaffected | Path traversal is a per-tool concern (filesystem layer), not host policy |
| `https://GITHUB.COM/foo` | `extractHost` lowercases → `github.com`; rule `github.com` matches | Standard host case-insensitivity |
| `https://github.com:443/foo` | port stripped by `extractHost` → `github.com` | Default HTTPS port; matches |
| `https://github.com:8443/foo` | `extractHost` returns `github.com` (port stripped); domain rule matches by host alone | Port-scoped rules are not in scope; documented limitation |

## Files

### New

| Path | Purpose |
|---|---|
| `src/web/searchBackend.ts` | `SearchBackend` interface + `SearchResult` type + `resolveSearchBackend()` |
| `src/web/backends/duckduckgo.ts` | DDG HTML endpoint via `fetchWeb`; result parser; `uddg` unwrap |
| `src/web/backends/brave.ts` | Brave Search API wrapper |
| `src/web/backends/tavily.ts` | Tavily API wrapper |
| `src/web/searchBackend.test.ts` | Resolver precedence tests |
| `src/web/backends/duckduckgo.test.ts` | Recorded-fixture parsing + `uddg` unwrap test |
| `src/tools/WebSearchTool.ts` | The tool (`query` input, formatted result list) |
| `src/tools/WebSearchTool.test.ts` | Validation, abort, error surfacing, notify dedup |
| `src/cli/webCommand.ts` | `handleWebCommand(input, engine, io)` mirroring `memoryCommand.ts` |
| `src/cli/webCommand.test.ts` | Subcommand dispatch + persistence |
| `src/config/settingsConfig.ts` | Sync read/write for `~/.ultron/settings.json`; schema-aware merge; `0600` mode |
| `src/config/settingsConfig.test.ts` | Round-trip, ENOENT, malformed JSON, non-clobber merge, mode 0600 |
| `tests/integration/web-search.test.ts` | End-to-end: WebSearch + cascade + seeded denylist |
| `tests/integration/web-slash.test.ts` | `/web allow X --persist` survives engine restart |

### Modified

| Path | Change |
|---|---|
| `src/core/tools/registry.ts` | `registry.register(WebSearchTool)` between WebFetchTool and AgentTool |
| `src/sdk/QueryEngine.ts` | Constructor seeds `appState.permissionRules` from `readSettingsConfig`; expose `settingsBaseDir` getter |
| `src/cli.ts` | Import + dispatch `/web` (mirroring `/memory` block ~L226–243); add `/web` to startup banner ~L351 |
| `src/core/queryEvents.ts` | `+WebBackendResolvedEvent` discriminant |
| `src/core/queryEventFactories.ts` | `+makeWebBackendResolvedEvent` |
| `src/core/tools/context.ts` | `+notify(event: NotifyEvent): void` on `ToolUseContext`; tests pass no-op |
| `src/audit/auditLog.ts` | `+SHOULD_AUDIT['web_backend_resolved']` |

### Reused (no modification)

- `src/web/domainPolicy.ts` — `extractHost`, `isValidDomainPattern`, `matchDomain` (used by `/web` arg validation and rule normalization)
- `src/web/fetcher.ts` — `fetchWeb` powers the DDG backend's HTML fetch
- `src/web/htmlToText.ts` — strips HTML for DDG result snippets
- `src/core/permissions/permissions.ts` — `findMatchingRules` powers WebSearch's policy closure (same pattern as `WebFetchTool.ts:88-95`)
- `src/cli/memoryCommand.ts` — structural template for `webCommand.ts`
- `src/config/userConfig.ts` — sync read/write template for `settingsConfig.ts` (test seam pattern)

## Implementation order

Each step is independently shippable and reviewable.

1. **Design doc.** This file. Written before any code lands (per durable feedback note).
2. **`src/config/settingsConfig.ts` + tests.** Schema-aware merge, atomic write, mode 0600, test seam.
3. **Search backend abstraction + DuckDuckGo backend.** `resolveSearchBackend` resolver, DDG HTML parser, `uddg` unwrap.
4. **Brave + Tavily backends.** JSON-API wrappers, typed errors.
5. **`WebSearchTool`.** Tool definition; `query` validation; `notify` emission on first call.
6. **Register WebSearchTool.** One-line add to `createDefaultRegistry`.
7. **`/web` slash command.** All subcommands, persistence flow, `/web setup` interactive UX.
8. **QueryEngine boot-time seeding.** `validateAndNormalizeRules`, `compileWebPolicy`, `dedupeRules`; `settingsBaseDir` getter.
9. **CLI dispatch + banner.** Mirror `/memory` block.
10. **Audit event.** `web_backend_resolved` event + `SHOULD_AUDIT` entry; verify the `notify` channel routes correctly to both stderr (one-shot) and audit (every emission).

## Verification

### Unit tests

- `searchBackend.test.ts` — env precedence (Brave env wins over Tavily env wins over settings wins over DDG); settings ignored when env present.
- `duckduckgo.test.ts` — recorded HTML fixture parses to N results; `uddg` unwrap correct; missing `uddg` falls back without misreporting host.
- `WebSearchTool.test.ts` — empty/oversized query rejects; aborted signal returns `errorKind:'aborted'`; backend errors surface as `errorKind:'execution_error'`; first call emits one `web_backend_resolved`, second call does not (dedup).
- `webCommand.test.ts` — each subcommand dispatch; `/web search foo` runs the tool's call path; `/web allow evil.com` writes a `WebFetch` (not WebSearch) domain rule to AppState; `--persist` writes settings.json with mode 0600; invalid host rejects clearly; double-allow produces single rule.
- `settingsConfig.test.ts` — round-trip; ENOENT returns `{}`; malformed JSON warns + returns `{}`; concurrent writes don't corrupt; **schema-aware merge — writing `webSearch.apiKeys.brave` does not erase `tavily` or top-level siblings**; written file mode is `0600`.
- `validateAndNormalizeRules.test.ts` — invalid `behavior` skipped with warning; uppercase `domain` lowercased; missing `source` defaulted; one bad entry doesn't poison the rest.

### Integration tests

- `tests/integration/web-search.test.ts` — seed `settings.json` with `{webPolicy:{denylist:['evil.com']}}`; boot engine; invoke WebSearch; have a mocked model try to WebFetch a denied host from a result — cascade denies at the deny rule.
- `tests/integration/web-slash.test.ts` — `/web allow github.com --persist`; tear down engine; reinit; verify rule present in `appState.permissionRules` without prompting; two consecutive WebSearch calls share session state.

### Manual smoke

1. `rm ~/.ultron/settings.json`. `npm start`. `/web` → "backend: duckduckgo (default)".
2. Without setting env vars, run a query that triggers WebSearch. Results appear; first-time `[WebSearch] Using DuckDuckGo...` notice appears once.
3. `export BRAVE_SEARCH_API_KEY=...`, restart. Banner: "backend: brave (env)".
4. `/web allow github.com --persist`. `cat ~/.ultron/settings.json` shows the rule. Restart. `/web rules` shows it without prompting.
5. `/web setup` → choose Brave → answer No to persistence → flow exits cleanly with the env-var instruction printed.

## Open questions (resolve during implementation, not blocking design)

1. Should the DDG backend pass `kl=us-en` (region/language) by default? Probably yes for result consistency in tests.
2. Brave's `count` parameter caps at 20. Tavily's `max_results` caps at 10. Pick the lower for our `limit` upper bound (10) for cross-backend parity.
3. Should `/web search` also respect the active skill's `allowed-tools`? Yes — the `/web search` path runs the same tool, so skill scope applies identically. Document this.

## Out of scope (mirrors v2-ROADMAP §6b)

- Browser automation.
- Authenticated fetch.
- Multiple search providers active simultaneously.
- Defense against PreToolUse hook URL rewrites (deferred per 6a).
- Robots.txt respect, custom request headers, POST/PUT/DELETE.
- Settings-file schema migration.
