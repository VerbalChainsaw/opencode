import { describe, expect, test } from "bun:test"

import type { GoalState } from "./goal-panel"
import {
  STATUS_META,
  liveGoal,
  nodeColor,
  outcomeLabel,
  shouldShowCreateForm,
  statusMeta,
} from "./goal-panel-lifecycle"

const baseState: GoalState = {
  id: "g1",
  condition: "All tests pass",
  command: "npm test",
  status: "active",
  startedAt: 1_700_000_000_000,
  completedAt: null,
  turnsEvaluated: 1,
  tokensUsed: 0,
  lastEvaluation: null,
  evaluationHistory: [],
  constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100_000 },
}

function withStatus(status: GoalState["status"]): GoalState {
  return { ...baseState, status }
}

// ── liveGoal ──────────────────────────────────────────────────────────────
//
// The single most important rule in the lifecycle model: a state object
// is "live" only while it's active or paused. Anything else (including
// a null/missing state) returns null so the panel falls through to the
// empty + history view. Bug A and Bug B are both fixed by this rule.

describe("liveGoal", () => {
  test("returns the state for an active goal", () => {
    expect(liveGoal(withStatus("active"))?.id).toBe("g1")
  })

  test("returns the state for a paused goal", () => {
    expect(liveGoal(withStatus("paused"))?.id).toBe("g1")
  })

  test("returns null for an achieved goal (Bug B: one-turn achieve)", () => {
    // REGRESSION: previously the panel rendered a hollow "active" card
    // when a goal was set and achieved in the same turn, because the
    // view branched on "is there a state object?" instead of on status.
    // liveGoal returning null here means the empty + history view
    // renders instead — the run is in history, not as a live card.
    expect(liveGoal(withStatus("achieved"))).toBeNull()
  })

  test("returns null for a cleared goal (Bug A: stop blanks the panel)", () => {
    // REGRESSION: previously clearing a goal made the panel disappear.
    // liveGoal returning null here means the empty + history view
    // renders, and the history timeline shows the cleared run.
    expect(liveGoal(withStatus("cleared"))).toBeNull()
  })

  test("returns null for a null state", () => {
    expect(liveGoal(null)).toBeNull()
  })

  test("returns null for an undefined state", () => {
    expect(liveGoal(undefined)).toBeNull()
  })
})

// ── shouldShowCreateForm ──────────────────────────────────────────────────
//
// The form is the empty-state affordance. The only times it should NOT
// show are: there is a live goal AND the user did not explicitly ask
// for the form.

describe("shouldShowCreateForm", () => {
  test("shows when there is no state at all (empty workspace)", () => {
    expect(shouldShowCreateForm(null, false)).toBe(true)
  })

  test("shows when a cleared goal is the current state (Bug A)", () => {
    // After clear, no live goal → form shows so the user can start
    // the next goal without hunting for the entry point.
    expect(shouldShowCreateForm(withStatus("cleared"), false)).toBe(true)
  })

  test("shows when an achieved goal is the current state (Bug B)", () => {
    // After one-turn achieve, no live goal → form shows.
    expect(shouldShowCreateForm(withStatus("achieved"), false)).toBe(true)
  })

  test("does NOT show when there is a live (active) goal", () => {
    expect(shouldShowCreateForm(withStatus("active"), false)).toBe(false)
  })

  test("does NOT show when there is a live (paused) goal", () => {
    expect(shouldShowCreateForm(withStatus("paused"), false)).toBe(false)
  })

  test("shows when the user explicitly asked, even with a live goal", () => {
    // The "New goal" affordance: replace a live goal with a new one.
    // This keeps the panel from being a dead end on achieved goals.
    expect(shouldShowCreateForm(withStatus("active"), true)).toBe(true)
    expect(shouldShowCreateForm(withStatus("paused"), true)).toBe(true)
  })

  test("shows when the user explicitly asked, with no state at all", () => {
    expect(shouldShowCreateForm(null, true)).toBe(true)
  })
})

// ── STATUS_META ───────────────────────────────────────────────────────────
//
// The mission-control status system. Every lifecycle status must have
// meta, and the four must be visually distinct (different colors) so
// status is legible at a glance.

describe("STATUS_META", () => {
  const allStatuses: Array<keyof typeof STATUS_META> = [
    "active",
    "paused",
    "achieved",
    "cleared",
  ]

  test("covers all four lifecycle statuses", () => {
    for (const s of allStatuses) {
      expect(STATUS_META[s]).toBeDefined()
    }
  })

  test("every status has a non-empty label, dot, text, and glyph", () => {
    for (const s of allStatuses) {
      const m = STATUS_META[s]
      expect(m.label.length).toBeGreaterThan(0)
      expect(m.dot.length).toBeGreaterThan(0)
      expect(m.text.length).toBeGreaterThan(0)
      expect(m.glyph.length).toBeGreaterThan(0)
    }
  })

  test("status colors are distinct (no two statuses share a color)", () => {
    // A status that reads as "active" but is colored like "cleared"
    // is a bug — colors must be visually distinct.
    const dots = new Set(allStatuses.map((s) => STATUS_META[s].dot))
    const texts = new Set(allStatuses.map((s) => STATUS_META[s].text))
    expect(dots.size).toBe(allStatuses.length)
    expect(texts.size).toBe(allStatuses.length)
  })

  test("'cancelled' label is used for cleared (user-facing rename)", () => {
    // The user's mental model is "cancelled", not the engine's
    // internal "cleared" — verify the label reflects that.
    expect(STATUS_META.cleared.label.toLowerCase()).toBe("cancelled")
  })

  test("statusMeta falls back to active for unknown status", () => {
    // Defensive: if a future status slips through, don't crash the
    // render — fall back to the most common state.
    const m = statusMeta("unknown" as never)
    expect(m).toBe(STATUS_META.active)
  })

  test("statusMeta falls back to active for undefined", () => {
    expect(statusMeta(undefined)).toBe(STATUS_META.active)
  })
})

// ── nodeColor ─────────────────────────────────────────────────────────────
//
// The history timeline node color. The rail renders one node per past
// run, and the node color encodes the run's outcome.

describe("nodeColor", () => {
  test("success → emerald", () => {
    expect(nodeColor("success")).toBe("bg-emerald-400")
  })

  test("mixed → amber", () => {
    expect(nodeColor("mixed")).toBe("bg-amber-400")
  })

  test("failure → rose", () => {
    expect(nodeColor("failure")).toBe("bg-rose-400")
  })

  test("unknown status → muted fallback (don't crash the rail)", () => {
    // Defense: a corrupt or future archive entry must not throw.
    const color = nodeColor("garbage")
    expect(color.startsWith("bg-")).toBe(true)
  })
})

// ── outcomeLabel ──────────────────────────────────────────────────────────
//
// Human label for a history run outcome. The engine stores raw strings;
// the user's mental model has friendlier names.

describe("outcomeLabel", () => {
  test("cleared → 'Cancelled'", () => {
    // The whole point: a cleared run is read as "Cancelled" so the
    // history timeline matches the live card's status meta.
    expect(outcomeLabel("cleared")).toBe("Cancelled")
  })

  test("achieved → 'Achieved'", () => {
    expect(outcomeLabel("achieved")).toBe("Achieved")
  })

  test("replaced → 'Replaced'", () => {
    expect(outcomeLabel("replaced")).toBe("Replaced")
  })

  test("unknown outcome passes through unchanged (passthrough, not crash)", () => {
    // Defense: an unknown outcome string should be shown as-is rather
    // than dropped. The history timeline must be lossless.
    expect(outcomeLabel("foo-bar")).toBe("foo-bar")
  })
})
