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
 *   - `shouldShowCreateForm` is the matching form gate. The empty state IS
 *     the create affordance — never a dead end.
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

import type { GoalState } from "./goal-panel"

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
 * Whether the create form should be visible.
 *
 * The form is shown when the user explicitly asked for it (`showCreate`),
 * or whenever there's no live goal (the empty state IS the create
 * affordance — never a dead end, including on achieved/cleared goals).
 */
export function shouldShowCreateForm(
  state: GoalState | null | undefined,
  showCreate: boolean,
): boolean {
  return showCreate || liveGoal(state) === null
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
