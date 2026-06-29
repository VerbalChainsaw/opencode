import { describe, expect, test } from "bun:test"
import { promptActionTabIndex, promptPlaceholder } from "./placeholder"

describe("promptPlaceholder", () => {
  const t = (key: string, params?: Record<string, string>) => `${key}${params?.example ? `:${params.example}` : ""}`

  test("returns shell placeholder in shell mode", () => {
    const value = promptPlaceholder({
      mode: "shell",
      commentCount: 0,
      example: "example",
      suggest: true,
      t,
    })
    expect(value).toBe("prompt.placeholder.shell:example")
  })

  test("returns summarize placeholders for comment context", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 1, example: "example", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComment",
    )
    expect(promptPlaceholder({ mode: "normal", commentCount: 2, example: "example", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComments",
    )
  })

  test("returns default placeholder with example when suggestions enabled", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      example: "translated-example",
      suggest: true,
      t,
    })
    expect(value).toBe("prompt.placeholder.normal:translated-example")
  })

  test("returns simple placeholder when suggestions disabled", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      example: "translated-example",
      suggest: false,
      t,
    })
    expect(value).toBe("prompt.placeholder.simple")
  })

  test("returns design placeholder for redesigned composer surfaces", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      example: "translated-example",
      suggest: true,
      surface: "design",
      t,
    })
    expect(value).toBe("prompt.placeholder.design")
  })

  test("keeps comment-specific guidance ahead of design placeholder", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 1,
      example: "translated-example",
      suggest: true,
      surface: "design",
      t,
    })
    expect(value).toBe("prompt.placeholder.summarizeComment")
  })
})

describe("promptActionTabIndex", () => {
  test("hides shell-incompatible controls from the tab order in shell mode", () => {
    expect(promptActionTabIndex({ mode: "shell", hiddenInShell: true })).toBe(-1)
    expect(promptActionTabIndex({ mode: "normal", hiddenInShell: true })).toBeUndefined()
  })

  test("keeps shared actions tabbable in shell mode", () => {
    expect(promptActionTabIndex({ mode: "shell" })).toBeUndefined()
  })
})
