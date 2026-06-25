/**
 * AG-P0-02: Correct the OpenCode v2 assistant-message contract.
 *
 * Production shape: the OpenCode SDK v2 emits assistant messages with
 * timestamps at `info.time.created` (top-level). The v1 SDK used
 * `info.metadata.time.created` (nested). The current code reads only the
 * v1 path; on a v2 host it always sees `createdAt: 0` and falls back
 * to array position, which is correct ONLY when timestamps are absent.
 *
 * AG-P0-02 requires:
 *   1. v2 top-level `info.time.created` is read exactly.
 *   2. legacy nested `info.metadata.time.created` works only as fallback.
 *   3. stale step-1 marker does not complete step 2 (covered indirectly
 *      via the cutoff comparison — when the v2 timestamp is correctly
 *      read, the cutoff logic in evaluateByTranscript already filters
 *      stale markers; this test pins the helper output).
 *   4. out-of-order array with valid timestamps selects the newest message.
 *   5. no-timestamp fallback remains deterministic (array position).
 *
 * Forbidden by the ticket:
 *   - changing goal evaluation semantics
 *   - weakening the stale-marker cutoff
 *   - replacing timestamps with Date.now() before comparison
 *
 * This test file imports a pure helper (`pickLatestAssistant`) that the
 * fix introduces. The async wrapper at server.ts:628 (getLatestAssistantMeta)
 * remains; it now delegates to this pure helper after fetching.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distServerPath = pathToFileURL(join(here, "..", "dist", "server.js")).href;

// The helper is pure: it takes a raw messages array and returns the pick.
// It does NOT depend on the plugin instance, client, or directory, so
// the tests can drive it directly without any setup.

let pickLatestAssistant;

test("AG-P0-02.1: server.ts exports pickLatestAssistant as a pure helper", async () => {
  const mod = await import(distServerPath);
  assert.equal(typeof mod.pickLatestAssistant, "function",
    "pickLatestAssistant must be exported from server.ts");
  pickLatestAssistant = mod.pickLatestAssistant;
});

test("AG-P0-02.1: v2 top-level info.time.created is read exactly", () => {
  const messages = [
    {
      info: {
        id: "m-v2",
        role: "assistant",
        // v2 SDK shape: time is top-level on info.
        time: { created: 1700000010000 },
      },
      parts: [{ type: "text", text: "step 1 done\nGOAL_COMPLETE: shipped" }],
    },
  ];
  const pick = pickLatestAssistant(messages);
  assert.ok(pick, "must pick the assistant message");
  assert.equal(pick.createdAt, 1700000010000,
    "v2 info.time.created must be the canonical timestamp");
  assert.equal(pick.messageId, "m-v2");
  assert.match(pick.text, /GOAL_COMPLETE/);
});

test("AG-P0-02.2: legacy info.metadata.time.created works only as fallback", () => {
  // When BOTH are present, v2 wins (the canonical SDK contract).
  const messages = [
    {
      info: {
        id: "m-both",
        role: "assistant",
        time: { created: 2000 }, // v2 (newer)
        metadata: { time: { created: 1000 } }, // legacy (older)
      },
      parts: [{ type: "text", text: "v2 wins" }],
    },
  ];
  const pick = pickLatestAssistant(messages);
  assert.equal(pick.createdAt, 2000, "when both v2 and legacy are present, v2 wins");

  // When ONLY legacy is present, legacy is the source.
  const legacyOnly = [
    {
      info: {
        id: "m-legacy",
        role: "assistant",
        metadata: { time: { created: 1700000020000 } },
      },
      parts: [{ type: "text", text: "legacy only" }],
    },
  ];
  const legacyPick = pickLatestAssistant(legacyOnly);
  assert.equal(legacyPick.createdAt, 1700000020000,
    "legacy timestamp is the fallback when v2 is absent");
});

test("AG-P0-02.3: stale step-1 marker does not complete step 2 (cutoff integration)", () => {
  // Simulate the chain step scenario: the goal has a stepMarkerAt
  // cutoff at time T_cutoff. The transcript has an OLDER marker
  // (step-1's GOAL_COMPLETE:) and a NEWER message (step-2's empty
  // assistant message that the model emitted before the marker).
  //
  // The fix is to return the NEWEST message by v2 timestamp; the
  // cutoff check in evaluateByTranscript then correctly says
  // "no marker since the cutoff" and step-2 is not falsely achieved.
  //
  // Before the fix, the code returned the LAST assistant by array
  // position. If the SDK returns messages in any other order (or the
  // newest message has no marker yet), this can falsely surface a
  // stale marker.
  const T_CUTOFF = 1700000050000;
  const messages = [
    // Older message — would be a stale marker for step 2.
    {
      info: {
        id: "m-step1-marker",
        role: "assistant",
        time: { created: T_CUTOFF - 1000 }, // BEFORE cutoff
      },
      parts: [{ type: "text", text: "step 1 done\nGOAL_COMPLETE: shipped first" }],
    },
    // Newer message — no marker yet, but it's the "current" message.
    {
      info: {
        id: "m-step2-thinking",
        role: "assistant",
        time: { created: T_CUTOFF + 5000 }, // AFTER cutoff
      },
      parts: [{ type: "text", text: "I'm working on step 2 now..." }],
    },
  ];
  const pick = pickLatestAssistant(messages);
  // The newest-by-timestamp message is the step-2 one (no marker).
  assert.equal(pick.messageId, "m-step2-thinking",
    "newest-by-timestamp wins, not newest-by-array-position");
  assert.equal(pick.createdAt, T_CUTOFF + 5000);
  // The cutoff check (in evaluateByTranscript, not in this helper)
  // will then correctly say: "no marker since the cutoff".
  // This test pins the helper output; the cutoff semantics are
  // covered by the AG-P0-01 chain-runtime test.
});

test("AG-P0-02.4: out-of-order array with valid timestamps selects the newest message", () => {
  // The SDK may return messages in any order; the helper must sort
  // by timestamp, not by array position.
  const messages = [
    {
      info: { id: "m-old", role: "assistant", time: { created: 1000 } },
      parts: [{ type: "text", text: "old" }],
    },
    {
      info: { id: "m-newest", role: "assistant", time: { created: 3000 } },
      parts: [{ type: "text", text: "newest" }],
    },
    {
      info: { id: "m-middle", role: "assistant", time: { created: 2000 } },
      parts: [{ type: "text", text: "middle" }],
    },
  ];
  const pick = pickLatestAssistant(messages);
  assert.equal(pick.messageId, "m-newest",
    "out-of-order array must be sorted by timestamp, not position");
  assert.equal(pick.createdAt, 3000);
});

test("AG-P0-02.5: no-timestamp fallback remains deterministic (array position)", () => {
  // When all candidates lack timestamps (createdAt falls back to 0),
  // the helper must pick deterministically by array position. This
  // preserves the v0.7.x behavior for hosts that have not yet migrated
  // to v2 messages.
  const messages = [
    {
      info: { id: "m-a", role: "assistant" }, // no time, no metadata.time
      parts: [{ type: "text", text: "no time A" }],
    },
    {
      info: {
        id: "m-b",
        role: "assistant",
        time: { created: "not-a-number" }, // wrong type — normalized to 0
      },
      parts: [{ type: "text", text: "wrong type B" }],
    },
    {
      info: {
        id: "m-c",
        role: "assistant",
        // time present but missing `created`
        time: {},
      },
      parts: [{ type: "text", text: "missing created C" }],
    },
  ];
  const pick = pickLatestAssistant(messages);
  // All three have effective createdAt=0. The deterministic fallback
  // is array position — the last assistant (m-c) wins.
  assert.equal(pick.messageId, "m-c",
    "no-timestamp fallback picks the last assistant by array position");
  assert.equal(pick.createdAt, 0, "invalid timestamps normalize to 0");
});

test("AG-P0-02: non-assistant messages are filtered out", () => {
  const messages = [
    {
      info: { id: "m-user", role: "user", time: { created: 9999999 } },
      parts: [{ type: "text", text: "user msg" }],
    },
    {
      info: { id: "m-tool", role: "tool", time: { created: 8888888 } },
      parts: [{ type: "text", text: "tool output" }],
    },
    {
      info: { id: "m-assistant", role: "assistant", time: { created: 100 } },
      parts: [{ type: "text", text: "assistant" }],
    },
  ];
  const pick = pickLatestAssistant(messages);
  assert.equal(pick.messageId, "m-assistant");
  assert.equal(pick.createdAt, 100, "user/tool timestamps ignored");
});

test("AG-P0-02: empty messages array returns null", () => {
  assert.equal(pickLatestAssistant([]), null);
  assert.equal(pickLatestAssistant(null), null);
  assert.equal(pickLatestAssistant(undefined), null);
});

test("AG-P0-02: array with no assistants returns null", () => {
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [] },
    { info: { id: "m2", role: "system", time: { created: 2 } }, parts: [] },
  ];
  assert.equal(pickLatestAssistant(messages), null);
});

test("AG-P0-02: integration — fresh dir, server.ts source-level grep pins v2 path", async () => {
  // The ticket requires the implementation change in src/server.ts.
  // Pin the source so a future refactor doesn't drop the v2 path.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(here, "..", "src", "server.ts"), "utf-8");
  assert.match(src, /info\.time\.created/,
    "src/server.ts must read info.time.created (the v2 SDK path)");
  assert.match(src, /info\.metadata\?\.time\?\.created|info\.metadata\.time\.created/,
    "src/server.ts must retain info.metadata.time.created as legacy fallback");
});
