# Phase 6a Design: WebFetch Tool + Domain Policy Substrate

## Amendments after second review (post-implementation)

Three correctness fixes landed after the first implementation pass. The
body of this doc still describes the original first-hop-check design
inline in places; this section is the canonical source of truth.

1. **First-hop policy check removed from `fetchWeb`.** Reason: it broke
   `allow_once` and `bypassPermissions`. Both authorize without
   persisting a rule, so the closure's rule lookup returned `'ask'` and
   the fetcher threw on the very first hop. The fetcher now skips the
   first hop entirely (the cascade already authorized it) and only
   re-checks redirect hops. Consequence: `WebFetchPolicyError` (the
   first-hop variant) is removed; `WebFetchPolicyRedirectError` stays.
   Known limitation: a PreToolUse hook that rewrites `input.url`
   between authorize and execute slips past per-host policy. Closing
   that gap requires re-authorization on hook input mutation — a
   cross-tool concern that lives in a future phase.
2. **`checkPolicy` closure uses cascade order: deny > ask > allow >
   fallback ask.** Earlier draft skipped the explicit-`ask` branch and
   would `'allow'` a host that had both `ask` and `allow` rules,
   contradicting the cascade. Fixed in
   `src/tools/WebFetchTool.ts::checkPolicy`.
3. **DNS lookup raced against timeout + abort.** Earlier draft awaited
   `lookup(host)` unguarded; a hanging resolver could exceed the 30 s
   contract and ignore cancellation. New `raceWithTimeoutAndAbort`
   helper in `src/web/fetcher.ts` wraps the resolver promise.

A fourth review point ("`webPolicy` substrate missing") was
intentionally rejected — the previous-round amendments removed
`webPolicy` from the design because returning `allow` from
`tool.checkPermissions` does not terminate the cascade. The rules ARE
the policy; settings-file persistence that seeds initial rules is
deferred to 6b.

The rest of the doc reads as originally written; treat any inline
mention of "first-hop check" or `WebFetchPolicyError` as superseded by
this section.

## Context

v2 §6 promises **first-party web tools**: "WebSearch / WebFetch —
gated read-only tools for live lookups, with domain allow/deny lists."
The roadmap places this pillar after the dynamic tool registry (Phase
3), the audit/hooks spine (Phase 2), memory (Phase 4), and skills
(Phase 5) precisely so that any new tool inherits permission gating,
audit emission, hook firing, and skill-allowlist intersection without
extra wiring.

Pillar 6 is three deliverables — web tools, CodeSandbox, attachments
— so it splits naturally:

- **6a** (this phase) — `WebFetchTool` plus the shared **domain
  allow/deny policy** substrate that WebSearch will reuse. One
  concrete consumer paves the policy seam.
- **6b** — `WebSearchTool` on the same domain policy, with the choice
  of search-API provider (Brave / Tavily / Bing / etc.) made there.
- **6c** — `CodeSandbox` (Python/JS execution in an ephemeral
  sandbox).
- **6d** — first-class image / PDF / notebook attachments.

The central architectural questions and their answers:

1. **Where does the domain policy live — extension to
   `PermissionRule`, or a separate config struct in `AppState`?**
   **`PermissionRule` only.** A new optional `domain?: string` field
   on `PermissionRule` lets the cascade match web rules the same way
   it matches file rules today (toolName + path). The earlier draft
   of this design also added a separate `webPolicy: { allowlist;
   denylist }` field on `AppState` as a "bootstrap" surface, but
   that produced a self-contradicting cascade: returning
   `{ behavior: 'allow' }` from `tool.checkPermissions` does **not**
   terminate the cascade (see `permissions.ts:96-109` — the engine
   continues through safety checks, mode, allow rules, and fallback
   ask), so `webPolicy.allowlist` would never actually allow
   anything. The clean model is **the rules ARE the policy**: 6a
   ships an empty default; the user populates via `allow_by_rule`
   answers (which the cascade now persists as domain-scoped session
   rules); 6b adds `~/.ultron/settings.json` loading that seeds
   initial rules at boot. One representation, one cascade, no
   contradiction. Extending `PermissionRule` (~5 LOC) makes WebFetch
   first-class in the cascade and avoids overloading the `path`
   field with hosts.
2. **Default posture — allow-all, deny-all, or ask-by-default?**
   **Ask-by-default.** Mirrors `BashTool`: an unknown URL prompts
   the user the first time, and `allow_by_rule` persists a
   session-scoped allow for that exact host (or a `*.suffix`
   wildcard the user expands manually in settings). No surprise
   network egress; no requirement to pre-populate an allowlist
   before the tool is usable.
3. **Should WebFetch summarize via the model (recursive call) or
   return raw content?**
   **Return body content (post HTML-to-text), no recursive model
   call.** Claude Code's WebFetch tool runs a small fast model on
   the body; that is a UX win but ties the tool boundary to model
   availability and adds a recursive `callModel` invocation. Ultron
   keeps the tool dumb in 6a — fetch, decode, strip, return.
   The orchestrating turn already has full model access; let the
   parent decide what to extract. A future opt-in `summarize: true`
   knob is a strict superset and can land in 6b alongside
   WebSearch.
4. **Scheme posture — HTTPS-only, HTTP allowed, auto-upgrade?**
   **HTTPS-only.** `validateInput` rejects `http://` URLs. Avoids
   downgrade attacks and any need to remember an HTTP→HTTPS upgrade
   path. The UX cost is minor (HTTP-only sites are rare); the
   security cost of a permissive default is much larger.
5. **SSRF — block private/loopback addresses?**
   **Yes, hard block at fetch time.** After DNS resolution, refuse
   to connect to `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`,
   `192.168.0.0/16`, `169.254.0.0/16` (link-local), `0.0.0.0`,
   `::1`, `fc00::/7`, `fe80::/10`, and any non-global IPv6.
   Hostnames `localhost` / `*.local` / `*.internal` rejected at
   `validateInput` before DNS even fires (cheap fail-fast). The
   block is non-bypassable — no permission rule can override it.
   Same posture as `filesystem.ts`'s safety checks.
6. **HTML extraction — ship a converter dependency, or strip by
   hand?**
   **Strip by hand for 6a.** A minimal regex-based pass: drop
   `<script>` / `<style>` / `<noscript>` blocks, replace
   `<br>`/`<p>`/`</h*>` with newlines, strip remaining tags,
   collapse whitespace, decode common HTML entities (`&amp;`,
   `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;`, numeric refs).
   Quality is "good enough for an LLM to read", not pretty for
   humans. Avoids the dependency footprint and `package.json` churn
   for a pillar's first slice. A `turndown` upgrade is a clean
   future swap behind the same `htmlToText(html)` function.
7. **Response size cap and content-type filter?**
   **5 MB cap, accept text-ish only.** Allowed content types:
   `text/*`, `application/json`, `application/xml`,
   `application/xhtml+xml`, `application/javascript`,
   `application/ld+json`. Anything else (binary, image, PDF, ZIP)
   → typed error `WebFetchUnsupportedContentTypeError`. Attachments
   are 6d's job; 6a refuses them rather than mis-handling them.
   The 5 MB cap mirrors `FileReadTool`'s 10 MB cap (web payloads
   are typically smaller; 5 MB is generous for HTML). When a
   response exceeds the cap, the body is truncated at 5 MB and the
   tool result content ends with `\n[truncated at 5 MB]`.
8. **Redirect handling — re-check policy on cross-host?**
   **Yes, max 5 redirects, re-check on every hop.** A 302 from
   `github.com` to `evil.example.com` must run the *target* through
   the cascade, not just the origin. If the redirected host fails
   policy → typed `WebFetchPolicyRedirectError`. Same scheme rule
   (HTTPS only) applies to every hop.
9. **What new audit metadata is needed?**
   **None — `tool_call_started` / `tool_call_finished` already
   carry `input` (URL is in there) and `resultPreview` (the first
   200 chars of the response).** `redactSecrets` runs at the audit
   boundary as defense-in-depth. The cascade's
   `permission_decision` event already carries the full reason
   payload; the new `rule.domain` field rides through automatically
   via the existing `PermissionRule` JSON serialization.
10. **Hook + skill integration — anything special?**
    **Nothing special.** PreToolUse / PostToolUse hooks fire
    automatically because `WebFetchTool` is a `Tool`. Skills'
    `allowedTools` already accepts arbitrary canonical names —
    `'WebFetch'` is just a string. The Phase 5b `scopedToolAllowlist`
    cascade step gates skill activation correctly with no edits.

---

## Architecture

```
  src/tools/WebFetchTool.ts          (NEW, ~120 LOC)
    ├─ WebFetchTool: Tool             (buildTool wrapper)
    ├─ schema: { url }                (no `prompt` field — see §3 above)
    ├─ validateInput                  (URL well-formed, https://, no userinfo, host syntactically valid)
    ├─ getDomain(input) → host        (NEW interface point)
    ├─ checkPermissions               (URL well-formed; cascade decides)
    └─ call                           (delegates to fetcher.ts)

  src/web/fetcher.ts                 (NEW, ~220 LOC)
    ├─ fetchWeb(url, opts) → FetchResult   (HTTPS-only, redirect re-check, IP block, size cap, timeout, abort)
    ├─ blockPrivateAddresses(host) → bool  (DNS lookup + IP class check)
    ├─ Errors: WebFetchTimeoutError, WebFetchTooLargeError,
              WebFetchUnsupportedContentTypeError,
              WebFetchPolicyRedirectError, WebFetchPrivateAddressError,
              WebFetchHttpError

  src/web/fetcher.test.ts            (NEW)

  src/web/domainPolicy.ts            (NEW, ~80 LOC)
    ├─ extractHost(url) → string | null     (URL parser, lowercased, no port)
    ├─ matchDomain(pattern, host) → boolean (exact or `*.suffix`)
    ├─ isValidDomainPattern(pat) → boolean  (rule-construction gate)
    └─ Wildcard syntax: `*.example.com` matches `a.example.com`,
       `a.b.example.com`; does NOT match `example.com` (use both
       entries when you want both).

  src/web/domainPolicy.test.ts       (NEW)

  src/web/htmlToText.ts              (NEW, ~100 LOC)
    ├─ htmlToText(html) → string            (script/style strip + tag strip + entity decode)
    ├─ decodeEntities(s) → string           (&amp; &lt; &gt; &quot; &#39; &nbsp; &#NNN; &#xHH;)
    └─ collapseWhitespace(s) → string

  src/web/htmlToText.test.ts         (NEW)

  src/core/permissions/types.ts      (EDIT — +1 field on PermissionRule)
    └─ PermissionRule.domain?: string       (exact or `*.suffix`)

  src/core/permissions/permissions.ts (EDIT — domain match in findMatchingRules + format)
    ├─ findMatchingRules(rules, name, path, host) — host param threaded through
    ├─ formatDecisionMessage — domain printed when present
    └─ Exports findMatchingRules so the fetcher's redirect re-check
       reuses the same rule semantics as the cascade.

  src/core/permissions/permissions.test.ts (EDIT — +domain rule cases)

  src/core/tools/types.ts            (EDIT — +1 optional method on Tool, ToolSpec)
    └─ Tool.getDomain?(input) → string | undefined
       (parallel to existing getPath)

  src/core/tools/runToolUse.ts       (EDIT — thread getDomain into ruleCreated)
    └─ When response === 'allow_by_rule', construct
       PermissionRule with `domain` from tool.getDomain (when defined),
       validated via isValidDomainPattern. Without this, allow_by_rule
       on a WebFetch prompt would create a session-wide allow for ALL
       WebFetch calls.

  src/core/tools/runToolUse.test.ts  (EDIT — +allow_by_rule with domain)

  src/core/tools/registry.ts         (EDIT — register WebFetchTool)
    └─ createDefaultRegistry: registry.register(WebFetchTool)

  src/core/state.ts                  (UNCHANGED — webPolicy field
    deliberately not added; the rules ARE the policy. See §1 above.)

  src/tools/WebFetchTool.test.ts     (NEW)
  tests/integration/webFetch.test.ts (NEW — mock HTTPS server end-to-end)
```

Untouched: provider adapters, MCP layer, hooks runtime, audit
writer, query loop, normalizeMessages, memory store, skills store,
filesystem-safety substrate. The cascade gains one optional match
dimension; the registry gains one tool; AppState gains one field;
`Tool` gains one optional method. No new event types, no new audit
entries, no slash commands, no settings-file persistence (deferred to
6b alongside `/web`).

---

## Scope

### In (locked)

1. **`WebFetchTool`** registered in `createDefaultRegistry`.
   - Name: `WebFetch` (canonical). Visible in skill `allowedTools`
     by that exact string.
   - Description: `Fetch the contents of an HTTPS URL. Returns the
     response body as text (HTML stripped). Read-only, no JavaScript
     execution. Subject to per-host permission rules.`
   - Input schema:
     ```json
     {
       "type": "object",
       "properties": {
         "url": { "type": "string", "description": "Full HTTPS URL to fetch (must start with https://)" }
       },
       "required": ["url"]
     }
     ```
   - `isMutating: false`, `isConcurrencySafe: () => true`,
     `getPath` undefined, `getDomain: (input) => extractHost(input.url)`.

2. **`Tool.getDomain?(input)`** — new optional method on the `Tool`
   interface and `ToolSpec`. Parallels `getPath`. Returns the
   request host (lowercased, no port, no userinfo) or `undefined`
   when the input doesn't carry a URL. `buildTool` defaults to
   omitting the property when not specified — same pattern as
   `getPath`.

3. **`PermissionRule.domain?: string`** — new optional field. Exact
   host (`github.com`) or wildcard suffix (`*.github.com`). Suffix
   wildcard matches subdomains only (`a.github.com`,
   `a.b.github.com`); the bare apex (`github.com`) requires its own
   rule. Bare `*` is rejected at rule-load time (fail-closed, mirrors
   the `*` toolName fallback in `matchesToolName`).

4. **`findMatchingRules(rules, toolName, path, host)`** — host
   parameter threaded through. Match semantics:
   - Rule with neither `path` nor `domain` → tool-name only.
   - Rule with `path` set → matches iff tool resolves to that exact
     path (current behavior).
   - Rule with `domain` set → matches iff tool resolves to a host
     that satisfies `matchDomain(rule.domain, host)`.
   - Rule with both → both must match (AND).
   - A rule's `path` ignores tools that don't expose `getPath`;
     symmetrically `domain` ignores tools that don't expose
     `getDomain`.

5. **`formatDecisionMessage`** — when a rule with `domain` is the
   reason, append ` (${rule.domain})` parenthetical the same way
   `path` is printed today.

6. **`AppState` is unchanged in 6a.** No `webPolicy` field.
   Earlier draft proposed one as "bootstrap" allow/deny; that was
   wrong because `tool.checkPermissions` returning `allow` does not
   terminate the cascade (verified at `permissions.ts:96-109`).
   The rules ARE the policy. Population paths in 6a:
   - `allow_by_rule` user response inserts a session-scoped
     `PermissionRule { toolName: 'WebFetch', domain, behavior:
     'allow', source: 'session' }` — see §6.5 below.
   - Tests construct `AppState.permissionRules` with seeded
     values directly.

   Settings-file persistence (which would seed initial rules at
   boot) and the `/web` slash command for imperative `/web allow
   github.com` / `/web deny <host>` are 6b.

6.5. **`runToolUse.ts::authorizeToolUse` — thread `getDomain`
   into `ruleCreated`.** Today (`runToolUse.ts:104-112`),
   `ruleCreated` carries only `toolName`, optional `path`, and
   `source`. For WebFetch this would create a session-wide allow
   for *every* host, defeating the per-host model. Edit:
   ```ts
   const ruleCreated: PermissionRule | undefined =
     response === 'allow_by_rule'
       ? {
           toolName: toolUse.name,
           behavior: 'allow',
           ...(tool.getPath?.(toolUse.input) && { path: tool.getPath(toolUse.input) }),
           ...(tool.getDomain?.(toolUse.input) && { domain: tool.getDomain(toolUse.input)! }),
           source: 'session',
         }
       : undefined
   ```
   Constructed `domain` must pass `isValidDomainPattern` —
   `extractHost` returns a valid lowercased host or null, so a
   non-null result is always a valid exact-host pattern, but the
   guard runs anyway as defense-in-depth. A null `getDomain`
   result (malformed URL slipped past validateInput somehow)
   omits the `domain` field — combined with no `path`, this falls
   back to a tool-name-only allow, which for WebFetch would be
   too broad. The guard escalates: if the tool exposes
   `getDomain` AND the value is null/undefined AND no `path` is
   set, refuse to construct the rule and convert the response to
   `allow_once` semantics. Documented as a sharp edge.

7. **`WebFetchTool.checkPermissions`** — minimal:
   1. `host = extractHost(input.url)`. If null →
      `{ behavior: 'deny', message: 'invalid URL' }`.
      (`validateInput` should already have rejected this; the
      check is defense-in-depth.)
   2. Otherwise return `{ behavior: 'allow' }` and let the
      cascade do the work. The cascade's `findMatchingRules`
      consults `permissionRules` for a `domain`-scoped allow/deny
      rule; absent any match, the cascade falls through to `ask`
      and the user is prompted. Approving with `allow_by_rule`
      then persists the host-scoped rule via §6.5.
   - The earlier draft of this design tried to short-circuit
     allow/deny inside the tool check via a `webPolicy` field on
     AppState. That doesn't work because `tool.checkPermissions`
     returning `allow` only continues the cascade — it does not
     terminate it. Per-host policy lives entirely in
     `permissionRules`.

8. **Cascade order is unchanged.** The new `domain` field plugs
   into existing `findMatchingRules`. No new step is inserted; the
   `runCascade` function in `src/core/permissions/permissions.ts`
   gets the host parameter passed through.

9. **`fetchWeb(url, opts)`** — fetcher contract:
   ```ts
   type FetchOptions = {
     readonly signal: AbortSignal
     readonly timeoutMs?: number          // default 30_000
     readonly maxBytes?: number           // default 5 * 1024 * 1024
     readonly maxRedirects?: number       // default 5
     readonly checkPolicy: (host: string) => 'allow' | 'deny' | 'ask'
       // closure over the cascade — called on FIRST hop AND every
       // redirect hop, not only redirects. The first-hop call closes
       // the post-PreToolUse-hook gap (query.ts:301 explicitly
       // documents that permissions are NOT re-checked after hook
       // mutation). The closure must reuse cascade rule semantics
       // by calling findMatchingRules — see §13 below.
     readonly userAgent?: string          // default 'Ultron/0.1 (+local CLI agent)'
     readonly lookup?: typeof dns.lookup  // DI for tests; defaults to dns.lookup
     readonly httpsAgent?: https.Agent    // DI for tests (e.g. self-signed cert acceptance)
   }

   type FetchResult = {
     readonly status: number
     readonly contentType: string
     readonly body: string                // already decoded; HTML→text done by caller
     readonly truncated: boolean
     readonly finalUrl: string            // post-redirect
     readonly redirectChain: readonly string[]  // includes finalUrl
   }
   ```
   Behavior:
   - HTTPS only — http URLs throw `WebFetchSchemeError` before any
     network call.
   - DNS lookup → check IP class. Private/loopback/link-local →
     throw `WebFetchPrivateAddressError`. (Both IPv4 and IPv6.)
   - Timeout: 30s wall-clock for the whole exchange (DNS + connect
     + headers + body). On timeout → `WebFetchTimeoutError`.
   - Body cap: 5 MB. Read up to cap+1 byte; if cap is exceeded, the
     reader continues to drain to a hard ceiling (cap × 2) and
     returns `truncated: true` with the body truncated at cap.
     Beyond cap × 2 → `WebFetchTooLargeError` (defends against an
     adversarial server).
   - Content-type: must match the allow set (§7 above) by prefix
     before `;` separator. Otherwise →
     `WebFetchUnsupportedContentTypeError`.
   - Redirects: follow up to 5. On every cross-host hop, call
     `opts.checkPolicy(newHost)`. `deny` or `ask` → throw
     `WebFetchPolicyRedirectError`. (Note: `ask` mid-fetch can't
     prompt the user, so it converts to a refusal at the redirect
     hop. The user can re-invoke the tool with the final URL if
     they wanted.)
   - HTTP errors (4xx/5xx): return as `FetchResult` with the body
     and status; do not throw. The tool surfaces the status to the
     model so it can react.
   - User-Agent: identifies as Ultron. Does not lie.
   - Encoding: respect `charset` from the content-type header
     (default UTF-8). Use `TextDecoder` for non-UTF-8.
   - **First-hop policy check.** Before DNS or any network IO,
     call `opts.checkPolicy(initialHost)`. `deny` or `ask` →
     throw `WebFetchPolicyError` (distinct from
     `WebFetchPolicyRedirectError`). This is the seam that closes
     the PreToolUse-hook URL-rewrite gap. The cascade authorized
     the *original* host before hooks ran; if a hook mutated the
     URL to a different host, the rewritten host has not been
     authorized and the fetcher refuses it here.

10. **`htmlToText(html)`** — minimal regex pipeline:
    - Drop `<script[\s\S]*?</script>`, `<style[\s\S]*?</style>`,
      `<noscript[\s\S]*?</noscript>` (case-insensitive, multiline).
    - Drop HTML comments `<!--[\s\S]*?-->`.
    - Replace block-introducing tags (`<br>`, `<br/>`, `<p>`,
      `</p>`, `</h1>`–`</h6>`, `</div>`, `</li>`, `</tr>`) with
      `\n`.
    - Strip remaining `<...>`.
    - Decode entities: `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`,
      `&apos;`, `&nbsp;`, numeric `&#NNN;`, hex `&#xHH;`. Unknown
      entities pass through verbatim.
    - Collapse runs of `\n` to at most two; trim ends.
    The function is content-type-aware via the caller: only
    `text/html` and `application/xhtml+xml` are passed through it.
    `application/json` and other text types are returned verbatim.

11. **Tool result formatting** — `WebFetchTool.call` returns:
    ```
    URL: https://github.com/anthropics/anthropic-sdk-typescript
    Status: 200
    Content-Type: text/html; charset=utf-8

    <body content, HTML stripped, up to 5 MB>
    [truncated at 5 MB]   ← only when truncated: true
    ```
    Redirect chain (when `redirectChain.length > 1`) appears as a
    line `Followed redirects: a → b → c` between the URL and Status
    lines. Errors return `{ content: '<message>', isError: true,
    errorKind: 'execution_error' }`.

12. **Default registry** — `createDefaultRegistry` registers
    `WebFetchTool` after `BashTool`, before `AgentTool`, so the
    grouping reads "filesystem → shell → web → agent". Comment
    block above the registrations is updated to reflect the seven
    built-ins.

13. **Fetcher's `checkPolicy` reuses cascade rule semantics.** The
    `checkPolicy` closure passed into `fetchWeb` from
    `WebFetchTool.call` MUST consult the same `findMatchingRules`
    that the cascade itself uses, not a hand-rolled
    `r.toolName === 'WebFetch'` filter. To make this clean,
    `findMatchingRules` is exported from
    `src/core/permissions/permissions.ts` (currently file-local).
    The closure becomes:
    ```ts
    const checkPolicy = (host: string): 'allow' | 'deny' | 'ask' => {
      const rules = appState.getState().permissionRules
      const matching = findMatchingRules(rules, 'WebFetch', undefined, host)
      if (matching.find((r) => r.behavior === 'deny')) return 'deny'
      if (matching.find((r) => r.behavior === 'allow')) return 'allow'
      return 'ask'
    }
    ```
    Same wildcard rules, same suffix-`*` semantics, no
    duplication. (Skill `scopedToolAllowlist` does NOT participate
    in the redirect re-check — the original `tool_use` already
    cleared the skill scope at the cascade entry; mid-fetch
    redirects are not new tool uses.)

14. **`isValidDomainPattern` validation point.** The function
    lives in `src/web/domainPolicy.ts` and is called wherever a
    rule is constructed:
    - In `runToolUse.ts` when materializing `ruleCreated` from
      `tool.getDomain` (defensive — `extractHost` already returns
      a clean lowercased host).
    - In any future settings.json loader (6b) when seeding rules
      at boot. Out of 6a scope but the function is exported for
      6b's use.
    No central "rule-load" layer exists today; that's fine — the
    pattern check at every construction site is the substitute.

### Out (deferred to 6b / later)

- **`WebSearchTool`** and the search-API provider choice (Brave /
  Tavily / Bing / DuckDuckGo / etc.) — 6b. WebSearch consumes the
  same `domain` cascade machinery this phase delivers; the only
  new substrate it needs is one config field for the API key.
- **`/web` slash command** for imperative `/web list`, `/web allow
  <host>`, `/web deny <host>`, `/web rules` — 6b. The session-
  scoped `allow_by_rule` path covers the in-prompt UX in 6a.
- **Settings-file persistence** that seeds initial `permissionRules`
  (domain-scoped) at boot from `~/.ultron/settings.json` — 6b.
- **`WebFetchTool` `prompt` field for in-tool model summarization**
  — not planned for v2. The orchestrating turn already has model
  access; recursive `callModel` from inside a tool muddies the
  permission and audit boundaries.
- **HTML→markdown via `turndown` or `node-html-markdown`** — 6c
  candidate alongside attachment fidelity. The `htmlToText`
  function is the swap point.
- **CodeSandbox** — 6c.
- **First-class attachments** (image / PDF / notebook) — 6d.
  Until then, `WebFetchTool` refuses non-text content types
  rather than silently surfacing binary garbage.
- **Auto-upgrade `http://` → `https://`** — not planned. Reject
  HTTP at validateInput.
- **Robots.txt respect** — not in scope. The user is responsible
  for the legal/courtesy posture of their fetches; Ultron's job is
  to expose the URL the user (or skill or model) named, gated by
  the per-host policy. A future opt-in `respectRobots: true` knob
  is a clean addition.
- **Cookies / authentication headers / custom request headers** —
  not in scope. WebFetch is anonymous; authenticated fetches go
  through MCP servers that own the credential. (See `WebFetch`
  caveat in Claude Code's tool docs — same posture.)
- **POST / PUT / DELETE / PATCH** — not in scope. WebFetch is
  read-only, GET only. Mutating HTTP belongs to a different tool
  with a different permission posture.
- **Streaming response handling** — out of scope. Body is
  collected before the tool returns; partial-result streaming
  isn't useful for an LLM consumer that needs the whole document
  to reason.
- **WebSocket / SSE / non-HTTP protocols** — never planned for
  WebFetch. A separate tool would be a different design.
- **Domain rule wildcards beyond `*.suffix`** — no regex, no globs
  with multiple wildcards. Two patterns cover the real
  ergonomics: `host.example.com` (exact) and `*.example.com`
  (suffix). Anything more invites confusing rules.
- **Cross-cascade `scopedDomainAllowlist`** for skills (analog to
  `scopedToolAllowlist`) — possibly useful, but no skill currently
  needs it. Defer.
- **Per-domain rate limiting** — out of scope. The 30s timeout
  and 5 MB cap are the only resource gates in 6a.
- **Caching responses** — out of scope. Every fetch is fresh.
- **Response decompression** (`Content-Encoding: gzip / br`) —
  Node's `https.get` does NOT auto-decompress, so we either set
  `Accept-Encoding: identity` (ask the server not to compress) or
  decompress manually. **In 6a: send `Accept-Encoding: identity`.**
  Most modern servers honor it; if a server forces compression
  anyway, the response surfaces as binary garbage and the
  content-type filter passes (gzipped HTML still has
  `Content-Type: text/html`) — this is a sharp edge documented
  below. A `zlib` decompression pass is a clean future add.

---

## Data flow

### Happy path — fetch `https://github.com/foo`

1. Model emits `tool_use` block: `{ name: 'WebFetch', input: { url:
   'https://github.com/foo' } }`.
2. `runToolUse` resolves the tool, calls `validateInput` —
   URL parses, scheme is HTTPS, no userinfo. Pass.
3. `hasPermissionsToUseTool` runs the cascade:
   - `tool.getDomain(input)` → `'github.com'`.
   - `findMatchingRules(rules, 'WebFetch', undefined, 'github.com')`
     — no matching rules in a fresh session.
   - Step 1 (deny rules) — none.
   - Step 1.5 (skill scope) — no active skill.
   - Step 2 (ask rules) — none.
   - Step 3 (`tool.checkPermissions`) — returns `{ behavior:
     'allow' }` (host is well-formed; the cascade decides).
   - Step 4 (safety checks) — none registered for `WebFetch`.
   - Step 5 (mode) — `default`.
   - Step 6 (allow rules) — none.
   - Step 7 (fallback) — `ask`.
4. The runner shows the user "WebFetch wants to fetch
   https://github.com/foo". User picks `allow_by_rule`.
5. Runner (`runToolUse.ts`, edited per §6.5) inserts
   `PermissionRule { toolName: 'WebFetch', domain: 'github.com',
   behavior: 'allow', source: 'session' }`. The `domain` field is
   set from `tool.getDomain(input)`. The *exact* host is recorded;
   `*.suffix` upgrades happen via the future `/web` UX, not from a
   one-tap approval.
6. `executeToolUse` → `WebFetchTool.call(input, ctx, signal)`.
7. `fetchWeb('https://github.com/foo', { signal, checkPolicy: ... })`:
   - `extractHost` → `'github.com'`.
   - **First-hop policy check** — `checkPolicy('github.com')`
     returns `'allow'` (the rule inserted at step 5 matches).
   - DNS lookup → public IP. Pass IP-class check.
   - HTTPS GET with `Accept-Encoding: identity` and the Ultron UA.
   - Response: 200, `Content-Type: text/html; charset=utf-8`,
     body 200 KB.
   - Body within cap → no truncation.
   - No redirects.
8. `htmlToText(body)` strips and decodes.
9. Tool returns `{ content: 'URL: ...\nStatus: 200\n...\n\n<text>',
   isError: false }`.
10. `tool_call_finished { toolName: 'WebFetch', outcome: 'ok',
    durationMs, resultPreview: <first 200 chars> }` emits → audit
    line written.
11. Next turn: a re-fetch of `https://github.com/foo` (or any
    `https://github.com/...` path) finds the session rule at step
    6 and skips the prompt.

### Permission-deny paths

- **Cascade rule deny** (user previously set a session deny) at
  step 1 → `{ behavior: 'deny', reason: { type: 'rule', rule } }`.
- **PreToolUse-hook URL rewrite caught at first hop.** A hook
  rewrites `input.url` from `github.com` (authorized) to
  `evil.example.com` (not authorized) between authorization and
  execution. `executeToolUse` re-runs `validateInput` on the
  rewritten URL — that passes (still HTTPS, still well-formed).
  `WebFetchTool.call` enters `fetchWeb`, which calls
  `checkPolicy('evil.example.com')` on the first hop; the rule
  set has no allow for that host → `'ask'` → `fetchWeb` throws
  `WebFetchPolicyError`. Tool returns `{ isError: true,
  errorKind: 'execution_error', content: '<message>' }`. The
  audit shows `tool_call_finished { outcome: 'error' }` plus the
  earlier `permission_decision { decision: 'allow' }` for the
  *original* host — together forming a forensic trail.
- **IP-class block** — fires inside `fetchWeb` after the
  first-hop policy check passes. The cascade allows the host;
  DNS resolves to `127.0.0.1`; fetcher throws
  `WebFetchPrivateAddressError`.
- **Cross-host redirect to a denied host** — `fetchWeb` follows
  the 302, calls `opts.checkPolicy('evil.example.com')`, gets
  `'deny'` or `'ask'`, throws `WebFetchPolicyRedirectError`.
  Tool returns error.

### Aborted fetch

- User cancels → AbortSignal aborts mid-request. `fetchWeb`
  resolves with whatever's been read; `WebFetchTool.call` returns
  `{ content: '[aborted]', isError: true, errorKind: 'aborted' }`.
  Same shape as `BashTool`'s abort path.

### Concurrency

`WebFetchTool` is read-only and `isConcurrencySafe: () => true`, so
the existing concurrent-tool runner can fire multiple WebFetch calls
in parallel from the same turn (model can emit several `tool_use`
blocks at once). Each call hits the policy cascade independently.
No locks, no shared state beyond `appState.permissionRules` (read-only).

---

## Module breakdown

### `src/web/domainPolicy.ts` (new, ~120 LOC)

```ts
export function extractHost(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.username !== '' || u.password !== '') return null  // no userinfo
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}

// Pattern: exact host or `*.suffix.example.com`. Bare `*` rejected.
// Used at every rule construction point as defense in depth.
export function isValidDomainPattern(pat: string): boolean { ... }

// Suffix wildcard matches subdomains only:
//   matchDomain('*.github.com', 'a.github.com')  → true
//   matchDomain('*.github.com', 'a.b.github.com')→ true
//   matchDomain('*.github.com', 'github.com')    → false (apex needs its own rule)
//   matchDomain('github.com', 'github.com')      → true
//   matchDomain('github.com', 'a.github.com')    → false
export function matchDomain(pattern: string, host: string): boolean { ... }
```

No `WebPolicyDecision`, no `checkBootstrapPolicy`. Per §1, the
bootstrap concept is dropped; the cascade's `findMatchingRules` IS
the policy check, and the fetcher's `checkPolicy` closure
(constructed in `WebFetchTool.call`) reuses it.

`extractHost` rejects URLs that carry userinfo (`https://user:pass@host`)
because the username could leak credentials into audit logs and
because per-host policy assumes a stable host identity. This is a
quiet contract — `validateInput` performs the same check and returns
a clean `valid: false` message.

### `src/web/fetcher.ts` (new, ~220 LOC)

Uses `node:https` (built-in, no dependency). `fetch()` (the new
global in Node 20+) would also work but `https` gives finer control
over timeouts and abort semantics. Choose `node:https` for the
implementation; rationale: `fetch` doesn't expose hooks for the
DNS-lookup → IP-class check between resolution and connect.

```ts
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import net from 'node:net'

export class WebFetchSchemeError extends Error { ... }
export class WebFetchPrivateAddressError extends Error { ... }
export class WebFetchTimeoutError extends Error { ... }
export class WebFetchTooLargeError extends Error { ... }
export class WebFetchUnsupportedContentTypeError extends Error { ... }
export class WebFetchPolicyError extends Error { ... }          // first-hop policy fail
export class WebFetchPolicyRedirectError extends Error { ... }  // redirect-hop policy fail
export class WebFetchHttpError extends Error { ... }            // network/socket errors

const PRIVATE_IP4_RANGES = [
  // CIDR list: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8, 100.64/10
] as const

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) { /* range check */ }
  if (net.isIPv6(ip)) { /* ::1, fc00::/7, fe80::/10, IPv4-mapped check */ }
  return false
}

export async function fetchWeb(url: string, opts: FetchOptions): Promise<FetchResult> {
  // 1. Scheme check: throw WebFetchSchemeError on non-https.
  // 2. Loop up to opts.maxRedirects:
  //    a. extractHost; if null → invalid URL error.
  //    b. opts.checkPolicy(host); deny/ask:
  //       - on first hop → WebFetchPolicyError (closes hook-rewrite gap)
  //       - on redirect hops → WebFetchPolicyRedirectError
  //    c. dns.lookup(host) (uses opts.lookup if provided);
  //       if isPrivateAddress(addr) → WebFetchPrivateAddressError.
  //    d. https.get with custom lookup that pins to the resolved IP (defends
  //       against TOCTOU between DNS check and connect).
  //    e. On 3xx with Location → loop.
  //    f. On 2xx/4xx/5xx → stream body up to (cap, cap*2) ceiling.
  // 3. Apply timeout via AbortSignal.timeout(opts.timeoutMs) merged with
  //    opts.signal via AbortSignal.any.
  // 4. Validate content-type prefix; throw if disallowed.
  // 5. Decode body using charset from content-type (default UTF-8).
  // 6. Return FetchResult.
}
```

The TOCTOU mitigation (custom `lookup` for `https.get` that
returns the already-resolved IP) is worth the 10 LOC: between
"DNS says this host resolves to 1.2.3.4" and "actually connect",
DNS could have changed. Pinning the resolved IP for the actual
connect closes the gap.

### `src/web/htmlToText.ts` (new, ~100 LOC)

Pure functions, no I/O. Decoding table is fixed-size; numeric
references are bounded by `String.fromCodePoint` validity.

```ts
export function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, '')
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, '')
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(br|p|li|tr|div|h[1-6])\b[^>]*>/gi, '\n')
  s = s.replace(/<\/(p|li|tr|div|h[1-6])>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = collapseWhitespace(s)
  return s.trim()
}
```

### `src/tools/WebFetchTool.ts` (new, ~120 LOC)

```ts
import { buildTool } from '../core/tools/types.js'
import { fetchWeb, /* errors */ } from '../web/fetcher.js'
import { extractHost } from '../web/domainPolicy.js'
import { htmlToText } from '../web/htmlToText.js'
import { findMatchingRules } from '../core/permissions/permissions.js'

export const WebFetchTool = buildTool({
  name: 'WebFetch',
  description: '...',
  inputSchema: { /* §1 above */ },
  isMutating: false,
  isConcurrencySafe: () => true,
  getDomain: (input) => extractHost(typeof input.url === 'string' ? input.url : ''),

  async validateInput(input) {
    if (typeof input.url !== 'string' || input.url.trim() === '') {
      return { valid: false, message: 'url must be a non-empty string' }
    }
    let parsed: URL
    try { parsed = new URL(input.url) } catch {
      return { valid: false, message: 'url is not a valid URL' }
    }
    if (parsed.protocol !== 'https:') {
      return { valid: false, message: 'only https:// URLs are supported' }
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return { valid: false, message: 'URLs with userinfo are not supported' }
    }
    if (/^localhost$|\.local$|\.internal$/i.test(parsed.hostname)) {
      return { valid: false, message: 'localhost / .local / .internal hosts are not supported' }
    }
    return { valid: true }
  },

  async checkPermissions(input) {
    const host = extractHost(input.url as string)
    if (host === null) return { behavior: 'deny', message: 'invalid URL' }
    return { behavior: 'allow' }  // cascade does the rule lookup
  },

  async call(input, context, signal) {
    const appState = context.appState
    // Reuse cascade rule semantics — same wildcard / suffix-* / source rules.
    const checkPolicy = (host: string): 'allow' | 'deny' | 'ask' => {
      const rules = appState.getState().permissionRules
      const matching = findMatchingRules(rules, 'WebFetch', undefined, host)
      if (matching.find((r) => r.behavior === 'deny')) return 'deny'
      if (matching.find((r) => r.behavior === 'allow')) return 'allow'
      return 'ask'
    }

    try {
      const result = await fetchWeb(input.url as string, {
        signal,
        checkPolicy,
      })
      const isHtml = /^(text\/html|application\/xhtml\+xml)\b/i.test(result.contentType)
      const body = isHtml ? htmlToText(result.body) : result.body
      const lines = [
        `URL: ${input.url}`,
        ...(result.redirectChain.length > 1 ? [`Followed redirects: ${result.redirectChain.join(' → ')}`] : []),
        `Status: ${result.status}`,
        `Content-Type: ${result.contentType}`,
        '',
        body,
        ...(result.truncated ? ['[truncated at 5 MB]'] : []),
      ]
      return { content: lines.join('\n'), isError: false }
    } catch (err) {
      if (signal.aborted) return { content: '[aborted]', isError: true, errorKind: 'aborted' }
      return { content: errMsg(err), isError: true, errorKind: 'execution_error' }
    }
  },
})
```

### `src/core/permissions/types.ts` (edit, +1 field)

```ts
export type PermissionRule = {
  toolName: string
  behavior: PermissionRuleBehavior
  path?: string                   // exact match, not a glob
  domain?: string                 // ← Phase 6a: exact host or `*.suffix`
  source: PermissionRuleSource
}
```

### `src/core/permissions/permissions.ts` (edit, ~25 LOC)

```ts
async function runCascade(...) {
  const rules = context.appState.getState().permissionRules
  const toolPath = tool.getPath?.(toolUse.input)
  const toolHost = tool.getDomain?.(toolUse.input)
  const matching = findMatchingRules(rules, toolUse.name, toolPath, toolHost)
  // ...rest unchanged
}

function findMatchingRules(
  rules: readonly PermissionRule[],
  toolName: string,
  toolPath: string | undefined,
  toolHost: string | undefined,
): PermissionRule[] {
  return rules.filter((rule) => {
    if (!matchesToolName(rule.toolName, toolName)) return false
    if (rule.path !== undefined) {
      if (toolPath === undefined || rule.path !== toolPath) return false
    }
    if (rule.domain !== undefined) {
      if (toolHost === undefined || !matchDomain(rule.domain, toolHost)) return false
    }
    return true
  })
}

// formatDecisionMessage: append `(${rule.domain})` parenthetical alongside
// the existing path branch.
```

`matchDomain` is imported from `src/web/domainPolicy.js` — the
permission engine becomes a one-line consumer of the policy module.
`findMatchingRules` is **exported** (currently file-local) so the
fetcher's `checkPolicy` closure can reuse the same rule semantics
for redirect re-checks.

### `src/core/tools/runToolUse.ts` (edit, ~10 LOC)

The `ruleCreated` block at lines 104–112 currently only carries
`toolName`, optional `path`, and `source`. For domain-bearing tools
this would create a session-wide allow for every host of that tool —
exactly the opposite of the per-host model. Edit the construction:

```ts
const domain = tool.getDomain?.(toolUse.input)
const ruleCreated: PermissionRule | undefined =
  response === 'allow_by_rule'
    ? buildAllowByRule(toolUse.name, tool, toolUse.input)
    : undefined

function buildAllowByRule(
  toolName: string,
  tool: Tool,
  input: Record<string, unknown>,
): PermissionRule | undefined {
  const path = tool.getPath?.(input)
  const domain = tool.getDomain?.(input)
  // Defensive: if the tool advertises domain scope but resolution
  // failed, refuse to construct an over-broad rule.
  if (tool.getDomain !== undefined && (domain === undefined || !isValidDomainPattern(domain))) {
    if (path === undefined) return undefined  // would be too broad — caller treats as allow_once
  }
  return {
    toolName,
    behavior: 'allow',
    ...(path !== undefined && { path }),
    ...(domain !== undefined && isValidDomainPattern(domain) && { domain }),
    source: 'session',
  }
}
```

When `buildAllowByRule` returns `undefined` (defensive escape),
the `payload.userResponse` stays `'allow_by_rule'` for telemetry
fidelity, but the AppState mutation is skipped — the call is
authorized once for this turn only. Tested in
`runToolUse.test.ts`.

### `src/core/state.ts` — UNCHANGED

The earlier draft proposed a `webPolicy` field on `AppState`. It is
**removed** from this design: `tool.checkPermissions` returning
`allow` does not terminate the cascade, so the bootstrap concept
contradicts the engine. The cascade's `permissionRules` IS the
policy. 6b will add `~/.ultron/settings.json` loading that seeds
initial rules at boot.

### `src/core/tools/types.ts` (edit, +~10 LOC)

```ts
export interface Tool {
  // ... existing fields
  getDomain?(input: Record<string, unknown>): string | undefined
}

export type ToolSpec = {
  // ... existing
  getDomain?: Tool['getDomain']
}

export function buildTool(spec: ToolSpec): Tool {
  return {
    // ... existing
    ...(spec.getDomain && { getDomain: spec.getDomain }),
  }
}
```

### `src/core/tools/registry.ts` (edit, +2 lines)

```ts
import { WebFetchTool } from '../../tools/WebFetchTool.js'

export function createDefaultRegistry(): ToolRegistry {
  const registry = createToolRegistry()
  registry.register(FileReadTool)
  registry.register(FileWriteTool)
  registry.register(FileEditTool)
  registry.register(GlobTool)
  registry.register(GrepTool)
  registry.register(BashTool)
  registry.register(WebFetchTool)        // ← Phase 6a
  registry.register(AgentTool)
  return registry
}
```

---

## Critical invariants

1. **HTTPS-only.** `validateInput` rejects every non-`https:` URL.
   The fetcher throws `WebFetchSchemeError` even if a redirect
   targets `http:` — defense in depth.
2. **Private/loopback addresses are non-bypassable.** No
   permission rule, no skill, no `bypassPermissions` mode can
   override the IP-class check inside `fetchWeb`. Same posture as
   filesystem-safety.
3. **First-hop is trusted; redirects re-check policy.** The
   cascade authorized the initial input (via allow rule,
   `allow_by_rule`, `allow_once`, or `bypassPermissions`). The
   fetcher does NOT re-check the first hop — doing so would break
   `allow_once` and `bypassPermissions`, neither of which
   persists a rule for a closure to find. Only redirect hops
   (`hop > 0`) call `opts.checkPolicy(newHost)` and reject
   `deny`/`ask` with `WebFetchPolicyRedirectError`. **Known
   limitation**: a PreToolUse hook that rewrites `input.url`
   between authorize and execute slips past per-host policy.
   Closing that gap requires re-authorization on hook input
   mutation — a cross-tool concern that lives in a future phase.
4. **`checkPolicy` mirrors cascade rule order: deny > ask > allow
   > fallback ask.** The closure inside `WebFetchTool.call` calls
   `findMatchingRules` directly (no hand-rolled filter) and
   resolves precedence the same way the cascade does at
   `permissions.ts:65,89,135,142`, so a redirect re-check
   produces the same decision a fresh authorization would.
5. **`tool.checkPermissions` is the positive vote, not the final
   word.** Returning `{ behavior: 'allow' }` from
   `WebFetchTool.checkPermissions` does not bypass the cascade —
   the cascade's own deny/ask rules at steps 1–2 and the fallback
   at step 7 still apply. This is why per-host policy lives in
   `permissionRules`, not in a tool-internal config field.
6. **DNS lookup is raced against timeout and abort.** The
   resolver promise is wrapped in `raceWithTimeoutAndAbort` so a
   hanging DNS server cannot exceed the 30 s wall-clock contract
   or ignore cancellation.
7. **Body cap is enforced even on adversarial servers.** The
   reader drains to at most cap × 2; beyond that → throw. No way
   to OOM the process via a slow trickle.
8. **Domain wildcard syntax is restricted.** Only `*.suffix`
   (subdomains-only) is allowed. Bare `*` is rejected. No
   regex; no multi-wildcard patterns. `isValidDomainPattern`
   gates rule construction at every site (runToolUse, future
   settings.json loader).
9. **`allow_by_rule` for domain-bearing tools always carries
   `domain`.** `runToolUse.ts::buildAllowByRule` refuses to
   construct an over-broad rule when the tool exposes
   `getDomain` but resolution failed. The user response is still
   recorded as `'allow_by_rule'` in the audit, but no rule lands
   in AppState — the call gets `allow_once` semantics. Defense
   against silent over-broad authorizations.
10. **Audit metadata is unchanged.** The new `domain` field on
    `PermissionRule` is automatically picked up by the existing
    `permission_decision` event; the `tool_call_*` events carry the
    URL via `input` already. No new event types.
11. **`getDomain` is purely declarative.** It returns the host or
    undefined; it never throws, never does I/O, never depends on
    AppState. Same shape as `getPath`.
12. **Read-only tool.** `WebFetchTool.isMutating === false`. No
    writes, no shell, no filesystem. Concurrent-safe.
13. **No recursive `callModel`.** WebFetch does not invoke a model
    inside the tool boundary. The body is returned as-is (post
    HTML strip) and the parent turn decides what to do with it.
14. **All Phase 5b skill machinery still works.** A skill with
    `allowedTools: ['WebFetch']` activates correctly; one without
    `WebFetch` denies the tool at the cascade `skillScope` step.

---

## Sharp edges

- **`Accept-Encoding: identity` may be ignored.** Some servers
  always gzip. When that happens the response body looks like
  binary garbage and `htmlToText` produces empty/junk output. We
  document this; a `zlib.gunzipSync` pass on `Content-Encoding:
  gzip` responses is a clean future add (probably 6c when
  attachment fidelity already pulls in binary handling).
- **DNS race (TOCTOU) closed by pinning IP.** `https.get` is
  invoked with a custom `lookup` callback that returns the
  already-resolved IP, so the OS's connect doesn't re-resolve and
  potentially get a different (private) address. Tested via a
  fake `lookup` callback.
- **`*.example.com` does not match `example.com`.** Two rules
  needed to cover both. Documented in description; `/web allow`
  in 6b can offer a "match apex too" toggle.
- **No URL canonicalization beyond `URL` parser defaults.** The
  WHATWG URL parser lowercases the scheme and host but leaves the
  path/query case-sensitive. `extractHost` returns the lowercased
  host. No punycode → unicode round-trip; punycode hosts are
  treated as their ASCII form.
- **`*.suffix` rules are broader than per-host rules.** A user
  who upgrades a `gist.github.com` rule to `*.github.com` (via
  6b's `/web allow *.github.com` or by hand-editing
  settings.json in 6b+) thereby trusts every subdomain. Documented
  in `/web allow` semantics; 6a only records exact-host rules
  from `allow_by_rule`, so the broadening is always an explicit
  user act.
- **Tool result preview redaction.** `redactSecrets` runs on
  every audit envelope. A WebFetch response that contains a
  string matching a secret pattern (e.g. an API key in HTML) gets
  redacted in the audit row but lands in the in-memory tool
  result intact for the model to see. This is the expected
  posture (audit hides; model sees) and matches how `BashTool`
  behaves. Operators concerned about this should set a deny rule
  on the host.
- **PreToolUse-hook URL rewrite — closed inside `fetchWeb`.**
  `query.ts:301-302` documents that permissions are NOT re-checked
  after PreToolUse hook mutation. `runToolUse.ts:153-198`
  re-validates input but only against shape/scheme — not the
  domain policy. A hook that rewrites `input.url` from an
  authorized host to a denied host would slip past the cascade
  entirely. Closed by the **first-hop policy check** in
  `fetchWeb` (invariant #3): the fetcher itself calls
  `checkPolicy(initialHost)` before any DNS or socket IO and
  refuses unauthorized hosts with `WebFetchPolicyError`. Tested
  in the integration suite.
- **Redirect chain leaks intermediate hosts to the audit log via
  the tool result preview.** Acceptable — the user authorized the
  fetch and intermediate hops are part of the trail. If
  intermediates land on a denied host, the fetch errors out
  before completing.
- **`localhost` block is by hostname, not by resolution.** A user
  who really wants local fetches (testing) is locked out — by
  design. Local services should be exposed via dev tools, not
  WebFetch.
- **IPv6 literal in URL.** `https://[::1]/` parses; `extractHost`
  returns `[::1]` (URL parser lowercases). The IP-class check
  also catches `::1` directly. Tested.
- **Concurrent fetches share the AppState read.** A
  `setState({ permissionRules })` call between two parallel
  fetches could land on different snapshots. Acceptable: the
  rule set is re-read per fetch, and a mid-flight rule change is
  not retroactive within an in-flight fetcher.

---

## Verification

### Unit — `src/web/domainPolicy.test.ts` (new)

- `extractHost`:
  - `https://github.com/foo` → `'github.com'`.
  - `https://GitHub.com/foo` → `'github.com'` (lowercased).
  - `https://github.com:8080/foo` → `'github.com'` (no port).
  - `https://user:pass@github.com/foo` → `null` (userinfo
    rejected).
  - `not-a-url` → `null`.
  - `https://[::1]/` → `'[::1]'`.
- `isValidDomainPattern`:
  - `github.com` → true.
  - `*.github.com` → true.
  - `*` → false.
  - `*.*.example.com` → false (only one wildcard).
  - `*.` → false.
  - empty string → false.
- `matchDomain`:
  - `('github.com', 'github.com')` → true.
  - `('github.com', 'a.github.com')` → false.
  - `('*.github.com', 'a.github.com')` → true.
  - `('*.github.com', 'a.b.github.com')` → true.
  - `('*.github.com', 'github.com')` → false (apex excluded).
  - `('*.github.com', 'evil.com')` → false.
  - case-insensitive match (host already lowercased by
    `extractHost`; pattern lowercased here).
- (No `checkBootstrapPolicy` tests — function removed per §1.
  Per-host policy lives entirely in `permissionRules` and is
  exercised by the cascade and `findMatchingRules` tests.)

### Unit — `src/web/htmlToText.test.ts` (new)

- `<script>alert(1)</script>hello` → `'hello'`.
- `<style>...</style><p>hi</p>` → `'hi'`.
- Nested tags: `<div><p>foo<b>bar</b></p></div>` → `'foo bar'`.
- Comments: `<!-- secret --><p>x</p>` → `'x'`.
- Entities: `Tom &amp; Jerry` → `'Tom & Jerry'`,
  `&lt;script&gt;` → `'<script>'`, `&#39;` → `'`,
  `&#x2014;` → em-dash.
- Numeric overflow `&#9999999;` → passes through verbatim
  (invalid codepoint).
- Whitespace collapse: `\n\n\n\n` → `\n\n`.
- Plain text passes through unchanged.

### Unit — `src/web/fetcher.test.ts` (new)

Tests use a local HTTPS server fixture (`https.createServer` with
a self-signed cert) and pass an `httpsAgent` configured to accept
that cert via `opts.httpsAgent` (DI hook in `FetchOptions`). DNS
behavior is tested by passing `opts.lookup` (DI hook). No global
mocks — each test owns its injected dependencies, which keeps the
suite robust to Node version drift in `dns/promises` /
`https.get`. Cover:

- HTTPS-only: `http://example.com` → `WebFetchSchemeError`.
- First-hop policy fail: `checkPolicy` returns `'deny'` → throw
  `WebFetchPolicyError`.
- First-hop policy fail: `checkPolicy` returns `'ask'` → throw
  `WebFetchPolicyError`.
- First-hop policy pass: `checkPolicy` returns `'allow'` →
  proceeds.
- Private addresses (via `opts.lookup` returning `127.0.0.1`,
  `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, `169.254.0.1`,
  `::1`, `fc00::1`, `fe80::1`) → `WebFetchPrivateAddressError`
  for each.
- Public address: `opts.lookup` returns `1.1.1.1` → fetch
  proceeds.
- Timeout: server hangs → `WebFetchTimeoutError` after configured
  timeout.
- Body cap: server returns 5 MB + 1 KB → `truncated: true`,
  body length ≤ 5 MB.
- Body adversarial: server returns 12 MB → `WebFetchTooLargeError`
  (cap × 2 ceiling).
- Content-type allowed: `text/html`, `application/json`,
  `text/plain` → pass.
- Content-type rejected: `application/octet-stream`, `image/png`
  → `WebFetchUnsupportedContentTypeError`.
- Charset decoding: server returns ISO-8859-1 with non-ASCII →
  decoded correctly.
- Redirect 302 same-host → followed; final URL recorded; chain
  recorded.
- Redirect cross-host with `checkPolicy` returning `'allow'` →
  followed.
- Redirect cross-host with `checkPolicy` returning `'deny'` →
  `WebFetchPolicyRedirectError`.
- Redirect cross-host with `checkPolicy` returning `'ask'` →
  `WebFetchPolicyRedirectError` (mid-fetch ask = refusal).
- Redirect to `http://` URL → `WebFetchSchemeError`.
- Redirect chain length 6 → max-redirects error.
- Abort: AbortSignal fires mid-body → fetch rejects (caller
  treats as `aborted`).
- HTTP 404: returns FetchResult with status 404 and body, no
  throw.
- HTTP 500: same.
- TOCTOU: mock DNS to return public on first call, private on
  second; verify the pinned-IP `lookup` callback prevents the
  switch.

### Unit — `src/tools/WebFetchTool.test.ts` (new)

- `validateInput`:
  - missing url → `valid: false`.
  - non-string url → `valid: false`.
  - empty string → `valid: false`.
  - non-URL → `valid: false`.
  - http:// → `valid: false`.
  - userinfo → `valid: false`.
  - localhost / .local / .internal → `valid: false`.
  - well-formed https URL → `valid: true`.
- `getDomain`:
  - `{ url: 'https://A.GITHUB.com/x' }` → `'a.github.com'`.
  - missing url → `undefined`.
  - non-string → `undefined`.
- `checkPermissions`:
  - well-formed https URL → `allow` (cascade decides).
  - malformed URL (extractHost null) → `deny`.
- `call` (with `fetchWeb` mocked):
  - happy 200 text/plain → returns body wrapped in URL/Status
    header.
  - happy 200 text/html → returns `htmlToText(body)`.
  - 404 → returns body with status 404, `isError: false`.
  - `WebFetchPrivateAddressError` → `isError: true`,
    `errorKind: 'execution_error'`.
  - `WebFetchPolicyError` (first-hop) → same.
  - `WebFetchPolicyRedirectError` → same.
  - aborted → `isError: true`, `errorKind: 'aborted'`,
    `content: '[aborted]'`.
  - truncated → result content ends with `[truncated at 5 MB]`.
  - redirect chain length 2 → `Followed redirects:` line
    appears.
- `checkPolicy` closure (constructed inside `call`):
  - With a session rule `{ toolName: 'WebFetch', domain:
    'github.com', behavior: 'allow' }`, `checkPolicy('github.com')`
    → `'allow'`.
  - Same rule, `checkPolicy('evil.com')` → `'ask'`.
  - With a `*.github.com` allow rule,
    `checkPolicy('gist.github.com')` → `'allow'`,
    `checkPolicy('github.com')` → `'ask'`.
  - With a deny rule, deny wins over a sibling allow rule for
    the same host.

### Unit — `src/core/permissions/permissions.test.ts` (edit)

Add cases:

- Rule `{ toolName: 'WebFetch', domain: 'github.com', behavior:
  'allow' }` matches a tool use with host `github.com`.
- Same rule does not match `gist.github.com` (exact, not
  wildcard).
- Rule with `domain: '*.github.com'` matches `gist.github.com`
  but not `github.com`.
- Rule with both `path` and `domain` → both must match (both
  set on a synthetic tool that exposes both `getPath` and
  `getDomain`, just for this test).
- Rule with `domain` set on a tool without `getDomain` → does
  not match.
- `formatDecisionMessage` includes the domain when present.
- Existing path-based and tool-name-only rules continue to match.
- `findMatchingRules` is exported (compile-time + import test
  from a sibling test file).

### Unit — `src/core/tools/runToolUse.test.ts` (edit)

Add cases:

- `allow_by_rule` for a tool with both `getPath` and `getDomain`
  → `ruleCreated` carries both fields.
- `allow_by_rule` for a tool with only `getDomain` (e.g. WebFetch)
  → `ruleCreated` carries `domain` and no `path`.
- `allow_by_rule` for a tool with only `getPath` (e.g. FileRead)
  → `ruleCreated` carries `path` and no `domain` (existing
  behavior preserved).
- `allow_by_rule` for a tool with no `getPath` and no `getDomain`
  (e.g. Bash) → `ruleCreated` is tool-name only (existing
  behavior preserved).
- `allow_by_rule` for a domain-bearing tool whose `getDomain`
  returns `undefined` → `ruleCreated` is `undefined` (defensive
  escape per §6.5); AppState mutation skipped; payload still
  carries `userResponse: 'allow_by_rule'`.
- `isValidDomainPattern` rejects an invalid pattern slipping in
  via `getDomain` → `ruleCreated` omits the `domain` field;
  same defensive escape kicks in if no `path` either.

### Integration — `tests/integration/webFetch.test.ts` (new)

- End-to-end: spin up a local HTTPS test server (self-signed
  cert) and pass an `httpsAgent` configured to accept that cert
  via the `httpsAgent` DI hook on `FetchOptions`. Register
  `WebFetchTool`, drive a `tool_use` through `runToolUse`,
  assert the tool result.
  - First call → cascade prompts user (mock `askUser` returns
    `allow_by_rule`).
  - Permission rule inserted into AppState; `domain` field
    matches the test host.
  - Second call to same host → no prompt (rule matches).
  - Third call to a different host → prompts again.
  - Audit log captures `permission_decision`,
    `tool_call_started`, `tool_call_finished` for each.
- Skill activation: pre-activate a skill with
  `allowedTools: ['FileRead']`, attempt WebFetch → cascade denies
  at `skillScope` step.
- **PreToolUse-hook URL rewrite is caught.** Pre-authorize host
  `a.test` via a session rule. Register a PreToolUse hook that
  rewrites `input.url` to `b.test` (which has no rule). Drive
  the WebFetch call. Expect:
  - Cascade authorizes `a.test` (rule matches).
  - Hook rewrites to `b.test`.
  - `executeToolUse` re-runs `validateInput` (passes — both URLs
    are well-formed HTTPS).
  - `fetchWeb` first-hop `checkPolicy('b.test')` returns `'ask'`
    (no rule), throws `WebFetchPolicyError`.
  - Tool returns `{ isError: true, errorKind: 'execution_error',
    content: '<message about b.test>' }`.
  - Audit shows the original `permission_decision` for `a.test`
    AND the `tool_call_finished` error — together the forensic
    trail.

### Manual smoke

```bash
npm run typecheck
npm run test
# After install, drive through the CLI:
echo "Fetch https://example.com" | node dist/cli.js
# Expect: prompt for permission → allow_once → response shown.
```

`npm run typecheck && npm run test` green at every step.

---

## Acceptance

- `src/web/domainPolicy.ts` exports `extractHost`, `matchDomain`,
  `isValidDomainPattern`.
- `src/web/fetcher.ts` exports `fetchWeb`, `FetchOptions`
  (including `lookup` and `httpsAgent` DI hooks), `FetchResult`,
  `isPrivateAddress`, and the typed errors
  (`WebFetchSchemeError`, `WebFetchPrivateAddressError`,
  `WebFetchTimeoutError`, `WebFetchTooLargeError`,
  `WebFetchUnsupportedContentTypeError`,
  `WebFetchPolicyError`, `WebFetchPolicyRedirectError`,
  `WebFetchHttpError`).
- `src/web/htmlToText.ts` exports `htmlToText`.
- `src/tools/WebFetchTool.ts` exports `WebFetchTool: Tool`,
  registered as `'WebFetch'`.
- `src/core/tools/types.ts::Tool.getDomain?` and
  `ToolSpec.getDomain?` exist; `buildTool` propagates.
- `src/core/permissions/types.ts::PermissionRule.domain?` exists.
- `src/core/permissions/permissions.ts::findMatchingRules` is
  **exported**, threads `toolHost`, and matches on `domain` via
  `matchDomain`.
- `src/core/permissions/permissions.ts::formatDecisionMessage`
  prints the domain alongside path.
- `src/core/tools/runToolUse.ts::authorizeToolUse` constructs
  `ruleCreated` with `domain` from `tool.getDomain` (when
  defined and valid); refuses to construct an over-broad rule
  for domain-bearing tools whose `getDomain` returns undefined
  (defensive escape — call gets allow_once semantics).
- `AppState` is **unchanged** (no `webPolicy` field).
- `src/core/tools/registry.ts::createDefaultRegistry` registers
  `WebFetchTool` between `BashTool` and `AgentTool`.
- All existing Phase 1–5 tests stay green.
- `npm run typecheck && npm run test` green.
- A WebFetch call against a real public HTTPS URL succeeds
  end-to-end through the CLI with a one-time approval prompt.
- A PreToolUse hook that rewrites `input.url` to an
  unauthorized host is rejected at the fetcher's first-hop
  policy check (verified by integration test).

---

## Implementation order

Each step keeps the build green.

1. **Add `getDomain` to `Tool` and `ToolSpec`; thread
   `buildTool`.** Pure types; existing tools unaffected (optional
   method).
2. **Write `src/web/domainPolicy.ts` + tests.** Pure functions:
   `extractHost`, `matchDomain`, `isValidDomainPattern`.
3. **Add `domain` to `PermissionRule`; extend
   `findMatchingRules` (+thread `toolHost`) + export it +
   `formatDecisionMessage`.** Permission tests stay green
   because no rule sets `domain` yet. Add new tests for the
   domain branch.
4. **Edit `runToolUse.ts::authorizeToolUse`** to thread
   `getDomain` into `ruleCreated` with the defensive escape per
   §6.5. Add tests in `runToolUse.test.ts`.
5. **Write `src/web/htmlToText.ts` + tests.** Pure functions.
6. **Write `src/web/fetcher.ts` + tests.** Network module with
   `lookup` and `httpsAgent` DI hooks. First-hop policy check.
   Tests use injected `lookup` and self-signed cert via injected
   `httpsAgent`.
7. **Write `src/tools/WebFetchTool.ts` + tests.** Tool wrapper;
   `checkPolicy` closure reuses `findMatchingRules`; mock
   `fetchWeb` for the call-path tests.
8. **Register in `createDefaultRegistry`.** Existing
   `registry.test.ts` may need an updated default-count assertion.
9. **Write `tests/integration/webFetch.test.ts`.** End-to-end
   through `runToolUse` with a real test HTTPS server, including
   the PreToolUse-hook URL-rewrite case.
10. **Green.** `npm run typecheck && npm run test`.

6a closes the web-tool substrate. 6b adds `WebSearchTool` (same
policy module + cascade, different fetcher path), the `/web`
slash command for imperative rule management, and the
`~/.ultron/settings.json` load path that seeds initial
`permissionRules` (domain-scoped) at boot.

---

## Critical files to modify or create

- `src/web/domainPolicy.ts` (NEW)
- `src/web/domainPolicy.test.ts` (NEW)
- `src/web/fetcher.ts` (NEW)
- `src/web/fetcher.test.ts` (NEW)
- `src/web/htmlToText.ts` (NEW)
- `src/web/htmlToText.test.ts` (NEW)
- `src/tools/WebFetchTool.ts` (NEW)
- `src/tools/WebFetchTool.test.ts` (NEW)
- `tests/integration/webFetch.test.ts` (NEW)
- `src/core/permissions/types.ts` (EDIT — `domain?` on `PermissionRule`)
- `src/core/permissions/permissions.ts` (EDIT — domain match in
  `findMatchingRules` + export it + `formatDecisionMessage`)
- `src/core/permissions/permissions.test.ts` (EDIT — domain rule cases)
- `src/core/tools/types.ts` (EDIT — `getDomain?` on `Tool` /
  `ToolSpec`, propagate in `buildTool`)
- `src/core/tools/runToolUse.ts` (EDIT — thread `getDomain` into
  `ruleCreated` with the defensive escape per §6.5)
- `src/core/tools/runToolUse.test.ts` (EDIT — `allow_by_rule` +
  domain cases)
- `src/core/tools/registry.ts` (EDIT — register `WebFetchTool`)
- `src/core/tools/registry.test.ts` (EDIT — default-count
  assertion if any)
- `src/core/state.ts` — UNCHANGED. (Earlier draft proposed a
  `webPolicy` field; removed because it contradicted the cascade.
  See §1.)

## Reused existing utilities (do not re-implement)

- `src/core/tools/types.ts::buildTool` — same factory all v1
  tools use.
- `src/core/permissions/permissions.ts::runCascade` — the
  cascade is unchanged in shape; only `findMatchingRules` gains
  a parameter.
- `src/audit/auditLog.ts` — no changes; existing
  `tool_call_started` / `tool_call_finished` /
  `permission_decision` events carry the new metadata
  automatically.
- `src/memory/redact.ts::redactSecrets` — runs on every audit
  envelope; no extension needed for WebFetch (URL is in input,
  body in resultPreview, both walked).
- `src/hooks/runPreToolUseHooks.ts` /
  `src/hooks/runPostToolUseHooks.ts` — fire automatically because
  `WebFetchTool` is a `Tool`. No wiring.
- `src/skills/router.ts::filterToolDefs` — already accepts
  arbitrary canonical names; `'WebFetch'` works as-is.
- Node built-ins: `node:https`, `node:dns/promises`, `node:net`,
  `node:url` (global `URL`), `TextDecoder` (global). No new npm
  dependency.

## Verification end-to-end

```bash
npm run typecheck
npm run test
npx vitest run src/web/
npx vitest run src/tools/WebFetchTool.test.ts
npx vitest run src/core/permissions/permissions.test.ts
npx vitest run src/core/tools/runToolUse.test.ts
npx vitest run tests/integration/webFetch.test.ts

# Phase 5 tests stay green:
npx vitest run src/skills/
npx vitest run src/cli/skillsCommand.test.ts
# Phase 4 tests stay green:
npx vitest run src/memory/
# Phase 2 tests stay green:
npx vitest run src/hooks/
npx vitest run src/audit/
```

6a is a one-tool + one-substrate phase: success means a real
HTTPS URL fetches end-to-end through the cascade with a one-time
approval prompt, the response body lands in the model's tool
result (HTML stripped where applicable), `permission_decision` and
`tool_call_*` events are audited with the new `domain` metadata
visible, and a skill with `allowedTools: ['WebFetch']` activates
to a model session that can call WebFetch and nothing else. 6b
adds WebSearch on the same policy substrate; 6c adds CodeSandbox;
6d adds first-class attachments.
