/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import { createSignal } from "solid-js"
import { buildSidebarView, sanitizeForSidebar, type SidebarView } from "./sidebar-logic.js"

const sidebar: TuiPlugin = async (api) => {
  const directory = api?.state?.path?.directory
  if (!directory) return

  const { statSync } = await import("node:fs")
  const { join: pathJoin } = await import("node:path")
  const STATE_PATH = pathJoin(directory, ".opencode", ".goal-state.json")

  const [view, setView] = createSignal<SidebarView>(buildSidebarView(directory))
  const t = () => api.theme?.current ?? {
    text: 0xffffff, textMuted: 0x888888,
    success: 0x22cc66, warning: 0xffaa00,
    backgroundPanel: 0x121212,
  }

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
      setView(buildSidebarView(directory))
    })
  }

  const safetyPoll = setInterval(() => {
    if (disposed || pending) return
    try {
      const mtime = String(statSync(STATE_PATH).mtimeMs)
      if (mtime !== lastMtime) {
        lastMtime = mtime
        const fresh = buildSidebarView(directory)
        if (fresh.content !== view().content) setView(fresh)
      }
    } catch { /* missing */ }
  }, 2000)
  safetyPoll.unref?.()

  const { isGoalStatePath } = await import("./tui-logic.js")
  const unsub = api.event.on("file.watcher.updated", (evt) => {
    if (isGoalStatePath(evt.properties.file)) refresh()
  })
  const unsubscribe = typeof unsub === "function" ? unsub : (() => {})

  function renderTitle(props: { title: string }): JSX.Element {
    return (
      <box flexDirection="column">
        <text fg={t().text}><b>{props.title}</b></text>
        <text fg={t().textMuted}>{sanitizeForSidebar(view().title)}</text>
      </box>
    )
  }

  function renderContent(): JSX.Element {
    const v = view()
    const fg = v.isPaused ? t().warning : v.hasGoal ? t().text : t().textMuted
    return (
      <box flexDirection="column" gap={1}>
        {v.content.split("\n").map((line: string) => (
          <text fg={fg}>{line || " "}</text>
        ))}
      </box>
    )
  }

  function renderFooter(): JSX.Element {
    return <text fg={t().textMuted}>{view().footer}</text>
  }

  try {
    api.slots.register({
      slots: {
        sidebar_title: (_ctx, props) => renderTitle(props as { title: string }),
        sidebar_content: () => renderContent(),
        sidebar_footer: () => renderFooter(),
      },
      dispose() {
        disposed = true
        unsubscribe()
        clearInterval(safetyPoll)
      },
    })
  } catch {
    unsubscribe()
    clearInterval(safetyPoll)
    disposed = true
  }
}

const plugin: TuiPluginModule = { id: "opencode-autogoal/sidebar", tui: sidebar }
export default plugin
