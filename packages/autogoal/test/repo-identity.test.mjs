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
 *
 * Cross-platform notes:
 *
 *   - The script is a bash script (`#!/usr/bin/env bash`). On POSIX
 *     hosts (`/usr/bin/bash` is on PATH) Node's `spawnSync("bash", ...)`
 *     works directly. On Windows, the `bash` resolved via PATH is the
 *     WSL bash launcher, which interprets Windows backslash paths as
 *     escape sequences and produces ENOENT (exit 127). The fix is to
 *     use Git Bash (`C:\Program Files\Git\bin\bash.exe`) when available
 *     on Windows — it accepts both backslash and forward-slash paths.
 *   - When no compatible bash is found, tests that need a shell skip
 *     explicitly with a recorded reason. They are NOT failures.
 *   - Temp-dir cleanup on Windows can EBUSY when the test process
 *     cwd is the temp dir (Windows prevents removing a cwd of any
 *     handle). The test restores `process.cwd()` to the test file's
 *     directory before `rmSync`, and uses `maxRetries` so transient
 *     handle leaks settle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, win32, posix } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(here, "..", "..", "..");
const script = join(monorepoRoot, "scripts", "assert-autogoal-repo.sh");
const originalCwd = process.cwd();

/**
 * Locate a usable bash interpreter. Returns `{ exe, kind }` on success
 * or `null` if no compatible bash is available on this host.
 *
 * Search order:
 *   1. `bash` on PATH (works on POSIX hosts).
 *   2. Git Bash at the standard Windows install path
 *      (`C:\Program Files\Git\bin\bash.exe`). Git Bash accepts both
 *      backslash and forward-slash paths.
 *   3. `/c/Program Files/Git/usr/bin/bash.exe` (alternate Git layout).
 *
 * On Windows, prefer Git Bash over the WSL bash launcher: the WSL
 * launcher interprets `\` in script path arguments as bash escape
 * characters and produces ENOENT.
 */
function findBash() {
  // First try: `bash` on PATH.
  const probe = spawnSync("bash", ["--version"], { encoding: "utf-8" });
  if (probe.status === 0) {
    // Sanity-check that this `bash` actually understands a real bash
    // version banner (not a Windows cmd-stub returning bogus output).
    if (/GNU bash/i.test(probe.stdout ?? "")) {
      return { exe: "bash", kind: "path-bash" };
    }
  }

  // On Windows, fall back to known Git Bash locations. The `C:/`
  // forward-slash form is what Node returns from path.join on Windows;
  // we test both layouts.
  if (process.platform === "win32") {
    const candidates = [
      join(win32.sep, "Program Files", "Git", "bin", "bash.exe"),
      join(win32.sep, "Program Files", "Git", "usr", "bin", "bash.exe"),
      join(win32.sep, "Program Files (x86)", "Git", "bin", "bash.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const v = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
        if (v.status === 0 && /GNU bash/i.test(v.stdout ?? "")) {
          return { exe: candidate, kind: "git-bash" };
        }
      }
    }
  }

  return null;
}

/**
 * Convert the absolute script path to a form the chosen bash
 * interpreter accepts.
 *
 * On POSIX hosts (`process.platform === "linux"` etc.), `path.join`
 * already returns forward-slash paths and the bash is a real
 * Linux bash at `/usr/bin/bash`. No conversion is needed; the path
 * is already correct.
 *
 * On Windows hosts, the bash resolved via PATH is the WSL bash
 * launcher (`C:\Windows\System32\bash.exe`), which is a real Linux
 * bash that needs POSIX paths. Node's `path.join` returns
 * `C:\Users\...` on Windows; convert to `/mnt/c/Users/...`. The
 * drvfs mount makes this work.
 *
 * Git Bash (the Windows-native alternative) accepts both forms; we
 * still normalize to `/mnt/c/...` because that path is also accepted
 * by Git Bash (via msys2's POSIX translation), so a single code
 * path works.
 */
function scriptArgForBash() {
  if (process.platform === "win32") {
    // Convert `C:\Users\foo\bar.sh` -> `/mnt/c/Users/foo/bar.sh`
    // for the WSL bash launcher (which sees the Windows filesystem
    // mounted at /mnt/<drive>). Git Bash accepts both forms via
    // msys2; the /mnt/c form is also accepted there.
    return script
      .replace(/^([A-Za-z]):([\\/])/, (_, drive, sep) => `/mnt/${drive.toLowerCase()}${sep}`)
      .split(win32.sep)
      .join(posix.sep);
  }
  return script;
}

/**
 * Run the assert-autogoal-repo.sh script under the chosen bash.
 * Restores the test process cwd to the test file's directory
 * before returning so a Windows-EBUSY cannot block temp-dir cleanup
 * (Windows refuses to remove a directory that is the cwd of any
 * handle in the process).
 */
function runScript(bash, cwdOverride) {
  const target = cwdOverride ?? monorepoRoot;
  // chdir to target so the script sees the right git root (must run
  // before spawn because spawn reads cwd synchronously).
  process.chdir(target);
  try {
    return spawnSync(bash.exe, [scriptArgForBash()], {
      cwd: target,
      encoding: "utf-8",
      timeout: 10_000,
    });
  } finally {
    try {
      process.chdir(originalCwd);
    } catch {
      /* ignore — originalCwd may already be unreachable */
    }
  }
}

/**
 * Remove a temp dir with Windows-safe retry handling.
 *
 * Windows occasionally EBUSYs a directory that an external process
 * (e.g. the bash script we just spawned into) has just released.
 * `rmSync`'s `maxRetries`/`retryDelay` does not always cooperate
 * with `recursive: true` on Windows, so we wrap a simple manual
 * retry with linear backoff.
 *
 * Restores `process.cwd()` to the test file's directory first so
 * Windows does not EBUSY on a cwd-bound handle.
 */
function rmSafe(p) {
  try {
    process.chdir(originalCwd);
  } catch {
    /* ignore */
  }
  let lastErr;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      rmSync(p, { recursive: true, force: true });
      return;
    } catch (e) {
      lastErr = e;
      const delay = 100 * (attempt + 1);
      const end = Date.now() + delay;
      while (Date.now() < end) {
        /* spin — Node has no sync sleep; keep attempts fast */
      }
    }
  }
  throw lastErr;
}

const bash = findBash();
const skipReason = bash
  ? null
  : "no compatible bash runtime found on this host (tried PATH `bash`, Git Bash at standard Windows paths)";

// ── Happy path ─────────────────────────────────────────────────────────

test("assert-autogoal-repo.sh exits 0 from the canonical monorepo root", { skip: skipReason ?? undefined }, () => {
  const r = runScript(bash);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /assert-autogoal-repo: OK/);
  assert.match(r.stdout, /opencode-source/);
});

// ── Sad paths ──────────────────────────────────────────────────────────

test("assert-autogoal-repo.sh exits 1 outside any git work tree", { skip: skipReason ?? undefined }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "autogoal-repo-id-"));
  try {
    const r = runScript(bash, tmp);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /not inside a git work tree/);
  } finally {
    rmSafe(tmp);
  }
});

test("assert-autogoal-repo.sh exits 2 inside a non-canonical git repo", { skip: skipReason ?? undefined }, () => {
  // Simulate the most common drift case: a stale shell cd'd into a
  // repo whose basename is not "opencode-source". The basename
  // check is what catches this.
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

    const r = runScript(bash, tmp);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /expected basename 'opencode-source'/);
    assert.match(r.stderr, /retired on 2026-06-22/);
  } finally {
    rmSafe(tmp);
  }
});