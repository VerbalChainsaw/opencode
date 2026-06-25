/**
 * AG-P1-06 — Unify continuation delivery and failure recovery.
 *
 * The autogoal plugin issues continuation prompts in two places:
 *   (a) chain-advance prompt after a chain step achieves (server.ts:1167-1201)
 *   (b) continue-working nudge when an evaluation returned not-met (server.ts:1279-1329)
 *
 * The pre-fix contract: each path calls `client.session.prompt(...)` with a
 * `.then(resetNudgeFailures).catch(classifyNudgeFailure)`. The two paths
 * SHARE the failure classifier but DIVERGE on retry accounting — the
 * continue-nudge path has bounded retry + exhaustion pause; the chain-advance
 * path does NOT.
 *
 * The ticket requires ONE dispatcher shared by both paths with:
 *   - failure classified once
 *   - per-session/step idempotency key (prevents duplicate prompt delivery)
 *   - auth / provider-fatal → pause immediately
 *   - network / abort / unknown → bounded retry accounting
 *   - exhaustion → pause with deterministic `lastEvaluation.reason`
 *   - user-visible notification on pause
 *   - success → reset only the relevant counter
 *
 * These tests pin the central decision function `decideContinuationRetry`
 * which the dispatcher delegates to. The retry loop itself, the side
 * effects (state writes, webhook, notify), and the per-session counter
 * storage are wired in the tsx caller; the decision function is pure
 * and testable here in isolation.
 *
 * Allowed files per AG-P1-06: `packages/autogoal/src/server.ts` and a
 * narrow delivery/failure test file. This file is the test; the source
 * changes happen in server.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distServerPath = pathToFileURL(join(here, "..", "dist", "server.js")).href;

let decideContinuationRetry;

test("AG-P1-06: server.ts exports decideContinuationRetry as a pure helper", async () => {
  const mod = await import(distServerPath);
  assert.equal(
    typeof mod.decideContinuationRetry,
    "function",
    "decideContinuationRetry must be exported from server.ts so the dispatcher can delegate retry decisions to a testable pure function",
  );
  decideContinuationRetry = mod.decideContinuationRetry;
});

const BASELINE_OPTS = {
  maxAttempts: 3,
  idempotencyKey: "session-1/step-1",
  lastDeliveredKey: null,
};

// ── 1. success path ─────────────────────────────────────────────────────────

test("AG-P1-06.1: success returns 'delivered' on the first attempt", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    failure: null,
    attempt: 1,
  });
  assert.deepEqual(decision, { status: "delivered" });
});

// ── 2. duplicate-suppression via idempotency key ────────────────────────────

test("AG-P1-06.2: same idempotency key as the last delivered delivery is suppressed", () => {
  // The acceptance criterion: "use per-session/step idempotency key to
  // prevent duplicate prompt delivery." A second call with the same key
  // (e.g. retry after partial-failure that actually succeeded) must NOT
  // re-issue the prompt.
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    idempotencyKey: "session-1/step-1",
    lastDeliveredKey: "session-1/step-1",
    failure: null,
    attempt: 1,
  });
  assert.deepEqual(decision, { status: "duplicate-suppressed" });
});

// ── 3. pause-immediately for hard errors ────────────────────────────────────

test("AG-P1-06.3: auth failure pauses immediately, no retry", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    failure: "auth",
    attempt: 1,
  });
  assert.equal(decision.status, "pause-immediately");
  if (decision.status === "pause-immediately") {
    assert.equal(decision.failure, "auth");
    assert.match(decision.reason, /auth/i);
  }
});

test("AG-P1-06.4: provider-fatal failure pauses immediately, no retry", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    failure: "provider-fatal",
    attempt: 1,
  });
  assert.equal(decision.status, "pause-immediately");
  if (decision.status === "pause-immediately") {
    assert.equal(decision.failure, "provider-fatal");
  }
});

// ── 4. retryable failures ───────────────────────────────────────────────────

test("AG-P1-06.5: network failure on attempt 1 is retryable", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    failure: "network",
    attempt: 1,
  });
  assert.equal(decision.status, "retryable");
  if (decision.status === "retryable") {
    assert.equal(decision.failure, "network");
    assert.equal(decision.attempt, 1);
  }
});

test("AG-P1-06.6: abort failure on attempt 2 is retryable", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    failure: "abort",
    attempt: 2,
  });
  assert.equal(decision.status, "retryable");
});

test("AG-P1-06.7: unknown failure on attempt 1 is retryable", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    failure: "unknown",
    attempt: 1,
  });
  assert.equal(decision.status, "retryable");
});

// ── 5. exhaustion → paused with deterministic reason ────────────────────────

test("AG-P1-06.8: network failure at maxAttempts is exhausted (paused)", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    failure: "network",
    attempt: 3,
  });
  assert.equal(decision.status, "exhausted");
  if (decision.status === "exhausted") {
    assert.equal(decision.failure, "network");
    assert.equal(decision.attempts, 3);
    assert.match(decision.reason, /network/i);
    assert.match(decision.reason, /3/); // mentions the attempt count
  }
});

test("AG-P1-06.9: abort failure at maxAttempts is exhausted (paused)", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    failure: "abort",
    attempt: 3,
  });
  assert.equal(decision.status, "exhausted");
});

// ── 6. custom maxAttempts is honored ────────────────────────────────────────

test("AG-P1-06.10: maxAttempts=5 still allows retry on attempt 4", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    maxAttempts: 5,
    failure: "network",
    attempt: 4,
  });
  assert.equal(decision.status, "retryable");
});

test("AG-P1-06.11: maxAttempts=5 exhausted at attempt 5", () => {
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    maxAttempts: 5,
    failure: "network",
    attempt: 5,
  });
  assert.equal(decision.status, "exhausted");
  if (decision.status === "exhausted") {
    assert.equal(decision.attempts, 5);
  }
});

// ── 7. duplicate suppression does NOT pre-empt hard errors ──────────────────

test("AG-P1-06.12: hard error on a duplicate-suppressed key still pauses", () => {
  // If the prior delivery succeeded but a SECOND call arrives with the
  // same key and fails with auth, the idempotency check fires first and
  // the auth pause is moot. But the dispatcher order matters: the
  // acceptance criterion is "auth pauses immediately". The pure function
  // here encodes the decision rules in a single place; the dispatcher
  // is responsible for the order of checks.
  //
  // Per the spec the decision function focuses on the retry decision.
  // Idempotency is enforced BEFORE the call by the dispatcher wrapper
  // (a key match → don't even call client.session.prompt). If the
  // dispatcher did call, this decision function would see the failure.
  // The test pins that the decision function itself does NOT silently
  // produce duplicate-suppressed for a non-null failure.
  const decision = decideContinuationRetry({
    ...BASELINE_OPTS,
    failure: "auth",
    attempt: 1,
    idempotencyKey: "session-1/step-1",
    lastDeliveredKey: "session-1/step-1",
  });
  assert.equal(decision.status, "pause-immediately");
});