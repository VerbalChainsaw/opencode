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

  test("Goal tab chrome is derived from session-filtered goal state, not raw workspace state", async () => {
    const src = await sessionSidePanelSource()
    const goalBlockStart = src.indexOf("const goal = useGoal()")
    const goalBlockEnd = src.indexOf("const fileTreeTab = () => layout.fileTree.tab()", goalBlockStart)
    expect(goalBlockStart).toBeGreaterThan(-1)
    expect(goalBlockEnd).toBeGreaterThan(goalBlockStart)
    const goalBlock = src.slice(goalBlockStart, goalBlockEnd)

    expect(goalBlock).toContain("goalStateForSession(goal.store.state, params.id)")
    expect(goalBlock).not.toContain("goalCloseable(goal.store.state?.status)")
    expect(goalBlock).not.toContain('goal.store.state?.status === "paused"')
    expect(goalBlock).not.toContain("const state = goal.store.state")
  })
})
