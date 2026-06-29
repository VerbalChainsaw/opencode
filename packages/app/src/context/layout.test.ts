import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createSessionKeyReader,
  ensureSessionKey,
  knownProjectDirectoryKeys,
  pruneSessionKeys,
  restorableOpenProjects,
  shouldRestoreOpenProject,
  staleOpenProjectDirectories,
  unconfirmedOpenProjectDirectories,
} from "./layout-helpers"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

describe("layout project restore helpers", () => {
  test("uses the backend project list for known project matching without pruning local-only projects", () => {
    const known = knownProjectDirectoryKeys([
      {
        worktree: "C:\\Repos\\active",
        sandboxes: ["C:\\Repos\\active-workspace"],
      },
    ])

    expect(shouldRestoreOpenProject("C:/Repos/active", known)).toBe(true)
    expect(shouldRestoreOpenProject("C:/Repos/active-workspace", known)).toBe(true)
    expect(shouldRestoreOpenProject("C:/Repos/local-only", known)).toBe(true)
    expect(
      staleOpenProjectDirectories([{ worktree: "C:/Repos/active" }, { worktree: "C:/Repos/local-only" }], known),
    ).toEqual([])
    expect(
      restorableOpenProjects([{ worktree: "C:/Repos/active" }, { worktree: "C:/Repos/local-only" }], known),
    ).toEqual([{ worktree: "C:/Repos/active" }, { worktree: "C:/Repos/local-only" }])
  })

  test("keeps a manually opened project pending until the server reports it", () => {
    const known = knownProjectDirectoryKeys([])
    const pending = new Set(["C:/Repos/new"])

    expect(shouldRestoreOpenProject("C:/Repos/new", known, pending)).toBe(true)
    expect(staleOpenProjectDirectories([{ worktree: "C:/Repos/new" }], known, pending)).toEqual([])
  })

  test("keeps explicitly opened local projects even when backend metadata has not discovered them", () => {
    const known = knownProjectDirectoryKeys([{ worktree: "C:/Repos/known" }])
    const opened = [{ worktree: "C:/Repos/local-only" }]

    expect(shouldRestoreOpenProject("C:/Repos/local-only", known)).toBe(true)
    expect(staleOpenProjectDirectories(opened, known)).toEqual([])
    expect(restorableOpenProjects(opened, known)).toEqual(opened)
  })

  test("surfaces unconfirmed local-only projects for existence validation", () => {
    const known = knownProjectDirectoryKeys([{ worktree: "C:/Repos/known" }])
    const pending = new Set(["C:/Repos/pending"])

    expect(
      unconfirmedOpenProjectDirectories(
        [{ worktree: "C:/Repos/known" }, { worktree: "C:/Repos/local-only" }, { worktree: "C:/Repos/pending" }],
        known,
        pending,
      ),
    ).toEqual(["C:/Repos/local-only"])
  })
})
