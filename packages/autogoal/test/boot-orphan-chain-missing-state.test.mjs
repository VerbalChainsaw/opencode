/**
 * Plugin boot: chain file is unlinked when the state file is absent or
 * corrupt — the most-orphaned a chain can be.
 *
 * Defect (CENTER-AUDIT 2026-06-26, state-absent-orphan): The boot
 * orphan-cleanup at server.ts:1075-1111 guarded on `bootTerminalState`
 * truthy. That value is null when the state file is absent (deleted,
 * zero-byte, or never written) or corrupt (parse/validate/io/oversize).
 * A chain file with no recoverable state is the most-orphaned a chain
 * can be — there is no goal anchoring its steps — but the guard let it
 * persist forever across boots, consuming disk and requiring manual
 * cleanup.
 *
 * Three real-world entry points to the bug:
 *   1. `createGoalChain` writes the chain file before the state file
 *      (goal-chain.ts:654-664). A crash between those two writes leaves
 *      a chain with no state.
 *   2. User manually deletes `.opencode/.goal-state.json` (debugging,
 *      cleanup attempt, etc.) but leaves the chain file behind.
 *   3. State file corrupts and gets quarantined to `.corrupt.<ts>`
 *      by `readGoalStateResult`. The chain file is left intact even
 *      though the state it referenced no longer exists.
 *
 * Fix: classify the boot state once into terminal / unrecoverable /
 * live. If unrecoverable (absent OR corrupt), unlink the chain file
 * unconditionally. Active/paused states are preserved as before.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { server as autogoalServer } from "../dist/server.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "autogoal-orphanmissing-"));
}

function plantChain(dir, { stepsCount = 3, current = 0, chainId = "chain-stale" } = {}) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  const steps = Array.from({ length: stepsCount }, (_, i) => ({
    condition: `step ${i + 1}`,
    verification: { type: "marker" },
    maxTurns: 3,
    maxMinutes: 10,
  }));
  const chain = {
    version: 1,
    id: chainId,
    steps,
    current,
    cycles: 0,
    maxCycles: 10,
    onComplete: "stop",
    master: { maxTurns: 20, maxMinutes: 60, turnsUsed: 0, minutesUsed: 0 },
    metadata: {
      createdAt: 1_000_000,
      setBy: "chain",
      sessionId: "ses_dead_session",
    },
  };
  writeFileSync(join(dir, ".opencode", ".goal-chain.json"), JSON.stringify(chain, null, 2));
}

const fakeClient = () => ({
  app: { log: async () => {} },
  tui: { showToast: async () => {} },
  session: { messages: async () => ({ data: [] }), prompt: async () => ({ data: { id: "x" } }) },
});

test("plugin boot: state ABSENT + chain present → chain unlinked (missing-state orphan)", async () => {
  const dir = freshDir();
  try {
    plantChain(dir, { stepsCount: 3, current: 0 });
    const chainPath = join(dir, ".opencode", ".goal-chain.json");
    const statePath = join(dir, ".opencode", ".goal-state.json");
    assert.ok(existsSync(chainPath), "precondition: chain file planted");
    assert.equal(existsSync(statePath), false, "precondition: state file absent");

    await autogoalServer({ client: fakeClient(), directory: dir });

    assert.equal(
      existsSync(chainPath),
      false,
      "chain with no anchoring state must be unlinked at boot",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin boot: state CORRUPT (invalid JSON) + chain present → chain unlinked", async () => {
  const dir = freshDir();
  try {
    plantChain(dir, { stepsCount: 2, current: 1 });
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    // Plant syntactically invalid JSON. readGoalStateResult quarantines it
    // to .corrupt.<ts> and returns kind: "corrupt", so the original path
    // becomes absent after the read — either way it's unrecoverable.
    writeFileSync(join(dir, ".opencode", ".goal-state.json"), "{not valid json", "utf-8");
    const chainPath = join(dir, ".opencode", ".goal-chain.json");
    assert.ok(existsSync(chainPath), "precondition: chain file planted");

    await autogoalServer({ client: fakeClient(), directory: dir });

    assert.equal(
      existsSync(chainPath),
      false,
      "chain with corrupt state must be unlinked at boot",
    );
    // A corrupt artifact should have been quarantined.
    const artifacts = readdirSync(join(dir, ".opencode")).filter((f) =>
      f.startsWith(".goal-state.json.corrupt."),
    );
    assert.ok(artifacts.length >= 1, "corrupt state file should be quarantined alongside chain cleanup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin boot: state CORRUPT (validation failure) + chain present → chain unlinked", async () => {
  const dir = freshDir();
  try {
    plantChain(dir, { stepsCount: 4, current: 2 });
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    // Syntactically valid JSON but schema-invalid (missing required fields).
    writeFileSync(
      join(dir, ".opencode", ".goal-state.json"),
      JSON.stringify({ version: 1, junk: true }),
      "utf-8",
    );
    const chainPath = join(dir, ".opencode", ".goal-chain.json");
    assert.ok(existsSync(chainPath), "precondition: chain file planted");

    await autogoalServer({ client: fakeClient(), directory: dir });

    assert.equal(
      existsSync(chainPath),
      false,
      "chain with schema-invalid state must be unlinked at boot",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin boot: state ABSENT + chain ABSENT → no error (clean directory)", async () => {
  const dir = freshDir();
  try {
    // Don't plant anything. The plugin boot should not throw or create
    // spurious files on a clean directory.
    await autogoalServer({ client: fakeClient(), directory: dir });

    assert.equal(
      existsSync(join(dir, ".opencode", ".goal-chain.json")),
      false,
      "no chain file should appear from a clean boot",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin boot: ACTIVE state + chain → chain preserved (regression guard)", async () => {
  const dir = freshDir();
  try {
    plantChain(dir, { chainId: "chain-live" });
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(
      join(dir, ".opencode", ".goal-state.json"),
      JSON.stringify({
        version: 1,
        id: "goal-live",
        condition: "step 1",
        command: null,
        verification: { type: "marker" },
        status: "active",
        createdAt: 1_000_000,
        startedAt: 1_000_000,
        completedAt: null,
        pausedAt: null,
        resumedAt: null,
        turnsEvaluated: 0,
        tokensUsed: 0,
        lastEvaluation: null,
        evaluationHistory: [],
        constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
        metadata: { setBy: "chain", chainId: "chain-live", chainStep: 0, chainTotal: 3 },
      }),
    );
    const chainPath = join(dir, ".opencode", ".goal-chain.json");

    await autogoalServer({ client: fakeClient(), directory: dir });

    assert.ok(
      existsSync(chainPath),
      "chain file backing an active goal MUST be preserved across boot (regression guard)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
