import type { PermissionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
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
import { useNotification, type Notification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import {
  closeHomeProject,
  displayName,
  getProjectAvatarSource,
  homeProjectDirectories,
  homeProjectNavigation,
  mergeHomeProjectLists,
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
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { cleanText, readGoalFromSdk, type GoalSdkClient, type GoalState } from "@/pages/session/goal-panel-pure"

const HOME_SESSION_LIMIT = 64
const HOME_ROW_LAYOUT =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] bg-transparent text-left transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out focus-visible:outline-none"
const HOME_ROW_BASE = `${HOME_ROW_LAYOUT} border-0`
const HOME_ROW = `${HOME_ROW_BASE} [font-weight:530] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover`
const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW_LAYOUT} h-8 gap-2 border border-transparent px-2 [font-weight:440] text-v2-text-text-muted hover:border-v2-border-border-muted hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base data-[selected]:border-v2-border-border-base data-[selected]:border-l-sky-400 data-[selected]:bg-v2-background-bg-layer-02 data-[selected]:text-v2-text-text-base data-[selected]:hover:bg-v2-background-bg-layer-02 focus-visible:border-v2-border-border-base focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:outline-none`
const HOME_SECTION_LABEL = "text-[11px] uppercase tracking-[0.08em] text-v2-text-text-muted [font-weight:530]"

type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

type HomeGoalRecord = {
  id: string
  project: LocalProject
  projectName: string
  directory: string
  status: GoalState["status"]
  condition: string
  updated: number
}

type HomeAttentionKind = "permission" | "question" | "retry" | "error" | "response" | "project"

type HomeAttentionRecord = {
  id: string
  kind: HomeAttentionKind
  project: LocalProject
  projectName: string
  directory: string
  session?: Session
  reason: string
  detail?: string
  count: number
  time: number
  clearable: boolean
}

type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

const HOME_SESSION_SEARCH_RESULTS_ID = "home-session-search-results"
const HOME_SEARCH_RESULT_ROW =
  "flex h-10 w-full shrink-0 cursor-default items-center gap-2 border-0 py-3 pl-4 pr-6 text-left transition-[background-color] duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
const HOME_SEARCH_RESULT_TITLE =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-base [font-weight:530]"
const HOME_SEARCH_RESULT_META =
  "min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]"

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

function homeProjectForDirectory(
  directory: string,
  projects: LocalProject[],
  directories: (project: LocalProject) => string[],
) {
  return projects.find((project) => directories(project).some((candidate) => pathKey(candidate) === pathKey(directory)))
}

async function buildHomeGoalRecords(input: {
  projectDirectories: string[]
  projects: LocalProject[]
  directories: (project: LocalProject) => string[]
  readGoal: (directory: string) => Promise<Awaited<ReturnType<typeof readGoalFromSdk>>>
}) {
  const loaded = await Promise.all(
    input.projectDirectories.map(async (directory): Promise<HomeGoalRecord | null> => {
      const project = homeProjectForDirectory(directory, input.projects, input.directories)
      if (!project) return null

      const store = await input.readGoal(directory)
      if (!store.state) return null
      if (!(store.state.status === "active" || store.state.status === "paused")) return null

      return {
        id: store.state.id,
        project,
        projectName: displayName(project),
        directory,
        status: store.state.status,
        condition: cleanText(store.state.condition),
        updated: store.state.lastEvaluation?.timestamp ?? store.state.startedAt,
      }
    }),
  )

  return loaded
    .filter((record): record is HomeGoalRecord => !!record)
    .sort((a, b) => b.updated - a.updated)
}

function matchesHomeSessionSearch(record: HomeSessionRecord, query: string) {
  return `${record.session.title} ${record.projectName}`.toLowerCase().includes(query)
}

function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

type HomeSyncReader = Pick<ReturnType<typeof useServerSync>, "child">

type HomeNotificationReader = {
  session: Pick<ReturnType<typeof useNotification>["session"], "unseen">
  project: Pick<ReturnType<typeof useNotification>["project"], "unseen">
}

type HomePermissionReader = {
  autoResponds: (item: PermissionRequest, directory: string) => boolean
}

function latestNotificationTime(notifications: Notification[]) {
  return notifications.reduce((latest, notification) => Math.max(latest, notification.time), 0)
}

function notificationErrorDetail(notification: Notification | undefined) {
  if (!notification || notification.type !== "error") return undefined
  const error = notification.error
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error) return String(error.message)
  return "Session error"
}

function isHomeSessionLive(input: {
  record: HomeSessionRecord
  sync: HomeSyncReader
  permission: HomePermissionReader
}) {
  const [store] = input.sync.child(input.record.session.directory, { bootstrap: false })
  if (store.session_working(input.record.session.id)) return true
  if (
    sessionPermissionRequest(store.session, store.permission, input.record.session.id, (item) => {
      return !input.permission.autoResponds(item, input.record.session.directory)
    })
  ) {
    return true
  }
  return !!sessionQuestionRequest(store.session, store.question, input.record.session.id)
}

function homeAttentionPriority(kind: HomeAttentionKind) {
  switch (kind) {
    case "permission":
      return 0
    case "question":
      return 1
    case "retry":
      return 2
    case "error":
      return 3
    case "response":
      return 4
    case "project":
      return 5
  }
}

function buildHomeAttentionRecords(input: {
  records: HomeSessionRecord[]
  projects: LocalProject[]
  directories: (project: LocalProject) => string[]
  sync: HomeSyncReader
  permission: HomePermissionReader
  notification: HomeNotificationReader
  notificationActive: boolean
}) {
  const seenSessions = new Set(input.records.map((record) => record.session.id))
  const sessionRecords = input.records.flatMap((record): HomeAttentionRecord[] => {
    const [store] = input.sync.child(record.session.directory, { bootstrap: false })
    const permissionRequest = sessionPermissionRequest(store.session, store.permission, record.session.id, (item) => {
      return !input.permission.autoResponds(item, record.session.directory)
    })
    const questionRequest = sessionQuestionRequest(store.session, store.question, record.session.id)
    const status = store.session_status[record.session.id] as SessionStatus | undefined
    const unseen = input.notificationActive ? input.notification.session.unseen(record.session.id) : []
    const updated = record.session.time.updated ?? record.session.time.created
    const base = {
      project: record.project,
      projectName: record.projectName,
      directory: record.session.directory,
      session: record.session,
    }

    if (permissionRequest) {
      return [
        {
          ...base,
          id: `permission:${record.session.id}:${permissionRequest.id}`,
          kind: "permission",
          reason: "Permission needed",
          detail: permissionRequest.permission,
          count: 1,
          time: updated,
          clearable: false,
        },
      ]
    }

    if (questionRequest) {
      const question = questionRequest.questions[0]
      return [
        {
          ...base,
          id: `question:${record.session.id}:${questionRequest.id}`,
          kind: "question",
          reason: "Question waiting",
          detail: question?.question ?? question?.header,
          count: questionRequest.questions.length,
          time: updated,
          clearable: false,
        },
      ]
    }

    if (status?.type === "retry") {
      return [
        {
          ...base,
          id: `retry:${record.session.id}:${status.attempt}`,
          kind: "retry",
          reason: "Retrying",
          detail: status.message,
          count: 1,
          time: status.next,
          clearable: false,
        },
      ]
    }

    const error = unseen.findLast((notification) => notification.type === "error")
    if (error) {
      return [
        {
          ...base,
          id: `error:${record.session.id}`,
          kind: "error",
          reason: "Session error",
          detail: notificationErrorDetail(error),
          count: unseen.filter((notification) => notification.type === "error").length,
          time: latestNotificationTime(unseen),
          clearable: true,
        },
      ]
    }

    if (unseen.length > 0) {
      return [
        {
          ...base,
          id: `response:${record.session.id}`,
          kind: "response",
          reason: unseen.length === 1 ? "Response ready" : `${unseen.length} unread updates`,
          count: unseen.length,
          time: latestNotificationTime(unseen),
          clearable: true,
        },
      ]
    }

    return []
  })

  if (!input.notificationActive) return sessionRecords.sort(sortHomeAttentionRecords)

  const orphanProjectRecords = input.projects.flatMap((project): HomeAttentionRecord[] => {
    const unseenByDirectory = input
      .directories(project)
      .map((directory) => {
        const unseen = input.notification.project
          .unseen(directory)
          .filter((notification) => !notification.session || !seenSessions.has(notification.session))
        return { directory, unseen }
      })
      .filter((item) => item.unseen.length > 0)
    const unseen = unseenByDirectory.flatMap((item) => item.unseen)
    if (unseen.length === 0) return []

    const hasError = unseen.some((notification) => notification.type === "error")
    const directoryCount = unseenByDirectory.length
    const detail =
      directoryCount === 1
        ? `${unseen.length} alert${unseen.length === 1 ? "" : "s"}`
        : `${unseen.length} alerts across ${directoryCount} directories`
    return [
      {
        id: `project:${project.id ?? pathKey(project.worktree)}`,
        kind: "project",
        project,
        projectName: displayName(project),
        directory: unseenByDirectory[0]?.directory ?? project.worktree,
        reason: hasError ? "Project error" : unseen.length === 1 ? "Unread project alert" : "Unread project alerts",
        detail,
        count: unseen.length,
        time: latestNotificationTime(unseen),
        clearable: true,
      },
    ]
  })

  return [...sessionRecords, ...orphanProjectRecords].sort(sortHomeAttentionRecords)
}

function sortHomeAttentionRecords(a: HomeAttentionRecord, b: HomeAttentionRecord) {
  return homeAttentionPriority(a.kind) - homeAttentionPriority(b.kind) || b.time - a.time
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
  const projects = createMemo(() => mergeHomeProjectLists(openedProjects(), focusedSync().data.project))
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
      if (!ctx) return []
      return buildHomeGoalRecords({
        projectDirectories: projectDirectories(),
        projects: projects(),
        directories,
        readGoal: async (directory) => {
          const client = ctx.sdk.createClient({ directory, throwOnError: true })
          return readGoalFromSdk({ client: { file: client.file } } satisfies GoalSdkClient)
        },
      })
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
  const activeGoalRecords = createMemo(() => goalLoad.data ?? [])
  const activeGoalCount = createMemo(() => activeGoalRecords().length)
  const attentionRecords = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return []
    return buildHomeAttentionRecords({
      records: allRecords(),
      projects: projects(),
      directories,
      sync: focusedSync(),
      permission,
      notification,
      notificationActive: ServerConnection.key(conn) === server.key,
    })
  })
  const latestRecord = createMemo(() => records()[0])
  const latestGoalRecord = createMemo(() => activeGoalRecords()[0] ?? null)

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
    const project = projects().find((project) => directories(project).some((candidate) => pathKey(candidate) === pathKey(directory)))
    if (!project) return
    const ctx = global.createServerCtx(conn)
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
      <Dialog title={language.t("session.goal.history.title")}>
        <GoalsDialogBody
          records={snapshot}
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
    if (!conn || ServerConnection.key(conn) !== server.key) return
    if (record.session) {
      notification.session.markViewed(record.session.id)
      return
    }
    directories(record.project)
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))
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
    void import("@/components/settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }

  function openHelp() {
    platform.openLink("https://opencode.ai/desktop-feedback")
  }

  return (
    <div class="rounded-[10px] shadow-[var(--v2-elevation-raised)] m-2 min-h-0 lg:overflow-hidden bg-v2-background-bg-base self-stretch flex-1">
      <div class="mx-auto grid w-full h-full max-w-[1160px] gap-6 px-6 pb-12 lg:grid-cols-[280px_minmax(0,1fr)]">
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

        <section class="min-h-0 min-w-0 flex-1 flex flex-col pt-10" aria-label={sessionBoardTitle()}>
          <div class="flex min-h-0 flex-1 flex-col gap-4 pb-8">
            <div data-component="home-brand-strip" class="flex min-w-0 flex-col gap-4">
              <div class="flex min-w-0 flex-col gap-4 border-b border-v2-border-border-base pb-4 xl:flex-row xl:items-end xl:justify-between">
                <div class="flex min-w-0 items-start gap-4">
                  <div class="min-w-0">
                    <Logo class="h-6 w-[134px]" />
                    <div class={HOME_SECTION_LABEL}>{language.t("home.header.kicker")}</div>
                    <h1 class="mt-1 truncate text-[22px] leading-7 text-v2-text-text-base [font-weight:600]">
                      {language.t("app.name.desktop")}
                    </h1>
                    <p class="mt-1 max-w-[620px] text-[13px] leading-5 text-v2-text-text-muted">
                      {language.t("home.header.subtitle")}
                    </p>
                  </div>
                </div>
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <ButtonV2
                    data-action="home-primary-new-session"
                    variant="contrast"
                    size="normal"
                    icon="plus"
                    onClick={openNewSession}
                  >
                    {language.t("home.actions.newSession")}
                  </ButtonV2>
                  <ButtonV2
                    data-action="home-primary-open-project"
                    variant="neutral"
                    size="normal"
                    icon="folder-add-left"
                    disabled={!focusedServer()}
                    onClick={() => focusedServer() && chooseProject(focusedServer()!)}
                  >
                    {language.t("home.actions.openProject")}
                  </ButtonV2>
                  <IconButtonV2
                    data-action="home-header-settings"
                    variant="ghost-muted"
                    size="large"
                    icon={<IconV2 name="settings-gear" />}
                    onClick={openSettings}
                    aria-label={language.t("sidebar.settings")}
                  />
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

            <div data-component="home-metric-strip" class="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <HomeMetricCard
                label={language.t("home.projects")}
                value={String(projects().length)}
                detail={language.t("home.metrics.projects.detail")}
                icon="folder-add-left"
                disabled={projects().length === 0}
                onClick={() => openProjectsDialog()}
              />
              <HomeMetricCard
                label={language.t("home.metrics.liveSessions")}
                value={String(liveSessionCount())}
                detail={language.t("home.metrics.liveSessions.detail")}
                icon="status-active"
                disabled={liveSessionCount() === 0}
                onClick={() => {
                  setState("searchFocused", true)
                  queueMicrotask(() => focusSessionSearch?.())
                }}
              />
              <HomeMetricCard
                label={language.t("home.metrics.activeGoals")}
                value={String(activeGoalCount())}
                detail={language.t("home.metrics.activeGoals.detail")}
                icon="status"
                disabled={activeGoalCount() === 0}
                onClick={() => openGoalsDialog()}
              />
              <HomeMetricCard
                label={language.t("home.metrics.needsAttention")}
                value={String(attentionRecords().length)}
                detail={language.t("home.metrics.needsAttention.detail")}
                icon="help"
                tone="warning"
                disabled={attentionRecords().length === 0}
                onClick={() => openAttentionDialog()}
              />
            </div>

            <div class="grid min-h-0 flex-1 grid-rows-[minmax(240px,1fr)_auto] gap-4 xl:grid-cols-[minmax(0,1fr)_280px] xl:grid-rows-none">
              <section
                data-component="home-live-board"
                class="flex min-h-[240px] min-w-0 flex-col overflow-hidden rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 pb-2 pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] xl:min-h-0"
              >
                <div class="mb-2 flex items-center justify-between gap-3 px-2">
                  <div class="min-w-0">
                    <div class="truncate text-[15px] leading-5 text-v2-text-text-base [font-weight:560]">
                      {sessionBoardTitle()}
                    </div>
                    <Show when={selectedProjectName()}>
                      {(project) => (
                        <div class="mt-0.5 truncate text-[12px] leading-4 text-v2-text-text-weaker">
                          {language.t("home.sessions.projectScope", { project: project() })}
                        </div>
                      )}
                    </Show>
                  </div>
                  <div class="flex shrink-0 items-center gap-3">
                    <Show when={selectedProject()}>
                      <button
                        type="button"
                        class="text-[12px] text-v2-text-text-muted transition-colors hover:text-v2-text-text-base focus-visible:outline-none focus-visible:text-v2-text-text-base"
                        onClick={() => setSelection({ server: state.selection.server })}
                      >
                        {language.t("home.sessions.showAllProjects")}
                      </button>
                    </Show>
                    <Show when={latestRecord()}>
                      <button
                        type="button"
                        class="text-[12px] text-v2-text-text-muted transition-colors hover:text-v2-text-text-base focus-visible:outline-none focus-visible:text-v2-text-text-base"
                        onClick={() => latestRecord() && openSession(latestRecord()!.session)}
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
                <ScrollView data-component="home-live-board-scroll" class="mt-3 min-h-0 flex-1 overflow-hidden">
                  <div class="pt-3 flex flex-col gap-6">
                    <Show
                      when={!sessionLoad.isLoading}
                      fallback={<HomeSessionSkeleton label={language.t("common.loading")} />}
                    >
                      <Show
                        when={groups().length > 0}
                        fallback={
                          <div class="flex min-w-0 flex-col gap-4">
                            <HomeSessionGroupHeader
                              title={language.t("home.sessions.empty")}
                              onNewSession={newSessionProject() ? openNewSession : undefined}
                            />
                          </div>
                        }
                      >
                        <For each={groups()}>
                          {(group, index) => (
                            <div class="flex min-w-0 flex-col gap-4">
                              <HomeSessionGroupHeader
                                title={group.title}
                                onNewSession={index() === 0 && newSessionProject() ? openNewSession : undefined}
                              />
                              <div class="flex min-w-0 flex-col gap-px">
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

              <aside class="flex min-h-0 flex-col gap-4">
                <section class="rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                  <div class="mb-2 text-v2-text-text-muted [font-weight:440]">{language.t("home.actions.title")}</div>
                  <div class="flex flex-col gap-2">
                    <ButtonV2 data-action="home-sidebar-new-session" variant="contrast" size="normal" icon="plus" onClick={openNewSession}>
                      {language.t("home.actions.newSession")}
                    </ButtonV2>
                    <ButtonV2
                      data-action="home-sidebar-resume-last"
                      variant="ghost-muted"
                      size="normal"
                      icon="status-active"
                      disabled={!latestRecord()}
                      onClick={() => latestRecord() && openSession(latestRecord()!.session)}
                    >
                      {language.t("home.actions.resumeLast")}
                    </ButtonV2>
                    <ButtonV2
                      data-action="home-sidebar-open-goal"
                      variant="ghost-muted"
                      size="normal"
                      icon="status"
                      disabled={!latestGoalRecord()}
                      onClick={() => latestGoalRecord() && openGoalRecord(latestGoalRecord()!)}
                    >
                      {language.t("home.actions.openGoal")}
                    </ButtonV2>
                    <ButtonV2
                      data-action="home-sidebar-open-project"
                      variant="ghost-muted"
                      size="normal"
                      icon="folder-add-left"
                      disabled={!focusedServer()}
                      onClick={() => focusedServer() && chooseProject(focusedServer()!)}
                    >
                      {language.t("home.actions.openProject")}
                    </ButtonV2>
                  </div>
                </section>

                <section class="rounded-[10px] border border-amber-500/40 bg-amber-500/8 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                  <div class="mb-2 text-v2-text-text-base [font-weight:530]">{language.t("home.attention.title")}</div>
                  <Show
                    when={attentionRecords().length > 0}
                    fallback={<p class="text-[13px] leading-5 text-v2-text-text-muted">{language.t("home.attention.empty")}</p>}
                  >
                    <ul class="flex flex-col gap-1.5">
                      <For each={attentionRecords().slice(0, 3)}>
                        {(record) => (
                          <li>
                            <div class="flex min-w-0 items-stretch gap-1">
                              <button
                                type="button"
                                class="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                                onClick={() => openAttentionRecord(record)}
                              >
                                <span class="mt-1.5 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden />
                                <span class="min-w-0 flex-1">
                                  <span class="block truncate text-v2-text-text-base [font-weight:530]">
                                    {record.session ? sessionTitle(record.session.title) || record.session.id : record.projectName}
                                  </span>
                                  <span class="block truncate text-[12px] text-v2-text-text-muted">{record.reason}</span>
                                </span>
                              </button>
                              <Show when={record.clearable}>
                                <button
                                  type="button"
                                  class="shrink-0 rounded-md px-1.5 text-[11px] text-v2-text-text-weaker transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
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
                  </Show>
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
}) {
  const isInteractive = () => !!props.onClick && !props.disabled
  return (
    <button
      type="button"
      data-component="home-metric-card"
      class="group flex min-h-[92px] w-full flex-col items-stretch rounded-[10px] border px-3 py-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-[background-color,border-color,box-shadow] disabled:cursor-default disabled:opacity-70"
      classList={{
        "border-v2-border-border-base bg-v2-background-bg-layer-01 hover:border-border-strong hover:bg-v2-background-bg-layer-02 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong":
          props.tone !== "warning" && isInteractive(),
        "border-v2-border-border-base bg-v2-background-bg-layer-01": props.tone !== "warning" && !isInteractive(),
        "border-amber-500/40 bg-amber-500/8 hover:border-amber-400/60 hover:bg-amber-500/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60":
          props.tone === "warning" && isInteractive(),
        "border-amber-500/40 bg-amber-500/8": props.tone === "warning" && !isInteractive(),
      }}
      onClick={() => isInteractive() && props.onClick?.()}
      disabled={!isInteractive()}
      aria-label={`${props.label}: ${props.value}. ${props.detail}`}
    >
      <div class="flex min-w-0 items-center justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1.5">
          <span
            class="flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-v2-border-border-muted text-v2-icon-icon-muted"
            classList={{
              "border-amber-400/30 text-amber-300": props.tone === "warning",
            }}
            aria-hidden
          >
            <IconV2 name={props.icon} size="small" />
          </span>
          <span class="min-w-0 truncate text-[11px] uppercase tracking-[0.08em] text-v2-text-text-muted [font-weight:560]">
            {props.label}
          </span>
        </span>
        <Show when={isInteractive()}>
          <span
            class="shrink-0 text-[13px] text-v2-text-text-weaker transition-colors group-hover:text-v2-text-text-base"
            aria-hidden
          >
            ›
          </span>
        </Show>
      </div>
      <div class="mt-2 flex min-w-0 items-end justify-between gap-2">
        <div class="text-[26px] leading-none text-v2-text-text-base [font-weight:600] tabular-nums">{props.value}</div>
        <p class="min-w-0 flex-1 text-right text-[12px] leading-4 text-v2-text-text-weaker">{props.detail}</p>
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
  onSelect: (goal: HomeGoalRecord) => void
}) {
  return (
    <div class="flex flex-col gap-1 p-1">
      <Show
        when={props.records.length > 0}
        fallback={
          <div class="px-2 py-6 text-center text-v2-text-text-muted text-13-regular">
            No active goals right now.
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
  onClear: (record: HomeAttentionRecord) => void
  onOpen: (record: HomeAttentionRecord) => void
}) {
  return (
    <div class="flex flex-col gap-1 p-1">
      <Show
        when={props.records.length > 0}
        fallback={
          <div class="px-2 py-6 text-center text-v2-text-text-muted text-13-regular">
            {props.language.t("home.attention.empty")}
          </div>
        }
      >
        <ul class="flex flex-col gap-1">
          <For each={props.records}>
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
                      onClick={() => props.onClear(record)}
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
    <aside class="flex min-h-0 min-w-0 flex-col pb-8 pt-10" aria-label={props.language.t("home.projects")}>
      <nav
        data-component="home-project-tree"
        class="flex min-h-0 flex-1 min-w-0 flex-col gap-2 overflow-hidden rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
      >
        <div class="flex h-8 min-w-0 items-center justify-between px-1">
          <div class={HOME_SECTION_LABEL}>{props.language.t("home.projects")}</div>
          <div class="flex items-center gap-1">
            <span class="rounded-[6px] border border-v2-border-border-muted px-1.5 py-0.5 text-[10px] tabular-nums text-v2-text-text-weaker">
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
            <div class="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <HomeProjectList {...props} server={global.servers.list()[0]!} />
            </div>
          }
        >
          <For each={global.servers.list()}>
            {(item) => {
              const key = ServerConnection.key(item)
              const healthy = () => !!global.servers.health[key]?.healthy
              const serverCtx = global.createServerCtx(item)
              return (
                <div class="flex min-h-0 flex-1 min-w-0 flex-col gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                    <div class="mx-3 h-px bg-v2-border-border-base" />
                    <HomeProjectList {...props} server={item} projects={serverCtx.projects.list()} />
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
    <div class="group/server relative flex h-8 min-w-0 items-center rounded-[6px]">
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
        <span class="flex min-w-0 items-center gap-1">
          <span class={HOME_PROJECT_NAV_LABEL}>{props.server.displayName ?? new URL(props.server.http.url).host}</span>
          <Show when={props.server.label}>
            {(label) => (
              <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none text-v2-text-text-muted">
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
    <div class="flex min-w-0 flex-col gap-1.5">
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
    <div class="group/project relative flex h-8 min-w-0 items-center rounded-[6px]">
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
          <span class="shrink-0 rounded-[6px] border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] tabular-nums text-amber-300">
            {props.unseenCount}
          </span>
        </Show>
      </button>
      <div
        class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/project:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={state.menuOpen}
      >
        <IconButtonV2
          data-action="home-project-new-session"
          variant="ghost-muted"
          size="small"
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
            size="small"
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
    <div class="ml-4 mr-2 w-[calc(100%_-_24px)]">
      <div ref={root} data-component="home-session-search" class="relative z-10 w-full">
        <Show when={props.open}>
          <div
            data-component="home-session-search-panel"
            class="absolute flex flex-col rounded-[12px] bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
            style={{
              top: "-6px",
              left: "-6px",
              width: "calc(100% + 14px)",
            }}
          >
            <div class="flex flex-col pt-9">
              <div id={HOME_SESSION_SEARCH_RESULTS_ID} role="listbox" class="flex flex-col gap-4 pt-4 pb-2">
                <Show
                  when={!props.loading}
                  fallback={
                    <div class="flex items-center justify-center px-4 py-3 text-v2-text-text-muted [font-weight:440]">
                      <Spinner class="size-4" />
                    </div>
                  }
                >
                  <Show
                    when={props.results.length > 0}
                    fallback={
                      <p class="my-1.5 px-4 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                        {props.noResultsLabel}
                      </p>
                    }
                  >
                    <div class="flex flex-col">
                      <p class="my-1.5 px-4 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                        {language.t("home.sessions.search.sessions")}
                      </p>
                      <div ref={listRef} class="flex max-h-80 flex-col gap-px overflow-y-auto">
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
          class="relative z-20 flex h-9 w-full items-center gap-2 rounded-[6px] py-1 pl-3 pr-2 text-v2-icon-icon-muted transition-[background-color,box-shadow] duration-[120ms] ease-in-out"
          classList={{
            "bg-v2-background-bg-deep focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_0.5px_var(--v2-border-border-focus),var(--v2-elevation-raised)]":
              !props.open,
            "bg-transparent shadow-[0_0_0_0.5px_var(--v2-border-border-focus)]": props.open,
          }}
        >
          <IconV2 name="magnifying-glass" />
          <input
            ref={input}
            class="relative z-20 min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
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
        "bg-v2-overlay-simple-overlay-hover": props.selected,
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
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          class={`${HOME_SEARCH_RESULT_TITLE} ${props.record.projectName ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={props.record.projectName}>
          <span class={HOME_SEARCH_RESULT_META}>{props.record.projectName}</span>
        </Show>
      </div>
    </button>
  )
}

function HomeSessionGroupHeader(props: { title: string; onNewSession?: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex h-7 min-w-0 items-center justify-between pl-4 pr-2">
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
      class={`${HOME_ROW} h-10 gap-2 px-6 py-3 pl-4`}
      onClick={() => props.openSession(props.record.session)}
    >
      <HomeSessionLeading
        project={props.record.project}
        session={props.record.session}
        server={props.server}
        activeServer={props.activeServer}
      />
      <span
        class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] ${props.record.projectName ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
      >
        {title()}
      </span>
      <Show when={props.record.projectName}>
        <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]">
          {props.record.projectName}
        </span>
      </Show>
    </button>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between px-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}</For>
      </div>
    </div>
  )
}

function groupSessions(
  records: HomeSessionRecord[],
  language: ReturnType<typeof useLanguage>,
  projectName?: string,
): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? projectName
        ? language.t("home.sessions.group.project", { project: projectName })
        : language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")

  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
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
  const recent = createMemo(() => {
    return sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

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
        <Match when={sync.data.project.length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(server.current!, project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <div class="text-14-regular text-text-weak">
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={!sync.ready}>
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
