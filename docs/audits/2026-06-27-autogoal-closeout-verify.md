# AutoGoal closeout — verify & fix (2026-06-27)

7-target verification sweep over the remaining closeout defects, each verifier
reading current HEAD, each CONFIRMED finding put through an adversarial skeptic
before any code was touched. Workflow run `wf_c33a25be-f68` (11 agents).

## Verdict matrix

| ID | Claim | Verify | Adversarial | Outcome |
|----|-------|--------|-------------|---------|
| D0 | system `set_goal` should update the AutoGoal tab | STALE | — | **No fix.** Works as intended: `set_goal` stamps `metadata.sessionId`, panel polls every 2s, `goalStateForSession` shows it in the owning session. Only "delay" is the documented 2s poll. Headless/unbound goals show globally by the documented CLI contract — not a leak. |
| D1 | residual `readGoalState()` shim corrupt-blindness | CONFIRMED | **REAL, fix-safe** | **Fixed.** Adversarial pass narrowed 18 callsites → **1**: `experimental.session.compacting` was the lone top-of-handler read still collapsing corrupt→null, silently dropping the ACTIVE GOAL context across compaction. Other 17 are re-reads of just-written state inside locks (SAFE). |
| D2 | CLI watch chain-step 0-based | CONFIRMED | **REAL, fix-safe** | **Fixed.** `cli.ts` watch frame was the lone 0-based human-facing surface ("chain step 0/3" on first step). `+1` at the print site only — `gui.ts` projection stays 0-based (other consumers re-increment). |
| D3 | bridge `GoalControlState.metadata` typing gap | CONFIRMED | **OVERSTATED**, fix-safe | **Fixed (type-only).** `chainId/chainStep/chainTotal/webhook` are preserved at runtime but were `unknown` to TS consumers via the index signature. Zero runtime impact; declared to match canonical `GoalState.metadata`. |
| D4 | `desktop-ui-design.md` SSE/ARCHITECTURE drift | CONFIRMED | **REAL, fix-safe** | **Fixed (docs-only).** Dead `../ARCHITECTURE.md` link repointed to `../docs/gui-integration.md`; all SSE/event-push language replaced with the real 2s polling contract. |
| D5 | desktop shell hardening (4 sub-claims) | STALE | — | **No fix.** All four already remediated: both `shell.openExternal` sites gated by `isHttpsUrl`; sidecar start message microtask-deferred after listener registration (MED-35); `updater-subscriptions.set()` removes+unsubscribes prior entry; catalog clean, no drift. |
| D6 | final Electron proof | STALE | — | **No code.** `tsgo -b` desktop typecheck exit 0, zero diagnostics; `dist/opencode-desktop-win-x64.exe` present (~120 MB, current-HEAD build). Only manual UAT remains — checklist below. |

## Fixes landed

- `packages/autogoal/src/server.ts` — D1: compacting handler uses `readGoalStateResult`, logs+returns on corrupt (mirrors `session.idle`).
- `packages/autogoal/src/cli.ts` — D2: watch frame `chain step ${current + 1}/${total}`.
- `packages/autogoal/src/control-state.ts` — D3: `GoalControlState.metadata` declares the four preserved fields.
- `packages/autogoal/specs/desktop-ui-design.md` — D4: polling contract, dead link removed.
- `packages/autogoal/test/server-compacting-corrupt.test.mjs` — D1 regression (corrupt logs + drops context; absent silent; active still injects).
- `packages/autogoal/test/cli-watch.test.mjs` — D2: first-step `1/N` regression + 0-based projection double-increment guard; updated the test that previously pinned the 0-based bug.

Verification: autogoal typecheck clean, build clean, 162/162 across all affected
suites (cli, cli-watch, cli-json, gui, server-error, compacting-corrupt,
control-state-bridge, dispatcher-parity).

## D6 — Manual Electron UAT checklist

Run `dist/opencode-desktop-win-x64.exe` (cannot run headless here):

1. **Launch + panel render** — open a session, open the Goal panel. Expect: renders, no console errors, backend badge shows connected.
2. **Chain start** — build a ≥3-step chain, click Start. Expect: running state; counter reads **1/N** (not 0/N); running-now card shows step 1's label.
3. **Pause** — click Pause. Expect: paused state; counter unchanged; resume control appears.
4. **Stop + Restart** — Stop clears running state; Restart relaunches from step 1, counter **1/N**.
5. **Steer** — trigger Steer on the running chain. Expect: inline steer panel opens within the Goal panel (no separate window, no clipping); applies without losing the running step.
6. **Handoff** — trigger Handoff. Expect: inline handoff panel opens inline; agent/model switch UI shows; applies cleanly.
7. **Small-height geometry** — resize Goal panel to ~400px height. Expect: step list, running-now card, metric tiles scroll/fit; no overflow, no clipped text, no overlapping rows.
8. **Backend unreachable** — stop the backend / point at an unreachable port. Expect: distinct amber backend-unreachable badge (distinguishable from empty "no goal" per NCO1); chain controls disabled; no throws.
9. **Multi-step display** — mid-run, read the `#k` error refs and `k/N` counter. Expect: every visible step number is 1-based and matches the highlighted running row; `chain remove` on step k issues `chain remove k` (1-based).
