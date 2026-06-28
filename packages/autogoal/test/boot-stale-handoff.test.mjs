/**
 * Boot quarantine of a stale handoff (CENTER-AUDIT 2026-06-27, SunoSavvy).
 *
 * A handoff is intentionally cross-session, but one left unclaimed for longer
 * than MAX_HANDOFF_AGE_MS (7 days) is abandoned. Presenting it as a one-click
 * "Claim" in an unrelated new session is the stale-handoff surprise that
 * resumed an 8-step chain and ran away. On plugin boot the handoff file is
 * quarantined (renamed to .stale.<ts>, recoverable) so it can't auto-present.
 *
 * Pins: stale handoff (8 days) is quarantined; fresh handoff (1 hour) is
 * preserved; quarantine is a rename, not a delete (recoverable).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const { server } = await import(pathToFileURL(join(distDir, "server.js")).href);

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-stalehandoff-"));
}
function cleanDir(d) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const fakeClient = () => ({
  app: { log: async () => {} },
  tui: { showToast: async () => {} },
  session: { messages: async () => ({ data: [] }), prompt: async () => ({ data: { id: "x" } }) },
});

/** Plant a handoff file whose createdAt is `ageMs` in the past. */
function plantHandoff(dir, ageMs) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  const payload = {
    createdAt,
    state: {
      version: 1,
      id: "goal-handoff",
      condition: "resume the chain",
      command: null,
      verification: { type: "marker" },
      status: "active",
      createdAt: Date.now() - ageMs,
      startedAt: Date.now() - ageMs,
      completedAt: null,
      pausedAt: null,
      resumedAt: null,
      turnsEvaluated: 0,
      tokensUsed: 0,
      lastEvaluation: null,
      evaluationHistory: [],
      constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
      metadata: { setBy: "chain", chainId: "c1", chainStep: 0, chainTotal: 8 },
    },
  };
  writeFileSync(join(dir, ".opencode", ".goal-handoff.json"), JSON.stringify(payload, null, 2));
}

const DAY = 24 * 60 * 60 * 1000;

test("boot: a stale handoff (8 days) is quarantined, not presented", async () => {
  const dir = freshDir();
  try {
    plantHandoff(dir, 8 * DAY);
    const hp = join(dir, ".opencode", ".goal-handoff.json");
    assert.ok(existsSync(hp), "precondition: handoff planted");

    await server({ client: fakeClient(), directory: dir });

    assert.equal(existsSync(hp), false, "stale handoff must be removed from the live path");
    const quarantined = readdirSync(join(dir, ".opencode")).filter((f) =>
      f.startsWith(".goal-handoff.json.stale."),
    );
    assert.ok(quarantined.length >= 1, "stale handoff must be quarantined (recoverable), not deleted");
  } finally {
    cleanDir(dir);
  }
});

test("boot: a fresh handoff (1 hour) is preserved", async () => {
  const dir = freshDir();
  try {
    plantHandoff(dir, 60 * 60 * 1000);
    const hp = join(dir, ".opencode", ".goal-handoff.json");

    await server({ client: fakeClient(), directory: dir });

    assert.ok(existsSync(hp), "a fresh handoff must survive boot (legit cross-session use)");
    const quarantined = readdirSync(join(dir, ".opencode")).filter((f) =>
      f.startsWith(".goal-handoff.json.stale."),
    );
    assert.equal(quarantined.length, 0, "a fresh handoff must NOT be quarantined");
  } finally {
    cleanDir(dir);
  }
});

test("boot: exactly-at-threshold (just under 7 days) is preserved", async () => {
  const dir = freshDir();
  try {
    plantHandoff(dir, 7 * DAY - 60 * 60 * 1000); // 6 days 23 hours
    const hp = join(dir, ".opencode", ".goal-handoff.json");

    await server({ client: fakeClient(), directory: dir });

    assert.ok(existsSync(hp), "a handoff just under the 7-day threshold must be preserved");
  } finally {
    cleanDir(dir);
  }
});
