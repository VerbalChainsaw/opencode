/**
 * G-2 — dismiss-terminal wires into the unarchived-terminal filter.
 *
 * Audit hardening plan item G-2: when the user clicks the X button
 * on a terminal-history chain row, the action should:
 *   1. Record the terminal goal's id in the dismissed set so the
 *      unarchivedTerminalGoal filter hides the "still needs
 *      archiving" prompt.
 *   2. NOT null the chain (the terminal goal is still meaningful
 *      for archive polling and the history panel).
 *
 * Pre-fix: dismiss-terminal did `setChainDismissed(true); setChain(null)`
 * which collapsed the entire chain panel and blocked archive polling
 * for the session. Post-fix: only the terminal-goal row is hidden.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GOAL_PANEL_TSX = join(here, "goal-panel.tsx");

test("G-2.1: dismiss-terminal no longer calls setChain(null)", async () => {
  const src = await readFile(GOAL_PANEL_TSX, "utf-8");
  // Find the dismiss-terminal case body. The pre-fix code did:
  //   case "dismiss-terminal":
  //     setChainDismissed(true)
  //     setChain(null)
  //     return
  // Post-fix: setChain(null) is gone.
  const match = src.match(/case "dismiss-terminal":\s*\n([\s\S]*?)\n\s*return;\s*\n\s*case "noop":/);
  assert.ok(match, "dismiss-terminal case not found");
  const body = match[1];
  assert.ok(
    !/setChain\(null\)/.test(body),
    "dismiss-terminal must NOT call setChain(null); the terminal goal is still meaningful for archive polling",
  );
});

test("G-2.2: dismiss-terminal adds the goal's id to dismissedTerminalGoalIDs", async () => {
  const src = await readFile(GOAL_PANEL_TSX, "utf-8");
  const match = src.match(/case "dismiss-terminal":\s*\n([\s\S]*?)\n\s*return;\s*\n\s*case "noop":/);
  assert.ok(match);
  const body = match[1];
  // The setter is the production name; we accept either the
  // setter or the underlying store. The contract is: dismiss
  // must record the id in the dismissed store.
  assert.ok(
    /setDismissedTerminalGoalIDs|dismissedTerminalGoalIDs/.test(body),
    "dismiss-terminal must record the goal's id via setDismissedTerminalGoalIDs / dismissedTerminalGoalIDs",
  );
  // And specifically must check whether the goal already exists
  // (avoid duplicates) — the production code uses `prev.includes`.
  assert.ok(
    /prev\.includes\(tGoal\.id\)/.test(body),
    "dismiss-terminal must check whether the goal is already dismissed to avoid duplicates",
  );
});

test("G-2.3: dismissedTerminalGoalIDs is declared with createStore", async () => {
  const src = await readFile(GOAL_PANEL_TSX, "utf-8");
  assert.ok(
    /createStore<\{ ids: string\[\] \}>\(\{ ids: \[\] \}\)/.test(src),
    "dismissedTerminalGoalIDs must be a SolidJS store with an ids array",
  );
});

test("G-2.4: unarchivedTerminalGoal filters out dismissed ids", async () => {
  const src = await readFile(GOAL_PANEL_TSX, "utf-8");
  // Find the unarchivedTerminalGoal memo body and check it has
  // the dismissedTerminalGoalIDs.ids.includes check.
  const memoMatch = src.match(
    /unarchivedTerminalGoal = createMemo\(\(\) => \{([\s\S]*?)^  \}\)/m,
  );
  assert.ok(memoMatch, "unarchivedTerminalGoal memo not found");
  const body = memoMatch[1];
  assert.ok(
    /dismissedTerminalGoalIDs\.ids\.includes\(goal\.id\)/.test(body),
    "unarchivedTerminalGoal must filter out dismissed goal ids",
  );
});