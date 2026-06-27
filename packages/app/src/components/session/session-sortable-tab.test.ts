import { describe, expect, test } from "bun:test"

const sortableTabSource = async () => await Bun.file(new URL("./session-sortable-tab.tsx", import.meta.url)).text()

describe("session sortable tab UI contracts", () => {
  test("file tab close button uses a 24px hit target", async () => {
    const src = await sortableTabSource()
    const closeButton = src.match(/<IconButton[\s\S]{0,220}aria-label=\{language\.t\("common\.closeTab"\)\}/)
    expect(closeButton).toBeTruthy()
    expect(closeButton![0]).toContain('class="h-6 w-6"')
    expect(closeButton![0]).not.toContain('class="h-5 w-5"')
  })
})
