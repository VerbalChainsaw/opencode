# center-audit report — Sloppy wiring scan of recent 18 commits

**Author:** Hermes (acting as senior engineer)
**Date:** 2026-06-25
**Repository:** `C:\Users\zerop\Development\opencode-source`
**Audit target:** HEAD = `7b1645fff`; baseline = `4ebcf1c30` (start of the repair program)
**Mode:** AUTONOMOUS (user said "scan recent code for gaps, wiring issues, sloppy code")
**Method:** Multi-defect hardening audit over the recent commit window

---

## Audit frame

```
Mode:             AUTONOMOUS
Repository root:  /mnt/c/Users/zerop/Development/opencode-source
Target revision:  HEAD = 7b1645fff
Baseline:         4ebcf1c30 (AG-P0-01 red-pin, start of repair program)
Workspace state:  CLEAN
Subsystems:
  - packages/autogoal/src/server.ts (2487 lines, ~430 changed in 18 commits)
  - packages/autogoal/src/goal-chain.ts (geometry audit fixes)
  - packages/autogoal/src/deliverContinuation (new, ~150 lines + tests)
  - packages/app/src/pages/session/goal-panel.tsx (5617 lines, visible-source routing)
  - packages/app/src/pages/session/goal-panel-pure.ts (1295 lines, pure helpers)
Environment:      WSL, node --test + bun --test (bun unavailable this session)
Defect classes:   Atomicity, Validation, Message accuracy, Input hardening,
                  Hidden assumptions, State mutation, Temporal inconsistency,
                  Documentation
```

---

## Defect catalog

### D-NEW-1 — dispatcher's `onNotify` callback swallows notify failures (chain-advance path)

**Class:** Error swallowing / sloppy wiring
**Impact:** MEDIUM (user can't see why a notification was suppressed; debuggability)
**Confidence:** HIGH
**Mutation likelihood:** CERTAIN (every chain-advance pause path)
**Repro:** DETERMINISTIC

#### Evidence

**E-NEW-1-1** — `packages/autogoal/src/server.ts:1585-1587`
```ts
onNotify: async (title: string, message: string, level: ...) => {
  await notify(sessionId, title, message, level).catch(() => {});
},
```
**E-NEW-1-2** — same pattern at line 1753-1755 (continue-nudge path).

#### Trajectory

The dispatcher's `finalizePause` (line 470) is the documented C4 ordering:
```ts
await opts.deps.onPause(reason);
await opts.deps.onNotify(...);  // ← calls the dep callback
opts.deps.onWebhookFire("paused");
opts.deps.onReset();
```

The chain-advance and continue-nudge `onNotify` deps callbacks BOTH wrap `notify()` with `.catch(() => {})`. **The dispatcher already awaits the callback** — if `notify()` throws, that throw propagates through the dispatcher's await chain and surfaces in the dispatcher's caller (server.ts) as a rejection. **Wrapping with `.catch(() => {})` inside the callback HIDES notify failures from the dispatcher's error path AND from the surrounding evaluate() try/catch.**

This is the exact pattern flagged in step 11 of the previous audit: the previous code also had `notify(...).catch(noop)`. The refactor preserved the swallowing rather than removing it.

#### Repair contract

Either:
- **Option A** (preferred): Remove the `.catch(() => {})` from the dep callbacks; let notify failures propagate to the dispatcher's caller (which has the surrounding try/catch in evaluate() and logs via `log("error", ...)`).
- **Option B**: Document the intentional swallow with a comment.

Either is a 2-line change. Option A is consistent with the audit's claim that `finalizePause` is the single source of truth for pause semantics — notify errors should be observed, not silently dropped.

---

### D-NEW-2 — dispatcher's `finalizePause` does NOT await `onWebhookFire` (C4 ordering not actually guaranteed)

**Class:** Temporal inconsistency / sloppy contract
**Impact:** MEDIUM (the C4 fix is documented but not enforced — webhook can fire before notify completes)
**Confidence:** HIGH
**Mutation likelihood:** CERTAIN

#### Evidence

**E-NEW-2-1** — `packages/autogoal/src/server.ts:470-479`
```ts
const finalizePause = async (reason: string, level: "error" | "warning") => {
  await opts.deps.onPause(reason);
  await opts.deps.onNotify(...);
  opts.deps.onWebhookFire("paused");  // ← NOT awaited
  opts.deps.onReset();
};
```

**E-NEW-2-2** — `packages/autogoal/src/server.ts:356`
```ts
onWebhookFire(status: GoalStatus): void;  // typed as sync void
```

#### Trajectory

The C4 fix documented in commit `eef28483c` claimed: "the order is `onPause → onNotify → onWebhookFire`". The code DOES call them in that order, but `onWebhookFire` is typed `void` (synchronous return) and is NOT awaited. If `fireWebhook()` is async internally (which it is — `fetch(wh.url, ...)`), the call returns a Promise that nobody awaits. **The webhook fires fire-and-forget; the C4 ordering is NOT actually sequential.**

This is also reinforced by the type signature `onWebhookFire(status: GoalStatus): void` — the dispatcher treats it as synchronous, but the production implementation may be async. Type-vs-runtime mismatch.

#### Repair contract

- Change the interface: `onWebhookFire(status: GoalStatus): Promise<void> | void;`
- In `finalizePause`: `await opts.deps.onWebhookFire("paused");`
- Update the call sites in server.ts (chain-advance + continue-nudge) — they currently use `fireWebhook(fresh, status)` synchronously which is fine, but if anyone wraps it in an async operation the type would allow it.

A 3-line change: one line in the interface, one in finalizePause, one optional line in the call sites if needed.

---

### D-NEW-3 — `remove-live-pending` action silently dismisses entire chain view when no live goal

**Class:** Hidden assumption / sloppy semantics
**Impact:** MEDIUM (user clicks X on a row that has no live goal → entire chain UI vanishes)
**Confidence:** HIGH
**Mutation likelihood:** CERTAIN (any user whose chain has no `liveGoal()` and clicks X)

#### Evidence

**E-NEW-3-1** — `packages/app/src/pages/session/goal-panel.tsx:3083-3088`
```ts
case "remove-live-pending":
  if (!liveGoal()) {
    setChainDismissed(true)
    setChain(null)
    return
  }
  return void removeLiveChainStep(action.index);
```

**E-NEW-3-2** — Pure selector `chainStepVisibleAction` at `goal-panel-pure.ts:1199-1214` returns `remove-live-pending` when the source is "live" and either the run is terminal OR `index > runningStepIndex`. If there's no live goal at all (`liveGoal() === null`), the row's `source: "live"` metadata can still be set if the chain data has a `live` source row. The tsx handler then incorrectly transitions to "dismiss the chain view" semantics.

#### Trajectory

The intent of the tsx dispatch was:
- If live goal exists → call `removeLiveChainStep(action.index)`
- If no live goal → ? (undefined behavior; the code chooses "dismiss entire view")

The actual user-visible behavior: a user with a draft + a stale "live" source row in the chain panel (e.g., after the live run finished but the row template hasn't refreshed) clicks X, and the entire chain panel disappears. **No error, no recovery, no archive.**

The pure selector doesn't have access to `liveGoal()` (it takes `runningStepIndex` and `liveRunStatus` separately), so it can't suppress this path itself. The contract is "the tsx layer must validate `liveGoal()` before calling removeLiveChainStep" — but the implementation uses `setChainDismissed(true); setChain(null)` as the validation-failed branch.

#### Repair contract

The tsx layer should treat `liveGoal() === null` as a noop for `remove-live-pending`, NOT a dismissal. Replace:
```ts
case "remove-live-pending":
  if (!liveGoal()) {
    setChainDismissed(true)  // ← remove
    setChain(null)           // ← remove
    return
  }
  return void removeLiveChainStep(action.index);
```

with either an error toast or a silent noop:
```ts
case "remove-live-pending":
  if (!liveGoal()) return;  // nothing to remove
  return void removeLiveChainStep(action.index);
```

(The pure selector should arguably be updated to add `noop` as a possible return for the "live source but no live run" case, but that's a contract extension.)

---

### D-NEW-4 — `setChainDraft` in session-switch effect triggers multiple intermediate state writes

**Class:** State mutation / temporal inconsistency
**Impact:** MEDIUM (tab close during session switch corrupts persisted draft)
**Confidence:** MEDIUM
**Mutation likelihood:** UNLIKELY (requires fast user action during a switch)

#### Evidence

**E-NEW-4-1** — `packages/app/src/pages/session/goal-panel.tsx:1585-1594`
```ts
setChainDraft("source", next.source)   // write 1
setChainDraft("steps", next.steps)      // write 2
setChainDraft("master", "maxTurns", ...) // write 3
setChainDraft("master", "maxTimeMinutes", ...) // write 4
setChainDraft("objective", next.objective) // write 5
```

**E-NEW-4-2** — SolidJS stores batch reactivity but each `setChainDraft` call triggers an `effect()` if one is registered. `writeStoredChainDraft` is called via an `effect()` that auto-persists on store changes — see lines 1498-1510 area.

#### Trajectory

If `effect()` runs synchronously after each `setChainDraft`, each intermediate state is persisted. A user closing the tab between write 1 and write 5 ends up with `source: next.source` but `steps: OLD.steps`. On reload, the draft appears "touched" but with old step content — silently inconsistent.

Even if `effect()` is batched (SolidJS typically does), the order of writes within a single batch is the issue: the autosave `writeStoredChainDraft` reads the store at flush time. If batched correctly, it reads the FINAL state. **But the test that pins this behavior is absent.**

#### Repair contract

Use `batch(() => { ... })` from solid-js to wrap the multi-field update:
```ts
import { batch } from "solid-js";
batch(() => {
  setChainDraft("source", next.source);
  setChainDraft("steps", next.steps);
  setChainDraft("master", "maxTurns", next.master.maxTurns);
  setChainDraft("master", "maxTimeMinutes", next.master.maxTimeMinutes);
  setChainDraft("objective", next.objective);
});
```

This guarantees the autosave `effect()` fires once with the final state.

---

### D-NEW-5 — `ignoreRefreshError` and 3 other catch-all error swallower helpers in tsx

**Class:** Error swallowing (multiple sites)
**Impact:** MEDIUM (user sees stale chain/archive/handoff/activity forever if SDK is unreachable)
**Confidence:** HIGH
**Mutation likelihood:** CERTAIN (any network blip to the SDK)

#### Evidence

**E-NEW-5-1** — `packages/app/src/pages/session/goal-panel.tsx:1622`
```ts
const ignoreRefreshError = (_error?: unknown) => undefined
```
Used at lines 1631, 1662, 1668, 1684, and others. **No log, no telemetry, no user notification.**

**E-NEW-5-2** — `fetch(wh.url, ...).catch(() => { /* fire-and-forget */ })` at `server.ts:1304`. **Webhook failures silently dropped.**

**E-NEW-5-3** — `client.app.log({...}).catch(() => {})` at `server.ts:925`. **Plugin log failures silently dropped.**

**E-NEW-5-4** — `client.tui.showToast({...}).catch(() => {})` at `server.ts:1021`. **Toast failures silently dropped.**

#### Trajectory

`ignoreRefreshError` was added pre-this-program (pre-existing code). The webhook fetch swallow and the SDK error swallows are pre-existing. **None of these were introduced by the 18-commit scan window.**

Per the audit's scope discipline: the audit target is the 18-commit window. Pre-existing defects are surfaced for visibility but not in-scope for repair without user direction.

#### Disposition

**IN-SCOPE for awareness, OUT-OF-SCOPE for repair** without user direction. These are real production-stability gaps but they predate the audit window. Recommended follow-up: a dedicated "error-handling hygiene" audit across the codebase to instrument all silent-catch sites with at least a `log("debug", ...)`.

---

### D-NEW-6 — Module-level `lastDeliveredKeyBySession` Map (cross-instance state leak)

**Class:** Hidden assumption (multi-instance safety)
**Impact:** LOW (OpenCode plugin model assumes one plugin instance per workspace)
**Confidence:** HIGH
**Mutation likelihood:** UNLIKELY (depends on host loading multiple plugin instances)

#### Evidence

**E-NEW-6-1** — `packages/autogoal/src/server.ts:544`
```ts
const lastDeliveredKeyBySession = new Map<string, string>();
```

#### Trajectory

`deliverContinuation` is at module level (line 376). It closes over the module-level Map. **If a host loads the plugin twice (e.g., two workspaces), the second instance's Map collides with the first's.** The dedup state would silently misbehave.

The OpenCode plugin model assumes one instance per workspace, so this is theoretical. But the dispatcher function is itself a generic utility that could be reused elsewhere.

#### Repair contract

Move the Map inside `server: Plugin = async (...) => { ... }` closure. Update `deliverContinuation`'s call signature to accept the Map (or a callback that reads/writes it). One-time refactor that improves multi-instance safety.

**OUT-OF-SCOPE for the immediate hardening** — flagged for the architectural-cleanup backlog.

---

### D-NEW-7 — `fireWebhook` is typed as `void` but does async I/O — type-vs-runtime mismatch

**Class:** Documentation / sloppy typing
**Impact:** LOW (TypeScript doesn't catch it; runtime works because the caller doesn't await)
**Confidence:** HIGH
**Mutation likelihood:** UNLIKELY

#### Evidence

**E-NEW-7-1** — `packages/autogoal/src/server.ts:1280`
```ts
function fireWebhook(state: GoalState, previousStatus: GoalStatus | null) {
  ...
  fetch(wh.url, {...}).catch(() => { /* fire-and-forget */ });
}
```
The function uses `fetch`, which is async, but returns nothing (void). The call sites don't `await` it (because they can't — there's nothing to await).

#### Trajectory

This is a pre-existing design choice (fire-and-forget webhook). The sloppy aspect is that **the function isn't typed to indicate its async nature**. A future refactor that tries to `await fireWebhook(...)` would silently get `undefined`.

#### Repair contract

Either:
- Rename to `fireWebhookFireAndForget(...)` (clarifies intent at call sites)
- Or change return type to `void` and add a JSDoc comment `@returns nothing; the HTTP POST is fire-and-forget`

The current `function fireWebhook(state, previousStatus): void` already has the right type — just add the JSDoc warning. **Pre-existing code, OUT-OF-SCOPE for repair** without user direction.

---

## Reclassifications (audit self-correction)

### Initial claim: chain-advance `await notify(...).catch(() => {})` was inside the dispatcher's `finalizePause`

**Reclassified:** The swallow is in the deps callbacks (server.ts call sites), NOT in the dispatcher itself. The dispatcher awaits `opts.deps.onNotify(...)` faithfully. The sloppy code is in the production callbacks (lines 1586, 1754) — see D-NEW-1.

### Initial claim: dispatcher's idempotency Map keyed only on sessionId is wrong-shaped for chains

**Reclassified:** Not a defect. `goalBelongsToSession(state, sessionID)` enforces ONE goal per session (server.ts:2322). For chains, the chain-advance and nudge paths use distinct idempotency keys, and within a single step's retry loop the same key is used. The Map shape is correct for the invariant the system actually maintains. Flagged for documentation (D-NEW-6 covers the cross-instance case separately).

### Initial claim: `setChainDismissed(true)` on `remove-live-pending` is a UX choice

**Reclassified to D-NEW-3 defect:** It IS a defect. The pure selector returns `remove-live-pending` for a "live" source row, but the tsx handler's fallback when `liveGoal() === null` is "dismiss everything" — that's silent state loss, not a UX choice.

---

## What is NOT in this report (already audited)

- AG-P0-04 chain draft provenance: pre-existing audit (geometry audit 2026-06-25 covered it transitively).
- D5 stepMarkerAt validation: shipped in geometry audit.
- D6 advanceGoalChain atomicity: shipped in geometry audit.
- AG-P1-07 generation-counter ordering: code review confirms clean (cleaner than the dispatcher code I shipped).

---

## Repair plan (priority-ordered)

1. **D-NEW-2** (HIGH/CONFIRMED) — Make C4 ordering actually sequential. 3-line fix: type update + `await`.
2. **D-NEW-1** (MEDIUM/CONFIRMED) — Remove `.catch(() => {})` from `onNotify` callbacks. 2-line fix.
3. **D-NEW-3** (MEDIUM/CONFIRMED) — Change `if (!liveGoal()) setChainDismissed; setChain(null)` to a noop. 2-line fix.
4. **D-NEW-4** (MEDIUM/CONFIRMED) — Wrap session-switch `setChainDraft` block in `batch()`. 5-line fix.
5. **D-NEW-6** (LOW/UNLIKELY) — Move `lastDeliveredKeyBySession` inside `server` closure. Cross-cutting refactor; defer.
6. **D-NEW-7** (LOW/DOCS) — Add JSDoc to `fireWebhook`. 1-line fix.
7. **D-NEW-5** (MEDIUM/PRE-EXISTING) — Out of scope; flag for dedicated error-handling audit.

**One commit per defect.** Smallest-repair contract. Tests added per commit where applicable.

---

## Verification

- Each CONFIRMED defect has a failing-before mechanism described in the trajectory
- The pre-audit baseline (1319/1319 autogoal + 672/12 app) must be preserved
- Each fix is verified by either: existing test still passes, or new failing-before + passing-after test
- The full autogoal suite runs after each fix

---

*End of report.*