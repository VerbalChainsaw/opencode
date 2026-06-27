import { describe, expect, test } from "bun:test"

const sessionSidePanelSource = async () => await Bun.file(new URL("./session-side-panel.tsx", import.meta.url)).text()

describe("session side panel UI contracts", () => {
  test("Goal and context tab close buttons use 24px hit targets", async () => {
    const src = await sessionSidePanelSource()
    const closeButtons = src.match(/<IconButton[\s\S]{0,420}aria-label=\{language\.t\("common\.closeTab"\)\}/g) ?? []
    expect(closeButtons.length).toBeGreaterThanOrEqual(2)
    expect(closeButtons.every((button) => button.includes('class="h-6 w-6"'))).toBe(true)
    expect(closeButtons.some((button) => button.includes('class="h-5 w-5"'))).toBe(false)
  })
})
