import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, pickDefaultServerUrl, resolveCurrentServerUrl } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

describe("pickDefaultServerUrl", () => {
  test("prefers the current loopback server over a stale saved loopback server", () => {
    expect(
      pickDefaultServerUrl({
        stored: "http://localhost:4096",
        current: "http://127.0.0.1:9877",
      }),
    ).toBe("http://127.0.0.1:9877")
  })

  test("keeps a saved remote server selection", () => {
    expect(
      pickDefaultServerUrl({
        stored: "https://server.example.test",
        current: "http://127.0.0.1:9877",
      }),
    ).toBe("https://server.example.test")
  })

  test("keeps the current server when nothing is saved", () => {
    expect(
      pickDefaultServerUrl({
        stored: null,
        current: "http://127.0.0.1:9877",
      }),
    ).toBe("http://127.0.0.1:9877")
  })
})

describe("resolveCurrentServerUrl", () => {
  test("uses the dev app origin when vite backend env is missing", () => {
    expect(
      resolveCurrentServerUrl({
        isDev: true,
        hostname: "127.0.0.1",
        origin: "http://127.0.0.1:4173",
      }),
    ).toBe("http://127.0.0.1:4173")
  })

  test("uses the configured dev backend when vite env is present", () => {
    expect(
      resolveCurrentServerUrl({
        isDev: true,
        hostname: "127.0.0.1",
        origin: "http://127.0.0.1:4173",
        viteHost: "127.0.0.1",
        vitePort: "9877",
      }),
    ).toBe("http://127.0.0.1:9877")
  })

  test("prefers a dev override before vite env values", () => {
    expect(
      resolveCurrentServerUrl({
        devOverride: "http://127.0.0.1:9877/",
        isDev: true,
        hostname: "127.0.0.1",
        origin: "http://127.0.0.1:4173",
        viteHost: "127.0.0.1",
        vitePort: "4096",
      }),
    ).toBe("http://127.0.0.1:9877")
  })

  test("keeps the desktop localhost fallback on opencode.ai hosts", () => {
    expect(
      resolveCurrentServerUrl({
        isDev: true,
        hostname: "app.opencode.ai",
        origin: "https://app.opencode.ai",
      }),
    ).toBe("http://localhost:4096")
  })
})
