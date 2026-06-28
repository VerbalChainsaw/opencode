# Orchestration knowns closeout (2026-06-28)

Closing every open "known" from the SunoSavvy incident chain. 4-angle
adversarial workflow (wf_a6e7737b-ab8, 6 agents, all completed).

## Verdict matrix

| Known | Status | Adversarial | Outcome |
|-------|--------|-------------|---------|
| **B** — Stop "overrode me and sent commands to the chain" | MISIDENTIFIED (HIGH) | — | **No fix.** Stop is provably correct: `transitionGoal("clear")` only flips status + archives (no chain-advance); an in-flight continuation is suppressed + aborted by `activeGoalStillCurrent` (re-reads disk, false once cleared) and the app-side `promptAdmissionEpoch`; `session.idle` hard-returns unless `status==="active"`, so a cleared goal can't re-arm; abort runs before+after the clear and surfaces failures. The runaway came from **claim**, already fixed in v1.17.9/v1.17.10. |
| **C** — claimed handoff keeps origin sessionId | CONFIRMED (HIGH) | **REAL, fix-safe** | **FIXED.** `claimHandoff` carried the ORIGIN `metadata.sessionId` forward via `sanitizeMetadata`; the claim flow opens a fresh session, so `goalStateForSession`/`goalBelongsToSession` scoped the goal to the origin id — the claimer could neither see nor drive it (orphaned zombie goal, the inverse failure of the runaway). |
| **A** — v1.17.10 i18n regression | PARTIAL (HIGH) | **REAL, fix-safe** | **FIXED.** The 5 new `session.goal.handoff.*` keys were added to en.ts but not zh.ts/zht.ts, so `parity.test.ts` failed. (The v1.17.10 commit's "196/196" claim was from running only goal-panel tests, not the full app suite — the skeptic caught the gap.) |
| **D** — stop/pause/claim/abort/chain sweep | STALE (MEDIUM) | — | **No defect.** One benign note: `lastDeliveredKeyBySession` is never pruned, but it can never false-suppress because every idempotency key embeds the goal's `randomUUID` id — an invariant already pinned by `dials.test.mjs:420/430` (`notEqual(newId, oldId)`). |

## Fixes

### C — rebind claimed handoff to the claimer (goal-state.ts, server.ts)
`claimHandoff(directory, now, sessionID?)`: after rebuilding metadata, set
`metadata.sessionId` to the sanitized claimer id (matching `createGoalState`'s
contract), or delete it when no session is supplied (CLI/headless → unbound,
driveable by first idle). `goal_claim` passes `ctx.sessionID`. Handoffs stay
intentionally cross-session — only the post-claim ownership binding changed.
Tests (dials.test.mjs): rebind-to-claimer and unbound-when-headless.

### A — zh/zht handoff translations (zh.ts, zht.ts)
Added genuine Simplified + Traditional Chinese for `handoff.age`,
`.fromSession`, `.resumesChain`, `.staleWarn`, `.claimConfirm`, preserving the
`{{age}}`/`{{session}}`/`{{total}}` placeholders.

## Verification
- autogoal: 1423/1426 (only the 3 unrunnable `assert-autogoal-repo.sh` shell
  tests), incl. dials 77/77 with the 2 new rebind tests; typecheck + build clean.
- app: **771/771** full suite (84 files), incl. i18n parity 3/3 (was 2/1 fail);
  typecheck clean.
- desktop: tsgo clean (unchanged).
