/**
 * D1 (CENTER-AUDIT 2026-06-27) — the experimental.session.compacting handler
 * must surface a corrupt .goal-state.json instead of silently dropping the
 * ACTIVE GOAL context.
 *
 * Defect: the handler read state via the readGoalState() shim, which collapses
 * both "absent" and "corrupt" to null. On a corrupt state file while a goal was
 * active, the handler early-returned with no log/quarantine and pushed NO
 * "## ACTIVE GOAL" block into the compaction context — the agent silently lost
 * its goal anchor across compaction. Every other top-of-handler state read
 * (session.idle, session.error) and the chain read inside this same handler
 * already discriminate corrupt; compacting was the lone corrupt-blind read.
 *
 * Fix: use readGoalStateResult() and, on corrupt, log at error level (mirroring
 * the idle/error pattern) and return. Absent and non-active still early-return
 * silently; valid active/paused state still pushes the ACTIVE GOAL block.
 *
 * This pins all four cases: corrupt (log + no context), absent (no context),
 * active (context pushed), and the positive regression so the fix isn't an
 * over-correction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const { server } = await import(pathToFileURL(join(distDir, "server.js")).href);

const COMPACTING = "experimental.session.compacting";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-compacting-"));
}
function cleanDir(d) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Mock client capturing plugin log() calls so we can assert the corrupt log. */
function makeClient() {
  const logs = [];
  return {
    logs,
    client: {
      app: {
        log: (...args) => {
          logs.push(args);
          return Promise.resolve();
        },
      },
      tui: { showToast: async () => {} },
      session: { messages: async () => ({ data: [] }), prompt: async () => ({ data: { id: "x" } }) },
    },
  };
}

function plantCorruptState(dir) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), "{not valid json", "utf-8");
}

/** Build a valid active goal via the public set_goal tool path. */
async function plantActiveGoal(plugin, dir, sessionID) {
  await plugin.tool.set_goal.execute(
    { condition: "keep the build green", command: process.platform === "win32" ? "exit 0" : "true" },
    { directory: dir, sessionID },
  );
}

/** Invoke the compacting hook with a captured output.context array. */
async function runCompacting(plugin, sessionID) {
  const output = { context: [] };
  await plugin[COMPACTING]({ sessionID }, output);
  return output.context;
}

function logsInclude(logs, needle) {
  // The plugin's log() calls client.app.log({ body: { message, ... } }), so the
  // captured arg is an object, not a string. Match against the serialized entry.
  return logs.some((entry) => {
    try {
      return JSON.stringify(entry).includes(needle);
    } catch {
      return false;
    }
  });
}

test("compacting: corrupt state file logs error and pushes NO ACTIVE GOAL context", async () => {
  const dir = freshDir();
  try {
    const { client, logs } = makeClient();
    const plugin = await server({ client, directory: dir });
    plantCorruptState(dir);

    const ctx = await runCompacting(plugin, "ses_compact_1");

    assert.equal(
      ctx.some((c) => typeof c === "string" && c.includes("ACTIVE GOAL")),
      false,
      "corrupt state must not inject an ACTIVE GOAL block",
    );
    assert.ok(
      logsInclude(logs, "goal state file is corrupt"),
      "corrupt state during compaction must be logged (was silently dropped pre-fix)",
    );
  } finally {
    cleanDir(dir);
  }
});

test("compacting: absent state file pushes no context and does not error-log", async () => {
  const dir = freshDir();
  try {
    const { client, logs } = makeClient();
    const plugin = await server({ client, directory: dir });
    // no goal-state file planted

    const ctx = await runCompacting(plugin, "ses_compact_2");

    assert.equal(ctx.length, 0, "absent state must inject no context");
    assert.equal(
      logsInclude(logs, "goal state file is corrupt"),
      false,
      "absent state must NOT be reported as corrupt",
    );
  } finally {
    cleanDir(dir);
  }
});

test("compacting: valid active goal pushes the ACTIVE GOAL block (over-fix guard)", async () => {
  const dir = freshDir();
  try {
    const { client } = makeClient();
    const plugin = await server({ client, directory: dir });
    const sessionID = "ses_compact_3";
    await plantActiveGoal(plugin, dir, sessionID);

    const ctx = await runCompacting(plugin, sessionID);

    assert.ok(
      ctx.some((c) => typeof c === "string" && c.includes("ACTIVE GOAL")),
      "a valid active goal must still inject the ACTIVE GOAL block after the fix",
    );
    assert.ok(
      ctx.some((c) => typeof c === "string" && c.includes("keep the build green")),
      "the injected block must carry the goal condition",
    );
  } finally {
    cleanDir(dir);
  }
});
