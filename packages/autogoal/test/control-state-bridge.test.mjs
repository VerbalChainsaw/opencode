// Bridge-path coverage for runGoalControlStateFile (control-state.ts) — the
// deterministic command runner the Desktop GUI calls via /experimental/goal/control.
// This path duplicates chain logic from command.ts/goal-chain.ts, so it needs its
// own tests (the GUI hit a 400 because `chain remove` and `fresh` regressed here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGoalControlStateFile } from "../dist/control-state.js";
import { readGoalChain, advanceGoalChain } from "../dist/goal-chain.js";
import { readGoalState } from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-bridge-"));
}

test("bridge: chain remove deletes a pending one-based step", async () => {
  const dir = freshDir();
  try {
    const payload = JSON.stringify({
      steps: [{ condition: "Plan" }, { condition: "Build" }, { condition: "Document" }],
    });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());

    const removed = await runGoalControlStateFile(dir, "chain remove 3", Date.now());
    assert.match(removed.output, /removed/i);

    const chain = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"));
    assert.deepEqual(
      chain.steps.map((step) => step.condition),
      ["Plan", "Build"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: a started chain is accepted by the runtime's strict readGoalChain", async () => {
  // Regression: the bridge wrote chains missing `cycles` + master.turnsUsed/
  // minutesUsed, so goal-chain.ts readGoalChain rejected them as corrupt and the
  // runtime never auto-advanced GUI-started chains.
  const dir = freshDir();
  try {
    const payload = JSON.stringify({
      master: { maxTurns: 10, maxMinutes: 40 },
      steps: [{ condition: "Plan" }, { condition: "Build" }, { condition: "Ship" }],
    });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());

    const chain = readGoalChain(dir);
    assert.ok(chain, "runtime readGoalChain must accept a bridge-created chain");
    assert.equal(chain.cycles, 0);
    assert.equal(chain.master.turnsUsed, 0);
    assert.equal(chain.master.minutesUsed, 0);

    // An edit op (remove) re-reads + re-writes the chain; it must stay valid.
    await runGoalControlStateFile(dir, "chain remove 3", Date.now());
    const after = readGoalChain(dir);
    assert.ok(after, "chain must remain valid after a bridge edit op");
    assert.equal(after.steps.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: a started chain advances step 0 → step 1 (end-to-end)", async () => {
  // The definitive check for the critical fix: the runtime's advanceGoalChain
  // must accept the bridge chain AND move to the next step (not "Chain
  // interrupted"/"No active chain").
  const dir = freshDir();
  try {
    const payload = JSON.stringify({ steps: [{ condition: "Plan" }, { condition: "Build" }] });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());
    assert.equal(readGoalState(dir).condition, "Plan");

    const res = advanceGoalChain(dir);
    assert.equal(res.ok, true, `advance must succeed; got: ${res.error}`);
    const state = readGoalState(dir);
    assert.equal(state.condition, "Build");
    assert.equal(state.metadata.chainStep, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: clear cancels the active chain artifact so a stopped run cannot revive", async () => {
  const dir = freshDir();
  try {
    const payload = JSON.stringify({ steps: [{ condition: "Plan" }, { condition: "Build" }] });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());
    assert.ok(readGoalChain(dir), "precondition: chain file should exist after start");

    const cleared = await runGoalControlStateFile(dir, "clear", Date.now());
    assert.match(cleared.output, /cleared/i);
    assert.equal(readGoalState(dir).status, "cleared");
    assert.equal(readGoalChain(dir), null, "clearing from the Desktop bridge must remove the live chain");
    assert.equal(existsSync(join(dir, ".opencode", ".goal-chain.json")), false);

    const res = advanceGoalChain(dir);
    assert.equal(res.ok, false, "a stopped chain must not advance after clear");
    assert.match(res.error, /No active chain/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: clear preserves a matching pending handoff chain for claim", async () => {
  const dir = freshDir();
  try {
    const payload = JSON.stringify({ steps: [{ condition: "Plan" }, { condition: "Build" }] });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());
    const before = readGoalChain(dir);
    assert.ok(before, "precondition: chain file should exist after start");

    await runGoalControlStateFile(dir, "handoff carry this forward", Date.now());
    await runGoalControlStateFile(dir, "clear", Date.now());

    const after = readGoalChain(dir);
    assert.ok(after, "a matching handoff needs the chain file for later claim");
    assert.equal(after.id, before.id);
    assert.equal(readGoalState(dir).status, "cleared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: chain remove refuses the currently-running step", async () => {
  const dir = freshDir();
  try {
    const payload = JSON.stringify({ steps: [{ condition: "Plan" }, { condition: "Build" }] });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());
    await assert.rejects(() => runGoalControlStateFile(dir, "chain remove 1", Date.now()), /currently running/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: terminal chain remove deletes the final achieved step and chain file", async () => {
  const dir = freshDir();
  try {
    const payload = JSON.stringify({ steps: [{ condition: "Plan" }] });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());

    const statePath = join(dir, ".opencode", ".goal-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.status = "achieved";
    state.completedAt = Date.now();
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    const removed = await runGoalControlStateFile(dir, "chain remove 1", Date.now());
    assert.match(removed.output, /removed/i);
    assert.equal(readGoalChain(dir), null, "terminal removal of the last row should remove the chain");
    assert.equal(existsSync(join(dir, ".opencode", ".goal-chain.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: fresh removes live state files and reports success", async () => {
  const dir = freshDir();
  try {
    await runGoalControlStateFile(dir, 'set "do the thing"', Date.now());
    assert.ok(existsSync(join(dir, ".opencode", ".goal-state.json")));

    const res = await runGoalControlStateFile(dir, "fresh", Date.now());
    assert.match(res.output, /reset/i);
    assert.ok(!existsSync(join(dir, ".opencode", ".goal-state.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: set bounds an over-length condition to 4000 chars", async () => {
  const dir = freshDir();
  try {
    const huge = "y".repeat(5000);
    await runGoalControlStateFile(dir, `set "${huge}"`, Date.now());
    const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
    assert.equal(state.condition.length, 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: chain start-json rejects an oversized payload before parsing", async () => {
  const dir = freshDir();
  try {
    // A >256KB payload must be rejected pre-parse (DoS guard), not JSON.parsed.
    const huge = "x".repeat(300 * 1024);
    const payload = JSON.stringify({ steps: [{ condition: huge }] });
    await assert.rejects(() => runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now()), /too large/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: chain start-json rejects a deeply-nested payload before parsing", async () => {
  const dir = freshDir();
  try {
    const deep = `chain start-json ${"[".repeat(500)}${"]".repeat(500)}`;
    await assert.rejects(() => runGoalControlStateFile(dir, deep, Date.now()), /nesting depth/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: chain move treats from/to as 1-based (matches remove + CLI)", async () => {
  // Regression: the bridge's chain move was passing 1-based indices straight
  // through, so a 3-step chain's `chain move 2 3` silently threw "out of range"
  // and never moved anything. The GUI's move-step button hit this.
  const dir = freshDir();
  try {
    const payload = JSON.stringify({ steps: [{ condition: "A" }, { condition: "B" }, { condition: "C" }] });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());
    await runGoalControlStateFile(dir, "chain move 2 3", Date.now());

    const chain = readGoalChain(dir);
    assert.equal(chain.steps.map((s) => s.condition).join(","), "A,C,B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: chain add refreshes the active state's chainTotal metadata", async () => {
  // Regression: adding a step didn't call updateActiveChainMetadata, so the
  // GUI's "step X of N" display went stale after an add.
  const dir = freshDir();
  try {
    const payload = JSON.stringify({ steps: [{ condition: "A" }, { condition: "B" }] });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());
    await runGoalControlStateFile(dir, 'chain add "C"', Date.now());

    const state = readGoalState(dir);
    assert.equal(state.metadata.chainTotal, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: chain start-json defaults maxCycles to 10 (matches CLI)", async () => {
  // Regression: the bridge hardcoded maxCycles:1, so GUI-started chains with
  // onComplete:"loop" could only loop once, and a fresh chain without an
  // explicit budget stopped at 1 cycle while CLI chains got 10.
  const dir = freshDir();
  try {
    const payload = JSON.stringify({ steps: [{ condition: "A" }, { condition: "B" }] });
    await runGoalControlStateFile(dir, `chain start-json ${payload}`, Date.now());

    const chain = readGoalChain(dir);
    assert.equal(chain.maxCycles, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
