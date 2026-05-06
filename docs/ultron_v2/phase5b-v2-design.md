# Phase 5b Design: Skill Router + Body Injection + Scoped Tool Allowlist

## Context

v2 §5 promises a **skills primitive** — reusable instruction/capability
bundles invokable by name, on-disk, obeying the same tool permission
rules. **Phase 5a** shipped the substrate in pure subtractable form:
`~/.ultron/skills/<id>/SKILL.md` directories with kebab-case
frontmatter, an atomic store, the 64 KB / 4 MB / 128-skill caps, audit
events for `skill_written` / `skill_deleted`, the `localMemoryGuard`
extended to enforce `0o700` on `skills/`, and a configurable secret
gate on `writeSkill` (`WriteSkillOptions.allowLowConfidenceSecrets`).
None of it changed runtime behaviour. A `Skill` exists on disk and
parses; the model never sees one.

**Phase 5b** is the runtime activation half. When a user runs
`/skill activate review-pr <pr-url>`, the skill's body is injected
into the system prompt as a single `'org'`-bucket part for the
duration of an *activation window* (default one turn, configurable),
the model sees a tool list narrowed to the skill's `allowedTools`
(when set), and the permission cascade gains a deny-equivalent rail
that closes any allow-all bypass for tools outside that list. When
the window closes — turn count exhausted, user runs
`/skill deactivate`, the turn errors, or the body fails the
activation-time secret re-scan — the engine restores the full tool
set and the next turn's system prompt is byte-identical to a session
that never activated a skill. The `'org'`-bucket seam at
`cacheHints.ts:49` already names this phase; the placeholder comment
becomes the actual injection branch. 5b adds two audit events
(`skill_activated`, `skill_deactivated`), one slash command
(`/skill`), one router module, one injection builder, and three
coordinated edits to `QueryEngine`, `permissions.ts`, and
`cacheHints.ts`. Every other surface — provider adapters, MCP, hooks,
memory store/tools/slash, transcript, attachments — is untouched.

The central architectural questions and their answers:

1. **Slash surface — bare-id vs subcommand?**
   **Explicit subcommand.** `/skill activate <id>`,
   `/skill deactivate`, `/skill list`, `/skill show <id>`,
   `/skill help`. Mirrors the convention shared with `/memory`,
   `/mcp`, and `/model`; avoids the ambiguity of a skill named `list`
   or `help` shadowing a subcommand. This is a deliberate departure
   from `v2-ROADMAP.md:421`'s wording (`<id> [args]` activate); the
   roadmap's mechanical implementation gets the convention right.
2. **Where does activation state live?**
   **Private fields on `QueryEngine`** (`_activeSkill`,
   `_remainingTurns`, `_activeCallModel`). Same lifetime as the
   engine, same access pattern as `_memoryBaseDir` /
   `_callModelRebuilt`. A separate `router.ts` module is still
   warranted — but as **stateless helpers** (`scanForActivation`,
   `filterToolDefs`, `makeActiveSkill`, `summarizeMatches`) that the
   engine composes. Keeps the test surface tight without introducing
   a parallel singleton.
3. **Tool allowlist enforcement: send-side, cascade, or both?**
   **Both (defense in depth).** Send-side filtering rebuilds
   `callModel` with intersected tool definitions on activate (and
   on every other rebuild path: `setModel`, `reloadMcp`,
   first-submit MCP bootstrap), so the model emits fewer disallowed
   `tool_use` blocks (token + latency win, cleaner traces). The
   cascade gains a `scopedToolAllowlist` field that adds **one new
   check between cascade-step-1 (explicit deny) and step-2
   (explicit ask)** — explicit user `deny` rules still win, but
   `bypassPermissions` mode cannot override an active skill's
   narrowing. This handles the pathological case of a stale
   `tool_use` for a tool the skill removed crossing a turn boundary,
   plus gives `permission_decision` audit rows a structured deny
   reason (`skillScope`).
4. **Body injection placement.**
   **After the memory block, before volatile.** The skill body is
   invariant across all turns of an activation window; memory
   typically is too within a window. Placing skill *after* memory
   means the second cache breakpoint lands on the last `'org'`
   part — which during an activation is the skill body. The
   placeholder comment at `cacheHints.ts:49-52` already names this
   phase; appending the new branch below the memory block at
   `cacheHints.ts:53-59` matches the seam exactly.
5. **Body wrapper format.**
   Mirror `memoryInjection.ts`'s `<system-reminder>` shape. Header
   frames the model's mode of operation; body is the verbatim
   SKILL.md `content`; `<skill-args>` block when args were passed;
   `<allowed-tools>` block when `allowedTools` was set, with
   explicit "you may only call these tools" sentence; footer closes
   the reminder. Exact template in §Module breakdown.
6. **callModel rebuild strategy.**
   Cache *both* the activation-filtered `_activeCallModel` and the
   regular `this.callModel`. On `submitPrompt` entry, compute
   `turnCallModel = this._activeCallModel ?? this.callModel`. On
   deactivate, drop `_activeCallModel`. The engine's existing
   `setModel` / `rebuildCallModels` machinery remains the canonical
   path — activation just adds a sibling cache. **Three rebuild
   sites must refresh `_activeCallModel`** when a skill is active
   with `allowedTools`: `setModel`, `reloadMcp` (when
   `toolDefinitionsChanged`), and the first-submit MCP bootstrap
   block at `QueryEngine.ts:419-422`.
7. **Args handling.**
   Args concatenated after the id are rendered as
   `<skill-args>...</skill-args>` inside the system-reminder.
   **No synthetic user message.** Args are not what the user "said"
   in the chat stream — they are activation parameters surfaced as
   system-reminder context. Matches Codex/Claude-Code skill
   conventions where `argument-hint` documents what to put after
   the id.
8. **Empty `allowedTools: []` semantics.**
   Distinct from absent. An empty array means the skill is permitted
   zero tools — instruction-only mode. The send-side filter passes
   `[]` to `callModel`, the cascade's `scopedToolAllowlist` is `[]`,
   every tool denies. Tested end-to-end.
9. **Activation-time secret re-scan target.**
   `detectSecrets(serializeSkill(skill))`. Same string the write
   gate scans, so a body that round-trips writeSkill identically
   round-trips the activation scan. Hand-authored SKILL.md bypasses
   5a's write gate, so this is the second checkpoint before bytes
   reach the model.
10. **Refusal-audit shape.**
    `skill_deactivated { reason: 'secret_refused' }` is emitted via
    a private `recordRefusedActivation(id, name)` helper that
    bypasses `deactivateSkill` — there is no active state to clear
    on a refusal. `deactivateSkill`'s parameter type stays narrow
    (`'turns_exhausted' | 'user_deactivated' | 'error'`) so its
    callers can't accidentally emit `'secret_refused'`.

---

## Architecture

```
  src/cli/skillsCommand.ts                 (NEW, ~340 LOC)
    ├─ handleSkillCommand(input, engine, io)
    ├─ subcommands: '', list, show, activate, deactivate, help
    └─ uses: confirmYesNo (low-confidence secret prompt on activate)

  src/skills/router.ts                     (NEW, ~140 LOC)
    ├─ ActiveSkill type
    ├─ scanForActivation(skill) → ActivationScanResult
    ├─ filterToolDefs(toolDefs, allowedTools) → ApiToolDefinition[]
    ├─ makeActiveSkill(skill, args) → ActiveSkill
    └─ summarizeMatches(matches) → string

  src/context/skillInjection.ts            (NEW, ~110 LOC)
    └─ buildSkillInjectionParts(active: ActiveSkill | null)
         → readonly SystemPromptPart[]
       — empty when null; one 'org' part wrapping <system-reminder>
         otherwise

  src/sdk/QueryEngine.ts                   (EDIT, ~120 LOC)
    ├─ _activeSkill, _remainingTurns, _activeCallModel fields
    ├─ activeSkill, isSkillActive getters
    ├─ activateSkill(id, opts, scanHandler?) async method
    ├─ deactivateSkill(reason) sync method
    ├─ recordRefusedActivation(id, name) private helper
    ├─ submitPrompt:
    │   - pass active to buildFullSystemPromptParts
    │   - thread scopedToolAllowlist into permissionOpts for the turn
    │   - use _activeCallModel when active
    │   - epilogue: decrement turns; deactivate on 0 or terminal.error
    ├─ setModel: rebuild _activeCallModel if active w/ allowedTools
    ├─ reloadMcp: rebuild _activeCallModel if active and tools changed
    └─ first-submit MCP bootstrap: rebuild _activeCallModel symmetrically

  src/context/cacheHints.ts                (EDIT, +~10 LOC)
    └─ accepts opts.activeSkill?: ActiveSkill | null
       invokes buildSkillInjectionParts after the memory block

  src/context/queryContext.ts              (EDIT, passthrough opts)
    └─ buildFullSystemPromptParts forwards activeSkill

  src/core/permissions/permissions.ts      (EDIT, +~20 LOC)
    └─ runCascade: new step 1.5 'skill scope' check between
       explicit deny (step 1) and explicit ask (step 2)
       formatDecisionMessage handles 'skillScope' reason

  src/core/permissions/types.ts            (EDIT, +1 field, +1 reason)
    ├─ PermissionOptions.scopedToolAllowlist?: readonly string[]
    └─ PermissionDecisionReason | { type: 'skillScope';
                                    toolName: string;
                                    allowed: readonly string[] }

  src/core/queryEvents.ts                  (EDIT, +2 events)
    ├─ SkillActivatedEvent
    ├─ SkillDeactivatedEvent
    └─ Add to QueryEvent union

  src/core/queryEventFactories.ts          (EDIT, +2 factories)
    ├─ makeSkillActivatedEvent(...)
    └─ makeSkillDeactivatedEvent(...)

  src/audit/auditLog.ts                    (EDIT, +2 SHOULD_AUDIT entries)

  src/cli.ts                               (EDIT)
    ├─ +/skill dispatch block
    ├─ +banner mention
    └─ +event-silencing switch (skill_activated, skill_deactivated)

  src/cli/skillsCommand.test.ts            (NEW)
  src/skills/router.test.ts                (NEW)
  src/context/skillInjection.test.ts       (NEW)
  src/sdk/QueryEngine.test.ts              (EDIT, +activation suite)
  src/core/permissions/permissions.test.ts (EDIT, +scopedToolAllowlist)
  tests/integration/skill-activation.test.ts (NEW)
```

Untouched: provider adapters (the Anthropic two-pass scan continues
to land its second breakpoint on the last `'org'` part, which is the
skill body when active), `query()`, `normalizeMessages`, hooks spine,
MCP layer, default tool registry construction, memory store/tools/
slash, attachments pipeline, transcript persistence. 5b is additive
at the engine seams plus three module additions.

---

## Scope

### In (locked)

1. **`/skill` slash command surface** — explicit subcommands, mirrored
   on `/memory`:
   - `/skill` — print `SKILLS.md` (or `(no skills)` when empty)
   - `/skill list` — table: id / name / hasArgs / allowedToolsCount
   - `/skill show <id>` — `serializeSkill(skill)` byte-for-byte
   - `/skill activate <id> [--turns N] [args...]` — activate with
     optional turn budget (default 1, capped at 100) and freeform args
   - `/skill deactivate` — deactivate active skill, no-op when none
   - `/skill help`
   No `/skill new` / `/skill edit` — explicitly out (users author in
   `$EDITOR` outside Ultron). No bare-id `/skill <id> ...` activation.

2. **Activation state** lives on `QueryEngine` as private fields:
   ```ts
   private _activeSkill: ActiveSkill | null = null
   private _remainingTurns = 0
   private _activeCallModel: CallModelFn | null = null
   ```
   `ActiveSkill` is a frozen snapshot (id, name, body, allowedTools,
   args, activatedAt) captured at activate-time so a `/skill edit`
   between activate and turn N would NOT mutate the active body.

3. **Activation lifecycle** — `activateSkill(id, opts, scanHandler?)`:
   1. Throw if `_running` (mirror `setModel`'s
      `'Cannot ... while a submission is in progress'` error).
   2. Throw if `_activeSkill !== null` — must `/skill deactivate`
      first. No implicit replacement; surprise-avoidance.
   3. Throw if `_memoryBaseDir === null`
      (`disableMemory: true` disables skills too, since they share
      the baseDir).
   4. `readSkill(this._memoryBaseDir, id)` → `null` ⇒ throw a
      user-facing error. **No audit** — missing skill is a user
      error, not a security event.
   5. Run `detectSecrets(serializeSkill(skill))` via
      `scanForActivation`. Hand-authored SKILL.md bypasses 5a's
      write gate; this is the second checkpoint.
      - **High-confidence**: `recordRefusedActivation(id, name)`
        emits `skill_deactivated { reason: 'secret_refused' }`;
        throw a user-facing error. No `_activeSkill` mutation.
      - **Low-confidence**: if no `scanHandler` provided, refuse
        as above. If handler returns `false`, refuse. If handler
        returns `true`, continue.
   6. Set
      `_activeSkill = makeActiveSkill(skill, opts.args ?? '')`,
      `_remainingTurns = opts.turns ?? 1`.
   7. If `skill.allowedTools !== undefined`, build
      `_activeCallModel` from
      `filterToolDefs(getToolDefinitions(toolRegistry), allowedTools)`.
      Otherwise leave `_activeCallModel = null` (turn uses regular
      `this.callModel`).
   8. Audit
      `skill_activated { id, name, turns, hasAllowedTools, hasArgs, timestamp }`.

4. **Deactivation paths** — three reasons reachable while active are
   accepted by `deactivateSkill`; the fourth (`'secret_refused'`) is
   only reachable via `recordRefusedActivation` before any active
   state exists:
   - `_remainingTurns` reaches 0 after a turn → `'turns_exhausted'`.
   - User runs `/skill deactivate` → `'user_deactivated'` (no-op if
     not active; courtesy `(no active skill)` to stdout).
   - `terminal.reason === 'error'` after a turn → `'error'`.
   - Activation refused at step 5 above → `'secret_refused'` via
     `recordRefusedActivation` (no state change, since no state
     was ever set).

5. **`deactivateSkill(reason)`** (sync):
   ```ts
   deactivateSkill(
     reason: 'turns_exhausted' | 'user_deactivated' | 'error',
   ): void
   ```
   - If `_activeSkill === null` and reason is `'user_deactivated'`
     → write `(no active skill)` to stdout, no audit. Otherwise
     no-op.
   - Capture `id`, `name` from `_activeSkill`.
   - Clear `_activeSkill = null`, `_remainingTurns = 0`,
     `_activeCallModel = null`.
   - Emit `skill_deactivated { id, name, reason, timestamp }`.

6. **Per-submission integration** in `submitPrompt`, between the
   existing system-prompt build at line 427 and the deps assembly at
   line 504:
   ```ts
   // System prompt — pass _memoryBaseDir AND _activeSkill so 4d's
   // memory injection AND 5b's skill injection both run when applicable.
   const systemPromptParts = await buildFullSystemPromptParts(this.config.cwd, {
     memoryBaseDir: this._memoryBaseDir,
     activeSkill: this._activeSkill,
   })

   // Skill scope — when active, the cascade narrows the tool set.
   const turnPermissionOpts: PermissionOptions = this._activeSkill?.allowedTools
     ? {
         ...this.permissionOpts,
         scopedToolAllowlist: this._activeSkill.allowedTools,
       }
     : this.permissionOpts

   const turnCallModel = this._activeCallModel ?? this.callModel
   ```
   - `turnPermissionOpts` flows into `createAuthorizeToolUseFn` and
     `createForkSubagent`'s `permissionOpts`.
   - `turnCallModel` flows into `deps.callModel` and
     `createForkSubagent`'s `callModel` parameter.
   - `createForkSubagent`'s `compactCallModel` stays unfiltered —
     compaction emits text only, never `tool_use`.

7. **Per-turn epilogue** in `submitPrompt`'s `try` block, after
   `this._messages = [...terminal.messages]`:
   ```ts
   if (this._activeSkill !== null) {
     if (terminal.reason === 'error') {
       this.deactivateSkill('error')
     } else {
       this._remainingTurns--
       if (this._remainingTurns <= 0) {
         this.deactivateSkill('turns_exhausted')
       }
     }
   }
   ```
   `aborted` and `max_turns` terminals do NOT auto-deactivate — the
   user might want to retry within the same window. `error` does
   deactivate per the roadmap. Successful turn decrements; reaching
   0 deactivates.

8. **System-prompt injection** at the seam —
   `buildSystemPromptParts` accepts
   `opts.activeSkill?: ActiveSkill | null`. When set,
   `buildSkillInjectionParts(active)` is invoked AFTER the memory
   block. Returns 0 or 1 `'org'` parts; one part wraps a
   `<system-reminder>` block. Placement-after-memory is intentional
   (see arch question 4): the Anthropic adapter's two-pass logic
   sets the second breakpoint on the LAST `'org'` part, which during
   activation is the skill body. Memory entries are upstream of the
   breakpoint, so memory edits between turns invalidate downstream;
   skill activation/deactivation toggles the breakpoint location
   cleanly.

9. **Anthropic two-breakpoint interaction.** The adapter's Pass 2
   (last `'org'` part) lands on:
   - Memory part when no skill is active and memory is populated.
   - Skill part when skill is active, regardless of memory.
   - Nothing when both are empty (Pass 1 still fires on last
     `'global'`).
   No adapter change needed; 5b is invisible to the adapter. Two
   consecutive turns in the same activation window present
   byte-identical skill bytes → cache hit on the org segment between
   turns. Verified by integration smoke.

10. **Send-side tool filtering** — `_activeCallModel` is built once
    at activate time:
    ```ts
    const fullDefs = getToolDefinitions(this.toolRegistry)
    const filtered = filterToolDefs(fullDefs, skill.allowedTools!)
    this._activeCallModel = this.resolveCallModel(this._model, filtered)
    ```
    `filterToolDefs(defs, allowed)` is a pure helper in `router.ts`:
    ```ts
    export function filterToolDefs(
      defs: readonly ApiToolDefinition[],
      allowedTools: readonly string[],
    ): ApiToolDefinition[] {
      const allow = new Set(allowedTools)
      return defs.filter((d) => allow.has(d.name))
    }
    ```
    Empty `allowedTools` → empty filtered list → `callModel`
    constructed with `tools: []` → model genuinely cannot emit any
    `tool_use` block. Cascade is still defense-in-depth (the model
    could still try, e.g., a stale plan; the cascade catches it).

11. **Three `_activeCallModel` rebuild sites** when a skill is
    active with `allowedTools`:
    - **`setModel(newModel)`** at `QueryEngine.ts:343` — the
      activation may span a model swap.
    - **`reloadMcp` when `toolDefinitionsChanged`** at line 629 —
      MCP tools may be added/removed mid-window.
    - **First-submit MCP bootstrap** at line 419-422 — if a skill
      is activated BEFORE the first `submitPrompt`, the MCP
      bootstrap's `rebuildCallModels()` would leave
      `_activeCallModel` stale (built against pre-MCP defs).
      Rebuild symmetrically inside the same
      `if (!this._callModelRebuilt && this.hasMcpTools())` block.
    All three sites use the same shape:
    ```ts
    if (this._activeSkill?.allowedTools !== undefined) {
      const fullDefs = getToolDefinitions(this.toolRegistry)
      const filtered = filterToolDefs(fullDefs, this._activeSkill.allowedTools)
      this._activeCallModel = this.resolveCallModel(this._model, filtered)
    }
    ```

12. **Cascade-side enforcement** — `permissions.ts` gains step 1.5
    between explicit-deny (step 1) and explicit-ask (step 2):
    ```ts
    // 1. Explicit deny rules — user explicit deny ALWAYS wins.
    const denyRule = matching.find((r) => r.behavior === 'deny')
    if (denyRule) {
      return { behavior: 'deny', reason: { type: 'rule', rule: denyRule } }
    }

    // 1.5. Skill scope (Phase 5b). When an activation is in flight
    //      with a narrowed tool list, any tool outside the list
    //      denies here. AFTER explicit deny (user always wins),
    //      BEFORE mode bypass (skill scope wins over bypassPermissions).
    if (opts.scopedToolAllowlist !== undefined
        && !opts.scopedToolAllowlist.includes(toolUse.name)) {
      return {
        behavior: 'deny',
        reason: { type: 'skillScope',
                  toolName: toolUse.name,
                  allowed: opts.scopedToolAllowlist },
      }
    }

    // 2. Explicit ask rules
    // ... rest of cascade unchanged
    ```
    `formatDecisionMessage` switch gains:
    ```ts
    case 'skillScope':
      return `tool not in active skill's allowed-tools (allowed: ${reason.allowed.join(', ')})`
    ```
    `PermissionOptions` field gain:
    ```ts
    export type PermissionOptions = {
      headless: boolean
      safetyChecks: SafetyCheck[]
      askUser?: AskUserFn
      /** Phase 5b: when present, the cascade denies any tool not
       *  in the list before the mode-bypass step. Skill activation
       *  populates this. */
      scopedToolAllowlist?: readonly string[]
    }
    ```

13. **Audit events** — metadata-only:
    ```ts
    type SkillActivatedEvent = {
      readonly type: 'skill_activated'
      readonly id: string
      readonly name: string
      readonly turns: number
      readonly hasAllowedTools: boolean
      readonly hasArgs: boolean
      readonly timestamp: number
    }
    type SkillDeactivatedEvent = {
      readonly type: 'skill_deactivated'
      readonly id: string
      readonly name: string
      readonly reason:
        | 'turns_exhausted'
        | 'user_deactivated'
        | 'error'
        | 'secret_refused'
      readonly timestamp: number
    }
    ```
    Boolean flags rather than the strings/lists/args themselves.
    `redactSecrets` runs at the audit boundary as defense-in-depth.

14. **`writeSkill` semantics unchanged from 5a.** 5a already exposes
    `WriteSkillOptions.allowLowConfidenceSecrets`
    (`src/skills/store.ts:347`); a passing test asserts the
    low-confidence path
    (`src/skills/store.test.ts:327`). 5b doesn't touch the store
    gate. The "5b loosens" note in 5a docs refers to the
    **activation-time** scan, which always re-runs and routes
    low-confidence through the activation confirmation path.

15. **CLI banner** updated to mention `/skill`. Event-silencing
    block in `cli.ts:278-294` adds `'skill_activated'` and
    `'skill_deactivated'` cases (already silent in the same group as
    `skill_written` / `skill_deleted`).

### Out (deferred / not planned)

- `/skill new`, `/skill edit` — users author in `$EDITOR` outside
  Ultron. The 5a substrate's `writeSkill` exists for tests and
  future tooling.
- Project-local `.ultron/skills/` discovery, multi-root merge.
- Bare-id activation (`/skill review-pr <args>`) — explicitly
  rejected (see arch question 1).
- Skill composition (one skill activating another).
- Remote skill fetch / URL imports / Claude-Code skill-directory
  bulk import.
- Skills-as-code (executable JS modules).
- `--purge-dir` flag on delete (5a's `deleteSkill` already
  preserves siblings; full-tree removal is a future affordance).
- Multi-skill activation (two skills active simultaneously). Single-
  slot activation only in 5b.
- Activation transcript persistence (the activation isn't a
  `Message`; it's session metadata. Future phase if "where am I"
  recovery needs it).
- Resuming sessions with an active skill. 5b activations are
  session-runtime only; resume restores `_activeSkill = null`.
- A model-facing `SkillInvoke` tool. Skills are user-driven
  activation; the model never activates one.

---

## Data flow

### Activate path (happy)

1. User: `/skill activate review-pr --turns 3 https://github.com/foo/bar/pull/1`.
2. `cli.ts` matches `/skill ` prefix, closes readline, dispatches
   to `handleSkillCommand`.
3. `handleSkillCommand` parses subcommand `activate`, args
   `['--turns', '3', 'https://github.com/foo/bar/pull/1']`. Extracts
   `turns=3`, leaves args string `'https://github.com/foo/bar/pull/1'`.
4. `engine.activateSkill('review-pr', { turns: 3, args: '<url>' }, confirmYesNo)`.
5. Engine: `_running` check passes; `_activeSkill === null` check
   passes; `_memoryBaseDir !== null` check passes.
6. `readSkill(baseDir, 'review-pr')` returns `Skill`.
7. `scanForActivation(skill)`: serialize → `detectSecrets`. No
   matches → `{ ok: true }`.
8. `_activeSkill = makeActiveSkill(skill, args)`;
   `_remainingTurns = 3`.
9. `skill.allowedTools = ['FileRead', 'Grep', 'Glob']` is set →
   `_activeCallModel = resolveCallModel(_model, filterToolDefs(fullDefs, allowedTools))`.
10. Audit: `skill_activated { id, name, turns: 3, hasAllowedTools: true, hasArgs: true }`.
11. CLI prints `skill "review-pr" activated for 3 turn(s)`.

### Activate path (low-confidence secret)

7'. `scanForActivation(skill)` returns
    `{ ok: false, kind: 'low', matches }`.
7''. `confirmYesNo('Skill body matches credential-like patterns: <types>. Activate anyway?', { defaultNo: true })`.
7'''. User chooses No → `recordRefusedActivation(id, name)` emits
      `skill_deactivated { reason: 'secret_refused' }`; engine throws.
      No `_activeSkill` mutation since none was set yet.

### Activate path (high-confidence secret)

7'. `scanForActivation(skill)` returns
    `{ ok: false, kind: 'high', matches }`. No prompt; immediate
    refusal.
7''. `recordRefusedActivation(id, name)`; engine throws. CLI prints
     `[skill] activation refused: high-confidence credentials in body`.

### Submission with active skill

1. User: any prompt. `submitPrompt` enters.
2. `_running = true`; AbortController created.
3. Resume / hooks / MCP lazy bootstrap (unchanged) — but the MCP
   bootstrap's `if (!this._callModelRebuilt && this.hasMcpTools())`
   block now ALSO rebuilds `_activeCallModel` if `_activeSkill?.allowedTools` is set.
4. **System-prompt build:**
   ```ts
   const parts = await buildFullSystemPromptParts(this.config.cwd, {
     memoryBaseDir: this._memoryBaseDir,
     activeSkill: this._activeSkill,
   })
   ```
   `buildSystemPromptParts` runs:
   - Push `'global'` parts from preamble.
   - If memoryBaseDir set: push memory injection part(s) with
     `'org'` hint.
   - **NEW:** if `opts.activeSkill` set: push
     `buildSkillInjectionParts(active)` (one `'org'` part).
   - Push date + envInfo with `'volatile'` hint.
5. **Permission opts for the turn:**
   ```ts
   const turnPermissionOpts: PermissionOptions = this._activeSkill?.allowedTools
     ? { ...this.permissionOpts, scopedToolAllowlist: this._activeSkill.allowedTools }
     : this.permissionOpts
   ```
   Threaded through `createAuthorizeToolUseFn(toolUseContext, turnPermissionOpts)`
   and `createForkSubagent({ ..., permissionOpts: turnPermissionOpts })`.
6. **callModel for the turn:**
   `const turnCallModel = this._activeCallModel ?? this.callModel`.
   Threaded into `deps.callModel` and
   `createForkSubagent({ ..., callModel: turnCallModel })`.
   `compactCallModel` stays unfiltered.
7. Query loop runs as today. Anthropic adapter sees the new `'org'`
   skill part as the last in its array (after memory, before
   volatile date/env), lands its second breakpoint there.
8. Tool calls flow through the cascade. If the model emits a
   `tool_use` for a tool not in `allowedTools`:
   - Send-side filter already excluded it from the model's view,
     but if a stale plan or `tool_use_start` SSE event references
     it → cascade step 1.5 denies with
     `{ type: 'skillScope', toolName, allowed }`. Synthetic
     `tool_result` carries `permission_denied` with reason
     `"tool not in active skill's allowed-tools (allowed: FileRead, Grep, Glob)"`.
9. Generator drains; `terminal: Terminal` returned.
10. **Epilogue:**
    ```ts
    if (this._activeSkill !== null) {
      if (terminal.reason === 'error') {
        this.deactivateSkill('error')
      } else {
        this._remainingTurns--
        if (this._remainingTurns <= 0) {
          this.deactivateSkill('turns_exhausted')
        }
      }
    }
    ```
11. `_running = false` in finally block.

### Deactivate path (user)

1. User: `/skill deactivate`.
2. `engine.deactivateSkill('user_deactivated')`.
3. If `_activeSkill === null` → CLI prints `(no active skill)`.
4. Else: capture name+id, clear fields, emit
   `skill_deactivated { id, name, reason: 'user_deactivated' }`.
5. Next `submitPrompt` builds a system prompt without the skill
   block; `turnCallModel = this.callModel`.

### Cascade-deny on out-of-scope tool

1. Model emits `tool_use` for `Bash` while skill scope
   `['FileRead', 'Grep', 'Glob']` is active.
2. `authorizeToolUse` resolves the tool, validates input, calls
   `hasPermissionsToUseTool`.
3. Cascade step 1 (explicit deny) — pass.
4. Cascade step 1.5 (skill scope) — `'Bash'` not in
   `['FileRead', 'Grep', 'Glob']` →
   `{ behavior: 'deny', reason: { type: 'skillScope', toolName: 'Bash', allowed: [...] } }`.
5. `formatDecisionMessage` renders:
   `"tool not in active skill's allowed-tools (allowed: FileRead, Grep, Glob)"`.
6. Synthetic `tool_result` (`permission_denied`) returned to the
   model.
7. `permission_decision` event flows to audit with the structured
   reason.

---

## Module breakdown

### `src/skills/router.ts` (new, ~140 LOC)

```ts
/**
 * Skill activation router — stateless helpers used by QueryEngine.
 *
 * No singleton, no module-level state. The engine owns activation
 * state (_activeSkill, _remainingTurns, _activeCallModel); this module
 * provides pure functions for the activation-time secret re-scan,
 * tool-def filtering, and the active-skill snapshot type.
 */

import type { Skill } from './skill.js'
import type { ApiToolDefinition } from '../core/tools/registry.js'
import { detectSecrets, type SecretMatch } from '../memory/secretScanner.js'
import { serializeSkill } from './skill.js'

export type ActiveSkill = {
  readonly id: string
  readonly name: string
  readonly body: string                       // skill.content snapshot
  readonly allowedTools?: readonly string[]   // captured snapshot
  readonly args: string                       // '' when none
  readonly activatedAt: number
}

export type ActivationScanResult =
  | { ok: true }
  | { ok: false; kind: 'high' | 'low'; matches: readonly SecretMatch[] }

/**
 * Re-scan a skill's serialized form for secrets at activation time.
 * Hand-authored SKILL.md bypasses 5a's writeSkill gate; this is the
 * second checkpoint before bytes reach the model. High-confidence →
 * refuse outright; low-confidence → caller askUser then refuse-or-proceed.
 *
 * Scan target is `serializeSkill(skill)` — same string the write gate
 * scans, so a body that round-trips writeSkill identically round-trips
 * the activation scan.
 */
export function scanForActivation(skill: Skill): ActivationScanResult {
  const matches = detectSecrets(serializeSkill(skill))
  if (matches.length === 0) return { ok: true }
  const highs = matches.filter((m) => m.confidence === 'high')
  if (highs.length > 0) return { ok: false, kind: 'high', matches: highs }
  return { ok: false, kind: 'low', matches }
}

export function summarizeMatches(matches: readonly SecretMatch[]): string {
  return [...new Set(matches.map((m) => m.type))].join(', ')
}

/**
 * Filter a list of API tool definitions to those named in `allowedTools`.
 * Order of returned defs matches the original order (deterministic for
 * caching). Empty allowed → empty result (instruction-only skill).
 */
export function filterToolDefs(
  defs: readonly ApiToolDefinition[],
  allowedTools: readonly string[],
): ApiToolDefinition[] {
  const allow = new Set(allowedTools)
  return defs.filter((d) => allow.has(d.name))
}

/**
 * Build an ActiveSkill snapshot from a parsed Skill plus activation
 * params. The body and allowedTools are captured here so a later
 * `/skill edit` (or any disk mutation) cannot mutate an in-flight
 * activation.
 */
export function makeActiveSkill(
  skill: Skill,
  args: string,
): ActiveSkill {
  return {
    id: skill.id,
    name: skill.name,
    body: skill.content,
    ...(skill.allowedTools !== undefined && { allowedTools: skill.allowedTools }),
    args,
    activatedAt: Date.now(),
  }
}
```

### `src/context/skillInjection.ts` (new, ~110 LOC)

```ts
/**
 * Skill body injection into the system prompt (Phase 5b).
 *
 * Reads from the engine's _activeSkill snapshot and produces a single
 * `'org'`-bucket SystemPromptPart wrapping a <system-reminder>.
 * Inserted AFTER the memory block by cacheHints.ts, so the Anthropic
 * adapter's Pass 2 (last `'org'` part) lands on the skill body during
 * an activation window — stable bytes within the window mean a cache
 * hit on the org segment for subsequent turns.
 *
 * Pure module — no I/O, no globals. Test surface is the wrapper
 * template exactness and the args/allowedTools branch matrix.
 */

import type { SystemPromptPart } from './systemPromptParts.js'
import type { ActiveSkill } from '../skills/router.js'

const HEADER_OPEN = '<system-reminder>'
const HEADER_LINE_1 =
  'A user-authored skill is active for this turn. The instructions below'
const HEADER_LINE_2 =
  'override your default response style for the duration; treat them as'
const HEADER_LINE_3 =
  'authoritative within their scope.'

const FOOTER = '</system-reminder>'

export function buildSkillInjectionParts(
  active: ActiveSkill | null,
): readonly SystemPromptPart[] {
  if (active === null) return []
  return [{ content: renderActiveSkill(active), cacheHint: 'org' }]
}

function renderActiveSkill(active: ActiveSkill): string {
  const lines: string[] = [
    HEADER_OPEN,
    HEADER_LINE_1,
    HEADER_LINE_2,
    HEADER_LINE_3,
    '',
    `Active skill: ${active.name} (id: ${active.id})`,
    '',
    '## Instructions',
    '',
    active.body.trimEnd(),
    '',
  ]

  if (active.args.length > 0) {
    lines.push(
      '## Activation arguments',
      '',
      '<skill-args>',
      active.args,
      '</skill-args>',
      '',
    )
  }

  if (active.allowedTools !== undefined) {
    lines.push('## Tool scope', '')
    if (active.allowedTools.length === 0) {
      lines.push(
        'This skill is instruction-only. You may not invoke any tools',
        'while this skill is active.',
        '',
      )
    } else {
      lines.push(
        'You may only call the following tools while this skill is active:',
        '',
        '<allowed-tools>',
        ...active.allowedTools.map((t) => `- ${t}`),
        '</allowed-tools>',
        '',
        'Calls to any other tool will be denied at the permission boundary.',
        '',
      )
    }
  }

  lines.push(FOOTER)
  return lines.join('\n')
}
```

**Wrapper template (final form, all branches):**

```
<system-reminder>
A user-authored skill is active for this turn. The instructions below
override your default response style for the duration; treat them as
authoritative within their scope.

Active skill: <skill.name> (id: <skill.id>)

## Instructions

<verbatim skill.content, with trailing newline trimmed>

## Activation arguments       ← only when args.length > 0

<skill-args>
<args>
</skill-args>

## Tool scope                 ← only when allowedTools !== undefined

You may only call the following tools while this skill is active:

<allowed-tools>
- FileRead
- Grep
- Glob
</allowed-tools>

Calls to any other tool will be denied at the permission boundary.

</system-reminder>
```

When `allowedTools` is `[]`, the "## Tool scope" body becomes:
```
## Tool scope

This skill is instruction-only. You may not invoke any tools
while this skill is active.
```

### `src/cli/skillsCommand.ts` (new, ~340 LOC)

Mirrors `memoryCommand.ts`'s shape: `SkillEngine` structural type,
`SkillCommandIo` test seam, `handleSkillCommand` entrypoint with
switch dispatch, helpers for each subcommand, `mapStoreError` for
typed-error → user-message mapping.

```ts
export type SkillEngine = {
  readonly memoryBaseDir: string | null   // skills/ sibling to memory/
  readonly auditWriter: AuditWriter
  readonly activeSkill: ActiveSkill | null
  readonly isSkillActive: boolean
  activateSkill(
    id: string,
    opts: ActivateSkillOpts,
    scanHandler?: SkillScanHandler,
  ): Promise<void>
  deactivateSkill(reason: 'user_deactivated'): void
}

export type ActivateSkillOpts = {
  readonly turns?: number   // default 1
  readonly args?: string    // default ''
}

export type SkillScanHandler =
  (matches: readonly SecretMatch[]) => Promise<boolean>

export type SkillCommandIo = {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly confirmYesNo?: typeof defaultConfirmYesNo
}

export async function handleSkillCommand(
  input: string,
  engine: SkillEngine,
  io: SkillCommandIo,
): Promise<void> {
  const baseDir = engine.memoryBaseDir
  if (baseDir === null) {
    io.stdout.write('[skill] disabled in this engine (memory off)\n')
    return
  }

  const trimmed = input.trim()
  const rest = trimmed === '/skill' ? '' : trimmed.slice('/skill '.length)
  const tokens = rest.trim().length === 0 ? [] : rest.trim().split(/\s+/)
  const subcommand = tokens[0] ?? ''
  const args = tokens.slice(1)

  // switch (subcommand) { '': showIndex, 'list', 'show', 'activate',
  //                       'deactivate', 'help', default: writeHelp }
}

async function activateCmd(ctx, engine, args): Promise<void> {
  const id = args[0]
  if (!id || !validateId(id)) { /* error message */ return }

  // Parse --turns N before scanning args.
  let turns = 1
  let argTokens = args.slice(1)
  if (argTokens[0] === '--turns') {
    const n = Number(argTokens[1])
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      ctx.stderr.write('[skill] --turns must be an integer 1..100\n')
      return
    }
    turns = n
    argTokens = argTokens.slice(2)
  }
  const skillArgs = argTokens.join(' ')

  const scanHandler: SkillScanHandler = async (matches) => {
    return ctx.confirmYesNo(
      `Skill body matches credential-like patterns: ${summarizeMatches(matches)}. Activate anyway?`,
      { defaultNo: true },
    )
  }

  try {
    await engine.activateSkill(id, { turns, args: skillArgs }, scanHandler)
    ctx.stdout.write(`skill "${id}" activated for ${turns} turn(s)\n`)
  } catch (err) {
    ctx.stderr.write(`[skill] ${mapActivateError(err)}\n`)
  }
}
```

### `src/sdk/QueryEngine.ts` (edit, ~120 LOC across multiple sites)

**New private fields** (after `_callModelRebuilt`, line ~166):

```ts
private _activeSkill: ActiveSkill | null = null
private _remainingTurns = 0
private _activeCallModel: CallModelFn | null = null
```

**New public getters** (after `auditWriter` getter, ~line 281):

```ts
/** The currently-active skill snapshot, or null. */
get activeSkill(): ActiveSkill | null {
  return this._activeSkill
}

/** Convenience: true when an activation window is open. */
get isSkillActive(): boolean {
  return this._activeSkill !== null
}
```

**New methods** (after `setModel` / `rebuildCallModels`, ~line 365):

```ts
/**
 * Activate a skill for `opts.turns` (default 1) turns. Reads the
 * skill from disk, runs the activation-time secret re-scan, and
 * (if allowedTools is set) builds a filtered `_activeCallModel`.
 * Throws if a submission is in progress, if a skill is already
 * active, or if the skill is missing.
 */
async activateSkill(
  id: string,
  opts: ActivateSkillOpts = {},
  scanHandler?: SkillScanHandler,
): Promise<void> {
  if (this._running) {
    throw new Error('Cannot activate skill while a submission is in progress')
  }
  if (this._activeSkill !== null) {
    throw new Error(
      `Skill "${this._activeSkill.id}" is already active; deactivate first`,
    )
  }
  if (this._memoryBaseDir === null) {
    throw new Error('Skills are disabled (disableMemory: true)')
  }

  const skill = await readSkill(this._memoryBaseDir, id)
  if (skill === null) {
    throw new Error(`Skill "${id}" not found`)
  }

  const scan = scanForActivation(skill)
  if (!scan.ok) {
    if (scan.kind === 'high') {
      this.recordRefusedActivation(skill.id, skill.name)
      throw new Error(
        `activation refused: high-confidence credentials in body (${summarizeMatches(scan.matches)})`,
      )
    }
    // low-confidence
    if (!scanHandler) {
      this.recordRefusedActivation(skill.id, skill.name)
      throw new Error(
        `activation refused: credential-like patterns in body (${summarizeMatches(scan.matches)})`,
      )
    }
    const proceed = await scanHandler(scan.matches)
    if (!proceed) {
      this.recordRefusedActivation(skill.id, skill.name)
      throw new Error('activation refused by user')
    }
  }

  const args = opts.args ?? ''
  const turns = opts.turns ?? 1
  if (!Number.isInteger(turns) || turns < 1) {
    throw new Error('turns must be a positive integer')
  }

  const active = makeActiveSkill(skill, args)
  this._activeSkill = active
  this._remainingTurns = turns

  if (active.allowedTools !== undefined) {
    const fullDefs = getToolDefinitions(this.toolRegistry)
    const filtered = filterToolDefs(fullDefs, active.allowedTools)
    this._activeCallModel = this.resolveCallModel(this._model, filtered)
  } else {
    this._activeCallModel = null
  }

  this._auditWriter.write(
    makeSkillActivatedEvent({
      id: active.id,
      name: active.name,
      turns,
      hasAllowedTools: active.allowedTools !== undefined,
      hasArgs: args.length > 0,
    }),
  )
}

/**
 * Deactivate the active skill. Idempotent for `'user_deactivated'`.
 *
 * The 'secret_refused' reason is NOT accepted here — it's reserved
 * for the pre-activation refusal path and is emitted by
 * `recordRefusedActivation` instead, which never touches active state.
 */
deactivateSkill(
  reason: 'turns_exhausted' | 'user_deactivated' | 'error',
): void {
  if (this._activeSkill === null) return
  const { id, name } = this._activeSkill
  this._activeSkill = null
  this._remainingTurns = 0
  this._activeCallModel = null
  this._auditWriter.write(
    makeSkillDeactivatedEvent({ id, name, reason }),
  )
}

/**
 * Emit a `skill_deactivated { reason: 'secret_refused' }` event
 * without flipping any active state. Used during activation refusals
 * (high-confidence detection or user-declined low-confidence) where
 * no active state was ever set.
 */
private recordRefusedActivation(id: string, name: string): void {
  this._auditWriter.write(
    makeSkillDeactivatedEvent({ id, name, reason: 'secret_refused' }),
  )
}
```

**Modified `submitPrompt`** — three localized changes:

```ts
// (1) System prompt build — extend opts:
const systemPromptParts = await buildFullSystemPromptParts(this.config.cwd, {
  memoryBaseDir: this._memoryBaseDir,
  activeSkill: this._activeSkill,
})

// (2) Per-turn permission opts:
const turnPermissionOpts: PermissionOptions = this._activeSkill?.allowedTools
  ? { ...this.permissionOpts, scopedToolAllowlist: this._activeSkill.allowedTools }
  : this.permissionOpts

// (3) Per-turn callModel:
const turnCallModel = this._activeCallModel ?? this.callModel

// ... use turnCallModel and turnPermissionOpts in the sites where
// this.callModel and this.permissionOpts are referenced today
// (deps.callModel; createForkSubagent's callModel + permissionOpts;
// createAuthorizeToolUseFn's permissionOpts).
// compactCallModel STAYS unfiltered (compaction emits text only).
```

**Modified `submitPrompt` epilogue** — after
`this._messages = [...terminal.messages]`:

```ts
if (this._activeSkill !== null) {
  if (terminal.reason === 'error') {
    this.deactivateSkill('error')
  } else {
    this._remainingTurns--
    if (this._remainingTurns <= 0) {
      this.deactivateSkill('turns_exhausted')
    }
  }
}
```

**Modified MCP first-bootstrap rebuild** at line 419-422:

```ts
if (!this._callModelRebuilt && this.hasMcpTools()) {
  this.rebuildCallModels()
  // 5b: if a skill was activated before first submit, the just-rebuilt
  //     this.callModel obsoletes the pre-MCP _activeCallModel. Refresh
  //     symmetrically.
  if (this._activeSkill?.allowedTools !== undefined) {
    const fullDefs = getToolDefinitions(this.toolRegistry)
    const filtered = filterToolDefs(fullDefs, this._activeSkill.allowedTools)
    this._activeCallModel = this.resolveCallModel(this._model, filtered)
  }
  this._callModelRebuilt = true
}
```

**Modified `setModel`** at line 343:

```ts
setModel(model: string): void {
  // ... existing _running guard, identity short-circuit, callModel
  //     rebuild (unchanged) ...
  this._model = model
  // 5b: keep _activeCallModel coherent with the new model.
  if (this._activeSkill?.allowedTools !== undefined) {
    const fullDefs = getToolDefinitions(this.toolRegistry)
    const filtered = filterToolDefs(fullDefs, this._activeSkill.allowedTools)
    this._activeCallModel = this.resolveCallModel(model, filtered)
  }
}
```

**Modified `reloadMcp`** at line 629:

```ts
if (result.toolDefinitionsChanged) {
  this.rebuildCallModels()
  // 5b: same refresh as above.
  if (this._activeSkill?.allowedTools !== undefined) {
    const fullDefs = getToolDefinitions(this.toolRegistry)
    const filtered = filterToolDefs(fullDefs, this._activeSkill.allowedTools)
    this._activeCallModel = this.resolveCallModel(this._model, filtered)
  }
  this._callModelRebuilt = this.hasMcpTools()
}
```

### `src/context/cacheHints.ts` (edit)

```ts
export type BuildSystemPromptPartsOpts = {
  readonly memoryBaseDir?: string | null
  readonly activeSkill?: ActiveSkill | null   // ← Phase 5b
}

export async function buildSystemPromptParts(
  cwd: string,
  opts: BuildSystemPromptPartsOpts = {},
): Promise<SystemPromptPart[]> {
  // ... preamble pushes 'global' parts (unchanged)

  // Memory injection (4d)
  if (opts.memoryBaseDir) {
    const memParts = await buildMemoryInjectionParts(
      opts.memoryBaseDir,
      MEMORY_INJECTION_TOKEN_BUDGET,
    )
    parts.push(...memParts)
  }

  // Skill injection (5b) — placed AFTER memory so the Anthropic
  // adapter's second cache breakpoint (last 'org' part) lands on the
  // skill body during an activation window. Stable bytes within the
  // window → cache hit.
  if (opts.activeSkill) {
    parts.push(...buildSkillInjectionParts(opts.activeSkill))
  }

  // Volatile tail
  parts.push({ content: currentDate, cacheHint: 'volatile' })
  parts.push({ content: systemCtx.envInfo, cacheHint: 'volatile' })

  return parts
}
```

The seam comment at lines 49-52 updates from
"Phase 5b will add skills using the same bucket" to
"Skills injection (5b) — last `'org'` part during an activation
window. The two-pass Anthropic adapter pins its second breakpoint
here when active, otherwise on the memory part."

### `src/context/queryContext.ts` (edit)

`buildFullSystemPromptParts(cwd, opts)` already takes opts and
forwards to `buildSystemPromptParts`. The opts type widens by one
field; the forwarder is unchanged otherwise.

### `src/core/permissions/permissions.ts` (edit, ~20 LOC)

See §Scope item 12 above for the full diff.

Cascade order pseudocode in concrete language:

```
0. abort guard      (unchanged)
1. explicit deny    (unchanged — wins over everything)
1.5. skill scope    (NEW — denies if tool not in allowlist)
2. explicit ask     (unchanged)
3. tool.checkPermissions (unchanged)
4. safetyChecks     (unchanged)
5. mode bypass      (unchanged — but cannot fire because step 1.5
                     already denied non-allowlisted tools)
6. explicit allow   (unchanged)
7. fallback ask     (unchanged)
```

### `src/core/permissions/types.ts` (edit)

```ts
export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'safetyCheck'; message: string }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'toolCheck'; message: string }
  | { type: 'toolCheck' }
  | { type: 'headlessEscalation'; original: PermissionDecisionReason }
  | { type: 'skillScope'; toolName: string; allowed: readonly string[] }   // NEW
  | { type: 'fallback' }

export type PermissionOptions = {
  headless: boolean
  safetyChecks: SafetyCheck[]
  askUser?: AskUserFn
  /** Phase 5b — skill activation narrows the tool set. */
  scopedToolAllowlist?: readonly string[]
}
```

### `src/core/queryEvents.ts` (edit, +~30 LOC)

After `SkillDeletedEvent` (5a's block):

```ts
// Skill activation events (Phase 5b). Metadata-only — body, args,
// and the allowed-tools list are never on the event.

export type SkillActivatedEvent = {
  readonly type: 'skill_activated'
  readonly id: string
  readonly name: string
  readonly turns: number
  readonly hasAllowedTools: boolean
  readonly hasArgs: boolean
  readonly timestamp: number
}

export type SkillDeactivatedEvent = {
  readonly type: 'skill_deactivated'
  readonly id: string
  readonly name: string
  readonly reason:
    | 'turns_exhausted'
    | 'user_deactivated'
    | 'error'
    | 'secret_refused'
  readonly timestamp: number
}
```

Add both to the `QueryEvent` union.

### `src/core/queryEventFactories.ts` (edit, +2 factories)

```ts
export function makeSkillActivatedEvent(args: {
  id: string
  name: string
  turns: number
  hasAllowedTools: boolean
  hasArgs: boolean
}): SkillActivatedEvent {
  return { type: 'skill_activated', ...args, timestamp: Date.now() }
}

export function makeSkillDeactivatedEvent(args: {
  id: string
  name: string
  reason: 'turns_exhausted' | 'user_deactivated' | 'error' | 'secret_refused'
}): SkillDeactivatedEvent {
  return { type: 'skill_deactivated', ...args, timestamp: Date.now() }
}
```

### `src/audit/auditLog.ts` (edit, +2 lines)

Append `'skill_activated'` and `'skill_deactivated'` to
`SHOULD_AUDIT`.

### `src/cli.ts` (edit)

- Import `handleSkillCommand`.
- Add the dispatch after the `/memory` block at line 225-242:
  ```ts
  if (trimmed === '/skill' || trimmed.startsWith('/skill ')) {
    rl.close()
    try {
      await handleSkillCommand(trimmed, engine, {
        stdout: process.stdout,
        stderr: process.stderr,
      })
    } catch (err) {
      process.stderr.write(`\n\x1b[31m[skill: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\n`)
    } finally {
      rl = createInterface({ input: process.stdin, output: process.stdout })
    }
    prompt()
    return
  }
  ```
- Banner update: append `, /skill` to the help line at line 329.
- **Event-silence block at line 278-294 — bundled with the
  `QueryEvent` union expansion in step 2** to keep typecheck green.
  Adds `case 'skill_activated':` and `case 'skill_deactivated':` to
  the silent-handling group.

---

## Critical invariants

1. **Substrate-only stays subtractable.** All 5a tests run unchanged:
   removing `_activeSkill`, `activateSkill`, `deactivateSkill`, the
   `/skill` dispatch, and the new injection branch must leave 5a
   functional. Verified by running `npx vitest run src/skills/
   tests/integration/skill-store.test.ts` against a 5b'd tree.
2. **No bare-id activation.** `/skill review-pr` produces "unknown
   subcommand 'review-pr'", not an activation. `/skill help`
   clarifies.
3. **Single activation slot.** `_activeSkill` is null OR a single
   snapshot. `activateSkill` while active throws. No implicit
   replace.
4. **`_running` guard on activate AND deactivate.** Mirrors
   `setModel`; activations cannot interleave with submissions.
5. **Activation snapshot immutability.** `ActiveSkill` is `readonly`.
   A `/skill edit` (future) writing to disk does NOT affect an
   in-flight activation; the next activation reads fresh state.
6. **Cascade-side scope wins over `bypassPermissions`.** Step 1.5
   placement is load-bearing. Tested explicitly.
7. **Cascade-side scope LOSES to explicit user `deny` rules.** Step
   1 still runs first. Tested explicitly.
8. **Send-side filter and cascade-side filter agree.** When
   `allowedTools = ['FileRead']`, the model's tool list contains
   only `FileRead`, and the cascade only allows through `FileRead`.
   The two layers have the same input and the same `Set` semantics.
9. **Empty `allowedTools: []` end-to-end.** `_activeCallModel`
   constructed with `tools: []`, `scopedToolAllowlist = []`, every
   tool denies. Tested.
10. **Audit metadata only.** `skill_activated` carries booleans for
    `hasAllowedTools` / `hasArgs`; never the strings.
    `skill_deactivated` carries the reason enum; never the body.
    `redactSecrets` runs at the audit boundary.
11. **Activation-time secret re-scan ALWAYS runs**, even when the
    skill was written by 5a's own gated `writeSkill`. The scan
    target is `serializeSkill(skill)` — same string the write gate
    scans. Tests assert the parity.
12. **Deactivation reason `'error'` only for
    `terminal.reason === 'error'`.** `aborted` and `max_turns` do
    NOT auto-deactivate.
13. **Refusal audit shape isolated.** `'secret_refused'` is emitted
    only by `recordRefusedActivation`, never by `deactivateSkill`.
    `deactivateSkill`'s parameter type stays narrow so its callers
    can't accidentally emit it.
14. **`writeSkill` callers' secret gate unchanged from 5a.** 5b
    loosens activation, NOT writes.
15. **Memory injection still runs** when active. Skills do not
    displace memory; both `'org'` parts coexist, with skill last.
16. **Cache breakpoint behaviour.** Anthropic adapter Pass 2 lands
    on:
    - skill part when active (regardless of memory)
    - memory part when active=null and memory non-empty
    - nothing when both are empty
17. **Three `_activeCallModel` rebuild sites stay in sync.**
    `setModel`, `reloadMcp` (when tools changed), and first-submit
    MCP bootstrap all refresh `_activeCallModel` if a skill is
    active with `allowedTools`. Missing any one leaves a stale
    callModel.

---

## Sharp edges

- **`turnCallModel` and forks.** The subagent fork's `callModel`
  parameter must use `turnCallModel`, not `this.callModel`.
  Otherwise a forked subagent during an active skill would see the
  unfiltered tool set. `compactCallModel` stays unfiltered (compaction
  emits text only, never `tool_use`).
- **First-turn-of-activation cache miss.** Pass 2 sees a new `'org'`
  byte stream when activation flips the breakpoint location from
  memory to skill. The org segment cache miss is unavoidable on
  activation; subsequent turns of the same activation are cache
  hits. Documented.
- **Activation across `setModel`.** Rebuild
  `_activeCallModel` in `setModel` when `_activeSkill?.allowedTools`
  is set.
- **MCP reload during active skill.** Symmetric rebuild in
  `reloadMcp` when `toolDefinitionsChanged`.
- **Activation BEFORE first MCP-bootstrapping submit.** Captured by
  the rebuild in the first-submit `if (!this._callModelRebuilt &&
  this.hasMcpTools())` block — without this, a skill activated
  before any submission would see a stale (pre-MCP) tool set even
  after MCP brings in new tools.
- **Skill names that look like subcommands.** A skill `id: 'list'` —
  `/skill list` always means subcommand. User must use `/skill
  activate list`. Documented in `/skill help`.
- **`--turns 0`.** Refused at parse time. `--turns N` capped at 100.
- **`--turns` and args interleaving.** `--turns N` must come right
  after the id; everything after is args. Documented.
- **Activation while memory is disabled.** `_memoryBaseDir === null`
  (when `disableMemory: true`) means there's no `skills/` either
  (same baseDir). Skill commands print
  `[skill] disabled in this engine (memory off)`.
- **Activation refused on scan-handler exception.** If
  `confirmYesNo` throws, treat as a refusal — emit `secret_refused`,
  propagate the error to the CLI. Tested.
- **Skill activated, then session resumed.** 5b activations are
  session-runtime only. Resume restores `_activeSkill = null`.
- **Concurrent `/skill activate` and `submitPrompt`.** `_running`
  guard rejects activate; activate before submit. CLI is
  single-threaded by readline so this is a contract issue only at
  the SDK level.
- **Cascade deny audit redaction.** `formatDecisionMessage` for
  `skillScope` includes the `allowed` list. Tool names, not user
  content; no secrets. Pass through redaction unchanged.
- **`scopedToolAllowlist: []` corner.** `[].includes(name) === false`
  for any name → cascade denies every tool. Correct. Tested.
- **`scopedToolAllowlist === undefined` vs absent.** Step 1.5 only
  fires when `opts.scopedToolAllowlist !== undefined`. Absent
  (default for non-active turns) → step 1.5 noop. Tested.
- **Audit envelope ordering.** `skill_activated` is emitted BEFORE
  the first `submitPrompt` of the activation window starts;
  `skill_deactivated` AFTER the terminal of the deactivating turn.
  The audit log shows the natural envelope.
- **Refusal audit on missing skill.** `readSkill → null` is a user
  error, not a security event. Throw a normal error; do NOT emit
  `skill_deactivated`.
- **Refusal on shape error.** If `readSkill` throws
  `MalformedSkillError`, also a user-fixable problem; throw, no
  audit.
- **Two consecutive activations of the same skill.** First
  activates, runs, deactivates on turn-exhaustion; second activation
  is a fresh snapshot via fresh `readSkill`. If the file changed in
  between, the new activation reads fresh bytes.

---

## Verification

### Unit — `src/skills/router.test.ts` (new)

- `scanForActivation`:
  - clean skill → `{ ok: true }`.
  - skill with high-confidence pattern in body →
    `{ ok: false, kind: 'high', matches: [...] }`.
  - skill with low-confidence pattern (e.g. `password = "..."`) →
    `{ ok: false, kind: 'low', matches: [...] }`.
  - skill with both high and low matches → `kind: 'high'`,
    `matches` only contains the high entries.
  - **Parity with write gate**: the same `Skill` round-tripped
    through `writeSkill` (with strict gate) and `scanForActivation`
    yields the same `detectSecrets` results — locks the
    `serializeSkill(skill)` scan target.
- `filterToolDefs`:
  - `defs=[A,B,C], allowed=[A,C]` → `[A, C]` (preserves source
    order).
  - `defs=[A,B,C], allowed=[]` → `[]`.
  - `defs=[A,B], allowed=['NotARealTool']` → `[]`.
  - empty defs → `[]` regardless.
- `makeActiveSkill`:
  - skill with `allowedTools` → snapshot includes the field.
  - skill without `allowedTools` → snapshot omits the field (not
    `[]`).
  - `args: ''` permitted; preserved.
- `summarizeMatches` — types deduplicated, comma-joined.

### Unit — `src/context/skillInjection.test.ts` (new)

- `buildSkillInjectionParts(null)` → `[]`.
- Snapshot-style template assertions for:
  - body only.
  - body + args.
  - body + allowedTools (non-empty).
  - body + allowedTools (empty).
  - body + args + allowedTools (both branches present, args first).
- Stability: two calls with the same input → byte-identical output
  (cache stability).
- Two different active skills → different content; demonstrates
  fresh activation = fresh breakpoint bytes.

### Unit — `src/cli/skillsCommand.test.ts` (new)

Modeled after `memoryCommand.test.ts`. Each test uses a fresh tmp
`baseDir` populated with hand-written SKILL.md files. The engine
fake exposes structural `SkillEngine`.

- `/skill` → prints `SKILLS.md` content; empty store → `(no skills)`.
- `/skill list` → tabular output with id / name / hasArgs /
  allowedToolsCount columns.
- `/skill list` with no skills → `(no skills)` text.
- `/skill show review-pr` → emits `serializeSkill(skill)`
  byte-for-byte.
- `/skill show <missing>` → stderr error, no exception.
- `/skill show <bad-id>` → stderr error.
- `/skill activate review-pr` → engine.activateSkill called with
  `{ turns: 1, args: '' }`.
- `/skill activate review-pr --turns 5 https://x` →
  `{ turns: 5, args: 'https://x' }`.
- `/skill activate review-pr --turns abc` → stderr "must be an
  integer", no engine call.
- `/skill activate review-pr --turns 0` → stderr error.
- `/skill activate review-pr --turns 999` → stderr error (>100 cap).
- `/skill activate review-pr arg1 arg2` → args concatenated
  `'arg1 arg2'`, turns=1.
- Activation that throws because `_running` → stderr error, no
  crash.
- Activation that throws because already-active → stderr error.
- `/skill deactivate` while active → `engine.deactivateSkill('user_deactivated')` called.
- `/skill deactivate` while not active → `(no active skill)` to
  stdout.
- `/skill help` → expected lines.
- `/skill garbage` → unknown subcommand stderr; help text.

### Unit — `src/core/permissions/permissions.test.ts` (edit)

Add cases:

- `scopedToolAllowlist: ['FileRead']`, tool `FileRead` requested →
  cascade falls through step 1.5 (no deny), continues to mode/allow.
- `scopedToolAllowlist: ['FileRead']`, tool `Bash` requested →
  `behavior: 'deny'`, `reason: { type: 'skillScope', toolName: 'Bash', allowed: ['FileRead'] }`.
- `scopedToolAllowlist: []`, tool `FileRead` requested → deny with
  `skillScope`.
- `scopedToolAllowlist: undefined`, tool `Bash` → step 1.5 noop,
  normal cascade applies.
- **Defense-in-depth ordering**: explicit user `deny` rule for
  `FileRead` AND `scopedToolAllowlist: ['FileRead']` → deny by
  `rule` (step 1 wins).
- **Skill scope beats mode bypass**:
  `permissionMode: 'bypassPermissions'`,
  `scopedToolAllowlist: ['FileRead']`, tool `Bash` → deny by
  `skillScope` (step 1.5 wins over step 5).
- `formatDecisionMessage` covers `skillScope` reason:
  `"tool not in active skill's allowed-tools (allowed: FileRead)"`.

### Unit — `src/sdk/QueryEngine.test.ts` (edit)

Add cases under a new `describe('skill activation', ...)`:

- `activateSkill(id)` with no skill on disk → throws "not found"; no
  audit event.
- `activateSkill(id)` while another skill is active → throws.
- `activateSkill(id)` while `_running === true` → throws.
- `activateSkill(id)` with `disableMemory: true` → throws.
- `activateSkill(id)` with high-confidence secret in body → throws,
  audit `skill_deactivated { reason: 'secret_refused' }`, no
  `_activeSkill` set.
- `activateSkill(id)` with low-confidence and `scanHandler` returns
  `false` → throws, audit `skill_deactivated { reason: 'secret_refused' }`.
- `activateSkill(id)` with low-confidence WITHOUT `scanHandler` →
  throws, audit `skill_deactivated { reason: 'secret_refused' }`.
- `activateSkill(id)` with low-confidence and `scanHandler` returns
  `true` → succeeds, `_activeSkill` set, audit `skill_activated`.
- `activateSkill(id, { turns: 3 })` clean → `_remainingTurns === 3`.
- `activateSkill(id, { turns: 0 })` → throws.
- `activateSkill(id)` with `allowedTools: ['FileRead']` set on
  skill → `_activeCallModel !== null`; tool defs passed to that
  callModel are filtered (assertion via stubbed `resolveCallModel`).
- `activateSkill(id)` with `allowedTools: undefined` →
  `_activeCallModel === null`.
- `submitPrompt` while active passes `activeSkill` to
  `buildFullSystemPromptParts` and `scopedToolAllowlist` to
  `permissionOpts` (assertion via spy on the system-prompt builder
  and a captured `authorizeToolUse`).
- `submitPrompt` while active uses `_activeCallModel` for
  `deps.callModel` (assertion via captured deps).
- `submitPrompt` while active passes `turnCallModel` (=
  `_activeCallModel`) into `createForkSubagent`'s `callModel`
  parameter; `compactCallModel` stays unfiltered.
- `submitPrompt` epilogue decrements `_remainingTurns`; reaches 0 →
  emits `skill_deactivated { reason: 'turns_exhausted' }`, clears
  `_activeSkill`.
- `submitPrompt` epilogue with `terminal.reason === 'error'` → emits
  `skill_deactivated { reason: 'error' }`.
- `submitPrompt` epilogue with `terminal.reason === 'aborted'` →
  does NOT deactivate; `_remainingTurns` unchanged.
- `submitPrompt` epilogue with `terminal.reason === 'max_turns'` →
  does NOT deactivate.
- `deactivateSkill('user_deactivated')` while active → clears state,
  emits event.
- `deactivateSkill('user_deactivated')` while inactive → no-op, no
  event.
- `setModel(newModel)` while active with `allowedTools` →
  `_activeCallModel` rebuilt against `newModel` with the same
  filtered defs.
- `reloadMcp` when `toolDefinitionsChanged` and skill is active with
  `allowedTools` → `_activeCallModel` rebuilt.
- **First-submit MCP bootstrap with active skill** —
  `activateSkill` before any submission, then `submitPrompt`; assert
  `_activeCallModel` was rebuilt against post-MCP defs.

### Unit — adapter test sanity (read-only)

`anthropicAdapter.test.ts` already has the two-pass test from 4d.
Add ONE case: parts =
`[global, memory(org), skill(org), volatile, volatile]` → exactly
two `cache_control` markers, one on the last `'global'` and one on
`parts[3]` (last `'org'`, the skill).

### Integration — `tests/integration/skill-activation.test.ts` (new)

Hand-written SKILL.md fixtures under a tmp baseDir; use stub
`callModel` that records its `tools` argument plus the system prompt
parts; collect events through a real `createAuditWriter` pointed at
a tmp file.

- **Activation → submit → deactivate (happy):**
  1. Hand-write SKILL.md with `allowed-tools: ["FileRead"]` and a
     known body.
  2. Engine.activateSkill('id', { turns: 1 }).
  3. Engine.submitPrompt('do thing'). Stub callModel records
     `tools` and `systemPromptParts`.
  4. Assert `tools` array contains exactly `FileRead`.
  5. Assert one of the system-prompt parts has `cacheHint: 'org'`
     and content includes `<system-reminder>` plus the body.
  6. Assert audit JSONL contains `skill_activated`, then
     `skill_deactivated { reason: 'turns_exhausted' }`.
- **Tool denial under skill scope:**
  1. SKILL.md with `allowed-tools: ["FileRead"]`. Activate.
  2. Submit; stub callModel returns a tool_use for `Bash`.
  3. Assert a `permission_decision` event with `decision: 'deny'`,
     reason mentioning `"allowed-tools"`.
  4. Assert synthetic `tool_result` with
     `errorKind: 'permission_denied'`.
- **High-confidence secret refusal:**
  1. Hand-write SKILL.md whose body includes a high-confidence
     pattern.
  2. activateSkill throws.
  3. Audit JSONL contains
     `skill_deactivated { reason: 'secret_refused' }` and NO
     `skill_activated`.
- **Multi-turn activation with cache stability:**
  1. SKILL.md without `allowed-tools` (no scope), `--turns 3`.
  2. submitPrompt three times (stub callModel returns end_turn).
  3. Assert the `'org'` system-prompt part is byte-identical across
     all three calls.
  4. Assert `skill_activated` once, then
     `skill_deactivated { turns_exhausted }` after the third turn.
- **User deactivation mid-window:**
  1. Activate with `--turns 5`.
  2. submitPrompt once.
  3. deactivateSkill('user_deactivated'). Audit shows that reason.
  4. submitPrompt again. System-prompt part array has no `'org'`
     skill part.
- **Empty allowedTools (instruction-only):**
  1. SKILL.md with `allowed-tools: []`.
  2. Activate; submit; stub callModel returns a tool_use for ANY
     tool.
  3. Assert `tools` array passed to callModel is `[]` (send-side
     empty).
  4. Assert any tool_use the model still emits gets denied with
     `skillScope`.

### Manual smoke

```bash
# Author a skill by hand:
mkdir -p ~/.ultron/skills/review-pr
cat > ~/.ultron/skills/review-pr/SKILL.md <<'EOF'
---
name: review-pr
description: Review pull requests for correctness and missing tests.
allowed-tools: ["FileRead", "Grep", "Glob"]
argument-hint: <pr-url>
---

You are reviewing a pull request. Focus on correctness, regression
risk, and missing tests. Do not touch the working tree.
EOF

npm run typecheck && npm run test
node dist/cli.js
> /skill list
> /skill show review-pr
> /skill activate review-pr --turns 2 https://github.com/foo/bar/pull/1
> Try to read some code and identify issues.
> Continue.
> # turns_exhausted, deactivates automatically
> /skill activate review-pr
> /skill deactivate
> /quit

grep -E 'skill_(activated|deactivated|written|deleted)' ~/.ultron/audit.jsonl
```

`ANTHROPIC_LOG=debug` smoke (with a real key) — confirm two
`cache_control` entries during the active turn and the second one's
content matches the wrapped skill body. On the second turn within
the same activation, confirm a `cache_read` hit.

`npm run typecheck && npm run test` green at every step.

---

## Acceptance

- `src/cli/skillsCommand.ts` exports `handleSkillCommand`, plus
  `SkillEngine` / `SkillCommandIo` / `ActivateSkillOpts` /
  `SkillScanHandler` types.
- `src/skills/router.ts` exports `ActiveSkill`, `scanForActivation`,
  `filterToolDefs`, `makeActiveSkill`, `summarizeMatches`,
  `ActivationScanResult`.
- `src/context/skillInjection.ts` exports
  `buildSkillInjectionParts(active: ActiveSkill | null) →
  readonly SystemPromptPart[]`.
- `QueryEngine` exposes `activeSkill`, `isSkillActive` getters and
  `activateSkill(id, opts, scanHandler?)`, `deactivateSkill(reason)`
  methods. Activation honors `_running` and "already active" guards.
- `submitPrompt` passes `activeSkill` to
  `buildFullSystemPromptParts`; threads `scopedToolAllowlist` into
  permission opts; uses `_activeCallModel` when set; epilogue
  deactivates on turn-exhaustion or terminal error.
- `setModel`, `reloadMcp`, AND first-submit MCP bootstrap all
  refresh `_activeCallModel` when a skill is active with
  `allowedTools`.
- `permissions.ts` `runCascade` includes the skill-scope step
  between explicit-deny and explicit-ask. Reason type `skillScope`
  is exported and formatted by `formatDecisionMessage`.
- `PermissionOptions.scopedToolAllowlist?: readonly string[]` is
  added; existing callers unaffected.
- `cacheHints.ts::buildSystemPromptParts` accepts `opts.activeSkill`;
  injects the skill block AFTER memory.
- `queryEvents.ts` exports `SkillActivatedEvent`,
  `SkillDeactivatedEvent`, both in `QueryEvent` union.
- `queryEventFactories.ts` exports `makeSkillActivatedEvent`,
  `makeSkillDeactivatedEvent`.
- `auditLog.ts::SHOULD_AUDIT` includes `'skill_activated'`,
  `'skill_deactivated'`.
- `cli.ts` dispatches `/skill ...` to `handleSkillCommand`; banner
  mentions `/skill`; the new events are silenced (audit-only) in
  the interactive event switch.
- All Phase 4 (4a–4d) and Phase 5a tests stay green unchanged.
- Empty `allowedTools: []` is preserved end-to-end (sees zero tools
  at the model, denies every tool at the cascade).
- `npm run typecheck && npm run test` green.
- Manual smoke: skill activation injects the body, narrows the tool
  set, and the audit log shows the activated/deactivated pair with
  metadata-only payloads.

---

## Implementation order

Each step keeps the build green; each step is mergeable on its own.

1. **Write this design doc** (`docs/ultron_v2/phase5b-v2-design.md`). Done
   first so the design is the contract for the rest.
2. **Audit event types + factories + cli.ts switch.** Edit
   `queryEvents.ts` (+2 events, extend union),
   `queryEventFactories.ts` (+2 factories), `auditLog.ts` (+2
   `SHOULD_AUDIT` entries), AND `src/cli.ts:278-294` event-silencing
   switch (add `'skill_activated'` and `'skill_deactivated'` cases).
   The `cli.ts` switch uses an exhaustive `_exhaustive: never`
   default at line 295-298, so adding new union members WITHOUT
   updating the switch breaks typecheck — bundle them in one step.
3. **`PermissionOptions.scopedToolAllowlist` + cascade step 1.5.**
   Edit `permissions/types.ts` (+field, +reason variant),
   `permissions.ts` (cascade step + `formatDecisionMessage`). Add
   `permissions.test.ts` cases. Existing memory/4d/3 tests
   untouched.
4. **Write `src/skills/router.ts` + `router.test.ts`.** Pure
   helpers. Tests cover scan, filter, snapshot, parity-with-write-gate.
5. **Write `src/context/skillInjection.ts` +
   `skillInjection.test.ts`.** Snapshot-style template assertions.
   Pure.
6. **Wire `cacheHints.ts`** to accept `opts.activeSkill` and invoke
   `buildSkillInjectionParts`. Update `queryContext.ts` opts
   passthrough. Existing memory tests stay green (no opt → no skill
   part).
7. **Wire `QueryEngine`** — fields, getters, `activateSkill`,
   `deactivateSkill`, `recordRefusedActivation`, `setModel` rebuild,
   `reloadMcp` rebuild, **first-submit MCP bootstrap rebuild**,
   `submitPrompt` integration. Update `QueryEngine.test.ts` with
   the activation suite (including the first-submit-MCP scenario).
8. **Write `src/cli/skillsCommand.ts` + `skillsCommand.test.ts`.**
   All subcommand routing, arg parsing, error mapping. CLI
   integration deferred to step 9 so the unit tests stand alone.
9. **Wire `cli.ts`** — `/skill` dispatch block + banner update.
   (Event-silencing switch was already updated in step 2.)
10. **Add `tests/integration/skill-activation.test.ts`** for the
    end-to-end happy path, scope denial, secret refusal, multi-turn
    cache stability, user deactivation, and instruction-only.
11. **Final `npm run typecheck && npm run test` + manual smoke.**
    All green.

5b closes the §5 pillar. The `'org'` injection seam, set up by 4d,
now serves both memory and skills exactly as designed. The cascade
gains its first non-rule deny path that respects the existing
precedence — user explicit denies still win — while closing the
bypass-mode loophole. Future skill phases (project-local, remote
import, composition) build on this activation contract without
changing it.

---

## Critical files to modify or create

- `src/sdk/QueryEngine.ts` (EDIT — fields, getters, activate/deactivate
  methods, recordRefusedActivation helper, submitPrompt integration,
  three callModel rebuild sites)
- `src/skills/router.ts` (NEW)
- `src/context/skillInjection.ts` (NEW)
- `src/context/cacheHints.ts` (EDIT — opts.activeSkill branch)
- `src/context/queryContext.ts` (EDIT — opts passthrough)
- `src/cli/skillsCommand.ts` (NEW)
- `src/cli.ts` (EDIT — dispatch, banner, event-silencing)
- `src/core/permissions/permissions.ts` (EDIT — cascade step 1.5)
- `src/core/permissions/types.ts` (EDIT — option + reason variant)
- `src/core/queryEvents.ts` (EDIT — +2 events, extend union)
- `src/core/queryEventFactories.ts` (EDIT — +2 factories)
- `src/audit/auditLog.ts` (EDIT — +2 SHOULD_AUDIT entries)
- `src/skills/router.test.ts` (NEW)
- `src/context/skillInjection.test.ts` (NEW)
- `src/cli/skillsCommand.test.ts` (NEW)
- `src/sdk/QueryEngine.test.ts` (EDIT — activation describe block)
- `src/core/permissions/permissions.test.ts` (EDIT — cascade cases)
- `tests/integration/skill-activation.test.ts` (NEW)
- `docs/ultron_v2/phase5b-v2-design.md` (NEW — this file)

## Reused existing utilities (do not re-implement)

- `src/skills/store.ts::readSkill` — load skill at activate time.
- `src/skills/skill.ts::serializeSkill` — feed into the secret
  re-scan; same string the write gate scans.
- `src/memory/secretScanner.ts::detectSecrets` — same scanner used
  by 4a/4b/4c gates.
- `src/cli/confirmPrompt.ts::confirmYesNo` — low-confidence ask
  (pattern from `memoryCommand.ts`'s `editLoop`).
- `src/core/tools/registry.ts::getToolDefinitions` — feed
  `filterToolDefs` for send-side filtering.
- `QueryEngine.resolveCallModel` — already takes `tools` arg; reused
  for the activation-filtered build.
- `QueryEngine.rebuildCallModels` pattern — symmetric for
  `_activeCallModel` rebuild on `setModel` / `reloadMcp` /
  first-submit MCP bootstrap.
- `src/audit/redaction.ts::redactSecrets` — runs at the audit
  boundary as defense-in-depth on `skill_activated` / `skill_deactivated`
  payloads.

## Verification end-to-end

```bash
npm run typecheck
npm run test
npx vitest run src/skills/                      # 5a + 5b unit
npx vitest run src/context/skillInjection.test.ts
npx vitest run src/cli/skillsCommand.test.ts
npx vitest run src/sdk/QueryEngine.test.ts
npx vitest run src/core/permissions/
npx vitest run tests/integration/skill-activation.test.ts
# All Phase 4 (4a–4d) and 5a tests stay green:
npx vitest run src/memory/ src/skills/ tests/integration/
```

5b is a runtime-activation phase: success means a skill on disk
becomes a turn-scoped system-prompt part with a narrowed tool set
when activated, the cascade respects the existing precedence (user
deny still wins, mode bypass loses to skill scope), and the
deactivation paths (turn-exhaustion, user, error, secret-refusal)
all emit the right audit envelope. Subagents during an active turn
inherit the narrowed tool set and the cascade scope. The
`'org'`-bucket cache breakpoint flows naturally to the skill body
during an activation window, giving cache hits across multiple
turns.

**Sources consulted for design:**
- v1 v2-ROADMAP.md Phase 5b row (lines 414-447)
- Phase 5a design (`docs/ultron_v2/phase5a-v2-design.md`)
- Phase 4d design (`docs/ultron_v2/phase4d-v2-design.md`) — closest analog
  (memory injection at the same `'org'` seam)
- OpenAI Codex Skills: https://developers.openai.com/codex/skills
  (`argument-hint` convention)
- Claude Code Skills: https://code.claude.com/docs/en/skills
  (skill activation patterns)
