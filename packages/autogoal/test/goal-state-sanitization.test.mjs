/**
 * v0.7.3 / scan 2026-06-25 (G-5) — sanitization at persistence.
 *
 * Pre-fix: createGoalState stored parsed.condition, parsed.command,
 * and parsed.agentName without sanitization. Sanitization happened
 * only at display time, making the on-disk state a single point
 * of failure.
 *
 * Post-fix: createGoalState sanitizes all three fields at the
 * trust boundary. The on-disk state is safe-by-default.
 *
 * The sanitizeForPrompt function (goal-state.ts:1323+) strips:
 *   - C0 control chars (0x00-0x1F)
 *   - C1 control chars (0x80-0x9F)
 *   - Unicode bidi/format chars (zero-width, RTL override, etc.)
 *
 * The marker regex (GOAL_COMPLETE:) is anchored and would not be
 * triggered by control chars, but defense-in-depth is the right
 * default.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const goalStateUrl = pathToFileURL(join(here, "..", "dist", "goal-state.js")).href;
const goalState = await import(goalStateUrl);

test("G-5.1: createGoalState sanitizes C0 control chars in condition", () => {
  const state = goalState.createGoalState(
    { condition: "real\x00goal\x01condition", constraints: { maxTurns: 5, maxTimeMinutes: 0, maxTokens: 0 }, custom: false, agentName: null, sessionId: null, command: null, verification: null },
    "user",
    Date.now(),
  );
  assert.ok(
    !state.condition.includes("\x00"),
    "C0 null byte must be stripped from condition",
  );
  assert.ok(
    !state.condition.includes("\x01"),
    "C0 SOH byte must be stripped from condition",
  );
  assert.ok(state.condition.includes("real"));
  assert.ok(state.condition.includes("goal"));
  assert.ok(state.condition.includes("condition"));
});

test("G-5.2: createGoalState sanitizes C1 control chars in condition", () => {
  // 0x85 is NEL (Next Line), a C1 control char.
  const state = goalState.createGoalState(
    { condition: "before\x85after", constraints: { maxTurns: 5, maxTimeMinutes: 0, maxTokens: 0 }, custom: false, agentName: null, sessionId: null, command: null, verification: null },
    "user",
    Date.now(),
  );
  assert.ok(
    !state.condition.includes("\x85"),
    "C1 NEL byte must be stripped from condition",
  );
});

test("G-5.3: createGoalState sanitizes Unicode bidi override in condition", () => {
  // 0x202E is RIGHT-TO-LEFT OVERRIDE, a Unicode format char that
  // can be used to disguise file paths in terminal output.
  const state = goalState.createGoalState(
    { condition: "safe\u202Ehidden\u202Cvisible", constraints: { maxTurns: 5, maxTimeMinutes: 0, maxTokens: 0 }, custom: false, agentName: null, sessionId: null, command: null, verification: null },
    "user",
    Date.now(),
  );
  assert.ok(
    !state.condition.includes("\u202E"),
    "RTL override must be stripped from condition",
  );
  assert.ok(
    !state.condition.includes("\u202C"),
    "PDF (pop directional formatting) must be stripped from condition",
  );
});

test("G-5.4: createGoalState sanitizes command field", () => {
  const state = goalState.createGoalState(
    {
      condition: "ok",
      command: "echo hello\x00; rm -rf /",
      constraints: { maxTurns: 5, maxTimeMinutes: 0, maxTokens: 0 },
      custom: false,
      agentName: null,
      sessionId: null,
      verification: null,
    },
    "user",
    Date.now(),
  );
  assert.ok(
    !state.command.includes("\x00"),
    "command must be sanitized (null byte stripped)",
  );
  assert.ok(state.command.includes("echo"));
  assert.ok(state.command.includes("rm -rf /"));
});

test("G-5.5: createGoalState sanitizes agentName", () => {
  const state = goalState.createGoalState(
    {
      condition: "ok",
      command: null,
      constraints: { maxTurns: 5, maxTimeMinutes: 0, maxTokens: 0 },
      custom: false,
      agentName: "agent\u202Ehidden",
      sessionId: null,
      verification: null,
    },
    "user",
    Date.now(),
  );
  assert.ok(
    !state.metadata.agentName.includes("\u202E"),
    "agentName must be sanitized",
  );
  assert.ok(state.metadata.agentName.includes("agent"));
  assert.ok(state.metadata.agentName.includes("hidden"));
});

test("G-5.6: createGoalState preserves non-malicious content unchanged", () => {
  const long = "a".repeat(200);
  const state = goalState.createGoalState(
    {
      condition: long + " with a normal sentence.",
      command: "ls -la",
      constraints: { maxTurns: 5, maxTimeMinutes: 0, maxTokens: 0 },
      custom: false,
      agentName: "build",
      sessionId: null,
      verification: null,
    },
    "user",
    Date.now(),
  );
  // sanitizeForPrompt only strips control/bidi chars. Plain text
  // passes through. The long content is preserved.
  assert.equal(state.condition.length, long.length + " with a normal sentence.".length);
  assert.equal(state.command, "ls -la");
  assert.equal(state.metadata.agentName, "build");
});

test("G-5.7: createGoalState with no command keeps command as null", () => {
  const state = goalState.createGoalState(
    { condition: "ok", constraints: { maxTurns: 5, maxTimeMinutes: 0, maxTokens: 0 }, custom: false, agentName: null, sessionId: null, command: null, verification: null },
    "user",
    Date.now(),
  );
  assert.equal(state.command, null);
});