/**
 * Plugin boot: terminal goal state does not carry over to a new
 * opencode session.
 *
 * Pins the root fix for a class of UX bugs where the desktop panel
 * displays a goal that was achieved or cleared in a prior session
 * as if it were a live goal in the new session. Example: a user
 * runs a goal in the morning, the goal is achieved and archived,
 * the user closes the app, then reopens the app in the evening
 * — the panel shows the morning's achieved goal in the "current
 * goal" position, with the green "achieved" styling, which the
 * user reads as "active goal running" even though the engine has
 * long since stopped driving it.
 *
 * Root cause (audit, June 2026): the on-disk state file
 * (`.opencode/.goal-state.json`) is written with `status: "achieved"`
 * when a goal completes (server.ts:870) and with `status: "cleared"`
 * when a user clears a goal (goal-state.ts:1039-1040). The archive
 * (`.opencode/goal-archive.jsonl` and `.opencode/goal-history.json`)
 * is the durable record. The state file is the *live* state, but it
 * is left on disk in a terminal state forever.
 *
 * Fix: the plugin's `server({...})` factory, called once per
 * opencode session boot, archives any terminal state to the
 * archive (idempotent — the `appendGoalArchive` and
 * `appendGoalHistory` paths already no-op on existing entries)
 * and unlinks the state file. The chain file is also unlinked
 * if its `current` is at the last step (chain done) or its
 * `current === -1` (chain never started).
 *
 * The in-session "view last goal" UX is preserved because the
 * clear only runs at boot, not during a session. While the app
 * is open, the panel continues to show the achieved/cleared
 * goal (the existing TUI logic at tui-logic.test.mjs:83 still
 * works). On next open, the boot clear fires and the panel
 * shows "No goal set" with the goal available in the history
 * panel.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { server as autogoalServer } from "../dist/server.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "autogoal-bootclear-"));
}

function plantGoalState(dir, status, extra = {}) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  const state = {
    version: 1,
    id: "goal-stale",
    condition: "a goal from a previous session",
    command: null,
    verification: { type: "marker" },
    status,
    createdAt: 1_000_000,
    startedAt: 1_000_000,
    completedAt: status === "achieved" ? 2_000_000 : null,
    pausedAt: null,
    resumedAt: null,
    turnsEvaluated: 1,
    tokensUsed: 0,
    lastEvaluation: status === "achieved"
      ? { met: true, reason: "met", confidence: 1, timestamp: 2_000_000, evaluatorType: "heuristic" }
      : null,
    evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user", sessionId: "ses_prev_session" },
    ...extra,
  };
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(state, null, 2));
}

test("plugin boot: terminal (achieved) state from prior session is archived and cleared", async () => {
  const dir = freshDir();
  try {
    plantGoalState(dir, "achieved");
    const statePath = join(dir, ".opencode", ".goal-state.json");
    assert.ok(existsSync(statePath), "precondition: state file should be planted");

    const client = {
      app: { log: async () => {} },
      tui: { showToast: async () => {} },
      session: { messages: async () => ({ data: [] }), prompt: async () => ({ data: { id: "x" } }) },
    };

    // Boot the plugin. The factory is the entry point.
    await autogoalServer({ client, directory: dir });

    // The state file must be gone — the engine should see no live goal.
    assert.equal(
      existsSync(statePath),
      false,
      "terminal achieved state from prior session must be unlinked after boot",
    );

    // The goal must be in the archive (idempotent on the append path).
    const archivePath = join(dir, ".opencode", "goal-archive.jsonl");
    assert.ok(existsSync(archivePath), "archive file should exist after boot clear");
    const archiveContent = readFileSync(archivePath, "utf-8");
    assert.match(archiveContent, /a goal from a previous session/, "archive should contain the cleared goal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin boot: terminal (cleared) state from prior session is cleared", async () => {
  const dir = freshDir();
  try {
    plantGoalState(dir, "cleared");
    const statePath = join(dir, ".opencode", ".goal-state.json");
    assert.ok(existsSync(statePath), "precondition: state file should be planted");

    const client = {
      app: { log: async () => {} },
      tui: { showToast: async () => {} },
      session: { messages: async () => ({ data: [] }), prompt: async () => ({ data: { id: "x" } }) },
    };

    await autogoalServer({ client, directory: dir });

    assert.equal(
      existsSync(statePath),
      false,
      "terminal cleared state from prior session must be unlinked after boot",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin boot: ACTIVE state from prior session is preserved (not auto-cleared)", async () => {
  const dir = freshDir();
  try {
    plantGoalState(dir, "active");
    const statePath = join(dir, ".opencode", ".goal-state.json");
    assert.ok(existsSync(statePath), "precondition: state file should be planted");

    const client = {
      app: { log: async () => {} },
      tui: { showToast: async () => {} },
      session: { messages: async () => ({ data: [] }), prompt: async () => ({ data: { id: "x" } }) },
    };

    await autogoalServer({ client, directory: dir });

    assert.ok(
      existsSync(statePath),
      "active state from prior session must remain after boot (manual clear required to drop)",
    );
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(state.status, "active");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
