import { describe, expect, test } from "bun:test"

const helpButton = async () =>
  (await Bun.file(new URL("./help-button.tsx", import.meta.url)).text()).toString()

describe("HelpButton TSX wiring", () => {
  test("uses localized operator help instead of placeholder copy", async () => {
    const src = await helpButton()
    expect(src).toContain("useLanguage")
    expect(src).toContain('language.t("sidebar.help")')
    expect(src).toContain('language.t("common.close")')
    expect(src).toContain('language.t("help.dev.title")')
    expect(src).toContain('language.t("help.dev.body")')
    expect(src).toContain('language.t("help.dev.footer")')
    expect(src).not.toContain("Lorem ipsum")
  })

  test("keeps the help popover bounded and motion-safe", async () => {
    const src = await helpButton()
    expect(src).toContain("w-[min(320px,calc(100vw-2rem))]")
    expect(src).toContain("rounded-lg border border-border-base")
    expect(src).toContain("motion-reduce:transition-none")
  })
})
