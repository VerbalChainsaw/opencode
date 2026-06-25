/**
 * AG-P0-04 — Chain draft explicit provenance.
 *
 * The local chain draft has two distinct empty states:
 *   - `uninitialized` (no key in sessionStorage, or fresh default) — the
 *     user has never touched the draft; the selector may fall back to
 *     the runtime chain snapshot.
 *   - `draft` (user mutated, OR explicitly cleared) — the draft is the
 *     authoritative source; an empty `draft` is intentional and the
 *     selector MUST NOT fall back to runtime.
 *
 * Without the `source` field, "last X revives the whole list" can occur
 * because the selector cannot tell these two cases apart.
 */

import { describe, expect, test } from "bun:test";
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
    // No key in sessionStorage yet, runtime chain exists → recover.
    expect(
      selectRunnableChainSteps([], runtimeSteps, "uninitialized"),
    ).toEqual(runtimeSteps);
  });

  test("3. explicit empty draft (source=draft, steps=[]) is intentionally empty — no recovery", () => {
    // User deleted the last step or hit Clear Draft. The runtime
    // snapshot MUST NOT be resurrected. This is the central fix for
    // the "last X revives the whole list" sequence.
    expect(
      selectRunnableChainSteps([], runtimeSteps, "draft"),
    ).toEqual([]);
  });

  test("4. default source value preserves prior two-arg call shape (backward compatible)", () => {
    // Callers that omit `source` get the prior behavior: empty draft
    // falls back to runtime. The new 3-arg form is opt-in for the
    // call sites that already track source.
    expect(selectRunnableChainSteps([], runtimeSteps)).toEqual(runtimeSteps);
    expect(selectRunnableChainSteps(draftSteps, runtimeSteps)).toEqual(
      draftSteps,
    );
  });

  test("5. liveGoal() guard is the caller's responsibility; selector returns draft deterministically", () => {
    // The tsx guard at the call site (`if (liveGoal()) return []`)
    // short-circuits before the selector runs. The selector itself
    // is pure and does not know about live state — it just maps
    // (draftSteps, visibleSteps, source) → T[].
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
    // Simulates the persistence round-trip:
    //   1. User clears the draft → { source: "draft", steps: [] }.
    //   2. Reload reads it back via readStoredChainDraft().
    //   3. Selector receives source="draft" + empty steps + runtime chain.
    // The result must be empty (no fallback). This is what the
    // `setChainDraft("source", next.source)` line at the session-switch
    // effect guarantees.
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