# Goal Playbook Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the OpenCode Desktop Goal tab into a session-native playbook workspace with a center chain builder and right-side action library/editor.

**Architecture:** Keep the existing `GoalPanel` command plumbing and state readers. Reorganize the loaded/create state into a wide responsive grid: setup and chain board on the left, action library and inspector on the right. All chain/action edits stay local until `startGoalChain()` or `createGoal()` explicitly starts work.

**Tech Stack:** SolidJS, existing `@opencode-ai/ui` controls, source-contract tests with Bun/Happydom, no new dependencies.

## Global Constraints

- Work only in `C:\Users\zerop\Development\opencode-source\packages\app` for the Desktop renderer changes.
- Do not route editable controls through `session.command`; deterministic controls use `goal_control`, and draft edits use local state.
- Browser validation is diagnostic only; final Desktop proof requires Electron when available.
- Preserve existing dirty worktree changes.

---

### Task 1: Playbook Workspace Contract

**Files:**

- Modify: `packages/app/src/pages/session/goal-panel.test.ts`
- Modify: `packages/app/src/pages/session/goal-panel.tsx`

**Interfaces:**

- Consumes: existing `chainDraft`, `budgetSummary()`, `filteredTemplates()`, `addActionToChain()`, `startGoalChain()`.
- Produces: stable DOM landmarks `goal-playbook-workspace`, `goal-playbook-setup`, `goal-playbook-budget-strip`, `goal-playbook-chain-pane`, `goal-action-library-rail`, `goal-action-row`, `goal-drop-zone`, `goal-global-budget`.

- [ ] **Step 1: Write the failing contract test**

```ts
test("playbook workspace matches the approved session-native layout", async () => {
  const src = await goalPanelSource()
  expect(src).toContain('data-component="goal-playbook-workspace"')
  expect(src).toContain('data-component="goal-playbook-setup"')
  expect(src).toContain('data-component="goal-playbook-budget-strip"')
  expect(src).toContain('data-component="goal-playbook-chain-pane"')
  expect(src).toContain('data-component="goal-action-library-rail"')
  expect(src).toContain('data-component="goal-action-row"')
  expect(src).toContain('data-component="goal-drop-zone"')
  expect(src).toContain('data-component="goal-global-budget"')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts`
Expected: FAIL because the new playbook DOM landmarks are missing.

- [ ] **Step 3: Implement the layout landmarks**

Wrap the loaded create state in a responsive playbook grid, moving the existing chain and action library blocks into named panes without changing command plumbing.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts`
Expected: PASS.

### Task 2: Action Row Add Buttons

**Files:**

- Modify: `packages/app/src/pages/session/goal-panel.test.ts`
- Modify: `packages/app/src/pages/session/goal-panel.tsx`

**Interfaces:**

- Consumes: `addActionToChain(template, varsForAction(template))`.
- Produces: each visible action row can add itself to the chain without starting a model turn.

- [ ] **Step 1: Write the failing contract test**

```ts
test("action library rows add to the local chain without crossing the run boundary", async () => {
  const src = await goalPanelSource()
  const actionRow = src.match(/data-component="goal-action-row"[\s\S]*?addActionToChain\(t, varsForAction\(t\)\)/)
  expect(actionRow).toBeTruthy()
  expect(actionRow![0]).not.toContain("sendGoalCommand")
  expect(actionRow![0]).not.toContain("startGoalRun")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts`
Expected: FAIL because the row-level Add button is missing.

- [ ] **Step 3: Implement row-level Add buttons**

Add an `ActionButton` or plain button inside each `filteredTemplates()` row that calls `addActionToChain(t, varsForAction(t))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts`
Expected: PASS.

### Task 3: Verification

**Files:**

- Test: `packages/app/src/pages/session/goal-panel.test.ts`

**Interfaces:**

- Consumes: completed Task 1 and Task 2.
- Produces: tested renderer changes with no type errors.

- [ ] **Step 1: Run focused tests**

Run: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts`
Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `bun typecheck`
Expected: `tsgo -b` exits 0.

- [ ] **Step 3: Run full app tests**

Run: `bun test --preload ./happydom.ts`
Expected: all app tests pass.
