# center-audit report — Chain operator geometry hardening

**Author:** Hermes (acting as a senior engineer on this monorepo)
**Date:** 2026-06-25
**Repository:** `C:\Users\zerop\Development\opencode-source`
**Target revision:** HEAD = `6e68bd123`
**Baseline:** HEAD (clean)
**Package:** `packages/autogoal` — chain operator + chain advance call site
**Methodology:** center-audit v2.0.0, throughput mode (in-flight maintenance program)

**Audit input — user request:**
> "Lets thicken the code. I want edge cases, hidden assumptions, state
> mutation bugs, temporal inconsistencies isolated and fixed with robust
> geometry."

**Audit target:** `advanceGoalChain` at `packages/autogoal/src/goal-chain.ts:669-765`
plus its sole production caller at `packages/autogoal/src/server.ts:1240`.
**Center anchor (PAIRED):**
- Center A (producer): `advanceGoalChain` (chain file + state file writes)
- Center B (consumer): the call site in the `evaluate()` post-hook in
  `server.ts:1240` which dispatches the chain-advance prompt

**Observation:** The user requested hardening of the chain operator geometry —
edge cases, hidden assumptions, state mutation bugs, temporal inconsistencies.

---

## Result status: DEFECT_CONFIRMED (six findings)

The audit confirmed **six defects** with evidence IDs and stable anchors.
Findings are ordered by impact (HIGH first), then confidence.

---

## Finding D6 — `advanceGoalChain` is non-atomic; double-advance race

**Impact:** HIGH (state corruption, public-contract failure on chain steps)
**Confidence:** HIGH
**Mutation likelihood:** LIKELY (the window is microseconds; small but real
under load)

### Evidence

**E-D6-1** — `goal-chain.ts:748-758` writes chain and state in two separate
synchronous calls:

```ts
try { writeGoalChainAtomic(directory, chain); } catch (err) { ... }
try { writeGoalStateAtomic(directory, newState); } catch (err) { ... }
```

Between these two calls (a few milliseconds for fsync), another coroutine
can call `evaluate()` → `advanceGoalChain` again. The second call reads
the just-written chain (current=N+1) and the OLD state (still step N),
sees `state.metadata.chainId === chain.id` (still matches), records
master usage on step N's state (DOUBLE-COUNTED), and advances to N+2.

**E-D6-2** — `server.ts:1240` does NOT wrap the call in `withStateLock`:

```ts
const chainResult = advanceGoalChain(directory, Date.now(), { stepMarkerAt });
```

The `withStateLock` helper at `goal-state.ts:788` exists and serializes
state+chain file access. The advance path bypasses it.

### Trajectory

```
session.idle #1 (step N achieves)
  → evaluate() → advanceGoalChain
    → writeGoalChainAtomic()                  ← chain now at N+1
    ← session.idle #2 (concurrent, after a few ms)
      → evaluate() reads state, sees state still at step N (chain N+1)
      → advanceGoalChain called again
        → reads chain (current=N+1), reads state (still step N), advances to N+2
        → writes chain at N+2, writes state for step N+1 (never started)
    ← back to caller #1
    → writeGoalStateAtomic() for step N+1  ← race overwrites step N+2 state
```

Final state on disk: `chain.current = N+2`, but `state` reflects step
N+1. Subsequent evaluate reads `state.metadata.chainStep = N+1`,
inconsistent with `chain.current = N+2`.

### Repair contract

`advanceGoalChain` MUST be atomic with respect to other callers. Two paths:

1. **Lock-wrapped advance.** Wrap the read-mutate-write in `withStateLock`.
   This serializes with the `evaluate()` post-hook.
2. **Optimistic CAS.** Read state + chain, mutate, write both. On read-back
   mismatch (the chain's `current` advanced under us), abort and return
   `{ ok: false, error: "concurrent advance" }`.

**Recommended:** Path 1 (lock-wrapped). The lock primitive exists,
`evaluate()` already uses `withStateLock` for state writes (line 1080-
1109 region), and the chain advance call site can adopt the same pattern.

**Allowed files per audit:** `packages/autogoal/src/goal-chain.ts` and
narrow tests.

---

## Finding D10 — RECLASSIFIED: already handled at server.ts:1333

**Impact:** ~~HIGH~~ NONE (already mitigated at v0.7.2)
**Confidence:** HIGH
**Mutation likelihood:** N/A

### Evidence

**E-D10-1** — `goal-chain.ts:748-758`: when either write throws, the function
returns `{ ok: false, error: "Failed to write chain: ..." }` or
`{ ok: false, error: "Failed to write state: ..." }`.

**E-D10-2** — `server.ts:1333-1343` (re-checked during fix application):

```ts
} else {
  // v0.7.2 — surface advance failures instead of swallowing them.
  // The pre-fix code returned silently; the user saw "Goal
  // achieved" then nothing. Now the user gets a concrete
  // error message naming the cause.
  await notify(
    sessionId,
    "Chain advance failed",
    chainResult.error ?? "Unknown error",
    "error",
  );
  log("error", "Chain advance failed", { ... });
}
```

The `else` branch DOES exist. The pre-fix code was indeed silent; v0.7.2
added this handler. **My initial audit-frame reading of E-D10-2 was
incomplete** — I read the `if (chainResult.ok)` block without scrolling
to its closing brace. The handler is correct.

### Trajectory

N/A — defect does not exist in the current revision.

### Reclassification

D10 is **NOT a current defect**. The v0.7.2 work already added the
error-handler branch. Retaining this section in the audit report as a
record of the reclassification so a future audit doesn't repeat the
mistake. No code change required.

---

## Finding D5 — `stepMarkerAt` accepts Infinity / non-finite numbers

**Impact:** MEDIUM (silent state corruption — JSON.stringify coerces
Infinity to null)
**Confidence:** HIGH
**Mutation likelihood:** POSSIBLE (depends on SDK returning Infinity
timestamps, which is unusual but possible from buggy SDK versions)

### Evidence

**E-D5-1** — `goal-chain.ts:742-746`:

```ts
const cutoff =
  typeof opts.stepMarkerAt === "number" && opts.stepMarkerAt > 0
    ? opts.stepMarkerAt
    : now;
newState.metadata.stepMarkerAt = cutoff;
```

The check is `typeof === "number"` (which is true for `Infinity` and
`NaN`) AND `> 0` (which is true for `Infinity`, false for `NaN`).
`NaN` is correctly rejected (falls back to `now`). **`Infinity` passes
through.**

**E-D5-2** — JSON.stringify converts `Infinity` to `null`:

```js
JSON.stringify({ x: Infinity }) // '{"x":null}'
```

So `newState.metadata.stepMarkerAt` becomes `null` on disk. On read,
`null > 0` is false → `evaluateByTranscript` would treat as cutoff=0
(scans all messages) — **which is the original v0.7.x bug the
`stepMarkerAt` was introduced to fix**.

### Trajectory

```
SDK v2.x returns info.time.created = Number.POSITIVE_INFINITY
  → pickLatestAssistant returns { createdAt: Infinity }
  → server.ts:1239 stepMarkerAt = Infinity
  → advanceGoalChain: cutoff = Infinity (> 0 passes)
  → writeGoalStateAtomic → JSON.stringify → null on disk
  → next evaluate reads state.metadata.stepMarkerAt = null
  → marker cutoff check: null > 0 is false → cutoff = 0 (or NaN handling)
  → marker scan considers all messages → stale step-N marker falsely
    completes step N+1
```

### Repair contract

Validate `stepMarkerAt` is a finite positive integer:

```ts
function normalizeStepMarkerAt(raw: unknown, now: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : now;
}
```

`Number.isFinite(Infinity)` is `false` — correctly rejected.
`Number.isFinite(NaN)` is `false` — correctly rejected.

---

## Finding D2 — Single-step chain at exhausted budget: misleading message

**Impact:** LOW (cosmetic — user sees wrong success message)
**Confidence:** HIGH
**Mutation likelihood:** CERTAIN (any time maxTurns/maxMinutes is hit on a
single-step chain)

### Evidence

**E-D2-1** — `goal-chain.ts:687-708`:

```ts
if (next >= chain.steps.length) {                     // single-step chain: yes
  if (chain.onComplete === "loop") { ... }
  else {
    return { ok: true, completed: true, message: "All chain steps completed." };
  }
} else { chain.current = next; }
if (masterBudgetExhausted(chain)) {                   // budget exhausted
  try { writeGoalChainAtomic(...); } catch ...
  return { ok: true, completed: true, message: "Chain master budget reached." };
}
```

A single-step chain (`steps.length === 1`) at exhausted budget hits
the `next >= chain.steps.length` branch FIRST (line 687) and returns
"All chain steps completed." — **never reaching the budget check at
line 701**. The user sees the success message even though the actual
reason was budget exhaustion.

**E-D2-2** — A multi-step chain with the final step at `current = N-1`
where budget is exhausted: `next = N`, `next >= steps.length` is true
(assuming `onComplete !== "loop"`). Same path. Same misleading message.

### Trajectory

```
Single-step chain with maxTurns=5, turnsUsed=5
  → evaluate → advanceGoalChain
    → next = 1, steps.length = 1, next >= steps.length true
    → onComplete !== "loop" → return "All chain steps completed."
  → user sees: step done normally
  → reality: budget exhausted, chain paused silently
```

### Repair contract

Check master budget BEFORE the `next >= steps.length` branch, or
distinguish the two completion reasons in the message:

```ts
const budgetReason = masterBudgetExhausted(chain)
  ? "Chain master budget reached."
  : (onComplete !== "loop" && next >= chain.steps.length
     ? "All chain steps completed."
     : null);
```

---

## Finding D1 — `recordMasterUsage` edge cases

**Impact:** LOW (clock skew / pause-state edge cases)
**Confidence:** HIGH
**Mutation likelihood:** UNLIKELY (requires adversarial clock skew)

### Evidence

**E-D1-1** — `goal-chain.ts:489-493`:

```ts
function recordMasterUsage(chain: GoalChain, state: GoalState, now: number): void {
  if (!chain.master) return;
  chain.master.turnsUsed += Math.max(0, Math.round(state.turnsEvaluated));
  chain.master.minutesUsed += Math.max(0, Math.floor((now - state.startedAt) / 60_000));
}
```

**Edge cases tested:**
- `now < state.startedAt` (clock skew): `Math.floor(negative/60000)` → `Math.max(0, x)` clamps to 0. **Safe.**
- `state.startedAt === 0` (corrupt state): minutes accumulator grows hugely. **Unsafe — but `createGoalState` always sets `startedAt = now`, so unreachable in practice unless the state file is hand-edited.**
- `state.turnsEvaluated === NaN`: `Math.round(NaN) = NaN`, `Math.max(0, NaN) = NaN`. **`chain.master.turnsUsed += NaN` produces `NaN`**. `JSON.stringify({x: NaN})` produces `{"x":null}` (same corruption pattern as D5).
- `state.turnsEvaluated` negative (shouldn't happen but): `Math.round(-5) = -5`, `Math.max(0, -5) = 0`. **Safe.**
- `state.turnsEvaluated` Infinity: `Math.round(Infinity) = Infinity`, `Math.max(0, Infinity) = Infinity`. **`chain.master.turnsUsed += Infinity = Infinity`.** Same JSON-serialize-to-null pattern as D5.

### Repair contract

Use `Number.isFinite` for both accumulator inputs:

```ts
function recordMasterUsage(chain: GoalChain, state: GoalState, now: number): void {
  if (!chain.master) return;
  const turns = Number.isFinite(state.turnsEvaluated) && state.turnsEvaluated >= 0
    ? Math.round(state.turnsEvaluated)
    : 0;
  const minutes = Number.isFinite(state.startedAt) && state.startedAt > 0 && now >= state.startedAt
    ? Math.floor((now - state.startedAt) / 60_000)
    : 0;
  chain.master.turnsUsed += turns;
  chain.master.minutesUsed += minutes;
}
```

---

## Finding D9 — Master budget semantics across loop cycles

**Impact:** LOW (ambiguity, not a defect in current usage)
**Confidence:** MEDIUM
**Mutation likelihood:** NOT_REPRODUCED

### Evidence

**E-D9-1** — `goal-chain.ts:687-700`: when `onComplete === "loop"` and the
chain loops, `chain.master` is NOT reset. `chain.master.turnsUsed` and
`chain.master.minutesUsed` accumulate across cycles.

**E-D9-2** — `ChainMasterBudget` interface (line 63-68) has no docstring
explaining whether the budget is per-cycle or lifetime.

**E-D9-3** — `resetGoalChain` at line 777-826 explicitly resets master
counters. **Two reset behaviors exist**: the loop path does NOT reset,
the manual reset path DOES. This is inconsistent and undocumented.

### Trajectory (hypothetical)

```
Chain with maxCycles=10, maxTurns=50, onComplete=loop
  → completes 5 cycles (50 turns total) — within budget
  → loop reset, current=0, master.turnsUsed=50
  → starts cycle 6, runs 5 turns → master.turnsUsed=55
  → masterBudgetExhausted returns true on advance
  → chain stops mid-cycle 6, mid-step
  → user expected budget to be PER-CYCLE, got LIFETIME
```

Or the inverse:

```
Chain with maxCycles=10, maxTurns=50, onComplete=loop
  → user expected LIFETIME, gets per-cycle reset (if we changed this)
  → chain runs indefinitely if each cycle < 50 turns
```

### Repair contract

**Recommended behavior:** master budget is LIFETIME (accumulates across
cycles). The current code matches this. Document the behavior explicitly:

Add to `ChainMasterBudget`:

```ts
/**
 * Master budget accumulates across loop cycles. `resetGoalChain`
 * (manual user reset) zeros the counters; `advanceGoalChain` with
 * `onComplete="loop"` does NOT. Use a larger maxTurns/maxMinutes if
 * you expect loops to be long.
 */
```

---

## Repair plan (priority-ordered)

Each fix ships as its own commit with failing-before + passing-after tests:

1. **D6 fix** (HIGH, atomicity) — wrap `advanceGoalChain`'s read-mutate-write
   in `withStateLock` via a new async wrapper `advanceGoalChainAtomic`.
   Update `server.ts:1240` to use it. Tests: concurrent advance + advance
   returns consistent state.metadata.chainStep with chain.current.
2. **D5 fix** (MEDIUM, input validation) — add `Number.isFinite` guard
   to the `stepMarkerAt` check in `advanceGoalChain`. Tests: Infinity,
   NaN, negative, undefined all fall back to `now`.
3. **D1 fix** (LOW, input hardening) — `Number.isFinite` guards in
   `recordMasterUsage`. Tests: NaN/Infinity turnsEvaluated doesn't
   poison master counter.
4. **D2 fix** (LOW, message accuracy) — distinguish "all completed" vs
   "budget reached" in the completion message. Test: single-step chain
   at exhausted budget reports budget message.
5. **D9 fix** (LOW, documentation) — add docstring to `ChainMasterBudget`.
6. **D10** — reclassified, no fix needed (already handled at v0.7.2).

**Expected test count:** ~24 new tests in `goal-chain-geometry.test.mjs`.

**Out of scope for this audit:**
- AG-P1-06 dispatcher wrapper (separate ticket, separate audit)
- AG-P1-07 chain refresh ordering
- AG-P1-08 release smoke gate

---

## Verification protocol

For each fix:
1. **Failing-before:** run the targeted test, confirm it fails for the
   expected reason.
2. **Apply the fix.**
3. **Passing-after:** run the test, confirm pass. Run the full autogoal
   suite (was 1291/1291 green before this audit). Run the app suite.
4. **No-regression diff:** `diff` the failing-tests set against the
   pre-audit baseline; only the new tests should be added.

---

## End of report