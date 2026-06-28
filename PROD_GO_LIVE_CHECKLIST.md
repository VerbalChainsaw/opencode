# Production Go-Live Checklist

Last updated: 2026-06-28

## Canonical Scope

- Work in `C:\Users\zerop\Development\opencode-source`.
- Treat sibling `C:\Users\zerop\Development\OpenGoal` as retired workspace context unless a task explicitly asks for historical comparison.
- Production readiness means the operator-facing Desktop GUI, AutoGoal runtime, docs, and release proof line up in the real monorepo.

## Go-Live Closeout Defects

None currently recorded.

## Recently Closed

- 2026-06-28: Windows packaging output is now clean-build deterministic. `packages/desktop` package scripts run `scripts/clean-dist.ts` before `electron-builder`, removing stale generated release metadata such as an old `dist/latest.yml` before a new installer is produced. Rebuilt `bun run package:win` after the fix; the fresh `dist` contains the rebuilt installer, blockmap, builder debug file, and unpacked app only. New installer SHA256: `ABD364554CE88CD61DB4C8F3831619A5F9CC580E0297AB3DAD8F7940B5680572`.
- 2026-06-28: Final real Desktop/Electron proof is closed. `bun run typecheck && bun run build` passed in `packages/desktop`; `bun run preview` launched the actual Electron app, started the sidecar, exposed DevTools on `127.0.0.1:9222`, and loaded `oc://renderer/index.html` with title `OpenCode`. Live DOM inspection proved the Project Window and `opencode-source` session surface rendered, including the Goal tab with `goal-chain-builder`, `goal-status-card`, `goal-history-panel`, method library controls, and action controls. I did not rewrite the live workspace into an active chain just to force Pause/Resume in the GUI; those sequencing paths are covered by the focused GoalPanel and AutoGoal tests listed below.
- 2026-06-28: Docs/spec reconciliation is closed. Historical work orders now point at the current `docs/SPEC.md` / `docs/gui-integration.md` contracts instead of a missing `ARCHITECTURE.md`, the GUI integration contract now describes the unified monorepo Desktop file-read plus `goal_control` bridge path, and `goal_get_state` server/tool prose no longer tells Desktop consumers to poll the tool path. `node --test test/docs-drift.test.mjs test/server-dials.test.mjs` passed.
- 2026-06-28: Chain-runner Stop/Pause late-continuation race is closed. `deliverContinuation(...)` now rechecks the active goal after successful prompt admission, treats active-goal id/status drift as `stale-suppressed`, avoids poisoning idempotency on stale success, and calls a stale-delivery abort hook. Chain-advance and nudge automation both wire that hook to best-effort `session.abort(...)`.
- 2026-06-28: GoalPanel start/resume/restart/steer prompt admission is now guarded outside the automated continuation dispatcher. GUI prompts capture a refreshed active goal id plus a local control epoch; if Stop/Pause/Fresh or another control wins while `session.prompt` is in flight, late prompt admission is aborted and no fallback pause is issued.
- 2026-06-28: Desktop bridge live-chain removal now matches the canonical runner invariant. Bridge `chain remove` can remove only pending future steps from a live chain; completed/current live steps are rejected without rewriting chain history or active goal metadata.
- 2026-06-28: Desktop shell hardening was verified current. External link entry points gate through HTTPS-only URL validation, sidecar `postMessage` startup waits for listener/timeout wiring, updater subscriptions replace the prior renderer listener, and focused Desktop typecheck/build/tests passed with existing warnings only.
- 2026-06-28: GoalPanel terminal chain rows no longer route through the live pending-row removal action. Terminal-history rows now emit an explicit terminal cleanup action, and stale clicks dismiss the terminal affordance if a live goal appears between render and click.
- 2026-06-28: Plugin/server `/goal chain skip` now uses atomic chain advancement through the async command dispatcher path, keeping `.goal-chain.json` and goal-state metadata sequenced together for GUI, tool, and hook execution.
- 2026-06-28: CLI/watch and related operator surfaces were verified to display chain progress as one-based while preserving zero-based runtime metadata. Covered by watch, control-center, render pane, goal blocks, and sidebar suites.
- 2026-06-28: Bridge `GoalControlState.metadata` now declares runtime chain metadata through `stepMarkerAt`, aligning generated public types with canonical `GoalState.metadata` and marker-cutoff continuation behavior.
- 2026-06-28: CLI `/goal chain skip` parity closed. Standalone CLI normal-command execution now awaits `dispatchGoalCommandStructuredAsync(...)`, so CLI `chain skip` shares the atomic chain advancement path used by plugin/server tools and hooks.
- 2026-06-28: Chain-control corrupt-state results now preserve typed primitive failure reasons through the command envelope. Corrupt chain/current-state failures from skip/reset/add/move/remove now surface as `corrupt-state` instead of `no-goal` or generic invalid values.
- 2026-06-28: Plugin/server and CLI chain mutations now serialize every mutating `chain` subcommand through the async structured dispatcher lock boundary, not only `chain skip`.
- 2026-06-28: The Desktop HTTP bridge entry point `runGoalControlStateFile(...)` now runs under the shared runtime state lock, covering Stop/Clear plus chain start/add/move/remove controls on the primary `/experimental/goal/control` route.
- 2026-06-28: AutoGoal runtime non-chain corrupt-state shim sweep is closed. `transitionGoal(...)` and `restartGoal(...)` now return the exact state they wrote, `server.ts` no longer imports or calls the null-collapsing `readGoalState(...)` shim, command clear/resume use primitive-returned state, and auto-loop/session-error fresh checks use tri-state readers when a live disk read is required.

## Not Release Blockers

- A broad `home.tsx` / `titlebar.tsx` pure-function refactor is overkill for go-live unless a real behavior defect appears.
- String-match tests can be replaced opportunistically, but they are not the production-readiness center unless they mask a live runtime defect.
- UI polish punch-list items are audit/proof work unless Electron testing shows actual workflow breakage.
- The retired `OpenGoal` path is workspace noise, not a product defect, as long as all active changes land in `opencode-source`.

## Closeout Order

1. Do not expand to broader monorepo audit findings without a fresh product-facing defect.
2. Commit/release packaging can proceed once the dirty-tree scope is reviewed.
