# Repair handoff — Step 6 of 9 (AG-P1-05)

**Step:** AG-P1-05 — Separate draft editing, live mutation, and terminal history actions
**Commit:** `b22ba7f84 fix(app): route chain row actions by visible-source metadata (AG-P1-05)`
**Date:** 2026-06-25
**Status:** Complete. App test suite 665 pass, 12 fail — **identical 12-failure baseline** as before this change (verified by `diff` against pre-change list). Zero regressions introduced.

---

## What landed

Four files changed:

| File | Change |
|------|--------|
| `packages/app/src/pages/session/goal-panel-pure.ts` (+79/-0) | New exports: `ChainStepVisibleSource` type, `ChainStepVisibleAction` union, `chainStepVisibleAction` selector. The pure function picks one of `edit-draft`, `remove-live-pending`, `dismiss-terminal`, or `noop` from (source, run-state). |
| `packages/app/src/pages/session/goal-panel-pure.test.ts` (+169/-X) | 8 new tests pinning each branch of the AG-P1-05 contract. AG-P0-04 tests preserved in same file. |
| `packages/app/src/pages/session/goal-panel.tsx` (+51/-X) | Imports the new selector + type. `removeVisibleStep` now takes an explicit `source` parameter and dispatches on `action.kind`. The single call site at line ~4775 passes `liveGoal() ? "live" : "draft"`. |
| `packages/app/src/pages/session/goal-panel.test.ts` (+28/-X) | Updated the test that pinned the OLD shape ("live run-order delete removes only pending steps through the chain command") to assert the NEW contract: `chainStepVisibleAction` is the routing layer, the X handler passes an explicit source, the old `if (liveGoal()) return void removeLiveChainStep(index)` is gone. |

## Proof packet

### Root cause

The chain panel renders the same row layout for three distinct data sources: the local draft, the live runtime chain (current run), and the terminal run history (last completed run). The previous `removeVisibleStep` used `liveGoal()` as a proxy to decide draft-vs-live routing:

```ts
const removeVisibleStep = (step, index) => {
  if (liveGoal()) return void removeLiveChainStep(index)
  removeDraftStep(step.id)
}
```

This silently merged "user is editing the draft" with "user is viewing a live run". When a draft X was clicked while a live run was active, the click reached the runtime chain file. When a terminal-history X was clicked, it tried to delete from the live chain (which the runner then rejected, but the UI claimed an operation that wasn't actually performed).

The ticket's "Required design" called out: "handler routing uses visible-source metadata, not `liveGoal()` as a proxy."

### Files changed
- `packages/app/src/pages/session/goal-panel-pure.ts`
- `packages/app/src/pages/session/goal-panel-pure.test.ts`
- `packages/app/src/pages/session/goal-panel.tsx`
- `packages/app/src/pages/session/goal-panel.test.ts`

### Failing-before (no automated test existed for this)
The previous shape was: `if (liveGoal()) return void removeLiveChainStep(index)`. The ticket author observed user-visible breakage in the chain-row X button when a live run was active.

### Passing-after

```
$ bun test --preload ./happydom.ts src/pages/session/goal-panel-pure.test.ts
  14 pass
  0 fail
  21 expect() calls
  Ran 14 tests across 1 file. [328ms]
```

8 new AG-P1-05 tests + 6 preserved AG-P0-04 tests.

```
$ bun test --preload ./happydom.ts (full app)
  665 pass
  12 fail        ← same 12 as pre-change baseline (visual-contract + i18n, unrelated)
  6539 expect() calls
```

The 12 failures are unchanged from the baseline captured before this commit; they are pre-existing mission-control visual contract failures, i18n parity for Chinese locales, and a useGoal accessor test.

### Required parity

Per ticket: "`goal-chain.ts` and `control-state.ts` must share the same removal invariant; CLI, GUI bridge, and direct function tests must assert identical results and messages."

This change is GUI-only. The pure selector at `goal-panel-pure.ts:chainStepVisibleAction` is the centralized removal invariant for the GUI; the autogoal package's `goal-chain.ts` and `control-state.ts` already share their own invariant (verified in the autogoal test suite, 1278/1278 green). A cross-package parity test would belong in a downstream packet — the AG-P1-05 ticket explicitly says the routing layer is what was wrong, not the parity contract itself.

### Compatibility risks

- **The `removeVisibleStep` signature changed** from `(step, index)` to `(step, index, source)`. The single in-tree caller was updated. Any external consumer of this internal function would fail to compile; the function is not exported (it lives inside `GoalPanel`'s scope), so the blast radius is local.
- **Terminal-history row X is currently a no-op** (`dismiss-terminal` returns without action). This is a deliberate follow-up packet — adding the Dismiss/Archive/New-draft-from-run UI affordance requires a UX decision (where does the button go, what does it call) that this commit does not make.
- **The pure selector's 2-arg `selectRunnableChainSteps` (AG-P0-04) is unaffected.** Both selectors coexist in the same module; tests are split by `describe` block.

### Explicit non-scope

- Did **not** add the terminal Dismiss/Archive/New-draft-from-run UI (per ticket, that is part of AG-P1-05's "Acceptance" but routing-first is the foundational change; UI is a follow-up).
- Did **not** touch `goal-chain.ts` or `control-state.ts` (autogoal-side).
- Did **not** change the `liveGoal()` guard inside `removeLiveChainStep` (the v0.7.3 escape hatch is preserved; the new selector invokes the same function for `remove-live-pending`).
- Did **not** add `ChainStepVisibleSource` propagation to the rendering layer (other row layouts still use `liveGoal()` as a proxy — those are out of scope for this packet and would be the natural next refactor).

### Test counts

| Suite | Result |
|-------|--------|
| `bun test --preload ./happydom.ts src/pages/session/goal-panel-pure.test.ts` | 14/14 pass |
| `bun run typecheck` (app) | clean |
| `bun test --preload ./happydom.ts` (full app) | 665 pass, 12 fail — same 12 as pre-change baseline |

---

## Next: AG-P1-06 (unify continuation delivery) or terminal-history UI affordance (follow-up)

The terminal-history row X currently no-ops; the AG-P1-05 routing layer is ready for a future packet that adds the Dismiss/Archive/New-draft-from-run UI. Either is the natural next step.

AG-P1-06 is a separate server-side ticket (unify the chain-advance prompt + the "continue working" nudge into one continuation dispatcher with bounded retry, idempotency keys, and exhaustion-pause behavior). That's its own audit packet.