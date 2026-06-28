/**
 * AG-P1-06 part 2 — dispatcher wrapper integration tests.
 *
 * The decision function `decideContinuationRetry` was shipped in part 1.
 * This file pins the WRAPPER behavior: the dispatcher takes the prompt
 * payload + a mock client and orchestrates the retry loop, idempotency,
 * pause-on-exhaust, and visible notification.
 *
 * Required behavior (from ticket AG-P1-06):
 *   - classify failure once
 *   - per-session/step idempotency key (prevent duplicate prompt delivery)
 *   - auth / provider-fatal → pause immediately
 *   - network / abort / unknown → bounded retry accounting
 *   - exhaustion → pause + deterministic `lastEvaluation.reason` + visible notify
 *   - success → reset only the relevant counter
 *
 * The wrapper is tested by importing it from the compiled `dist/server.js`
 * and driving a mock client that fails-then-succeeds on the chain-advance
 * path (the previously-unsupported scenario). Per-ticket-failure tests
 * pin each branch of the contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distServerPath = pathToFileURL(join(here, "..", "dist", "server.js")).href;

let deliverContinuation;

test("AG-P1-06.2: server.ts exports deliverContinuation", async () => {
  const mod = await import(distServerPath);
  assert.equal(
    typeof mod.deliverContinuation,
    "function",
    "deliverContinuation must be exported from server.ts so tests can drive it directly",
  );
  deliverContinuation = mod.deliverContinuation;
});

/**
 * Build a minimal mock client + deps. The wrapper accepts a generic
 * `send` function so we can drive any failure pattern. The wrapper also
 * accepts callbacks (onPause, onNotify, onWebhookFire) so we can
 * observe side effects without mocking the full goalState file system.
 */
function makeHarness(opts) {
  const {
    prompt,
    onPause,
    onNotify,
    onWebhookFire,
    onReset,
    onRecord,
  } = opts;
  const client = {
    session: { prompt },
  };
  return {
    client,
    callbacks: { onPause, onNotify, onWebhookFire, onReset, onRecord },
  };
}

// ── 1. Success on first attempt ────────────────────────────────────────────

test("AG-P1-06.2.1: success on first attempt returns 'delivered' and resets counter", async () => {
  const { client, callbacks } = makeHarness({
    prompt: async () => ({ data: { id: "prompt-ok" } }),
    onReset: () => {},
  });
  let resetCalled = 0;
  callbacks.onReset = () => resetCalled++;

  const result = await deliverContinuation(client, {
    sessionId: "s-1",
    idempotencyKey: "session-1/step-1",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: { onReset: callbacks.onReset, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });

  assert.equal(result.status, "delivered");
  assert.equal(resetCalled, 1);
});

// ── 2. Transient failure → retry succeeds ─────────────────────────────────

test("AG-P1-06.2.2: transient network failure retries then succeeds", async () => {
  let attempts = 0;
  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      if (attempts === 1) {
        // Network blip on first attempt
        throw Object.assign(new Error("fetch failed ECONNRESET"), { code: "ECONNRESET" });
      }
      return { data: { id: "prompt-ok-after-retry" } };
    },
  });

  const result = await deliverContinuation(client, {
    sessionId: "s-2",
    idempotencyKey: "session-2/step-1",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });

  assert.equal(result.status, "delivered");
  assert.equal(attempts, 2, "should have retried once before succeeding");
});

// ── 3. Exhaustion → paused + reason + notify ──────────────────────────────

test("AG-P1-06.2.3: exhaustion pauses the goal and writes deterministic reason", async () => {
  const { client, callbacks } = makeHarness({
    prompt: async () => {
      // All 3 attempts fail with network errors
      throw Object.assign(new Error("fetch failed ETIMEDOUT"), { code: "ETIMEDOUT" });
    },
    onPause: (reason) => {},
    onNotify: (title, message, level) => {},
    onWebhookFire: (status) => {},
  });

  let pauseReason = null;
  let notifyTitle = null;
  let notifyLevel = null;
  let webhookStatus = null;
  callbacks.onPause = (reason) => { pauseReason = reason; };
  callbacks.onNotify = (title, _msg, level) => {
    notifyTitle = title;
    notifyLevel = level;
  };
  callbacks.onWebhookFire = (status) => { webhookStatus = status; };

  const result = await deliverContinuation(client, {
    sessionId: "s-3",
    idempotencyKey: "session-3/step-1",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: {
      onPause: callbacks.onPause,
      onNotify: callbacks.onNotify,
      onWebhookFire: callbacks.onWebhookFire,
      onReset: () => {},
    },
  });

  assert.equal(result.status, "paused");
  // AG-P1-06 part 3 — the exhaustion reason now matches the legacy
  // shape that the server-error diagnostic tests pin:
  //   "Nudge delivery failed N times consecutively in session X
  //    (kind: detail)"
  // The kind and detail are threaded through from
  // `classifyNudgeFailure`. The dispatcher unit test doesn't assert
  // exact equality because the detail string is the mock's error
  // message verbatim; we match on the structural pieces.
  assert.match(result.reason ?? "", /Nudge delivery failed 3 times consecutively/);
  assert.match(result.reason ?? "", /network/);
  assert.match(result.reason ?? "", /s-3/);
  assert.match(pauseReason ?? "", /network/i);
  assert.match(pauseReason ?? "", /3/);
  assert.equal(notifyTitle, "Goal paused — continuation delivery failed");
  assert.equal(notifyLevel, "warning");
  assert.equal(webhookStatus, "paused");
});

// ── 4. Hard error → immediate pause, no retry ─────────────────────────────

test("AG-P1-06.2.4: auth failure pauses immediately, no retry", async () => {
  let attempts = 0;
  const { client, callbacks } = makeHarness({
    prompt: async () => {
      attempts++;
      throw Object.assign(new Error("ProviderAuthError: 401 unauthorized"), {
        code: "UNAUTHORIZED",
      });
    },
    onPause: (reason) => {},
    onNotify: () => {},
    onWebhookFire: () => {},
  });

  let pauseReason = null;
  callbacks.onPause = (reason) => { pauseReason = reason; };

  const result = await deliverContinuation(client, {
    sessionId: "s-4",
    idempotencyKey: "session-4/step-1",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: {
      onPause: callbacks.onPause,
      onNotify: callbacks.onNotify,
      onWebhookFire: callbacks.onWebhookFire,
      onReset: () => {},
    },
  });

  assert.equal(result.status, "paused");
  assert.equal(attempts, 1, "should not retry on hard error");
  assert.match(pauseReason ?? "", /auth/i);
});

// ── 5. Idempotency: same key after success → no second prompt ──────────────

test("AG-P1-06.2.5: same idempotency key after success suppresses re-delivery", async () => {
  let attempts = 0;
  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      return { data: { id: `prompt-${attempts}` } };
    },
  });

  const opts = {
    sessionId: "s-5",
    idempotencyKey: "session-5/step-1",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  };

  const r1 = await deliverContinuation(client, opts);
  const r2 = await deliverContinuation(client, opts);

  assert.equal(r1.status, "delivered");
  assert.equal(r2.status, "duplicate-suppressed");
  assert.equal(attempts, 1, "second call must NOT re-issue the prompt");
});

test("D-NEW-6.1: idempotency is per-session (different sessionId, same key = delivered)", async () => {
  // D-NEW-6 cross-session isolation: the Map is keyed by sessionId,
  // so a fresh sessionId with the same idempotencyKey is treated
  // as a brand-new delivery, not a duplicate. This is the contract
  // that the multi-instance safety comment in server.ts relies on:
  // per-session state is independent.
  let attempts = 0;
  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      return { data: { id: `prompt-${attempts}` } };
    },
  });

  // First delivery under session A.
  const r1 = await deliverContinuation(client, {
    sessionId: "session-A",
    idempotencyKey: "shared-key",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });
  assert.equal(r1.status, "delivered");

  // Same idempotencyKey under a DIFFERENT sessionId is a fresh
  // delivery (the dispatcher doesn't know that some other session
  // already delivered this key).
  const r2 = await deliverContinuation(client, {
    sessionId: "session-B",
    idempotencyKey: "shared-key",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });
  assert.equal(r2.status, "delivered");
  assert.equal(attempts, 2, "two distinct sessions each get their own delivery");

  // Same sessionId + same key again is the duplicate-suppressed
  // path (test 2.5). Confirm cross-session was the distinguishing
  // factor, not the key itself.
  const r3 = await deliverContinuation(client, {
    sessionId: "session-B",
    idempotencyKey: "shared-key",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });
  assert.equal(r3.status, "duplicate-suppressed");
  assert.equal(attempts, 2);
});

// ── 6. Per-session counter isolation ───────────────────────────────────────

test("AG-P1-06.2.6: failure counter is per-session, not global", async () => {
  let attempts = 0;
  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      // All attempts fail with network errors
      throw Object.assign(new Error("fetch failed"), { code: "ETIMEDOUT" });
    },
  });

  // Session A: 3 failures → paused
  const rA = await deliverContinuation(client, {
    sessionId: "session-A",
    idempotencyKey: "session-A/step-1",
    body: { parts: [{ type: "text", text: "A" }] },
    maxAttempts: 3,
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });

  // Session B: should start fresh with counter=0, still paused at 3
  // but the failure reason mentions only 1 failure (B's first attempt
  // is the only one in B's counter).
  const rB = await deliverContinuation(client, {
    sessionId: "session-B",
    idempotencyKey: "session-B/step-1",
    body: { parts: [{ type: "text", text: "B" }] },
    maxAttempts: 3,
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });

  assert.equal(rA.status, "paused");
  assert.equal(rB.status, "paused");
  // Both attempted exactly 3 times each (one full retry loop per session)
  assert.equal(attempts, 6, "two sessions × 3 attempts each = 6 attempts total");
});

// ── 7. Provider-fatal also pauses immediately ─────────────────────────────

test("AG-P1-06.2.7: provider-fatal (e.g. 503 overloaded) pauses immediately", async () => {
  let attempts = 0;
  const { client, callbacks } = makeHarness({
    prompt: async () => {
      attempts++;
      throw Object.assign(new Error("Provider overloaded 503"), {
        code: "OVERLOADED",
      });
    },
    onPause: () => {},
    onNotify: () => {},
    onWebhookFire: () => {},
  });

  const result = await deliverContinuation(client, {
    sessionId: "s-7",
    idempotencyKey: "session-7/step-1",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: {
      onPause: callbacks.onPause,
      onNotify: callbacks.onNotify,
      onWebhookFire: callbacks.onWebhookFire,
      onReset: () => {},
    },
  });

  assert.equal(result.status, "paused");
  assert.equal(attempts, 1, "provider-fatal must NOT retry");
  assert.match(result.reason ?? "", /provider-fatal/i);
});

// ── 8. Abort failure IS retryable ─────────────────────────────────────────

test("AG-P1-06.2.8: abort failure retries (treats as transient)", async () => {
  let attempts = 0;
  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      if (attempts < 2) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      return { data: { id: "ok" } };
    },
  });

  const result = await deliverContinuation(client, {
    sessionId: "s-8",
    idempotencyKey: "session-8/step-1",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });

  assert.equal(result.status, "delivered");
  assert.equal(attempts, 2);
});

// ── 9. Backoff option (C2) ──────────────────────────────────────────────────

test("C2.1: backoffMs absent → no delay between attempts", async () => {
  let attempts = 0;
  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error("fetch failed ECONNRESET"), { code: "ECONNRESET" });
      }
      return { data: { id: "ok" } };
    },
    onPause: () => {},
    onNotify: () => {},
    onWebhookFire: () => {},
  });

  const t0 = Date.now();
  const result = await deliverContinuation(client, {
    sessionId: "s-c2-1",
    idempotencyKey: "s-c2-1/k",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    // backoffMs is absent — no delay expected
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });
  const elapsed = Date.now() - t0;

  assert.equal(result.status, "delivered");
  assert.equal(attempts, 3);
  // Should complete in <100ms (no artificial delay).
  assert.ok(elapsed < 100, `expected <100ms without backoff; took ${elapsed}ms`);
});

test("C2.2: backoffMs function is called between retries", async () => {
  let attempts = 0;
  const backoffCalls = [];
  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error("fetch failed ECONNRESET"), { code: "ECONNRESET" });
      }
      return { data: { id: "ok" } };
    },
    onPause: () => {},
    onNotify: () => {},
    onWebhookFire: () => {},
  });

  const result = await deliverContinuation(client, {
    sessionId: "s-c2-2",
    idempotencyKey: "s-c2-2/k",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    backoffMs: (nextAttempt) => {
      backoffCalls.push(nextAttempt);
      return 0; // no real delay; we just want to observe the call
    },
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });

  assert.equal(result.status, "delivered");
  assert.equal(attempts, 3);
  // backoffMs is called BEFORE attempts 2 and 3 (so 2 calls total).
  assert.deepEqual(backoffCalls, [2, 3]);
});

test("C2.3: backoffMs is awaited between attempts (delay is real)", async () => {
  let attempts = 0;
  const timestamps = [];
  const { client } = makeHarness({
    prompt: async () => {
      timestamps.push(Date.now());
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error("fetch failed ECONNRESET"), { code: "ECONNRESET" });
      }
      return { data: { id: "ok" } };
    },
    onPause: () => {},
    onNotify: () => {},
    onWebhookFire: () => {},
  });

  const result = await deliverContinuation(client, {
    sessionId: "s-c2-3",
    idempotencyKey: "s-c2-3/k",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    backoffMs: () => 30, // 30ms between each attempt
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });

  assert.equal(result.status, "delivered");
  assert.equal(attempts, 3);
  // attempts 2 and 3 should each be ~30ms after the previous.
  const gap1 = timestamps[1] - timestamps[0];
  const gap2 = timestamps[2] - timestamps[1];
  assert.ok(gap1 >= 25, `gap1 should be >=25ms; was ${gap1}ms`);
  assert.ok(gap2 >= 25, `gap2 should be >=25ms; was ${gap2}ms`);
});

test("C2.4: backoffMs not called after final attempt", async () => {
  let attempts = 0;
  const backoffCalls = [];
  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      throw Object.assign(new Error("fetch failed ECONNRESET"), { code: "ECONNRESET" });
    },
    onPause: () => {},
    onNotify: () => {},
    onWebhookFire: () => {},
  });

  const result = await deliverContinuation(client, {
    sessionId: "s-c2-4",
    idempotencyKey: "s-c2-4/k",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    backoffMs: (nextAttempt) => {
      backoffCalls.push(nextAttempt);
      return 0;
    },
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });

  assert.equal(result.status, "paused");
  assert.equal(attempts, 3);
  // Backoff is called before attempts 2 and 3, but NOT after
  // attempt 3 (which is the final one that exhausts retries).
  assert.deepEqual(backoffCalls, [2, 3]);
});

test("C2.5: backoffMs returning 0 skips the delay", async () => {
  let attempts = 0;
  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      if (attempts < 2) {
        throw Object.assign(new Error("fetch failed ECONNRESET"), { code: "ECONNRESET" });
      }
      return { data: { id: "ok" } };
    },
    onPause: () => {},
    onNotify: () => {},
    onWebhookFire: () => {},
  });

  const t0 = Date.now();
  const result = await deliverContinuation(client, {
    sessionId: "s-c2-5",
    idempotencyKey: "s-c2-5/k",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    backoffMs: () => 0,
    deps: { onReset: () => {}, onPause: () => {}, onNotify: () => {}, onWebhookFire: () => {} },
  });
  const elapsed = Date.now() - t0;

  assert.equal(result.status, "delivered");
  assert.equal(attempts, 2);
  assert.ok(elapsed < 50, `backoffMs returning 0 should not delay; took ${elapsed}ms`);
});

test("stale guard suppresses hard-failure pause when the target changes during prompt delivery", async () => {
  let current = true;
  let attempts = 0;
  let pauseCalled = 0;
  let notifyCalled = 0;
  let webhookCalled = 0;
  let resetCalled = 0;

  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      current = false;
      const err = new Error("ProviderAuthError: invalid key");
      err.name = "ProviderAuthError";
      throw err;
    },
  });

  const result = await deliverContinuation(client, {
    sessionId: "s-stale-hard-failure",
    idempotencyKey: "s-stale-hard-failure/k",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    shouldContinue: () => current,
    deps: {
      onPause: () => { pauseCalled++; },
      onNotify: () => { notifyCalled++; },
      onWebhookFire: () => { webhookCalled++; },
      onReset: () => { resetCalled++; },
    },
  });

  assert.equal(result.status, "stale-suppressed");
  assert.equal(attempts, 1, "hard failures still do not retry");
  assert.equal(pauseCalled, 0, "stale hard failure must not pause the replacement/cleared goal");
  assert.equal(notifyCalled, 0, "stale hard failure must not notify as though the current goal failed");
  assert.equal(webhookCalled, 0, "stale hard failure must not emit a paused webhook for the wrong goal");
  assert.equal(resetCalled, 0, "stale suppression is not a successful delivery");
});

test("stale guard suppresses and aborts a prompt that succeeds after the target changes", async () => {
  let current = true;
  let attempts = 0;
  let staleAbortCalled = 0;
  let resetCalled = 0;

  const { client } = makeHarness({
    prompt: async () => {
      attempts++;
      current = false;
      return { data: { id: "late-prompt" } };
    },
  });

  const result = await deliverContinuation(client, {
    sessionId: "s-stale-success",
    idempotencyKey: "s-stale-success/k",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    shouldContinue: () => current,
    deps: {
      onPause: () => {},
      onNotify: () => {},
      onWebhookFire: () => {},
      onReset: () => { resetCalled++; },
      onStaleDelivery: () => { staleAbortCalled++; },
    },
  });

  assert.equal(result.status, "stale-suppressed");
  assert.equal(attempts, 1, "the prompt attempt itself already happened");
  assert.equal(staleAbortCalled, 1, "late prompt admission must trigger best-effort cleanup");
  assert.equal(resetCalled, 0, "stale suppression is not a successful delivery");

  const duplicate = await deliverContinuation(client, {
    sessionId: "s-stale-success",
    idempotencyKey: "s-stale-success/k",
    body: { parts: [{ type: "text", text: "test" }] },
    maxAttempts: 3,
    shouldContinue: () => false,
    deps: {
      onPause: () => {},
      onNotify: () => {},
      onWebhookFire: () => {},
      onReset: () => { resetCalled++; },
      onStaleDelivery: () => { staleAbortCalled++; },
    },
  });

  assert.equal(duplicate.status, "stale-suppressed");
  assert.equal(attempts, 1, "stale success must not poison idempotency as delivered");
});
