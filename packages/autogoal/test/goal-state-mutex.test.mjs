// ── withStateLock regression test (v0.7.0 audit fix R1/R2/R5) ────────────
//
// The mutex serializes state-mutating callbacks within a single Node
// process. The audit found that tool handlers and the auto-loop's
// evaluate() IIFE could clobber each other's field updates. This test
// pins the contract of `withStateLock` directly so future refactors
// can't regress the serialization guarantee.
//
// What we pin:
//   1. FIFO ordering — second call runs AFTER first returns
//   2. Different directories — run in parallel
//   3. Throw inside fn — third caller can still acquire (no deadlock)
//   4. Return value is awaited and forwarded to caller
//   5. Async fn body is properly awaited

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Resolve the built artifact (goal-state.js lives in dist/ after `npm run build`).
const dist = join(import.meta.dirname || __dirname, "..", "dist");
const goalStatePath = join(dist, "goal-state.js").replace(/\\/g, "/");

test("withStateLock: exists in dist/goal-state.js after build", () => {
  assert.ok(existsSync(goalStatePath),
    `dist/goal-state.js not found at ${goalStatePath} — did you run \`npm run build\`?`);
});

test("withStateLock: serializes concurrent calls on the same directory (FIFO)", async () => {
  const { withStateLock } = await import(`file:///${goalStatePath}`);
  const dir = mkdtempSync(join(tmpdir(), "wsl-fifo-"));
  try {
    const order = [];
    // First call: holds the lock for 50ms, then records.
    const p1 = withStateLock(dir, async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("first");
    });
    // Second call: queued behind first, runs after first returns.
    const p2 = withStateLock(dir, async () => {
      order.push("second");
    });
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["first", "second"],
      "second call must run after first returns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withStateLock: runs calls on DIFFERENT directories in parallel", async () => {
  const { withStateLock } = await import(`file:///${goalStatePath}`);
  const dirA = mkdtempSync(join(tmpdir(), "wsl-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wsl-b-"));
  try {
    const order = [];
    // Two independent locks — should run concurrently.
    const start = Date.now();
    const p1 = withStateLock(dirA, async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("A");
    });
    const p2 = withStateLock(dirB, async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("B");
    });
    await Promise.all([p1, p2]);
    const elapsed = Date.now() - start;
    // If they ran serially, elapsed would be ≥100ms. Parallel ⇒ ~50ms.
    assert.ok(elapsed < 95, `expected parallel execution (<95ms), got ${elapsed}ms`);
    // Order may vary (whichever microtask resolves first); both must be present.
    assert.equal(order.length, 2);
    assert.ok(order.includes("A") && order.includes("B"));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("withStateLock: a throw inside fn releases the lock (no deadlock)", async () => {
  const { withStateLock } = await import(`file:///${goalStatePath}`);
  const dir = mkdtempSync(join(tmpdir(), "wsl-throw-"));
  try {
    // First call throws.
    await withStateLock(dir, () => {
      throw new Error("intentional test failure");
    }).then(
      () => assert.fail("expected the throw to propagate"),
      (err) => assert.equal(err.message, "intentional test failure"),
    );
    // Second call after the throw must still acquire — proves the
    // catch+swallow on the slot doesn't poison the chain.
    const result = await withStateLock(dir, () => "ok");
    assert.equal(result, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withStateLock: returns the awaited fn return value", async () => {
  const { withStateLock } = await import(`file:///${goalStatePath}`);
  const dir = mkdtempSync(join(tmpdir(), "wsl-ret-"));
  try {
    // Sync return.
    assert.equal(await withStateLock(dir, () => 42), 42);
    // Async return.
    assert.equal(await withStateLock(dir, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "async-result";
    }), "async-result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withStateLock: many concurrent callers all serialize in FIFO order", async () => {
  const { withStateLock } = await import(`file:///${goalStatePath}`);
  const dir = mkdtempSync(join(tmpdir(), "wsl-many-"));
  try {
    const order = [];
    const promises = [];
    for (let i = 0; i < 10; i++) {
      const idx = i;
      promises.push(withStateLock(dir, async () => {
        // No delay — pure FIFO check. If any two run concurrently, the
        // slot assignment would not be FIFO-pure.
        order.push(idx);
      }));
    }
    await Promise.all(promises);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      "all 10 calls must run in submission order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
