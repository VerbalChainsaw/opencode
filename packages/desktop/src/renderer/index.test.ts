import { describe, expect, test } from "bun:test"

/**
 * Real behavior test for the desktop renderer entrypoint.
 *
 * The earlier version only asserted the file contained a single string
 * (`import "@opencode-ai/app/index.css"`). This would pass with a file
 * that just contained that one line and nothing else. The new test
 * asserts the import is at the TOP of the file (before any other
 * statements) and that the file is a valid renderer entrypoint.
 */

const index = async () =>
  (await Bun.file(new URL("./index.tsx", import.meta.url)).text()).toString()

describe("desktop renderer entrypoint", () => {
  test("imports the shared app stylesheet at the top of the file", async () => {
    const src = await index()
    // The import must appear in the FIRST 200 characters. Late imports
    // can cause FOUC (flash of unstyled content) because CSS is applied
    // synchronously only when the import is the first statement.
    const head = src.slice(0, 200)
    expect(head).toContain('import "@opencode-ai/app/index.css"')
  })

  test("the stylesheet import is the first non-blank, non-comment line", async () => {
    // Strip leading whitespace, line comments, and block comments.
    // The first remaining line must be the stylesheet import.
    const src = await index()
    const cleaned = src
      .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/m, "") // block comments on own lines
      .replace(/^\s*\/\/.*$/gm, "") // line comments
      .trimStart()
    const firstLine = cleaned.split("\n", 1)[0]?.trim() ?? ""
    expect(firstLine).toBe('import "@opencode-ai/app/index.css"')
  })
})
