/**
 * v0.7.3 / scan 2026-06-25 (C1) — withFileLock cross-process lock tests.
 *
 * The cross-process lock is a defense-in-depth layer on top of
 * withStateLock (in-process). The OpenCode host loads one plugin
 * per workspace, so multi-process contention is theoretical. These
 * tests pin the contract regardless.
 *
 * No external dependencies — uses Node's built-in fs.open with
 * O_EXCL | O_CREAT.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fileLockUrl = pathToFileURL(join(here, "..", "dist", "file-lock.js")).href;
const fileLock = await import(fileLockUrl);

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-flock-"));
}

test("C1.1: withFileLock runs the callback and returns its result", async () => {
  const dir = freshDir();
  try {
    const result = await fileLock.withFileLock(
      dir,
      async () => "hello world",
      { acquireTimeoutMs: 200 },
    );
    assert.equal(result, "hello world");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1.2: withFileLock removes the lockfile after the callback", async () => {
  const dir = freshDir();
  try {
    await fileLock.withFileLock(
      dir,
      async () => "ok",
      { acquireTimeoutMs: 200 },
    );
    const lockPath = join(dir, ".opencode", ".goal-state.lock");
    assert.equal(
      existsSync(lockPath),
      false,
      "lockfile must be removed after the callback completes",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1.3: withFileLock serializes concurrent callers (lock blocks)", async () => {
  const dir = freshDir();
  try {
    // Pre-create the lockfile so the next acquire blocks.
    const lockPath = join(dir, ".opencode", ".goal-state.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "existing-pid\n", "utf-8");

    const start = Date.now();
    const result = await fileLock.withFileLock(
      dir,
      async () => "ok",
      // Short timeout so the test doesn't hang for the full 2s.
      { acquireTimeoutMs: 50, bestEffort: false },
    );
    const elapsed = Date.now() - start;
    // Could not acquire within 50ms — returned undefined.
    assert.equal(result, undefined, "bestEffort:false returns undefined on timeout");
    assert.ok(elapsed >= 40, `should wait at least 40ms; took ${elapsed}ms`);
    // Lockfile still exists (we never acquired).
    assert.ok(existsSync(lockPath), "lockfile still exists after timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1.4: withFileLock bestEffort:true proceeds unlocked on timeout", async () => {
  const dir = freshDir();
  try {
    const lockPath = join(dir, ".opencode", ".goal-state.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "existing-pid\n", "utf-8");

    const result = await fileLock.withFileLock(
      dir,
      async () => "fallback-value",
      { acquireTimeoutMs: 50, bestEffort: true },
    );
    assert.equal(
      result,
      "fallback-value",
      "bestEffort:true runs the callback even when the lock cannot be acquired",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1.5: withFileLock is fresh-lock-aware (does not clear a recently-created lock)", async () => {
  const dir = freshDir();
  try {
    const lockPath = join(dir, ".opencode", ".goal-state.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "fresh-pid\n", "utf-8");

    const result = await fileLock.withFileLock(
      dir,
      async () => "ok",
      { acquireTimeoutMs: 50, bestEffort: true },
    );
    // The lock is fresh (just written); bestEffort proceeds
    // unlocked with the callback's value.
    assert.equal(result, "ok");
    assert.ok(existsSync(lockPath), "fresh lockfile still exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1.6: withFileLock is exported from autogoal/dist/file-lock.js", () => {
  assert.equal(typeof fileLock.withFileLock, "function");
});

// ── Q7 follow-up: stale-lock mtime test ─────────────────────────────────

test("C1.7: withFileLock clears stale lockfiles (injected clock)", async () => {
  // Q7 follow-up — closes the gap flagged by the minimax
  // cross-validator: the previous test suite asserted only the
  // "fresh lock" path; the "stale lock" path was dead-code in the
  // test suite. The fix is to inject a clock via the new `now`
  // option so the staleness check can be exercised without
  // sleeping or manipulating mtime.
  const dir = freshDir();
  try {
    const lockPath = join(dir, ".opencode", ".goal-state.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    // Pre-create the lockfile. mtime will be "now" (just written).
    writeFileSync(lockPath, "stale-pid\n", "utf-8");

    // Injected clock that returns a time 30 seconds in the future.
    // With staleMs=10 (the default) and the lockfile's mtime being
    // 30 seconds in the past (relative to the injected clock),
    // isStale returns true → unlink runs → the next tryAcquire
    // succeeds. So the callback should run.
    let virtualNow = Date.now() + 30_000;
    const injectedNow = () => virtualNow;

    const result = await fileLock.withFileLock(
      dir,
      async () => "stale-cleared-and-acquired",
      {
        acquireTimeoutMs: 200,
        bestEffort: false,
        staleMs: 10_000, // lock older than 10s is stale
        now: injectedNow,
      },
    );
    assert.equal(
      result,
      "stale-cleared-and-acquired",
      "stale lock should be detected, cleared, and the callback should run",
    );
    // After acquire, the lockfile is removed by the finally block.
    assert.equal(
      existsSync(lockPath),
      false,
      "lockfile removed after callback (proves stale-clear → acquire → run → cleanup)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1.8: withFileLock does NOT clear fresh lockfiles (injected clock)", async () => {
  // Companion to C1.7: with a lockfile mtime that is NOT yet
  // past the staleness threshold, the lock should NOT be cleared
  // — confirming the threshold logic is correct (not "always clear").
  // The injected clock ADVANCES on each call (5ms per call) so the
  // polling loop's timeout check can fire. Without advancing, the
  // loop would run forever because `now() - start` would stay 0.
  const dir = freshDir();
  try {
    const lockPath = join(dir, ".opencode", ".goal-state.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "fresh-pid\n", "utf-8");

    let callCount = 0;
    const virtualStart = Date.now() + 5_000;
    const injectedNow = () => virtualStart + (callCount++ * 5);

    const result = await fileLock.withFileLock(
      dir,
      async () => "fresh-lock-held",
      {
        acquireTimeoutMs: 100,
        bestEffort: false,
        staleMs: 10_000,
        now: injectedNow,
      },
    );
    // Lock is fresh; acquire times out. bestEffort:false returns undefined.
    assert.equal(
      result,
      undefined,
      "fresh lock should NOT be stale-cleared (threshold logic correct)",
    );
    // Original lockfile still exists (we did not touch it).
    assert.ok(
      existsSync(lockPath),
      "fresh lockfile preserved (no clear-and-retry path triggered)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});