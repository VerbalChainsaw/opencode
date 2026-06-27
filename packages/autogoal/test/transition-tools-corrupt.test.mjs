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
