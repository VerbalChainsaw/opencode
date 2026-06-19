/**
 * Per audit AUDIT-DEFECTS.md MED-43: the customFetch shim used to
 * be `any` for both the variable and the request param. This test
 * guards against the regression by asserting the source files in
 * this package don't use `any` for that pattern.
 *
 * The test is a static source check, not a runtime test, because
 * the SDK ships only a typecheck pass (`tsgo --noEmit`) and a
 * generated build script. The audit's concern was code quality,
 * which is what this test guards.
 */

import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const dir = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => Bun.file(join(dir, rel)).text()

describe("SDK client customFetch typing (AUDIT-DEFECTS.md MED-43)", () => {
  test("v1 client.ts does not use `any` for the customFetch shim", async () => {
    const src = await read("./client.ts")
    // The original MED-43 anti-pattern: `const customFetch: any = (req: any)`.
    // After the fix, the local variable uses a structural CustomFetch
    // interface and the request param is `Request`, not `any`.
    expect(src).not.toMatch(/const\s+customFetch\s*:\s*any\s*=\s*\(\s*req\s*:\s*any/)
  })

  test("v2 client.ts does not use `any` for the customFetch shim", async () => {
    const src = await read("./v2/client.ts")
    expect(src).not.toMatch(/const\s+customFetch\s*:\s*any\s*=\s*\(\s*req\s*:\s*any/)
  })

  test("v1 client.ts documents the audit finding", async () => {
    const src = await read("./client.ts")
    expect(src).toContain("AUDIT-DEFECTS.md MED-43")
  })

  test("v2 client.ts documents the audit finding", async () => {
    const src = await read("./v2/client.ts")
    expect(src).toContain("AUDIT-DEFECTS.md MED-43")
  })
})
