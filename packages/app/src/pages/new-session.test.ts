import { describe, expect, test } from "bun:test"
import { nextNewSessionDraftReset } from "./new-session-pure"

const source = async () => await Bun.file(new URL("./new-session.tsx", import.meta.url)).text()

describe("new session draft page", () => {
  test("resets local session model state when the draft route identity changes", () => {
    const calls: string[] = []
    let previousKey: string | undefined

    for (const draftID of [undefined, "draft-a", "draft-a", "draft-b", undefined]) {
      const next = nextNewSessionDraftReset(previousKey, draftID)
      previousKey = next.key
      if (next.shouldReset) calls.push(next.key)
    }

    expect(calls).toEqual(["new-session", "draft-a", "draft-b", "new-session"])
  })

  test("wires draft route resets through the behavioral helper", async () => {
    const src = await source()

    expect(src).toContain("createNewSessionDraftResetEffect(")
    expect(src).toContain("resetSessionModel(local)")
  })
})
