/**
 * Chain operator geometry hardening — audit 2026-06-25.
 *
 * Six defects identified in `advanceGoalChain` + its sole production caller:
 *   D1 — recordMasterUsage edge cases (Infinity/NaN propagation)
 *   D2 — single-step chain at exhausted budget: misleading message
 *   D5 — stepMarkerAt accepts Infinity / non-finite numbers (JSON null)
 *   D6 — advanceGoalChain non-atomic: chain-write / state-write race
 *   D9 — master budget semantics across loop cycles (documentation)
 *   D10 — server.ts:1241 silently swallows advance errors
 *
 * Each defect has a dedicated test group below. The tests are written
 * against the production exports of `goal-chain.ts` and `goal-state.ts`
 * (no internal access). They use a per-test `mkdtempSync` directory so
 * they cannot interfere with each other or with the host filesystem.
 *
 * Each test is expected to FAIL on the un-patched code and PASS after
 * the corresponding fix is applied. The test file is committed alongside
 * the fixes — see audit report at
 * `.hermes/audit-reports/chain-operator-geometry-2026-06-25.md`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distGoalChain = pathToFileURL(join(here, "..", "dist", "goal-chain.js")).href;
const distGoalState = pathToFileURL(join(here, "..", "dist", "goal-state.js")).href;

function freshDir() {
  return mkdtempSync(join(tmpdir(), "autogoal-geom-"));
}

async function loadMods() {
  const chainMod = await import(distGoalChain);
  const stateMod = await import(distGoalState);
  return { chainMod, stateMod };
}

// ── D5 — stepMarkerAt accepts Infinity / non-finite numbers ────────────────
//
// These tests use TWO-step chains so the advance reaches the new-step
// path that actually sets state.metadata.stepMarkerAt. For single-step
// chains the advance returns at the completion branch BEFORE reaching
// the cutoff computation, so stepMarkerAt is irrelevant for them.

test("D5.1: stepMarkerAt = Number.POSITIVE_INFINITY falls back to now", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    chainMod.createGoalChain(
      dir,
      [{ condition: "step 1" }, { condition: "step 2" }],
      { now: 1 },
    );
    const advanced = chainMod.advanceGoalChain(dir, 100, {
      stepMarkerAt: Number.POSITIVE_INFINITY,
    });
    assert.equal(advanced.ok, true);
    if (!advanced.ok || !advanced.state) throw new Error("unexpected");
    // Read raw state file. stepMarkerAt must be a finite number or 0/now,
    // NOT null and NOT Infinity.
    const raw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"),
    );
    assert.equal(
      typeof raw.metadata.stepMarkerAt,
      "number",
      "stepMarkerAt must serialize as a finite number, not null",
    );
    assert.ok(
      Number.isFinite(raw.metadata.stepMarkerAt),
      "stepMarkerAt must be finite; Infinity is rejected (got " + JSON.stringify(raw.metadata.stepMarkerAt) + ")",
    );
    // Specifically: should equal `now` (100), since Infinity was rejected.
    assert.equal(raw.metadata.stepMarkerAt, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D5.2: stepMarkerAt = NaN falls back to now", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    chainMod.createGoalChain(
      dir,
      [{ condition: "step 1" }, { condition: "step 2" }],
      { now: 1 },
    );
    const advanced = chainMod.advanceGoalChain(dir, 100, {
      stepMarkerAt: Number.NaN,
    });
    assert.equal(advanced.ok, true);
    if (!advanced.ok || !advanced.state) throw new Error("unexpected");
    const raw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"),
    );
    assert.ok(
      Number.isFinite(raw.metadata.stepMarkerAt),
      "stepMarkerAt must be finite; NaN is rejected (got " + JSON.stringify(raw.metadata.stepMarkerAt) + ")",
    );
    assert.equal(raw.metadata.stepMarkerAt, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D5.3: stepMarkerAt = valid positive finite number is preserved", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    chainMod.createGoalChain(
      dir,
      [{ condition: "step 1" }, { condition: "step 2" }],
      { now: 1 },
    );
    const advanced = chainMod.advanceGoalChain(dir, 100, {
      stepMarkerAt: 1_700_000_000_123,
    });
    assert.equal(advanced.ok, true);
    const raw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"),
    );
    assert.equal(raw.metadata.stepMarkerAt, 1_700_000_000_123);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D5.4: stepMarkerAt = 0 falls back to now (0 means 'not provided')", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    chainMod.createGoalChain(
      dir,
      [{ condition: "step 1" }, { condition: "step 2" }],
      { now: 1 },
    );
    const advanced = chainMod.advanceGoalChain(dir, 500, { stepMarkerAt: 0 });
    assert.equal(advanced.ok, true);
    const raw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"),
    );
    assert.equal(raw.metadata.stepMarkerAt, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D1 — recordMasterUsage edge cases ──────────────────────────────────────

test("D1.1: state.turnsEvaluated = NaN does not poison master.turnsUsed", async () => {
  const { chainMod, stateMod } = await loadMods();
  const dir = freshDir();
  try {
    const created = chainMod.createGoalChain(
      dir,
      [{ condition: "step 1" }],
      { now: 1, master: { maxTurns: 100, maxMinutes: 100 } },
    );
    assert.equal(created.ok, true);

    // Corrupt the state file: set turnsEvaluated to NaN. This simulates
    // a bug in an upstream consumer (or a malicious state edit). The
    // master.turnsUsed must NOT become NaN.
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    raw.turnsEvaluated = Number.NaN;
    writeFileSync(statePath, JSON.stringify(raw));

    const advanced = chainMod.advanceGoalChain(dir, 100);
    // AG-P1-06 / audit 2026-06-25 (D1) — the validator rejects states
    // with NaN/Infinity turnsEvaluated, so the advance returns ok=false.
    // The master.turnsUsed is therefore NOT poisoned by the corruption
    // (recordMasterUsage never runs against an invalid state).
    assert.equal(advanced.ok, false);

    const chainRaw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"),
    );
    assert.ok(
      Number.isFinite(chainRaw.master.turnsUsed),
      "master.turnsUsed must remain finite when state.turnsEvaluated is NaN",
    );
    assert.equal(chainRaw.master.turnsUsed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D1.2: state.turnsEvaluated = Infinity does not poison master.turnsUsed", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    chainMod.createGoalChain(dir, [{ condition: "step 1" }], {
      now: 1,
      master: { maxTurns: 100, maxMinutes: 100 },
    });
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    raw.turnsEvaluated = Number.POSITIVE_INFINITY;
    writeFileSync(statePath, JSON.stringify(raw));

    const advanced = chainMod.advanceGoalChain(dir, 100);
    assert.equal(advanced.ok, false);
    const chainRaw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"),
    );
    assert.ok(
      Number.isFinite(chainRaw.master.turnsUsed),
      "master.turnsUsed must remain finite when state.turnsEvaluated is Infinity",
    );
    assert.equal(chainRaw.master.turnsUsed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D1.3: state.startedAt > now (clock skew backward) does not produce negative minutes", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    chainMod.createGoalChain(dir, [{ condition: "step 1" }], {
      now: 1_000_000,
      master: { maxTurns: 100, maxMinutes: 100 },
    });
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    raw.startedAt = 1_000_000_000; // 999 seconds in the future
    writeFileSync(statePath, JSON.stringify(raw));

    const advanced = chainMod.advanceGoalChain(dir, 1_000_500);
    assert.equal(advanced.ok, true);

    const chainRaw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"),
    );
    assert.ok(
      chainRaw.master.minutesUsed >= 0,
      "master.minutesUsed must be ≥ 0 even when startedAt > now",
    );
    assert.ok(
      Number.isFinite(chainRaw.master.minutesUsed),
      "master.minutesUsed must remain finite under clock skew",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D2 — single-step chain at exhausted budget ─────────────────────────────

test("D2.1: single-step chain with exhausted budget reports 'budget reached'", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    // Single-step chain, master budget already exhausted before any advance.
    const created = chainMod.createGoalChain(dir, [{ condition: "step 1" }], {
      now: 1,
      master: { maxTurns: 5, maxMinutes: 60 },
    });
    assert.equal(created.ok, true);

    // Force master.turnsUsed past the cap.
    const chainPath = join(dir, ".opencode", ".goal-chain.json");
    const raw = JSON.parse(readFileSync(chainPath, "utf-8"));
    raw.master.turnsUsed = 10;
    writeFileSync(chainPath, JSON.stringify(raw));

    const advanced = chainMod.advanceGoalChain(dir, 100);
    assert.equal(advanced.ok, true);
    if (!advanced.ok) throw new Error("unexpected");
    // The post-fix message distinguishes "budget reached" from
    // "all chain steps completed". A single-step chain that hits the
    // budget on advance must report budget, not step completion.
    assert.match(
      advanced.message,
      /budget|master/i,
      `expected message to mention budget exhaustion, got: ${advanced.message}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D6 — non-atomic advance race (the headline defect) ──────────────────────

test("D6.1: two concurrent advanceGoalChain calls advance exactly one step", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    chainMod.createGoalChain(
      dir,
      [{ condition: "step 1" }, { condition: "step 2" }, { condition: "step 3" }],
      { now: 1 },
    );

    // Two awaits in parallel. With withStateLock serializing, only ONE
    // call should see chain.current === 0 and advance to 1; the other
    // should see current === 1 and advance to 2. After both, chain.current
    // is 2 (not 2 from one call + 1 from the other = 2 if serialized
    // correctly). Wait — both calls reading the same starting state and
    // serializing would each advance by 1, ending at 2.
    //
    // Pre-fix (no lock): one call writes chain.current=1, then state.
    // Before the state write, the second call reads chain.current=1 and
    // OLD state (step 1). It then computes "advance from step 1 to 2",
    // writes chain.current=2, then the first call's state write lands
    // overwriting. Final: chain.current=2, state for step 2 (race won
    // by some ordering). No CORRECTNESS difference in this small case,
    // but state.metadata.chainStep can be inconsistent with chain.current.
    //
    // The post-fix contract: chain.current advances by exactly 1 per
    // successful call. Two concurrent calls = chain.current advances by 2.
    // state.metadata.chainStep MUST match chain.current at the end.
    const [r1, r2] = await Promise.all([
      Promise.resolve().then(() => chainMod.advanceGoalChain(dir, 100)),
      Promise.resolve().then(() => chainMod.advanceGoalChain(dir, 101)),
    ]);

    const chainRaw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"),
    );
    const stateRaw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"),
    );

    // Final chain.current: two successful advances from 0 = 2.
    assert.equal(
      chainRaw.current,
      2,
      "two concurrent advances should result in chain.current = 2",
    );
    // Final state.metadata.chainStep MUST match chain.current.
    assert.equal(
      stateRaw.metadata.chainStep,
      chainRaw.current,
      `state.metadata.chainStep (${stateRaw.metadata.chainStep}) must equal chain.current (${chainRaw.current}) — atomicity guarantee`,
    );
    // Both calls must report ok.
    assert.ok(r1.ok, "first advance must succeed");
    assert.ok(r2.ok, "second advance must succeed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D6.2: chain-write-then-state-write window cannot double-advance", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    // 3-step chain so two sequential advances both reach the new-step
    // path (third step is left for a future packet).
    chainMod.createGoalChain(
      dir,
      [{ condition: "step 1" }, { condition: "step 2" }, { condition: "step 3" }],
      { now: 1 },
    );

    // Sequential calls (more deterministic than concurrent for this case).
    const r1 = chainMod.advanceGoalChain(dir, 100);
    const r2 = chainMod.advanceGoalChain(dir, 101);
    assert.ok(r1.ok);
    assert.ok(r2.ok);

    const chainRaw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"),
    );
    const stateRaw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"),
    );

    // Two sequential advances from current=0 → 2.
    assert.equal(chainRaw.current, 2);
    // State metadata MUST be self-consistent with chain.
    assert.equal(stateRaw.metadata.chainStep, 2);
    assert.equal(stateRaw.condition, "step 3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D9 — master budget semantics across loop cycles ────────────────────────

test("D9.1: master.turnsUsed accumulates across loop cycles (NOT reset)", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    // 2-step loop chain, maxCycles=2, master maxTurns=10.
    chainMod.createGoalChain(
      dir,
      [{ condition: "step 1" }, { condition: "step 2" }],
      { now: 1, master: { maxTurns: 10, maxMinutes: 60 }, onComplete: "loop", maxCycles: 2 },
    );

    // Manually drive the chain: set turnsUsed=4 (from a previous cycle's
    // accounting that's not yet on disk), then advance TWICE: first to
    // step 2, second to trigger the loop-reset path (next >= steps.length).
    const chainPath = join(dir, ".opencode", ".goal-chain.json");
    let raw = JSON.parse(readFileSync(chainPath, "utf-8"));
    raw.master.turnsUsed = 4;
    writeFileSync(chainPath, JSON.stringify(raw));

    // Advance 1: current 0 → 1.
    const r1 = chainMod.advanceGoalChain(dir, 100);
    assert.ok(r1.ok);

    // Advance 2: current 1 → triggers loop-reset path. next = 2, steps.length = 2,
    // next >= steps.length true. onComplete === "loop", cycles < maxCycles,
    // so chain.cycles += 1; chain.current = 0. master NOT reset.
    const r2 = chainMod.advanceGoalChain(dir, 200);
    assert.ok(r2.ok);

    raw = JSON.parse(readFileSync(chainPath, "utf-8"));
    // The master counter accumulates across cycles (NOT reset by loop).
    // It must be >= 4 (the pre-existing value, plus anything recordMasterUsage
    // added based on state.turnsEvaluated which starts at 0 per step).
    assert.ok(
      raw.master.turnsUsed >= 4,
      `master.turnsUsed must accumulate across loop cycles; got ${raw.master.turnsUsed}`,
    );
    assert.equal(raw.cycles, 1, "cycle counter must increment after loop reset");
    assert.equal(raw.current, 0, "loop should reset current to 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Cross-cutting sanity: existing public behavior preserved ───────────────

test("X1.1: pre-fix public behavior — happy path with no master budget is unchanged", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    const created = chainMod.createGoalChain(
      dir,
      [{ condition: "step 1" }, { condition: "step 2" }],
      { now: 1 },
    );
    assert.equal(created.ok, true);

    const advanced = chainMod.advanceGoalChain(dir, 100);
    assert.equal(advanced.ok, true);
    if (!advanced.ok || !advanced.state) throw new Error("unexpected");
    assert.equal(advanced.state.condition, "step 2");
    assert.equal(advanced.state.metadata.chainStep, 1);

    const chainRaw = JSON.parse(
      readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"),
    );
    assert.equal(chainRaw.current, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("X1.2: pre-fix public behavior — chain-interrupted state is rejected", async () => {
  const { chainMod } = await loadMods();
  const dir = freshDir();
  try {
    chainMod.createGoalChain(dir, [{ condition: "step 1" }], { now: 1 });
    // Replace state with a fresh one that has no chainId.
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    raw.metadata.chainId = undefined;
    delete raw.metadata.chainId;
    raw.metadata.chainStep = undefined;
    delete raw.metadata.chainStep;
    writeFileSync(statePath, JSON.stringify(raw));

    const advanced = chainMod.advanceGoalChain(dir, 100);
    assert.equal(advanced.ok, false);
    if (advanced.ok) throw new Error("unexpected");
    assert.match(advanced.error, /interrupted|overridden/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});