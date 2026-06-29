/**
 * Pure logic for the composer goal badge (the A+B indicator): operator-colored
 * step dots + "k/N" count, plus the band color for the composer's left edge.
 *
 * The colors come from the active chain step's operator `tone`
 * (violet/blue/orange/emerald/fuchsia/sky). A single (non-chain) goal renders
 * one status-colored dot. Paused → amber, stalled → orange. No active goal →
 * an "idle" affordance (a quiet "set goal" chip).
 *
 * Kept framework-free so it unit-tests without the renderer.
 */
import type { GoalState } from "./goal-panel-pure"
import type { GoalTemplateTone, RuntimeChainData } from "./goal-panel-pure"

export const GOAL_CHAIN_PATH = ".opencode/.goal-chain.json"

/** Operator tone → hex. Vibrant enough to read on the dark composer surface. */
export const TONE_HEX: Record<GoalTemplateTone, string> = {
  violet: "#8b5cf6",
  blue: "#3b82f6",
  orange: "#f97316",
  emerald: "#10b981",
  fuchsia: "#d946ef",
  sky: "#38bdf8",
}

const STATUS_HEX = {
  active: "#10b981", // emerald — running
  paused: "#f59e0b", // amber
  stalled: "#f97316", // orange
} as const

export type ComposerGoalKind = "active" | "paused" | "stalled" | "idle"

export interface ComposerGoalDot {
  /** hex color for the dot */
  color: string
  /** a completed step (before current) */
  done: boolean
  /** the current/active step */
  active: boolean
}

export interface ComposerGoalIndicator {
  kind: ComposerGoalKind
  /** 1-based current step for display; 0 when there is no chain. */
  stepCurrent: number
  /** total steps; 0 when there is no chain. */
  stepTotal: number
  /** operator-colored dots, one per chain step (empty for a single goal). */
  dots: ComposerGoalDot[]
  /** color for the badge accent + the composer left band. */
  bandColor: string
  /** short, sanitized goal condition for the title tooltip. */
  title: string
}

function toneColor(tone: GoalTemplateTone | undefined): string {
  return tone ? TONE_HEX[tone] ?? STATUS_HEX.active : STATUS_HEX.active
}

/** Clamp a chain index into [0, len-1]; returns 0 for an empty chain. */
function clampIndex(current: number, len: number): number {
  if (len <= 0) return 0
  if (!Number.isFinite(current) || current < 0) return 0
  if (current > len - 1) return len - 1
  return current
}

export interface BuildIndicatorInput {
  state: GoalState | null
  chain: RuntimeChainData | null
  now: number
  /** active goal with no movement for this long reads as stalled. */
  stalledAfterMs?: number
}

/**
 * Build the composer indicator from the polled goal state + chain. Returns the
 * `idle` kind (a "set goal" affordance) when there is no live goal — never
 * null, so the composer always has a small, consistent goal anchor.
 */
export function buildComposerGoalIndicator(input: BuildIndicatorInput): ComposerGoalIndicator {
  const { state, chain, now } = input
  const stalledAfterMs = input.stalledAfterMs ?? 10 * 60 * 1000

  const idle: ComposerGoalIndicator = {
    kind: "idle",
    stepCurrent: 0,
    stepTotal: 0,
    dots: [],
    bandColor: "transparent",
    title: "",
  }

  // Only a live (active/paused) goal drives the badge. cleared/achieved/absent
  // → idle. This mirrors buildHomeGoalRecords' active/paused filter so a stale
  // or terminal goal never lights up the composer.
  if (!state || (state.status !== "active" && state.status !== "paused")) return idle

  const title = (state.condition ?? "").slice(0, 200)

  // Chain steps must belong to this goal's chain. The renderer already gates
  // the chain read on chainMatchesGoal; here we additionally require a non-empty
  // step list to treat it as a chain.
  const steps = chain?.steps ?? []
  const isChain = steps.length > 0
  const currentIdx = isChain ? clampIndex(chain!.current, steps.length) : 0

  let kind: ComposerGoalKind = state.status === "paused" ? "paused" : "active"
  if (kind === "active") {
    const lastMove = state.lastEvaluation?.timestamp ?? state.resumedAt ?? state.startedAt ?? 0
    if (lastMove > 0 && now - lastMove > stalledAfterMs) kind = "stalled"
  }

  const activeTone = isChain ? steps[currentIdx]?.tone : undefined
  const bandColor =
    kind === "paused" ? STATUS_HEX.paused : kind === "stalled" ? STATUS_HEX.stalled : toneColor(activeTone)

  const dots: ComposerGoalDot[] = isChain
    ? steps.map((step, i) => ({
        color: toneColor(step.tone),
        done: i < currentIdx,
        active: i === currentIdx,
      }))
    : []

  return {
    kind,
    stepCurrent: isChain ? currentIdx + 1 : 0, // 1-based display
    stepTotal: isChain ? steps.length : 0,
    dots,
    bandColor,
    title,
  }
}
