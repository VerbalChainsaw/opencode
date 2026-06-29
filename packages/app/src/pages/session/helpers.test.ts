import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  createOpenReviewFile,
  createOpenSessionFileTab,
  createSessionTabs,
  focusTerminalById,
  getTabReorderIndex,
  goalTabCloseable,
  isSessionInteractiveTarget,
  sessionPanelTabShown,
  shouldAutoOpenGoalTab,
  shouldDefaultOpenGoalTab,
  shouldFocusTerminalOnKeyDown,
  shouldShowFileTree,
  toggleSessionPanelTab,
} from "./helpers"

describe("shouldShowFileTree", () => {
  test("does not reserve space for a disabled v2 file tree", () => {
    expect(shouldShowFileTree({ desktopV2: true, showFileTree: false, opened: true })).toBe(false)
    expect(shouldShowFileTree({ desktopV2: false, showFileTree: false, opened: true })).toBe(true)
    expect(shouldShowFileTree({ desktopV2: true, showFileTree: true, opened: true })).toBe(true)
  })
})

describe("sessionPanelTabShown", () => {
  test("requires the panel to be open and the requested tab to be active", () => {
    expect(
      sessionPanelTabShown({
        panelOpen: true,
        activeTab: "review",
        tab: "review",
      }),
    ).toBe(true)

    expect(
      sessionPanelTabShown({
        panelOpen: true,
        activeTab: "goal",
        tab: "review",
      }),
    ).toBe(false)

    expect(
      sessionPanelTabShown({
        panelOpen: false,
        activeTab: "review",
        tab: "review",
      }),
    ).toBe(false)
  })
})

describe("toggleSessionPanelTab", () => {
  test("closes the panel when the requested tab is already shown", () => {
    const calls: string[] = []

    toggleSessionPanelTab({
      panelOpen: true,
      activeTab: "review",
      tab: "review",
      openTab: (tab) => {
        calls.push(`open-tab:${tab}`)
      },
      setActive: (tab) => calls.push(`set-active:${tab}`),
      openPanel: () => calls.push("open-panel"),
      closePanel: () => calls.push("close-panel"),
    })

    expect(calls).toEqual(["close-panel"])
  })

  test("opens the panel and targets the requested tab when a different tab is showing", () => {
    const calls: string[] = []

    toggleSessionPanelTab({
      panelOpen: true,
      activeTab: "goal",
      tab: "review",
      openTab: (tab) => {
        calls.push(`open-tab:${tab}`)
      },
      setActive: (tab) => calls.push(`set-active:${tab}`),
      openPanel: () => calls.push("open-panel"),
      closePanel: () => calls.push("close-panel"),
    })

    expect(calls).toEqual(["open-tab:review", "set-active:review"])
  })

  test("opens both the tab and panel when the panel is currently closed", () => {
    const calls: string[] = []

    toggleSessionPanelTab({
      panelOpen: false,
      activeTab: undefined,
      tab: "review",
      openTab: (tab) => {
        calls.push(`open-tab:${tab}`)
      },
      setActive: (tab) => calls.push(`set-active:${tab}`),
      openPanel: () => calls.push("open-panel"),
      closePanel: () => calls.push("close-panel"),
    })

    expect(calls).toEqual(["open-tab:review", "set-active:review", "open-panel"])
  })
})

describe("shouldDefaultOpenGoalTab", () => {
  test("AutoGoal is the default landing: opens once per session, even with no goal set", () => {
    // Fresh session → default to AutoGoal (not gated on a goal existing).
    expect(
      shouldDefaultOpenGoalTab({
        sessionKey: "workspace/session-a",
        defaultedSessionKey: null,
      }),
    ).toBe(true)

    // Already defaulted for this session → don't yank the user back if they
    // switched to chat/files.
    expect(
      shouldDefaultOpenGoalTab({
        sessionKey: "workspace/session-a",
        defaultedSessionKey: "workspace/session-a",
      }),
    ).toBe(false)

    // A different session re-defaults to AutoGoal.
    expect(
      shouldDefaultOpenGoalTab({
        sessionKey: "workspace/session-b",
        defaultedSessionKey: "workspace/session-a",
      }),
    ).toBe(true)
  })

  test("does not open when there is no session key", () => {
    expect(
      shouldDefaultOpenGoalTab({
        sessionKey: undefined,
        defaultedSessionKey: null,
      }),
    ).toBe(false)
  })
})

describe("toastOffsetRight", () => {
  test("keeps permission and question toasts clear of the desktop right panel", async () => {
    const helpers = (await import("./helpers")) as unknown as {
      toastOffsetRight?: (input: {
        desktopSidePanelOpen: boolean
        desktopReviewOpen: boolean
        sessionWidth: number
        fileTreeWidth: number
      }) => string
    }

    expect(typeof helpers.toastOffsetRight).toBe("function")
    expect(
      helpers.toastOffsetRight!({
        desktopSidePanelOpen: false,
        desktopReviewOpen: false,
        sessionWidth: 520,
        fileTreeWidth: 320,
      }),
    ).toBe("32px")
    expect(
      helpers.toastOffsetRight!({
        desktopSidePanelOpen: true,
        desktopReviewOpen: true,
        sessionWidth: 520,
        fileTreeWidth: 320,
      }),
    ).toBe("calc(32px + 520px)")
    expect(
      helpers.toastOffsetRight!({
        desktopSidePanelOpen: true,
        desktopReviewOpen: false,
        sessionWidth: 520,
        fileTreeWidth: 320,
      }),
    ).toBe("calc(32px + 320px)")
  })
})

describe("mission-control session shell contracts", () => {
  test("goal tab remains a first-class fixed trigger in the side panel", async () => {
    // The <Tabs.Content value="goal"> must appear in the JSX so the
    // standard Kobalte tab system renders the goal panel. A regression
    // that drops it (or typos the value) would make the tab content
    // never mount, leaving an empty dock surface.
    const source = await Bun.file(new URL("./session-side-panel.tsx", import.meta.url)).text()
    expect(source).toMatch(/<Tabs\.Content\s+[^>]*value="goal"/)
  })

  test("session shell still exposes a visible ResizeHandle for the right panel", async () => {
    // The right-panel resize handle is the user's only way to recover
    // from an over-narrow dock. If the <ResizeHandle> tag is dropped,
    // the user loses the ability to widen the dock at all. Assert the
    // JSX tag is present and that it's wired to onResize (not just
    // a decorative placeholder).
    const source = await Bun.file(new URL("../session.tsx", import.meta.url)).text()
    expect(source).toMatch(/<ResizeHandle[\s\S]*?onResize=/)
  })

  test("session header keeps a dedicated goal toggle in the V2 action rail", async () => {
    // The session header exposes a `goalLabel:` field on the action
    // state and an `aria-label` bound to it. The aria-label is the
    // screen-reader entry point for the goal toggle button — without
    // it, the dock is invisible to assistive tech.
    const source = await Bun.file(
      new URL("../../components/session/session-header.tsx", import.meta.url),
    ).text()
    expect(source).toContain("goalLabel:")
    expect(source).toContain("aria-label={props.state.goalLabel}")
    expect(source).toContain("<span>{props.state.goalLabel}</span>")
    expect(source).toContain('<span class="text-11-medium">{language.t("session.tab.goal")}</span>')
  })

  test("goal toggle closes the side panel when goal tab is already showing", async () => {
    // Regression: clicking the goal tab while the goal dock was already
    // open left the side panel stuck open. The fix is in `toggleGoal`:
    // when goalShown() is true, the handler sets the active tab to
    // "empty" AND closes the review panel. If either step is removed,
    // the dock won't actually collapse.
    const source = await Bun.file(
      new URL("../../components/session/session-header.tsx", import.meta.url),
    ).text()
    // The `if (goalShown())` branch must (a) set the active tab to
    // "empty" to clear the goal content and (b) call reviewPanel.close().
    // Both must be present, in either order.
    const branch = source.match(/if\s*\(goalShown\(\)\)\s*\{([\s\S]*?)\n\s{2}\}/)
    expect(branch).toBeTruthy()
    expect(branch![1]).toContain('setActive("empty")')
    expect(branch![1]).toMatch(/reviewPanel\.close/)
  })

  test("review toggle targets the review tab instead of treating the whole panel as active", async () => {
    const source = await Bun.file(
      new URL("../../components/session/session-header.tsx", import.meta.url),
    ).text()

    expect(source).toContain('tab: "review"')
    expect(source).toContain("reviewOpened: reviewShown()")
    expect(source).toContain("onReviewToggle: toggleReview")
    expect(source).toContain("onClick={toggleReview}")
    expect(source).toContain("aria-expanded={reviewShown()}")
    expect(source).toContain('{reviewShown() ? "review-active" : "review"}')
    expect(source).not.toContain("onClick={() => view().reviewPanel.toggle()}")
    expect(source).not.toContain("reviewOpened: view().reviewPanel.opened()")
    expect(source).not.toContain("onReviewToggle: () => view().reviewPanel.toggle()")
  })

  test("review command palette toggle uses tab-aware panel routing", async () => {
    const source = await Bun.file(new URL("./use-session-commands.tsx", import.meta.url)).text()

    expect(source).toContain("toggleSessionPanelTab")
    expect(source).toContain('tab: "review"')
    expect(source).not.toContain('onSelect: () => view().reviewPanel.toggle()')
  })

  test("global toast regions use the session right-panel offset variable", async () => {
    const localLegacy = await Bun.file(new URL("../../../../ui/src/components/toast.css", import.meta.url)).text()
    const v2 = await Bun.file(new URL("../../../../ui/src/v2/components/toast-v2.css", import.meta.url)).text()

    expect(localLegacy).toContain("var(--oc-toast-region-right, 32px)")
    expect(v2).toContain("var(--oc-toast-region-right, 32px)")
  })

  test("todo dock toggle is a real button instead of a nested fake button plus icon button", async () => {
    const source = await Bun.file(new URL("./composer/session-todo-dock.tsx", import.meta.url)).text()
    expect(source).toMatch(/<button\s+type="button"[\s\S]*data-action="session-todo-toggle"/)
    expect(source).toContain('aria-expanded={!props.collapsed}')
    expect(source).not.toContain('role="button"')
    expect(source).not.toContain("IconButton")
  })
})

describe("shouldAutoOpenGoalTab", () => {
  test("opens for the first visible goal", () => {
    expect(
      shouldAutoOpenGoalTab({
        currentGoalID: "goal-1",
        previousGoalID: null,
        dismissedGoalID: null,
      }),
    ).toBe(true)
  })

  test("does not reopen a manually dismissed goal", () => {
    expect(
      shouldAutoOpenGoalTab({
        currentGoalID: "goal-1",
        previousGoalID: null,
        dismissedGoalID: "goal-1",
      }),
    ).toBe(false)
  })

  test("opens again when a later goal has a different id", () => {
    expect(
      shouldAutoOpenGoalTab({
        currentGoalID: "goal-2",
        previousGoalID: "goal-1",
        dismissedGoalID: "goal-1",
      }),
    ).toBe(true)
  })
})

describe("goalTabCloseable", () => {
  test("a live goal (active/paused) is NOT closeable", () => {
    expect(goalTabCloseable("active")).toBe(false)
    expect(goalTabCloseable("paused")).toBe(false)
  })

  test("terminal / empty / unknown states stay closeable", () => {
    expect(goalTabCloseable("achieved")).toBe(true)
    expect(goalTabCloseable("cleared")).toBe(true)
    expect(goalTabCloseable(undefined)).toBe(true)
  })
})

describe("createOpenReviewFile", () => {
  test("opens and loads selected review file", () => {
    const calls: string[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => calls.push("show"),
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `file://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      loadFile: (path) => calls.push(`load:${path}`),
    })

    openReviewFile("src/a.ts")

    expect(calls).toEqual(["show", "load:src/a.ts", "tab:src/a.ts", "open:file://src/a.ts", "active:file://src/a.ts"])
  })
})

describe("createOpenSessionFileTab", () => {
  test("activates the opened file tab", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return `file://${value}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.slice("file://".length)
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("src/a.ts")

    expect(calls).toEqual([
      "normalize:src/a.ts",
      "open:file://src/a.ts",
      "path:file://src/a.ts",
      "load:src/a.ts",
      "review",
      "active:file://src/a.ts",
    ])
  })
})

describe("focusTerminalById", () => {
  test("focuses textarea when present", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-one"><div data-component="terminal"><textarea></textarea></div></div>`

    const focused = focusTerminalById("one")

    expect(focused).toBe(true)
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
  })

  test("falls back to terminal element focus", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-two"><div data-component="terminal" tabindex="0"></div></div>`
    const terminal = document.querySelector('[data-component="terminal"]') as HTMLElement
    let pointerDown = false
    terminal.addEventListener("pointerdown", () => {
      pointerDown = true
    })

    const focused = focusTerminalById("two")

    expect(focused).toBe(true)
    expect(document.activeElement).toBe(terminal)
    expect(pointerDown).toBe(true)
  })
})

describe("shouldFocusTerminalOnKeyDown", () => {
  test("skips pure modifier keys", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Alt", altKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }))).toBe(false)
  })

  test("skips shortcut key combos", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }))).toBe(false)
  })

  test("keeps plain typing focused on terminal", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "a" }))).toBe(true)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "A", shiftKey: true }))).toBe(true)
  })
})

describe("isSessionInteractiveTarget", () => {
  test("treats custom role buttons as interactive targets", () => {
    document.body.innerHTML = `<div role="button" tabindex="0"><span id="label">Queued messages</span></div>`
    const label = document.getElementById("label")

    expect(isSessionInteractiveTarget(label)).toBe(true)
  })

  test("treats native links and contenteditable surfaces as interactive targets", () => {
    document.body.innerHTML = `<a id="link" href="/docs">Docs</a><div id="editor" contenteditable="true">Edit</div>`
    const link = document.getElementById("link")
    const editor = document.getElementById("editor")

    expect(isSessionInteractiveTarget(link)).toBe(true)
    expect(isSessionInteractiveTarget(editor)).toBe(true)
  })

  test("ignores plain static containers", () => {
    const node = document.createElement("div")

    expect(isSessionInteractiveTarget(node)).toBe(false)
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid drag reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined for unknown droppable id", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })
})

describe("createSessionTabs", () => {
  test("normalizes the effective file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.activeFileTab()).toBe("norm:src/a.ts")
      expect(result.closableTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("prefers context and review fallbacks when no file tab is active", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("context")
      expect(result.closableTab()).toBe("context")
      dispose()
    })

    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("review")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  // F-5: the "goal" tab is a fixed trigger like "context" and "review".
  // It must NOT appear in openedTabs (no normalized file entry, no
  // duplicated path), and activeTab must return "goal" when it's the
  // active tab.
  describe("goal tab (F-5 integration)", () => {
    test('openedTabs excludes "goal" — it is a trigger, not a file tab', () => {
      createRoot((dispose) => {
        const [state] = createStore({
          active: "goal" as string | undefined,
          all: ["goal", "file://src/a.ts", "context", "review"],
        })
        const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
        const result = createSessionTabs({
          tabs,
          pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
          normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
        })
        // "goal" must not appear in openedTabs; only the normalized file
        // tab should be there.
        expect(result.openedTabs()).toEqual(["norm:src/a.ts"])
        dispose()
      })
    })

    test('activeTab returns "goal" when goal is the active tab', () => {
      createRoot((dispose) => {
        const [state] = createStore({
          active: "goal" as string | undefined,
          all: ["goal"],
        })
        const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
        const result = createSessionTabs({
          tabs,
          pathFromTab: () => undefined,
          normalizeTab: (tab) => tab,
        })
        expect(result.activeTab()).toBe("goal")
        dispose()
      })
    })

    test('closableTab does not expose "goal" to the generic close command', () => {
      createRoot((dispose) => {
        const [state] = createStore({
          active: "goal" as string | undefined,
          all: ["goal", "context"],
        })
        const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
        const result = createSessionTabs({
          tabs,
          pathFromTab: () => undefined,
          normalizeTab: (tab) => tab,
        })
        expect(result.activeTab()).toBe("goal")
        expect(result.closableTab()).toBeUndefined()
        dispose()
      })
    })

    test('activeTab returns "goal" when only "goal" is in the tab list', () => {
      // No context, no review, no file. Just goal.
      createRoot((dispose) => {
        const [state] = createStore({
          active: "goal" as string | undefined,
          all: ["goal"],
        })
        const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
        const result = createSessionTabs({
          tabs,
          pathFromTab: () => undefined,
          normalizeTab: (tab) => tab,
        })
        expect(result.activeTab()).toBe("goal")
        expect(result.activeFileTab()).toBeUndefined()
        dispose()
      })
    })
  })
})
