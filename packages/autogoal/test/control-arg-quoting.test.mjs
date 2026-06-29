/**
 * Control-arg quoting round-trip (wiring sweep 2026-06-28, handoff-steer-claim).
 *
 * The GUI quotes control args (steer/handoff notes, set condition, --command)
 * via goal-panel-pure.ts `goalControlQuotedArg`, which backslash-escapes
 * embedded quotes and backslashes. The autogoal consumers (`unwrapQuotes`,
 * `parseCommand`) must reverse that escaping so a note/condition/command
 * containing `"` or `\` round-trips intact. Before the fix `unwrapQuotes`
 * required exactly two quote chars (so the escaped form was persisted verbatim)
 * and `parseCommand`'s `[^"]+` truncated at the first escaped quote.
 *
 * The producer is replicated here (copy-function pattern) so the contract is
 * pinned cross-package without importing renderer code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { unwrapQuotes, parseCommand } = await import(
  pathToFileURL(join(here, "..", "dist", "goal-state.js")).href
);

// Mirror of goal-panel-pure.ts goalControlQuotedArg (the GUI producer).
function goalControlQuotedArg(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

test("unwrapQuotes reverses goalControlQuotedArg for notes with quotes/backslashes", () => {
  for (const note of [
    'say "hi"',
    "use \\path\\to",
    'mix "a" and \\b',
    'trailing quote "',
    "plain note",
    "no special chars",
  ]) {
    assert.equal(
      unwrapQuotes(goalControlQuotedArg(note)),
      note,
      `round-trip failed for: ${JSON.stringify(note)}`,
    );
  }
});

test("unwrapQuotes preserves manual CLI forms (single pair + multi-token)", () => {
  assert.equal(unwrapQuotes('"do the thing"'), "do the thing");
  // genuine multi-token, no escapes → left untouched (prior behavior)
  assert.equal(unwrapQuotes('"a" and "b"'), '"a" and "b"');
  // unquoted → untouched
  assert.equal(unwrapQuotes("bare text"), "bare text");
});

test("parseCommand reverses goalControlQuotedArg for commands with quotes", () => {
  for (const cmd of ['echo "done"', 'grep "foo" file.txt', 'sh -c "exit 0"', "npm test"]) {
    const line = `set "cond" --command ${goalControlQuotedArg(cmd)}`;
    assert.equal(parseCommand(line), cmd, `parseCommand failed for: ${JSON.stringify(cmd)}`);
  }
});

test("parseCommand still handles manual CLI quoting (no escapes)", () => {
  assert.equal(parseCommand('set "x" --command "npm test"'), "npm test");
  assert.equal(parseCommand("set x --command 'echo hi'"), "echo hi");
  assert.equal(parseCommand("set x with no command"), null);
});
