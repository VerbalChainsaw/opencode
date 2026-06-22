# OpenGoal / AutoGoal — AI Orientation

**Single source of truth for getting oriented fast.** Read this first. It is kept current-only — if something here is wrong, fix it here. Do not trust older notes in `.hermes/scratchpad.md` over this file.

Last verified: full green across all packages (see Gates below).

---

## 1. What this is

OpenGoal/AutoGoal keeps an OpenCode agent working toward a goal until a condition is met (auto-loop on `session.idle`). Goals can be single, or **chains** of ordered steps. Two surfaces drive it: a terminal CLI/TUI and the **Desktop GoalPanel GUI**.

### Two repos — BOTH ship to production
| Repo | Package | Ships as | Role |
|---|---|---|---|
| `C:\Users\zerop\Development\OpenGoal` | `opencode-autogoal` | published npm | CLI / TUI / terminal users |
| `C:\Users\zerop\Development\opencode-source` | monorepo | Electron Desktop app | the GUI users actually run |

They share ~the same runtime but have ~380 lines of internal code drift. **This is NOT a blocker:** command *behavior* is confirmed byte-identical across both (verified by running the same commands through each `dist/command.js` and diffing state/chain files). The drift is in internal plumbing only; both are independently green.

### opencode-source packages that matter
- `packages/autogoal` — `@opencode-ai/autogoal`, the goal runtime (server plugin + CLI + the Desktop bridge runner). **Most runtime work happens here.**
- `packages/app` — SolidJS GUI. The GoalPanel is `src/pages/session/goal-panel.tsx` (+ `goal-panel-pure.ts`, `goal-panel-actions.ts`, `goal-panel-contract.test.ts`).
- `packages/opencode` — the HTTP bridge the GUI calls: `POST /experimental/goal/control/goal_control`. Handler: `src/server/routes/instance/httpapi/handlers/experimental.ts`.
- `packages/desktop` — the Electron shell (`electron-vite` + `electron-builder`). **No Tauri build target** (it was ported from Tauri; leftover Tauri code is dead).
- `packages/ui`, `packages/core` — shared components/utils.

---

## 2. Architecture you must understand

### The two goal-control dispatchers (this is where bugs lived)
The same goal-control command language (`set`, `turns`, `pause`, `chain start-json`, `chain remove`, `handoff`, `fresh`, …) has **two implementations**:
1. **CLI path:** `packages/autogoal/src/command.ts` → `goal-state.ts` / `goal-chain.ts`. Used by the terminal + chat `/goal`.
2. **Bridge path:** `packages/autogoal/src/control-state.ts` → `runGoalControlStateFile()`. Used by the **Desktop GUI** via the experimental HTTP endpoint.

These duplicated logic and **drifted repeatedly** (9 bridge-only bugs this session). They are now **behaviorally reconciled and CI-locked** (see Parity contract). The runtime auto-advance uses the STRICT reader in `goal-chain.ts` (`readGoalChain`/`validateGoalChain`) for BOTH paths — so anything the bridge writes must satisfy that validator.

### The bridge request flow (GUI → runtime)
GUI (`goal-panel-actions.ts`) → `POST /experimental/goal/control/goal_control` → handler `experimental.ts`:
- If command's first word is in `STATE_FILE_GOAL_CONTROL_ACTIONS` (the allowlist) → deterministic fast path → `runGoalControlStateFile`.
- Else → tries the `goal_control` tool, falls back to `runGoalControlStateFile`.
- Failures map to `HttpApiError.BadRequest` (the error schema has NO message field; the cause is now logged via `Effect.logError`).

### State files (in the workspace `.opencode/`)
`.goal-state.json` (active goal), `.goal-chain.json` (chain), `.goal-handoff.json`, `.session-events.jsonl`, `.step-timeline.jsonl`, `goal-templates.json`, `goal-history.json`. `fresh`/`reset-state` deletes the live ones, keeps templates+history.

---

## 3. THE PARITY CONTRACT — do not break

Two test files lock the dispatchers together. **They are the contract; make code conform to them, never weaken them to pass.**
- `packages/autogoal/test/dispatcher-parity.test.mjs` — runs the shared command set through BOTH dispatchers, asserts equivalent state/chain files.
- `packages/autogoal/test/control-state-bridge.test.mjs` — bridge-path coverage incl. the critical "bridge chain is accepted by `readGoalChain` and advances step 0→1".

If you change either dispatcher, these must stay green **unchanged**.

Known benign difference (normalized out, do NOT "fix"): `set --command X` writes `verification:null + command` (CLI) vs `verification:{type:"shell",command}` (bridge). The GUI derives completion rule from the `command` field, never `verification.type`, and the runtime evaluates both identically. No user-facing impact.

---

## 4. Gates — how to verify (run before claiming anything)

```
# Bundled runtime (authoritative): typecheck + build + 1214 tests
cd C:/Users/zerop/Development/opencode-source/packages/autogoal && npm test          # expect 1214/0, exit 0

# npm repo runtime
cd C:/Users/zerop/Development/OpenGoal && npm run build && node --test               # expect 1193+/0

# App (GUI) — typecheck + tests
cd C:/Users/zerop/Development/opencode-source/packages/app && bun run typecheck && bun test --preload ./happydom.ts   # 656/0

# Bridge contract test
cd C:/Users/zerop/Development/opencode-source/packages/opencode && bun test test/goal-control-state.test.ts          # 13/0

# Desktop shell
cd C:/Users/zerop/Development/opencode-source/packages/desktop && bun run typecheck && bun test                      # 64/0

# Production compiles ("compiled for Electron")
cd .../packages/app && bun run build           # ✓ (chunk-size warning only)
cd .../packages/desktop && bun run build        # ✓ electron-vite build

# Run the live app (for any visual/Electron verification)
cd C:/Users/zerop/Development/opencode-source/packages/desktop && bun run dev
```

Single focused test: `node --test test/<file>.mjs` (autogoal) or `bun test --preload ./happydom.ts src/.../<file>.test.ts` (app).

---

## 5. DONE (this work cycle — all verified green, parity-locked)

**9 bridge/dispatcher drift bugs fixed:**
- 🔴 **CRITICAL:** GUI-started chains were silently rejected by the runtime (`readGoalChain` returned null — bridge chains lacked `cycles` + `master.turnsUsed/minutesUsed`) and **never auto-advanced past step 0**. Fixed in `control-state.ts` (type + `startGoalChain` + read-path `sanitizeGoalChain`/`sanitizeChainMaster`). Verified end-to-end.
- Reset→400 (Windows `unlink` lock → added `unlinkWithRetry`; allowlist missing `handoff`/`claim`/`fresh`/`reset-state`; silent error-swallow → now logs cause).
- `chain remove` missing in bridge `editChain`; chain `move` off-by-one; chain `add` not refreshing `chainTotal`; `maxCycles` default mismatch.
- The dead chain-auto-advance loop (`goalBelongsToSession` rejected unbound goals → `session.idle` never evaluated CLI/chain-created goals). Fixed in `server.ts`.

**5 hardening gaps closed:** bridge JSON DoS caps (256KB + depth-256 in `parseJsonObject`), `set` condition bound (4000/1000), Windows `unlink` retry, server-side error logging, allowlist completion. SSRF guard verified safe (`server.ts` blocks loopback/link-local unless `allowLocal`).

**Reconciliation:** behaviorally complete + CI-locked (parity tests); cross-repo command behavior confirmed identical.

**Tests:** went from 30 failing → 0. A gutted `sidebar-logic.ts` regression was caught and reverted (restored the polished sidebar).

GoalPanel GUI is being actively polished by the parallel worker (recent commits: unified `primaryAction` Set-Goal/Start-Chain button, flattened running-status cards, command tray). The CANCELLED terminal badge was de-buttoned (status label + dot).

**Order B (2026-06-21) — minimal B refactor landed in working tree:**
- New file `packages/autogoal/src/dispatcher.ts` (83 lines) exporting `splitGoalCommand` (verbatim from old control-state.ts) and `GOAL_RESULT_REASONS` const tuple. Both file headers updated with a `PARITY CONTRACT` block naming the two lock tests. control-state.ts now imports splitGoalCommand from dispatcher.ts (the local 30-line copy deleted). command.ts untouched beyond the header comment.
- `npm test`: 1214/0 ✅. `node --test` on the 3 contract test files: 31/0 ✅.
- Bridge's `runGoalControlStateFile > adds and reorders chain steps` test in `packages/opencode/test/goal-control-state.test.ts` is failing 3/13 on the unmodified `dev` HEAD (pre-existing WIP, NOT caused by this refactor — verified by stashing and re-running). Likely tied to the uncommitted work in `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts` and `packages/opencode/test/goal-control-state.test.ts`. Will land cleanly when that work-in-progress is finished.
- Staged-against-pre-existing-dirty: when I ran `git add` on the B files, the diff absorbed 9 unrelated uncommitted hunks from the same package (working tree was already dirty from another worker's WIP). I `git reset HEAD` to keep B's commit small; Order E will commit B as its own focused chunk once it runs `git add` with specific paths.

---

## 6. REMAINING (work orders)

Priority order. Each is self-contained.

**A. Verify npm repo has the command fixes** (`C:\Users\zerop\Development\OpenGoal`, cheap). Confirm `src/command.ts`/`goal-chain.ts` have: chain `move` 1-based→0-based, chain `add` chainTotal refresh, `maxCycles` default 10. Port if missing. Verify: `node --test` green.

**B. Structural dispatcher merge** (`packages/autogoal`, medium, SAFE now). Make `control-state.ts` delegate to `goal-state.ts`/`goal-chain.ts` primitives instead of reimplementing, OR extract one shared dispatcher. Keep bridge's `{title,output,metadata}` return. Verify: parity tests green **unchanged**.

**C. Strip dead Tauri code** (`packages/app/src/components/titlebar.tsx` + `packages/ui/src/styles/base.css`, **NEEDS VISUAL**). Remove `__TAURI__`/`tauriApi()`/`getWin`/`currentDesktopWindow`/`currentThemeWindow`/Tauri `drag`/`maximize`; simplify `electronWindows()`→`windows()`; drop the never-rendered `<Show when={windows() && !electronWindows()}>`. Rely on `-webkit-app-region` CSS + native overlay. **Verify in live Electron:** title-bar drag, double-click-maximize, min/max/close all work. Then typecheck + `titlebar.test.ts`.

**D. GoalPanel empty-state polish** (`goal-panel.tsx`, **NEEDS LIVE WINDOW + HUMAN** — coordinate with user). Make the goal input the focal point; disabled primary button should read "waiting for input" not "broken." File is mid-restructure — do not edit blind; keep the unified `primaryAction`.

**E. Commit verified work** (after gates green). Lots uncommitted (autogoal/src, app/session, i18n, tests). Logical chunks, spec-cited messages (`fix(autogoal): …`). Never commit on a red gate.

---

## 7. How to operate (rules)

- **Shell = PowerShell 7 (`pwsh`)**, not Git Bash. No `head`/`tail`/`wc`/`2>/dev/null`/`pkill`. Use `rg`, `Select-Object`, `2>$null`. For real bash: `bash -c '...'`. Prefer absolute paths; `cd` inside compound commands can prompt.
- **Read before edit; verify after.** Run the smallest relevant gate after each change. "Green" means you ran it and saw it.
- **Never weaken the parity tests to pass.** They are the contract.
- **Don't blind-edit `goal-panel.tsx`** — it's actively restructured by another worker. Coordinate; pile on, don't revert.
- **Anything the bridge writes to `.goal-chain.json` must satisfy `goal-chain.ts validateGoalChain`** (needs `cycles`, and when `master` present, `master.turnsUsed`/`minutesUsed`). This is the #1 footgun.
- **Visual/Electron verification** = launch `packages/desktop` `bun run dev`; the GoalPanel renders in a session's Goal tab. Server-side runtime/test work needs no window.
- **Both repos ship** — runtime behavior changes may need mirroring to the npm repo (but `control-state.ts`/the HTTP bridge is bundled-only).
- **Commit/push only when the user asks.** Branch off the default branch first if needed.

---

## 8. Coordination

The user (expensive-model + human) writes/audits; executor AIs implement work orders A–E. **C and D need the live window** — those are done WITH the user. A, B, E are autonomous-safe given the gates. Update §5/§6 of this file as work lands.
