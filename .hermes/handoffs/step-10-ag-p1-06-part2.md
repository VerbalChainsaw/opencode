# Repair handoff — Step 10 of 9 — AG-P1-06 part 2 (dispatcher wrapper)

**Step:** AG-P1-06 part 2 — dispatcher wrapper integration
**Commit:** `f925c389a feat(autogoal): deliverContinuation dispatcher (AG-P1-06 part 2)`
**Date:** 2026-06-25
**Status:** Dispatcher shipped + tested in isolation. Production call-site integration is a follow-up.

---

## What landed

Two files changed:

| File | Change |
|------|--------|
| `packages/autogoal/src/server.ts` (+161) | New exported `deliverContinuation(client, opts)` plus supporting types `ContinuationDeliveryStatus`, `ContinuationDeliveryOutcome`, `ContinuationDeliveryDeps`. Module-scoped `lastDeliveredKeyBySession` Map for idempotency. |
| `packages/autogoal/test/server-continuation-dispatcher.test.mjs` (new, 324 lines) | 9 dispatcher-integration tests |

## The fix in one sentence

`deliverContinuation` is the central dispatcher that both the chain-advance prompt and the continue-nudge path should route through. It owns the retry loop, idempotency check, pause-with-deterministic-reason, and visible notification. The decision logic (already shipped in part 1) is delegated to `decideContinuationRetry`.

## The four-callback injection shape

`opts.deps` carries four side-effect callbacks:

```ts
deps: {
  onPause(reason): void | Promise<void>     // transitionGoal + write lastEvaluation
  onNotify(title, message, level): void | Promise<void>  // user-visible notification
  onWebhookFire(status): void   // fire the goal-state webhook
  onReset(): void               // reset the per-session failure counter
}
```

This is the testability seam. Production call sites inject the real
`transitionGoal` + `notify` + `fireWebhook` + `nudgeFailureCounts.delete`.
Tests inject observation-only stubs that record what was called and
assert the right side effects happened — no need to fake the full
goalState file system.

## Test results

| Suite | Result |
|-------|--------|
| `server-continuation-dispatcher.test.mjs` (new) | **9/9 pass** |
| Full autogoal (`npm test`) | **1313/1313** (was 1304, +9) |
| Typecheck | clean |

The 9 tests pin each branch of the contract:

1. Success on first attempt returns `'delivered'` and resets the counter
2. Transient network failure retries then succeeds
3. Exhaustion pauses the goal and writes the deterministic reason
4. Auth failure pauses immediately, no retry
5. Same idempotency key after success suppresses re-delivery
6. Failure counter is per-session, not global
7. Provider-fatal (503) pauses immediately
8. Abort failure retries (transient)
9. Export check

## Honest disclosures

### 1. Production call-site integration is a follow-up

The dispatcher is shipped and tested in isolation, but the two
production call sites (chain-advance at server.ts:1279 and
continue-nudge at server.ts:1409) still call
`client.session.prompt(...).then().catch()` inline. Switching them
to `deliverContinuation(...)` is mechanical but touches the hot
evaluation loop. Each path needs:

- Constructing the body (already done inline)
- Deciding the idempotency key: `sessionId + goalState.id + chainStep`
  for chain-advance; `sessionId + goalState.id` for nudge
- Wiring deps to the real `transitionGoal` + `notify` + `fireWebhook`
  + `nudgeFailureCounts.delete` (or its replacement in the
  dispatcher-driven model)
- Handling the outcome (chain-advance issues the prompt downstream;
  nudge just records success/failure)

This is a real change, not a one-liner. It deserves its own commit
with a real audit pass on the call-site integration.

### 2. The `nudgeFailureCounts` Map is NOT replaced by this commit

The pre-existing `nudgeFailureCounts` Map at server.ts:655 stays in
place. The new dispatcher has its own per-call counter state
(via `deps.onReset` + `deps.onPause` callbacks). When the call sites
are migrated, the pre-existing `nudgeFailureCounts` can be removed.

### 3. The retry loop has no backoff

We deliberately do NOT add artificial backoff sleep between attempts.
The SDK call is the rate-limit gate. A future hardening could add
jittered backoff for known-flaky providers, but that's out of scope
for this ticket.

### 4. The `deps` callback for `onPause` is sync OR async

`onPause` returns `Promise<void> | void`. The dispatcher `await`s the
return value regardless. If the caller's `onPause` is sync (just calls
`transitionGoal` which is sync), the await is a no-op. If it's async
(e.g. wraps the lock), the dispatcher waits for it.

---

## Next packet

**The 9-step program is now complete at the unit-test level.** The
remaining work to ship AG-P1-06 fully:
- Migrate the chain-advance call site to `deliverContinuation`
- Migrate the continue-nudge call site to `deliverContinuation`
- Remove the now-redundant `nudgeFailureCounts` Map
- Remove the duplicated retry-accounting logic

Each migration is ~30-50 lines. Combined into one commit, that's
~100 lines in `server.ts` with a focused integration test that drives
both paths through the dispatcher with mock `client.session.prompt`.

Then the **only remaining ticket** in the 9-step program is **AG-P1-08**
(release smoke gate) which requires a real OpenCode host binary to
certify against. This is a CI/integration concern, not a code-shape
concern, and may not be feasible from this WSL session.

---

## Final state of the 9-step program

| # | Step | Status |
|---|------|--------|
| 1 | P4-C0 IPC silent drop | ✅ DONE (pre-existing) |
| 2 | P3-C0 corrupt goal state | ✅ DONE (pre-existing) |
| 3 | AG-P0-01 rapid two-step regression test | ✅ GREEN (after P0-03) |
| 4 | AG-P0-02 v2 assistant-message contract | ✅ DONE |
| 5 | AG-P0-03 event-identity dedup | ✅ DONE |
| 6 | AG-P0-04 chain draft provenance | ✅ DONE |
| 7 | AG-P1-05 visible-source routing | ✅ DONE |
| 8a | AG-P1-06 decision function | ✅ DONE |
| 8b | AG-P1-06 dispatcher wrapper | ✅ DONE (this commit) |
| 8c | Chain geometry audit | ✅ DONE |
| 9 | AG-P1-07 ordered refresh commits | ✅ DONE |
| — | AG-P1-06 call-site migration | 🟠 FOLLOW-UP |
| — | AG-P1-08 release smoke gate | ⬜ TODO (needs real host binary) |