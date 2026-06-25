# Repair handoff — Step 9 of 9 (AG-P1-07)

**Step:** AG-P1-07 — Make chain refresh commits ordered
**Commit:** `2bdbcd0ec fix(app): ordered chain refresh commits via generation-counter discard (AG-P1-07)`
**Date:** 2026-06-25
**Status:** Complete. Polling can no longer resurrect older chain state through out-of-order network completion.

---

## User request

> "Keep going."

(Continuing the 9-step program from where AG-P1-06 part 1 left off.)

## What landed

Four files changed:

| File | Change |
|------|--------|
| `packages/app/src/pages/session/goal-panel-pure.ts` (+75) | New pure helper `createOrderedChainRefresh<T>(readFn, onCommit)` plus the `OrderedChainRefresh` interface. Generation-counter discard pattern. |
| `packages/app/src/pages/session/goal-panel.tsx` (+28/-5) | Both the polling tick and `refreshChain()` route through the SAME `createOrderedChainRefresh` guard. `refreshChain()` now returns `Promise<void>`. `refreshGoalSurfaces()` awaits it. `onCleanup` disposes the guard. |
| `packages/app/src/pages/session/goal-panel-pure.test.ts` (+241) | 7 new tests pinning the ordering guard behavior |
| `packages/app/src/pages/session/goal-panel.test.ts` (+~6/-2) | Updated the mission-control contract test to assert the NEW `refreshChain()` shape |

## The fix in one sentence

`createOrderedChainRefresh` increments a counter on every `request()` and only commits the result if its captured generation still matches the current generation when the Promise resolves — so an out-of-order network completion is discarded instead of overwriting newer state.

## Acceptance criterion check

> "Polling can no longer resurrect older chain state through out-of-order network completion."

Pinned by test #1 in `goal-panel-pure.test.ts`:
```
test("1. resolves request 2 first, then request 1's late completion is ignored")
```
Mock `readFn` where request 1 takes 50ms and request 2 takes 10ms. Pre-fix:
request 2 commits at 10ms, request 1 commits at 50ms — overwriting newer
state. Post-fix: request 1's result is discarded because the counter
already advanced past its generation.

## Files & required behavior

| Required behavior | Where it lives |
|---|---|
| Each read receives a monotonic generation OR abort signal | `createOrderedChainRefresh` generation counter |
| Only the latest generation commits to `setChain` | `if (myGeneration !== current) return` discard in the `.then` handler |
| `refreshChain()` returns a promise | `const refreshChain = (): Promise<void> => chainRefresh.request()` |
| `refreshGoalSurfaces()` awaits the requested chain refresh | `await refreshChain()` |
| Interval and command-triggered refreshes share the same ordering guard | Both paths route through the single `chainRefresh` instance |
| Component cleanup prevents late commits | `onCleanup(() => chainRefresh.dispose())` |

## Test counts

| Suite | Before | After |
|-------|--------|-------|
| `goal-panel-pure.test.ts` (pure module) | 14/14 | **21/21** (+7) |
| Full app (`bun test`) | 665 pass, 12 fail (baseline) | 672 pass, 12 fail — **identical baseline** (verified by diff) |
| Autogoal (`npm test`) | 1304/1304 | 1304/1304 (unchanged) |
| Typecheck | clean | clean |

## Honest disclosures

1. **The mission-control contract test was updated, not added.** The existing
   test "command controls contain refresh failures after command execution"
   pinned the OLD `() => void readChain(sdk).then(setChain).catch(...)`
   shape. I updated it to assert the new shape: `Promise<void>` return,
   `createOrderedChainRefresh` is the backing primitive, the old
   shape is gone. This is a contract change, not a test addition.

2. **One transient failure during fix development.** A second pass at
   `expect(...).toBe(value, msg)` (bun allows 2 args, TS doesn't) caused
   a typecheck error on the first commit attempt. Fixed by dropping the
   custom message in favor of bun's built-in assertion error.

3. **The fix is in-process only.** Two plugin instances writing to the
   same workspace would NOT be serialized by `createOrderedChainRefresh`.
   That's the same in-process scope as `withStateLock` from the AG-P0-03
   work. Cross-process concurrency is a separate concern.

---

## Next packet

The 9-step program is now complete:

| # | Step | Status |
|---|------|--------|
| 1 | P4-C0 IPC silent drop | ✅ DONE (pre-existing) |
| 2 | P3-C0 corrupt goal state | ✅ DONE (pre-existing) |
| 3 | AG-P0-01 rapid two-step regression test | ✅ GREEN (after P0-03) |
| 4 | AG-P0-02 v2 assistant-message contract | ✅ DONE |
| 5 | AG-P0-03 event-identity dedup | ✅ DONE |
| 6 | AG-P0-04 chain draft provenance | ✅ DONE |
| 7 | AG-P1-05 visible-source routing | ✅ DONE |
| 8 | AG-P1-06 part 1 decision function | ✅ DONE (part 2 = dispatcher wrapper is follow-up) |
| 8b | Chain geometry audit | ✅ DONE |
| 9 | AG-P1-07 ordered refresh commits | ✅ DONE |
| — | AG-P1-06 part 2 dispatcher wrapper | 🟠 FOLLOW-UP |
| — | AG-P1-08 release smoke gate | ⬜ TODO |

**AG-P1-08** (release smoke gate) is the final ticket. It requires a
canonical monorepo with lockfile + exact supported OpenCode SDK/runtime
to certify the package against the real host contract rather than only
source-level mocks. This is a CI/integration concern, not a code-shape
concern, and may not be feasible from this WSL session — likely best
done from the Windows side with the actual installed OpenCode binary.