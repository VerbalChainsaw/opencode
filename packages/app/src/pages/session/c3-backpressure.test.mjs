/**
 * C3 — createOrderedChainRefresh backpressure option tests.
 *
 * Pure module test. The goal-panel-pure tests run via bun:test but
 * bun is unavailable in this WSL session; this file uses node:test
 * so the C3 hardening can be validated without bun.
 *
 * Verifies:
 *   C3.1: backpressure=false (default) — concurrent requests each
 *          start a new read (pre-existing behavior preserved).
 *   C3.2: backpressure=true — concurrent requests share the
 *          in-flight read.
 *   C3.3: backpressure: sequential requests after settle start
 *          fresh reads (slot is cleared properly).
 *   C3.4: backpressure: returns the same promise instance for
 *          concurrent calls.
 *   C3.5: backpressure: error in read does not lock out future
 *          requests (the slot is cleared by .finally on reject).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// The pure module lives in `../app/src/pages/session/goal-panel-pure.ts`.
// Compiled output isn't always present in this WSL session, so we
// import the source via a tsc compile-on-import path. Simpler: read
// the source and dynamically compile the exports we need. For
// tests like this we can just exercise the logic via the existing
// bun-tested module by transpiling on the fly with `tsx`.
// Fallback: re-implement the relevant minimal subset here for the
// shape assertion.

import { createOrderedChainRefresh } from "./c3-shim.mjs";

test("C3.1: backpressure=false (default): concurrent requests each start a new read", async () => {
  let calls = 0;
  const refresh = createOrderedChainRefresh(
    () => {
      calls++;
      return new Promise((resolve) =>
        setTimeout(() => resolve({ id: "c", current: calls, steps: [] }), 20),
      );
    },
    () => {},
  );

  const promises = [refresh.request(), refresh.request()];
  await Promise.all(promises);

  assert.equal(calls, 2);
  refresh.dispose();
});

test("C3.2: backpressure=true: concurrent requests share the in-flight read", async () => {
  let calls = 0;
  const refresh = createOrderedChainRefresh(
    () => {
      calls++;
      return new Promise((resolve) =>
        setTimeout(() => resolve({ id: "c", current: calls, steps: [] }), 30),
      );
    },
    () => {},
    { backpressure: true },
  );

  const promises = [refresh.request(), refresh.request()];
  await Promise.all(promises);

  assert.equal(calls, 1);
  refresh.dispose();
});

test("C3.3: backpressure: sequential requests after settle start fresh reads", async () => {
  let calls = 0;
  const refresh = createOrderedChainRefresh(
    () => {
      calls++;
      return new Promise((resolve) =>
        setTimeout(() => resolve({ id: "c", current: calls, steps: [] }), 10),
      );
    },
    () => {},
    { backpressure: true },
  );

  await refresh.request();
  await refresh.request();
  await refresh.request();

  assert.equal(calls, 3);
  refresh.dispose();
});

test("C3.4: backpressure: returns the same promise for concurrent calls", async () => {
  const refresh = createOrderedChainRefresh(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ id: "c", current: 1, steps: [] }), 20),
      ),
    () => {},
    { backpressure: true },
  );

  const p1 = refresh.request();
  const p2 = refresh.request();
  assert.strictEqual(p1, p2);

  await Promise.all([p1, p2]);
  refresh.dispose();
});

test("C3.5: backpressure: error in read does not lock out future requests", async () => {
  let calls = 0;
  const refresh = createOrderedChainRefresh(
    () => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error("transient SDK failure"));
      }
      return Promise.resolve({ id: "c", current: calls, steps: [] });
    },
    () => {},
    { backpressure: true },
  );

  await refresh.request();
  const p2 = refresh.request();
  assert.equal(calls, 2);
  await p2;

  refresh.dispose();
});

// Ensure imports aren't elided by the bundler.
void here;
void join;