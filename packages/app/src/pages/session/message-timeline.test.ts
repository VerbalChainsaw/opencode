import { describe, expect, test } from "bun:test"

const messageTimelineSource = async () => await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()

describe("message timeline accessibility contracts", () => {
  test("jump-to-latest control exposes a localized accessible name", async () => {
    const src = await messageTimelineSource()
    const jumpControlStart = src.indexOf("onClick={props.onResumeScroll}")
    expect(jumpControlStart).toBeGreaterThan(-1)

    const jumpControl = src.slice(Math.max(0, jumpControlStart - 260), jumpControlStart + 120)
    expect(jumpControl).toContain('aria-label={language.t("session.messages.jumpToLatest")}')
    expect(jumpControl).toContain('title={language.t("session.messages.jumpToLatest")}')
  })
})
