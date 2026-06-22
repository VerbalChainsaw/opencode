/**
 * opencode-autogoal — shared goal-control command primitives.
 *
 * The goal-control command language has TWO entry points (the CLI dispatcher
 * `command.ts` and the Desktop bridge `control-state.ts`). They must produce
 * equivalent state for the shared command set. That contract is locked by
 * `test/dispatcher-parity.test.mjs` and `test/control-state-bridge.test.mjs`
 * — make code conform to the tests, never weaken the tests to pass.
 *
 * This module is the smallest safe extraction from those two files: the
 * quote-aware command tokenizer and the canonical list of error reasons.
 * Future extractions (shared envelope shapes, shared argument parsers) belong
 * here too, but each must be a no-op refactor guarded by the parity tests.
 */

/**
 * Quote-aware command tokenizer used by both dispatchers.
 *
 * - Splits on whitespace, respecting single (`'`) and double (`"`) quoted
 *   spans. The quotes are stripped, not preserved.
 * - Throws on an unclosed quote so a malformed command fails fast rather
 *   than silently misparsing the rest of the line.
 * - Used by `control-state.ts:runGoalControlStateFile` to route the command
 *   to its action handler. The CLI's `command.ts` historically used a
 *   brittle `argsText.search(/\s/)` split because its action grammar is
 *   simpler; that path is left in place to keep the parity tests' input
 *   set byte-identical.
 */
export function splitGoalCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (quote) throw new Error("Unclosed quote in goal control command.")
  if (current) tokens.push(current)
  return tokens
}

/**
 * Canonical list of "reason" codes that `EditResult` / `TransitionResult`
 * / `SetResult` etc. may return on the failure branch. The CLI's
 * `GoalCommandResult.kind` and the bridge's `{title, output, metadata}`
 * shapes both have to map these reasons to their surface kind/message.
 *
 * Listing them here gives both dispatchers a single source of truth for
 * the union, so a new reason added in `goal-state.ts` is grep-discoverable
 * from one place.
 */
export const GOAL_RESULT_REASONS = [
  "no-goal",
  "terminal-state",
  "already-in-state",
  "invalid-value",
  "write-failed",
  "handoff-pending",
  "handoff-exists",
  "no-handoff",
  "current-goal",
  "out-of-range",
] as const

export type GoalResultReason = (typeof GOAL_RESULT_REASONS)[number]
