/**
 * Repo-identity script guard.
 *
 * The script under test, `scripts/assert-autogoal-repo.sh`, lives at the
 * monorepo root. It is wired into the repo identity pipeline (called by
 * humans before AutoGoal work and by CI as a pre-flight gate). This test
 * verifies that the script correctly:
 *
 *   - exits 0 when invoked from the canonical opencode-source root
 *   - exits 1 when invoked outside any git work tree
 *   - exits 2 when invoked inside a repo whose basename is not
 *     "opencode-source" (the most common drift case: a stale shell
 *     cd'd into the retired ../OpenGoal sibling)
 *
 * The test is co-located with the autogoal package test suite because
 * that is the only `node --test` runner the monorepo currently has.
 * Running it requires the build to have already produced the dist tree
 * for tests that import from it; this test does not depend on dist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(here, "..", "..", "..");
const script = join(monorepoRoot, "scripts", "assert-autogoal-repo.sh");

function runScript(cwd) {
  return spawnSync("bash", [script], {
    cwd: cwd ?? monorepoRoot,
    encoding: "utf-8",
    timeout: 10_000,
  });
}

// ── Happy path ─────────────────────────────────────────────────────────

test("assert-autogoal-repo.sh exits 0 from the canonical monorepo root", () => {
  const r = runScript();
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /assert-autogoal-repo: OK/);
  assert.match(r.stdout, /opencode-source/);
});

// ── Sad paths ──────────────────────────────────────────────────────────

test("assert-autogoal-repo.sh exits 1 outside any git work tree", () => {
  const tmp = mkdtempSync(join(tmpdir(), "autogoal-repo-id-"));
  try {
    const r = runScript(tmp);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /not inside a git work tree/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("assert-autogoal-repo.sh exits 2 inside a non-canonical git repo", () => {
  // Simulate the most common drift case: a stale shell cd'd into the
  // retired sibling. The basename check is what catches this.
  const tmp = mkdtempSync(join(tmpdir(), "autogoal-repo-id-"));
  try {
    // Initialize a throwaway git repo with a non-canonical basename.
    const init = spawnSync(
      "git",
      ["init", "-q", "-b", "main"],
      { cwd: tmp, encoding: "utf-8" },
    );
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
    const conf = spawnSync(
      "git",
      ["config", "user.email", "test@local"],
      { cwd: tmp, encoding: "utf-8" },
    );
    assert.equal(conf.status, 0);
    const conf2 = spawnSync(
      "git",
      ["config", "user.name", "test"],
      { cwd: tmp, encoding: "utf-8" },
    );
    assert.equal(conf2.status, 0);
    const commit = spawnSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: tmp, encoding: "utf-8" },
    );
    assert.equal(commit.status, 0, `git commit failed: ${commit.stderr}`);

    // Rename the directory to mimic the retired sibling's basename.
    // The script reads git rev-parse, so basename matters; the cwd we
    // pass to spawnSync still resolves to the same physical path.
    // Easiest: just confirm exit 2 from inside /tmp/<random>; the
    // basename will not be "opencode-source".
    const r = runScript(tmp);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /expected basename 'opencode-source'/);
    assert.match(r.stderr, /retired on 2026-06-22/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});