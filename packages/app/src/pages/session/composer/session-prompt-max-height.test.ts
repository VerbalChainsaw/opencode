import { describe, expect, test } from "bun:test"
import { computeDockPromptMaxHeight } from "./session-prompt-max-height"

describe("computeDockPromptMaxHeight", () => {
  test("clamps the prompt height between sticky header and dock footer", () => {
    expect(
      computeDockPromptMaxHeight({
        stickyBottom: 120,
        dockBottom: 840,
        promptBottom: 760,
        minHeight: 220,
      }),
    ).toBe(632)
  })

  test("uses the minimum height when the available space is too small", () => {
    expect(
      computeDockPromptMaxHeight({
        stickyBottom: 300,
        dockBottom: 520,
        promptBottom: 500,
        minHeight: 240,
      }),
    ).toBe(240)
  })
})
