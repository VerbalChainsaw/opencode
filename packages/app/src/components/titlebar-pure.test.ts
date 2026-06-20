import { describe, expect, test } from "bun:test"
import {
  electronTitlebarWidthCSS,
  readTitlebarDirectoryPickerSelection,
  resolveTitlebarNewSessionDirectory,
  titlebarDraftRequest,
  windowsControlsWidthCSS,
} from "./titlebar-pure"

describe("titlebar pure helpers", () => {
  test("resolves new-session directory from the current route before project fallback", () => {
    expect(
      resolveTitlebarNewSessionDirectory({
        currentDirectory: "C:\\repo\\current",
        projectWorktrees: ["C:\\repo\\fallback"],
      }),
    ).toBe("C:\\repo\\current")

    expect(
      resolveTitlebarNewSessionDirectory({
        currentDirectory: undefined,
        projectWorktrees: ["C:\\repo\\fallback", "C:\\repo\\second"],
      }),
    ).toBe("C:\\repo\\fallback")

    expect(
      resolveTitlebarNewSessionDirectory({
        currentDirectory: "",
        projectWorktrees: [],
      }),
    ).toBeUndefined()
  })

  test("normalizes directory picker results to the directory titlebar can draft", () => {
    expect(readTitlebarDirectoryPickerSelection("C:\\repo\\picked")).toBe("C:\\repo\\picked")
    expect(readTitlebarDirectoryPickerSelection(["C:\\repo\\first", "C:\\repo\\second"])).toBe("C:\\repo\\first")
    expect(readTitlebarDirectoryPickerSelection([])).toBeUndefined()
    expect(readTitlebarDirectoryPickerSelection(null)).toBeUndefined()
    expect(readTitlebarDirectoryPickerSelection("")).toBeUndefined()
  })

  test("builds the draft-tab request without a legacy session route", () => {
    expect(titlebarDraftRequest("server-a", "C:\\repo\\current")).toEqual({
      server: "server-a",
      directory: "C:\\repo\\current",
    })
    expect(Object.keys(titlebarDraftRequest("server-a", "C:\\repo\\current"))).toEqual(["server", "directory"])
  })

  test("calculates Windows control width and Electron titlebar clamp", () => {
    expect(windowsControlsWidthCSS(1)).toBe("138px")
    expect(windowsControlsWidthCSS(2)).toBe("69px")
    expect(windowsControlsWidthCSS(0.5)).toBe("138px")
    expect(electronTitlebarWidthCSS("138px")).toBe(
      "min(env(titlebar-area-width, calc(100vw - 138px)), calc(100vw - 138px))",
    )
  })
})
