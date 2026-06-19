# OpenGoal / OpenCode Goal Playbook Scratchpad

## 2026-06-17 - Goal playbook workspace

User's current directive:

- Keep the work on OpenCode/OpenGoal/AutoCode only.
- Do not lose place; update scratchpad before continuing.
- Commit later, but only after the tree is cleaned into sensible boundaries.
- The current Goal tab works mechanically but does not yet match the provided playbook screenshot closely enough.

Current implementation state:

- `packages/app/src/pages/session/goal-panel-actions.ts` adds `stopGoalRun`, which calls the SDK session abort path instead of only clearing goal state.
- `packages/app/src/pages/session/goal-panel.tsx` has the session-native Goal workspace with:
  - set-goal area
  - budget metric strip
  - two-column chain builder/action library
  - local-only add action and budget controls
  - explicit `Start chain` run boundary
  - stable `data-component` markers for future button sweeps.
- `packages/app/src/pages/session/goal-panel.test.ts` has source contracts and function tests for:
  - stop = abort plus clear
  - set goal auto-starts only at the explicit set-goal boundary
  - local controls do not start a turn
  - action rows add to local chain
  - recent runs listbox behavior
  - playbook workspace markers.
- `docs/superpowers/plans/2026-06-17-goal-playbook-workspace.md` records the current implementation plan.

Verification so far:

- `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts`: 67 pass, 0 fail.
- `bun typecheck` from `packages/app`: pass.
- `bunx prettier --check ...`: pass.
- `bunx oxlint packages/app/src/pages/session/goal-panel.tsx packages/app/src/pages/session/goal-panel.test.ts`: 0 errors, 8 existing unsafe-cast warnings around SDK/parser boundaries.
- Full app suite: `bun test --preload ./happydom.ts`: 558 pass, 0 fail.
- Browser smoke on `127.0.0.1:4444`:
  - workspace/setup/budget/chain/right-rail/drop-zone markers present.
  - 7 action rows loaded.
  - clicking `Add` changed chain rows from 0 to 1 without changing the session URL or submitting chat.
  - `+ turn`, `+ min`, and master-turn input updated local totals without triggering a new machine turn.
- Electron dev app is running from `packages/desktop`:
  - renderer: `http://localhost:5173/`
  - Electron window title: `OpenCode`
  - DevTools endpoint: `127.0.0.1:9222`

Current visual gap against latest reference:

- Center chain should be a dense list of horizontal action rows, not chunky pill cards.
- Right rail needs top tabs (`Action Library`, `Packs`, `Templates`, `Archived`), filter controls, row cards, and a lower inspector/editor.
- Top setup area needs tighter alignment: set-goal inputs on the left, compact budget metric boxes on the right.
- Chain controls need import/save/start actions and a lower global budget band.
- Rows need colored icon squares, drag handles, row numbers, compact turn/time boxes, gate badges, edit and overflow controls.

New requirement added by user:

- Chain blocks should eventually support precise per-block context setup:
  - auto-load one or more skills before a block runs
  - optionally compact the conversation before/after a block
  - attach additional block-specific requirements/instructions
  - expose this as configurable action metadata, not hidden prompt magic
- Current implementation should surface this direction in the UI/model only where honest. Do not imply execution until the backend chain contract can actually consume the metadata.

Next concrete step:

1. Refactor the chain builder markup/classes toward the supplied screenshot while preserving existing local-only control handlers.
2. Keep existing `data-component` markers stable and add any missing markers needed for button sweep tests.
3. Add visible action inspector fields/notes for skill loading, compaction, and extra requirements as pending metadata.
4. Re-run focused tests, full app tests, and runtime smoke after the visual pass.
5. Only then decide commit grouping and tree cleanup.

## 2026-06-17 - Goal action library semantics and button sweep

User's literal words:

> Some of the menu doesn't make sense. Do all the buttons work as intended? Is there no option for raised elements or color?
> Like, are all of these things dialable? Can we change them where we need to? Like category planning, gate behavior required? Like what is some of this stuff? Is it even d doing anything? And why are we designating the difference between a built in or a prompt? Like it doesn't matter. These are all just actions.

Spec reconciliation:

- The Desktop goal panel remains the host-consumed session surface described by the app design spec; the right rail is an action library and chain-builder editor, not a separate standalone app.
- The prior pending context setup controls were removed because they were visible but not executable by the current chain backend contract.
- Action source labels such as built-in/prompt and internal row version markers were removed from the operator-facing library. The visible model is now "actions" with editable category, gate behavior, color, and elevation.

Current implementation state:

- `packages/app/src/pages/session/goal-panel-pure.ts` sanitizes optional action metadata: category, gate, tone, and elevation.
- `packages/app/src/pages/session/goal-panel.tsx` exposes those fields in the action editor, carries them into draft chain rows, and preserves them in the `Start chain` payload.
- Gate labels are operator-facing: `Always run`, `Must pass`, `Verify manually`, and `Review required`.
- The dead/non-executing menu affordances checked in this pass are absent from the live Desktop window: `Packs`, `Archived`, `BUILT-IN`, `Context setup`, `pending`, `Block context setup`, `Compact before block`, `Compact after block`, and row `v3` markers.

Verification:

- `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts src/pages/session/goal-panel-contract.test.ts`: 97 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun test --preload ./happydom.ts`: 564 pass, 0 fail.
- Electron Desktop CDP smoke against `http://localhost:5173/index.html`: all checks passed for workspace load, dead-label removal, search, category filtering, add-to-chain, move order, remove/cancel, new action style controls, and edit-reopen state restoration.
- Screenshot: `C:\Users\zerop\Development\opencode-source\output\playwright\electron-action-controls-smoke.png`.

Boundary:

- The live Electron sweep intentionally did not click `Start chain` or `Save template` because those cross the backend/file mutation boundary in the active user session. Their payload shapes are covered by source/unit contract tests. A disposable-session mutation pass is the next concrete verification if the user wants destructive/live backend proof.

## 2026-06-17 - Chain/template fallback gap

Spec reconciliation:

- User's literal objective: finish the chainloader and entire sidepanel so it is polished, clear, functional, fully debugged, end-to-end tested, visually examined, and adversarially scanned.
- The repo's spec surface for this work remains the OpenCode Desktop session sidepanel (`specs/desktop-ui-design.md`) plus the goal-chain/template requirements in the v0.4/v0.5 work orders.
- The reconciliation: visible chainloader controls must not depend on a hidden plugin-only path when the Desktop fallback control route is already powering the rest of the sidepanel; `Save template`, duplicate/delete, and `Start chain` need fallback-route coverage or they remain visibly clickable but not reliably functional.

Current finding:

- `packages/opencode/src/server/routes/instance/httpapi/goal-control-state.ts` handles `set`, budgets, pause/resume/clear, restart, steer, and condition edits.
- It rejects `template ...` and `chain ...` with "Goal control action requires the OpenGoal plugin", while `packages/app/src/pages/session/goal-panel.tsx` exposes `Save template`, duplicate/delete, and `Start chain` buttons through the same control route.

Next concrete step:

1. Add failing server-route tests for `template import`, `template delete`, and `chain start-json`.
2. Implement safe file-backed fallback support using atomic writes into `.opencode/goals/*.json` and `.opencode/.goal-chain.json`, plus setting step 1 active.
3. Re-run package tests and then use a disposable Desktop workspace/session for live mutation proof.

## 2026-06-17 - Desktop mutation proof and fixes

Follow-up findings:

- `Save template` initially sent the generated SDK path as a GET, which returned 200 but did not mutate files. `packages/app/src/pages/session/goal-panel-actions.ts` now prefers the root/raw POST transport and only falls back to the generated method when no raw POST transport exists.
- `template` and `chain` POSTs initially reached the server but were delegated to the plugin tool first when the target directory matched the current instance. `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts` now routes those verbs directly to the file-backed fallback, matching the already-file-backed state/budget verbs.
- `packages/opencode/src/server/routes/instance/httpapi/goal-control-state.ts` now supports `template import`, `template delete`, `chain start-json`, `chain add`, and `chain move`, including template snapshot updates, chain file writes, active goal activation, and preserving the active step when reordering.

Verified in Desktop Electron:

- Disposable proof action was created from the sidepanel with category `Testing`, gate `Must pass`, color `Emerald`, elevation `Raised`, verify command `echo codex-electron-ok`, 4-turn budget, and 7-minute budget.
- Category filtering hid non-testing actions and kept testing actions visible.
- Cancel hid the editor; New action reopened it.
- Saved action appeared via search, staged into the chain, and `Start chain` wrote `.opencode/.goal-chain.json` plus `.opencode/.goal-state.json`.
- Live chain Move Down reordered the active step; the chain file kept the saved action attached at index 1 and updated `current` plus active goal metadata to `chainStep: 1`.
- Proof screenshot: `C:\Users\zerop\Development\opencode-source\output\playwright\electron-goal-sidepanel-mutation-proof.png`.
- The proof restored the original `.opencode` files afterward and reloaded the renderer; disposable proof action was no longer visible.

Verification:

- `packages/app`: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts src/pages/session/goal-panel-contract.test.ts` -> 99 pass, 0 fail.
- `packages/app`: `bun run typecheck` -> pass.
- `packages/opencode`: `bun test test/goal-control-state.test.ts` -> 9 pass, 0 fail.
- `packages/opencode`: `bun script/build-node.ts` -> pass; fresh Desktop dev process launched and served CDP on `127.0.0.1:9222`.

Remaining known boundary:

- `packages/opencode` package typecheck is still blocked by unrelated pre-existing TUI errors in `packages/tui/src/component/dialog-provider.tsx` (`errorMessage` is undefined). Do not count that as fixed by this pass.

## 2026-06-17 - Semantic action controls proof

Follow-up findings:

- The visible builder vocabulary is now action-oriented: `Run order`, `Action text`, `Checkpoint`, `Color`, `Elevation`, `Runtime check`, `Shell command`, and `GOAL_COMPLETE marker`.
- The old confusing operator copy is absent from the live Electron panel: `Gate behavior`, `Retry limit`, `Drop an action or pack`, and `Built-in`.
- `Documentation` is now a server-accepted template category, matching the Desktop filter/editor options.
- Chain payloads now carry explicit verification metadata: shell-backed actions write `verification: { type: "shell", command }`; no-command actions write `verification: { type: "marker" }`.
- The metric cards now wrap small label/detail text and use three columns at normal desktop widths so `CHECKPOINTS` and `non-run checks` remain readable.

Native Electron proof:

- Opened the `opencode-source` session in the OpenCode Desktop Electron app via CDP `127.0.0.1:9222`.
- Cleared stale local chain rows with the visible row `Remove` button.
- Opened `New action`, set draft fields, then clicked `Cancel`; the temporary cancel label did not persist.
- Added `Plan` from the action library; this staged a marker-verified chain step locally.
- Created and saved disposable `Codex Proof Action` with category `Documentation`, checkpoint `Command check`, color `Emerald`, elevation `Raised`, verify command `echo codex-proof-ok`, and action text `codex proof condition requires shell verification`.
- Search plus `Documentation` filter isolated the saved action.
- Inspector showed `Color: Emerald`, `Elevation: Raised`, `Runtime check: Shell command`, and `Verify command: echo codex-proof-ok`.
- Added the saved action to the chain, verified `1 cmd / 1 marker`, moved it above `Plan`, and clicked `Start chain`.
- File-backed verification succeeded: `goal-templates.json` preserved style/category/checkpoint/command metadata; `.goal-chain.json` put the proof action first and Plan second; `.goal-state.json` activated chain step 0 with shell verification and `chainTotal: 2`.
- Proof restored `.opencode/.goal-state.json`, `.opencode/.goal-chain.json`, `.opencode/goal-templates.json`, and any new goal detail files afterward.

Verification:

- `packages/app`: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts src/pages/session/goal-panel-contract.test.ts` -> 99 pass, 0 fail, 318 expects.
- `packages/app`: `bun run typecheck` -> pass.
- `packages/opencode`: `bun test test/goal-control-state.test.ts` -> 10 pass, 0 fail, 47 expects.
- `packages/opencode`: `bun script/build-node.ts` -> pass.
- Electron semantic proof script -> pass; proof screenshot `C:\Users\zerop\Development\opencode-source\output\playwright\electron-goal-sidepanel-semantic-proof.png`.
- Electron refreshed readability screenshot -> `C:\Users\zerop\Development\opencode-source\output\playwright\electron-goal-sidepanel-readable-metrics.png`.

Remaining known boundary:

- The live proof injects chat/session transcript messages while proving `Start chain`; file state is restored, but the session conversation history still shows proof messages.
- `packages/opencode` full typecheck remains blocked by the unrelated existing TUI `errorMessage` errors.

## 2026-06-17 - Final layout/control matrix pass

Follow-up findings:

- The live Electron sidepanel still had a real set-goal layout defect after the semantic pass: at a 1440px desktop viewport, the sidepanel container was only 890px wide and the viewport-based `lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.72fr)_112px]` form layout collapsed `Goal condition` to a 28px input.
- The create-goal form now uses a single-column stack inside the set-goal panel. Electron DOM measurement after the patch showed both `Goal condition` and `Verify command` at 396px wide, with the `Set Goal` button at 398px.
- The disabled `Set Goal` state in the screenshot is expected when the condition is empty; the defect was the unreadable empty input, not the disabled submit rule.
- Removed the now-unused English `session.goal.template.source.*` and `session.goal.template.kind.method` strings so the product copy no longer carries the old built-in/prompt distinction.
- The Codex task tracker reported the long-running goal status as `blocked` when checked, but no current technical blocker remains for this pass. Treat that as stale tracker state from an earlier continuation; the available tracker update statuses are only `complete` and `blocked`.

Native Electron proof:

- Ran a non-destructive control matrix through the OpenCode Desktop Electron window over CDP `127.0.0.1:9222`.
- `New action` opened the editor; `Category`, `Checkpoint`, `Color`, `Elevation`, and `Action text` were visible and alterable.
- Set category to `Documentation`, checkpoint to `Review check`, color to `Emerald`, elevation to `Raised`, and verified both pressed states.
- `Cancel` closed the draft without leaving the disposable `Matrix Proof Action` visible.
- Category filter changed visible rows from 6 to 1; search narrowed the current filtered result set; reset restored 6 rows.
- Added `Plan` and `Build` to the local chain; `Start chain` became enabled; per-step turns/minutes changed to 3 and 9; Move Down and Move Up reordered and restored rows; Remove cleared the draft rows.
- Session storage was restored after the proof, leaving 0 draft rows and no open draft editor.
- Refreshed screenshot: `C:\Users\zerop\Development\opencode-source\output\playwright\electron-goal-sidepanel-readable-set-goal.png`.

Verification:

- Electron layout measurement -> pass (`Goal condition` 396px, `Verify command` 396px, no input overflow).
- Electron control matrix -> pass, 0 failures.
- `packages/app`: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts src/pages/session/goal-panel-contract.test.ts` -> 99 pass, 0 fail, 319 expects.
- `packages/app`: `bun run typecheck` -> pass.
- `packages/opencode`: `bun test test/goal-control-state.test.ts` -> 10 pass, 0 fail, 47 expects.
- `packages/opencode`: `bun script/build-node.ts` -> pass.

Remaining known boundary:

- The live session transcript still contains earlier proof messages and unrelated `Unauthorized: token is required` chat output. The sidepanel state/files were restored after mutation proofs.
- `packages/opencode` full typecheck remains blocked by the unrelated existing TUI `errorMessage` errors in `packages/tui/src/component/dialog-provider.tsx`.

## 2026-06-17 - Sidebar lifecycle controls pass

Spec reconciliation:

- User's literal objective: finish building the OpenGoal sidebar with polished interface, full debugging, end-to-end testing, and validation.
- The repo spec surface for this pass is `specs/desktop-ui-design.md` §2/§4/§7/§13 plus the v0.4 goal-chain/control requirements. The Desktop sidebar must expose the live lifecycle actions as host-consumed controls, not only as hidden command-route support.
- Reconciliation: the action library and chain builder were already proven; the next requirement gap was the broader sidebar lifecycle strip. `restart` existed in the fallback route and typed action model but was not visible in the run controls, so it was not dialable from the sidebar.

Fix:

- Added a visible `Restart` button to the active/paused run-control strip in `packages/app/src/pages/session/goal-panel.tsx`.
- The run-control grid is now five columns at XL widths: Pause/Resume, Steer, Restart, Stop, New goal.
- Added a source contract test in `packages/app/src/pages/session/goal-panel.test.ts` so `Restart` remains a first-class lifecycle action and calls `runAction("restart")`.

Native Electron proof:

- Opened the real `opencode-source` session from the OpenCode Desktop live board, selected the Goal tab, and injected a temporary active `.opencode/.goal-state.json`.
- Verified the active goal rendered with `Pause`, `Steer`, `Restart`, `Stop`, and `New goal` visible.
- Clicked `Pause`; state changed to `paused` and UI exposed `Resume`.
- Clicked `Resume`; state changed back to `active` and UI exposed `Pause`.
- Opened `Steer`, sent `lifecycle proof steering note`, and verified it was appended to `metadata.steering`.
- Clicked `Restart`; state received a new id, reset progress to zero, stayed active, and preserved `metadata.previousId`.
- Clicked `Stop`, then `Cancel`; state id/status were unchanged.
- Clicked `Stop`, then `Confirm stop`; state changed to `cleared` with `completedAt`.
- The script restored the original `.opencode/.goal-state.json`; after the next poll, the proof condition disappeared from the live UI and the file was back to its original cleared state.
- Screenshot before restore: `C:\Users\zerop\Development\opencode-source\output\playwright\electron-goal-sidebar-lifecycle-restart.png`.

Verification:

- `packages/app`: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts src/pages/session/goal-panel-contract.test.ts` -> 100 pass, 0 fail, 323 expects.
- `packages/app`: `bun run typecheck` -> pass.
- Electron lifecycle matrix -> pass, 0 failures.
- `packages/opencode`: `bun test test/goal-control-state.test.ts` -> 10 pass, 0 fail, 47 expects.
- `packages/opencode`: `bun script/build-node.ts` -> pass.

## 2026-06-17 - Home project session scoping pass

User finding:

- Clicking a project on the front page looked like it still showed generic "recent sessions" instead of that project's sessions.

Fix:

- Project row selection now resolves to the owning project worktree and keeps that project selected instead of silently toggling back to all projects on a second click.
- The center board title now changes from `Live Board` to `<project> sessions` when scoped.
- The board adds a visible scope line, `Showing only <project>`, and an explicit `All projects` reset action.
- The all-older session group uses `<project> sessions` while scoped instead of falling back to the global `Recent sessions` label.

Native Electron proof:

- Started a fresh OpenCode Desktop dev process from `packages/desktop`; renderer served at `http://localhost:5173/`, sidecar ready at `http://127.0.0.1:53234`, CDP ready at `127.0.0.1:9222`.
- In the Electron window, clicked the `opencode-source` project row.
- Verified `opencode-source` was selected in the project list.
- Verified the board HTML contained `opencode-source sessions`, `Showing only opencode-source`, and `All projects`.
- Verified the scoped list contained the `New session` row for `opencode-source` instead of the mixed all-project list.
- Clicked `All projects`; verified no project rows remained selected and the board returned to `Live Board` with the mixed all-project session list.
- Screenshot: `C:\Users\zerop\Development\opencode-source\output\playwright\electron-home-project-scoped-sessions.png`.

Verification:

- `packages/app`: `bun test --preload ./happydom.ts src/pages/home.test.ts src/pages/layout/helpers.test.ts` -> 48 pass, 0 fail, 165 expects.
- `packages/app`: `bun run typecheck` -> pass.
