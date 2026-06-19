import { describe, expect, test } from "bun:test"
import { createLegacySessionFallbackRequest } from "./client"

describe("createLegacySessionFallbackRequest", () => {
  test("rewrites v2 session GET requests onto the legacy session surface", () => {
    const request = new Request(
      "http://127.0.0.1:9877/api/session/ses_test/message?limit=80&directory=C%3A%5Cwork&location%5Bdirectory%5D=C%3A%5Cwork",
      {
        headers: {
          "x-opencode-directory": "C%3A%5Cwork",
        },
      },
    )

    const fallback = createLegacySessionFallbackRequest(request)

    expect(fallback).toBeDefined()
    expect(fallback?.url).toBe("http://127.0.0.1:9877/session/ses_test/message?limit=80&directory=C%3A%5Cwork")
    expect(fallback?.headers.get("x-opencode-directory")).toBeNull()
  })

  test("does not rewrite non-session paths", () => {
    const request = new Request("http://127.0.0.1:9877/api/provider")
    expect(createLegacySessionFallbackRequest(request)).toBeUndefined()
  })

  test("does not rewrite non-idempotent requests", () => {
    const request = new Request("http://127.0.0.1:9877/api/session/ses_test/prompt", { method: "POST" })
    expect(createLegacySessionFallbackRequest(request)).toBeUndefined()
  })
})
