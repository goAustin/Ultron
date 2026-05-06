# v3 Domain-Prompt UX Design

## Status

Implemented. Plan: `~/.claude/plans/tidy-doodling-willow.md`. Predecessors: Phase 0 (`computerUseSettings`), Phase 2 (`isDomainAllowed` + `extractHost` + `matchDomain`), Phase 3 (`SessionManager`, `BrowserSession` interface), Phase 4·1 (`computerSafetyChecks`, `ClassifyContext`, `decisionFromAssessment`). No new phase; this is a UX-correctness fix on top of the v3 spine.

Post-implementation review caught two bugs in v1: (a) `createPlaywrightSessionFactory` dropped the `getSessionAllowedHosts` factory param, leaving the production `PlaywrightBrowserSession` with the always-empty fallback overlay — `allow_once` would fail at the navigate-pre-flight check even though the cascade approved; (b) the `approvedDomainHook` in `QueryEngine` fired for every `Computer*` tool with `getDomain`, not just `ComputerNavigate`, so an `allow_by_rule` on a `ComputerType` sensitive-input prompt would persist the current page's host into `allowedDomains`. Both fixes are inline in this design doc and the plan; the integration test added in this round (`tests/integration/domainPrompt.integration.test.ts`) exercises the overlay propagation end-to-end so this regression class is caught next time.

## Context

When `computerUse.enabled === true` but `allowedDomains` is empty (the default after enabling), Ultron rejects every browser session with `BrowserSessionError(kind: 'allowlist_empty')` at `src/core/computer/sessionManager.ts:159-164`. Even after the user seeds one host, every fresh domain produces `BrowserSessionError(kind: 'domain_denied')` at `src/core/computer/playwrightBrowserSession.ts:372`. Both surface to the model as `errorKind: 'permission_denied'` (`src/tools/ComputerTools.ts:195`) — a terminal failure that the model treats as "give up and tell the user."

Reproduction:

```
you> open youtube.com
[error] allowedDomains must be non-empty for non-test sessions; configure computerUse.allowedDomains
I can't open YouTube in the browser here because this session doesn't allow that domain.
```

The fix is not to weaken the safety model. The denylist + HTTPS-only checks + per-action risk classifier remain the load-bearing safety primitives. The empty-allowlist hard-block is a *friction* control, not a *safety* control — it forces the user to predict every domain in advance, edit `~/.ultron/settings.json`, and restart. Replacing it with a runtime "Allow once / Allow by rule / Deny once" prompt — the same prompt the cascade already produces for `ComputerStart` — preserves the safety model and removes the friction.

## Goals

1. **Empty allowlist starts cleanly.** A user who just flipped `computerUse.enabled: true` can run "open youtube.com" without editing settings or restarting.
2. **Per-domain prompt reuses the existing UX.** No new prompt component, no new approval verbs. The existing `permissionPrompt.ts` 3-option UI carries `ComputerNavigate` exactly as it carries `ComputerStart` today.
3. **`Allow once` works correctly.** The cascade approval propagates to live policy before `BrowserSession.navigate()` runs — no second-layer rejection.
4. **`Allow by rule` survives restart.** Persisted to `~/.ultron/settings.json` via the existing `writeSettingsConfig` machinery; reloaded on next start through the existing `loadSettings` path. No new persistence layer.
5. **Subresource interception stays silent.** A YouTube watch page making 50 third-party fetches must not produce 50 prompts. Only top-level navigation reaches the cascade.
6. **SDK strict mode is preserved.** Headless / SDK callers can opt back into the "must seed allowlist" behavior with one boolean.

## Non-goals

- **No new permission verbs.** `allow_once`, `allow_by_rule`, `deny_once`, `abort` stay as-is. The four are sufficient.
- **No PSL (Public Suffix List) dependency.** `derivePersistencePatterns` does a conservative left-strip of `www.` and accepts that a host like `github.io` produces an over-broad `*.github.io` pattern. PSL would be the right call for a multi-tenant tool; for a single-user CLI it is over-engineering.
- **No prompt redesign.** The user explicitly considered (and declined) a four-option prompt that surfaces "Allow this site vs Allow this domain." The 3-option default + `derivePersistencePatterns` is the current contract.
- **No subresource prompts.** A page that hops to `googlesyndication.com` for an ad does not prompt; the route interceptor silently aborts that fetch as today.
- **No new safety check.** This change extends `computerSafetyChecks.ts`; no new entry in `permissionOpts.safetyChecks`.
- **No change to `BrowserSessionError` shape.** `'allowlist_empty'` and `'domain_denied'` kinds remain (used by SDK strict mode); only the unconditional CLI throw site goes away.
- **No CLI subcommand for managing allowlist.** Editing `settings.json` directly remains the escape hatch for power users; the `/permission` slash command is out of scope for v3.

## Approach

Four coordinated edits. The load-bearing trick is in edit (2): the safety check returns `behavior: 'allow'` (not `null`) for hosts already in the effective allowlist. Per `permissions.ts:111-117`, a non-null safety-check result short-circuits the cascade — steps 5–7 (mode / in-memory rules / fallback ask) skip entirely. This means we never need to broaden in-memory `PermissionRule` scope or touch `buildAllowByRule`; the safety check is the only gate.

### Edit 1 — gate the empty-allowlist hard-block on a new SDK setting

`src/core/computer/sessionManager.ts:159-164`: change the unconditional throw to:

```ts
if (settings.requireAllowlistAtStart && requireAllowlist && settings.allowedDomains.length === 0) {
  throw new BrowserSessionError('allowlist_empty', '...')
}
```

`requireAllowlistAtStart` is a new boolean on `ComputerUseSettings`, default `false`. CLI uses the default; SDK callers who want strict pre-flight pass `{ computerUse: { requireAllowlistAtStart: true } }`. The `BrowserSessionError(kind: 'allowlist_empty')` enum stays, the error-mapper at `src/tools/ComputerTools.ts:195` stays, and the `sessionManager.test.ts:146` case migrates under the strict branch.

### Edit 2 — three-way safety check for `ComputerNavigate`

`src/core/computer/policy.ts:218-225` currently classifies every `ComputerNavigate` as level 1 (defer). Replace with a host-aware classifier:

```ts
if (toolName === 'ComputerNavigate') {
  const host = extractHost(input.url)
  if (host === null) return { level: 1, category: 'reversible_ui', reason: 'unparseable URL' }
  if (matchesAny(deniedDomains, host)) return { level: 4, category: 'prohibited', reason: `domain ${host} denied` }
  if (matchesAny(effectiveAllowed, host)) return { level: 0, category: 'known_domain', reason: `${host} in allowlist` }
  return { level: 2, category: 'unknown_domain', reason: `${host} not in allowlist`, evidence: { nearbyText: host } }
}
```

`effectiveAllowed = settings.allowedDomains ∪ sessionAllowedHosts(sessionId)`. `matchesAny` walks the list and applies `matchDomain` per entry.

`decisionFromAssessment` (`src/core/permissions/computerSafetyChecks.ts:86`) grows a third arm:

```ts
if (assessment.category === 'known_domain') {
  return { behavior: 'allow', reason: { type: 'safetyCheck', message: assessment.reason, metadata } }
}
```

Today the function returns `null` for level 0/1 (defer) and `'ask'`/`'deny'` for higher levels. The `'allow'` arm is new and short-circuits the rest of the cascade for known domains — so the user is not prompted on every navigate to a host they've already approved.

`ClassifyContext` grows three optional fields: `allowedDomains`, `deniedDomains`, `sessionAllowedHosts`. The safety check populates them by reading the live `SessionManager` via two new public-interface methods (edit 3).

The prompt's `reason` string surfaces the host: `"ComputerNavigate to www.youtube.com — host not in computerUse.allowedDomains"`. The user sees what they are approving without needing to inspect the JSON `input` blob.

### Edit 3 — wire `allow_once` and `allow_by_rule` to live policy

The reviewer-caught bug: even when the cascade approves an `allow_once` for an unknown host, `BrowserSession.navigate()` immediately rejects with `domain_denied` because `_settings.allowedDomains` was not updated. Both responses must propagate to live policy before `call()` runs.

Two storage tiers:

- **Session overlay** — `SessionManager` keeps `Map<sessionId, Set<host>>`. `allow_once` adds to overlay; cleared on `BrowserSession.close()`. Lives in memory only.
- **Persistent allowlist** — `computerUse.allowedDomains` in `~/.ultron/settings.json`. `allow_by_rule` adds to overlay AND writes to disk via `writeSettingsConfig`.

`isDomainAllowed` (`src/core/computer/policy.ts:56`) grows an optional `sessionAllowedHosts: ReadonlySet<string>` parameter; the check tries the persistent allowlist first and the overlay second. Both call sites — route interceptor (`playwrightBrowserSession.ts:301`) and navigate pre-flight (`:364`) — pass a `SessionManager`-supplied `getSessionAllowedHosts` accessor.

Hook point: `runToolUse.ts:179` (the post-decision branch) invokes a generic `approvedDomainHook` for domain-bearing approvals. `QueryEngine` deliberately handles only `ComputerNavigate` responses there: other Computer tools also expose a current-page `getDomain`, but their prompts are about sensitive input, dangerous clicks, or handoff — not about granting navigation rights to the host. For `ComputerNavigate` with `response ∈ {allow_once, allow_by_rule}`, resolve the host via `tool.getDomain(input)` and call:

- `sessionManager.allowDomainForSession(sessionId, host)` — both responses.
- `sessionManager.persistAllowedDomain(host)` — `allow_by_rule` only. Internally:
  1. `derivePersistencePatterns(host)` produces `[apex, *.apex]`.
  2. Append both patterns to `settings.allowedDomains` (dedupe).
  3. `writeSettingsConfig({ computerUse: { allowedDomains: next } })`.
  4. Call `BrowserSession.refreshSettings(next)` on every live session so the route interceptor and navigate pre-flight see the new list.

`sessionId` is read from `toolUse.input.sessionId`, which every `Computer*` tool requires per `ComputerTools.ts` schemas.

### Edit 4 — hot-reload via `refreshSettings`

`BrowserSession` interface (`src/core/computer/types.ts`) gains:

```ts
refreshSettings(next: ComputerUseSettings): void
```

`PlaywrightBrowserSession._settings` drops `readonly` and becomes a mutable pointer. `refreshSettings` reassigns. The route interceptor and navigate pre-flight already dereference `this._settings.allowedDomains` per call, so the swap is atomic for any subsequent request — no race window.

Test fakes get a no-op `refreshSettings` (or one that records the last passed value for assertion in `sessionManager.test.ts`).

## Key design decisions

### Safety check returns `'allow'` (not `null`) for known hosts

The cascade short-circuits on any non-null safety-check return. Returning `'allow'` for known hosts means we never reach the in-memory `PermissionRule` lookup, so we don't have to broaden the `buildAllowByRule` scope to handle wildcard patterns. `buildAllowByRule` (`runToolUse.ts:211`) keeps its current behavior of producing exact-host rules; those rules are now redundant for `ComputerNavigate` (the safety check authorizes first), but keeping them is harmless and keeps the `Tool` interface consistent across all tools.

### `derivePersistencePatterns(host)` strips leading `www.`, returns `[apex, *.apex]`

Examples:

| Input | Output |
|---|---|
| `www.youtube.com` | `[youtube.com, *.youtube.com]` |
| `youtube.com` | `[youtube.com, *.youtube.com]` |
| `studio.youtube.com` | `[studio.youtube.com, *.studio.youtube.com]` |
| `github.io` | `[github.io, *.github.io]` |

Rationale: `*.youtube.com` does NOT match the apex `youtube.com` (`domainPolicy.ts:84`), so persisting only the wildcard would re-prompt the user on the apex. Persisting both is the simplest correct fix. Stripping `www.` covers the common "user typed the canonical homepage URL" case. Stripping nothing else keeps the helper PSL-free and predictable; the documented limitation is that subdomain-first navigations and eTLD hosts (`github.io`, `vercel.app`) produce narrower-than-ideal or broader-than-ideal patterns. Power users edit `settings.json`.

### Session overlay vs persistent allowlist

`allow_once` lives in memory; `allow_by_rule` lives on disk. The overlay is a `Map<ComputerSessionId, Set<string>>` on `SessionManager`, keyed by session ID, cleared in `closeOnce`. This means:

- A user picking `allow_once` for `youtube.com` can navigate to `youtube.com` for the rest of the session without re-prompting (consistent "approval lasts for this session").
- The same user starting a new session re-prompts (consistent "approval was just for that session").
- A user picking `allow_by_rule` once never re-prompts again, across sessions and process restarts.

The overlay is intentionally per-session, not per-process — closing one session does not affect another live session's overlay, but a fresh session has an empty overlay even if a sibling session approved `youtube.com` two minutes ago. This is a defensible default; the alternative (process-wide overlay) makes `allow_once` semantically closer to `allow_by_rule` in surprising ways.

### `requireAllowlistAtStart` defaults to `false` for CLI, opt-in `true` for SDK

The CLI is interactive — a prompt is the right UX when the user is at the keyboard. The SDK is often headless (CI, batch jobs); a prompt has no operator to answer. The new boolean lets SDK callers preserve the old "fail-fast at session start" behavior without the CLI carrying the friction:

```ts
new SessionManager({ settings: { ...settings, requireAllowlistAtStart: true }, ... })
```

This is pure plumbing; the existing `validateComputerUseSettings` accepts the new field with a `boolean` validator and `false` default (`computerUseSettings.ts`).

## Files to change

Source:

- `src/config/computerUseSettings.ts` — add `requireAllowlistAtStart` field; add `derivePersistencePatterns(host)` helper.
- `src/core/computer/policy.ts` — extend `classifyAction` for `ComputerNavigate`; add `'known_domain'` and `'unknown_domain'` to `RiskCategory`; widen `isDomainAllowed` to accept session overlay.
- `src/core/computer/sessionManager.ts` — gate `allowlist_empty` throw; add `getSettings`, `getSessionAllowedHosts`, `allowDomainForSession`, `persistAllowedDomain`; clear overlay in `closeOnce`.
- `src/core/computer/types.ts` — extend `ComputerSessionManager` interface with the four new methods; add `BrowserSession.refreshSettings(next)`.
- `src/core/computer/playwrightBrowserSession.ts` — drop `readonly` on `_settings`; implement `refreshSettings`; pass overlay into `isDomainAllowed` at navigate (`:364`) and route interceptor (`:301`).
- `src/core/permissions/computerSafetyChecks.ts` — `decisionFromAssessment` grows `'allow'` arm for `'known_domain'`; threads `allowedDomains`/`deniedDomains`/`sessionAllowedHosts` into `ClassifyContext`; surfaces host in `reason`.
- `src/core/tools/runToolUse.ts` / `src/sdk/QueryEngine.ts` — after a positive `ComputerNavigate` response (`allow_once`/`allow_by_rule`), call `allowDomainForSession`; for `allow_by_rule`, also call `persistAllowedDomain`.

Tests:

- `src/core/computer/sessionManager.test.ts:146` — `allowlist_empty` test moves under `requireAllowlistAtStart: true` branch; new tests for overlay lifecycle (cleared on `close`) and `persistAllowedDomain` (writes settings + calls `refreshSettings` on live sessions).
- `src/tools/ComputerTools.test.ts:479` — same gating.
- `src/core/computer/policy.test.ts` — new cases for `ComputerNavigate` × {known persistent, known overlay, unknown, denied, malformed URL}.
- `src/core/permissions/computerSafetyChecks.test.ts` — new cases: `ComputerNavigate` to known host returns `behavior: 'allow'`; unknown returns `'ask'` with host in `reason`; denied returns `'deny'`.
- `src/core/tools/runToolUse.test.ts` — new cases: `allow_once` for `ComputerNavigate` calls `allowDomainForSession` only; `allow_by_rule` calls both methods.
- `src/config/computerUseSettings.test.ts` — `derivePersistencePatterns` matrix per the table above; `requireAllowlistAtStart` validation (boolean coercion, default).

Docs:

- `docs/computer-use.md` — replace the "must seed `allowedDomains` first" prerequisite with a "you'll be prompted on first navigate" walkthrough; document `requireAllowlistAtStart` for SDK callers.

## Verification

1. **Unit**: `npm run test -- policy computerSafetyChecks runToolUse sessionManager computerUseSettings` passes.
2. **Type**: `npm run typecheck` clean.
3. **Integration** (env-gated, requires Chromium):
   - `ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run tests/integration/phase6Acceptance.integration.test.ts` — existing suite still green.
   - New case: empty allowlist → `ComputerStart` succeeds → `ComputerNavigate https://www.youtube.com` produces an `'ask'` permission event → simulate `allow_by_rule` → second navigate to `https://m.youtube.com` proceeds without prompt → settings.json now contains `youtube.com` and `*.youtube.com`.
4. **Manual smoke** (the original failing flow):
   - `cd /Users/aiklig/Projects/mmx && node /Users/aiklig/Projects/Ultron/dist/cli.js`
   - `you> open youtube.com`
   - Expect: prompt appears with `Reason: ComputerNavigate to www.youtube.com — host not in computerUse.allowedDomains`.
   - Pick `Allow by rule` → page loads → `cat ~/.ultron/settings.json` shows `youtube.com` and `*.youtube.com` in `computerUse.allowedDomains`.
   - Restart CLI → `you> open music.youtube.com` → no prompt; page loads.

## Open questions / future work

- **Process-wide overlay?** Currently the overlay is per-session. If users routinely run multiple concurrent sessions that all want the same approval, a process-wide overlay (cleared on CLI exit) might reduce duplicate prompts. Defer until a real workload demands it.
- **`/permission allowlist add youtube.com` slash command?** The escape hatch today is editing `settings.json`. A slash command would be friendlier but is orthogonal to this fix; defer.
- **PSL integration for `derivePersistencePatterns`?** Would let `studio.youtube.com` correctly persist `[youtube.com, *.youtube.com]`. Requires either a runtime PSL dependency or a vendored snapshot. Defer; document the limitation.
- **Wildcard prompts?** Adding a fourth option ("Allow this site vs Allow this domain") was considered and declined for this iteration. If user feedback shows the auto-derived pattern is too narrow or too broad too often, revisit.
