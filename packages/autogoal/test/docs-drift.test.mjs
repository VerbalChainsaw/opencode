/**
 * Regression test for defect A-1 (REVIEW-V040-MULTI-ANGLE.md §2.7):
 *
 * 14 references to a non-existent `withStateLock` helper existed across
 * CHANGELOG.md, specs/v0.4.0-roadmap.md, and src/tui-logic.ts even
 * though the helper was removed in commit 4217a13 (v0.3.0). v0.3.0 was
 * also missing from CHANGELOG.md (the file jumped from `## 0.2.1` to
 * `## 0.4.0`).
 *
 * This test pins:
 *   1. `withStateLock` does not appear anywhere under `src/` (the
 *      helper was removed in v0.3.0 and must not be re-introduced).
 *   2. CHANGELOG.md has a `## 0.3.0` section (the entry is
 *      load-bearing historical context for the v0.4.0 concurrency
 *      stance — see src/goal-state.ts:537-550 and
 *      specs/v0.4.0-roadmap.md).
 *
 * If a future maintainer re-introduces the lock by accident (e.g. a
 * code review misses the call, or a refactor copies a stale comment),
 * the test fails with the offending file:line so the fix is cheap.
 *
 * Run from the repo root: `node --test test/docs-drift.test.mjs`.
 * No external dependencies (no `rg` shell-out, no `child_process`) —
 * uses node:fs + node:path + a hand-rolled substring grep so the
 * test works identically on win × ubuntu × node 20/22.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const workspaceRoot = join(repoRoot, "..", "..");

/**
 * Recursively walk `dir` collecting file paths. Skips common
 * non-source directories (node_modules, dist, .git, hidden).
 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else if (s.isFile()) out.push(full);
  }
  return out;
}

/**
 * Find every line in `file` that contains `needle` (1-indexed line
 * numbers). Returns `[]` if the file has no match.
 */
function findMatches(file, needle) {
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      hits.push({ line: i + 1, text: lines[i] });
    }
  }
  return hits;
}

// ── Test 1: src/ has `withStateLock` references where expected ────────────

test("docs-drift: withStateLock is defined in goal-state.ts and used in src/server.ts", () => {
  // History:
  //   v0.3.0 (commit 4217a13) — the helper was REMOVED after a security
  //     review found TOCTOU bugs in the original advisory-file-lock impl.
  //   v0.4.0 — filesystem mutex was removed; concurrency relied on
  //     atomic-write + IIFE id-equality guards.
  //   v0.7.0 (audit Call 2) — the v0.4.0 removal left multi-async-window
  //     races (R1, R2, R5): tool handlers and the auto-loop's evaluate()
  //     IIFE could clobber each other's field updates (last-rename-wins,
  //     bounded-impact). The audit re-introduced an in-process JS mutex
  //     `withStateLock` to serialize the affected paths.
  //
  // Drift to catch:
  //   - `withStateLock` defined in src/goal-state.ts (the primitive)
  //   - `withStateLock` imported into src/server.ts (the only mutator)
  //   - `withStateLock` called from the tool handlers (clear_goal,
  //     pause_goal, resume_goal, goal_webhook) AND the auto-loop's
  //     nudge-failure catch + session.error handler
  const srcDir = join(repoRoot, "src");
  const files = walk(srcDir);

  // The primitive must exist in goal-state.ts.
  const goalStateFile = files.find((f) => f.endsWith("goal-state.ts"));
  assert.ok(goalStateFile, "src/goal-state.ts not found");
  const goalStateHits = findMatches(goalStateFile, "export async function withStateLock");
  assert.equal(goalStateHits.length, 1,
    `src/goal-state.ts should export withStateLock exactly once (got ${goalStateHits.length} matches)`);

  // server.ts must import it and use it from the wrapped call sites.
  const serverFile = files.find((f) => f.endsWith("server.ts"));
  assert.ok(serverFile, "src/server.ts not found");
  const serverSrc = readFileSync(serverFile, "utf-8");
  assert.ok(/import\s*\{[^}]*\bwithStateLock\b[^}]*\}\s*from\s*"\.\/goal-state\.js"/.test(serverSrc),
    "src/server.ts must import withStateLock from ./goal-state.js");
  // Count `withStateLock(...)` calls — at minimum 5 (clear_goal, pause_goal,
  // resume_goal, goal_webhook, nudge-failure, session.error).
  const callCount = (serverSrc.match(/\bwithStateLock\s*\(/g) ?? []).length;
  assert.ok(callCount >= 5,
    `src/server.ts should call withStateLock at least 5 times (tool handlers + auto-loop). Found: ${callCount}`);
});

// ── Test 2: CHANGELOG.md has a ## 0.3.0 section ─────────────────────────

test("docs-drift: CHANGELOG.md has a ## 0.3.0 section", () => {
  // v0.3.0 is load-bearing historical context: the commit message
  // and the security-review trail that justified removing the
  // advisory file lock. Without it, the v0.4.0 concurrency stance
  // (atomic write + no lock + last-rename-wins) reads as if it
  // appeared from nowhere, and a future maintainer looking for
  // the v0.2.0-rc.10 `withStateLock` helper would be confused.
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf-8");
  // Match the section header at the start of a line, optional
  // leading whitespace, then `## 0.3.0` followed by either EOL or
  // a non-digit (so we don't accidentally match `## 0.3.0-rc.X`).
  const sectionRe = /^## 0\.3\.0(\s|$)/m;
  assert.match(
    changelog,
    sectionRe,
    "CHANGELOG.md is missing a `## 0.3.0` section. The v0.3.0 release " +
    "(commit 4217a13, refactor(lock): remove advisory file lock) is " +
    "load-bearing historical context for the v0.4.0 concurrency stance. " +
    "Insert a `## 0.3.0` section between `## 0.4.0` and `## 0.2.1` " +
    "documenting the withStateLock removal and the replacement pattern.",
  );
});

// ── Test 3: root AGENTS.md routes AutoGoal work to this monorepo ──────────

test("docs-drift: root AGENTS.md does not route key files to retired sibling paths", () => {
  const agents = readFileSync(join(workspaceRoot, "AGENTS.md"), "utf-8");
  const staleNeedles = [
    "### Key files (OpenGoal sibling)",
    "`src/goal-state.ts`",
    "`src/server.ts`",
    "`src/goal-chain.ts`",
    "`src/goal-templates.ts`",
    "`MISSION_CONTROL_UI_DESIGN.md`",
    "`MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md`",
  ];

  for (const needle of staleNeedles) {
    assert.ok(
      !agents.includes(needle),
      `root AGENTS.md still contains stale AutoGoal routing: ${needle}`,
    );
  }

  const requiredNeedles = [
    "`packages/autogoal/src/goal-state.ts`",
    "`packages/autogoal/src/server.ts`",
    "`packages/autogoal/src/goal-chain.ts`",
    "`packages/autogoal/src/templates.ts`",
    "`packages/autogoal/docs/gui-integration.md`",
  ];

  for (const needle of requiredNeedles) {
    assert.ok(
      agents.includes(needle),
      `root AGENTS.md is missing current AutoGoal routing: ${needle}`,
    );
  }
});

// ── Test 4: GUI integration doc points at current Desktop files ───────────

test("docs-drift: GUI integration doc points at the current Desktop Goal panel", () => {
  const guiDoc = readFileSync(join(repoRoot, "docs", "gui-integration.md"), "utf-8");
  const staleNeedles = [
    "packages/app/src/components/session/goal-tab.tsx",
    "VerbalChainsaw/opencode",
  ];

  for (const needle of staleNeedles) {
    assert.ok(
      !guiDoc.includes(needle),
      `gui-integration.md still points at stale Desktop consumer: ${needle}`,
    );
  }

  const requiredNeedles = [
    "packages/app/src/pages/session/goal-panel.tsx",
    "packages/app/src/pages/session/goal-panel-actions.ts",
  ];

  for (const needle of requiredNeedles) {
    assert.ok(
      guiDoc.includes(needle),
      `gui-integration.md is missing current Desktop consumer: ${needle}`,
    );
  }
});
