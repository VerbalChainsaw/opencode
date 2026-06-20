import { describe, expect, test } from "bun:test"

/**
 * Thin renderer entrypoint smoke.
 * Importing index.tsx directly is not a useful unit test because it depends on
 * Electron preload state plus Vite-only CSS and worker transforms. Real
 * renderer behavior should live in extracted modules such as deep-links.ts.
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

  test("wires the tested desktop deep-link bridge to the preload API", async () => {
    const src = await index()
    expect(src).toContain('import { listenForDesktopDeepLinks } from "./deep-links"')
    expect(src).toContain("listenForDesktopDeepLinks(window.api, window)")
  })
})
