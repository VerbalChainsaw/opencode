# Repair handoff — Step 5 of 9 (AG-P0-04)

**Step:** AG-P0-04 — Give the chain draft explicit provenance
**Commit:** `d6033a3b9 fix(app): explicit ChainDraftSource provenance for empty-draft survival`
**Date:** 2026-06-25
**Status:** Complete. App test suite 657 pass, 12 pre-existing failures (verified unchanged by stashing the diff and re-running on baseline).

---

## What landed

Three files changed:

| File | Change |
|------|--------|
| `packages/app/src/pages/session/goal-panel.tsx` (+73/-3) | New `ChainDraftSource = "uninitialized" \| "draft"` type and `source` field on `ChainDraftState`. Mutation callsites (addActionToChain, removeDraftStep, moveDraftStep, updateDraftStepBudget, updateMasterBudget, both Clear Draft paths, resetGoalState) flip `source` to `"draft"`. Session-switch effect restores `source` from the freshly-loaded draft. Autosave persists `source`. `runnableChainSteps` passes `source` to the selector. |
| `packages/app/src/pages/session/goal-panel-pure.ts` (+20/-2) | `selectRunnableChainSteps` now takes a `source` arg. Empty draft + `source === "draft"` returns `[]` (no recovery). Empty draft + `source === "uninitialized"` falls back to runtime snapshot (recovery). 2-arg call shape preserved as default for backward compatibility. |
| `packages/app/src/pages/session/goal-panel-pure.test.ts` (new, 98 lines) | 6 tests pinning each branch of the contract: populated-draft-wins, recoverable-empty, explicit-empty-survives-clear, backward-compatible-2-arg, deterministic-empty-cases, session-switch-round-trip. |

## Proof packet

### Root cause

The local chain draft's `steps: []` shape could not distinguish "no draft ever set" (recoverable from a runtime chain) from "user explicitly cleared the draft" (must remain empty). The symptom: deleting the last draft step would resurrect the runtime chain's steps on the next poll update — the "last X revives the whole list" sequence reported in the ticket.

The fix introduces `ChainDraftSource = "uninitialized" | "draft"` on the `ChainDraftState` and threads it through every mutation site, the persistence round-trip, and the runnable-steps selector.

### Files changed
- `packages/app/src/pages/session/goal-panel.tsx`
- `packages/app/src/pages/session/goal-panel-pure.ts`
- `packages/app/src/pages/session/goal-panel-pure.test.ts` (new)

### Test counts

| Suite | Result |
|-------|--------|
| `bun test --preload ./happydom.ts src/pages/session/goal-panel-pure.test.ts` (new) | 6/6 pass |
| `bun run typecheck` (app) | clean |
| `bun test --preload ./happydom.ts` (full app) | 657 pass, 12 fail — **same 12 as pre-change baseline** (verified by `git stash` + re-run) |

The 12 pre-existing failures are unrelated to this change. They are mission-control visual contract tests, i18n parity for Chinese locales, and a useGoal accessor test — all documented in prior baselines.

### Required tests (per ticket)

1. ✅ delete the final draft step → visible list remains empty after chain poll update. *(pinned by test 3: "explicit empty draft... no recovery")*
2. ✅ Clear Draft → visible and runnable lists remain empty. *(pinned by test 3 + the new `setChainDraft("source", "draft")` line in the Clear Draft button handler)*
3. ✅ reload with persisted explicit empty draft → remains empty. *(pinned by test 6: "session switch restores source from persisted draft")*
4. ✅ no stored draft plus matching recoverable runtime chain → recovery still works. *(pinned by test 2: "uninitialized empty draft falls back to runtime snapshot")*
5. ✅ active live chain → runtime steps display regardless of empty local draft. *(pinned by the existing `liveGoal()` guard at the `runnableChainSteps` call site, which returns `[]` for the selector when a live goal is active; the runtime chain is rendered separately by the existing live-render path)*
6. ✅ session switch → no draft or runtime chain leaks from the prior session. *(pinned by test 6 + the session-switch effect restoring `source`)*

### Compatibility risks

- **Old stored drafts (no `source` field):** `readStoredChainDraft` defaults them to `"draft"`, which means a pre-AG-P0-04 stored empty draft becomes "explicit empty". This is the desired behavior — a user who closed the browser with an empty draft previously would have had it resurrected by the runtime chain; now it stays empty. No data loss; behavior tightens.
- **The `ChainDraftState` interface change:** any external code that constructs a `ChainDraftState` literal without `source` would fail to compile. Searched the repo — only `defaultChainDraft` and `readStoredChainDraft` construct the type, both updated.

### Explicit non-scope

- Did **not** change `selectRunnableChainSteps`'s 2-arg behavior (preserved as default value).
- Did **not** touch the runtime chain file or chain runner.
- Did **not** touch session storage autosave mechanism (only added `source` to the persisted object).
- Did **not** touch any of the protected parity tests in the autogoal package (this is an app change).
- Did **not** add toast plumbing for explicit-empty confirmation (out of scope per ticket).

---

## Next: AG-P1-05 (separate draft/live/terminal actions)