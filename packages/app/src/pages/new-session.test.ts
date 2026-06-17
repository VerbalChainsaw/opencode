import { describe, expect, test } from "bun:test"

const source = async () => await Bun.file(new URL("./new-session.tsx", import.meta.url)).text()

describe("new session draft page", () => {
  test("resets local session model state when a standalone draft route loads", async () => {
    const src = await source()

    expect(src).toContain('useSearchParams<{ draftId?: string; prompt?: string }>()')
    expect(src).toContain("const local = useLocal()")
    expect(src).toContain('() => searchParams.draftId ?? "new-session"')
    expect(src).toContain("() => resetSessionModel(local)")
  })
})
