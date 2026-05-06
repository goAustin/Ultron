# Model Hot-Swap Handoff

## Status

Future development note.

Ultron already supports model hot-swapping between turns. The current contract is
practical and sufficient for real-world task delivery: message history, session
state, permissions, tools, memory injection, and visible assistant output are
preserved; model-private inference state is not preserved.

This document records the intended boundary and a possible follow-up feature:
an explicit visible handoff when switching models.

## Current Contract

`QueryEngine.setModel()` swaps the main-loop `callModel` by resolving the new
model through the provider registry and rebuilding the provider adapter. The
engine keeps its local state:

- conversation messages
- session ID and transcript
- permission rules and app state
- tool registry and MCP tools
- read-file state used by edit safety checks
- active skill window and filtered tool definitions

The next `submitPrompt()` sends the preserved message history to the newly
selected model through that model's provider adapter.

What is not preserved:

- hidden chain-of-thought
- provider-side inference state
- KV cache or equivalent runtime cache
- private planning that was never emitted into the conversation
- provider-specific reasoning blocks that are not portable across adapters

This is intentional. Model-private state is generally unavailable through public
provider APIs, is provider-specific, and should not become an application-level
correctness dependency.

## Practical Implication

A workflow like this is safe:

1. Use GPT-5.4 to produce a visible task plan.
2. Switch to MiniMax-M2.7.
3. Ask MiniMax-M2.7 to execute the visible checklist, preserving named
   constraints and running the required verification.

A workflow like this is unsafe:

1. Ask GPT-5.4 to think through a plan without emitting it.
2. Switch to MiniMax-M2.7.
3. Ask MiniMax-M2.7 to continue.

In the unsafe case, MiniMax only receives the transcript and system prompt. It
does not receive GPT-5.4's private reasoning. Task quality then depends on
whether the visible transcript contains enough operational detail.

## Design Position

Supporting hot-swapping is enough as the core capability. Ultron should not try
to emulate or promise transfer of hidden model state.

Instead, Ultron should make cross-model handoff explicit when the user wants it.
The durable interface between models should be written artifacts:

- visible plans
- TODO lists
- edited files
- tool results
- test output
- compact summaries
- acceptance criteria
- known risks and blocked questions

This keeps behavior explainable, provider-agnostic, auditable, and compatible
with session resume.

## Future Feature: Explicit Handoff

Add an optional handoff step around `/model`:

1. User selects a different model.
2. If the current session has non-trivial history, Ultron offers or runs a
   handoff summary before switching.
3. The current model emits a concise visible summary.
4. Ultron persists that summary as a normal assistant message, possibly flagged
   as metadata if it should not be user-facing by default.
5. Ultron calls `setModel()` and continues with the new model.

Suggested handoff prompt shape:

```text
Summarize the current work for another model that will continue execution.
Include:
- user goal
- relevant constraints
- completed work
- current plan
- next concrete actions
- files or commands that matter
- risks, blockers, and tests still needed

Do not include hidden reasoning. Write only operational context needed to
continue the task.
```

The summary should be short enough to preserve context budget, but concrete
enough that a weaker or cheaper model can continue without guessing.

## UX Options

Possible CLI behavior:

- `/model` keeps today's behavior by default.
- `/model --handoff` generates and persists a handoff before switching.
- A config option can enable automatic handoff when switching providers or when
  switching from a thinking-capable model to a non-thinking model.
- If a turn is in progress, `setModel()` should continue to reject the switch;
  handoff only runs between turns.

The first implementation should prefer an explicit command or prompt over an
automatic behavior change, because a handoff summary costs tokens and may add
latency.

## Implementation Notes

Likely touch points:

- `src/cli.ts`
  - Extend `/model` handling with an optional handoff mode.
  - Keep the existing direct `engine.setModel(choice)` path intact.

- `src/sdk/QueryEngine.ts`
  - Add a method such as `createHandoffSummary()` or `handoffBeforeModelSwitch()`.
  - Reuse the normal query path where possible so transcript persistence,
    audit events, hooks, and compaction behavior stay consistent.
  - Avoid switching models until the handoff turn has completed successfully.

- `src/core/messages.ts`
  - Consider whether a handoff summary needs a new flag, for example
    `isHandoffSummary`, or whether a plain assistant message is preferable.

- `src/core/normalizeMessages.ts`
  - Ensure handoff summaries remain visible to future providers.
  - Do not encode provider-specific reasoning data as handoff state.

## Acceptance Criteria

- Switching models preserves local conversation/session state exactly as today.
- A handoff summary, when requested, is persisted before the model changes.
- The new model receives the handoff as ordinary visible context.
- The feature does not claim or imply transfer of hidden reasoning state.
- If the handoff generation fails, the model remains unchanged unless the user
  explicitly chooses to switch anyway.
- Tests cover same-provider and cross-provider switches, including a switch from
  a thinking-capable model to MiniMax-M2.7.

## Non-Goals

- No attempt to transfer hidden chain-of-thought.
- No provider-specific cache migration.
- No dependency on model-private runtime state.
- No requirement that all models understand the same reasoning controls.
