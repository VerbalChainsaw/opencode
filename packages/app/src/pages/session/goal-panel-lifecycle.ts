/**
 * Goal panel lifecycle model.
 *
 * The panel renders strictly by STATUS, not by "is there a state object?".
 * This file owns the pure accessors that drive that rendering:
 *
 *   - `liveGoal(state)` returns the state ONLY while it's active or paused;
 *     a terminal goal (achieved/cleared) or a missing goal both fall through
 *     to the empty + history view. This makes the two failure modes
 *     structurally impossible:
 *
 *       - a goal achieved in one turn never shows a hollow "active" card —
 *         it becomes a finished run in the history timeline.
 *
 *       - clearing a goal doesn't blank the panel — the run drops into
 *         history and the empty/create view reappears.
 *
 *   - `STATUS_META` is the mission-control status system: semantic accent
 *     colors for the four lifecycle states so status is legible at a glance.
 *
 *   - `nodeColor` / `outcomeLabel` are the history-timeline presenters:
 *     node color by run outcome, and a human label (a cleared run reads
 *     as "Cancelled", matching the user's mental model).
 *
 * These accessors are pure so the lifecycle contract is testable without a
 * render harness, and so a future contributor can't accidentally re-introduce
 * the "view branches on truthiness instead of status" bug class.
 */

import type { GoalState } from "./goal-panel-pure"

export type GoalLifecycleStatus = "active" | "paused" | "achieved" | "cleared"

export interface StatusMeta {
  /** Human-readable label for the status (e.g. "Active", "Cancelled"). */
  label: string
  /** Tailwind class for the status dot. */
  dot: string
  /** Tailwind class for the status text. */
  text: string
  /** Single glyph for the status (e.g. "▸", "✓", "✕"). */
  glyph: string
}

export const STATUS_META: Record<GoalLifecycleStatus, StatusMeta> = {
  active: { label: "Active", dot: "bg-sky-400", text: "text-sky-400", glyph: "▸" },
  paused: { label: "Paused", dot: "bg-amber-400", text: "text-amber-400", glyph: "⏸" },
  achieved: { label: "Achieved", dot: "bg-emerald-400", text: "text-emerald-400", glyph: "✓" },
  cleared: { label: "Cancelled", dot: "bg-zinc-400", text: "text-text-weaker", glyph: "✕" },
}

export function statusMeta(s: GoalLifecycleStatus | undefined): StatusMeta {
  return STATUS_META[s ?? "active"] ?? STATUS_META.active
}

/**
 * The "live" goal: the state ONLY while it's active or paused. Any other
 * status (or a missing state) returns `null` so the panel falls through
 * to the empty + history view.
 *
 * Bug A (clearing a goal blanks the panel) and Bug B (one-turn achieve
 * leaves a hollow "active" card) are both fixed by this single rule.
 */
export function liveGoal(state: GoalState | null | undefined): GoalState | null {
  if (!state) return null
  if (state.status === "active" || state.status === "paused") return state
  return null
}

/**
 * The current terminal goal, if the state file still points at one.
 *
 * Terminal goals are not "live" controls, but the user still needs a visible
 * record of what just happened when the archive snapshot is missing or slow.
 */
export function terminalGoal(state: GoalState | null | undefined): GoalState | null {
  if (!state) return null
  if (state.status === "achieved" || state.status === "cleared") return state
  return null
}

/**
 * History timeline: node color by run outcome. The timeline itself lives
 * outside the status system (it shows past runs of all outcomes), so this
 * is keyed on the run's `status` field from the archive, not the goal's
 * lifecycle status.
 */
export function nodeColor(historyStatus: string): string {
  if (historyStatus === "success") return "bg-emerald-400"
  if (historyStatus === "mixed") return "bg-amber-400"
  if (historyStatus === "failure") return "bg-rose-400"
  // Fallback for unknown statuses — keep the rail rendering consistently.
  return "bg-zinc-400"
}

/**
 * Human label for a history run outcome. The engine stores the raw
 * `outcome` string; we map the cleared outcome to "Cancelled" because
 * that matches the user's mental model (and is what the status meta
 * says for the live card).
 */
export function outcomeLabel(outcome: string): string {
  if (outcome === "cleared") return "Cancelled"
  if (outcome === "achieved") return "Achieved"
  if (outcome === "replaced") return "Replaced"
  return outcome
}

/**
 * Pause/Resume is a SINGLE toggle rendered in a stable layout slot — never
 * two conditional buttons that swap position. The control reflects an
 * optimistic override (set the instant the user clicks) until the 2s poll
 * confirms the real status, so the label/position never lags reality.
 *
 * This is the fix for the "it was already paused and said Pause again" /
 * "buttons get out of order" class of bug: the dock used to render Pause vs
 * Resume straight off the polled status, so after a click the button lagged
 * by up to one poll and could send a stale command.
 *
 * Returns the action the toggle should send next, or null when there's no
 * live (active/paused) goal to pause or resume.
 *
 *   realStatus  — the latest polled goal status (may be stale just after a click)
 *   optimistic  — the status the user just drove the goal toward, or null
 */
export function pauseResumeAction(
  realStatus: GoalState["status"] | undefined,
  optimistic: "active" | "paused" | null,
): "pause" | "resume" | null {
  const effective = optimistic ?? realStatus
  if (effective === "active") return "pause"
  if (effective === "paused") return "resume"
  return null
}

/**
 * Stalled-run detection (the app-side slice of the spec's "stalled" state).
 *
 * A goal is "stalled" when it's still ACTIVE but nothing has happened for a
 * while — the agent stopped responding, a provider timed out, or the sidecar
 * is wedged. We derive it from the freshest activity timestamp the dock
 * already polls (`.opencode/.session-events.jsonl`) rather than adding a new
 * status to the plugin schema, so it's purely additive and cannot mislead a
 * paused/terminal run. `lastActivityAt` is the newest activity event's `at`
 * (or null when there's been no activity yet — a just-started goal is never
 * stalled).
 */
export const DEFAULT_STALL_MINUTES = 5

export function goalIdleMinutes(lastActivityAt: number | null | undefined, now: number): number {
  if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt) || lastActivityAt > now) return 0
  return Math.floor((now - lastActivityAt) / 60_000)
}

export function isGoalStalled(
  status: GoalState["status"] | undefined,
  lastActivityAt: number | null | undefined,
  now: number,
  thresholdMinutes: number = DEFAULT_STALL_MINUTES,
): boolean {
  if (status !== "active") return false
  if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt) || lastActivityAt > now) return false
  return now - lastActivityAt >= thresholdMinutes * 60_000
}
