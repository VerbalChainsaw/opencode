/**
 * AG-P1-05 — every X button operates on the data source the user is
 * actually viewing.
 *
 * The chain panel renders the same row layout for three distinct
 * sources: the local draft, the live runtime chain, and the terminal
 * run history. The previous code routed the X by `liveGoal()` as a
 * proxy, which silently merged the three. The pure selector below is
 * the new routing layer: each row carries a visible source and the
 * X dispatches to the correct mutator.
 *
 * These tests pin the four invariants called out in the ticket:
 *   1. Draft rows always edit local draft; they never reach the runtime chain.
 *   2. Live rows route to the live-pending remover, with the existing
 *      running/done guard preserved.
 *   3. Terminal-history rows never touch the live chain file.
 *   4. Disabled-state contract is exposed as `noop`.
 */

import { describe, expect, test } from "bun:test";
import { chainStepVisibleAction } from "./goal-panel-pure";

describe("AG-P1-05: chainStepVisibleAction routes by visible source", () => {
  test("1. draft row always edits the local draft, never the live chain", () => {
    const action = chainStepVisibleAction({
      source: "draft",
      stepID: "draft-step-1",
      index: 0,
      runningStepIndex: -1,
      liveRunStatus: null,
    });
    expect(action).toEqual({ kind: "edit-draft", stepID: "draft-step-1" });
  });

  test("1b. draft row still edits local draft even when a live run exists", () => {
    // The proxy bug: previously a draft X would route to removeLiveChainStep
    // when liveGoal() was truthy. That was wrong — the user is editing the
    // draft; the live run is a separate concern. The new selector pins the
    // invariant that source wins over liveGoal() presence.
    const action = chainStepVisibleAction({
      source: "draft",
      stepID: "draft-step-1",
      index: 0,
      runningStepIndex: 0,
      liveRunStatus: "active",
    });
    expect(action).toEqual({ kind: "edit-draft", stepID: "draft-step-1" });
  });

  test("2. live row past the running step routes to remove-live-pending", () => {
    const action = chainStepVisibleAction({
      source: "live",
      stepID: "live-step-2",
      index: 2,
      runningStepIndex: 1,
      liveRunStatus: "active",
    });
    expect(action).toEqual({ kind: "remove-live-pending", index: 2 });
  });

  test("2b. live row at or before the running step is noop (running/done guard)", () => {
    const atRunning = chainStepVisibleAction({
      source: "live",
      stepID: "live-step-1",
      index: 1,
      runningStepIndex: 1,
      liveRunStatus: "active",
    });
    expect(atRunning).toEqual({ kind: "noop" });

    const beforeRunning = chainStepVisibleAction({
      source: "live",
      stepID: "live-step-0",
      index: 0,
      runningStepIndex: 1,
      liveRunStatus: "active",
    });
    expect(beforeRunning).toEqual({ kind: "noop" });
  });

  test("2c. live row in a terminal-state run allows removal even at running index", () => {
    // v0.7.3 escape hatch: a chain whose step 0 was achieved but never
    // advanced can have current=0; the user must still be able to clear
    // the leftover step. Both 'achieved' and 'cleared' qualify.
    for (const status of ["achieved", "cleared"] as const) {
      const action = chainStepVisibleAction({
        source: "live",
        stepID: "live-step-0",
        index: 0,
        runningStepIndex: 0,
        liveRunStatus: status,
      });
      expect(action).toEqual({ kind: "remove-live-pending", index: 0 });
    }
  });

  test("3. terminal-history row never touches the live chain file", () => {
    const action = chainStepVisibleAction({
      source: "terminal-history",
      stepID: "terminal-step-0",
      index: 0,
      runningStepIndex: -1,
      liveRunStatus: null,
    });
    // The action is a distinct dismiss-terminal command, NOT a remove.
    // The tsx layer wires this to archive/reset; the runtime chain
    // file is never touched.
    expect(action).toEqual({ kind: "dismiss-terminal" });
    expect(action.kind).not.toBe("remove-live-pending");
  });

  test("3b. terminal-history row stays dismiss-terminal even when live run is also active", () => {
    // Two layers coexist (live + terminal). The X on the terminal row
    // must dismiss the terminal, not interfere with the live run.
    const action = chainStepVisibleAction({
      source: "terminal-history",
      stepID: "terminal-step-2",
      index: 2,
      runningStepIndex: 1,
      liveRunStatus: "active",
    });
    expect(action).toEqual({ kind: "dismiss-terminal" });
  });

  test("4. noop contract is exposed for disabled rendering", () => {
    // The tsx layer renders `disabled` from a separate run-state signal
    // (already in place via `stepRunState`). The pure selector's `noop`
    // makes the routing layer's contract explicit so future refactors
    // can rely on it.
    const action = chainStepVisibleAction({
      source: "live",
      stepID: "live-step-current",
      index: 1,
      runningStepIndex: 1,
      liveRunStatus: "paused",
    });
    expect(action).toEqual({ kind: "noop" });
  });
});

// ── AG-P0-04 — Chain draft explicit provenance (preserved from earlier) ──────
//
// See step-5-ag-p0-04.md handoff. The tests below pin the
// `selectRunnableChainSteps` selector's source-aware behavior; the
// AG-P1-05 tests above pin the row-level X-button routing. Both live
// in the same pure module so the contract is centralized.

import { selectRunnableChainSteps } from "./goal-panel-pure";

type Step = { id: string };

const runtimeSteps: Step[] = [
  { id: "rt-1" },
  { id: "rt-2" },
];
const draftSteps: Step[] = [
  { id: "d-1" },
];

describe("AG-P0-04: selectRunnableChainSteps with explicit draft provenance", () => {
  test("1. populated draft is used regardless of source", () => {
    expect(
      selectRunnableChainSteps(draftSteps, runtimeSteps, "draft"),
    ).toEqual(draftSteps);
    expect(
      selectRunnableChainSteps(draftSteps, runtimeSteps, "uninitialized"),
    ).toEqual(draftSteps);
  });

  test("2. uninitialized empty draft falls back to runtime snapshot (recoverable)", () => {
    expect(
      selectRunnableChainSteps([], runtimeSteps, "uninitialized"),
    ).toEqual(runtimeSteps);
  });

  test("3. explicit empty draft (source=draft, steps=[]) is intentionally empty — no recovery", () => {
    expect(
      selectRunnableChainSteps([], runtimeSteps, "draft"),
    ).toEqual([]);
  });

  test("4. default source value preserves prior two-arg call shape (backward compatible)", () => {
    expect(selectRunnableChainSteps([], runtimeSteps)).toEqual(runtimeSteps);
    expect(selectRunnableChainSteps(draftSteps, runtimeSteps)).toEqual(
      draftSteps,
    );
  });

  test("5. liveGoal() guard is the caller's responsibility; selector returns draft deterministically", () => {
    expect(
      selectRunnableChainSteps(draftSteps, [], "draft"),
    ).toEqual(draftSteps);
    expect(
      selectRunnableChainSteps([], [], "draft"),
    ).toEqual([]);
    expect(
      selectRunnableChainSteps([], [], "uninitialized"),
    ).toEqual([]);
  });

  test("6. session switch restores source from persisted draft — empty+draft survives reload", () => {
    const reloaded = { steps: [] as Step[], source: "draft" as const };
    expect(
      selectRunnableChainSteps(
        reloaded.steps,
        runtimeSteps,
        reloaded.source,
      ),
    ).toEqual([]);
  });
});