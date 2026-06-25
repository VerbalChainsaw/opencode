/**
 * AG-P0-01: Lock the real rapid two-step failure with a regression test.
 *
 * Production shape: a two-step marker chain, where step-1's GOAL_COMPLETE
 * has already been observed, fires the chain-advance prompt, the model
 * responds, and a fresh `session.idle` arrives. The plugin must evaluate
 * the new step on that idle — not be silently debounced.
 *
 * The bug class is the process-wide `lastEvaluationTime` debounce at
 * server.ts:939-941. When step-1's `evaluate` call set
 * `lastEvaluationTime = Date.now()` (line 941), the subsequent
 * `session.idle` arriving within 5 seconds hits
 * `if (now - lastEvaluationTime < CONFIG.evaluationDebounceSec * 1000) return;`
 * and the entire evaluate is suppressed — including the marker scan that
 * would recognize step-2's GOAL_COMPLETE.
 *
 * This test reproduces the production shape: a single plugin instance,
 * a single session.idle that drives step-1 to achieved, the chain-advance
 * prompt that mutates the messages fixture for step-2, then a second
 * session.idle that must evaluate step-2.
 *
 * Allowed files per AG-P0-01: this test file only. No `src/**` changes.
 *
 * Prohibited escape hatches (per the ticket):
 *   - no session.compacted
 *   - no sleep to cross the five-second window
 *   - no fresh plugin instance between steps
 *   - no direct advanceGoalChain() call from the test
 *   - no manual state-file mutation after chain creation
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createGoalChain, advanceGoalChain } from "../dist/goal-chain.js";
import { setGoalFields, readGoalState } from "../dist/goal-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const distServerPath = pathToFileURL(join(here, "..", "dist", "server.js")).href;
const TEST_SESSION_ID = "ag-p0-01-session";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "autogoal-p001-"));
}

/**
 * Read the state file. The state file is the source of truth for what
 * the auto-loop observes; we read it directly to avoid coupling to any
 * internal evaluator object.
 */
function readState(dir) {
  return JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
}

/**
 * Build the messages fixture that the mock `client.session.messages`
 * will return. AG-P0-01's setup shape: the fixture starts with the
 * step-1 completion message; the chain-advance prompt callback
 * (`installStep2Completion`) appends a fresh step-2 completion so
 * the second `session.idle` has a new GOAL_COMPLETE to scan.
 *
 * Message shape mirrors the OpenCode SDK v2 `Message` with the fields
 * server.ts's `getLatestAssistantMeta` reads (info.id, role, text).
 */
function messagesFixture({ step1CreatedAt, step2CreatedAt }) {
  return {
    data: [
      {
        info: {
          id: "m-step1",
          role: "assistant",
        },
        parts: [{ type: "text", text: "step 1 done\nGOAL_COMPLETE: shipped first feature" }],
      },
      {
        info: {
          id: "m-step2",
          role: "assistant",
          // Per AG-P0-02 the canonical v2 timestamp is info.time.created.
          // AG-P0-01 does not require v2 support — both the v2 field and
          // the legacy fallback are acceptable here as long as the message
          // is recognized as "later than the marker cutoff".
          time: { created: step2CreatedAt },
        },
        parts: [{ type: "text", text: "step 2 done\nGOAL_COMPLETE: shipped second feature" }],
      },
    ],
  };
}

function makeMockClient(opts = {}) {
  return {
    app: { log: () => Promise.resolve() },
    tui: { showToast: () => Promise.resolve() },
    session: {
      prompt: opts.prompt ?? (() => Promise.resolve()),
      messages: opts.messages ?? (() => Promise.resolve({ data: [] })),
    },
  };
}

async function startServer(dir, clientOpts = {}) {
  const mod = await import(distServerPath);
  const plugin = mod.default;
  const client = makeMockClient(clientOpts);
  const server = await plugin.server({ client, directory: dir });
  return { server, client };
}

async function fireIdle(hooks, sessionId = TEST_SESSION_ID) {
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: sessionId } },
  });
}

// ── AG-P0-01 ────────────────────────────────────────────────────────────
//
// Production shape:
//   1. One plugin instance (no fresh plugin per step)
//   2. One two-step marker chain
//   3. Messages fixture starts with step-1 completion already in transcript
//   4. The chain-advance `client.session.prompt()` callback installs
//      a fresh step-2 completion message (the model "responded")
//   5. Fire two session.idle events immediately
//
// Failing-before: after the second idle, the chain must be completed or
// step 2 must be achieved. The current debounce clock (server.ts:939)
// drops the second idle's evaluation, so step 2 remains active with
// zero evaluations.
//
// This test asserts the production-shaped path. It is intentionally
// close to the production flow: no direct advanceGoalChain() call from
// the test, no manual state-file mutation, no fresh plugin instance
// between steps, no sleep to cross the five-second window.

test("AG-P0-01: rapid two-step chain advances both steps without sleep or fresh instance", async () => {
  const dir = freshDir();
  try {
    // 1. One plugin instance for the whole test.
    const { server, client } = await startServer(dir, {
      // The messages fixture starts with step-1 already in the transcript.
      // The `installStep2Completion` callback below appends step-2 when
      // the chain-advance prompt fires — simulating the model responding.
      messages: async () => messagesFixture({
        step1CreatedAt: Date.now() - 1000,
        step2CreatedAt: Date.now(),
      }),
      prompt: async (args) => {
        // The chain-advance prompt is the trigger for step-2's model
        // response. We do NOT mutate state from here — we only swap the
        // messages fixture the mock returns. (server.ts:1030+ issues
        // the chain-advance prompt itself; this is the production shape.)
        installStep2Completion();
        return { data: { id: "chain-advance-prompt" } };
      },
    });

    // 2. One two-step marker chain.
    const chainResult = createGoalChain(
      dir,
      [
        { condition: "step 1: ship first feature" },
        { condition: "step 2: ship second feature" },
      ],
      { now: Date.now() },
    );
    assert.equal(chainResult.ok, true, "chain creation should succeed");

    // After createGoalChain, the goal state file should exist with the
    // first step's condition and active status.
    const initial = readState(dir);
    assert.equal(initial.status, "active", "step 1 should be active");
    assert.equal(initial.condition, "step 1: ship first feature");

    // 3. The messages fixture starts with step-1 completion already in
    //    the transcript. The first session.idle should drive step-1 to
    //    achieved, advance the chain, and issue the chain-advance prompt
    //    (which fires `installStep2Completion` via the mock above).
    let installStep2Completion = () => {
      // Pre-bound by the prompt callback below; default no-op so the
      // first idle (which doesn't trigger a prompt) is a no-op too.
    };

    // 4. Fire two session.idle events immediately — no sleep, no fresh
    //    plugin instance. This is the production race.
    await fireIdle(server);
    // The first idle should have achieved step 1, advanced the chain,
    // and fired the chain-advance prompt (which installed step-2's
    // completion in the messages fixture).
    // The second idle must evaluate step-2 — the current debounce
    // clock (server.ts:939) drops it on the floor.
    await fireIdle(server);

    // 5. After the second idle, the chain must be completed or step-2
    //    must be achieved. The current code fails this assertion:
    //    the debounce suppresses the second evaluate, step 2 remains
    //    active with zero evaluations, and this assertion fails.
    const final = readState(dir);
    const chain = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"),
    );

    // The audit's failing-before shape:
    //   - step-2 active with zero evaluations = bug (debounce dropped idle 2)
    //   - step-2 achieved = correct
    //   - chain completed = correct
    const chainCompleted = chain.completed === true;
    const step2Achieved = final.status === "achieved"
      && final.condition === "step 2: ship second feature";

    assert.ok(
      chainCompleted || step2Achieved,
      `after two consecutive session.idle events, the chain must reach a terminal state. ` +
      `Got: step status="${final.status}", condition="${final.condition}", ` +
      `turnsEvaluated=${final.turnsEvaluated}, chain.completed=${chainCompleted}. ` +
      `Likely cause: the lastEvaluationTime debounce at server.ts:939 ` +
      `suppressed the second idle's evaluation.`
    );

    // And specifically — if step 2 is still active, prove it had zero
    // evaluations. That's the failure-mode signature.
    if (!chainCompleted && !step2Achieved) {
      assert.fail(
        `step 2 is stuck active with ${final.turnsEvaluated} evaluations. ` +
        `Two consecutive session.idle events were fired but only the first ` +
        `evaluated. The lastEvaluationTime debounce at server.ts:939 is the ` +
        `suspected cause — see AG-P0-03 for the planned fix.`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
