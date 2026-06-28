/**
 * F-4 (v0.5.0) — `watch` live terminal dashboard regression coverage.
 *
 * Spec: packages/autogoal/specs/v0.5.0-feature-work-orders.md §F-4.
 *
 * The F-4 contract (paraphrased from the spec):
 *
 *   - `opencode-autogoal [--dir] watch [--interval <ms>]`
 *   - Non-TTY (piped/CI): print ONE frame, no ANSI clear, exit 0
 *     immediately (CI/pipe safe — this is the e2e test path).
 *   - TTY: long-running render loop; clear screen + home each tick;
 *     SIGINT → exit 0.
 *   - `--interval` clamps to [250, 60000]; out of range → usage error,
 *     exit 1.
 *   - `--json watch` is an explicit usage error, exit 1.
 *   - Frame content comes from `renderWatchFrame`, a pure exported fn
 *     (src/cli.ts:563) with NO ANSI inside (the clear codes live in
 *     the render loop, not the frame).
 *   - Frame covers: header, condition, progress bar (█/░), turns ·
 *     time · tokens, lastReason, steeringCount, chainStep,
 *     handoffPending, footer `ctrl-c to exit · polling every <n>s`.
 *
 * Coverage gaps closed by this file (spec §F-4 "Tests first" list,
 * lines 240-244, was unfulfilled):
 *
 *   1. renderWatchFrame unit tests per state (active/paused/corrupt/absent)
 *   2. interval clamp boundary tests
 *   3. e2e: spawn `watch` with stdout piped (non-TTY) in temp dir →
 *      exactly one frame, exit 0, contains "No goal set."
 *
 * Fixture strategy: use the exported `createGoalState` helper from
 * `dist/goal-state.js` as the canonical GoalState factory, then mutate
 * the returned object for the test scenario (status, metadata.steering,
 * metadata.chainStep/Total, lastEvaluation). Each fixture is asserted
 * against `validateGoalState` so the test catches any drift that
 * breaks the canonical shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { renderWatchFrame } from "../dist/cli.js";
import { presentGoalState } from "../dist/gui.js";
import {
  createGoalState,
  validateGoalState,
  DEFAULT_CONSTRAINTS,
} from "../dist/goal-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const NODE = process.execPath;

// Deterministic "now" so progress/elapsed math is stable across runs.
const NOW = 1_700_000_000_000;
const WIDTH = 80;

/**
 * Canonical GoalState factory. Uses `createGoalState` (the only
 * exported builder in goal-state.ts) and asserts the returned shape
 * passes `validateGoalState` before any test sees it — so a future
 * schema drift that breaks validation surfaces in THIS helper, not
 * in every individual test.
 */
function makeState(overrides = {}) {
  const base = createGoalState(
    {
      condition: "all tests pass",
      command: null,
      constraints: { ...DEFAULT_CONSTRAINTS },
      custom: false,
    },
    "user",
    NOW - 60_000,
  );
  // Apply overrides (e.g. status: "paused", turnsEvaluated, metadata).
  const merged = {
    ...base,
    ...overrides,
    // Merge metadata instead of replacing (preserves setBy).
    metadata: { ...base.metadata, ...(overrides.metadata ?? {}) },
  };
  // Confirm the fixture is canonical-shape. If this throws, every
  // test in this file would otherwise fail with a confusing
  // unrelated error.
  assert.equal(
    validateGoalState(merged),
    true,
    `fixture failed validateGoalState: ${JSON.stringify(merged)}`,
  );
  return merged;
}

function makeResult(state, opts = {}) {
  return {
    state: state ?? null,
    corrupt: opts.corrupt ?? false,
    summary: opts.summary ?? "",
  };
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-watch-"));
}

function runCli(dir, args, opts = {}) {
  return spawnSync(NODE, [CLI, "--dir", dir, ...args], {
    encoding: "utf-8",
    timeout: opts.timeout ?? 10_000,
  });
}

// ── Phase 3: pure renderWatchFrame unit tests ────────────────────────

test("renderWatchFrame: active goal frame includes condition, bar, percent, turns, time, tokens, lastReason, footer", () => {
  const state = makeState({
    turnsEvaluated: 5,
    tokensUsed: 12_000,
    lastEvaluation: {
      met: false,
      reason: "3 tests still failing",
      confidence: 1,
      timestamp: NOW - 5_000,
      evaluatorType: "deterministic",
    },
  });
  const frame = renderWatchFrame(makeResult(state), false, null, WIDTH, NOW, 2000);

  // Header + condition line.
  assert.match(frame, /all tests pass/);
  // Progress bar (block + light block + percent).
  assert.match(frame, /█/);
  assert.match(frame, /░/);
  assert.match(frame, /\d+%/);
  // Counts and labels.
  assert.match(frame, /5\/20/);
  assert.match(frame, /\d+m elapsed/);
  // Last evaluation reason.
  assert.match(frame, /Last: 3 tests still failing/);
  // Footer with refresh interval.
  assert.match(frame, /ctrl-c to exit/);
  assert.match(frame, /2s/);
});

test("renderWatchFrame: paused goal visibly reports paused and still identifies the goal", () => {
  const state = makeState({
    status: "paused",
    pausedAt: NOW - 10_000,
  });
  const frame = renderWatchFrame(makeResult(state), false, null, WIDTH, NOW, 2000);
  // statusLabel for paused is "Paused" (src/gui.ts:351).
  assert.match(frame, /Paused/);
  assert.match(frame, /all tests pass/);
});

test("renderWatchFrame: no-goal frame reports 'No goal set' and includes the set-command hint", () => {
  const frame = renderWatchFrame(makeResult(null), false, null, WIDTH, NOW, 2000);
  assert.match(frame, /No goal set/);
  // Hint mentions the `set` command.
  assert.match(frame, /opencode-autogoal set/);
});

test("renderWatchFrame: corrupt-state frame reports corruption, includes summary and quarantine artifact", () => {
  const frame = renderWatchFrame(
    makeResult(null, { corrupt: true, summary: "Failed to parse JSON" }),
    false,
    ".goal-state.json.corrupt.123",
    WIDTH,
    NOW,
    2000,
  );
  assert.match(frame, /corrupt/i);
  assert.match(frame, /Failed to parse JSON/);
  assert.match(frame, /Quarantined:.*\.goal-state\.json\.corrupt\.123/);
});

test("renderWatchFrame: steering produces singular count for one entry, plural for multiple", () => {
  const oneState = makeState({
    metadata: {
      steering: [{ at: NOW, note: "focus on auth" }],
    },
  });
  const oneFrame = renderWatchFrame(makeResult(oneState), false, null, WIDTH, NOW, 2000);
  assert.match(oneFrame, /1 steering note\b/);

  const threeState = makeState({
    metadata: {
      steering: [
        { at: NOW, note: "focus on auth" },
        { at: NOW, note: "skip flaky test" },
        { at: NOW, note: "use smaller fixtures" },
      ],
    },
  });
  const threeFrame = renderWatchFrame(makeResult(threeState), false, null, WIDTH, NOW, 2000);
  assert.match(threeFrame, /3 steering notes/);
});

test("renderWatchFrame: chain progress is displayed 1-based (D2 fix)", () => {
  // Canonical `metadata.chainStep` is 0-based storage (goal-state.ts:79-80).
  // D2 fix (CENTER-AUDIT 2026-06-27): the watch frame now displays it
  // 1-based to match every other user-facing surface (doctor line
  // cli.ts:262, sidebar-logic, goal-blocks, control-center-pane all +1).
  // Pre-fix this surface was the lone 0-based one, so the first step of a
  // chain rendered "chain step 0/N". The +1 lives at the cli.ts print site
  // ONLY — presentGoalState's projection stays 0-based (regression below).
  //
  // Stored chainStep=1 (the 2nd step, 0-based) → display "chain step 2/4".
  const state = makeState({
    metadata: {
      chainId: "c1",
      chainStep: 1,
      chainTotal: 4,
    },
  });
  const frame = renderWatchFrame(makeResult(state), false, null, WIDTH, NOW, 2000);
  assert.match(frame, /chain step/);
  assert.match(frame, /\/4\b/);
  assert.match(frame, /chain step 2\/4/);
});

test("renderWatchFrame: first chain step displays 1/N, not 0/N (D2 regression)", () => {
  // The headline symptom of the D2 bug: the first step (stored chainStep=0)
  // must render "chain step 1/3", never "chain step 0/3".
  const state = makeState({
    metadata: {
      chainId: "c1",
      chainStep: 0,
      chainTotal: 3,
    },
  });
  const frame = renderWatchFrame(makeResult(state), false, null, WIDTH, NOW, 2000);
  assert.match(frame, /chain step 1\/3/);
  assert.doesNotMatch(frame, /chain step 0\/3/);
});

test("presentGoalState projection keeps chainStep 0-based (D2 double-increment guard)", () => {
  // The +1 must live ONLY at the cli.ts display boundary. presentGoalState's
  // chainStep.current must stay equal to the stored 0-based metadata, because
  // other consumers (control-center-pane, control-center-logic) read this
  // projection and add their OWN +1 — moving the offset here would render
  // current+2 on those surfaces.
  const state = makeState({
    metadata: { chainId: "c1", chainStep: 2, chainTotal: 5 },
  });
  const projected = presentGoalState(state, false, NOW);
  assert.equal(projected.chainStep.current, 2);
  assert.equal(projected.chainStep.total, 5);
});

test("renderWatchFrame: handoff presence is displayed", () => {
  const state = makeState();
  const frame = renderWatchFrame(makeResult(state), true, null, WIDTH, NOW, 2000);
  assert.match(frame, /handoff pending/);
});

test("renderWatchFrame: output contains no ESC character (ANSI purity)", () => {
  // Spec §F-4 line 228: "NO ANSI inside [the frame]; the clear codes
  // live in the render loop". Test the invariant strictly.
  const state = makeState({
    turnsEvaluated: 5,
    tokensUsed: 12_000,
    lastEvaluation: {
      met: false,
      reason: "x",
      confidence: 1,
      timestamp: NOW,
      evaluatorType: "deterministic",
    },
    metadata: {
      chainId: "c1",
      chainStep: 0,
      chainTotal: 2,
      steering: [{ at: NOW, note: "x" }],
    },
  });
  const frame = renderWatchFrame(makeResult(state), true, null, WIDTH, NOW, 2000);
  assert.equal(
    frame.includes("\x1b"),
    false,
    `frame contains an ESC character: ${JSON.stringify(frame)}`,
  );
});

test("renderWatchFrame: narrow width clamps state-derived lines", () => {
  // Width clamping must not produce uncontrolled long lines. Spec does
  // not pin exact widths — assert that EVERY line fits within the
  // requested width (with the standard clamp allowance of one
  // trailing `…` on a single-line overflow). Lines that have content
  // beyond the clamp budget must end with `…` (the single-char
  // ellipsis used by the clamp at src/cli.ts:572).
  const state = makeState({
    condition: "a".repeat(200),
    turnsEvaluated: 5,
    lastEvaluation: {
      met: false,
      reason: "reason " + "x".repeat(200),
      confidence: 1,
      timestamp: NOW,
      evaluatorType: "deterministic",
    },
  });
  const narrowWidth = 30;
  const frame = renderWatchFrame(makeResult(state), false, null, narrowWidth, NOW, 2000);
  const lines = frame.split("\n");
  for (const line of lines) {
    // Allow the clamp trailing ellipsis on overflow.
    if (line.length > narrowWidth) {
      assert.ok(
        line.endsWith("…"),
        `line longer than width ${narrowWidth} without ellipsis: ${JSON.stringify(line)} (len=${line.length})`,
      );
      // Clamp truncates to width-1 chars then adds `…` (src/cli.ts:572).
      assert.ok(
        line.length <= narrowWidth,
        `line length ${line.length} exceeds width ${narrowWidth}: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("renderWatchFrame: interval footer formats 500ms as 0.5s and 5000ms as 5s", () => {
  const state = makeState();
  const result = makeResult(state);
  const frame500 = renderWatchFrame(result, false, null, WIDTH, NOW, 500);
  assert.match(frame500, /0\.5s/);
  const frame5000 = renderWatchFrame(result, false, null, WIDTH, NOW, 5000);
  assert.match(frame5000, /\b5s\b/);
});

// ── Phase 4: --interval clamp e2e (real CLI binary) ───────────────────

test("e2e: watch --interval 249 is rejected with exit 1", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["watch", "--interval", "249"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /250/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch --interval 250 is accepted (boundary lower)", () => {
  const dir = freshDir();
  try {
    // Non-TTY path: 250ms is accepted, prints one frame, exits 0.
    const r = runCli(dir, ["watch", "--interval", "250"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /ctrl-c to exit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch --interval 60000 is accepted (boundary upper)", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["watch", "--interval", "60000"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /ctrl-c to exit/);
    // 60000ms formats as "60s" (intervalMs / 1000 with no decimals).
    assert.match(r.stdout, /60s/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch --interval 60001 is rejected with exit 1", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["watch", "--interval", "60001"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /60000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch --interval 0 is rejected with exit 1", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["watch", "--interval", "0"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /250/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch --interval -1 (negative) is rejected with exit 1", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["watch", "--interval", "-1"]);
    assert.equal(r.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch --interval abc (nonnumeric) is rejected with exit 1", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["watch", "--interval", "abc"]);
    assert.equal(r.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch --interval 1.5 (fractional) is rejected with exit 1", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["watch", "--interval", "1.5"]);
    assert.equal(r.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch --interval (missing value) is rejected with exit 1", () => {
  // --interval with no value after it: parsePositiveInt("") returns null.
  const dir = freshDir();
  try {
    const r = runCli(dir, ["watch", "--interval"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--interval/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Phase 5: non-TTY e2e ─────────────────────────────────────────────

test("e2e: watch in empty dir (non-TTY) prints one frame, 'No goal set', no ESC, exit 0", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["watch"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /No goal set/);
    assert.match(r.stdout, /ctrl-c to exit/);
    // No ANSI clear codes.
    assert.equal(r.stdout.includes("\x1b"), false, `watch stdout contains ESC: ${JSON.stringify(r.stdout)}`);
    // Exactly one frame: the frame ends with a trailing newline.
    // The single-shot non-TTY path prints `<frame>\n`, so the output
    // must end with a newline and have no spurious extra frame markers
    // (the footer `ctrl-c to exit` appears exactly once).
    const ctrls = (r.stdout.match(/ctrl-c to exit/g) ?? []).length;
    assert.equal(ctrls, 1, `expected one footer line, got ${ctrls}\nstdout: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch with active goal (non-TTY) prints one frame containing the condition, exit 0", () => {
  const dir = freshDir();
  try {
    const setR = runCli(dir, ["set", "lint passes", "--command", "npm run lint"]);
    assert.equal(setR.status, 0, `set should exit 0: ${setR.stderr}`);

    const r = runCli(dir, ["watch"]);
    assert.equal(r.status, 0, `expected exit 0: stderr=${r.stderr}`);
    assert.match(r.stdout, /lint passes/);
    const ctrls = (r.stdout.match(/ctrl-c to exit/g) ?? []).length;
    assert.equal(ctrls, 1, `expected one footer line, got ${ctrls}\nstdout: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: watch with corrupt state (non-TTY) prints one corrupt-state frame, does not hang, exits 0", () => {
  // Spec §F-4 line 232-233: "corrupt → warning block naming
  // listCorruptArtifacts(dir)[0]". Corrupt state is a display
  // condition in watch, not an exit-code condition — the watch
  // command renders the corrupt frame and exits 0 in non-TTY mode.
  // (The exit-4 contract belongs to `status` with --json, not watch.)
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", ".goal-state.json"), "{ broken json", "utf-8");

    const r = runCli(dir, ["watch"], { timeout: 5_000 });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /corrupt/i);
    const ctrls = (r.stdout.match(/ctrl-c to exit/g) ?? []).length;
    assert.equal(ctrls, 1, `expected one footer line, got ${ctrls}\nstdout: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: --json watch is explicitly rejected with exit 1 and JSON-poll guidance", () => {
  // Spec §F-4 line 215 + src/cli.ts:614-618: --json watch is an
  // explicit usage error; the implementation points users at
  // `--json status` in a polling loop.
  const dir = freshDir();
  try {
    const r = runCli(dir, ["--json", "watch"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /--json/);
    assert.match(r.stderr, /status/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});