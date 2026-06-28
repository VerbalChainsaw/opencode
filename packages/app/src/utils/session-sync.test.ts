import { describe, expect, test } from "bun:test"
import { isSessionSyncNotFound, syncSessionOrIgnoreNotFound } from "./session-sync"

describe("session sync helpers", () => {
  test("treats missing sessions as nonfatal", async () => {
    const missing = new Error("missing", { cause: { status: 404 } })
    const sync = async () => {
      throw missing
    }

    await expect(syncSessionOrIgnoreNotFound("ses_missing", sync)).resolves.toBeUndefined()
    expect(isSessionSyncNotFound(missing)).toBe(true)
  })

  test("propagates non-404 session sync failures", async () => {
    const failure = new Error("server unavailable", { cause: { status: 503 } })

    await expect(
      syncSessionOrIgnoreNotFound("ses_active", async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
  })

  test("does not sync when no session id is available", async () => {
    let calls = 0

    await expect(
      syncSessionOrIgnoreNotFound(undefined, async () => {
        calls += 1
        return "synced"
      }),
    ).resolves.toBeUndefined()
    expect(calls).toBe(0)
  })
})
