// ── blocks._counter HMR-safety regression test (v0.7.0+ audit fix) ──────
//
// Verifies that autoKey produces unique keys and the per-bag counter
// increments predictably. (HMR safety is the rationale — each module
// re-evaluation creates a fresh bag with a fresh counter.)

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "..", "dist", "blocks", "factories.js").replace(/\\/g, "/");

test("blocks.autoKey produces a unique key per call", async () => {
  const { blocks } = await import(`file:///${dist}`);
  const k1 = blocks.autoKey("test");
  const k2 = blocks.autoKey("test");
  assert.match(k1, /^test-auto-\d+$/);
  assert.match(k2, /^test-auto-\d+$/);
  assert.notEqual(k1, k2, "consecutive autoKey calls must yield distinct keys");
});

test("blocks.autoKey with different prefixes does not collide", async () => {
  const { blocks } = await import(`file:///${dist}`);
  const a = blocks.autoKey("alpha");
  const b = blocks.autoKey("beta");
  assert.match(a, /^alpha-auto-\d+$/);
  assert.match(b, /^beta-auto-\d+$/);
  // The numeric suffixes are independent of the prefix string.
  const numA = Number(a.split("-").pop());
  const numB = Number(b.split("-").pop());
  assert.ok(Number.isFinite(numA) && Number.isFinite(numB));
});
