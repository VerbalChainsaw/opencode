/**
 * Bridge chain-promotion regression coverage.
 *
 * Pins the v0.4.1 E-1 webhook-promotion contract for the
 * `runGoalControlStateFile` bridge path (not just the CLI path).
 *
 * DEFECT (audit, June 2026): The CLI's `chain start` (command.ts:755)
 * passes `webhook: "from-state"` to `createGoalChain`, so a pre-chain
 * state's `metadata.webhook` is promoted to `chain.webhook` and
 * survives every chain advance. But the bridge's `startGoalChain`
 * (control-state.ts:384) does NOT pass this opt. As a result:
 *
 *   1. Step 0 (via `setActiveChainGoal`'s `existing.metadata.webhook`
 *      copy) DOES inherit the webhook.
 *   2. After the first advance, `applyChainWebhookToState` sees
 *      `chain.webhook === undefined` and DELETES
 *      `state.metadata.webhook`. The webhook is lost.
 *
 * This file pins the contract: after a bridge-started chain's first
 * advance, the new step's `metadata.webhook` must still equal the
 * pre-chain webhook. The test is RED on the unfixed code, GREEN
 * after the fix lands.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGoalControlStateFile } from "../dist/control-state.js";
import { advanceGoalChain } from "../dist/goal-chain.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "autogoal-bridge-wh-"));
}

const PRE_CHAIN_WEBHOOK = {
  url: "https://hook.example.invalid/test",
  on: ["achieved"],
  allowLocal: false,
};

test("bridge chain start: pre-chain webhook is promoted to chain.webhook (E-1 parity with CLI)", async () => {
  const dir = freshDir();
  try {
    // 1. Set a goal via the bridge.
    const r1 = await runGoalControlStateFile(dir, "set ship the patch", Date.now());
    assert.equal(r1.title.toLowerCase(), "goal control");

    // 2. Seed `metadata.webhook` into the state file (mimics what
    //    the `goal_webhook` tool would write). The bridge doesn't
    //    expose a `webhook` action — only the plugin-internal tool
    //    sets this field.
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.metadata.webhook = PRE_CHAIN_WEBHOOK;
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    // 3. Start a chain via the bridge. The bridge's `startGoalChain`
    //    must read the prior state's webhook and project it onto
    //    `chain.webhook` (mirroring the CLI's `webhook: "from-state"`
    //    opt at command.ts:755).
    const r2 = await runGoalControlStateFile(
      dir,
      'chain start-json {"steps":[{"condition":"first step"},{"condition":"second step"}]}',
      Date.now(),
    );
    assert.match(r2.output, /Chain started/);

    const chainPath = join(dir, ".opencode", ".goal-chain.json");
    const chain = JSON.parse(readFileSync(chainPath, "utf-8"));

    // 4. The chain file's `webhook` field must equal the pre-chain
    //    state's webhook.
    assert.ok(
      chain.webhook,
      `E-1 BRIDGE: chain.webhook must be promoted from pre-chain state; ` +
        `chain: ${JSON.stringify(chain, null, 2)}`,
    );
    assert.equal(chain.webhook.url, PRE_CHAIN_WEBHOOK.url);
    assert.deepEqual(chain.webhook.on, PRE_CHAIN_WEBHOOK.on);
    assert.equal(chain.webhook.allowLocal, PRE_CHAIN_WEBHOOK.allowLocal);

    // 5. Step 0's `metadata.webhook` must match.
    const step0 = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(step0.metadata.webhook.url, PRE_CHAIN_WEBHOOK.url);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge chain advance: pre-chain webhook survives the first advance", async () => {
  const dir = freshDir();
  try {
    // 1. Set a goal with a webhook.
    await runGoalControlStateFile(dir, "set ship the patch", Date.now());
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.metadata.webhook = PRE_CHAIN_WEBHOOK;
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    // 2. Start a chain.
    await runGoalControlStateFile(
      dir,
      'chain start-json {"steps":[{"condition":"first step"},{"condition":"second step"}]}',
      Date.now(),
    );

    // 3. Advance the chain (simulating the plugin's auto-loop).
    const r = advanceGoalChain(dir, Date.now(), { stepMarkerAt: 1000 });
    assert.equal(r.ok, true, `advance should succeed; got: ${JSON.stringify(r)}`);

    // 4. THE REGRESSION ASSERTION: step 1's `metadata.webhook` must
    //    still equal the pre-chain webhook. Pre-fix code leaves it
    //    undefined because `applyChainWebhookToState` deletes any
    //    state-level webhook when `chain.webhook` is undefined.
    const step1 = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.ok(
      step1.metadata.webhook,
      `E-1 BRIDGE ADVANCE: step 1 metadata.webhook must survive the advance; ` +
        `got: ${JSON.stringify(step1.metadata)}`,
    );
    assert.equal(step1.metadata.webhook.url, PRE_CHAIN_WEBHOOK.url);
    assert.deepEqual(step1.metadata.webhook.on, PRE_CHAIN_WEBHOOK.on);
    assert.equal(step1.metadata.webhook.allowLocal, PRE_CHAIN_WEBHOOK.allowLocal);
    assert.equal(step1.metadata.chainStep, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge chain start: no pre-chain webhook means no chain webhook (negative case)", async () => {
  const dir = freshDir();
  try {
    // Set a goal with NO webhook.
    await runGoalControlStateFile(dir, "set plain goal", Date.now());

    // Start a chain.
    await runGoalControlStateFile(
      dir,
      'chain start-json {"steps":[{"condition":"first"}]}',
      Date.now(),
    );

    const chain = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"));
    assert.equal(chain.webhook, undefined, "no pre-chain webhook → no chain.webhook");

    // The state on step 0 should also have no webhook.
    const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
    assert.equal(state.metadata.webhook, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
