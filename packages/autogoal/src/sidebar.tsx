/** @jsxImportSource @opentui/solid */
/**
 * opencode-autogoal — SIDEBAR plugin (sibling to the dashboard).
 *
 * Renders goal status in the host's right sidebar slot, updating reactively
 * whenever the goal state file changes — same mechanism as the git change
 * panel and the dashboard route. Uses SolidJS `createSignal` + file watcher
 * coalescing (the same pattern as `useGoalState` in tui.tsx).
 *
 * Enable via tui.json:
 *   { "plugin": ["opencode-autogoal/tui", "opencode-autogoal/sidebar"] }
 */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import { createSignal } from "solid-js"

import { buildSidebarView, sanitizeForSidebar, type SidebarView } from "./sidebar-logic.js"

const sidebar: TuiPlugin = async (api) => {
  // Guard: the host MUST provide a workspace directory. If missing (e.g.,
  // loaded in Desktop Electron which doesn't support TUI plugins), fail
  // fast with a visible error rather than a cryptic TypeError chain.
  const directory = api?.state?.path?.directory
  if (!directory) {
    try { console.warn("[autogoal/sidebar] no workspace directory — plugin will not render (loaded outside terminal?)") } catch { /* stderr unavailable */ }
    return
  }

  const { statSync } = await import("node:fs")
  const { join: pathJoin } = await import("node:path")
  const STATE_PATH = pathJoin(directory, ".opencode", ".goal-state.json")

  // Reactive signal — same pattern as useGoalState in tui.tsx.
  // When the goal state file changes, we re-read and update the signal.
  // SolidJS tracks the signal dependency in the slot render functions
  // and re-renders automatically.
  const [view, setView] = createSignal<SidebarView>(buildSidebarView(directory))

  // Coalesce file-watcher events (FIX-20 pattern).
  let pending = false
  let disposed = false
  let lastMtime = ""
  try { lastMtime = String(statSync(STATE_PATH).mtimeMs) } catch { /* missing */ }

  const refresh = () => {
    if (pending || disposed) return
    pending = true
    queueMicrotask(() => {
      pending = false
      if (disposed) return
      const fresh = buildSidebarView(directory)
      setView(fresh)
    })
  }

  // Safety-net poll: mtime-based, only re-reads on actual file change.
  // Avoids the I/O cost of buildSidebarView every 2s. Unref'd so it
  // doesn't block process exit. Guarantees updates even without reactive
  // slot context (belt to the signal's suspenders).
  const safetyPoll = setInterval(() => {
    if (disposed || pending) return
    try {
      const mtime = String(statSync(STATE_PATH).mtimeMs)
      if (mtime !== lastMtime) {
        lastMtime = mtime
        const fresh = buildSidebarView(directory)
        if (fresh.content !== view().content) {
          setView(fresh)
        }
      }
    } catch { /* file missing — keep current view */ }
  }, 2000)
  safetyPoll.unref?.()

  const { isGoalStatePath } = await import("./tui-logic.js")
  const unsub = api.event.on("file.watcher.updated", (evt) => {
    if (isGoalStatePath(evt.properties.file)) refresh()
  })
  const unsubscribe = typeof unsub === "function" ? unsub : (() => {})

  // Safe render wrapper — catches any error in the view-model build or JSX
  // render and returns a visible fallback instead of a black slot.
  function safeRender(fn: () => JSX.Element, fallback: string): JSX.Element {
    try { return fn() } catch (err: unknown) {
      const msg = `[autogoal/sidebar] render error: ${err instanceof Error ? err.message : String(err)}`
      try { console.warn(msg) } catch { /* stderr unavailable */ }
      const bg = api.theme?.current?.backgroundPanel ?? 0x121212
      const fg = api.theme?.current?.textMuted ?? 0x888888
      return <box backgroundColor={bg} padding={1}><text fg={fg}>{fallback}</text></box>
    }
  }

  function renderContent(): JSX.Element {
    return safeRender(() => {
      const v = view()
      const current = api.theme?.current
      const t = () => current ?? { text: 0xffffff, textMuted: 0x888888, success: 0x22cc66, warning: 0xffaa00, backgroundPanel: 0x121212 } as NonNullable<typeof current>

      if (!v.hasGoal) {
        const lines = v.content.split("\n")
        return (
          <box flexDirection="column" gap={1}>
            {lines.map((line: string) => (
              <text fg={t().textMuted}>{line || " "}</text>
            ))}
          </box>
        )
      }
      const lines = v.content.split("\n")
      return (
        <box flexDirection="column" gap={1}>
          {lines.map((line: string, idx: number) => {
            const fg = idx === 0 ? t().success : t().textMuted
            return <text fg={fg}>{line || " "}</text>
          })}
        </box>
      )
    }, "⚠ goal unavailable")
  }

  function renderTitle(props: { title: string }): JSX.Element {
    return safeRender(() => {
      const v = view()
      const current = api.theme?.current
      const t = () => current ?? { text: 0xffffff, textMuted: 0x888888, warning: 0xffaa00 } as NonNullable<typeof current>
      return (
        <box flexDirection="column">
          <text fg={t().text}><b>{props.title}</b></text>
          <text fg={v.isPaused ? t().warning : t().text}>
            {sanitizeForSidebar(v.title) || "🎯 goal"}
          </text>
        </box>
      )
    }, "⚠")
  }

  function renderFooter(_props: object): JSX.Element {
    return safeRender(() => {
      const v = view()
      const current = api.theme?.current
      const t = () => current ?? { textMuted: 0x888888 } as NonNullable<typeof current>
      return <text fg={t().textMuted}>{sanitizeForSidebar(v.footer)}</text>
    }, "")
  }

  // Slot registration. Wrapped in try/catch so a host API version mismatch
  // doesn't crash the entire plugin. Cleanup runs regardless of success.
  try {
    api.slots.register({
      slots: {
        sidebar_title: (_ctx, props) => renderTitle(props as { title: string }),
        sidebar_content: (_ctx, _props) => renderContent(),
        sidebar_footer: (_ctx, _props) => renderFooter(_props),
      },
      dispose() {
        disposed = true
        unsubscribe()
        clearInterval(safetyPoll)
      },
    })
  } catch (err: unknown) {
    try { console.warn(`[autogoal/sidebar] slot registration failed: ${err instanceof Error ? err.message : String(err)}`) } catch { /* stderr unavailable */ }
    // Registration failed — clean up immediately.
    unsubscribe()
    clearInterval(safetyPoll)
    disposed = true
  }
}

const plugin: TuiPluginModule = { id: "opencode-autogoal/sidebar", tui: sidebar }
export default plugin
