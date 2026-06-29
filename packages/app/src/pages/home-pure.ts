import type { PermissionRequest, QuestionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { displayName, mergeHomeProjectLists } from "@/pages/layout/helpers"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { DEFAULT_STALL_MINUTES, goalIdleMinutes, isGoalStalled } from "@/pages/session/goal-panel-lifecycle"
import { cleanText, type GoalState } from "@/pages/session/goal-panel-pure"
import { pathKey } from "@/utils/path-key"
import { DateTime } from "luxon"

export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export type HomeGoalRecord = {
  id: string
  project: LocalProject
  projectName: string
  directory: string
  sessionID?: string
  status: GoalState["status"]
  condition: string
  updated: number
}

export type HomeAttentionKind =
  | "permission"
  | "question"
  | "goal-limit"
  | "goal-stalled"
  | "retry"
  | "error"
  | "response"
  | "project"

export type HomeAttentionRecord = {
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

export type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

export type HomeSessionStore = {
  session: Session[]
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
  session_status: Record<string, SessionStatus | undefined>
  session_working: (id: string) => boolean
}

export type HomeSyncReader = {
  child: (directory: string, options: { bootstrap: false }) => readonly [HomeSessionStore, ...unknown[]]
}

export type HomePermissionReader = {
  autoResponds: (item: PermissionRequest, directory: string) => boolean
}

export type HomeNotification = {
  type: string
  time: number
  error?: unknown
  session?: string
}

export type HomeNotificationReader = {
  session: { unseen: (sessionID: string) => readonly HomeNotification[] }
  project: { unseen: (directory: string) => readonly HomeNotification[] }
}

export type HomeLanguage = {
  t: (key: string | number, args?: Record<string, string | number | boolean>) => string
}

type HomeProjectEntry = {
  id?: string
  worktree: string
  expanded?: boolean
  sandboxes?: string[]
}

export function resolveHomeServerProjects<TOpened extends HomeProjectEntry, TKnown extends HomeProjectEntry>(
  opened: TOpened[],
  known: TKnown[],
) {
  return mergeHomeProjectLists(opened, known)
}

export function findHomeProjectByDirectory<TProject extends { worktree: string; sandboxes?: string[] }>(
  projects: readonly TProject[],
  directory: string,
) {
  return projects.find((project) =>
    [project.worktree, ...(project.sandboxes ?? [])].some((candidate) => pathKey(candidate) === pathKey(directory)),
  )
}

function homeGoalSessionID(state: GoalState) {
  const raw = state.metadata?.sessionId
  if (typeof raw !== "string") return undefined
  const sessionID = raw.trim()
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionID)) return undefined
  return sessionID
}

export async function buildHomeGoalRecords(input: {
  projectDirectories: string[]
  projects: LocalProject[]
  readGoal: (directory: string) => Promise<{ state: GoalState | null }>
}) {
  const loaded = await Promise.all(
    input.projectDirectories.map(async (directory): Promise<HomeGoalRecord | null> => {
      const project = findHomeProjectByDirectory(input.projects, directory)
      if (!project) return null

      const store = await input.readGoal(directory)
      if (!store.state) return null
      if (!(store.state.status === "active" || store.state.status === "paused")) return null
      const sessionID = homeGoalSessionID(store.state)

      return {
        id: store.state.id,
        project,
        projectName: displayName(project),
        directory,
        ...(sessionID ? { sessionID } : {}),
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

function goalAttentionLimit(state: GoalState) {
  const detail = cleanText(state.lastEvaluation?.reason)
  if (/\bturn limit reached\b/i.test(detail)) {
    return { kind: "goal-limit" as const, reason: "Turn limit hit", detail }
  }
  if (/\btime limit reached\b/i.test(detail)) {
    return { kind: "goal-limit" as const, reason: "Time limit hit", detail }
  }
  if (state.status === "cleared" && state.turnsEvaluated >= state.constraints.maxTurns) {
    return {
      kind: "goal-limit" as const,
      reason: "Turn limit hit",
      detail: `Turn limit reached: ${state.turnsEvaluated}/${state.constraints.maxTurns} turns`,
    }
  }
  return null
}

function goalLastMovement(state: GoalState) {
  return state.lastEvaluation?.timestamp ?? state.startedAt
}

export async function buildHomeGoalAttentionRecords(input: {
  projectDirectories: string[]
  projects: LocalProject[]
  readGoal: (directory: string) => Promise<{ state: GoalState | null }>
  now?: number
  stalledAfterMinutes?: number
}) {
  const now = input.now ?? Date.now()
  const stalledAfterMinutes = input.stalledAfterMinutes ?? DEFAULT_STALL_MINUTES
  const loaded = await Promise.all(
    input.projectDirectories.map(async (directory): Promise<HomeAttentionRecord | null> => {
      const project = findHomeProjectByDirectory(input.projects, directory)
      if (!project) return null

      const store = await input.readGoal(directory)
      const state = store.state
      if (!state) return null

      const limit = goalAttentionLimit(state)
      if (limit) {
        return {
          id: `goal-limit:${state.id}`,
          kind: limit.kind,
          project,
          projectName: displayName(project),
          directory,
          reason: limit.reason,
          detail: limit.detail,
          count: 1,
          time: state.lastEvaluation?.timestamp ?? state.completedAt ?? state.startedAt,
          clearable: false,
        }
      }

      const lastMovement = goalLastMovement(state)
      if (!isGoalStalled(state.status, lastMovement, now, stalledAfterMinutes)) return null
      const idle = goalIdleMinutes(lastMovement, now)
      return {
        id: `goal-stalled:${state.id}`,
        kind: "goal-stalled",
        project,
        projectName: displayName(project),
        directory,
        reason: "Goal stalled",
        detail: `No movement for ${idle} minute${idle === 1 ? "" : "s"}`,
        count: 1,
        time: lastMovement,
        clearable: false,
      }
    }),
  )

  return mergeHomeAttentionRecords(loaded.filter((record): record is HomeAttentionRecord => !!record))
}

function latestNotificationTime(notifications: readonly HomeNotification[]) {
  return notifications.reduce((latest, notification) => Math.max(latest, notification.time), 0)
}

function notificationErrorDetail(notification: HomeNotification | undefined) {
  if (!notification || notification.type !== "error") return undefined
  const error = notification.error
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error) return String(error.message)
  return "Session error"
}

export function isHomeSessionLive(input: {
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

export function homeAttentionPriority(kind: HomeAttentionKind) {
  switch (kind) {
    case "permission":
      return 0
    case "question":
      return 1
    case "goal-limit":
      return 2
    case "goal-stalled":
      return 3
    case "retry":
      return 4
    case "error":
      return 5
    case "response":
      return 6
    case "project":
      return 7
  }
}

export function mergeHomeAttentionRecords(...recordSets: readonly HomeAttentionRecord[][]) {
  return recordSets.flat().sort(sortHomeAttentionRecords)
}

export function buildHomeAttentionRecords(input: {
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
    const status = store.session_status[record.session.id]
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

  return mergeHomeAttentionRecords(sessionRecords, orphanProjectRecords)
}

function sortHomeAttentionRecords(a: HomeAttentionRecord, b: HomeAttentionRecord) {
  return homeAttentionPriority(a.kind) - homeAttentionPriority(b.kind) || b.time - a.time
}

export function groupSessions(
  records: HomeSessionRecord[],
  language: HomeLanguage,
  projectName?: string,
  now: DateTime<boolean> = DateTime.local(),
): HomeSessionGroup[] {
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
