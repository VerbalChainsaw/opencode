/**
 * Plugin auto-loop contract: surface corrupt goal state, not silence.
 *
 * Pins the v0.4.2 surfacing contract on the auto-loop event path
 * (server.ts:session.idle handler). The CLI and `goal_status` tool
 * already surface corruption (per v042-corrupt-surfacing.test.mjs),
 * but the auto-loop event path uses the deprecated `readGoalState`
 * shim (which collapses absent+corrupt to null) and silently halts
 * evaluation when the state file is corrupt. This means a corrupted
 * goal state on disk:
 *
 *   - Stops the auto-loop silently (the plugin does nothing).
 *   - Sends no notification to the user.
 *   - Cannot be detected from any observable plugin behavior except
 *     the missing evaluation.
 *
 * This test pins the contract: when the goal state is corrupt and a
 * session.idle event fires, the plugin must surface the corruption
 * (not silently swallow it). The surface is a `log("error", ...)` call
 * with a recognizable message that mentions the corruption.
 *
 * PRE-FIX: the plugin reads via `readGoalState(directory)` which
 * returns null for corrupt. The session.idle handler's
 * `if (!state ...) return;` then silently exits. No log call.
 * → this assertion fails.
 * POST-FIX: the plugin uses `readGoalStateResult(directory)` and
 * explicitly handles the `corrupt` case with an error log.
 * → this assertion passes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { server as autogoalServer } from "../dist/server.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "autogoal-corrupt-"));
}

/** Plant an unparseable goal-state file. */
function plantCorruptState(dir) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), "{this is not json!");
}

test("plugin session.idle on corrupt state: surfaces the corruption via error log", async () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir);

    const logCalls = [];
    const client = {
      app: {
        log: async (...args) => {
          logCalls.push(args);
        },
      },
      tui: {
        showToast: async () => {},
      },
      session: {
        messages: async () => ({ data: [] }),
        prompt: async () => ({ data: { id: "x" } }),
      },
    };

    const plugin = await autogoalServer({ client, directory: dir });

    // Fire a session.idle event. The plugin should NOT silently halt
    // — it should log a recognizable error about the corruption.
    await plugin.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "ses_corrupt_test" },
      },
    });

    // Find any log call that mentions corruption.
    const corruptLog = logCalls.find((args) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      return /corrupt|invalid/i.test(text);
    });

    assert.ok(
      corruptLog,
      `plugin must log a corruption-related error on session.idle with corrupt state; ` +
        `got ${logCalls.length} log calls: ${JSON.stringify(logCalls)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin session.idle on absent state: stays silent (no false-positive corruption log)", async () => {
  const dir = freshDir();
  try {
    // No goal state file at all.
    const logCalls = [];
    const client = {
      app: {
        log: async (...args) => {
          logCalls.push(args);
        },
      },
      tui: {
        showToast: async () => {},
      },
      session: {
        messages: async () => ({ data: [] }),
        prompt: async () => ({ data: { id: "x" } }),
      },
    };

    const plugin = await autogoalServer({ client, directory: dir });

    await plugin.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "ses_absent_test" },
      },
    });

    const corruptLog = logCalls.find((args) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      return /corrupt|invalid/i.test(text);
    });

    assert.equal(
      corruptLog,
      undefined,
      `absent state must NOT log a corruption error; ` +
        `got: ${JSON.stringify(corruptLog)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
