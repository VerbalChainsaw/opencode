import { describe, expect, test } from "bun:test"
import {
  buildComposerGoalIndicator,
  TONE_HEX,
  type ComposerGoalIndicator,
} from "./goal-composer-badge-pure"
import type { GoalState, RuntimeChainData } from "./goal-panel-pure"

const NOW = 1_782_700_000_000

function state(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: "g1",
    condition: "make the build green",
    status: "active",
    startedAt: NOW - 60_000,
    completedAt: null,
    turnsEvaluated: 1,
    tokensUsed: 0,
    lastEvaluation: { met: false, reason: "x", confidence: 0.5, timestamp: NOW - 1000, evaluatorType: "heuristic" },
    evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    ...overrides,
  } as GoalState
}

function chain(tones: Array<RuntimeChainData["steps"][number]["tone"]>, current: number): RuntimeChainData {
  return {
    id: "c1",
    current,
    steps: tones.map((tone) => ({ condition: "step", ...(tone ? { tone } : {}) })),
  }
}

describe("buildComposerGoalIndicator", () => {
  test("no goal → idle", () => {
    const i = buildComposerGoalIndicator({ state: null, chain: null, now: NOW })
    expect(i.kind).toBe("idle")
    expect(i.bandColor).toBe("transparent")
  })

  test("cleared/achieved goal → idle (never lights up a terminal goal)", () => {
    expect(buildComposerGoalIndicator({ state: state({ status: "cleared" }), chain: null, now: NOW }).kind).toBe("idle")
    expect(buildComposerGoalIndicator({ state: state({ status: "achieved" }), chain: null, now: NOW }).kind).toBe("idle")
  })

  test("active single goal (no chain) → active, no dots, no step count, emerald band", () => {
    const i = buildComposerGoalIndicator({ state: state(), chain: null, now: NOW })
    expect(i.kind).toBe("active")
    expect(i.dots).toEqual([])
    expect(i.stepCurrent).toBe(0)
    expect(i.stepTotal).toBe(0)
    expect(i.bandColor).toBe("#10b981")
    expect(i.title).toBe("make the build green")
  })

  test("active chain → 1-based step, operator-colored dots, band = active step tone", () => {
    const i: ComposerGoalIndicator = buildComposerGoalIndicator({
      state: state(),
      chain: chain(["emerald", "fuchsia", "blue"], 1),
      now: NOW,
    })
    expect(i.kind).toBe("active")
    expect(i.stepCurrent).toBe(2) // 0-based current 1 → "2/3"
    expect(i.stepTotal).toBe(3)
    expect(i.dots).toHaveLength(3)
    expect(i.dots[0]).toEqual({ color: TONE_HEX.emerald, done: true, active: false })
    expect(i.dots[1]).toEqual({ color: TONE_HEX.fuchsia, done: false, active: true })
    expect(i.dots[2]).toEqual({ color: TONE_HEX.blue, done: false, active: false })
    expect(i.bandColor).toBe(TONE_HEX.fuchsia) // active step's operator tone
  })

  test("paused → amber band regardless of step tone", () => {
    const i = buildComposerGoalIndicator({
      state: state({ status: "paused" }),
      chain: chain(["emerald", "fuchsia"], 0),
      now: NOW,
    })
    expect(i.kind).toBe("paused")
    expect(i.bandColor).toBe("#f59e0b")
  })

  test("active goal with no movement past threshold → stalled, orange band", () => {
    const stale = state({ lastEvaluation: { met: false, reason: "x", confidence: 0.5, timestamp: NOW - 20 * 60 * 1000, evaluatorType: "heuristic" } })
    const i = buildComposerGoalIndicator({ state: stale, chain: chain(["blue"], 0), now: NOW, stalledAfterMs: 10 * 60 * 1000 })
    expect(i.kind).toBe("stalled")
    expect(i.bandColor).toBe("#f97316")
  })

  test("chain current index out of bounds clamps to last step", () => {
    const i = buildComposerGoalIndicator({ state: state(), chain: chain(["emerald", "blue"], 9), now: NOW })
    expect(i.stepCurrent).toBe(2)
    expect(i.dots[1].active).toBe(true)
  })

  test("a step with an unknown/missing tone falls back to a readable color (no crash)", () => {
    const i = buildComposerGoalIndicator({ state: state(), chain: chain([undefined], 0), now: NOW })
    expect(i.dots).toHaveLength(1)
    expect(typeof i.dots[0].color).toBe("string")
  })
})
