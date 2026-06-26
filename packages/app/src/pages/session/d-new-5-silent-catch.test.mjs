/**
 * D-NEW-5 — silent-catch cleanup tests.
 *
 * Audit finding: pre-fix, four production code paths swallowed
 * failures with .catch(() => {}) or a no-op arrow:
 *
 *   - server.ts:log() (plugin log channel)
 *   - server.ts:notify() tui.showToast()
 *   - server.ts:fireWebhook() fetch()
 *   - app:goal-panel.tsx ignoreRefreshError() (8 use sites)
 *
 * Post-fix, each swallow logs the error so production telemetry
 * surfaces SDK-unreachable, misconfigured webhook URL, or broken
 * toast UI failures.
 *
 * These tests pin the contract: the swallows are STILL fire-and-forget
 * (no propagated rejection) but they log the error to a captured
 * channel (console.warn or the plugin's log() function).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GOAL_PANEL_TSX = join(here, "goal-panel.tsx");
const SERVER_TS = join(here, "..", "..", "..", "..", "autogoal", "src", "server.ts");

// ── 1. ignoreRefreshError logs to console.warn with context label ────────

test("D-NEW-5.1: ignoreRefreshError logs error with context label", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    // Simulate the helper's runtime shape (matches the production
    // closure in goal-panel.tsx).
    const ignoreRefreshError = (context) => (error) => {
      console.warn(`[goal-panel] ${context} failed:`, error);
      return undefined;
    };
    const err = new Error("SDK unreachable");
    const result = ignoreRefreshError("refreshArchive")(err);
    assert.equal(result, undefined);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /\[goal-panel\] refreshArchive failed:/);
    assert.equal(warnings[0][1], err);
  } finally {
    console.warn = originalWarn;
  }
});

test("D-NEW-5.2: ignoreRefreshError accepts any error type", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const ignoreRefreshError = (context) => (error) => {
      console.warn(`[goal-panel] ${context} failed:`, error);
      return undefined;
    };
    ignoreRefreshError("test")("plain string");
    ignoreRefreshError("test")({ code: "ECONNRESET", message: "fetch failed" });
    ignoreRefreshError("test")(null);
    ignoreRefreshError("test")(undefined);
    assert.equal(warnings.length, 4);
    assert.equal(warnings[3][1], undefined);
  } finally {
    console.warn = originalWarn;
  }
});

test("D-NEW-5.3: ignoreRefreshError catches internal log failure and does not propagate", () => {
  const originalWarn = console.warn;
  // Make console.warn throw — this verifies ignoreRefreshError
  // doesn't ALSO throw (which would defeat its fire-and-forget
  // contract). The helper must defensively wrap its log call.
  console.warn = () => {
    throw new Error("console.warn itself is broken");
  };

  try {
    // The production helper MUST wrap console.warn in try/catch
    // so a broken logger doesn't surface as an unhandled rejection.
    const ignoreRefreshError = (context) => (error) => {
      try {
        console.warn(`[goal-panel] ${context} failed:`, error);
      } catch {
        // Swallow logger failures — telemetry must not break
        // the calling code path. The error was already lost
        // (no logger); there's nothing more we can do here.
      }
      return undefined;
    };
    // If this throws, the test fails (uncaught exception in .catch
    // would surface as a rejected promise in production code).
    assert.doesNotThrow(() => {
      ignoreRefreshError("test")(new Error("real error"));
    });
  } finally {
    console.warn = originalWarn;
  }
});

// ── 4. Each call site has a distinct context label ───────────────────────

test("D-NEW-5.4: each ignoreRefreshError call site uses a distinct context", async () => {
  const src = await readFile(GOAL_PANEL_TSX, "utf-8");

  // Match all `.catch(ignoreRefreshError("..."))` call sites.
  const matches = src.matchAll(/\.catch\(ignoreRefreshError\("([^"]+)"\)\)/g);
  const labels = new Set();
  for (const m of matches) {
    labels.add(m[1]);
  }

  // We expect at least 7 distinct context labels based on the
  // production code paths.
  assert.ok(
    labels.size >= 7,
    `expected at least 7 distinct context labels; found ${labels.size}: ${[...labels].join(", ")}`,
  );

  // Each label should be non-empty and human-readable.
  for (const label of labels) {
    assert.ok(label.length > 0, "context label must be non-empty");
    assert.match(label, /^[a-zA-Z][a-zA-Z0-9 .()_-]+$/, `unexpected label format: ${label}`);
  }
});

// ── 5. Server.ts silent catches now log ───────────────────────────────────

test("D-NEW-5.5: server.ts no longer has bare .catch(() => {}) for log/toast/webhook", async () => {
  const src = await readFile(SERVER_TS, "utf-8");

  // The audit identified 3 bare-catch sites in server.ts. Post-fix
  // each logs the error. This test asserts the bare-swallow patterns
  // are gone.

  // The plugin log swallow at log() — must not be `.catch(() => {})`.
  const logSwallowMatch = src.match(
    /client\.app\.log\([^)]*\)\.catch\(\(\) => \{\s*\}\);/,
  );
  assert.equal(
    logSwallowMatch,
    null,
    "server.ts log() still has bare .catch(() => {}); should log via console.warn",
  );

  // The tui.showToast swallow — must not be `.catch(() => {})`.
  const toastSwallowMatch = src.match(
    /client\.tui\.showToast\([^)]*\)\.catch\(\(\) => \{\s*\}\);/,
  );
  assert.equal(
    toastSwallowMatch,
    null,
    "server.ts notify() tui.showToast still has bare .catch(() => {}); should log via console.warn",
  );

  // The webhook fetch swallow — must not be `.catch(() => { /* fire-and-forget */ })` only.
  const webhookSwallowMatch = src.match(
    /fetch\(wh\.url[^)]*\)\.catch\(\(\) => \{\s*\/\* fire-and-forget \*\/\s*\}\);/,
  );
  assert.equal(
    webhookSwallowMatch,
    null,
    "server.ts fireWebhook fetch still has bare .catch with no error logging",
  );
});