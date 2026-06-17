/**
 * Per audit AUDIT-DEFECTS.md MED-33: shell.openExternal must only
 * accept https: URLs. The isHttpsUrl() helper is the gate; the test
 * pins both the happy path and every non-https scheme a malicious
 * renderer might try to slip in.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { isHttpsUrl } from "./is-https-url"

describe("isHttpsUrl (audit AUDIT-DEFECTS.md MED-33)", () => {
  let warnSpy: ReturnType<typeof mock>
  beforeEach(() => {
    warnSpy = mock(() => {})
    ;(globalThis as unknown as { console: Console }).console = new Proxy(
      console,
      {
        get(target, prop) {
          if (prop === "warn") return warnSpy
          return Reflect.get(target, prop)
        },
      },
    ) as Console
  })
  afterEach(() => {
    ;(globalThis as unknown as { console: Console }).console = console
  })

  test("accepts a real https URL", () => {
    expect(isHttpsUrl("https://opencode.ai")).toBe(true)
    expect(isHttpsUrl("https://docs.opencode.ai/path?q=1")).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("rejects file:// (would launch a local program)", () => {
    expect(isHttpsUrl("file:///etc/passwd")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  test("rejects javascript: (would execute script in browser)", () => {
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  test("rejects http:// (insecure, audit recommends https only)", () => {
    expect(isHttpsUrl("http://example.com")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  test("rejects chrome-extension://", () => {
    expect(isHttpsUrl("chrome-extension://abc/index.html")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  test("rejects ms-windows-store: (would launch a Windows app)", () => {
    expect(isHttpsUrl("ms-windows-store://pdp/?ProductId=foo")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  test("rejects ms-appinstaller: (would trigger a Windows installer)", () => {
    expect(isHttpsUrl("ms-appinstaller://example.com/installer.appx")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  test("rejects an empty string", () => {
    expect(isHttpsUrl("")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  test("rejects a non-URL string", () => {
    expect(isHttpsUrl("not a url at all")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  test("rejects strings with embedded scheme after whitespace", () => {
    // Attacker pattern: prefix with whitespace hoping a naive parser
    // will treat the rest as a host. new URL parses strictly.
    expect(isHttpsUrl("   javascript:alert(1)")).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })
})
