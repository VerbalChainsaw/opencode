/**
 * Tests for goal-chain.ts — chain CRUD, advancement, edge cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function freshDir() { return mkdtempSync(join(tmpdir(), "opengoal-chain-")); }
function cleanDir(d) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
function plantCorruptGoalState(dir) {
  const opencodeDir = join(dir, ".opencode");
  mkdirSync(opencodeDir, { recursive: true });
  const statePath = join(opencodeDir, ".goal-state.json");
  writeFileSync(statePath, "{not json", "utf-8");
  return statePath;
}
function plantCorruptGoalChain(dir) {
  const opencodeDir = join(dir, ".opencode");
  mkdirSync(opencodeDir, { recursive: true });
  const chainPath = join(opencodeDir, ".goal-chain.json");
  writeFileSync(chainPath, "{not json", "utf-8");
  return chainPath;
}

const { createGoalChain, readGoalChain, readGoalChainResult, advanceGoalChain, skipGoalChainStep, resetGoalChain, addChainStep, reorderChainStep, removeChainStep, setChainWebhook, validateGoalChain, CHAIN_FILE, MAX_CHAIN_SIZE } = await import("../dist/goal-chain.js");
const { readGoalState, writeGoalStateAtomic, transitionGoal, setGoal, setGoalFields, createHandoff, claimHandoff } = await import("../dist/goal-state.js");
const { dispatchGoalCommandStructured } = await import("../dist/command.js");

describe("createGoalChain", () => {
  it("writes chain file and sets step 0 as active goal", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "step one", command: "npm run a" },
        { condition: "step two", maxTurns: 10 },
      ]);
      assert.equal(res.ok, true);
      assert.ok(res.chain);
      assert.equal(res.chain.steps.length, 2);
      assert.equal(res.chain.current, 0);
      assert.ok(res.state);
      assert.equal(res.state.metadata.chainId, res.chain.id);
      assert.equal(res.state.metadata.chainStep, 0);
      assert.equal(res.state.metadata.chainTotal, 2);

      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.id, res.chain.id);

      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.metadata.chainId, chain.id);
    } finally { cleanDir(dir); }
  });

  it("rejects empty steps array", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, []);
      assert.equal(res.ok, false);
      assert.ok(res.error.includes("one step"));
    } finally { cleanDir(dir); }
  });

  it("rejects step with empty condition", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [{ condition: "" }]);
      assert.equal(res.ok, false);
    } finally { cleanDir(dir); }
  });

  it("preserves per-step agent pins and projects the active step agent to goal state", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "plan", agent: "explore" },
        { condition: "build", agent: "build" },
      ], { agentName: "default" });
      assert.equal(res.ok, true, res.error);

      const chain = readGoalChain(dir);
      assert.equal(chain.steps[0].agent, "explore");
      assert.equal(chain.steps[1].agent, "build");
      assert.equal(readGoalState(dir).metadata.agentName, "explore");

      const advanced = advanceGoalChain(dir);
      assert.equal(advanced.ok, true, advanced.error);
      assert.equal(advanced.state.metadata.agentName, "build");

      const reset = resetGoalChain(dir);
      assert.equal(reset.ok, true, reset.error);
      assert.equal(reset.state.metadata.agentName, "explore");
    } finally { cleanDir(dir); }
  });

  it("rejects empty per-step agent pins", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [{ condition: "plan", agent: "   " }]);
      assert.equal(res.ok, false);
      assert.match(res.error, /agent cannot be empty/);
    } finally { cleanDir(dir); }
  });

  it("surfaces corrupt current state before starting a chain", () => {
    const dir = freshDir();
    try {
      const statePath = plantCorruptGoalState(dir);

      const res = createGoalChain(dir, [{ condition: "first" }], { webhook: "from-state" });

      assert.equal(res.ok, false);
      assert.equal(res.reason, "corrupt-goal");
      assert.match(res.error, /Goal state file was corrupt/);
      assert.equal(existsSync(statePath), false, "corrupt state should be quarantined");
      assert.equal(existsSync(join(dir, CHAIN_FILE)), false, "chain should not be created");
      assert.ok(
        readdirSync(join(dir, ".opencode")).some((name) => name.startsWith(".goal-state.json.corrupt.")),
        "quarantined state artifact should remain visible",
      );
    } finally { cleanDir(dir); }
  });
});

describe("advanceGoalChain", () => {
  it("auto-advances to step 1 on achievement", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [
        { condition: "first" },
        { condition: "second" },
      ]);
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.ok(res.state);
      assert.equal(res.state.condition, "second");
      assert.equal(res.state.metadata.chainStep, 1);
    } finally { cleanDir(dir); }
  });

  it("completes chain after last step", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "only step" }]);
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.completed, true);
    } finally { cleanDir(dir); }
  });

  it("loops back to step 0 when onComplete=loop", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "a" }, { condition: "b" }], { onComplete: "loop", maxCycles: 5 });
      // Advance past step 0
      let res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.state.condition, "b");
      // Advance past step 1 → loop to step 0
      res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.state.condition, "a");
      assert.equal(res.state.metadata.chainStep, 0);

      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.cycles, 1);
    } finally { cleanDir(dir); }
  });

  it("stops after maxCycles loops", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "only" }], { onComplete: "loop", maxCycles: 2 });
      advanceGoalChain(dir); // cycle 0 complete, loop to cycle 1
      advanceGoalChain(dir); // cycle 1 complete → stopped (maxCycles=2 means 2 cycles, 0-indexed?)
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.completed, true);
    } finally { cleanDir(dir); }
  });

  it("returns error when chainId doesn't match (override guard)", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }]);
      // Manually override the goal to break the chain link
      const st = readGoalState(dir);
      st.metadata.chainId = "manual-override";
      writeGoalStateAtomic(dir, st);
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, false);
      assert.ok(res.error.includes("overridden"));
    } finally { cleanDir(dir); }
  });

  it("no chain → error", () => {
    const dir = freshDir();
    try {
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, false);
    } finally { cleanDir(dir); }
  });

  it("surfaces corrupt current state before advancing a live chain", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      assert.equal(create.ok, true);
      const chainBefore = readGoalChain(dir);
      const statePath = plantCorruptGoalState(dir);

      const res = advanceGoalChain(dir);

      assert.equal(res.ok, false);
      assert.match(res.error, /Goal state file was corrupt/);
      assert.equal(existsSync(statePath), false, "corrupt state should be quarantined");
      assert.deepEqual(readGoalChain(dir), chainBefore, "chain should not advance when current state is corrupt");
    } finally { cleanDir(dir); }
  });
});

describe("skipGoalChainStep", () => {
  it("skips without achievement", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "a" }, { condition: "b" }, { condition: "c" }]);
      const res = skipGoalChainStep(dir);
      assert.equal(res.ok, true);
      assert.equal(res.state.condition, "b");
    } finally { cleanDir(dir); }
  });
});

describe("addChainStep", () => {
  it("updates the active state's chainTotal when appending to a live chain", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      assert.equal(create.ok, true);

      const res = addChainStep(dir, "third");
      assert.equal(res.ok, true, `append should succeed; got: ${res.error}`);

      const chain = readGoalChain(dir);
      assert.equal(chain.steps.length, 3);
      const state = readGoalState(dir);
      assert.equal(state.metadata.chainTotal, 3);
      assert.equal(state.metadata.chainStep, 0);
    } finally { cleanDir(dir); }
  });

  it("promotes a standalone goal into a chain without dropping verification or limits", () => {
    const dir = freshDir();
    try {
      const set = setGoalFields(dir, {
        condition: "existing goal",
        verification: { type: "shell", command: "npm test" },
        maxTurns: 9,
        maxMinutes: 22,
      });
      assert.equal(set.ok, true);

      const res = addChainStep(dir, "follow-up");
      assert.equal(res.ok, true, `promotion should succeed; got: ${res.error}`);

      const chain = readGoalChain(dir);
      assert.equal(chain.steps.length, 2);
      assert.deepEqual(chain.steps[0].verification, { type: "shell", command: "npm test" });
      assert.equal(chain.steps[0].maxTurns, 9);
      assert.equal(chain.steps[0].maxMinutes, 22);
      const state = readGoalState(dir);
      assert.deepEqual(state.verification, { type: "shell", command: "npm test" });
      assert.equal(state.constraints.maxTurns, 9);
      assert.equal(state.constraints.maxTimeMinutes, 22);
      assert.equal(state.metadata.chainTotal, 2);
    } finally { cleanDir(dir); }
  });

  it("surfaces corrupt current state before appending to a live chain", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      assert.equal(create.ok, true);
      const chainBefore = readGoalChain(dir);
      const statePath = plantCorruptGoalState(dir);

      const res = addChainStep(dir, "third");

      assert.equal(res.ok, false);
      assert.match(res.error, /Goal state file was corrupt/);
      assert.equal(existsSync(statePath), false, "corrupt state should be quarantined");
      assert.deepEqual(readGoalChain(dir), chainBefore, "chain should not be mutated when current state is corrupt");
      assert.ok(
        readdirSync(join(dir, ".opencode")).some((name) => name.startsWith(".goal-state.json.corrupt.")),
        "quarantined state artifact should remain visible",
      );
    } finally { cleanDir(dir); }
  });
});

describe("reorderChainStep", () => {
  it("keeps active state metadata aligned when the current step index shifts", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }, { condition: "third" }]);
      assert.equal(create.ok, true);
      const advanced = advanceGoalChain(dir);
      assert.equal(advanced.ok, true);
      assert.equal(readGoalState(dir).metadata.chainStep, 1);

      const res = reorderChainStep(dir, 0, 2);
      assert.equal(res.ok, true, `reorder should succeed; got: ${res.error}`);

      const chain = readGoalChain(dir);
      assert.equal(chain.current, 0);
      assert.equal(chain.steps[chain.current].condition, "second");
      const state = readGoalState(dir);
      assert.equal(state.metadata.chainStep, 0);
      assert.equal(state.metadata.chainTotal, 3);
      assert.equal(state.condition, "second");
    } finally { cleanDir(dir); }
  });

  it("surfaces corrupt current state before reordering a live chain", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }, { condition: "third" }]);
      assert.equal(create.ok, true);
      const chainBefore = readGoalChain(dir);
      const statePath = plantCorruptGoalState(dir);

      const res = reorderChainStep(dir, 0, 2);

      assert.equal(res.ok, false);
      assert.match(res.error, /Goal state file was corrupt/);
      assert.equal(existsSync(statePath), false, "corrupt state should be quarantined");
      assert.deepEqual(readGoalChain(dir), chainBefore, "chain should not be reordered when current state is corrupt");
    } finally { cleanDir(dir); }
  });
});

describe("removeChainStep", () => {
  it("removes a pending future step and updates the active state's chainTotal", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [
        { condition: "first" },
        { condition: "second", model: { providerID: "openai", modelID: "gpt-5" }, skills: ["debug"] },
        { condition: "third" },
      ]);
      assert.equal(create.ok, true);

      const res = removeChainStep(dir, 1);
      assert.equal(res.ok, true, res.error);

      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.deepEqual(chain.steps.map((step) => step.condition), ["first", "third"]);
      assert.equal(chain.current, 0);

      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.metadata.chainTotal, 2);
    } finally { cleanDir(dir); }
  });

  it("rejects active or completed steps so an in-flight run cannot lose its current goal", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [
        { condition: "first" },
        { condition: "second" },
        { condition: "third" },
      ]);
      assert.equal(create.ok, true);

      let res = removeChainStep(dir, 0);
      assert.equal(res.ok, false);
      assert.match(res.error, /pending future steps/i);

      advanceGoalChain(dir);
      res = removeChainStep(dir, 0);
      assert.equal(res.ok, false);
      assert.match(res.error, /pending future steps/i);
      res = removeChainStep(dir, 1);
      assert.equal(res.ok, false);
      assert.match(res.error, /pending future steps/i);
    } finally { cleanDir(dir); }
  });

  it("validates structured model and skills metadata on chain steps", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        {
          condition: "model pinned step",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
          skills: ["frontend-design", "playwright"],
          category: "Testing",
          tone: "emerald",
          elevation: "raised",
        },
      ]);
      assert.equal(res.ok, true, res.error);
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.deepEqual(chain.steps[0].model, { providerID: "anthropic", modelID: "claude-sonnet-4" });
      assert.deepEqual(chain.steps[0].skills, ["frontend-design", "playwright"]);
      assert.equal(validateGoalChain(chain), true);
    } finally { cleanDir(dir); }
  });

  it("surfaces corrupt current state before removing a pending chain step", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }, { condition: "third" }]);
      assert.equal(create.ok, true);
      const chainBefore = readGoalChain(dir);
      const statePath = plantCorruptGoalState(dir);

      const res = removeChainStep(dir, 2);

      assert.equal(res.ok, false);
      assert.match(res.error, /Goal state file was corrupt/);
      assert.equal(existsSync(statePath), false, "corrupt state should be quarantined");
      assert.deepEqual(readGoalChain(dir), chainBefore, "chain should not remove steps when current state is corrupt");
    } finally { cleanDir(dir); }
  });
});

describe("setChainWebhook", () => {
  it("surfaces corrupt current state before changing chain webhook config", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      assert.equal(create.ok, true);
      const chainBefore = readGoalChain(dir);
      const statePath = plantCorruptGoalState(dir);

      const res = setChainWebhook(dir, { url: "https://example.com/hook", on: ["achieved"], allowLocal: false });

      assert.equal(res.ok, false);
      assert.match(res.error, /Goal state file was corrupt/);
      assert.equal(existsSync(statePath), false, "corrupt state should be quarantined");
      assert.deepEqual(readGoalChain(dir), chainBefore, "chain webhook should not change when current state is corrupt");
    } finally { cleanDir(dir); }
  });
});

describe("resetGoalChain", () => {
  it("resets to step 0", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "a" }, { condition: "b" }]);
      advanceGoalChain(dir); // now at step 1
      const res = resetGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.state.condition, "a");
      assert.equal(res.state.metadata.chainStep, 0);

      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.current, 0);
      assert.equal(chain.cycles, 0);
    } finally { cleanDir(dir); }
  });

  it("surfaces corrupt current state before resetting a live chain", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      advanceGoalChain(dir);
      const chainBefore = readGoalChain(dir);
      const statePath = plantCorruptGoalState(dir);

      const res = resetGoalChain(dir);

      assert.equal(res.ok, false);
      assert.match(res.error, /Goal state file was corrupt/);
      assert.equal(existsSync(statePath), false, "corrupt state should be quarantined");
      assert.deepEqual(readGoalChain(dir), chainBefore, "chain should not reset when current state is corrupt");
    } finally { cleanDir(dir); }
  });
});

describe("validateGoalChain", () => {
  function validChain(overrides = {}) {
    return {
      version: 1,
      id: "abc",
      steps: [{ condition: "x" }],
      current: 0,
      cycles: 0,
      maxCycles: 10,
      onComplete: "stop",
      metadata: { createdAt: 1, setBy: "user" },
      ...overrides,
    };
  }

  it("accepts a valid chain", () => {
    const c = validChain();
    assert.ok(validateGoalChain(c));
  });

  it("rejects missing steps", () => {
    assert.equal(validateGoalChain(validChain({ steps: [] })), false);
  });

  it("rejects invalid current index", () => {
    const c = validChain({ current: 5 });
    assert.equal(validateGoalChain(c), false);
  });

  it("rejects step with empty condition", () => {
    const c = validChain({ steps: [{ condition: "" }] });
    assert.equal(validateGoalChain(c), false);
  });

  it("rejects fractional indexes and counters that cannot safely index chain steps", () => {
    const invalidCases = [
      validChain({ current: 0.5 }),
      validChain({ cycles: 0.5 }),
      validChain({ maxCycles: 10.5 }),
      validChain({ steps: [{ condition: "x", maxTurns: 2.5 }] }),
      validChain({ steps: [{ condition: "x", maxMinutes: 2.5 }] }),
      validChain({ master: { maxTurns: 10.5, turnsUsed: 0, minutesUsed: 0 } }),
      validChain({ master: { maxMinutes: 10.5, turnsUsed: 0, minutesUsed: 0 } }),
      validChain({ master: { maxTurns: 10, turnsUsed: 0.5, minutesUsed: 0 } }),
      validChain({ master: { maxTurns: 10, turnsUsed: 0, minutesUsed: 0.5 } }),
    ];

    for (const c of invalidCases) {
      assert.equal(validateGoalChain(c), false, JSON.stringify(c));
    }
  });

  it("rejects fractional step budgets before writing a new chain", () => {
    const dir = freshDir();
    try {
      const turns = createGoalChain(dir, [{ condition: "x", maxTurns: 2.5 }]);
      assert.equal(turns.ok, false);
      assert.match(turns.error, /maxTurns/i);
      assert.equal(existsSync(join(dir, CHAIN_FILE)), false);

      const minutes = createGoalChain(dir, [{ condition: "x", maxMinutes: 2.5 }]);
      assert.equal(minutes.ok, false);
      assert.match(minutes.error, /maxMinutes/i);
      assert.equal(existsSync(join(dir, CHAIN_FILE)), false);
    } finally { cleanDir(dir); }
  });
});

describe("sanitizeMetadata preserves chainId", () => {
  it("chainId, chainStep, chainTotal survive restartGoal", async () => {
    const { restartGoal } = await import("../dist/goal-state.js");
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "restart me" }]);
      const res = restartGoal(dir);
      assert.equal(res.ok, true);
      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.metadata.chainId, readGoalChain(dir).id);
      assert.equal(state.metadata.chainStep, 0);
      assert.equal(state.metadata.chainTotal, 1);
    } finally { cleanDir(dir); }
  });
});

// ── Path (a): claimHandoff preserves chainId ─────────────────────────────
// Spec v0.4.0: "claimHandoff preserves chainId — claimed goal keeps chainId".
// `claimHandoff` routes the resumed state's metadata through `sanitizeMetadata`,
// which has chainId/chainStep/chainTotal on its allowlist. Pin that the
// handoff round-trip carries the chain association forward — a chain goal
// handed off in one session resumes in the next as the SAME chain step.

describe("Path (a): claimHandoff preserves chainId", () => {
  it("chainId, chainStep, chainTotal survive a handoff claim", () => {
    const dir = freshDir();
    try {
      // 1. Create a 2-step chain. Step 0 is active.
      const create = createGoalChain(dir, [
        { condition: "first" },
        { condition: "second" },
      ]);
      assert.ok(create.chain);
      const expectedChainId = create.chain.id;

      // 2. Hand the current goal off (with note).
      const ho = createHandoff(dir, "for tomorrow");
      assert.equal(ho.ok, true);

      // 3. Clear current goal (handoff can't be claimed while one is active).
      transitionGoal(dir, "clear");

      // 4. Claim the handoff. Pin that chainId/chStep survive.
      const claim = claimHandoff(dir);
      assert.equal(claim.ok, true);
      assert.ok(claim.state);
      assert.equal(claim.state.metadata.chainId, expectedChainId,
        "chainId must survive handoff claim");
      assert.equal(claim.state.metadata.chainStep, 0,
        "chainStep must survive handoff claim");
      assert.equal(claim.state.metadata.chainTotal, 2,
        "chainTotal must survive handoff claim");
    } finally { cleanDir(dir); }
  });

  it("harness: claimHandoff uses sanitizeMetadata (drops unknown metadata keys)", () => {
    // Defensive pin: the handoff path is the trust boundary. Even if a
    // planted handoff has extra metadata keys, only the allowlist survives.
    // (Sanity check on the security posture; the real value of this test
    // is that it documents the boundary.)
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "x" }]);
      assert.ok(create.chain);
      // Pre-poison the state with a junk metadata key.
      const st = readGoalState(dir);
      st.metadata.__attacker_planted = "should be dropped on claim";
      writeGoalStateAtomic(dir, st);
      const ho = createHandoff(dir);
      assert.equal(ho.ok, true);
      transitionGoal(dir, "clear");
      const claim = claimHandoff(dir);
      assert.equal(claim.ok, true);
      assert.ok(claim.state);
      assert.equal(claim.state.metadata.__attacker_planted, undefined,
        "unknown metadata keys must be dropped by sanitizeMetadata during claim");
      assert.ok(claim.state.metadata.chainId, "chainId should still survive");
    } finally { cleanDir(dir); }
  });
});

// ── v0.7.2: sanitizeMetadata preserves stepMarkerAt ───────────────────────
// Spec: "the runner persists it on the new step's state via
// `state.metadata.stepMarkerAt`. The marker scan in `evaluateByTranscript`
// uses this as a cutoff". The handoff path routes metadata through
// `sanitizeMetadata`; if the allowlist drops `stepMarkerAt`, a chain
// goal handed off mid-step would resume with no marker cutoff, and
// the prior step's stale GOAL_COMPLETE: would re-fire as the resumed
// step's completion. Pin that `sanitizeMetadata` carries the field
// forward, alongside chainId/chainStep/chainTotal.

describe("v0.7.2: sanitizeMetadata preserves stepMarkerAt", () => {
  it("stepMarkerAt survives a handoff claim", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [
        { condition: "first" },
        { condition: "second" },
      ]);
      assert.ok(create.chain);
      // Simulate the chain having advanced from step 0: the active
      // state is on step 1 with a stepMarkerAt from the prior step.
      const advance = advanceGoalChain(dir, Date.now(), { stepMarkerAt: 1234567890 });
      assert.equal(advance.ok, true);
      // Pin the state on disk has stepMarkerAt.
      const stBefore = readGoalState(dir);
      assert.equal(stBefore.metadata.stepMarkerAt, 1234567890,
        "precondition: stepMarkerAt should be set after advanceGoalChain");

      // Handoff → clear → claim.
      const ho = createHandoff(dir, "for the next session");
      assert.equal(ho.ok, true);
      transitionGoal(dir, "clear");
      const claim = claimHandoff(dir);
      assert.equal(claim.ok, true);
      assert.ok(claim.state);
      assert.equal(claim.state.metadata.stepMarkerAt, 1234567890,
        "stepMarkerAt must survive handoff claim — otherwise the resumed " +
        "step's marker scan would re-fire the prior step's GOAL_COMPLETE:");
    } finally { cleanDir(dir); }
  });

  it("stepMarkerAt survives restartGoal", async () => {
    const { restartGoal } = await import("../dist/goal-state.js");
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      // Move to step 1 with a stepMarkerAt.
      const advance = advanceGoalChain(dir, Date.now(), { stepMarkerAt: 9876543210 });
      assert.equal(advance.ok, true);

      // Restart the goal. The chain association survives (chainId/
      // chainStep/chainTotal are preserved) — and so must the cutoff.
      const res = restartGoal(dir);
      assert.equal(res.ok, true);
      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.metadata.stepMarkerAt, 9876543210,
        "stepMarkerAt must survive restartGoal — otherwise the restarted " +
        "step's marker scan would re-fire the prior step's GOAL_COMPLETE:");
    } finally { cleanDir(dir); }
  });

  it("unknown metadata keys still dropped; stepMarkerAt is the only new allowlist addition", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "x" }]);
      assert.ok(create.chain);
      const st = readGoalState(dir);
      // Sanity: a junk key + a valid stepMarkerAt.
      st.metadata.__attacker_planted = "should be dropped on claim";
      st.metadata.stepMarkerAt = 11111;
      writeGoalStateAtomic(dir, st);
      const ho = createHandoff(dir);
      assert.equal(ho.ok, true);
      transitionGoal(dir, "clear");
      const claim = claimHandoff(dir);
      assert.equal(claim.ok, true);
      assert.ok(claim.state);
      assert.equal(claim.state.metadata.__attacker_planted, undefined,
        "unknown keys still dropped by sanitizeMetadata");
      assert.equal(claim.state.metadata.stepMarkerAt, 11111,
        "stepMarkerAt carried through sanitizeMetadata");
    } finally { cleanDir(dir); }
  });
});

// ── Path (b): transitionGoal preserves chainId across clear→set cycle ────
// Spec scenario: "user clears a chain step, then sets a NEW goal" — the
// new goal should have NO chainId (it's not part of any chain). And
// conversely: a chain goal that is cleared (transitionGoal clear) and
// re-set (setGoal) starts a fresh state with no chainId, and the chain
// file is untouched (so it remains "interrupted" until reset).

describe("Path (b): transitionGoal / setGoal preserve-or-discard chainId correctly", () => {
  it("clear on a chain step does not lose the chain's state chainId; set creates a new id", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "step0" }]);
      assert.ok(create.chain);

      // Pin: state has chainId before clear.
      const before = readGoalState(dir);
      assert.equal(before.metadata.chainId, create.chain.id);

      // transitionGoal("clear") → status='cleared', completedAt set.
      // The metadata is preserved by transitionGoal (it only mutates status/timestamps).
      const t = transitionGoal(dir, "clear");
      assert.equal(t.ok, true);
      const after = readGoalState(dir);
      assert.equal(after.status, "cleared");
      // transitionGoal does not strip metadata; the chainId survives the clear,
      // although the goal is now terminal and won't be advanced.
      assert.equal(after.metadata.chainId, create.chain.id,
        "transitionGoal(clear) should not touch metadata.chainId");

      // Now set a NEW goal. setGoal creates a brand-new state with no chainId.
      const r = setGoal(dir, "different goal");
      assert.equal(r.ok, true);
      assert.equal(r.state.metadata.chainId, undefined,
        "setGoal (post-clear) starts a fresh state without chainId");
      assert.notEqual(r.state.id, before.id, "new state must have a new id");

      // The chain file is still present, pointing at step 0.
      const chain = readGoalChain(dir);
      assert.ok(chain, "chain file should be untouched by setGoal");
      assert.equal(chain.id, create.chain.id);
      assert.equal(chain.current, 0);
    } finally { cleanDir(dir); }
  });

  it("setGoal on a chain-active state interrupts the chain (next advance fails)", () => {
    // The override-guard path: when the user calls `set` while a chain is
    // active, setGoal replaces the state. The new state has no chainId,
    // so a SUBSEQUENT advanceGoalChain call must detect the mismatch and
    // refuse with the "interrupted" error. This is the spec's contract
    // for the override guard.
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [
        { condition: "first" },
        { condition: "second" },
      ]);
      assert.ok(create.chain);

      // Override: user calls setGoal.
      const r = setGoal(dir, "manual override");
      assert.equal(r.ok, true);
      assert.equal(r.state.metadata.chainId, undefined);

      // Next chain advance detects the mismatch and returns error.
      const adv = advanceGoalChain(dir);
      assert.equal(adv.ok, false);
      assert.ok(adv.error.includes("overridden"),
        `expected 'overridden' in error, got: ${adv.error}`);
    } finally { cleanDir(dir); }
  });
});

// ── Path (c): override guard — reset must not resurrect a stale chain over
// an unrelated replacement goal.

describe("Path (c): chain reset refuses to clobber an override", () => {
  it("override then chain reset is rejected and preserves the replacement goal", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      // Override.
      setGoal(dir, "manual override");
      // advance refused.
      const adv1 = advanceGoalChain(dir);
      assert.equal(adv1.ok, false);
      // chain reset should not restore a stale chain over the unrelated goal.
      const reset = resetGoalChain(dir);
      assert.equal(reset.ok, false);
      assert.match(reset.error, /overridden|interrupted/i);
      const state = readGoalState(dir);
      assert.equal(state.condition, "manual override");
      assert.equal(state.metadata.chainId, undefined);
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.current, 0);
    } finally { cleanDir(dir); }
  });
});

// ── Path (d): corrupt chain file (invalid JSON) → readGoalChain returns null ─

describe("Path (d): corrupt chain file", () => {
  it("invalid JSON → readGoalChain returns null", () => {
    const dir = freshDir();
    try {
      // Set up state and chain so the directory exists; then corrupt the chain.
      createGoalChain(dir, [{ condition: "x" }]);
      const chainPath = join(dir, CHAIN_FILE);
      writeFileSync(chainPath, "{not valid json", "utf-8");
      const chain = readGoalChain(dir);
      assert.equal(chain, null,
        "readGoalChain must return null for invalid JSON, not throw");
      // The state file is untouched.
      const st = readGoalState(dir);
      assert.ok(st, "state file should be untouched by corrupt chain file");
    } finally { cleanDir(dir); }
  });

  it("JSON-valid but wrong shape → readGoalChain returns null", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "x" }]);
      const chainPath = join(dir, CHAIN_FILE);
      // Valid JSON but missing required fields (e.g. no `id`).
      writeFileSync(chainPath, JSON.stringify({ version: 1, steps: [] }), "utf-8");
      const chain = readGoalChain(dir);
      assert.equal(chain, null, "shape-invalid chain must be rejected");
    } finally { cleanDir(dir); }
  });
});

// ── Path (e): oversized chain file (> MAX_CHAIN_SIZE) → readGoalChain returns null ─

describe("Path (e): oversized chain file", () => {
  it("file > 256KB → readGoalChain returns null", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "x" }]);
      const chainPath = join(dir, CHAIN_FILE);
      // 256KB is the cap; 257KB must be rejected.
      const oversize = "x".repeat(MAX_CHAIN_SIZE + 1024);
      writeFileSync(chainPath, JSON.stringify({
        version: 1,
        id: "abc",
        steps: [{ condition: "huge" }],
        current: 0,
        cycles: 0,
        maxCycles: 10,
        onComplete: "stop",
        metadata: { createdAt: 1, setBy: "user", junk: oversize },
      }), "utf-8");
      const chain = readGoalChain(dir);
      assert.equal(chain, null,
        `oversized chain (size > ${MAX_CHAIN_SIZE}) must be rejected`);
    } finally { cleanDir(dir); }
  });
});

// ── C-2 regression: thread corrupt-state signal through chain reader ────────
// The v0.4.0 `readGoalChain` collapsed three distinct failure modes
// (missing / oversize / corrupt) into a single `null`. A corrupt chain
// file was silently treated as "no chain" and the next
// `createGoalChain`/`advanceGoalChain` overwrote it, destroying mid-chain
// progress, webhook config, and the chain's UUID. v0.4.1 introduces a
// tri-state `ReadResult<GoalChain>` reader (`readGoalChainResult`) that
// distinguishes the three failure modes. On `corrupt`, the reader renames
// the file to `<original>.corrupt.<ts>` BEFORE returning so the user has
// a forensic recovery path. See REVIEW-V040-MULTI-ANGLE.md §2.2.

describe("C-2: readGoalChainResult tri-state reader", () => {
  it("missing chain file → {kind:'absent'} (the shim returns null)", () => {
    const dir = freshDir();
    try {
      const r = readGoalChainResult(dir);
      assert.equal(r.kind, "absent");
      assert.equal(readGoalChain(dir), null);
    } finally { cleanDir(dir); }
  });

  it("malformed JSON → {kind:'corrupt', reason:'parse'} and renames to .corrupt.<ts>", () => {
    const dir = freshDir();
    try {
      const chainPath = join(dir, CHAIN_FILE);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(chainPath, "{not valid json", "utf-8");
      const r = readGoalChainResult(dir);
      assert.equal(r.kind, "corrupt");
      if (r.kind === "corrupt") {
        assert.equal(r.reason, "parse");
        assert.ok(r.rawSize > 0);
      }
      // The original chain file is gone — renamed to .corrupt.<ts>.
      // The next createGoalChain can write a fresh chain without
      // overwriting the corrupt evidence.
      assert.equal(existsSync(chainPath), false,
        "corrupt chain file must be renamed, not left in place for a silent overwrite");
      const entries = readdirSync(join(dir, ".opencode"));
      const renamed = entries.find((e) => e.startsWith(".goal-chain.json.corrupt."));
      assert.ok(renamed, `expected a renamed .goal-chain.json.corrupt.<ts> file, got: ${entries.join(", ")}`);
      // The legacy shim returns null on corrupt (same as absent).
      assert.equal(readGoalChain(dir), null);
    } finally { cleanDir(dir); }
  });

  it("JSON-valid but wrong shape → {kind:'corrupt', reason:'validate'} and renames", () => {
    const dir = freshDir();
    try {
      const chainPath = join(dir, CHAIN_FILE);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      // Valid JSON but missing the required `id` field.
      writeFileSync(chainPath, JSON.stringify({ version: 1, steps: [] }), "utf-8");
      const r = readGoalChainResult(dir);
      assert.equal(r.kind, "corrupt");
      if (r.kind === "corrupt") {
        assert.equal(r.reason, "validate");
      }
      assert.equal(existsSync(chainPath), false,
        "schema-invalid chain file must be renamed");
    } finally { cleanDir(dir); }
  });

  it("fractional current index → {kind:'corrupt', reason:'validate'} and renames", () => {
    const dir = freshDir();
    try {
      const chainPath = join(dir, CHAIN_FILE);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(chainPath, JSON.stringify({
        version: 1,
        id: "abc",
        steps: [{ condition: "first" }, { condition: "second" }],
        current: 0.5,
        cycles: 0,
        maxCycles: 10,
        onComplete: "stop",
        metadata: { createdAt: 1, setBy: "user" },
      }), "utf-8");

      const r = readGoalChainResult(dir);

      assert.equal(r.kind, "corrupt");
      if (r.kind === "corrupt") assert.equal(r.reason, "validate");
      assert.equal(existsSync(chainPath), false, "fractional index chain file must be quarantined");
      assert.ok(
        readdirSync(join(dir, ".opencode")).some((entry) => entry.startsWith(".goal-chain.json.corrupt.")),
        "quarantined chain artifact should remain visible",
      );
    } finally { cleanDir(dir); }
  });

  it("oversize chain file → {kind:'corrupt', reason:'oversize'} and renames", () => {
    const dir = freshDir();
    try {
      const chainPath = join(dir, CHAIN_FILE);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      const oversize = "x".repeat(MAX_CHAIN_SIZE + 1024);
      writeFileSync(chainPath, JSON.stringify({
        version: 1,
        id: "abc",
        steps: [{ condition: "huge" }],
        current: 0,
        cycles: 0,
        maxCycles: 10,
        onComplete: "stop",
        metadata: { createdAt: 1, setBy: "user", junk: oversize },
      }), "utf-8");
      const r = readGoalChainResult(dir);
      assert.equal(r.kind, "corrupt");
      if (r.kind === "corrupt") {
        assert.equal(r.reason, "oversize");
        assert.ok(r.rawSize > MAX_CHAIN_SIZE);
      }
      assert.equal(existsSync(chainPath), false,
        "oversized chain file must be renamed");
    } finally { cleanDir(dir); }
  });

  it("bare /goal chain on corrupt chain → corrupt-state, not no active chain", () => {
    const dir = freshDir();
    try {
      const chainPath = join(dir, CHAIN_FILE);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(chainPath, "{not valid json", "utf-8");
      const res = dispatchGoalCommandStructured(dir, "chain");
      assert.equal(res.kind, "corrupt-state");
      assert.match(res.message, /corrupt/i);
      assert.equal(existsSync(chainPath), false);
      const entries = readdirSync(join(dir, ".opencode"));
      assert.ok(entries.find((e) => e.startsWith(".goal-chain.json.corrupt.")));
    } finally { cleanDir(dir); }
  });
});

describe("C-3: chain operations fail closed on corrupt chain files", () => {
  const cases = [
    ["advanceGoalChain", (dir) => advanceGoalChain(dir)],
    ["resetGoalChain", (dir) => resetGoalChain(dir)],
    ["setChainWebhook", (dir) => setChainWebhook(dir, { url: "https://example.com/hook", on: ["achieved"] })],
    ["addChainStep", (dir) => addChainStep(dir, "third")],
    ["reorderChainStep", (dir) => reorderChainStep(dir, 0, 1)],
    ["removeChainStep", (dir) => removeChainStep(dir, 1)],
  ];

  for (const [name, runOperation] of cases) {
    it(`${name} reports corrupt chain instead of treating it as absent`, () => {
      const dir = freshDir();
      try {
        const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
        assert.equal(create.ok, true, create.error);
        const stateBefore = readGoalState(dir);
        const chainPath = plantCorruptGoalChain(dir);

        const res = runOperation(dir);

        assert.equal(res.ok, false, `${name} should not succeed on a corrupt chain file`);
        assert.match(res.error, /Goal chain file was corrupt/);
        assert.equal(existsSync(chainPath), false, "corrupt chain should be quarantined");
        assert.equal(existsSync(join(dir, CHAIN_FILE)), false, "operation should not write a replacement chain file");
        assert.deepEqual(readGoalState(dir), stateBefore, "operation should not mutate current state");
        assert.ok(
          readdirSync(join(dir, ".opencode")).some((entry) => entry.startsWith(".goal-chain.json.corrupt.")),
          "quarantined chain artifact should remain visible",
        );
      } finally { cleanDir(dir); }
    });
  }
});

// ── Path (f): maxCycles semantics ────────────────────────────────────────
// Spec/TS: "maxCycles: number; // 0 = unlimited". Default in createGoalChain
// is 10. Pin both: the default, and that 0 = unlimited (no loop cap, only
// onComplete=stop halts the chain).

describe("Path (f): maxCycles semantics", () => {
  it("default maxCycles is 10 when not specified", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [{ condition: "x" }]);
      assert.ok(res.chain);
      assert.equal(res.chain.maxCycles, 10,
        "createGoalChain must default maxCycles to 10");
    } finally { cleanDir(dir); }
  });

  it("maxCycles=0 means unlimited: chain loops forever", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "only" }], { onComplete: "loop", maxCycles: 0 });
      // Run more advances than the old "default 10" cap; none should complete.
      for (let i = 0; i < 15; i++) {
        const r = advanceGoalChain(dir);
        assert.equal(r.ok, true);
        assert.notEqual(r.completed, true,
          `maxCycles=0 must NOT complete (unlimited); iter ${i}`);
      }
      const chain = readGoalChain(dir);
      assert.equal(chain.cycles, 15, "cycles should increment each loop");
    } finally { cleanDir(dir); }
  });

  it("maxCycles=2 with loop: completes after exactly 2 cycles", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "only" }], { onComplete: "loop", maxCycles: 2 });
      // Cycle 1: advance once → loop, cycles goes 0 → 1.
      const a1 = advanceGoalChain(dir);
      assert.equal(a1.ok, true);
      assert.notEqual(a1.completed, true);
      // Cycle 2: advance again → cap hit, returns completed (no further writes).
      const a2 = advanceGoalChain(dir);
      assert.equal(a2.ok, true);
      assert.equal(a2.completed, true,
        "maxCycles=2 must complete after 2 loops");
      assert.match(a2.message, /Chain completed after 2 cycles/);
      // A third advance should also report completed (the chain file is
      // unchanged because the second call returned before writing).
      const a3 = advanceGoalChain(dir);
      assert.equal(a3.ok, true);
      assert.equal(a3.completed, true,
        "further advances after maxCycles must also report completed");
      const chain = readGoalChain(dir);
      assert.ok(chain);
      // The second call returned early so cycles stays at 1 (the value
      // the first call wrote). Pin that the cap is enforced by early
      // return, not by clamping the counter.
      assert.equal(chain.cycles, 1,
        "cycles counter is not incremented once the cap is hit");
    } finally { cleanDir(dir); }
  });
});

// ── Path (g): chain display — 1 step, 1 step+loop, completed, cycles=N ──
// The display is the inline handler in command.ts: `chain` (no subcommand).
// We exercise the chain-display LOGIC by reading the chain file directly
// and asserting the markers/format match the spec section. The CLI e2e
// tests in test/cli-e2e.test.mjs cover the binary path.

describe("Path (g): chain display format", () => {
  function buildDisplayLines(chain) {
    // Mirrors src/command.ts:437-447 (chain handler). If that changes, this
    // test will fail and force a deliberate update of both.
    const lines = [
      `Chain: ${chain.id.slice(0, 8)} · ${chain.steps.length} steps · current: ${chain.current + 1}/${chain.steps.length}`,
      chain.onComplete === "loop"
        ? `Mode: loop (cycle ${chain.cycles + 1}${chain.maxCycles > 0 ? `/${chain.maxCycles}` : ""})`
        : "Mode: stop on completion",
      "",
    ];
    for (let i = 0; i < chain.steps.length; i++) {
      const marker = i < chain.current ? "✅" : i === chain.current ? "🎯" : "⬜";
      lines.push(`${marker} Step ${i + 1}: ${chain.steps[i].condition.slice(0, 80)}`);
    }
    return lines.join("\n");
  }

  it("1-step chain: current=0/1, no completion marker", () => {
    const chain = {
      version: 1, id: "abc12345-uuid", steps: [{ condition: "only step" }],
      current: 0, cycles: 0, maxCycles: 10, onComplete: "stop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    assert.match(out, /Chain: abc12345 · 1 steps · current: 1\/1/);
    assert.match(out, /Mode: stop on completion/);
    assert.match(out, /🎯 Step 1: only step/);
  });

  it("1-step + loop: mode is loop, cycle shown", () => {
    const chain = {
      version: 1, id: "abc12345-uuid", steps: [{ condition: "tick" }],
      current: 0, cycles: 2, maxCycles: 5, onComplete: "loop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    assert.match(out, /Mode: loop \(cycle 3\/5\)/);
  });

  it("1-step + loop, maxCycles=0: mode is loop, cycle shown with no cap", () => {
    const chain = {
      version: 1, id: "abc12345-uuid", steps: [{ condition: "tick" }],
      current: 0, cycles: 0, maxCycles: 0, onComplete: "loop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    // maxCycles=0 → "unlimited" → no "/N" suffix
    assert.match(out, /Mode: loop \(cycle 1\)/);
    assert.doesNotMatch(out, /Mode: loop \(cycle 1\/\d+\)/);
  });

  it("completed chain (current at last step, no achievement): markers show progress", () => {
    // 4-step chain, current=1 (step 2 active, step 1 done, steps 3-4 pending).
    const chain = {
      version: 1, id: "deploy-stand", steps: [
        { condition: "lint passes" },
        { condition: "tests pass" },
        { condition: "build succeeds" },
        { condition: "deploy to staging" },
      ],
      current: 1, cycles: 0, maxCycles: 10, onComplete: "stop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    assert.match(out, /✅ Step 1: lint passes/);
    assert.match(out, /🎯 Step 2: tests pass/);
    assert.match(out, /⬜ Step 3: build succeeds/);
    assert.match(out, /⬜ Step 4: deploy to staging/);
  });

  it("completed chain with cycles=N (loop done): cycle counter shown", () => {
    const chain = {
      version: 1, id: "loop-uuid", steps: [{ condition: "tick" }],
      current: 0, cycles: 3, maxCycles: 5, onComplete: "loop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    assert.match(out, /Mode: loop \(cycle 4\/5\)/);
  });
});

// ── Defect: stale chain operations after a state override ───────────────────
// Every live chain operation must share the same ownership guard: the current
// goal state has to belong to the chain file. Otherwise a stale chain artifact
// can clobber or mutate state for an unrelated replacement goal.

describe("stale chain ownership guards after override", () => {
  it("chain skip after set override is rejected (guard applies via advanceGoalChain)", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      setGoal(dir, "manual override");
      const res = skipGoalChainStep(dir);
      assert.equal(res.ok, false,
        "chain skip delegates to advanceGoalChain, which checks chainId");
      assert.ok(res.error.includes("overridden"),
        `expected 'overridden' in error, got: ${res.error}`);
    } finally { cleanDir(dir); }
  });

  it("chain reset after set override is rejected and preserves the unrelated goal", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      setGoal(dir, "manual override");
      const before = readGoalState(dir);
      const res = resetGoalChain(dir);
      assert.equal(res.ok, false,
        "chain reset must not reattach a stale chain to an unrelated goal");
      assert.match(res.error, /overridden|interrupted/i);
      assert.deepEqual(readGoalState(dir), before);
    } finally { cleanDir(dir); }
  });

  for (const [name, runOperation] of [
    ["setChainWebhook", (dir) => setChainWebhook(dir, { url: "https://example.com/hook", on: ["achieved"] })],
    ["addChainStep", (dir) => addChainStep(dir, "third")],
    ["reorderChainStep", (dir) => reorderChainStep(dir, 0, 1)],
    ["removeChainStep", (dir) => removeChainStep(dir, 1)],
  ]) {
    it(`${name} after set override is rejected and preserves state plus stale chain`, () => {
      const dir = freshDir();
      try {
        createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
        setGoal(dir, "manual override");
        const stateBefore = readGoalState(dir);
        const chainBefore = readGoalChain(dir);

        const res = runOperation(dir);

        assert.equal(res.ok, false, `${name} must reject a stale chain artifact`);
        assert.match(res.error, /overridden|interrupted/i);
        assert.deepEqual(readGoalState(dir), stateBefore);
        assert.deepEqual(readGoalChain(dir), chainBefore);
      } finally { cleanDir(dir); }
    });
  }
});

// ── Defect E-2: validateGoalChain accepts malformed `step.verification` ────
// REVIEW-V040-MULTI-ANGLE.md §2.4. A chain file with a malformed
// `verification` (e.g. { type: "BANANA" }) on any step previously passed
// validation; when that step became active via advanceGoalChain, the new
// state had the malformed verification, the next readGoalState rejected it,
// and the chain silently died mid-way. The fix mirrors goal-state.ts:223-233
// in the chain validator's step loop. These tests pin the four cases:
//   1. malformed verification → createGoalChain returns ok:false, error
//      names the step index, chain file is NOT written
//   2. verification: null (unset) → accepted
//   3. verification: { type: "shell", command: "npm test" } → accepted
//   4. verification: { type: "shell" } (missing required field) → rejected
// Plus a validator-level pin (validateGoalChain returns false on a hand-
// crafted chain object with a malformed verification on step 1).

describe("E-2: chain validator rejects malformed step.verification", () => {
  it("createGoalChain rejects a chain with malformed verification on step 2; names step index; writes nothing", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "valid first step" },
        { condition: "valid second step", verification: { type: "BANANA" } },
      ]);
      assert.equal(res.ok, false, "createGoalChain must reject a malformed step.verification");
      assert.ok(res.error.includes("Step 2"),
        `error must name the offending step index, got: ${res.error}`);
      assert.match(res.error, /verification/,
        `error must mention verification, got: ${res.error}`);
      // The validator runs BEFORE the write — chain file must not exist.
      const chain = readGoalChain(dir);
      assert.equal(chain, null,
        "chain file must NOT be written when the validator rejects the chain");
    } finally { cleanDir(dir); }
  });

  it("createGoalChain accepts verification: null (unset)", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "first", verification: null },
        { condition: "second" },
      ]);
      assert.equal(res.ok, true, `unset verification must be accepted; error: ${res.error}`);
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.steps[0].verification, null);
    } finally { cleanDir(dir); }
  });

  it("createGoalChain accepts a valid shell verification { type: 'shell', command: 'npm test' }", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "run the tests", verification: { type: "shell", command: "npm test" } },
        { condition: "then build" },
      ]);
      assert.equal(res.ok, true, `valid shell verification must be accepted; error: ${res.error}`);
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.steps[0].verification.type, "shell");
      assert.equal(chain.steps[0].verification.command, "npm test");
      // Pin: the active state's verification mirrors the step's.
      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.verification.type, "shell");
      assert.equal(state.verification.command, "npm test");
    } finally { cleanDir(dir); }
  });

  it("createGoalChain rejects shell verification missing the required 'command' field", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "first" },
        { condition: "bad shell", verification: { type: "shell" } },
      ]);
      assert.equal(res.ok, false, "shell verification without 'command' must be rejected");
      assert.ok(res.error.includes("Step 2"),
        `error must name the offending step index, got: ${res.error}`);
      assert.match(res.error, /command/,
        `error must mention the missing field, got: ${res.error}`);
      const chain = readGoalChain(dir);
      assert.equal(chain, null, "chain file must NOT be written on validation failure");
    } finally { cleanDir(dir); }
  });

  it("validateGoalChain returns false for a hand-crafted chain with malformed step.verification", () => {
    // The validator-level pin: even if a chain file is hand-edited with a
    // malformed verification on step 2, readGoalChain (which calls
    // validateGoalChain) must return null. This is the on-disk trust-
    // boundary path; without this check, readGoalChain would return the
    // poisoned chain object and advanceGoalChain would propagate the
    // malformed verification into a state file that the state validator
    // then rejects — chain silently dies mid-way.
    const c = {
      version: 1,
      id: "abc",
      steps: [
        { condition: "step one" },
        { condition: "step two", verification: { type: "BANANA" } },
      ],
      current: 0,
      cycles: 0,
      maxCycles: 10,
      onComplete: "stop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    assert.equal(validateGoalChain(c), false,
      "validateGoalChain must reject a chain whose step has a malformed verification");
  });
});

// ── Coverage gaps (Batch 2) ──────────────────────────────────────────────
// Two narrow pin-tests for code paths the prior suite didn't cover:
//   1. removeChainStep refuses to remove the sole step in a 1-step chain
//      (src/goal-chain.ts:946).
//   2. reorderChainStep on a multi-step chain anchored to a non-zero
//      `current` keeps the active step current by adjusting the index
//      forward (src/goal-chain.ts:900-912).

describe("Coverage: removeChainStep guards", () => {
  it("refuses to remove the only step in a 1-step chain", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "sole" }]);
      assert.equal(create.ok, true);

      const res = removeChainStep(dir, 0);
      assert.equal(res.ok, false, "removing the only step must fail");
      assert.match(res.error, /Cannot remove the only chain step/,
        `expected 'Cannot remove the only chain step' in error; got: ${res.error}`);

      // The chain file is unchanged.
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.steps.length, 1);
      assert.equal(chain.steps[0].condition, "sole");
    } finally { cleanDir(dir); }
  });

  it("removes the only step from a terminal chain by deleting the chain file", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "sole" }]);
      assert.equal(create.ok, true);

      const state = readGoalState(dir);
      state.status = "achieved";
      state.completedAt = Date.now();
      writeGoalStateAtomic(dir, state);

      const res = removeChainStep(dir, 0);
      assert.equal(res.ok, true, `terminal remove should succeed; got: ${res.error}`);
      assert.equal(readGoalChain(dir), null, "removing the last terminal step should remove the chain");
      assert.equal(existsSync(join(dir, CHAIN_FILE)), false, "chain file should be gone after the last step is removed");
    } finally { cleanDir(dir); }
  });
});

describe("stop/cancel chain advance guards", () => {
  it("advanceGoalChain refuses to advance a cleared chain state even when chainId still matches", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      assert.equal(create.ok, true);

      const clear = transitionGoal(dir, "clear");
      assert.equal(clear.ok, true, `precondition: clear should succeed; got: ${clear.error}`);

      const res = advanceGoalChain(dir);
      assert.equal(res.ok, false, "a stopped chain must not advance from a cleared state");
      assert.match(res.error, /cleared|stopped|interrupted/i);

      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.current, 0, "failed advance must not move chain.current");
      assert.equal(readGoalState(dir).condition, "first", "failed advance must not activate the next step");
      assert.equal(readGoalState(dir).status, "cleared");
    } finally { cleanDir(dir); }
  });

  it("resetGoalChain refuses to resurrect a cleared chain state", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      assert.equal(create.ok, true);

      const clear = transitionGoal(dir, "clear");
      assert.equal(clear.ok, true, `precondition: clear should succeed; got: ${clear.error}`);
      const before = readGoalState(dir);

      const res = resetGoalChain(dir);

      assert.equal(res.ok, false, "chain reset must not restart a user-stopped chain");
      assert.match(res.error, /cleared|stopped|interrupted/i);
      assert.deepEqual(readGoalState(dir), before);
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.current, 0, "failed reset must not move chain.current");
    } finally { cleanDir(dir); }
  });

  it("clear can cancel an achieved chain step before the orchestrator advances it", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      assert.equal(create.ok, true);

      const state = readGoalState(dir);
      state.status = "achieved";
      state.completedAt = Date.now();
      writeGoalStateAtomic(dir, state);

      const clear = transitionGoal(dir, "clear");
      assert.equal(clear.ok, true, `clear should cancel the achieved step; got: ${clear.error}`);
      assert.equal(readGoalState(dir).status, "cleared");

      const res = advanceGoalChain(dir);
      assert.equal(res.ok, false, "a user-cleared achieved step must not advance afterward");
      assert.match(res.error, /cleared|stopped|interrupted/i);
      assert.equal(readGoalState(dir).condition, "first");
    } finally { cleanDir(dir); }
  });
});

describe("Coverage: reorderChainStep active-step anchoring", () => {
  it("adjusts chain.current forward (1→2) when a move pushes the active step to a later index", () => {
    // Setup: 3-step chain, advance to step 1 (the "beta" step is active).
    // Then move the step at index 2 ("gamma") to index 0. After the move,
    // the array is ["gamma", "alpha", "beta"]; the originally active
    // step "beta" is now at index 2. The active-step anchor logic
    // (src/goal-chain.ts:905) detects this case and increments
    // chain.current from 1 → 2 so the same logical step stays current.
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [
        { condition: "alpha" },
        { condition: "beta" },
        { condition: "gamma" },
      ]);
      assert.equal(create.ok, true);

      const advanced = advanceGoalChain(dir);
      assert.equal(advanced.ok, true);
      const before = readGoalState(dir);
      assert.equal(before.metadata.chainStep, 1,
        "precondition: chainStep should be 1 after advance");

      const res = reorderChainStep(dir, 2, 0);
      assert.equal(res.ok, true, `reorder should succeed; got: ${res.error}`);

      // Step order updated: gamma moved to the front.
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.deepEqual(
        chain.steps.map((s) => s.condition),
        ["gamma", "alpha", "beta"],
        "step order should reflect the move (2→0)"
      );

      // chain.current incremented (1→2) to keep "beta" current.
      assert.equal(chain.current, 2,
        "chain.current should increment (1→2) to keep the originally active step current");
      assert.equal(chain.steps[chain.current].condition, "beta",
        "the step at chain.current should be the originally active step");

      // state.metadata.chainStep mirrors chain.current.
      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.metadata.chainStep, chain.current,
        "state.metadata.chainStep should mirror chain.current after the reorder");
      assert.equal(state.metadata.chainTotal, 3,
        "state.metadata.chainTotal should be unchanged (still 3 steps)");
      assert.equal(state.condition, "beta",
        "state.condition should still reference the originally active step");
    } finally { cleanDir(dir); }
  });

  it("adjusts chain.current forward when a future step moves onto the current index", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [
        { condition: "alpha" },
        { condition: "beta" },
        { condition: "gamma" },
      ]);
      assert.equal(create.ok, true);

      const advanced = advanceGoalChain(dir);
      assert.equal(advanced.ok, true);
      assert.equal(readGoalState(dir).metadata.chainStep, 1);

      const res = reorderChainStep(dir, 2, 1);
      assert.equal(res.ok, true, `reorder should succeed; got: ${res.error}`);

      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.deepEqual(chain.steps.map((s) => s.condition), ["alpha", "gamma", "beta"]);
      assert.equal(chain.current, 2);
      assert.equal(chain.steps[chain.current].condition, "beta");

      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.metadata.chainStep, 2);
      assert.equal(state.metadata.chainTotal, 3);
      assert.equal(state.condition, "beta");
    } finally { cleanDir(dir); }
  });
});
