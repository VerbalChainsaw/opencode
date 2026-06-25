/**
 * AG-P1-06 part 3 — call-site migration: shape verification tests.
 *
 * The decision function (`decideContinuationRetry`) is unit-tested in
 *   test/server-continuation-dispatch.test.mjs (13 tests).
 * The dispatcher wrapper (`deliverContinuation`) is unit-tested in
 *   test/server-continuation-dispatcher.test.mjs (9 tests).
 *
 * This file pins the WIRE-UP — that production server.ts uses the
 * dispatcher at both call sites (chain-advance + continue-nudge)
 * rather than the pre-fix inline `.then().catch()` pattern. It also
 * pins the Q4 cleanup: the legacy `nudgeFailureCounts` Map and its
 * helpers are removed.
 *
 * The retry-behavior integration tests (transient failure → retry) are
 * covered by the dispatcher's own unit tests above; reproducing them
 * at the full-server level would require a fully-mocked SDK with
 * async message reads and constraint checks, which is out of scope
 * for this commit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_TS = join(here, "..", "src", "server.ts");

function loadServerSource() {
  return readFileSync(SERVER_TS, "utf-8");
}

// ── 1. Both call sites use the dispatcher ──────────────────────────────────

test("AG-P1-06.3.1: chain-advance prompt uses deliverContinuation dispatcher", () => {
  const src = loadServerSource();
  // The chain-advance prompt block must call `deliverContinuation`.
  // Find it inside the `if (snapshot.achieved)` branch — between
  // `chainAdvanceOutcome = await deliverContinuation` and the
  // matching `notify("Chain advance failed"`.
  const dispatcherCallCount = (src.match(/deliverContinuation\s*\(/g) ?? []).length;
  assert.ok(
    dispatcherCallCount >= 2,
    `server.ts must call deliverContinuation at both the chain-advance and continue-nudge call sites; found ${dispatcherCallCount} call(s)`,
  );
});

test("AG-P1-06.3.2: continue-nudge prompt uses deliverContinuation dispatcher", () => {
  const src = loadServerSource();
  // The continue-nudge block (the path the auto-loop takes when the
  // goal is not yet met) must also call `deliverContinuation`. We
  // assert this by checking that the `nudgeOutcome = await
  // deliverContinuation` line exists AND that the inline
  // `.catch((err) => { ... recordNudgeFailure ... })` shape from
  // the pre-fix code is gone.
  assert.ok(
    src.includes("nudgeOutcome = await deliverContinuation("),
    "continue-nudge path must call deliverContinuation",
  );
  assert.ok(
    !src.includes("recordNudgeFailure(sessionId)"),
    "pre-fix recordNudgeFailure helper must be removed",
  );
});

// ── 2. Q4 cleanup: legacy Map and helpers removed ──────────────────────────

test("AG-P1-06.3.3: legacy nudgeFailureCounts Map and helpers are removed", () => {
  const src = loadServerSource();
  // Strip comments before checking (the legacy names appear in
  // comments documenting why they were removed — that's expected).
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^\s*\/\/.*$/gm, "")     // line comments
    .replace(/\/\*[\s\S]*$/g, "");   // unterminated block comments
  assert.ok(
    !codeOnly.includes("nudgeFailureCounts = new Map"),
    "nudgeFailureCounts Map declaration must be removed from code",
  );
  assert.ok(
    !codeOnly.includes("recordNudgeFailure"),
    "recordNudgeFailure helper must be removed from code (still allowed in comments)",
  );
  assert.ok(
    !codeOnly.includes("resetNudgeFailures"),
    "resetNudgeFailures helper must be removed from code",
  );
  assert.ok(
    !codeOnly.includes("_cleanupTimer"),
    "nudgeFailureCounts cleanup timer must be removed from code",
  );
});

// ── 3. Idempotency key shape ───────────────────────────────────────────────

test("AG-P1-06.3.4: chain-advance idempotency key includes chainStep", () => {
  const src = loadServerSource();
  // The chain-advance idempotency key must include the chain step
  // so two distinct steps don't suppress each other.
  assert.ok(
    src.includes("idempotencyKey: `${sessionId}|${state.id}|${state.metadata.chainStep ?? \"\"}`"),
    "chain-advance idempotency key must include state.metadata.chainStep",
  );
});

test("AG-P1-06.3.5: continue-nudge idempotency key is per-session per-state", () => {
  const src = loadServerSource();
  assert.ok(
    src.includes("idempotencyKey: `${sessionId}|${state.id}`"),
    "continue-nudge idempotency key must be session+state (no chain step)",
  );
});

// ── 4. C4 webhook ordering: pause → notify → webhook ──────────────────────

test("AG-P1-06.3.6: dispatcher deps callbacks are wired (pause/notify/webhook)", () => {
  const src = loadServerSource();
  // The chain-advance deps block must wire all four callbacks:
  //   onPause, onNotify, onWebhookFire, onReset.
  const depCallbacksForChainAdvance = (src.match(/deps:\s*\{[\s\S]*?onPause:\s*async[\s\S]*?onNotify:\s*async[\s\S]*?onWebhookFire:[\s\S]*?onReset:\s*\(\)/g) ?? []).length;
  // The continue-nudge block must also wire onPause, onNotify,
  // onWebhookFire, onReset.
  assert.ok(
    depCallbacksForChainAdvance >= 2,
    `expected at least 2 deps blocks (chain-advance + nudge); found ${depCallbacksForChainAdvance}`,
  );
});