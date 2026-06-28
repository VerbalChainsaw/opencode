# AutoGoal Vision

Last updated: 2026-06-28

This document turns the feature scan into a durable product direction for
AutoGoal and Mission Control. It is a planning document, not an implementation
spec. For code changes, the files in `packages/autogoal/specs/` remain the
authoritative work orders.

## Product Thesis

AutoGoal should make long-running agent work inspectable, controllable, and
recoverable from the Desktop app. The plugin owns the goal state, chains,
verification, history, templates, webhooks, and RenderBlock payloads. Mission
Control draws that state as an operator surface: start the right work, see why
it is running, interrupt it cleanly, recover from failure, and export what
happened.

The next phase is not another surface. It is better operational truth around
the surfaces that already exist.

## Current Baseline

The repository already has the major AutoGoal primitives in place:

- CLI commands for goal setup, watch mode, doctor output, archives, and stats.
- Goal chains with ordered steps, constraints, templates, and structured
  verification.
- Session events and step timeline files in `.opencode/`.
- Goal history and archive data.
- Webhook notification support.
- RenderBlock factories for GUI-ready plugin output.
- Desktop GoalPanel controls, activity, history, handoff, and state polling.

That means the next product work should mostly connect, explain, and harden the
existing data rather than invent a separate control plane.

## Strategic Pillars

### 1. Explainability Before More Controls

Operators need to know why AutoGoal is running, waiting, paused, blocked, or
done. Add an `explain` path before adding another command family.

Candidate work:

- Add `opencode-autogoal explain` to summarize the active goal, chain step,
  verification condition, budget, pinned runtime choices, webhook status, and
  the next expected transition.
- Render the same explanation in Mission Control as a diagnostic card.
- Include corrupt-state, missing-backend, unavailable-pin, and webhook-delivery
  details in the explanation instead of burying them in logs.

Relevant anchors:

- `packages/autogoal/docs/FEATURE-BACKLOG.md` - FTR-004 diagnostic UX.
- `packages/autogoal/src/cli.ts` - current CLI command surface.
- `packages/autogoal/src/command.ts` - command dispatcher.
- `packages/app/src/pages/session/goal-panel.tsx` - Desktop diagnostic surface.

### 2. Observable Runs, Not Just Current State

AutoGoal already writes session events and step timelines. Mission Control
should make that history visible as a first-class run timeline.

Candidate work:

- Promote the current activity strip into a full timeline view.
- Merge `.session-events.jsonl`, `.step-timeline.jsonl`, goal state, chain
  state, and archive rows into one ordered operator story.
- Show verification attempts, budget changes, pauses, resumes, handoffs,
  webhooks, errors, and terminal outcome.
- Keep the compact activity strip for scanning, but make every entry expandable
  when data exists.

Relevant anchors:

- `packages/autogoal/docs/SPEC.md` - session events and timeline requirements.
- `packages/autogoal/src/session-events.ts`.
- `packages/autogoal/src/step-timeline.ts`.
- `packages/app/src/pages/session/goal-panel.tsx` - activity and history UI.

### 3. Exportable Proof

When a run finishes, the user should be able to preserve the outcome without
reconstructing it from files and chat history.

Candidate work:

- Add a run report export that includes the goal condition, chain, verification
  history, timeline, activity, handoff text, prompts where available, webhook
  delivery state, and final outcome.
- Support Markdown first. JSON can follow for automation.
- Add the report action from both the CLI and Mission Control history.

Relevant anchors:

- `packages/autogoal/src/goal-archive.ts`.
- `packages/autogoal/src/goal-state.ts`.
- `packages/autogoal/src/goal-chain.ts`.
- `packages/autogoal/docs/FEATURE-BACKLOG.md` - archive and reporting backlog.

### 4. Recoverable History

History is useful only when it is navigable. The current archive and history
data should become a recovery surface, not a passive list.

Candidate work:

- Add current-run versus all-runs filtering in Mission Control.
- Add search and filters by status, chain title, condition, date, and session.
- Let archived runs open a read-only detail view with timeline and report
  actions.
- Preserve noisy or corrupt historical entries, but label them honestly.

Relevant anchors:

- `packages/autogoal/docs/SPEC.md` - archive requirements.
- `packages/autogoal/src/goal-archive.ts`.
- `packages/app/src/pages/session/goal-panel.tsx` - history panel.

### 5. Named Goal Slots

The current state model is a single active goal per workspace. That is simple
and should remain the default, but the next major architecture step is named
goal slots for parallel intent.

Candidate work:

- Design slots such as `work`, `scratch`, `release`, and `review`.
- Keep one default slot so current workflows and files remain valid.
- Add a migration plan for `.opencode/.goal-state.json`, `.goal-chain.json`,
  history, handoff, and GUI polling.
- Specify how slots interact with webhooks, templates, session ownership, and
  chain auto-advance before writing code.

Guardrail: do not implement this as ad hoc extra files without a spec and
migration plan.

Relevant anchors:

- `packages/autogoal/src/goal-state.ts`.
- `packages/autogoal/src/goal-chain.ts`.
- `packages/autogoal/docs/gui-integration.md`.

### 6. Reliable Integrations

Webhook support exists, but delivery should be visible and recoverable.

Candidate work:

- Add retry and backoff for failed webhook delivery.
- Persist failed-delivery status where both CLI and GUI can report it.
- Include delivery attempts in timeline and exported reports.
- Add operator-facing language for unreachable endpoints, permanent failures,
  and local-address blocking.

Relevant anchors:

- `packages/autogoal/src/server.ts` - webhook execution.
- `packages/autogoal/test/server-webhook.test.mjs`.
- `packages/autogoal/test/bridge-chain-webhook.test.mjs`.

### 7. Runtime Modernization

AutoGoal depends on reliable OpenCode session events and Desktop runtime
packages. Upgrade work should be staged, measured, and boring.

Candidate work:

- Retire temporary session v2 dual-write logic once event streams are stable.
- Keep app-side timeline work aligned with cursor-based session/event loading.
- Batch safe minor dependency upgrades first.
- Isolate larger moves behind separate gates, especially OpenTUI peer changes,
  Shiki major changes, and Electron/Vite ecosystem updates.
- Use package-level gates instead of repo-wide guesses.

Relevant anchors:

- `packages/opencode/src/session/processor.ts` - session v2 dual-write notes.
- `packages/app/src/pages/session.tsx` - session pagination and event loading.
- Root `package.json` catalogs.
- `packages/app/package.json`.
- `packages/desktop/package.json`.

## Upgrade Path

### Near Term

1. Add `explain` and the matching Desktop diagnostic card.
2. Expand Mission Control activity into a real run timeline.
3. Add current-run versus all-runs history filtering.
4. Surface webhook delivery failures and retry status.

### Mid Term

1. Add Markdown run report export.
2. Consolidate duplicated goal-control dispatcher behavior where it reduces
   drift without regressing the bridge's async atomic-write behavior.
3. Finish session v2 cleanup so timeline and reports trust one event path.
4. Make archive detail views the recovery path for completed and failed runs.

### Major Architecture

1. Specify named goal slots.
2. Design the migration and compatibility plan.
3. Implement slot-aware state, history, handoff, webhooks, CLI, bridge, and
   Mission Control controls behind focused tests.

## Guardrails

- The sole authoritative AutoGoal implementation is this monorepo under
  `packages/autogoal/`.
- Do not recreate, edit, test, or mirror work into the retired sibling
  `../OpenGoal` checkout.
- Do not build standalone terminal TUIs for Desktop GUI requests.
- The plugin defines data; the app renders data.
- Electron verification is required for visual Desktop changes.
- Specs in `packages/autogoal/specs/` win over this document when they conflict.
- Historical `.hermes` handoffs and scratchpad entries are useful evidence, but
  they are not current instructions when they disagree with `AGENTS.md`,
  `packages/autogoal/AGENTS.md`, or this vision.
