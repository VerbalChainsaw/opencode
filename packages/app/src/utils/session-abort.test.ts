import { describe, expect, test } from "bun:test"
import { abortWorkingSessionTurn } from "./session-abort"

describe("abortWorkingSessionTurn", () => {
  test("does not call abort when the session is not working", async () => {
    const calls: string[] = []

    const result = await abortWorkingSessionTurn({
      client: {
        session: {
          abort: async ({ sessionID }) => {
            calls.push(sessionID)
          },
        },
      },
      sessionID: "session-1",
      working: false,
    })

    expect(result).toEqual({ ok: true, attempted: false })
    expect(calls).toEqual([])
  })

  test("returns ok after aborting a working session", async () => {
    const calls: string[] = []

    const result = await abortWorkingSessionTurn({
      client: {
        session: {
          abort: async ({ sessionID }) => {
            calls.push(sessionID)
          },
        },
      },
      sessionID: "session-1",
      working: true,
    })

    expect(result).toEqual({ ok: true, attempted: true })
    expect(calls).toEqual(["session-1"])
  })

  test("returns the abort error without throwing", async () => {
    const error = new Error("abort denied")

    const result = await abortWorkingSessionTurn({
      client: {
        session: {
          abort: async () => {
            throw error
          },
        },
      },
      sessionID: "session-1",
      working: true,
    })

    expect(result).toEqual({ ok: false, attempted: true, error })
  })
})
