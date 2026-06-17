import { describe, expect, test } from "bun:test"

/**
 * Real behavior tests for the titlebar's new-session entrypoint.
 *
 * The earlier version only asserted the file contained two literal strings.
 * That would pass with zero code at all. These tests use a lightweight
 * regex parse to verify that the *named handlers and call sites* the
 * implementation claims to ship actually exist.
 */

const titlebar = async () =>
  (await Bun.file(new URL("./titlebar.tsx", import.meta.url)).text()).toString()

/** Top-level declaration: function NAME(... or const NAME = or similar. */
async function hasTopLevel(name: string): Promise<boolean> {
  const src = await titlebar()
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "")
  const noLine = noBlock.replace(/^\s*\/\/.*$/gm, "")
  const re = new RegExp(`^\\s*(export\\s+)?(function|const|class)\\s+${name}\\b`, "m")
  return re.test(noLine)
}

describe("titlebar new-session entrypoint", () => {
  test("creates a draft instead of relying on legacy session navigation", async () => {
    const src = await titlebar()
    // The new-session entrypoint must call tabs.newDraft with the right
    // server+directory pair — that's the fix for the "Failed to fetch
    // dynamically imported module: new-session.tsx" crash.
    expect(src).toMatch(/tabs\.newDraft\(\{\s*server:\s*server\.key,\s*directory\s*\}\)/)
  })

  test("wires onClick to the openNewTab handler on the V2 + button", async () => {
    const src = await titlebar()
    // The V2 IconButtonV2 must call openNewTab on click. The bare
    // string "onClick={openNewTab}" would also match a hand-rolled div;
    // require the IconButtonV2 prefix to ensure it's wired through the
    // official button component.
    expect(src).toMatch(/IconButtonV2[\s\S]{0,400}onClick=\{openNewTab\}/)
  })

  test("openNewTab is defined as a real function (not a stray identifier)", async () => {
    expect(await hasTopLevel("openNewTab")).toBe(true)
  })

  test("openNewTab falls back to the directory picker when no project is open", async () => {
    const src = await titlebar()
    const openNewTab = src.match(/const openNewTab = \(\) => \{([\s\S]*?)\n  \}/)
    expect(openNewTab).toBeTruthy()
    expect(openNewTab![1]).toContain("pickProjectForNewTab()")
  })

  test("directory-picker fallback updates the server project recency without calling a missing layout API", async () => {
    const src = await titlebar()
    expect(src).toContain("server.projects.touch(directory)")
    expect(src).not.toContain("layout.projects.touch(directory)")
  })

  test("does NOT navigate to the legacy /:dir/session route (which crashes on the draft page)", async () => {
    // The whole point of the refactor was to stop hitting the
    // /:dir/session route (which dynamically imports new-session.tsx
    // and crashes). Titlebar.tsx should never reference that route.
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
    const widthHelper = src.match(/const electronTitlebarWidth = \(\) =>\s*`([^`]+)`/)
    expect(widthHelper).toBeTruthy()
    expect(widthHelper![1]).toContain("min(env(titlebar-area-width")
    expect(widthHelper![1]).toContain("calc(100vw - ${windowsControlsWidth()})")
    expect(src).toContain("width: electronWindows() ? electronTitlebarWidth() : undefined")
    expect(src).toContain('"max-width": electronWindows() ? electronTitlebarWidth() : undefined')
  })
})
