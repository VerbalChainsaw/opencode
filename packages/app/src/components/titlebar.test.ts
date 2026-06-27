import { describe, expect, test } from "bun:test"

/**
 * Thin TSX wiring smoke for the titlebar.
 * Behavior lives in titlebar-pure.test.ts; these checks only cover component
 * seams that are not meaningful to assert without rendering the full app shell.
 */

const titlebar = async () =>
  (await Bun.file(new URL("./titlebar.tsx", import.meta.url)).text()).toString()

describe("titlebar TSX wiring", () => {
  test("wires onClick to the openNewTab handler on the V2 + button", async () => {
    const src = await titlebar()
    expect(src).toMatch(/IconButtonV2[\s\S]{0,400}onClick=\{openNewTab\}/)
  })

  test("wires new-tab handlers through titlebar pure helpers", async () => {
    const src = await titlebar()
    expect(src).toContain("resolveTitlebarNewSessionDirectory")
    expect(src).toContain("readTitlebarDirectoryPickerSelection(result)")
    expect(src.match(/tabs\.newDraft\(titlebarDraftRequest\(server\.key, directory\)\)/g)?.length).toBe(2)
    expect(src).toContain("server.projects.touch(directory)")
    expect(src).not.toContain("layout.projects.touch(directory)")
  })

  test("does NOT navigate to the legacy /:dir/session route (which crashes on the draft page)", async () => {
    const src = await titlebar()
    expect(src).not.toMatch(/\$\{params\.dir\}\/session[^?]/i)
  })

  test("V2 tab strip yields space to the right action rail", async () => {
    const src = await titlebar()
    const tabScroll = src.match(/data-component="titlebar-v2-tabs-scroll"[\s\S]{0,240}/)
    expect(tabScroll).toBeTruthy()
    expect(tabScroll![0]).toContain("flex-1")
    expect(tabScroll![0]).toContain("basis-0")

    const v2Layout = src.slice(src.indexOf('data-component="titlebar-v2-tabs-scroll"'), src.indexOf("<TitlebarV2Right"))
    expect(v2Layout).not.toContain('class="flex-1"')
  })

  test("Electron Windows titlebar width is clamped to the viewport", async () => {
    const src = await titlebar()
    expect(src).toContain("electronTitlebarWidthCSS(windowsControlsWidth())")
    expect(src).toContain("width: electronWindows() ? electronTitlebarWidth() : undefined")
    expect(src).toContain('"max-width": electronWindows() ? electronTitlebarWidth() : undefined')
  })

  test("draft tab close button uses the localized close-tab label", async () => {
    const src = await titlebar()
    expect(src).toContain('aria-label={language.t("common.closeTab")}')
    expect(src).not.toContain('aria-label="Close tab"')
  })
})
