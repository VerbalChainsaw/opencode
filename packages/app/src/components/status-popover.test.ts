import { describe, expect, test } from "bun:test"
import { statusDotTone } from "./status-popover-tone"

describe("statusDotTone", () => {
  test("shows success when the server is healthy and no MCP issue is active", () => {
    expect(statusDotTone({ ready: true, healthy: true, serverHealth: true })).toBe("success")
  })

  test("shows warning and critical MCP issues only after the server is healthy", () => {
    expect(statusDotTone({ ready: true, healthy: false, serverHealth: true, issue: "warning" })).toBe("warning")
    expect(statusDotTone({ ready: true, healthy: false, serverHealth: true, issue: "critical" })).toBe("critical")
  })

  test("shows critical when the server health check fails", () => {
    expect(statusDotTone({ ready: true, healthy: false, serverHealth: false })).toBe("critical")
  })

  test("uses the weak state before health is known or readiness completes", () => {
    expect(statusDotTone({ ready: false, healthy: false, serverHealth: undefined })).toBe("weak")
    expect(statusDotTone({ ready: false, healthy: true, serverHealth: true })).toBe("weak")
  })
})
