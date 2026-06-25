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
  assert.equal(result.reason, "Continuation delivery failed 3 times consecutively (network)");
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