// Dispatcher parity lock. command.ts (CLI) and control-state.ts (bridge/GUI)
// are two implementations of the same goal-control command language. They have
// drifted repeatedly (chain remove, allowlist, JSON DoS caps, set bound). This
// test pins that they produce EQUIVALENT state for the shared command set, so
// any future divergence fails CI instead of shipping as a bridge-only bug.
//
// Known intentional representation difference (excluded via normalization):
//   `verification` — CLI `set --command X` writes verification:null + command,
//   the bridge writes verification:{type:"shell",command}. Both evaluate the
//   same. Tracked in task #2; normalized out here so the rest can be locked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchGoalCommandStructured } from "../dist/command.js";
import { runGoalControlStateFile } from "../dist/control-state.js";

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `opengoal-parity-${prefix}-`));
}

function readState(dir) {
  const p = join(dir, ".opencode", ".goal-state.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// Strip fields that legitimately differ per-run (ids, timestamps, eval history)
// and the known `verification` representation difference, leaving the semantic
// state both dispatchers must agree on.
function normalizeState(s) {
  if (!s) return null;
  const {
    id, createdAt, startedAt, pausedAt, resumedAt, completedAt,
    lastEvaluation, evaluationHistory, verification, metadata, ...rest
  } = s;
  // metadata carries per-run values that legitimately differ between the two
  // dispatch runs: timestamps (conditionEditedAt) and random ids (previousId,
  // set by restart from the prior goal's id).
  const { conditionEditedAt, previousId, restartedAt, ...metaRest } = metadata ?? {};
  return { ...rest, metadata: metaRest };
}

async function applyToBoth(commands) {
  const cli = freshDir("cli");
  const bridge = freshDir("br");
  try {
    for (const c of commands) {
      dispatchGoalCommandStructured(cli, c);
      await runGoalControlStateFile(bridge, c, Date.now());
    }
    return { cli: readState(cli), bridge: readState(bridge) };
  } finally {
    rmSync(cli, { recursive: true, force: true });
    rmSync(bridge, { recursive: true, force: true });
  }
}

test("parity: set + dial commands produce equivalent state", async () => {
  const { cli, bridge } = await applyToBoth([
    'set "ship the release"',
    "turns 7",
    "time 25",
    "tokens 50000",
  ]);
  assert.deepEqual(normalizeState(cli), normalizeState(bridge));
});

test("parity: condition edit produces equivalent state", async () => {
  const { cli, bridge } = await applyToBoth(['set "first goal"', 'condition "second goal"']);
  assert.equal(cli.condition, "second goal");
  assert.deepEqual(normalizeState(cli), normalizeState(bridge));
});

test("parity: pause then resume produce equivalent status", async () => {
  const { cli, bridge } = await applyToBoth(['set "keep going"', "pause", "resume"]);
  assert.equal(cli.status, "active");
  assert.deepEqual(normalizeState(cli), normalizeState(bridge));
});

test("parity: restart produces equivalent active state", async () => {
  const { cli, bridge } = await applyToBoth(['set "do the work"', "restart"]);
  assert.equal(cli.status, "active");
  assert.deepEqual(normalizeState(cli), normalizeState(bridge));
});

test("parity: clear marks the goal terminal in both", async () => {
  const { cli, bridge } = await applyToBoth(['set "do it"', "clear"]);
  assert.equal(cli.status, bridge.status);
  assert.equal(cli.status, "cleared");
});

function readChain(dir) {
  const p = join(dir, ".opencode", ".goal-chain.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

test("parity: chain start-json writes an equivalent, runtime-valid chain", async () => {
  const payload = JSON.stringify({
    master: { maxTurns: 12, maxMinutes: 45 },
    steps: [{ condition: "Plan" }, { condition: "Build", command: "npm test" }],
  });
  const cmd = `chain start-json ${payload}`;
  const cli = freshDir("cli");
  const bridge = freshDir("br");
  try {
    dispatchGoalCommandStructured(cli, cmd);
    await runGoalControlStateFile(bridge, cmd, Date.now());
    const c1 = readChain(cli);
    const c2 = readChain(bridge);
    // The runtime budget/cycle fields must match so a bridge chain advances
    // exactly like a CLI chain.
    assert.equal(c1.cycles, c2.cycles);
    assert.equal(c1.current, c2.current);
    assert.equal(c1.onComplete, c2.onComplete);
    assert.deepEqual(
      { t: c1.master.turnsUsed, m: c1.master.minutesUsed, mt: c1.master.maxTurns, mm: c1.master.maxMinutes },
      { t: c2.master.turnsUsed, m: c2.master.minutesUsed, mt: c2.master.maxTurns, mm: c2.master.maxMinutes },
    );
    assert.deepEqual(
      c1.steps.map((s) => ({ condition: s.condition, command: s.command })),
      c2.steps.map((s) => ({ condition: s.condition, command: s.command })),
    );
  } finally {
    rmSync(cli, { recursive: true, force: true });
    rmSync(bridge, { recursive: true, force: true });
  }
});

test("parity: steer note count matches in both", async () => {
  const { cli, bridge } = await applyToBoth(['set "build"', 'steer "focus on the api first"']);
  const cliSteer = Array.isArray(cli.metadata.steering) ? cli.metadata.steering.length : 0;
  const brSteer = Array.isArray(bridge.metadata.steering) ? bridge.metadata.steering.length : 0;
  assert.equal(cliSteer, 1);
  assert.equal(cliSteer, brSteer);
});

test("parity: chain add / move produce equivalent state in both", async () => {
  // Locks the 6th+7th drift fixes (chain move 1-based off-by-one, chain add
  // metadata refresh). Both dispatchers must leave the chain in the same
  // shape after the same edit sequence.
  const payload = JSON.stringify({
    steps: [{ condition: "A" }, { condition: "B" }, { condition: "C" }],
  });
  const cli = freshDir("cli");
  const bridge = freshDir("br");
  try {
    const cmds = [`chain start-json ${payload}`, 'chain add "D"', "chain move 2 3"];
    for (const c of cmds) {
      dispatchGoalCommandStructured(cli, c);
      await runGoalControlStateFile(bridge, c, Date.now());
    }
    const c1 = readChain(cli);
    const c2 = readChain(bridge);
    assert.deepEqual(
      c1.steps.map((s) => s.condition),
      c2.steps.map((s) => s.condition),
    );
    assert.equal(c1.maxCycles, c2.maxCycles);
  } finally {
    rmSync(cli, { recursive: true, force: true });
    rmSync(bridge, { recursive: true, force: true });
  }
});

test("parity: clear cancels active chain files in both dispatchers", async () => {
  const payload = JSON.stringify({
    steps: [{ condition: "Plan" }, { condition: "Build" }],
  });
  const cli = freshDir("cli");
  const bridge = freshDir("br");
  try {
    const cmds = [`chain start-json ${payload}`, "clear"];
    for (const c of cmds) {
      dispatchGoalCommandStructured(cli, c);
      await runGoalControlStateFile(bridge, c, Date.now());
    }

    assert.equal(readState(cli).status, "cleared");
    assert.equal(readState(bridge).status, "cleared");
    assert.equal(readChain(cli), null, "CLI clear must cancel the live chain");
    assert.equal(readChain(bridge), null, "bridge clear must cancel the live chain");
  } finally {
    rmSync(cli, { recursive: true, force: true });
    rmSync(bridge, { recursive: true, force: true });
  }
});

function readHandoff(dir) {
  const p = join(dir, ".opencode", ".goal-handoff.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

test("parity: handoff note strips surrounding quotes in both dispatchers", async () => {
  // Locks the 8th drift fix: CLI `command.ts` was passing the raw payload
  // (with literal `"..."` quotes preserved) into createHandoff, while the
  // bridge's quote-aware `splitGoalCommand` stripped them. After the CLI now
  // applies `unwrapQuotes` to the handoff payload, both dispatchers must
  // persist handoff.note === "left a note for the next session".
  const cli = freshDir("cli");
  const bridge = freshDir("br");
  try {
    const cmds = ['set "ship the release"', 'handoff "left a note for the next session"'];
    for (const c of cmds) {
      dispatchGoalCommandStructured(cli, c);
      await runGoalControlStateFile(bridge, c, Date.now());
    }
    const h1 = readHandoff(cli);
    const h2 = readHandoff(bridge);
    assert.equal(h1.note, "left a note for the next session");
    assert.equal(h2.note, "left a note for the next session");
    assert.equal(h1.note, h2.note);
  } finally {
    rmSync(cli, { recursive: true, force: true });
    rmSync(bridge, { recursive: true, force: true });
  }
});
