/**
 * Conversational transition tools must surface corrupt state.
 *
 * Track H / H-1 says server consumers should use result-aware readers instead
 * of collapsing corrupt goal state into "no goal". The transition tools are
 * user-visible controls, so "clear", "pause", and "resume" must not quarantine
 * a corrupt state and then tell the operator there was no active goal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const distServerPath = pathToFileURL(join(distDir, "server.js")).href;

const { server } = await import(distServerPath);

function freshDir() {
  return mkdtempSync(join(tmpdir(), "autogoal-transition-corrupt-"));
}

function plantCorruptState(dir) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), "{this is not json!");
}

function makeClient() {
  return {
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
    session: {
      messages: async () => ({ data: [] }),
      prompt: async () => ({ data: { id: "x" } }),
    },
  };
}

test("transition tools surface corrupt goal state instead of reporting no active goal", async () => {
  for (const toolName of ["clear_goal", "pause_goal", "resume_goal"]) {
    const dir = freshDir();
    try {
      const plugin = await server({ client: makeClient(), directory: dir });
      plantCorruptState(dir);

      const result = await plugin.tool[toolName].execute(
        {},
        { directory: dir, sessionID: "ses_transition_corrupt", agent: "build" },
      );

      assert.match(
        String(result),
        /corrupt|quarantined|goal-state\.json\.corrupt/i,
        `${toolName} should surface the corrupt state, got: ${String(result)}`,
      );
      assert.doesNotMatch(
        String(result),
        /No active goal/i,
        `${toolName} must not collapse corrupt state into no-goal`,
      );

      assert.equal(
        existsSync(join(dir, ".opencode", ".goal-state.json")),
        false,
        `${toolName} should quarantine the corrupt state file`,
      );
      const corruptArtifacts = readdirSync(join(dir, ".opencode")).filter((name) => name.includes(".corrupt."));
      assert.ok(corruptArtifacts.length > 0, `${toolName} should leave a forensic corrupt artifact`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("goal_status surfaces corrupt goal state instead of reporting no active goal", async () => {
  const dir = freshDir();
  try {
    const plugin = await server({ client: makeClient(), directory: dir });
    plantCorruptState(dir);

    const result = await plugin.tool.goal_status.execute(
      {},
      { directory: dir, sessionID: "ses_status_corrupt", agent: "build" },
    );

    assert.match(
      String(result),
      /corrupt|quarantined|goal-state\.json\.corrupt/i,
      `goal_status should surface the corrupt state, got: ${String(result)}`,
    );
    assert.doesNotMatch(
      String(result),
      /No active goal/i,
      "goal_status must not collapse corrupt state into no-goal",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal_restart surfaces corrupt goal state instead of reporting no active goal", async () => {
  const dir = freshDir();
  try {
    const plugin = await server({ client: makeClient(), directory: dir });
    plantCorruptState(dir);

    const result = await plugin.tool.goal_restart.execute(
      {},
      { directory: dir, sessionID: "ses_restart_corrupt", agent: "build" },
    );

    assert.match(
      String(result),
      /corrupt|quarantined|goal-state\.json\.corrupt/i,
      `goal_restart should surface the corrupt state, got: ${String(result)}`,
    );
    assert.doesNotMatch(
      String(result),
      /No active goal/i,
      "goal_restart must not collapse corrupt state into no-goal",
    );

    assert.equal(
      existsSync(join(dir, ".opencode", ".goal-state.json")),
      false,
      "goal_restart should quarantine the corrupt state file",
    );
    const corruptArtifacts = readdirSync(join(dir, ".opencode")).filter((name) => name.includes(".corrupt."));
    assert.ok(corruptArtifacts.length > 0, "goal_restart should leave a forensic corrupt artifact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal_webhook surfaces corrupt goal state from ctx.directory instead of reporting no active goal", async () => {
  const serverDir = freshDir();
  const ctxDir = freshDir();
  try {
    const plugin = await server({ client: makeClient(), directory: serverDir });
    plantCorruptState(ctxDir);

    const result = await plugin.tool.goal_webhook.execute(
      { url: "https://example.test/autogoal", on: ["achieved"] },
      { directory: ctxDir, sessionID: "ses_webhook_corrupt", agent: "build" },
    );

    assert.match(
      String(result),
      /goal-state\.json\.corrupt/i,
      `goal_webhook should name the quarantined ctx.directory artifact, got: ${String(result)}`,
    );
    assert.doesNotMatch(
      String(result),
      /No active goal/i,
      "goal_webhook must not collapse corrupt state into no-goal",
    );

    assert.equal(
      existsSync(join(ctxDir, ".opencode", ".goal-state.json")),
      false,
      "goal_webhook should quarantine the corrupt ctx.directory state file",
    );
    const corruptArtifacts = readdirSync(join(ctxDir, ".opencode")).filter((name) => name.includes(".corrupt."));
    assert.ok(corruptArtifacts.length > 0, "goal_webhook should leave a forensic corrupt artifact in ctx.directory");
    assert.equal(
      existsSync(join(serverDir, ".opencode", ".goal-state.json")),
      false,
      "goal_webhook must not read or write state in the server factory directory for this tool call",
    );
  } finally {
    rmSync(serverDir, { recursive: true, force: true });
    rmSync(ctxDir, { recursive: true, force: true });
  }
});

test("goal_handoff surfaces corrupt goal state from ctx.directory instead of reporting no active goal", async () => {
  const serverDir = freshDir();
  const ctxDir = freshDir();
  try {
    const plugin = await server({ client: makeClient(), directory: serverDir });
    plantCorruptState(ctxDir);

    const result = await plugin.tool.goal_handoff.execute(
      { note: "pick this up later" },
      { directory: ctxDir, sessionID: "ses_handoff_corrupt", agent: "build" },
    );

    assert.match(
      String(result),
      /goal-state\.json\.corrupt/i,
      `goal_handoff should name the quarantined ctx.directory artifact, got: ${String(result)}`,
    );
    assert.doesNotMatch(
      String(result),
      /No active goal/i,
      "goal_handoff must not collapse corrupt state into no-goal",
    );

    assert.equal(
      existsSync(join(ctxDir, ".opencode", ".goal-state.json")),
      false,
      "goal_handoff should quarantine the corrupt ctx.directory state file",
    );
    const corruptArtifacts = readdirSync(join(ctxDir, ".opencode")).filter((name) => name.includes(".corrupt."));
    assert.ok(corruptArtifacts.length > 0, "goal_handoff should leave a forensic corrupt artifact in ctx.directory");
    assert.equal(
      existsSync(join(serverDir, ".opencode", ".goal-state.json")),
      false,
      "goal_handoff must not read or write state in the server factory directory for this tool call",
    );
    assert.equal(
      existsSync(join(ctxDir, ".opencode", ".goal-handoff.json")),
      false,
      "goal_handoff must not create a handoff from corrupt state",
    );
  } finally {
    rmSync(serverDir, { recursive: true, force: true });
    rmSync(ctxDir, { recursive: true, force: true });
  }
});

test("goal_claim surfaces corrupt current state instead of overwriting it with a handoff", async () => {
  const serverDir = freshDir();
  const ctxDir = freshDir();
  try {
    const plugin = await server({ client: makeClient(), directory: serverDir });
    await plugin.tool.set_goal.execute(
      { condition: "finish the queued handoff", verification: { type: "marker" } },
      { directory: ctxDir, sessionID: "ses_claim_corrupt", agent: "build" },
    );
    await plugin.tool.goal_handoff.execute(
      { note: "pending claim" },
      { directory: ctxDir, sessionID: "ses_claim_corrupt", agent: "build" },
    );
    assert.equal(
      existsSync(join(ctxDir, ".opencode", ".goal-handoff.json")),
      true,
      "test setup should create a pending handoff",
    );
    plantCorruptState(ctxDir);

    const result = await plugin.tool.goal_claim.execute(
      {},
      { directory: ctxDir, sessionID: "ses_claim_corrupt_next", agent: "build" },
    );

    assert.match(
      String(result),
      /goal-state\.json\.corrupt/i,
      `goal_claim should name the quarantined current-state artifact, got: ${String(result)}`,
    );
    assert.doesNotMatch(
      String(result),
      /Handoff claimed|Goal resumed|No handoff/i,
      "goal_claim must not claim or hide a handoff when current state is corrupt",
    );

    assert.equal(
      existsSync(join(ctxDir, ".opencode", ".goal-state.json")),
      false,
      "goal_claim should quarantine the corrupt current state file",
    );
    assert.equal(
      existsSync(join(ctxDir, ".opencode", ".goal-handoff.json")),
      true,
      "goal_claim must leave the handoff pending when current state is corrupt",
    );
    const corruptArtifacts = readdirSync(join(ctxDir, ".opencode")).filter((name) => name.includes(".corrupt."));
    assert.ok(corruptArtifacts.length > 0, "goal_claim should leave a forensic corrupt artifact in ctx.directory");
    assert.equal(
      existsSync(join(serverDir, ".opencode", ".goal-state.json")),
      false,
      "goal_claim must not read or write state in the server factory directory for this tool call",
    );
  } finally {
    rmSync(serverDir, { recursive: true, force: true });
    rmSync(ctxDir, { recursive: true, force: true });
  }
});
