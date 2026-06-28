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
 *   3. Terminal-history rows never route as live pending rows.
 *   4. Disabled-state contract is exposed as `noop`.
 */

import { describe, expect, test } from "bun:test";
import {
  actionDraftTemplateFromState,
  chainStartPayload,
  chainStepVisibleAction,
  chainStepVisibleSourceForState,
  DEFAULT_TEMPLATE_BUTTONS,
  type GoalActionDraftState,
  type GoalChainDraftStep,
  parseRuntimeChainSnapshot,
} from "./goal-panel-pure";

const runtimeChainSnapshot = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  id: "chain-1",
  steps: [
    {
      condition: "Build the production slice",
      command: "npm test",
      maxTurns: 3,
      maxMinutes: 5,
      category: "Building",
      tone: "blue",
      elevation: "raised",
      agent: "build",
      skills: ["skill-one", "skill-two"],
      model: { providerID: "openai", modelID: "gpt-5" },
    },
  ],
  current: 0,
  cycles: 0,
  maxCycles: 10,
  onComplete: "stop",
  metadata: { createdAt: 1_700_000_000_000, setBy: "user" },
  ...overrides,
});

describe("runtime chain snapshot parser", () => {
  test("maps a valid runtime chain into renderer chain data", () => {
    expect(parseRuntimeChainSnapshot(runtimeChainSnapshot())).toEqual({
      id: "chain-1",
      current: 0,
      steps: [
        {
          condition: "Build the production slice",
          command: "npm test",
          maxTurns: 3,
          maxTimeMinutes: 5,
          category: "Building",
          tone: "blue",
          elevation: "raised",
          agent: "build",
          skills: ["skill-one", "skill-two"],
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      ],
    });
  });

  test("rejects malformed snapshots instead of dropping invalid steps", () => {
    expect(parseRuntimeChainSnapshot(runtimeChainSnapshot({
      steps: [
        { condition: "valid", maxTurns: 1, maxMinutes: 1 },
        { command: "missing condition" },
      ],
    }))).toBeNull();
  });

  test("rejects fractional and out-of-range chain counters", () => {
    for (const patch of [
      { current: 0.5 },
      { current: -2 },
      { current: 1 },
      { cycles: 1.25 },
      { maxCycles: 2.5 },
    ]) {
      expect(parseRuntimeChainSnapshot(runtimeChainSnapshot(patch))).toBeNull();
    }
  });

  test("rejects malformed per-step budgets and pins", () => {
    for (const stepPatch of [
      { maxTurns: 1.2 },
      { maxMinutes: 0 },
      { skills: ["dup", "dup"] },
      { agent: "   " },
      { model: { providerID: "", modelID: "gpt-5" } },
    ]) {
      expect(parseRuntimeChainSnapshot(runtimeChainSnapshot({
        steps: [{ condition: "valid", ...stepPatch }],
      }))).toBeNull();
    }
  });
});

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

  test("2d. terminal achieved rows with a matching chain snapshot route as terminal history", () => {
    expect(chainStepVisibleSourceForState({
      hasLiveGoal: false,
      hasTerminalGoal: true,
      hasChainSnapshot: true,
    })).toBe("terminal-history");
    expect(chainStepVisibleSourceForState({
      hasLiveGoal: false,
      hasTerminalGoal: true,
      hasChainSnapshot: false,
    })).toBe("draft");
  });

  test("2e. explicit draft provenance wins over terminal snapshots", () => {
    expect(chainStepVisibleSourceForState({
      hasLiveGoal: false,
      hasTerminalGoal: true,
      hasChainSnapshot: true,
      draftSource: "draft",
      hasDraftSteps: false,
    })).toBe("draft");
    expect(chainStepVisibleSourceForState({
      hasLiveGoal: false,
      hasTerminalGoal: true,
      hasChainSnapshot: true,
      draftSource: "draft",
      hasDraftSteps: true,
    })).toBe("draft");
  });

  test("2f. active live goals still own runtime rows", () => {
    expect(chainStepVisibleSourceForState({
      hasLiveGoal: true,
      hasTerminalGoal: false,
      hasChainSnapshot: true,
      draftSource: "draft",
      hasDraftSteps: true,
    })).toBe("live");
  });

  test("3. terminal-history row uses explicit terminal cleanup when no live run exists", () => {
    const action = chainStepVisibleAction({
      source: "terminal-history",
      stepID: "terminal-step-0",
      index: 0,
      runningStepIndex: -1,
      liveRunStatus: null,
    });
    // The action is a distinct terminal cleanup command, NOT a live-pending remove.
    expect(action).toEqual({ kind: "remove-terminal-chain-step", index: 0 });
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

import { removeVisibleDraftStep, selectRunnableChainSteps } from "./goal-panel-pure";

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

  test("7. deleting a populated draft row edits the draft", () => {
    expect(
      removeVisibleDraftStep({
        draftSteps,
        visibleSteps: runtimeSteps,
        source: "draft",
        stepID: "d-1",
      }),
    ).toEqual([]);
  });

  test("8. deleting a recovered runtime row materializes the remaining rows as draft", () => {
    expect(
      removeVisibleDraftStep({
        draftSteps: [],
        visibleSteps: runtimeSteps,
        source: "uninitialized",
        stepID: "rt-1",
      }),
    ).toEqual([{ id: "rt-2" }]);
  });

  test("9. deleting the final recovered runtime row leaves an explicit empty draft", () => {
    expect(
      removeVisibleDraftStep({
        draftSteps: [],
        visibleSteps: [{ id: "rt-1" }],
        source: "uninitialized",
        stepID: "rt-1",
      }),
    ).toEqual([]);
  });
});

describe("chain orchestration payload contracts", () => {
  test("default action variables use operator-facing labels instead of raw scope terminology", () => {
    for (const template of DEFAULT_TEMPLATE_BUTTONS) {
      expect(template.variables?.scope?.description).toBeDefined();
      expect(template.variables?.scope?.description).not.toBe("Scope");
    }
  });

  test("action draft saves runtime routing pins and limits into the reusable action", () => {
    const draft: GoalActionDraftState = {
      sourceID: "debug",
      id: "",
      label: "Runtime route",
      prompt: "Debug {scope}",
      command: "bun test",
      turns: 2.6,
      minutes: 4.2,
      category: "Debugging",
      tone: "orange",
      elevation: "raised",
      agent: " build ",
      skills: ["frontend-design", "playwright"],
      model: "openai:gpt-5-codex",
    };

    const template = actionDraftTemplateFromState(draft, {
      variables: {
        scope: { description: "Scope" },
        unused: { description: "Unused" },
      },
    });

    expect(template).toMatchObject({
      id: "runtime-route",
      label: "Runtime route",
      condition: "Debug {scope}",
      command: "bun test",
      constraints: { maxTurns: 3, maxTimeMinutes: 4 },
      variables: { scope: { description: "Scope" } },
      category: "Debugging",
      tone: "orange",
      elevation: "raised",
      agent: "build",
      skills: ["frontend-design", "playwright"],
      model: { providerID: "openai", modelID: "gpt-5-codex" },
      builtin: false,
    });
  });

  test("chain start payload applies objective, budgets, verification, and per-step runtime pins", () => {
    const steps: GoalChainDraftStep[] = [
      {
        id: "step-1",
        actionID: "debug",
        label: "Debug",
        condition: "Debug the reported failure.",
        conditionTemplate: "Debug {scope}.",
        command: "bun test",
        maxTurns: 2,
        maxTimeMinutes: 3,
        category: "Debugging",
        tone: "orange",
        elevation: "raised",
        agent: " build ",
        skills: ["frontend-design", "playwright"],
        model: "openai:gpt-5-codex",
        builtin: true,
      },
      {
        id: "step-2",
        actionID: "validate",
        label: "Validate",
        condition: "Validate the current change.",
        conditionTemplate: "Validate {scope}.",
        command: "",
        maxTurns: 4,
        maxTimeMinutes: 5,
        category: "Testing",
        tone: "sky",
        elevation: "flat",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
        builtin: true,
      },
    ];

    const start = chainStartPayload(steps, { maxTurns: 10, maxTimeMinutes: 20 }, "the desktop chain smoke");
    const payload = JSON.parse(start.payload) as {
      master: { maxTurns: number; maxMinutes: number };
      steps: Array<Record<string, unknown>>;
    };

    expect(start).toMatchObject({
      firstStepAgent: "build",
      firstStepModel: { providerID: "openai", modelID: "gpt-5-codex" },
      firstStepSkills: ["frontend-design", "playwright"],
    });
    expect(payload.master).toEqual({ maxTurns: 10, maxMinutes: 20 });
    expect(payload.steps[0]).toMatchObject({
      condition: "Debug the desktop chain smoke.",
      command: "bun test",
      verification: { type: "shell", command: "bun test" },
      maxTurns: 2,
      maxMinutes: 3,
      category: "Debugging",
      tone: "orange",
      elevation: "raised",
      agent: "build",
      skills: ["frontend-design", "playwright"],
      model: { providerID: "openai", modelID: "gpt-5-codex" },
    });
    expect(payload.steps[1]).toMatchObject({
      condition: "Validate the desktop chain smoke.",
      verification: { type: "marker" },
      maxTurns: 4,
      maxMinutes: 5,
      category: "Testing",
      tone: "sky",
      elevation: "flat",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    });
    expect(payload.steps[1]).not.toHaveProperty("command");
  });
});

// ── AG-P1-07 — ordered chain refresh commits ─────────────────────────────────
//
// Acceptance criterion (ticket text):
//   "Polling can no longer resurrect older chain state through
//    out-of-order network completion."
//
// Required behavior:
//   - each read receives a monotonically increasing generation OR an abort signal
//   - only the latest generation commits to `setChain`
//   - `refreshChain()` returns a promise
//   - `refreshGoalSurfaces()` awaits the requested chain refresh
//   - interval and command-triggered refreshes share the same ordering guard
//   - component cleanup prevents late commits
//
// The pre-fix contract: `refreshChain = () => void readChain(sdk).then(setChain).catch(...)`.
// Returns void (not a promise). Two concurrent reads race on the network:
// request 2 finishes first and commits; request 1's late completion overwrites
// the newer state. The test pins this with an artificially-slow readChain mock.
//
// This test imports the dispatch helper (`createOrderedChainRefresh`) which the
// fix introduces. The helper takes a `readFn` that returns a Promise<ChainData | null>,
// an `onCommit` callback for setting the chain state, and returns a function
// that callers invoke to request a refresh. Each invocation bumps a generation
// counter; only the most recent generation's result commits.

type ChainData = {
  id: string;
  current: number;
  steps: Array<{ id: string }>;
};

interface OrderedChainRefresh {
  /** Request a refresh. Returns a promise that resolves when this request's
   *  result is either committed or discarded by the ordering guard. */
  request(): Promise<void>;
  /** Cancel any in-flight requests and prevent future late commits. */
  dispose(): void;
}

let createOrderedChainRefresh: (
  readFn: () => Promise<ChainData | null>,
  onCommit: (data: ChainData | null) => void,
  opts?: { backpressure?: boolean },
) => OrderedChainRefresh;

test("AG-P1-07: goal-panel-pure exports createOrderedChainRefresh", async () => {
  const mod = await import("./goal-panel-pure");
  expect(typeof mod.createOrderedChainRefresh).toBe("function");
  createOrderedChainRefresh = mod.createOrderedChainRefresh;
});

describe("AG-P1-07: createOrderedChainRefresh ordering guard", () => {
  test("1. resolves request 2 first, then request 1's late completion is ignored", async () => {
    let calls = 0;
    const commits: Array<ChainData | null> = [];

    // Mock readFn where request 2's network completes BEFORE request 1's.
    // The PRE-FIX code would commit request 2, then request 1's late
    // completion would overwrite the newer state — that's the defect.
    // POST-FIX: request 1's result must be discarded because it's stale.
    const readFn = () => {
      const myCall = ++calls;
      return new Promise<ChainData | null>((resolve) => {
        const delay = myCall === 1 ? 50 : 10;
        setTimeout(() => {
          resolve({
            id: "chain-1",
            current: myCall,
            steps: [{ id: `step-from-call-${myCall}` }],
          });
        }, delay);
      });
    };

    const refresh = createOrderedChainRefresh(readFn, (data) => {
      commits.push(data);
    });

    const r1 = refresh.request();
    const r2 = refresh.request();
    await Promise.all([r1, r2]);

    // Final state must reflect request 2, not request 1.
    expect(commits.length).toBeGreaterThanOrEqual(1);
    const final = commits[commits.length - 1];
    expect(final?.current).toBe(2);
    expect(final?.steps[0].id).toBe("step-from-call-2");

    // Request 1's stale result was discarded — commits never show current=1.
    const staleCommit = commits.find((c) => c?.current === 1);
    expect(staleCommit).toBeUndefined();

    refresh.dispose();
  });

  test("2. sequential requests commit in order, no commits are dropped", async () => {
    let calls = 0;
    const commits: Array<ChainData | null> = [];

    const readFn = () => {
      calls++;
      return Promise.resolve({
        id: "chain-1",
        current: calls,
        steps: [{ id: `step-${calls}` }],
      } satisfies ChainData);
    };

    const refresh = createOrderedChainRefresh(readFn, (data) => {
      commits.push(data);
    });

    await refresh.request();
    await refresh.request();
    await refresh.request();

    expect(commits.map((c) => c?.current)).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
    refresh.dispose();
  });

  test("3. each request's returned promise resolves when its result is committed or discarded", async () => {
    let calls = 0;
    let pending: Array<(v: ChainData | null) => void> = [];

    const readFn = () => {
      calls++;
      return new Promise<ChainData | null>((resolve) => {
        pending.push(resolve);
      });
    };

    const refresh = createOrderedChainRefresh(readFn, () => {});

    const r1 = refresh.request();
    const r2 = refresh.request();
    const r3 = refresh.request();

    expect(calls).toBe(3);

    // Resolve in REVERSE order: r3 first, r1 last.
    pending[2]({ id: "c", current: 3, steps: [] });
    pending[1]({ id: "b", current: 2, steps: [] });
    pending[0]({ id: "a", current: 1, steps: [] });

    // All three promises must resolve (none hang forever).
    await Promise.all([r1, r2, r3]);
    refresh.dispose();
  });

  test("4. dispose() prevents late commits from in-flight requests", async () => {
    let calls = 0;
    const commits: Array<ChainData | null> = [];

    const readFn = () => {
      calls++;
      return new Promise<ChainData | null>((resolve) => {
        setTimeout(() => {
          resolve({ id: "c", current: calls, steps: [] });
        }, 20);
      });
    };

    const refresh = createOrderedChainRefresh(readFn, (data) => {
      commits.push(data);
    });

    refresh.request();
    refresh.request();
    refresh.dispose();

    // Wait long enough for the setTimeout to fire.
    await new Promise((r) => setTimeout(r, 50));

    // No commits should have happened after dispose.
    expect(commits.length).toBe(0);
  });

  test("5. null result (chain absent) commits as null, does not break ordering", async () => {
    const commits: Array<ChainData | null> = [];
    let calls = 0;

    const readFn = () => {
      calls++;
      return calls === 1
        ? Promise.resolve({ id: "c", current: 0, steps: [] } satisfies ChainData)
        : Promise.resolve(null);
    };

    const refresh = createOrderedChainRefresh(readFn, (data) => {
      commits.push(data);
    });

    await refresh.request();
    await refresh.request();

    expect(commits).toHaveLength(2);
    expect(commits[0]?.current).toBe(0);
    expect(commits[1]).toBeNull();
    refresh.dispose();
  });

  test("6. rapid burst of N requests: only the last one's result commits", async () => {
    let calls = 0;
    const commits: Array<ChainData | null> = [];

    const readFn = () => {
      const myCall = ++calls;
      // Each call takes a slightly different time so they finish out of order.
      return new Promise<ChainData | null>((resolve) => {
        setTimeout(
          () => {
            resolve({ id: "c", current: myCall, steps: [] });
          },
          // Reverse ordering of completion times vs call order:
          // call 1 finishes last (100ms), call N finishes first (10ms).
          100 - myCall * 10 + 10,
        );
      });
    };

    const refresh = createOrderedChainRefresh(readFn, (data) => {
      commits.push(data);
    });

    const promises = Array.from({ length: 5 }, () => refresh.request());
    await Promise.all(promises);

    // Only the LAST-requested result commits. The exact data is the
    // call-N result where N=5.
    expect(commits.length).toBeGreaterThanOrEqual(1);
    const final = commits[commits.length - 1];
    expect(final?.current).toBe(5);

    // No commit with current < 5 should appear (those were stale).
    const stale = commits.find((c) => c?.current !== undefined && c.current < 5);
    expect(stale).toBeUndefined();

    refresh.dispose();
  });
});

// ── C3: backpressure option ────────────────────────────────────────────────

describe("C3: createOrderedChainRefresh backpressure option", () => {
  test("C3.1: backpressure=false (default): concurrent requests each start a new read", async () => {
    let calls = 0;
    const readFn = () => {
      calls++;
      return new Promise<ChainData | null>((resolve) =>
        setTimeout(() => resolve({ id: "c", current: calls, steps: [] }), 20),
      );
    };
    const refresh = createOrderedChainRefresh(readFn, () => {});

    // Fire two concurrent requests.
    const promises = [refresh.request(), refresh.request()];
    await Promise.all(promises);

    // Without backpressure, both calls went through (the second's
    // result wins via the generation counter, the first's is
    // discarded).
    expect(calls).toBe(2);
    refresh.dispose();
  });

  test("C3.2: backpressure=true: concurrent requests share the in-flight read", async () => {
    let calls = 0;
    const readFn = () => {
      calls++;
      return new Promise<ChainData | null>((resolve) =>
        setTimeout(() => resolve({ id: "c", current: calls, steps: [] }), 30),
      );
    };
    const refresh = createOrderedChainRefresh(readFn, () => {}, { backpressure: true });

    // Fire two concurrent requests.
    const promises = [refresh.request(), refresh.request()];
    await Promise.all(promises);

    // With backpressure, only ONE call was made. The second
    // request returned the same promise as the first.
    expect(calls).toBe(1);
    refresh.dispose();
  });

  test("C3.3: backpressure: sequential requests after settle start fresh reads", async () => {
    let calls = 0;
    const readFn = () => {
      calls++;
      return new Promise<ChainData | null>((resolve) =>
        setTimeout(() => resolve({ id: "c", current: calls, steps: [] }), 10),
      );
    };
    const refresh = createOrderedChainRefresh(readFn, () => {}, { backpressure: true });

    // Sequential (not concurrent): each request should start a fresh read.
    await refresh.request();
    await refresh.request();
    await refresh.request();

    expect(calls).toBe(3);
    refresh.dispose();
  });

  test("C3.4: backpressure: returns the same promise for concurrent calls", async () => {
    const readFn = () =>
      new Promise<ChainData | null>((resolve) =>
        setTimeout(() => resolve({ id: "c", current: 1, steps: [] }), 20),
      );
    const refresh = createOrderedChainRefresh(readFn, () => {}, { backpressure: true });

    const p1 = refresh.request();
    const p2 = refresh.request();
    expect(p1).toBe(p2);

    await Promise.all([p1, p2]);
    refresh.dispose();
  });

  test("C3.5: backpressure: error in read does not lock out future requests", async () => {
    let calls = 0;
    const readFn = () => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error("transient SDK failure"));
      }
      return Promise.resolve({ id: "c", current: calls, steps: [] });
    };
    const refresh = createOrderedChainRefresh(readFn, () => {}, { backpressure: true });

    // First request fails.
    await refresh.request();
    // Second request should start a fresh read (the slot must have
    // been cleared by the rejected promise's .finally).
    const p2 = refresh.request();
    expect(calls).toBe(2);
    await p2;

    refresh.dispose();
  });
});
