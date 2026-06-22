/**
 * F-1 (v0.5.0) — `--json` output mode regression coverage.
 *
 * Spec: packages/autogoal/specs/v0.5.0-feature-work-orders.md §F-1.
 *
 * The F-1 contract (paraphrased from the spec, line-by-line):
 *
 *   - With `--json`, stdout is exactly one line of JSON; stderr is empty
 *     for usage errors; the process exit code matches the envelope's
 *     `exitCode` field.
 *   - `--json` and `--dir` are leading flags accepted in either order
 *     before the command word.
 *   - Envelope shape: `{ok, kind, exitCode, message, state?}` where
 *     `state` is included ONLY for `view`/`status` (sanitized via
 *     `readGoalStateSafe`) and is `null` when no goal exists (the
 *     envelope at spec line 87 is explicitly nullable). All other
 *     commands must omit the `state` property entirely.
 *   - `agentExtras` is never emitted (agent-only scaffolding).
 *   - Unknown command / parseArgs throw with `--json` → `{ok:false,
 *     kind:"usage", exitCode:1, message:<error>}` on stdout, nothing on
 *     stderr, exit 1.
 *   - `help` with `--json` prints prose (help is for humans).
 *
 * Coverage gaps closed by this file (the spec's "Tests first" list
 * from spec §F-1 lines 105-115 was unfulfilled):
 *   1. parseArgs variants (`--json status`, `--dir X --json status`,
 *      `--json --dir X status`).
 *   2. `--json status` in a temp dir with no goal → JSON envelope,
 *      kind `no-goal`, exitCode 2, process exit 2, `state:null`.
 *   3. set a goal, `--json status` → `ok:true`, `state` field present
 *      and validator-shaped.
 *   4. corrupt state file planted → kind `corrupt-state`, exitCode 4,
 *      process exit 4.
 *   5. `--json zzz` (unknown) → single-line JSON on stdout, exit 1,
 *      stderr empty.
 *   6. stdout is exactly one line.
 *   7. `--json help` prints prose (no JSON envelope).
 *
 * Plus the broader spec assertions:
 *   - state is omitted for non-view/non-status commands.
 *   - agentExtras never emitted in any --json envelope.
 *   - parseArgs throw with `--json` returns JSON (the jsonHint branch
 *     at src/cli.ts:334-336), not prose.
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
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parseArgs } from "../dist/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const NODE = process.execPath;

// Real, existing directory. parseArgs validates --dir path existence
// at src/cli.ts:170-172, so unit tests that pass --dir must use a
// directory that actually exists. process.cwd() always exists.
const EXISTING_DIR = process.cwd();

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-json-"));
}

function runCli(dir, args) {
  return spawnSync(NODE, [CLI, "--dir", dir, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

function plantCorruptState(dir) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), "{ not valid json", "utf-8");
}

/**
 * Parse a single-line JSON envelope from a CLI result. Throws if the
 * result is empty, multi-line, or unparseable — every spec violation
 * shows up here before the assertions do, with the raw output
 * attached.
 */
function parseEnvelope(r, label) {
  const out = r.stdout.trim();
  if (out.length === 0) {
    throw new Error(
      `[${label}] expected one JSON line, got empty stdout. stderr: ${r.stderr}`,
    );
  }
  const lines = out.split("\n");
  if (lines.length !== 1) {
    throw new Error(
      `[${label}] expected exactly one JSON line, got ${lines.length}:\n${r.stdout}\nstderr: ${r.stderr}`,
    );
  }
  return JSON.parse(lines[0]);
}

// ── parseArgs unit tests ─────────────────────────────────────────────

test("parseArgs: --json status → json:true, action:status", () => {
  const r = parseArgs(["--json", "status"]);
  assert.equal(r.json, true);
  assert.equal(r.action, "status");
  assert.deepEqual(r.payloadParts, []);
});

test("parseArgs: --dir <existing> --json status → json:true, correct dir", () => {
  const r = parseArgs(["--dir", EXISTING_DIR, "--json", "status"]);
  assert.equal(r.json, true);
  assert.equal(r.action, "status");
  assert.equal(r.directory, resolve(EXISTING_DIR));
});

test("parseArgs: --json --dir <existing> status → json:true, correct dir", () => {
  const r = parseArgs(["--json", "--dir", EXISTING_DIR, "status"]);
  assert.equal(r.json, true);
  assert.equal(r.action, "status");
  assert.equal(r.directory, resolve(EXISTING_DIR));
});

test("parseArgs: --json without command (after leading flag) → throws", () => {
  // Leading-flag loop consumes --json, then falls through to the
  // `missing command` throw at src/cli.ts:184. parseArgs must surface
  // this as a throw — main() catches it and routes to the jsonHint
  // JSON envelope (covered by the e2e test below).
  assert.throws(() => parseArgs(["--json"]), /missing command/);
});

// ── e2e: --json status, no goal ───────────────────────────────────────

test("e2e: --json status with no goal → kind no-goal, exitCode 2, state:null, exit 2", () => {
  // Spec §F-1 line 87 envelope is `{ok, kind, exitCode, message, state?}`
  // with `state` explicitly nullable. readGoalStateSafe returns
  // {state: null, ...} when no goal exists (src/gui.ts readGoalStateSafe),
  // so the JSON envelope must emit `state: null`, not omit the field.
  const dir = freshDir();
  try {
    const r = runCli(dir, ["--json", "status"]);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\nstderr: ${r.stderr}`);
    const env = parseEnvelope(r, "no-goal");
    assert.equal(env.ok, false);
    assert.equal(env.kind, "no-goal");
    assert.equal(env.exitCode, 2);
    assert.equal(typeof env.message, "string");
    assert.equal(env.state, null, "no-goal envelope must carry state:null (spec §F-1 line 87)");
    assert.equal(env.agentExtras, undefined, "agentExtras must never be emitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e: --json status, active goal ──────────────────────────────────

test("e2e: set goal then --json status → ok:true, state present with condition, exit 0", () => {
  const dir = freshDir();
  try {
    // Seed a goal. `set <condition> --command <cmd>` is the canonical
    // set shape (spec §F-1 example, src/cli.ts HELP).
    const setR = runCli(dir, ["set", "all tests pass", "--command", "npm test"]);
    assert.equal(setR.status, 0, `set should exit 0: stderr=${setR.stderr}\nstdout=${setR.stdout}`);

    const r = runCli(dir, ["--json", "status"]);
    assert.equal(r.status, 0, `status should exit 0: stderr=${r.stderr}\nstdout=${r.stdout}`);
    const env = parseEnvelope(r, "active-goal");
    assert.equal(env.ok, true);
    assert.equal(env.kind, "success");
    assert.equal(env.exitCode, 0);
    assert.ok(env.state, "active-goal envelope must include state");
    assert.equal(env.state.condition, "all tests pass");
    // Validator-shaped: the full GoalState shape with the expected
    // top-level fields after sanitizeForPrompt routing (src/gui.ts
    // sanitizeGoalStateForGui is the single source of sanitization).
    assert.equal(typeof env.state.id, "string");
    assert.equal(typeof env.state.status, "string");
    assert.equal(typeof env.state.turnsEvaluated, "number");
    assert.equal(typeof env.state.constraints, "object");
    assert.equal(typeof env.state.metadata, "object");
    assert.equal(env.agentExtras, undefined, "agentExtras must never be emitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e: non-status JSON command omits state ──────────────────────────

test("e2e: --json pause (non-status command) omits state property entirely", () => {
  // Spec §F-1 lines 92-94: `state` is included ONLY for view/status.
  // All other commands must omit the field entirely (not emit null,
  // not emit an empty object — the key must be absent). `pause` is a
  // valid dispatcher action that exits 0 on an active goal.
  const dir = freshDir();
  try {
    const setR = runCli(dir, ["set", "x", "--command", "true"]);
    assert.equal(setR.status, 0, `set should exit 0: stderr=${setR.stderr}`);

    const r = runCli(dir, ["--json", "pause"]);
    assert.equal(r.status, 0, `pause should exit 0: stderr=${r.stderr}`);
    const env = parseEnvelope(r, "pause");
    assert.equal(env.ok, true);
    assert.equal(env.kind, "success");
    // The contract: state key is ABSENT (not null, not undefined-value).
    // Object property absence is enforced by `'state' in env`.
    assert.equal("state" in env, false, `non-status envelope must not contain 'state' key, got: ${JSON.stringify(env)}`);
    assert.equal(env.agentExtras, undefined, "agentExtras must never be emitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e: corrupt state ───────────────────────────────────────────────

test("e2e: corrupt state → kind corrupt-state, exitCode 4, process exit 4", () => {
  // The v0.4.1 C-2 tri-state reader quarantines corrupt files and
  // surfaces them as kind `corrupt-state` with exit 4 (KIND_TO_EXIT).
  const dir = freshDir();
  try {
    plantCorruptState(dir);

    const r = runCli(dir, ["--json", "status"]);
    assert.equal(r.status, 4, `expected exit 4, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const env = parseEnvelope(r, "corrupt-state");
    assert.equal(env.ok, false);
    assert.equal(env.kind, "corrupt-state");
    assert.equal(env.exitCode, 4);
    assert.equal(env.agentExtras, undefined, "agentExtras must never be emitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e: unknown command ─────────────────────────────────────────────

test("e2e: --json zzz (unknown) → one JSON line, kind usage, exitCode 1, stderr empty, exit 1", () => {
  // Spec §F-1 lines 96-99: unknown command with --json emits
  // {ok:false, kind:"usage", exitCode:1, message:<text>} on stdout,
  // nothing on stderr, exit 1.
  const dir = freshDir();
  try {
    const r = runCli(dir, ["--json", "zzz"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr, "", "stderr must be empty in --json mode");
    const env = parseEnvelope(r, "unknown");
    assert.equal(env.ok, false);
    assert.equal(env.kind, "usage");
    assert.equal(env.exitCode, 1);
    assert.equal(typeof env.message, "string");
    assert.match(env.message, /unknown command/);
    // Non-status: state must be absent.
    assert.equal("state" in env, false, "unknown-command envelope must not contain 'state' key");
    assert.equal(env.agentExtras, undefined, "agentExtras must never be emitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e: malformed leading arguments with --json ─────────────────────

test("e2e: --json with --dir <empty> (parseArgs throws) returns JSON usage, exit 1", () => {
  // Spec §F-1 lines 96-99: parseArgs throw with --json must emit the
  // JSON usage envelope. parseArgs throws when --dir has no path
  // argument (src/cli.ts:163-167). The cli.ts main() catches the
  // throw and routes through the jsonHint branch (src/cli.ts:334-336).
  // spawnSync bypasses any positional --dir handling, so we put --dir
  // and the empty arg together.
  const r = spawnSync(NODE, [CLI, "--json", "--dir", "", "status"], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr, "", "stderr must be empty in --json mode for usage errors");
  const env = parseEnvelope(r, "parse-error");
  assert.equal(env.ok, false);
  assert.equal(env.kind, "usage");
  assert.equal(env.exitCode, 1);
  assert.equal(typeof env.message, "string");
  assert.match(env.message, /--dir/, "message should mention the failing --dir flag");
  assert.equal(env.agentExtras, undefined, "agentExtras must never be emitted");
});

// ── e2e: --json help remains prose ───────────────────────────────────

test("e2e: --json help prints prose help, not JSON", () => {
  // Spec §F-1 lines 98-99: `help` with `--json` prints the normal
  // help text (help is for humans).
  const dir = freshDir();
  try {
    const r = runCli(dir, ["--json", "help"]);
    assert.equal(r.status, 0);
    // Must NOT be a JSON envelope — help is human-readable prose.
    assert.notEqual(r.stdout.trim().startsWith("{"), `help with --json should not emit JSON, got: ${r.stdout}`);
    assert.match(r.stdout, /Usage: opencode-autogoal/, "prose help expected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e: stdout is exactly one line (general invariant) ─────────────

test("e2e: --json stdout is always exactly one line (no-goal)", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["--json", "status"]);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `expected 1 line, got ${lines.length}\nstdout: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e: agentExtras absent across all surfaces ─────────────────────

test("e2e: agentExtras absent across every --json envelope variant", () => {
  // Cross-surface sweep. The CLI must never emit the agentExtras
  // key in --json mode (spec §F-1 line 95). Five invocations cover
  // no-goal, active-goal, non-status, unknown command, and corrupt.
  const dir = freshDir();
  try {
    // 1. no-goal status
    let r = runCli(dir, ["--json", "status"]);
    assert.equal("agentExtras" in JSON.parse(r.stdout.trim()), false, "agentExtras leaked in no-goal envelope");

    // 2. active goal status
    const setR = runCli(dir, ["set", "z", "--command", "true"]);
    assert.equal(setR.status, 0);
    r = runCli(dir, ["--json", "status"]);
    assert.equal("agentExtras" in JSON.parse(r.stdout.trim()), false, "agentExtras leaked in active-goal envelope");

    // 3. non-status command
    r = runCli(dir, ["--json", "pause"]);
    assert.equal("agentExtras" in JSON.parse(r.stdout.trim()), false, "agentExtras leaked in pause envelope");

    // 4. unknown command
    r = runCli(dir, ["--json", "nope"]);
    assert.equal("agentExtras" in JSON.parse(r.stdout.trim()), false, "agentExtras leaked in unknown envelope");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 5. corrupt-state is in a separate fresh dir to keep the test isolated.
  const corruptDir = freshDir();
  try {
    plantCorruptState(corruptDir);
    const r = runCli(corruptDir, ["--json", "status"]);
    assert.equal("agentExtras" in JSON.parse(r.stdout.trim()), false, "agentExtras leaked in corrupt envelope");
  } finally {
    rmSync(corruptDir, { recursive: true, force: true });
  }
});