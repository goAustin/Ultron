# v3 Phase 7 Design: Documentation and Release

## Status

Drafted; not yet implemented. Roadmap: `docs/ultron_v3/v3-computer-use-plan.md` lines 789–803 (Phase 7 deliverables) and 854–872 (Success Criteria). Predecessors: Phase 0/1/2/3/4·1/4·2/4·3/4b/5 (committed in `7be60f9` and `5ac4112`) and Phase 6 (in working tree at the time of writing — `tests/fixtures/computerUse/`, `tests/integration/phase6Acceptance.integration.test.ts`, `src/core/computer/sessionMetrics.test.ts`, plus modifications to `playwrightBrowserSession.{ts,test.ts}`, `sessionManager.ts`, `types.ts`, `ComputerTools.test.ts`, `QueryEngine.test.ts`, `computerSafetyChecks.test.ts`). Successor: none — Phase 7 closes v3.

Phase 7 is **documentation-only.** Zero runtime changes, zero new modules under `src/`, zero new tests. The deliverable is user-facing prose that lets a non-author enable Computer-Use safely, understand the data flow, and turn it off.

## Context

The v3 codebase is feature-complete after Phase 6: 11 `Computer*` tools registered behind `computerUse.enabled`, the DOM-first atom path, the policy/redaction/verify/watch-mode/storageState/handoff stack, the Computer-Use system-prompt section, the per-session step counter, and the Phase 6 acceptance suite proving the spine end-to-end. Nothing in the repo today tells a **user** how to:

- Turn the feature on for a single allowlisted domain.
- Understand what bytes leave the box (screenshots, ARIA tree text, observation prose).
- Read what each `computerUse.*` setting does.
- Recover from a missing Chromium install or a Playwright postinstall failure.
- Tell which scenarios v3 is **not** good at (Cloudflare-protected sites, desktop apps, native provider bridges).

The v3 plan's `## Configuration` block (lines 466–498) and `## Permission And Safety Model` block (lines 220–262) are the source of truth for settings and risk levels respectively, but they live inside the engineering plan — a user opening the repo cold has no entry point. Phase 7 supplies that entry point.

Phase 7 satisfies the three v3-roadmap acceptance criteria (`v3-computer-use-plan.md:799-803`):

| Criterion | Phase 7 proof |
|---|---|
| A user can enable Computer-Use for one allowlisted domain and complete a simple browser task | "Quick start" section walks through `settings.json` → `npx playwright install chromium` → first run, mirroring fixture 1 (`searchForm.ts`) as a real public-domain example |
| A user can understand which data may be sent to the model | "What leaves the machine" section enumerates the four egress channels (screenshot bytes, ARIA tree, URL+title, audit metadata) with redaction defaults and the toggle for each |
| A user can see how to disable Computer-Use completely | "Disabling" section: set `computerUse.enabled: false`; tools are not registered; no Playwright module loads (Phase 3 lazy-import contract) |

## Phase 0–6 prerequisites

- **Phase 0** — `defaultComputerUseSettings` + `validateComputerUseSettings` (`src/config/computerUseSettings.ts:66-86, 216-330`) is the source of truth for the settings table. Phase 7 docs MUST reference field names + defaults verbatim from this module so a settings-table drift is caught by `git diff`.
- **Phase 1** — image-attachment plumbing is the egress channel for screenshot bytes. The "What leaves the machine" section explains that screenshots are downscaled to `displaySize` (default `1024×768`) and capped at `maxScreenshotBytes` (default 2 MB) before emission.
- **Phase 2** — `npx playwright install chromium` requirement and `BrowserSessionError(kind: 'chromium_not_installed')` failure mode are the troubleshooting section's primary entries. The existing CLAUDE.md note (lines 25–28) is the seed.
- **Phase 3** — disabled-state contract: when `enabled: false`, `createComputerUseTools` is never called, the lazy `BrowserSessionFactory` import never fires, and `ComputerStart` returns the existing `'tool_not_found'` error if a stray model still tries to call it. This is the load-bearing claim of the "Disabling" section.
- **Phase 4·1** — the risk-level table (`v3-computer-use-plan.md:225-233`) is reproduced verbatim in the security section. The five non-bypassable safety checks (`v3-computer-use-plan.md:235-247`) are the bulleted list under "Safety guarantees."
- **Phase 4·2** — `redaction.ts` + the `redactionSelectors` setting are the two knobs documented under "Screenshot redaction." The default selectors (password fields, MFA inputs, payment fields, sensitive ARIA roles) are listed; `redactionSelectors` is shown as the extension point.
- **Phase 4·3** — the storageState handoff flow is documented under "Authenticated sites" with the `allowAuthHandoff: true` toggle and the per-session scratch directory location.
- **Phase 4b** — the DOM-first atom path is mentioned in "How it works" so users understand why an action might land deterministically without a screenshot round-trip; coordinate tools are documented as the fallback.
- **Phase 5** — the system-prompt section, step counter, and no-progress detector are mentioned under "Loop discipline." The `<untrusted-page-text>` wrapper is the load-bearing example of "Webpage content is hostile" in the security section.
- **Phase 6** — the acceptance fixtures (`tests/fixtures/computerUse/pages/`) are the *worked examples* the user docs cite. Fixture 1 (`searchForm.ts`) backs the quick-start; fixture 4 (`loginHandoff.ts`) backs the auth-handoff section; fixture 8 (`promptInjection.ts`) backs the prompt-injection caveat.

Phase 7 does **not** add new functionality, does **not** modify settings defaults, and does **not** introduce new failure modes. Every claim in the user docs cites code or design doc that already exists.

## Goals

1. **One user-facing doc, one canonical entry point.** `docs/computer-use.md` is the single file a user opens. It stays at the top level of `docs/` beside other user-facing references; versioned design archives live under `docs/ultron_v*/`. Section headers map 1:1 to the five Phase 7 deliverables (enable, security, settings, troubleshooting, limitations).
2. **README pointer.** One line added to `README.md` under the existing v2 paragraph: a sentence noting that v3 ships Computer-Use, gated off by default, with a link to `docs/computer-use.md`. No restructuring of README; one cohesive sentence.
3. **CLAUDE.md expansion.** The current 4-line Computer-Use paragraph (lines 25–28) becomes a small subsection under `## Commands`: keeps the install command and the integration-suite command, adds a one-line pointer to the user doc and a one-line pointer to `docs/ultron_v3/v3-computer-use-plan.md` for engineering context. **Contributor-facing**, not user-facing — describes how to test the feature, not how to use it.
4. **v3 plan status update.** `docs/ultron_v3/v3-computer-use-plan.md` Phase 7 deliverables block (lines 789–803) gets a "Status: complete" line and a pointer to the user doc. The Open Questions section is reviewed; resolved questions get inline annotations.
5. **Settings reference is grounded in code.** The settings table in `docs/computer-use.md` is generated by hand but cross-checked against `defaultComputerUseSettings` (`src/config/computerUseSettings.ts:66-86`); every field name + default value matches. A future settings change that updates `defaultComputerUseSettings` without updating the doc table will be caught at PR review (no runtime check; this is a discipline statement).
6. **Walkthrough is reproducible.** The quick-start uses `example.com` (which Profile A can reliably reach without WAF interference) and walks through enabling exactly one allowlisted domain, starting a session, observing, navigating, and stopping. The session is read-only — no form submission, no auth, nothing requiring approval.
7. **Limitations are explicit, not implicit.** The "Limitations" section enumerates Profile A's known weaknesses (Cloudflare/DataDome bot detection, no managed stealth, no desktop apps, no native provider bridges) and the deferred-policy items (`allowDownloads` / `allowUploads` validated but not yet enforced — see Phase 6 design fixture 10 caveat). Reading this section, a user can decide before turning it on whether their use case is in-scope for v3.

## Non-goals

- **No new runtime modules, no new tests, no settings changes.** Pure documentation phase.
- **No video walkthroughs, no screenshots embedded in the doc.** Markdown-only; the doc lives in the repo and renders cleanly on GitHub. Embedded screenshots would need an `assets/` subdirectory and image hosting that this repo does not have.
- **No CHANGELOG.md, no release notes, no version bump.** Ultron has no `CHANGELOG.md` today and is not versioned for distribution. Adding either would be scope creep.
- **No man pages, no `--help` text changes, no CLI subcommand for "show computer-use settings".** The `/help` slash command lives in a different layer; Phase 7 does not touch it.
- **No multi-language docs.** English only. Adding ja/zh would be a separate phase.
- **No "best practices" section that prescribes specific allowlist patterns or risk thresholds.** Each user's environment is different; the doc explains the mechanism and lets the user decide. Prescriptive advice would age poorly.
- **No comparison-to-Claude-Code section, no marketing copy.** This is reference documentation, not product positioning.
- **No standalone "Security model" markdown.** Security is one section of `docs/computer-use.md`. A separate `docs/computer-use-security.md` would fragment the read; a user evaluating "should I turn this on?" needs all four concerns (enable, security, settings, troubleshooting) on one scrollable page.
- **No `docs/ultron_v2/v2-scope.md` rewrite.** v2 already points Computer-Use to v3 (per Phase 0). One-line annotation noting v3 is shipped is sufficient; the historical content stays.
- **No reference docs for `BrowserSession` / `ComputerSessionManager` interfaces.** Engineering-facing; lives in the existing per-phase design docs and JSDoc comments. Phase 7 user docs do not duplicate them.
- **No regenerated `tsdoc` / `typedoc` site.** Out of project conventions.

## Key design decisions

### File layout — one user doc + light edits to two existing files

```
docs/
├── computer-use.md         # NEW — single-file user doc, ~600–900 lines
├── computer-use-plan.md    # already exists under docs/ultron_v3/; Phase 7 adds a "Status" line at the bottom
└── ...
README.md                   # add 1 line under the v2 paragraph
CLAUDE.md                   # expand the existing 4-line Computer-Use paragraph (lines 25–28) into a 6–8 line subsection
```

**Why one user doc and not five:** the read-flow is "I want to try this — is it safe? what does it do? what won't it do? how do I install it? how do I turn it off?" Splitting that into five files forces users to context-switch between docs that all share assumptions. One file lets a reviewer answer "is this safe enough to turn on?" in a single scroll. Engineering design docs live separately under `docs/ultron_v3/` for the deeper context.

### `docs/computer-use.md` outline

```
# Computer-Use (v3)

> One-paragraph TL;DR: opt-in browser automation, gated by default,
> sandboxed in a fresh Playwright Chromium per session, action-by-action
> permission cascade. Off unless you set `computerUse.enabled: true` in
> `~/.ultron/settings.json` AND list at least one allowlisted domain.

## Quick start
  - Install Chromium: `npx playwright install chromium`
  - Edit settings.json
  - First run walkthrough (read-only on example.com)
  - What you should see (model output sketch)

## How it works
  - Per-session Playwright browser context (sandboxed)
  - DOM-first atom path (preferred) + coordinate fallback
  - Stabilization + post-action verify
  - Step counter + duration timeout

## Security model
  - Five non-bypassable safety checks
  - Risk levels (table, copied verbatim from v3 plan §Permission And Safety Model)
  - Domain allowlist (top-level + subresource enforcement)
  - Headless = strict-deny for any "ask"
  - Webpage content is untrusted (`<untrusted-page-text>` wrapper)
  - Screenshot redaction (built-in selectors + extension via `redactionSelectors`)
  - Auth handoff is opt-in (`allowAuthHandoff`) and never logs form values

## What leaves the machine
  Four egress channels:
    1. Screenshot bytes — downscaled, redacted, capped, sent to model only
    2. ARIA snapshot text — redacted, token-budgeted
    3. URL + page title — wrapped in `<untrusted-page-text>`
    4. Audit metadata — host + dimensions + hash; NOT raw bytes by default
  Toggle table: which setting controls each channel
  Cookies and storageState — only persisted if you opt in

## Settings reference
  Table of every `computerUse.*` field with default + description.
  Worked examples for the four most common scenarios:
    - Read-only public site
    - Internal app behind a single allowlisted domain
    - Authenticated site (allowAuthHandoff: true)
    - Tightening: lower maxSteps, expand redactionSelectors

## CLI watch mode
  `watchMode: true` and a TTY stderr → one line per Computer-tool event

## Troubleshooting
  - Chromium not installed → `npx playwright install chromium`
  - "Domain not on allowlist" → add to `allowedDomains`
  - Cloudflare/DataDome blocks → known v3 limitation (Profile A)
  - "Approval required" headless → set `permissionMode` interactively or relax via rule
  - Session won't close → step / duration timeout, abort

## Limitations
  - Profile A (local Playwright) only; no managed stealth, no desktop
  - Cloudflare/DataDome bot detection breaks public web behind WAFs
  - No native provider bridges (OpenAI/Anthropic CUA APIs) in v3
  - `allowDownloads` / `allowUploads` are validated but not yet enforced
  - Subagent forks don't inherit step counters
  - DSF override is test-only (not exposed to the model)

## Disabling Computer-Use
  Set `computerUse.enabled: false` (or omit the section).
  Tools are not registered; the Playwright module is never loaded.
  No `npm uninstall` needed; no leftover state.

## Where to learn more
  - `docs/ultron_v3/v3-computer-use-plan.md` — engineering plan
  - `docs/ultron_v3/v3-phase{0..7}-design.md` — per-phase designs
```

Estimated length: ~600 lines including code blocks. ~50 lines per H2 section on average.

### Quick-start walkthrough — `example.com`, not a custom fixture

The quick-start uses `example.com` as the allowlisted domain. Reasons:

- It's a stable, reachable, no-WAF, no-JS-required public site that Profile A handles reliably.
- It demonstrates the full life cycle (start → navigate → observe → stop) without any approval prompts (no forms, no dangerous labels).
- It's a single round-trip; the user can read the model's output and the audit metadata in under a minute.
- It does NOT require running the user-private fixture server from `tests/fixtures/computerUse/`. Those fixtures are integration-test infrastructure, not user examples.

The walkthrough does NOT use a real Google search, banking site, or anything WAF-protected. The first paragraph of the section explicitly tells the user that public-web reliability is limited (forward-reference to "Limitations") and that the recommended use case is an internal app or a known-good domain.

### Settings table source-of-truth discipline

The settings table is hand-written but every entry is cross-checked at PR-review time against:

```ts
// src/config/computerUseSettings.ts:66-86
export const defaultComputerUseSettings: ComputerUseSettings = { ... }
```

Field names, default values, and ranges (where range-validated) are copied verbatim. Description prose is original to the doc but cites the relevant phase design when behavior is non-obvious (e.g., `verifyActions` cites Phase 4·2; `allowAuthHandoff` cites Phase 4·3). A future change to `defaultComputerUseSettings` without a corresponding doc update is the reviewer's catch — there is no runtime cross-check (out of Phase 7 scope; would require a dedicated test that imports the doc and parses the table).

### Risk-level table — verbatim copy

The risk-level table from `v3-computer-use-plan.md:225-233` is reproduced verbatim in the security section, with a one-line note crediting the source. Two reasons:

- It's the load-bearing security primitive; rephrasing risks introducing inconsistency.
- It's small (5 rows × 3 columns); maintaining duplicates is cheap and the duplication is intentional (the user doc must stand alone for users who don't read engineering design docs).

A future risk-level change would update both the v3 plan and the user doc together — same review discipline as the settings table.

### What the security section explicitly does NOT promise

The security section is honest about boundaries:

- **Profile A is not a stealth browser.** WAF-based bot detection (Cloudflare, DataDome) will identify and block sessions on protected sites in 2026. This is documented as a v3 limitation, not a v3 bug.
- **Audit captures metadata, not screenshot bytes by default.** A determined attacker with filesystem access could enable `debugPersistScreenshots: true` to capture bytes — but that's an explicit, settings-gated opt-in.
- **The `<untrusted-page-text>` wrapper is a prompt-engineering primitive, not a sandbox.** A sufficiently capable model can be tricked by a sufficiently sophisticated injection attack. Phase 6 fixture 8 proves the wrapper bytes survive end-to-end; it does NOT prove that any specific model honors the rule under attack. The doc says this plainly.
- **Domain allowlist is enforced at navigation time AND subresource interception.** A page allowed to navigate cannot pull resources from a denied domain. But a page allowed to navigate CAN run JavaScript that calls allowlisted APIs to exfiltrate data — domain allowlist is a navigation control, not a data-exfil control.
- **Auth handoff exists for user convenience, not for credential safety.** The user types the password into a real Chromium window; Ultron never sees the bytes, but Ultron also doesn't validate the auth flow. The user is responsible for trusting the page they're handing off to.

### Troubleshooting section — failure-first, not feature-first

The troubleshooting section is organized by **observed failure**, not by feature:

```
Symptom: "BrowserSessionError: chromium_not_installed"
Cause:   Playwright Chromium binary not present
Fix:     npx playwright install chromium
```

This format mirrors how Stack Overflow, GitHub issues, and runbooks are read. A user with a problem doesn't browse a feature list; they search for the error string they just saw. Each entry includes the exact error string the user will see, the cause, and the fix.

Five planned entries:

1. `BrowserSessionError: chromium_not_installed` → install command.
2. `BrowserSessionError: domain_not_allowed` → add to `allowedDomains` (with format guidance).
3. Connection refused / Cloudflare challenge page → known Profile A limitation.
4. `permission_ask` followed by tool error in non-interactive mode → headless = strict-deny; set `permissionMode` or add an allow rule scoped to the same domain + tool + risk class.
5. Session exceeded `maxSteps` / `maxDurationMs` → step or duration timeout; raise the setting or split the task.

### Limitations section — explicit deferrals

Each limitation cites the phase that ships the eventual fix (or "no scheduled fix"):

| Limitation | Phase that addresses it (if any) |
|---|---|
| Profile A only (no managed stealth) | Future profile work — no scheduled phase |
| Cloudflare/DataDome bot detection | Profile B (managed stealth) — no scheduled phase |
| No desktop GUI support | Profile C (container desktop) — no scheduled phase |
| No native OpenAI/Anthropic CUA bridges | Stretch Phase (deferred per `v3-computer-use-plan.md:728-754`) |
| `allowDownloads`/`allowUploads` not enforced | Out of v3 scope; documented in Phase 6 design (fixture 10 caveat) |
| Subagent forks don't inherit step counts | Out of v3 scope per Phase 5 design |
| DSF override is test-only | Phase 6 deliberate posture — model-facing tools never expose DSF |
| `_metrics` map has no TTL | Engine-scoped lifetime is sufficient for single-CLI use; out of v3 scope |

This table sets honest expectations: a user reading Phase 7 docs in 2027 can see which limitations are likely to be lifted in a future phase versus which are architectural.

### CLAUDE.md update — contributor-facing only

The current paragraph (CLAUDE.md:25–28):

```
Computer-Use (v3) requires Chromium. After `npm install`, run `npx playwright install chromium` once. CI may set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` since the integration suite is env-gated. Run the Playwright integration suite with:
ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run src/core/computer/playwrightBrowserSession.integration.test.ts
```

Becomes (Phase 7 expansion):

```
### Computer-Use (v3)

Requires Chromium. After `npm install`, run `npx playwright install chromium` once. CI may set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` since the integration suite is env-gated. Run the Playwright integration suite with:

```bash
ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run src/core/computer/playwrightBrowserSession.integration.test.ts
ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run tests/integration/phase6Acceptance.integration.test.ts
```

User-facing docs: [docs/computer-use.md](docs/computer-use.md). Engineering plan: [docs/ultron_v3/v3-computer-use-plan.md](docs/ultron_v3/v3-computer-use-plan.md).
```

Two new lines: the Phase 6 acceptance suite invocation and the doc pointers. The existing `npx playwright install chromium` and integration-suite lines are preserved verbatim.

### README.md update — one line under the v2 paragraph

Current paragraph (README.md:5):

```
New implementation code lives under `src/`. v1 is complete — the v1 roadmap and per-phase designs are archived under [`docs/ultron_v1/`](docs/ultron_v1/). v2 direction lives in [`docs/ultron_v2/v2-scope.md`](docs/ultron_v2/v2-scope.md).
```

Phase 7 appends one sentence:

```
v3 ships browser-based Computer-Use, **disabled by default**; see [`docs/computer-use.md`](docs/computer-use.md) for enabling, security, settings, and limitations, or [`docs/ultron_v3/v3-computer-use-plan.md`](docs/ultron_v3/v3-computer-use-plan.md) for the engineering plan.
```

No restructure; one sentence; standard cross-link style matching the surrounding text.

### v3 plan status annotation

`docs/ultron_v3/v3-computer-use-plan.md` Phase 7 block (lines 789–803) gets a small status header inserted after `### Phase 7 - Documentation And Release`:

```
### Phase 7 - Documentation And Release

**Status:** complete. User docs at [docs/computer-use.md](../computer-use.md). Per-phase design at [docs/ultron_v3/v3-phase7-design.md](v3-phase7-design.md).

Deliverables:
...
```

Three lines added. The deliverables list and acceptance criteria stay verbatim — they remain the contract Phase 7 is judged against.

### What does NOT change

- `src/` — untouched. Phase 7 is documentation-only.
- `tests/` — untouched.
- `package.json` — untouched (no version bump, no new deps).
- `tsconfig.json`, `vitest.config.ts` — untouched.
- `docs/ultron_v2/v2-scope.md` — untouched. v2 already references v3 for Computer-Use; one annotation in the v3 plan is sufficient.
- `AGENTS.md` — untouched. The contributor-facing build/test guidance there is unchanged by Phase 7.
- The other v3 phase design docs (Phase 0/1/2/3/4·1/4·2/4·3/4b/5/6) — untouched. Their status was set when each phase landed; Phase 7 doesn't restate that history.

## Files

### New

- `docs/computer-use.md` — single-file user doc (the load-bearing deliverable).
- `docs/ultron_v3/v3-phase7-design.md` — this design.

### Modified

- `README.md` — add one sentence under the existing v2 paragraph (line 5).
- `CLAUDE.md` — expand the existing 4-line Computer-Use paragraph (lines 25–28) into a `### Computer-Use (v3)` subsection under `## Commands` with the Phase 6 acceptance-suite line and the doc pointers.
- `docs/ultron_v3/v3-computer-use-plan.md` — insert a 1-line **Status: complete** annotation under the `### Phase 7 - Documentation And Release` header (line 789).

## Implementation order

1. **Design doc.** This file. Done before user-facing prose, per project convention.
2. **`docs/computer-use.md` v0 — skeleton.** Empty H2/H3 headers per the outline above. Compile-check links by reading the file in markdown preview. No prose yet; lets the user critique the structure before content commits.
3. **`docs/computer-use.md` v1 — quick start + how it works.** Fill in §Quick start (the highest-leverage user-facing section) and §How it works. The acceptance criterion "user can enable Computer-Use for one allowlisted domain and complete a simple browser task" is satisfied at this point.
4. **`docs/computer-use.md` v2 — security + what leaves the machine.** Fill in the two safety-critical sections. The acceptance criterion "user can understand which data may be sent to the model" is satisfied at this point.
5. **`docs/computer-use.md` v3 — settings reference.** Hand-build the table; cross-check every row against `defaultComputerUseSettings`.
6. **`docs/computer-use.md` v4 — watch mode + troubleshooting + limitations + disabling.** Fill remaining sections. The acceptance criterion "user can see how to disable Computer-Use completely" is satisfied at this point.
7. **README.md + CLAUDE.md updates.** One-sentence README addition; expand CLAUDE.md Computer-Use paragraph into a subsection with the Phase 6 acceptance-suite invocation and the doc pointers.
8. **v3 plan status annotation.** Three lines under the Phase 7 header in `v3-computer-use-plan.md`.

PR shape (chosen during planning): **one PR.** Phase 7 is doc-only — no test surface, no review-blocking dependencies between sections, and splitting docs across PRs makes the cross-links ugly. The PR description references the four cross-checks (settings table ↔ `defaultComputerUseSettings`; risk-level table ↔ v3 plan; quick-start ↔ Phase 6 fixture 1; troubleshooting ↔ documented `BrowserSessionErrorKind` values).

## Verification

1. `npm run typecheck` — clean (Phase 7 changes nothing TypeScript-visible).
2. `npm run test` — clean (Phase 7 changes nothing test-visible).
3. **Manual link check:** every internal `[link](path)` in `docs/computer-use.md` resolves to an existing file. Every `src/` reference resolves to an existing module. Every CLI command runs (`npx playwright install chromium` is the user-facing one; the integration suite invocation is verified by being copy-pasted from CLAUDE.md).
4. **Acceptance criteria audit** (per `v3-computer-use-plan.md:799-803`):
   - User can enable Computer-Use for one allowlisted domain and complete a simple browser task → §Quick start walks through this with `example.com`. ✓
   - User can understand which data may be sent to the model → §What leaves the machine enumerates four channels with their defaults and toggles. ✓
   - User can see how to disable Computer-Use completely → §Disabling Computer-Use explains the `enabled: false` path and the lazy-import contract that follows from it. ✓
5. **Cross-check audit** (manual, at PR review):
   - Settings table ↔ `src/config/computerUseSettings.ts:66-86` — every field name, default value, and range matches.
   - Risk-level table ↔ `v3-computer-use-plan.md:225-233` — verbatim.
   - Five non-bypassable safety checks ↔ `v3-computer-use-plan.md:235-247` — every bullet present.
   - Quick-start steps ↔ Phase 6 fixture 1 (`tests/fixtures/computerUse/pages/searchForm.ts`) — same tool sequence (`ComputerStart` → `ComputerNavigate` → `ComputerObserve` → `ComputerStop`).
   - Troubleshooting error strings ↔ `BrowserSessionErrorKind` union (`src/core/computer/types.ts`) — every documented error string is a real `errorKind` value the user can observe.
   - Limitations table ↔ deferred items in v3 plan (Stretch Phase, Profile B/C, etc.) — every limitation is honestly attributed to a documented future-phase or explicit non-goal.
6. **README + CLAUDE.md sanity:**
   - README.md still parses as a single coherent intro paragraph after the one-line addition.
   - CLAUDE.md Computer-Use subsection lists both integration-suite commands.

## Risks and open questions

- **Doc drift over time.** The settings table is the highest-drift surface. Mitigation: the doc cites file paths + line numbers; a `git grep` for `defaultComputerUseSettings` surfaces the table and the module together. A future runtime cross-check (parse the doc table, compare to the module) is conceivable but out of Phase 7 scope.
- **Quick-start example brittleness.** `example.com` is a load-bearing public domain for the walkthrough. If `example.com` changes its HTML structure or starts WAF-checking, the walkthrough will break for users. Mitigation: the walkthrough's assertions are intentionally weak ("you should see something like 'Example Domain' in the observation") and not byte-exact. If `example.com` becomes unreliable, swap in a different stable domain in a follow-up doc PR.
- **Risk-level table verbatim copy is duplication.** A future change to risk levels updates both the v3 plan and the user doc. Cost is small (5 rows); benefit is the user doc standing alone. Accepted.
- **CLAUDE.md grows from 4 lines to a subsection.** The CLAUDE.md style is terse paragraphs; subsections under `## Commands` are unusual. Mitigation: the subsection is small (6–8 lines) and pattern-matches the way `## Architecture` already uses sub-headers. If review pushes back, fall back to a single dense paragraph with the new lines appended.
- **No CHANGELOG / no version bump = no formal release marker.** v3 has no semver tag in `package.json` and no published artifact. Phase 7 documents the *feature*; "release" is implicit (the next `git pull` of `main` carries it). This matches Ultron's single-user local-first posture; no change planned.
- **Acceptance criterion "user can complete a simple browser task" is interpreted as a read-only navigation.** A *write* task (form submission) would require either (a) approval prompts the user reads on stdin, or (b) a relaxed permission rule. Both are documented in §Settings reference and §Security model, but the *quick start* is intentionally read-only to keep the first-run experience friction-free. A user wanting to do more is forwarded to the settings reference.
- **Limitations section may surprise stakeholders.** A reader expecting Computer-Use to "just work" on Cloudflare-protected sites will find Phase 7 docs sober. This is intentional; honest limitations are a release-readiness signal, not a bug. Phase 7 design pre-commits to honest framing.
- **No live-model integration test in Phase 7.** Same as Phase 6 fixture 8 — proving the docs are *correct* against a real model would require live API calls, would be flaky, and would couple docs to a specific model version. Out of scope.
