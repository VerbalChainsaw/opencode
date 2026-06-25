# Repair handoff — Step 8 of 9 (Chain geometry hardening)

**Step:** Chain operator geometry audit + fixes (audit 2026-06-25)
**Commit:** `1a34e23d4 fix(autogoal): harden chain operator geometry — atomicity, validation, message accuracy`
**Date:** 2026-06-25
**Status:** Complete. 5 defects fixed, 1 reclassified (already handled at v0.7.2).

---

## User request

> "Lets thicken the code. I want edge cases, hidden assumptions, state
> mutation bugs, temporal inconsistencies isolated and fixed with robust
> geometry."

## Audit method

center-audit v2.0.0, throughput mode (in-flight maintenance program).
Target: `advanceGoalChain` at `packages/autogoal/src/goal-chain.ts:669-765`
plus its sole production caller at `packages/autogoal/src/server.ts:1240`.

Audit report: `.hermes/audit-reports/chain-operator-geometry-2026-06-25.md`

## Findings — 6 suspected, 5 confirmed, 1 reclassified

| # | Defect | Impact | Status |
|---|--------|--------|--------|
| D1 | `recordMasterUsage` accepts NaN/Infinity in state inputs → JSON null corruption | LOW | ✅ FIXED (defense-in-depth) |
| D2 | Single-step chain at exhausted budget: misleading "completed" message | LOW | ✅ FIXED |
| D5 | `stepMarkerAt` accepts Infinity → JSON null → silent cutoff zero | MEDIUM | ✅ FIXED |
| D6 | `advanceGoalChain` non-atomic: chain/state divergence race | HIGH | ✅ FIXED (atomic wrapper) |
| D9 | Master budget semantics across loops: undocumented | LOW | ✅ FIXED (docstring) |
| D10 | Caller silently swallows advance errors | HIGH | 🔄 RECLASSIFIED (already handled) |

## Defects fixed

### D6 (HIGH, atomicity) — `advanceGoalChainAtomic`

The pre-fix contract: `advanceGoalChain` did two sequential file writes
(chain then state) without holding a lock. A concurrent `session.idle`
arriving between the writes would read the new chain + the OLD state and
re-advance, causing chain/state divergence.

The fix: new exported `advanceGoalChainAtomic(directory, now, opts)` async
wrapper that holds `withStateLock(directory, ...)` for the entire body.
The existing sync `advanceGoalChain` is unchanged (callers that don't
care about atomicity can still use it). `server.ts:1240` switched to the
atomic variant.

### D5 (MEDIUM, validation) — `Number.isFinite` on `stepMarkerAt`

Pre-fix: `typeof opts.stepMarkerAt === "number" && opts.stepMarkerAt > 0`
passes Infinity (the typeof matches; Infinity > 0). JSON.stringify
coerces Infinity to null. On next read the cutoff was zero, reintroducing
the v0.7.x stale-marker bug the field was introduced to fix.

The fix: added `Number.isFinite(rawMarker)` to the guard. Infinity and
NaN both fall back to `now`.

### D2 (LOW, message accuracy) — distinguish budget from completion

Pre-fix: a single-step chain at exhausted budget returned
"All chain steps completed." because the `next >= steps.length` branch
fired before the `masterBudgetExhausted` check. Different user-facing
semantics, wrong message.

The fix: explicit branch in the completion path that checks budget
exhaustion and returns "Chain master budget reached before completing
step N."

### D1 (LOW, input hardening) — `Number.isFinite` on master usage inputs

Pre-fix: `chain.master.turnsUsed += Math.max(0, Math.round(state.turnsEvaluated))`.
With `state.turnsEvaluated = NaN`, `Math.round(NaN) = NaN`,
`Math.max(0, NaN) = NaN`, and `NaN + turnsUsed = NaN`. Same pattern for
state.startedAt.

The fix: `Number.isFinite` guards in `recordMasterUsage`. The validator
at `validateGoalState:230` already rejects NaN/Infinity at read time,
so this is defense-in-depth — `recordMasterUsage` stays safe even if
the validator is loosened in the future.

### D9 (LOW, documentation) — `ChainMasterBudget` docstring

Pre-fix: the interface had no docstring explaining lifetime-vs-per-cycle
semantics. Added JSDoc pinning the behavior (master accumulates across
cycles; only `resetGoalChain` zeros the counters).

## Defect reclassified

### D10 — already handled at v0.7.2

Initially flagged as "caller silently swallows advance errors" based on
a partial read of `server.ts:1241`. The full read at line 1333 shows
the `else` branch already logs and notifies on `ok: false`. The
v0.7.2 commit added this. **Reclassification documented in the audit
report so a future audit doesn't repeat the mistake.**

## Files changed

| File | Change |
|------|--------|
| `packages/autogoal/src/goal-chain.ts` (+~50/-6) | D1, D2, D5, D6, D9 fixes; new `advanceGoalChainAtomic` export |
| `packages/autogoal/src/server.ts` (+~6/-1) | D6 wiring: switched call site to `advanceGoalChainAtomic` |
| `packages/autogoal/test/goal-chain-geometry.test.mjs` (new, 459 lines) | 13 new tests |
| `.hermes/audit-reports/chain-operator-geometry-2026-06-25.md` (new) | Full audit report |

## Test counts

| Suite | Before | After |
|-------|--------|-------|
| `goal-chain-geometry.test.mjs` (new) | n/a | 13/13 pass |
| Full autogoal (`npm test`) | 1291/1291 | 1304/1304 (+13) |
| App suite (`bun test`) | 665 pass, 12 fail | 665 pass, 12 fail (baseline unchanged) |
| Typecheck | clean | clean |

The 12 pre-existing app failures are unchanged (verified by `diff`
against the pre-change baseline).

## Honest disclosures

1. **D6 fix is in-process atomicity only.** `withStateLock` is a
   per-directory promise chain in `goal-state.ts:797`. It serializes
   concurrent calls within the same process. Cross-process concurrency
   (e.g., two plugin instances writing to the same workspace) is NOT
   protected. A future audit could harden this with file locking, but
   it's out of scope here.

2. **D1 input hardening is defense-in-depth.** The validator at
   `goal-state.ts:230` rejects NaN/Infinity, so `recordMasterUsage`
   never actually runs against corrupt state today. The fix preserves
   the invariant if the validator is ever loosened.

3. **D9 is documentation-only.** No behavior change. The fix is the
   JSDoc on `ChainMasterBudget`.

4. **My initial audit identified D10 as a defect; on closer reading,
   it was already handled.** I corrected the audit report and
   documented the reclassification so the next audit doesn't re-flag
   it. The audit method worked correctly: the reading was incomplete,
   not the method.

---

## Next packet

The geometry audit is complete. The remaining items in the 9-step
program:
- **AG-P1-06 part 2** — dispatcher wrapper integration (consumes
  `decideContinuationRetry`; ships the chain-advance + continue-nudge
  through one retry path)
- **AG-P1-07** — ordered chain refresh commits
- **AG-P1-08** — release smoke gate

Each is a real, audit-shaped ticket that deserves its own packet.