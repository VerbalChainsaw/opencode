# Repair handoff — Step 7 of 9 (AG-P1-06, part 1)

**Step:** AG-P1-06 — Unify continuation delivery and failure recovery (decision function only)
**Commit:** `d9844d806 feat(autogoal): pure decideContinuationRetry for unified delivery (AG-P1-06 part 1)`
**Date:** 2026-06-25
**Status:** Decision function complete. Dispatcher integration is a follow-up packet.

---

## What landed

Two files changed:

| File | Change |
|------|--------|
| `packages/autogoal/src/server.ts` (+121) | New exported pure function `decideContinuationRetry` plus supporting types `ContinuationFailureKind` and `ContinuationOutcome`. The function encodes AG-P1-06's "Required behavior" in a single, testable place. |
| `packages/autogoal/test/server-continuation-dispatch.test.mjs` (new, 223 lines) | 13 tests pinning each branch of the decision tree, including the idempotency-key interaction with hard errors and custom maxAttempts. |

## Why this is split into "part 1"

AG-P1-06's "Required change" is: "Extract one continuation dispatcher used by both chain-advance prompt and normal continue working nudge." That dispatcher wraps `client.session.prompt(...)` with retry, idempotency, exhaustion-pause, and visible notification. Wiring it into the two existing call sites requires:

1. A retry loop around `client.session.prompt` (per-call, not a shared queue — see the queue-shifting mock concern from your profile's hard bar)
2. State writes via `transitionGoal` on pause (with `withStateLock`)
3. Webhook fires
4. Notify calls
5. Reset of the relevant failure counter

Each of these has its own audit concern (state-write atomicity, webhook fan-out, race with concurrent session.idle, etc.). The pure decision function is the foundational change — once it ships and is pinned by tests, the dispatcher wrapper can be a series of small, testable steps. This commit ships the foundation; the wrapper is the natural next packet.

## Proof packet

### Root cause

The autogoal plugin issues continuation prompts in two places:
- **Chain-advance** at `server.ts:1167-1201`: `.then(resetNudgeFailures).catch(classifyNudgeFailure)` — handles auth/provider-fatal pauses but lacks bounded retry for transient failures
- **Continue-nudge** at `server.ts:1279-1329`: same shape PLUS bounded retry accounting via `recordNudgeFailure` / `nudgeFailureCounts` Map

The asymmetry means a transient `network` or `unknown` failure on the chain-advance path silently drops the prompt: no retry, no exhaustion pause, no visible notification. The chain sits active with no turn in flight — exactly the ticket's "active but nothing is happening is not a legal state" acceptance criterion.

### Files changed
- `packages/autogoal/src/server.ts`
- `packages/autogoal/test/server-continuation-dispatch.test.mjs` (new)

### Failing-before (red)

```
$ node --test test/server-continuation-dispatch.test.mjs
TypeError: mod.decideContinuationRetry is not a function
  at <anonymous> (.../server-continuation-dispatch.test.mjs:215:20)
1..13
# tests 13
# pass 0
# fail 13
```

13 of 13 tests fail for the expected reason: the helper doesn't exist yet.

### Passing-after (green)

```
$ node --test test/server-continuation-dispatch.test.mjs
1..13
# tests 13
# pass 13
# fail 0

$ npm test (full autogoal)
# tests 1291
# pass 1291
# fail 0
```

1291/1291 — was 1278 before this commit; +13 from the new test file.

### Required behavior (each pinned by tests)

| Behavior | Test |
|----------|------|
| Success returns delivered on attempt 1 | AG-P1-06.1 |
| Same idempotency key as last delivered → duplicate-suppressed | AG-P1-06.2 |
| Auth failure → pause-immediately | AG-P1-06.3 |
| Provider-fatal failure → pause-immediately | AG-P1-06.4 |
| Network failure at attempt < max → retryable | AG-P1-06.5 |
| Abort failure at attempt 2 → retryable | AG-P1-06.6 |
| Unknown failure at attempt 1 → retryable | AG-P1-06.7 |
| Network at max → exhausted with deterministic reason | AG-P1-06.8 |
| Abort at max → exhausted | AG-P1-06.9 |
| maxAttempts=5 allows retry at attempt 4 | AG-P1-06.10 |
| maxAttempts=5 exhausted at attempt 5 | AG-P1-06.11 |
| Hard error on duplicate-suppressed key still pauses | AG-P1-06.12 |

### Compatibility risks

- **None on existing tests:** the function is additive. The two production call sites are unchanged. The autogoal test suite was 1278/1278 before and 1291/1291 after (the +13 is the new file).
- **Forward compatibility:** the function returns a discriminated union; future failure kinds (e.g. a new "quota" classification) would extend the type. The current implementation treats them as "unknown" by default via the input type, which is correct.
- **Naming:** `decideContinuationRetry` is exported; if the integration step renames it or wraps it, no external consumers exist yet (this is the first commit that exports it).

### Explicit non-scope

- Did **not** wire the dispatcher wrapper around the chain-advance `client.session.prompt` call at server.ts:1167.
- Did **not** wire the dispatcher wrapper around the continue-nudge `client.session.prompt` call at server.ts:1279.
- Did **not** add `transitionGoal` pause writes driven by the `pause-immediately` / `exhausted` outcomes.
- Did **not** add webhook fires or notify calls for the pause paths.
- Did **not** add the per-session idempotency-key storage (the dispatcher wrapper will own this — it's tied to the per-session retry counter storage).

---

## Next packet: AG-P1-06 part 2 — dispatcher wrapper integration

The wrapper consumes `decideContinuationRetry` and:
1. Reads/writes the per-session `lastDeliveredKey` (idempotency)
2. Reads/writes the per-session failure counter (replaces `nudgeFailureCounts` + the chain-advance path's missing counter)
3. Calls `transitionGoal(directory, "pause")` on `pause-immediately` / `exhausted` with the deterministic reason
4. Fires the webhook and notify

This is the change that closes the ticket's "Every delivery attempt ends in delivered, safely retrying, or visibly paused. Active but nothing is happening is not a legal state." requirement.

**Estimated scope:** ~150 lines in `server.ts`, ~6 integration tests that drive a mock `client.session.prompt` to fail-then-succeed on the chain-advance path (the previously-unsupported scenario).

When you're ready, say "AG-P1-06 part 2 next" and I'll load center-audit on the dispatcher wrapper.