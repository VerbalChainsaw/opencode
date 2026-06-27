import { describe, expect, test } from "bun:test"

const tabsCss = async () => await Bun.file(new URL("./tabs.css", import.meta.url)).text()

describe("tabs CSS contracts", () => {
  test("compact review panel tab buttons keep a 24px interactive floor", async () => {
    const src = await tabsCss()
    const compactReviewBlockStart = src.indexOf('#review-panel &[data-variant="normal"][data-orientation="horizontal"]')
    expect(compactReviewBlockStart).toBeGreaterThan(-1)

    const compactReviewBlock = src.slice(compactReviewBlockStart, src.indexOf('&[data-variant="alt"]', compactReviewBlockStart))
    expect(src).toContain("--tabs-compact-pill-height: 24px")
    expect(compactReviewBlock).toContain("min-height: var(--tabs-compact-pill-height)")
  })
})
