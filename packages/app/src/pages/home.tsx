import type { Session } from "@opencode-ai/sdk/v2/client"
import { batch, createEffect, createMemo, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { Logo } from "@opencode-ai/ui/logo"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { getProjectAvatarVariant, useLayout, type LocalProject } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Icon } from "@opencode-ai/ui/icon"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDirectoryPicker } from "@/components/directory-picker"
import { DialogSelectServer, useServerManagementController } from "@/components/dialog-select-server"
import { DialogServerV2 } from "@/components/settings-v2/dialog-server-v2"
import { ServerConnection, useServer } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import {
  closeHomeProject,
  displayName,
  getProjectAvatarSource,
  homeProjectDirectories,
  homeProjectNavigation,
  type HomeProjectSelection,
  projectForSession,
  sortedRootSessions,
} from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { useGlobal } from "@/context/global"
import { useCommand } from "@/context/command"
import { useSettings } from "@/context/settings"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { type ServerHealth } from "@/utils/server-health"
import { readGoalFromSdk, type GoalSdkClient } from "@/pages/session/goal-panel-pure"
import {
  buildHomeAttentionRecords,
  buildHomeGoalAttentionRecords,
  buildHomeGoalRecords,
  findHomeProjectByDirectory,
  groupSessions,
  isHomeSessionLive,
  mergeHomeAttentionRecords,
  resolveHomeServerProjects,
  type HomeAttentionRecord,
  type HomeGoalRecord,
  type HomeSessionGroup,
  type HomeSessionRecord,
} from "./home-pure"
import "./home.css"

const HOME_SESSION_LIMIT = 64
const HOME_ROW_LAYOUT =
  "group flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[var(--radius-md)] bg-transparent text-left transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-[140ms] ease-out focus-visible:outline-none"
const HOME_ROW_BASE = `${HOME_ROW_LAYOUT} border-0`
const HOME_ROW = `${HOME_ROW_BASE} border border-transparent px-3 text-[13px] tracking-[0.01em] [font-weight:530] text-[color:var(--text-muted)] hover:border-[color:var(--border-subtle)] hover:[background:var(--bg-panel-hover)] hover:text-[color:var(--text-primary)] focus-visible:border-[color:var(--border-medium)] focus-visible:[background:var(--bg-panel-hover)] focus-visible:text-[color:var(--text-primary)]`
const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW_LAYOUT} h-8 gap-2 border border-transparent px-2.5 [font-weight:500] text-[color:var(--text-muted)] hover:border-[color:var(--border-subtle)] hover:[background:var(--bg-panel-hover)] hover:text-[color:var(--text-primary)] data-[selected]:border-[color:var(--border-medium)] data-[selected]:[background:var(--bg-panel-elevated)] data-[selected]:text-[color:var(--text-primary)] focus-visible:border-[color:var(--border-medium)] focus-visible:[background:var(--bg-panel-hover)] focus-visible:text-[color:var(--text-primary)] focus-visible:outline-none`
const HOME_SECTION_LABEL = "text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-secondary)] [font-weight:620]"
const HOME_PANEL =
  "relative overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--border-subtle)] [background:var(--bg-panel)] shadow-[var(--shadow-soft)] backdrop-blur-[18px]"
const HOME_PANEL_GLOW =
  "pointer-events-none absolute inset-0 opacity-85 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),transparent_24%),radial-gradient(circle_at_top_right,rgba(111,124,255,0.16),transparent_34%)]"

const HOME_SESSION_SEARCH_RESULTS_ID = "home-session-search-results"
const HOME_SEARCH_RESULT_ROW =
  "flex h-12 w-full shrink-0 cursor-default items-center gap-3 rounded-[var(--radius-md)] border border-transparent py-3 pl-4 pr-5 text-left transition-[background-color,border-color,color,transform] duration-[140ms] ease-out hover:border-[color:var(--border-subtle)] hover:[background:var(--bg-panel-hover)] hover:text-[color:var(--text-primary)] focus-visible:border-[color:var(--border-medium)] focus-visible:[background:var(--bg-panel-hover)] focus-visible:outline-none"
const HOME_SEARCH_RESULT_TITLE =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[0.01em] text-[color:var(--text-primary)] [font-weight:540]"
const HOME_SEARCH_RESULT_META =
  "min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[0.01em] text-[color:var(--text-muted)] [font-weight:450]"

let pendingHomeNavigation: { server: ServerConnection.Key; href: string } | undefined

function buildHomeSessionRecords(input: {
  sync: Pick<ReturnType<typeof useServerSync>, "child">
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}) {
  return [
    ...new Map(
      input
        .projectDirectories()
        .flatMap((directory) => sortedRootSessions(input.sync.child(directory, { bootstrap: false })[0], Date.now()))
        .map((session) => [`${pathKey(session.directory)}:${session.id}`, session] as const),
    ).values(),
  ]
    .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
    .flatMap((session) => {
      const project = projectForSession(session, input.projects(), input.projectByID())
      if (!project) return []
      return {
        session,
        project,
        projectName: displayName(project),
      }
    })
}

function matchesHomeSessionSearch(record: HomeSessionRecord, query: string) {
  return `${record.session.title} ${record.projectName}`.toLowerCase().includes(query)
}

function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

export default function Home() {
  const settings = useSettings()
  return (
    <Show when={settings.general.newLayoutDesigns()} fallback={<LegacyHome />}>
      <HomeDesign />
    </Show>
  )
}

function HomeDesign() {
  const sync = useServerSync()
  const layout = useLayout()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const tabs = useTabs()
  const language = useLanguage()
  const global = useGlobal()
  const command = useCommand()
  const notification = useNotification()
  const permission = usePermission()
  let focusSessionSearch: (() => void) | undefined
  const [state, setState] = createStore({
    search: "",
    selection: { server: server.key } as HomeProjectSelection,
    searchFocused: false,
  })

  const focusedServer = createMemo(
    () => global.servers.list().find((conn) => ServerConnection.key(conn) === state.selection.server) ?? server.current,
  )
  const focusedServerCtx = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return
    return global.createServerCtx(conn)
  })
  const focusedSync = () => focusedServerCtx()?.sync ?? sync
  const openedProjects = createMemo(() => focusedServerCtx()?.projects.list() ?? layout.projects.list())
  const projects = createMemo(() => resolveHomeServerProjects(openedProjects(), focusedSync().data.project))
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === state.selection.directory))
  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )
  const directories = (project: LocalProject) => [project.worktree, ...(project.sandboxes ?? [])]
  const projectDirectories = createMemo(() => {
    const project = selectedProject()
    if (!project) return projects().flatMap(directories)
    return directories(project)
  })
  const search = createMemo(() => state.search.trim())
  const sessionLoad = useQuery(() => ({
    queryKey: ["home", "sessions", state.selection.server, ...projectDirectories()] as const,
    queryFn: async () => {
      await Promise.all(
        projectDirectories().map((directory) =>
          focusedSync().project.loadSessions(directory, { limit: HOME_SESSION_LIMIT }),
        ),
      )
      return null
    },
  }))
  const goalLoad = useQuery(() => ({
    queryKey: ["home", "goals", state.selection.server, ...projectDirectories()] as const,
    queryFn: async () => {
      const ctx = focusedServerCtx()
      if (!ctx) return { goals: [], attention: [] }
      const goalReadCache = new Map<string, ReturnType<typeof readGoalFromSdk>>()
      const readGoal = (directory: string) => {
        const cached = goalReadCache.get(directory)
        if (cached) return cached
        const client = ctx.sdk.createClient({ directory, throwOnError: true })
        const next = readGoalFromSdk({ client: { file: client.file } } satisfies GoalSdkClient)
        goalReadCache.set(directory, next)
        return next
      }
      const goalInput = {
        projectDirectories: projectDirectories(),
        projects: projects(),
        readGoal,
      }
      const [goals, attention] = await Promise.all([
        buildHomeGoalRecords(goalInput),
        buildHomeGoalAttentionRecords({ ...goalInput, now: Date.now(), stalledAfterMinutes: 10 }),
      ])
      return { goals, attention }
    },
  }))

  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sync: focusedSync(),
      projectDirectories,
      projects,
      projectByID,
    }),
  )
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const searchResults = createMemo(() => {
    const query = search().toLowerCase()
    if (!query) return []
    return allRecords().filter((record) => matchesHomeSessionSearch(record, query))
  })
  const searchOpen = createMemo(() => state.searchFocused && search().length > 0)
  const selectedProjectName = createMemo(() => {
    const project = selectedProject()
    return project ? displayName(project) : undefined
  })
  const sessionBoardTitle = createMemo(() => {
    const project = selectedProjectName()
    return project ? language.t("home.sessions.projectBoard", { project }) : language.t("home.sessions.liveBoard")
  })
  const groups = createMemo(() => groupSessions(records(), language, selectedProjectName()))
  const liveSessionCount = createMemo(() =>
    allRecords().filter((record) =>
      isHomeSessionLive({
        record,
        sync: focusedSync(),
        permission,
      }),
    ).length,
  )
  const activeGoalRecords = createMemo(() => goalLoad.data?.goals ?? [])
  const activeGoalCount = createMemo(() => activeGoalRecords().length)
  const goalAttentionRecords = createMemo(() => goalLoad.data?.attention ?? [])
  const attentionRecords = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return []
    return mergeHomeAttentionRecords(
      buildHomeAttentionRecords({
        records: allRecords(),
        projects: projects(),
        directories,
        sync: focusedSync(),
        permission,
        notification,
        notificationActive: ServerConnection.key(conn) === server.key,
      }),
      goalAttentionRecords(),
    )
  })
  const attentionCount = createMemo(() => attentionRecords().length)
  const attentionLoading = createMemo(
    () => (sessionLoad.isLoading && sessionLoad.data === undefined) || (goalLoad.isLoading && goalLoad.data === undefined),
  )
  const liveSessionDetail = createMemo(() =>
    liveSessionCount() > 0 ? language.t("home.metrics.liveSessions.detail") : language.t("home.metrics.liveSessions.detail.idle"),
  )
  const activeGoalDetail = createMemo(() =>
    activeGoalCount() > 0 ? language.t("home.metrics.activeGoals.detail") : language.t("home.metrics.activeGoals.detail.idle"),
  )
  const attentionDetail = createMemo(() =>
    attentionCount() > 0 ? language.t("home.metrics.needsAttention.detail") : language.t("home.metrics.needsAttention.detail.clear"),
  )
  const latestRecord = createMemo(() => records()[0])

  function setSelection(next: HomeProjectSelection) {
    batch(() => {
      if (state.selection.server !== next.server) setState("selection", "server", next.server)
      if (state.selection.directory !== next.directory) setState("selection", "directory", next.directory)
    })
  }

  function closeSearch() {
    setState("search", "")
    setState("searchFocused", false)
  }

  function selectSearchSession(session: Session) {
    openSession(session)
    closeSearch()
  }

  command.register("home", () => [
    {
      id: "home.sessions.search.focus",
      title: language.t("home.sessions.search.placeholder"),
      keybind: "mod+f",
      hidden: true,
      onSelect: () => focusSessionSearch?.(),
    },
  ])

  createEffect(() => {
    const list = global.servers.list()
    if (list.some((conn) => ServerConnection.key(conn) === state.selection.server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  createEffect(() => {
    const pending = pendingHomeNavigation
    if (!pending || pending.server !== server.key) return
    pendingHomeNavigation = undefined
    navigate(pending.href)
  })

  function focusServer(conn: ServerConnection.Any) {
    setSelection({ server: ServerConnection.key(conn) })
  }

  function selectProject(conn: ServerConnection.Any, directory: string) {
    const key = ServerConnection.key(conn)
    const ctx = global.createServerCtx(conn)
    const project = findHomeProjectByDirectory(
      resolveHomeServerProjects(ctx.projects.list(), ctx.sync.data.project),
      directory,
    )
    if (!project) return
    ctx.projects.open(project.worktree)
    ctx.projects.touch(project.worktree)
    setSelection({ server: key, directory: project.worktree })
  }

  function addProjects(conn: ServerConnection.Any, directories: string[]) {
    const directory = directories[0]
    if (!directory) return
    const ctx = global.createServerCtx(conn)
    directories.forEach(ctx.projects.open)
    ctx.projects.touch(directory)
    setSelection({ server: ServerConnection.key(conn), directory })
  }

  function openNewSession() {
    const conn = focusedServer()
    const project = newSessionProject()
    if (!conn) return
    if (!project) {
      void chooseProject(conn)
      return
    }
    openProjectNewSession(conn, project.worktree)
  }

  // Dialog launchers. Each pushes onto the global dialog stack via the
  // standard Kobalte-backed <Dialog> shell, so we get focus trap, esc to
  // close, click-outside, scroll lock, and ARIA roles for free.
  // Snapshots the relevant data at click-time so the dialog stays correct
  // even if the underlying store changes while it's open.
  function openProjectsDialog() {
    const conn = focusedServer()
    if (!conn) return
    const snapshot = projects()
    dialog.show(() => (
      <Dialog title={`${language.t("home.projects")} · ${snapshot.length}`}>
        <ProjectsDialogBody
          projects={snapshot}
          language={language}
          onSelect={(directory) => {
            selectProject(conn, directory)
            dialog.close()
          }}
          onNewSession={(directory) => {
            openProjectNewSession(conn, directory)
            dialog.close()
          }}
        />
      </Dialog>
    ))
  }

  function openGoalsDialog() {
    const snapshot = activeGoalRecords()
    dialog.show(() => (
      <Dialog title={language.t("home.metrics.activeGoals")}>
        <GoalsDialogBody
          records={snapshot}
          language={language}
          onSelect={(goal) => {
            openGoalRecord(goal)
            dialog.close()
          }}
        />
      </Dialog>
    ))
  }

  function openAttentionDialog() {
    const conn = focusedServer()
    if (!conn) return
    const snapshot = attentionRecords()
    dialog.show(() => (
      <Dialog title={language.t("home.attention.title")}>
        <AttentionDialogBody
          records={snapshot}
          language={language}
          onClear={(record) => clearAttentionRecord(record)}
          onOpen={(record) => {
            openAttentionRecord(record)
            dialog.close()
          }}
        />
      </Dialog>
    ))
  }

  function navigateOnServer(conn: ServerConnection.Any, href: string) {
    const next = homeProjectNavigation(server.key, ServerConnection.key(conn), href)
    if (!next.server) {
      navigate(next.href)
      return
    }
    pendingHomeNavigation = next
    server.setActive(next.server)
  }

  function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    const ctx = global.createServerCtx(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    // Open a draft tab and route to /new-session?draftId=… — the same flow the titlebar "+"
    // button uses — instead of the legacy /:dir/session route. That route only reaches the
    // draft page via a fragile SessionRoute redirect effect, which throws "Failed to fetch
    // dynamically imported module: new-session.tsx". The draft route (ResolvedDraftRoute)
    // activates the target server itself when conn differs from the active one.
    tabs.newDraft({ server: ServerConnection.key(conn), directory })
  }

  function editProject(conn: ServerConnection.Any, project: LocalProject) {
    void import("@/components/dialog-edit-project").then((x) => {
      dialog.show(() => <x.DialogEditProject server={conn} project={project} />)
    })
  }

  function unseenCount(conn: ServerConnection.Any, project: LocalProject) {
    if (ServerConnection.key(conn) !== server.key) return 0
    return directories(project).reduce((total, directory) => total + notification.project.unseenCount(directory), 0)
  }

  function clearNotifications(conn: ServerConnection.Any, project: LocalProject) {
    if (ServerConnection.key(conn) !== server.key) return
    directories(project)
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))
  }

  function clearAttentionRecord(record: HomeAttentionRecord) {
    const conn = focusedServer()
    if (!conn || ServerConnection.key(conn) !== server.key) return false
    if (record.session) {
      notification.session.markViewed(record.session.id)
      return true
    }
    const directoriesToClear = directories(record.project)
      .filter((directory) => notification.project.unseenCount(directory) > 0)
    if (directoriesToClear.length === 0) return false
    directoriesToClear.forEach((directory) => notification.project.markViewed(directory))
    return true
  }

  function openAttentionRecord(record: HomeAttentionRecord) {
    const conn = focusedServer()
    if (!conn) return
    if (record.session) {
      openSession(record.session)
      return
    }
    selectProject(conn, record.directory)
  }

  function openGoalRecord(record: HomeGoalRecord) {
    const conn = focusedServer()
    if (!conn) return
    const loadedSession = record.sessionID
      ? records().find((item) => item.session.id === record.sessionID)?.session
      : undefined
    if (loadedSession) {
      openSession(loadedSession)
      return
    }
    if (record.sessionID) {
      const ctx = global.createServerCtx(conn)
      ctx.projects.open(record.project.worktree)
      ctx.projects.touch(record.project.worktree)
      navigateOnServer(conn, `/${base64Encode(record.directory)}/session/${record.sessionID}`)
      return
    }
    const session = records().find((item) => pathKey(item.session.directory) === pathKey(record.directory))?.session
    if (session) {
      openSession(session)
      return
    }
    selectProject(conn, record.directory)
  }

  function openSession(session: Session) {
    const project = projectForSession(session, projects(), projectByID())
    const conn = focusedServer()
    if (!conn) return
    const directory = project?.worktree ?? session.directory
    const ctx = global.createServerCtx(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    navigateOnServer(conn, `/${base64Encode(session.directory)}/session/${session.id}`)
  }

  function chooseProject(conn: ServerConnection.Any) {
    function resolve(result: string | string[] | null) {
      addProjects(conn, homeProjectDirectories(result))
    }

    const server = global.createServerCtx(conn)

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  function openSettings() {
    void import("@/components/settings-v2")
      .then((x) => {
        dialog.show(() => <x.DialogSettings />)
      })
      .catch((error) => {
        // A failed dynamic import (chunk load error) must not leave the
        // Settings button looking dead. Surface it instead of swallowing.
        console.error("[home] failed to open settings:", error)
        dialog.show(() => (
          <Dialog title={language.t("sidebar.settings")}>
            <div class="px-4 py-3 text-[13px] leading-5 text-v2-text-text-muted">
              {language.t("home.settings.loadFailed")}
            </div>
          </Dialog>
        ))
      })
  }

  function openHelp() {
    platform.openLink("https://opencode.ai/desktop-feedback")
  }

  function focusSessionSearchControl() {
    setState("searchFocused", true)
    queueMicrotask(() => focusSessionSearch?.())
  }

  function openLatestSession() {
    const record = latestRecord()
    if (!record) return
    openSession(record.session)
  }

  return (
    <div
      data-component="home-shell"
      class="relative isolate m-1.5 flex-1 self-stretch overflow-hidden rounded-[var(--radius-xl)] border border-[color:var(--border-subtle)] [background:var(--bg-shell)] shadow-[var(--shadow-soft)]"
    >
      <div
        aria-hidden
        class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(110,92,255,0.16),transparent_32%),radial-gradient(circle_at_90%_10%,rgba(255,176,88,0.08),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.03),transparent_22%)]"
      />
      <div
        aria-hidden
        class="pointer-events-none absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.88),transparent_82%)]"
      />
      <div class="relative mx-auto grid h-full w-full max-w-[1360px] gap-4 px-5 pb-7 pt-2 md:px-6 lg:grid-cols-[252px_minmax(0,1fr)] xl:px-7">
        <HomeProjectColumn
          projects={projects()}
          selected={state.selection}
          focusServer={focusServer}
          selectProject={selectProject}
          openNewSession={openProjectNewSession}
          chooseProject={(conn) => void chooseProject(conn)}
          editProject={editProject}
          closeProject={(conn, directory) => {
            const next = closeHomeProject(
              state.selection,
              ServerConnection.key(conn),
              global.createServerCtx(conn).projects,
              directory,
            )
            if (next) setSelection(next)
          }}
          clearNotifications={clearNotifications}
          unseenCount={unseenCount}
          language={language}
        />

        <section class="min-h-0 min-w-0 flex-1 flex flex-col pt-6 lg:pt-8" aria-label={sessionBoardTitle()}>
          <div class="flex min-h-0 flex-1 flex-col gap-4 pb-6">
            <div data-component="home-brand-strip" class={HOME_PANEL}>
              <div
                aria-hidden
                class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(110,92,255,0.18),transparent_34%),linear-gradient(135deg,rgba(94,106,210,0.14),transparent_48%),linear-gradient(180deg,rgba(255,255,255,0.045),transparent_44%)]"
              />
              <div aria-hidden class="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.32),transparent)]" />
              <div class="relative flex min-w-0 flex-col gap-4 px-5 py-4 md:px-6 md:py-5">
                <div class="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                  <div class="flex min-w-0 items-start gap-3">
                    <div class="min-w-0">
                      <Logo class="h-6 w-[134px] opacity-95" />
                      <div class={`${HOME_SECTION_LABEL} mt-2.5`}>{language.t("home.header.kicker")}</div>
                      <h1 class="mt-2 truncate text-[24px] leading-7 tracking-[-0.05em] text-[color:var(--text-primary)] [font-weight:610] md:text-[28px] md:leading-8">
                        {language.t("app.name.desktop")}
                      </h1>
                      <p class="mt-2 max-w-[520px] text-[13px] leading-5 text-[color:var(--text-muted)]">
                        {language.t("home.header.subtitle")}
                      </p>
                    </div>
                  </div>
                  <div class="flex min-w-0 flex-wrap items-center gap-2 xl:max-w-[560px] xl:justify-end">
                    <div class="flex min-w-0 flex-wrap items-center gap-2">
                      <ButtonV2
                        data-action="home-primary-new-session"
                        variant="contrast"
                        size="large"
                        icon="plus"
                        class="[font-weight:550]"
                        onClick={openNewSession}
                      >
                        {language.t("home.actions.newSession")}
                      </ButtonV2>
                      <ButtonV2
                        data-action="home-primary-open-project"
                        variant="neutral"
                        size="large"
                        icon="folder-add-left"
                        class="[font-weight:540]"
                        disabled={!focusedServer()}
                        onClick={() => focusedServer() && chooseProject(focusedServer()!)}
                      >
                        {language.t("home.actions.openProject")}
                      </ButtonV2>
                    </div>
                    <div class="flex items-center gap-1 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] [background:var(--bg-panel-elevated)] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                      <ButtonV2
                        data-action="home-header-settings"
                        variant="ghost-muted"
                        size="normal"
                        icon="settings-gear"
                        class="px-3"
                        onClick={openSettings}
                      >
                        {language.t("home.actions.settings")}
                      </ButtonV2>
                      <IconButtonV2
                        data-action="home-header-help"
                        variant="ghost-muted"
                        size="large"
                        icon={<IconV2 name="help" />}
                        onClick={openHelp}
                        aria-label={language.t("sidebar.help")}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div data-component="home-metric-strip" class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
              {/* v0.7.3 / audit June 2026: pass `loading` to each metric
                  card so the count stabilizes while the underlying
                  data source is still in transit. Without this, the
                  strip flickers "3 → 7 → 4" during boot, which the
                  user reads as "different number of projects every
                  time I open the app". The `loading` flag flips to
                  false once the source has settled on a stable value.
              */}
              <HomeMetricCard
                label={language.t("home.projects")}
                value={String(projects().length)}
                loading={focusedSync().data === undefined}
                detail={language.t("home.metrics.projects.detail")}
                icon="folder-add-left"
                disabled={projects().length === 0 || focusedSync().data === undefined}
                onClick={() => openProjectsDialog()}
              />
              <HomeMetricCard
                label={language.t("home.metrics.liveSessions")}
                value={String(liveSessionCount())}
                loading={sessionLoad.isLoading && sessionLoad.data === undefined}
                detail={liveSessionDetail()}
                icon="status-active"
                disabled={liveSessionCount() === 0 || (sessionLoad.isLoading && sessionLoad.data === undefined)}
                onClick={focusSessionSearchControl}
              />
              <HomeMetricCard
                label={language.t("home.metrics.activeGoals")}
                value={String(activeGoalCount())}
                loading={goalLoad.isLoading && goalLoad.data === undefined}
                detail={activeGoalDetail()}
                icon="status"
                disabled={goalLoad.isLoading && goalLoad.data === undefined}
                onClick={() => openGoalsDialog()}
              />
              <HomeMetricCard
                label={language.t("home.metrics.needsAttention")}
                value={String(attentionCount())}
                loading={attentionLoading()}
                detail={attentionDetail()}
                icon="help"
                tone="warning"
                disabled={attentionCount() === 0 || attentionLoading()}
                onClick={() => openAttentionDialog()}
              />
            </div>

            <div class="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_224px]">
              <section
                data-component="home-live-board"
                class={`${HOME_PANEL} flex min-h-[300px] min-w-0 flex-col px-3.5 pb-3.5 pt-3.5 xl:min-h-0`}
              >
                <div aria-hidden class={HOME_PANEL_GLOW} />
                <div aria-hidden class="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.28),transparent)]" />
                <div class="mb-2.5 flex items-center justify-between gap-2.5 px-1">
                  <div class="min-w-0">
                    <div class="truncate text-[15px] leading-5 text-[color:var(--text-primary)] [font-weight:560]">
                      {sessionBoardTitle()}
                    </div>
                    <Show when={selectedProjectName()}>
                      {(project) => (
                        <div class="mt-0.5 truncate text-[11px] leading-4 text-[color:var(--text-muted)]">
                          {language.t("home.sessions.projectScope", { project: project() })}
                        </div>
                      )}
                    </Show>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <Show when={selectedProject()}>
                      <button
                        type="button"
                        class="rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] [background:var(--bg-panel-elevated)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--text-muted)] transition-[background-color,border-color,color,transform] duration-[140ms] ease-out hover:border-[color:var(--border-medium)] hover:[background:var(--bg-panel-hover)] hover:text-[color:var(--text-primary)] hover:-translate-y-px focus-visible:border-[color:var(--border-medium)] focus-visible:[background:var(--bg-panel-hover)] focus-visible:outline-none focus-visible:text-[color:var(--text-primary)] focus-visible:-translate-y-px"
                        onClick={() => setSelection({ server: state.selection.server })}
                      >
                        {language.t("home.sessions.showAllProjects")}
                      </button>
                    </Show>
                    <Show when={latestRecord()}>
                      <button
                        type="button"
                        class="rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] [background:var(--bg-panel-elevated)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--text-muted)] transition-[background-color,border-color,color,transform] duration-[140ms] ease-out hover:border-[color:var(--border-medium)] hover:[background:var(--bg-panel-hover)] hover:text-[color:var(--text-primary)] hover:-translate-y-px focus-visible:border-[color:var(--border-medium)] focus-visible:[background:var(--bg-panel-hover)] focus-visible:outline-none focus-visible:text-[color:var(--text-primary)] focus-visible:-translate-y-px"
                        onClick={openLatestSession}
                      >
                        {language.t("home.actions.resumeLast")}
                      </button>
                    </Show>
                  </div>
                </div>
                <HomeSessionSearch
                  value={state.search}
                  placeholder={language.t("home.sessions.search.placeholder")}
                  open={searchOpen()}
                  loading={sessionLoad.isLoading}
                  results={searchResults()}
                  server={state.selection.server}
                  activeServer={state.selection.server === server.key}
                  noResultsLabel={language.t("home.sessions.search.noResults", { query: search() })}
                  bindFocus={(focus) => {
                    focusSessionSearch = focus
                  }}
                  onInput={(value) => setState("search", value)}
                  onFocus={() => setState("searchFocused", true)}
                  onClose={closeSearch}
                  onSelect={selectSearchSession}
                />
                <ScrollView data-component="home-live-board-scroll" class="mt-2.5 min-h-0 flex-1 overflow-hidden">
                  <div class="flex flex-col gap-2.5 pb-1 pt-1">
                    <Show
                      when={!sessionLoad.isLoading}
                      fallback={<HomeSessionSkeleton label={language.t("common.loading")} />}
                    >
                      <Show
                        when={groups().length > 0}
                        fallback={
                          <div class="flex min-w-0 flex-col gap-2.5">
                            <HomeSessionGroupHeader
                              title={language.t("home.sessions.empty")}
                              onNewSession={newSessionProject() ? openNewSession : undefined}
                            />
                          </div>
                        }
                      >
                        <For each={groups()}>
                          {(group, index) => (
                            <div class="flex min-w-0 flex-col gap-2">
                              <HomeSessionGroupHeader
                                title={group.title}
                                onNewSession={index() === 0 && newSessionProject() ? openNewSession : undefined}
                              />
                              <div class="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] [background:var(--bg-panel-elevated)] divide-y divide-white/5">
                                <For each={group.sessions}>
                                  {(record) => (
                                    <HomeSessionRow
                                      record={record}
                                      server={state.selection.server}
                                      activeServer={state.selection.server === server.key}
                                      openSession={openSession}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                </ScrollView>
              </section>

              <aside data-component="home-command-rail" class="flex min-h-0 flex-col">
                <section data-component="home-attention-panel" class={`${HOME_PANEL} flex min-h-0 flex-col p-3`}>
                  <div aria-hidden class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,191,90,0.16),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent_24%)]" />
                  <div class="relative flex min-h-0 flex-1 flex-col">
                    <div class="min-w-0">
                      <div class="min-w-0">
                        <div class="flex min-w-0 items-center gap-2">
                          <span class="h-2 w-2 shrink-0 rounded-full bg-amber-300 shadow-[0_0_12px_rgba(255,191,90,0.32)]" aria-hidden />
                          <span class={HOME_SECTION_LABEL}>{language.t("home.attention.title")}</span>
                        </div>
                        <div class="mt-1 text-[12px] leading-5 text-[color:var(--text-primary)] [font-weight:540]">
                          {language.t("home.attention.subtitle")}
                        </div>
                      </div>
                    </div>
                    <div class="mt-2.5 h-px bg-white/6" />
                    <Show
                      when={attentionRecords().length > 0}
                      fallback={<p class="mt-2.5 text-[11px] leading-5 text-[color:var(--text-muted)]">{language.t("home.attention.empty")}</p>}
                    >
                      <div class="mt-2.5 min-h-0 flex-1 overflow-hidden">
                        <ul class="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] [background:var(--bg-panel-elevated)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] divide-y divide-white/5">
                          <For each={attentionRecords().slice(0, 4)}>
                            {(record) => (
                              <li>
                                <div class="flex min-w-0 items-stretch gap-2.5 px-3 py-2.5">
                                  <button
                                    type="button"
                                    class="flex min-w-0 flex-1 items-start gap-2.5 rounded-[var(--radius-sm)] border border-transparent px-0 text-left transition-[background-color,border-color,color,transform] duration-[140ms] ease-out hover:-translate-y-px hover:border-amber-300/18 hover:text-[color:var(--text-primary)] focus-visible:-translate-y-px focus-visible:border-amber-300/24 focus-visible:outline-none"
                                    onClick={() => openAttentionRecord(record)}
                                  >
                                    <span class="mt-1 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-amber-300/16 bg-amber-300/10 text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" aria-hidden>
                                      <IconV2 name="help" size="small" />
                                    </span>
                                    <span class="min-w-0 flex-1">
                                      <span class="block whitespace-normal break-words text-[12px] leading-5 text-[color:var(--text-primary)] [font-weight:560]">
                                        {record.session ? sessionTitle(record.session.title) || record.session.id : record.projectName}
                                      </span>
                                      <span class="mt-1 block text-[10px] uppercase tracking-[0.14em] text-amber-100 [font-weight:620]">
                                        {record.reason}
                                      </span>
                                      <Show when={record.detail}>
                                        <span class="mt-1 block whitespace-normal break-words text-[11px] leading-5 text-[color:var(--text-muted)]">{record.detail}</span>
                                      </Show>
                                      <span class="mt-1.5 block whitespace-normal break-words text-[11px] text-[color:var(--text-muted)]">{record.projectName}</span>
                                    </span>
                                  </button>
                                  <Show when={record.clearable}>
                                    <button
                                      type="button"
                                      class="shrink-0 self-start rounded-[var(--radius-sm)] border border-transparent px-2 py-1 text-[10px] text-[color:var(--text-muted)] transition-[background-color,border-color,color,transform] duration-[140ms] ease-out hover:-translate-y-px hover:border-amber-300/24 hover:bg-black/15 hover:text-[color:var(--text-primary)] focus-visible:-translate-y-px focus-visible:border-amber-300/24 focus-visible:bg-black/20 focus-visible:outline-none"
                                      onClick={() => clearAttentionRecord(record)}
                                      aria-label={language.t("home.attention.clear", { reason: record.reason })}
                                    >
                                      {language.t("home.attention.clear.short")}
                                    </button>
                                  </Show>
                                </div>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    </Show>
                  </div>
                </section>
              </aside>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function HomeMetricCard(props: {
  label: string
  value: string
  detail: string
  icon: Parameters<typeof IconV2>[0]["name"]
  tone?: "warning" | "default"
  onClick?: () => void
  disabled?: boolean
  /**
   * v0.7.3 / audit June 2026: when the underlying data source is
   * still loading, show a stable skeleton ("—") instead of the
   * live count. The live count flickers as the opencode server
   * discovers projects incrementally and as the goal/attention
   * query resolves asynchronously. A stable skeleton prevents
   * the metric strip from showing "3 → 7 → 4" during boot, which
   * the user reads as "different number of projects every time I
   * open the app". Once the data settles, `value` is shown.
   */
  loading?: boolean
}) {
  const isInteractive = () => !!props.onClick && !props.disabled
  const displayValue = () => (props.loading ? "—" : props.value)
  return (
    <button
      type="button"
      data-component="home-metric-card"
      data-tone={props.tone ?? "default"}
      class="group relative flex min-h-[88px] w-full flex-col items-stretch overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--border-subtle)] [background:var(--bg-panel)] px-3.5 py-3 text-left shadow-[var(--shadow-soft)] transition-[background-color,border-color,box-shadow,transform,opacity] duration-[140ms] ease-out disabled:cursor-default disabled:opacity-80"
      classList={{
        "hover:-translate-y-px hover:border-[color:var(--border-medium)] hover:[background:var(--bg-panel-hover)] hover:shadow-[0_28px_64px_rgba(0,0,0,0.30),inset_0_1px_0_rgba(255,255,255,0.05)] focus-visible:-translate-y-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-medium)]":
          isInteractive(),
      }}
      onClick={() => isInteractive() && props.onClick?.()}
      disabled={!isInteractive() || props.loading}
      aria-label={`${props.label}: ${displayValue()}. ${props.detail}`}
    >
      <div
        aria-hidden
        class="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.32),transparent)]"
      />
      <div aria-hidden data-slot="home-metric-glow" class="pointer-events-none absolute inset-0" />
      <div class="relative z-10 flex min-w-0 items-center justify-between gap-2.5">
        <span class="flex min-w-0 items-center gap-2">
          <span
            class="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] [background:var(--bg-panel-elevated)] text-[color:var(--text-secondary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
            classList={{
              "text-[color:var(--accent-warning)]": props.tone === "warning",
              "text-[color:var(--accent-secondary)]": props.tone !== "warning",
            }}
            aria-hidden
          >
            <IconV2 name={props.icon} size="small" />
          </span>
          <span class="min-w-0 truncate text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-secondary)] [font-weight:620]">
            {props.label}
          </span>
        </span>
        <Show when={isInteractive()}>
          <span class="shrink-0 text-[11px] text-[color:var(--text-muted)] transition-colors group-hover:text-[color:var(--text-primary)]" aria-hidden>
            ↗
          </span>
        </Show>
      </div>
      <div class="relative z-10 mt-3 flex min-w-0 items-end justify-between gap-3">
        <div
          class="text-[30px] leading-none tracking-[-0.06em] text-[color:var(--text-primary)] [font-weight:620] tabular-nums"
          data-loading={props.loading ? "true" : undefined}
          aria-busy={props.loading ? "true" : undefined}
        >
          {displayValue()}
        </div>
        <p class="min-w-0 max-w-[58%] text-right text-[10px] leading-4 text-[color:var(--text-muted)] [font-weight:500]">
          {props.detail}
        </p>
      </div>
    </button>
  )
}

function ProjectsDialogBody(props: {
  projects: LocalProject[]
  language: ReturnType<typeof useLanguage>
  onSelect: (directory: string) => void
  onNewSession: (directory: string) => void
}) {
  return (
    <div class="flex flex-col gap-1 p-1">
      <ul class="flex flex-col gap-1">
        <For each={props.projects}>
          {(project) => (
            <li>
              <div class="flex items-stretch gap-1">
                <button
                  type="button"
                  class="flex flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-v2-text-text-base transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                  onClick={() => props.onSelect(project.worktree)}
                >
                  <span class="h-1.5 w-1.5 rounded-full bg-icon-success-base shrink-0" aria-hidden />
                  <span class="min-w-0 flex-1 truncate">{displayName(project)}</span>
                  <span class="shrink-0 text-[11px] text-v2-text-text-weaker">{props.language.t("common.open")}</span>
                </button>
                <button
                  type="button"
                  class="flex items-center gap-1 rounded-md border border-v2-border-border-muted px-2 py-1 text-[12px] text-v2-text-text-muted transition-colors hover:border-border-strong hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
                  onClick={() => props.onNewSession(project.worktree)}
                  aria-label={props.language.t("home.project.newSessionIn", { project: displayName(project) })}
                >
                  +
                </button>
              </div>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

function GoalsDialogBody(props: {
  records: HomeGoalRecord[]
  language: ReturnType<typeof useLanguage>
  onSelect: (goal: HomeGoalRecord) => void
}) {
  return (
    <div class="flex flex-col gap-1 p-1">
      <Show
        when={props.records.length > 0}
        fallback={
          <div class="px-2 py-6 text-center text-v2-text-text-muted text-13-regular">
            {props.language.t("home.goals.empty")}
          </div>
        }
      >
        <ul class="flex flex-col gap-1">
          <For each={props.records}>
            {(record) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                  onClick={() => props.onSelect(record)}
                >
                  <span class="mt-1.5 h-1.5 w-1.5 rounded-full bg-sky-400 shrink-0" aria-hidden />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-v2-text-text-base [font-weight:530]">
                      {record.condition || record.id}
                    </div>
                    <div class="mt-0.5 truncate text-[12px] text-v2-text-text-weaker">
                      {record.projectName} · {record.status}
                    </div>
                  </div>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

function AttentionDialogBody(props: {
  records: HomeAttentionRecord[]
  language: ReturnType<typeof useLanguage>
  onClear: (record: HomeAttentionRecord) => boolean
  onOpen: (record: HomeAttentionRecord) => void
}) {
  const [state, setState] = createStore({ records: props.records })
  createEffect(() => setState("records", props.records))

  function clearRecord(record: HomeAttentionRecord) {
    if (!props.onClear(record)) return
    setState("records", (current) => current.filter((item) => item.id !== record.id))
  }

  return (
    <div class="flex flex-col gap-1 p-1">
      <Show
        when={state.records.length > 0}
        fallback={
          <div class="px-2 py-6 text-center text-v2-text-text-muted text-13-regular">
            {props.language.t("home.attention.empty")}
          </div>
        }
      >
        <ul class="flex flex-col gap-1">
          <For each={state.records}>
            {(record) => (
              <li>
                <div class="flex items-stretch gap-1">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                    onClick={() => props.onOpen(record)}
                  >
                    <span class="mt-1.5 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-v2-text-text-base [font-weight:530]">
                        {record.session ? sessionTitle(record.session.title) || record.session.id : record.projectName}
                      </span>
                      <span class="mt-0.5 block truncate text-[12px] text-v2-text-text-muted">
                        {record.reason}
                        <Show when={record.detail}> · {record.detail}</Show>
                      </span>
                      <span class="mt-0.5 block truncate text-[11px] text-v2-text-text-weaker">
                        {record.projectName}
                      </span>
                    </span>
                  </button>
                  <Show when={record.clearable}>
                    <button
                      type="button"
                      class="flex items-center gap-1 rounded-md border border-v2-border-border-muted px-2 py-1 text-[12px] text-v2-text-text-muted transition-colors hover:border-border-strong hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
                      onClick={() => clearRecord(record)}
                      aria-label={props.language.t("home.attention.clear", { reason: record.reason })}
                    >
                      {props.language.t("home.attention.clear.short")}
                    </button>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

function HomeProjectColumn(props: {
  projects: LocalProject[]
  selected: HomeProjectSelection
  focusServer: (server: ServerConnection.Any) => void
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  chooseProject: (server: ServerConnection.Any) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  unseenCount: (server: ServerConnection.Any, project: LocalProject) => number
  language: ReturnType<typeof useLanguage>
}) {
  const global = useGlobal()
  const dialog = useDialog()
  const controller = useServerManagementController({ navigateOnAdd: false })
  return (
    <aside class="flex min-h-0 min-w-0 flex-col pb-5 pt-5 lg:pt-7" aria-label={props.language.t("home.projects")}>
      <nav
        data-component="home-project-tree"
        class={`${HOME_PANEL} flex min-h-0 flex-1 min-w-0 flex-col gap-1.5 p-2`}
      >
        <div aria-hidden class={HOME_PANEL_GLOW} />
        <div aria-hidden class="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.28),transparent)]" />
        <div class="flex h-7 min-w-0 items-center justify-between px-1">
          <div class={HOME_SECTION_LABEL}>{props.language.t("home.projects")}</div>
          <div class="flex items-center gap-1.5">
            <span class="rounded-[999px] border border-[color:var(--border-subtle)] [background:var(--bg-panel-elevated)] px-2 py-0.5 text-[10px] tabular-nums text-[color:var(--text-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              {props.projects.length}
            </span>
            <Show when={global.servers.list().length === 1}>
              <IconButtonV2
                data-action="home-add-project"
                variant="ghost-muted"
                size="large"
                class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
                icon={<IconV2 name="folder-add-left" />}
                onClick={() => props.chooseProject(global.servers.list()[0]!)}
                aria-label={props.language.t("home.project.add")}
              />
            </Show>
          </div>
        </div>
        <Show
          when={global.servers.list().length > 1}
          fallback={
            <div class="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <HomeProjectList {...props} server={global.servers.list()[0]!} />
            </div>
          }
        >
          <For each={global.servers.list()}>
            {(item) => {
              const key = ServerConnection.key(item)
              const healthy = () => !!global.servers.health[key]?.healthy
              const serverCtx = global.createServerCtx(item)
              const serverProjects = () => resolveHomeServerProjects(serverCtx.projects.list(), serverCtx.sync.data.project)
              return (
                <div class="flex min-h-0 flex-1 min-w-0 flex-col gap-1.5 overflow-y-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <HomeServerRow
                    server={item}
                    selected={props.selected.server === key && !props.selected.directory}
                    healthy={healthy()}
                    health={global.servers.health[key]}
                    controller={controller}
                    focusServer={props.focusServer}
                    chooseProject={props.chooseProject}
                    openEdit={(server) => dialog.show(() => <DialogServerV2 mode="edit" server={server} />)}
                    language={props.language}
                  />
                  <Show when={healthy()}>
                    <div class="mx-2 h-px bg-white/6" />
                    <HomeProjectList {...props} server={item} projects={serverProjects()} />
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
      </nav>
    </aside>
  )
}

function HomeServerRow(props: {
  server: ServerConnection.Any
  selected: boolean
  healthy: boolean
  health: ServerHealth | undefined
  controller: ReturnType<typeof useServerManagementController>
  focusServer: (server: ServerConnection.Any) => void
  chooseProject: (server: ServerConnection.Any) => void
  openEdit: (server: ServerConnection.Http) => void
  language: ReturnType<typeof useLanguage>
}) {
  const [state, setState] = createStore({ menuOpen: false })
  return (
    <div class="group/server relative flex h-8 min-w-0 items-center rounded-[var(--radius-md)]">
      <button
        type="button"
        class={`${HOME_PROJECT_NAV_ROW} pr-16 disabled:opacity-60`}
        data-selected={props.selected ? "" : undefined}
        disabled={!props.healthy}
        onClick={() => props.focusServer(props.server)}
      >
        <div class="flex size-4 shrink-0 items-center justify-center">
          <ServerHealthIndicator health={props.health} />
        </div>
        <span class="flex min-w-0 items-center gap-1.5">
          <span class={HOME_PROJECT_NAV_LABEL}>{props.server.displayName ?? new URL(props.server.http.url).host}</span>
          <Show when={props.server.label}>
            {(label) => (
              <span class="shrink-0 rounded-[999px] border border-[color:var(--border-subtle)] px-1.5 py-0.5 text-[9px] leading-none text-[color:var(--text-muted)]">
                {label()}
              </span>
            )}
          </Show>
        </span>
      </button>
      <div
        class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/server:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={state.menuOpen}
      >
        <ServerRowMenu
          server={props.server}
          controller={props.controller}
          onEdit={props.openEdit}
          open={state.menuOpen}
          onOpenChange={(open) => setState("menuOpen", open)}
        />
        <IconButtonV2
          data-action="home-add-project"
          variant="ghost-muted"
          size="small"
          icon={<IconV2 name="folder-add-left" />}
          aria-label={props.language.t("home.project.add")}
          onClick={() => props.chooseProject(props.server)}
        />
      </div>
    </div>
  )
}

function HomeProjectList(props: {
  server: ServerConnection.Any
  projects: LocalProject[]
  selected: HomeProjectSelection
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  unseenCount: (server: ServerConnection.Any, project: LocalProject) => number
  language: ReturnType<typeof useLanguage>
}) {
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <For each={props.projects}>
        {(project) => (
          <HomeProjectRow
            project={project}
            server={props.server}
            selected={
              props.selected.server === ServerConnection.key(props.server) &&
              props.selected.directory === project.worktree
            }
            unseenCount={props.unseenCount(props.server, project)}
            selectProject={props.selectProject}
            openNewSession={props.openNewSession}
            editProject={props.editProject}
            closeProject={props.closeProject}
            clearNotifications={props.clearNotifications}
            language={props.language}
          />
        )}
      </For>
    </div>
  )
}

function HomeProjectRow(props: {
  project: LocalProject
  server: ServerConnection.Any
  selected: boolean
  unseenCount: number
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  language: ReturnType<typeof useLanguage>
}) {
  const [state, setState] = createStore({ menuOpen: false })
  return (
    <div class="group/project relative flex h-9 min-w-0 items-center rounded-[var(--radius-md)]">
      <button
        type="button"
        data-component="home-project-row"
        class={`${HOME_PROJECT_NAV_ROW} pr-16`}
        data-selected={props.selected ? "" : undefined}
        aria-current={props.selected ? "page" : undefined}
        onClick={() => props.selectProject(props.server, props.project.worktree)}
      >
        <HomeProjectAvatar project={props.project} />
        <span class={HOME_PROJECT_NAV_LABEL}>{displayName(props.project)}</span>
        <Show when={props.unseenCount > 0}>
          <span class="shrink-0 rounded-[999px] border border-amber-300/18 bg-amber-300/10 px-2 py-0.5 text-[10px] tabular-nums text-amber-100">
            {props.unseenCount}
          </span>
        </Show>
      </button>
      <div
        class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover/project:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={state.menuOpen}
      >
        <IconButtonV2
          data-action="home-project-new-session"
          variant="ghost-muted"
          size="large"
          icon={<IconV2 name="edit" />}
          aria-label={props.language.t("command.session.new")}
          onClick={() => props.openNewSession(props.server, props.project.worktree)}
        />
        <MenuV2
          gutter={4}
          modal={false}
          placement="bottom-end"
          open={state.menuOpen}
          onOpenChange={(open) => setState("menuOpen", open)}
        >
          <MenuV2.Trigger
            as={IconButtonV2}
            data-action="home-project-menu"
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="outline-dots" />}
            aria-label={props.language.t("common.moreOptions")}
          />
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item onSelect={() => props.openNewSession(props.server, props.project.worktree)}>
                {props.language.t("command.session.new")}
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => props.editProject(props.server, props.project)}>
                {props.language.t("common.edit")}
              </MenuV2.Item>
              <MenuV2.Item
                disabled={props.unseenCount === 0}
                onSelect={() => props.clearNotifications(props.server, props.project)}
              >
                {props.language.t("sidebar.project.clearNotifications")}
              </MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => props.closeProject(props.server, props.project.worktree)}>
                {props.language.t("common.close")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>
    </div>
  )
}

function HomeProjectAvatar(props: { project: LocalProject }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <ProjectAvatar
      fallback={name()}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={getProjectAvatarVariant(props.project.icon?.color)}
    />
  )
}

function HomeSessionAvatar(props: { project: LocalProject; session: Session; activeServer: boolean }) {
  const directory = () => props.session.directory
  const sessionId = () => props.session.id
  const state = useSessionTabAvatarState(directory, sessionId, () => props.activeServer)
  return (
    <ProjectAvatar
      fallback={displayName(props.project)}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={getProjectAvatarVariant(props.project.icon?.color)}
      unread={state.unread()}
      loading={state.loading()}
    />
  )
}

function HomeSessionLeading(props: {
  project: LocalProject
  session: Session
  server: ServerConnection.Key
  activeServer: boolean
}) {
  const tabs = useTabs()
  const hasOpenTab = createMemo(() => sessionHasOpenTab(tabs.store, props.server, props.session))
  return (
    <div class="relative shrink-0">
      <Show when={hasOpenTab()}>
        <span
          aria-hidden="true"
          class="pointer-events-none absolute top-1/2 h-[7px] w-[3px] -translate-y-1/2 rounded-[2px] bg-v2-background-bg-layer-04"
          style={{ right: "calc(100% + 12px)" }}
        />
      </Show>
      <HomeSessionAvatar project={props.project} session={props.session} activeServer={props.activeServer} />
    </div>
  )
}

function HomeSessionSearch(props: {
  value: string
  placeholder: string
  open: boolean
  loading: boolean
  results: HomeSessionRecord[]
  server: ServerConnection.Key
  activeServer: boolean
  noResultsLabel: string
  bindFocus: (focus: () => void) => void
  onInput: (value: string) => void
  onFocus: () => void
  onClose: () => void
  onSelect: (session: Session) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({ active: "" })
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const focusInput = () => {
    input?.focus()
    props.onFocus()
  }

  onMount(() => {
    props.bindFocus(focusInput)
  })

  const syncActive = (results: HomeSessionRecord[]) => {
    if (results.length === 0) {
      setStore("active", "")
      return
    }
    if (!results.some((record) => homeSessionSearchKey(record) === store.active)) {
      setStore("active", homeSessionSearchKey(results[0]))
    }
  }

  createEffect(() => syncActive(props.results))

  createEffect(
    on(
      () => props.value,
      () => syncActive(props.results),
    ),
  )

  const scrollActiveIntoView = () => {
    const key = store.active
    if (!key || !listRef) return
    const element = listRef.querySelector<HTMLElement>(`[data-key="${key}"]`)
    element?.scrollIntoView({ block: "nearest" })
  }

  const moveActive = (delta: number) => {
    const results = props.results
    if (results.length === 0) return
    const index = results.findIndex((record) => homeSessionSearchKey(record) === store.active)
    const start = index === -1 ? 0 : index
    const next = (start + delta + results.length) % results.length
    setStore("active", homeSessionSearchKey(results[next]))
    scrollActiveIntoView()
  }

  const selectActive = () => {
    const record = props.results.find((item) => homeSessionSearchKey(item) === store.active)
    if (!record) return
    props.onSelect(record.session)
  }

  onCleanup(
    makeEventListener(document, "pointerdown", (event) => {
      if (!props.open) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (root?.contains(target)) return
      props.onClose()
    }),
  )

  return (
    <div class="mx-1 w-auto">
      <div ref={root} data-component="home-session-search" class="relative z-10 w-full">
        <Show when={props.open}>
          <div
            data-component="home-session-search-panel"
            class={`${HOME_PANEL} absolute flex flex-col rounded-[var(--radius-lg)] border-[color:var(--border-medium)] [background:var(--bg-panel-elevated)] shadow-[0_22px_54px_rgba(0,0,0,0.35)]`}
            style={{
              top: "-8px",
              left: "-8px",
              width: "calc(100% + 16px)",
            }}
          >
            <div class="flex flex-col pt-11">
              <div id={HOME_SESSION_SEARCH_RESULTS_ID} role="listbox" class="flex flex-col gap-3 pb-4 pt-4">
                <Show
                  when={!props.loading}
                  fallback={
                    <div class="flex items-center justify-center px-4 py-4 text-[color:var(--text-muted)] [font-weight:440]">
                      <Spinner class="size-4" />
                    </div>
                  }
                >
                  <Show
                    when={props.results.length > 0}
                    fallback={
                      <p class="px-4 text-[13px] leading-5 tracking-[0.01em] text-[color:var(--text-muted)] [font-weight:440]">
                        {props.noResultsLabel}
                      </p>
                    }
                  >
                    <div class="flex flex-col">
                      <p class="px-4 text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-secondary)] [font-weight:620]">
                        {language.t("home.sessions.search.sessions")}
                      </p>
                      <div aria-hidden class="mx-4 mt-3 h-px bg-white/6" />
                      <div
                        ref={listRef}
                        class="mt-3 flex max-h-80 flex-col gap-1 overflow-y-auto px-3 pb-1"
                      >
                        <For each={props.results}>
                          {(record) => (
                            <HomeSessionSearchResultRow
                              record={record}
                              server={props.server}
                              activeServer={props.activeServer}
                              selected={store.active === homeSessionSearchKey(record)}
                              onHighlight={() => setStore("active", homeSessionSearchKey(record))}
                              onSelect={(session) => props.onSelect(session)}
                            />
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Show>
        <label
          class="relative z-20 flex h-12 w-full items-center gap-3 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] [background:var(--bg-panel-elevated)] py-1 pl-3 pr-2 text-[color:var(--text-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-[background-color,border-color,box-shadow] duration-[140ms] ease-out"
          classList={{
            "hover:border-[color:var(--border-medium)] hover:[background:var(--bg-panel-hover)] focus-within:border-[color:var(--border-medium)] focus-within:[background:var(--bg-panel-hover)] focus-within:shadow-[0_0_0_1px_rgba(99,201,255,0.10),0_18px_44px_rgba(0,0,0,0.22)]":
              !props.open,
            "border-[color:var(--border-medium)] [background:var(--bg-panel-hover)] shadow-[0_0_0_1px_rgba(99,201,255,0.12)]": props.open,
          }}
        >
          <span class="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] [background:var(--bg-panel)] text-[color:var(--accent-secondary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <IconV2 name="magnifying-glass" />
          </span>
          <input
            ref={input}
            class="relative z-20 min-w-0 flex-1 border-0 bg-transparent text-[color:var(--text-primary)] outline-0 [font-weight:500] placeholder:text-[color:var(--text-muted)]"
            value={props.value}
            placeholder={props.placeholder}
            aria-label={props.placeholder}
            aria-expanded={props.open}
            aria-controls={HOME_SESSION_SEARCH_RESULTS_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              store.active && props.open ? `home-session-search-option-${store.active}` : undefined
            }
            onFocus={() => props.onFocus()}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                props.onClose()
                input?.blur()
                return
              }
              if (!props.open || props.results.length === 0) return
              if (event.altKey || event.metaKey) return
              if (event.key === "ArrowDown") {
                event.preventDefault()
                moveActive(1)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                moveActive(-1)
                return
              }
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                selectActive()
              }
            }}
          />
          <Show when={props.value}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="relative z-20 shrink-0"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              aria-label={props.placeholder}
              onClick={() => {
                props.onClose()
                input?.focus()
              }}
            />
          </Show>
        </label>
      </div>
    </div>
  )
}

function HomeSessionSearchResultRow(props: {
  record: HomeSessionRecord
  server: ServerConnection.Key
  activeServer: boolean
  selected: boolean
  onHighlight: () => void
  onSelect: (session: Session) => void
}) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)

  const key = () => homeSessionSearchKey(props.record)

  return (
    <button
      type="button"
      id={`home-session-search-option-${key()}`}
      data-key={key()}
      data-component="home-session-search-row"
      role="option"
      aria-selected={props.selected}
      classList={{
        [HOME_SEARCH_RESULT_ROW]: true,
        "border-[color:var(--border-medium)] [background:var(--bg-panel-hover)] text-[color:var(--text-primary)]": props.selected,
      }}
      onMouseEnter={() => props.onHighlight()}
      onClick={() => props.onSelect(props.record.session)}
    >
      <HomeSessionLeading
        project={props.record.project}
        session={props.record.session}
        server={props.server}
        activeServer={props.activeServer}
      />
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span
          class={`${HOME_SEARCH_RESULT_TITLE} ${props.record.projectName ? "max-w-[min(68%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={props.record.projectName}>
          <>
            <span aria-hidden class="h-3.5 w-px shrink-0 bg-white/8" />
            <span class={HOME_SEARCH_RESULT_META}>{props.record.projectName}</span>
          </>
        </Show>
      </div>
    </button>
  )
}

function HomeSessionGroupHeader(props: { title: string; onNewSession?: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex h-7 min-w-0 items-center justify-between px-1">
      <div class={HOME_SECTION_LABEL}>{props.title}</div>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2
            data-action="home-new-session"
            variant="ghost-muted"
            size="normal"
            icon="edit"
            class="h-7 px-2 [font-weight:530]"
            onClick={onNewSession()}
          >
            {language.t("command.session.new")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionRow(props: {
  record: HomeSessionRecord
  server: ServerConnection.Key
  activeServer: boolean
  openSession: (session: Session) => void
}) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)

  return (
    <button
      type="button"
      data-component="home-session-row"
      class={`${HOME_ROW} h-9 gap-2.5 rounded-none bg-transparent px-4 py-2 pl-3.5`}
      onClick={() => props.openSession(props.record.session)}
    >
      <HomeSessionLeading
        project={props.record.project}
        session={props.record.session}
        server={props.server}
        activeServer={props.activeServer}
      />
      <span
        class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-[color:var(--text-primary)] [font-weight:530] ${props.record.projectName ? "max-w-[min(68%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
      >
        {title()}
      </span>
      <Show when={props.record.projectName}>
        <>
          <span aria-hidden class="h-3.5 w-px shrink-0 bg-white/8" />
          <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[color:var(--text-muted)] [font-weight:450]">
            {props.record.projectName}
          </span>
        </>
      </Show>
    </button>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <div class="flex h-7 min-w-0 items-center justify-between px-1">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] [background:var(--bg-panel-elevated)] divide-y divide-white/5" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-9 [background:var(--bg-panel-elevated)] opacity-70" />}</For>
      </div>
    </div>
  )
}

function LegacyHome() {
  const sync = useServerSync()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const navigate = useNavigate()
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const homedir = createMemo(() => sync.data.path.home)
  const currentServerCtx = createMemo(() => {
    const current = server.current
    if (!current) return
    return global.createServerCtx(current)
  })
  const projects = createMemo(() => {
    const ctx = currentServerCtx()
    return resolveHomeServerProjects(ctx?.projects.list() ?? [], ctx?.sync.data.project ?? sync.data.project)
  })
  const projectSync = () => currentServerCtx()?.sync ?? sync

  const serverDotClass = createMemo(() => {
    const healthy = global.servers.health[server.key]?.healthy
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  function openProject(server: ServerConnection.Any, directory: string) {
    const serverCtx = global.createServerCtx(server)
    serverCtx.projects.open(directory)
    serverCtx.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  function chooseProject() {
    const s = server.current
    if (!s) return

    const resolve = (result: string | string[] | null) => {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(s, directory)
        }
      } else if (result) {
        openProject(s, result)
      }
    }

    pickDirectory({
      server: s,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <Logo class="md:w-xl opacity-12" />
      <Button
        size="large"
        variant="ghost"
        class="mt-4 mx-auto text-14-regular text-text-weak"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div
          classList={{
            "size-2 rounded-full": true,
            [serverDotClass()]: true,
          }}
        />
        {server.name}
      </Button>
      <Switch>
        <Match when={projects().length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.projects")}</div>
              <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={projects()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(server.current!, project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <Show when={project.time?.updated ?? project.time?.created}>
                      {(time) => (
                        <div class="text-14-regular text-text-weak">{DateTime.fromMillis(time()).toRelative()}</div>
                      )}
                    </Show>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={!projectSync().ready}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
            <Button class="px-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <Button class="px-3 mt-1" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
