import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { DateTime } from "luxon"

import {
  buildHomeAttentionRecords,
  buildHomeGoalAttentionRecords,
  buildHomeGoalRecords,
  findHomeProjectByDirectory,
  mergeHomeAttentionRecords,
  resolveHomeServerProjects,
  groupSessions,
  type HomeNotification,
} from "./home-pure"

const project = (id: string, name: string, worktree: string, sandboxes: string[] = []) => ({
  id,
  name,
  worktree,
  expanded: false,
  sandboxes,
})

const session = (id: string, directory: string, updated: number): Session =>
  ({
    id,
    directory,
    title: `Session ${id}`,
    time: { created: updated - 100, updated },
  }) as Session

const goalState = (
  id: string,
  status: "active" | "paused" | "achieved" | "cleared",
  condition: string,
  startedAt: number,
  timestamp?: number,
) => ({
  id,
  condition,
  status,
  startedAt,
  completedAt: null,
  turnsEvaluated: 2,
  tokensUsed: 100,
  lastEvaluation: timestamp
    ? { met: false, reason: "still running", timestamp, evaluatorType: "deterministic" as const }
    : null,
  evaluationHistory: [],
  constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100_000 },
})

const emptyStore = () => ({
  session: [] as Session[],
  permission: {},
  question: {},
  session_status: {},
  session_working: () => false,
})

const syncFrom = (stores: Record<string, ReturnType<typeof emptyStore>>) => ({
  child: (directory: string) => [stores[directory] ?? emptyStore()] as const,
})

describe("home pure data builders", () => {
  test("builds prioritized actionable attention records from sessions and orphan project notifications", () => {
    const projects = [
      project("p1", "Alpha", "C:/alpha"),
      project("p2", "Beta", "C:/beta"),
      project("p3", "Gamma", "C:/gamma"),
      project("p4", "Delta", "C:/delta"),
      project("p5", "Epsilon", "C:/epsilon"),
      project("p6", "Zeta", "C:/zeta"),
    ]
    const records = projects.slice(0, 5).map((item, index) => ({
      project: item,
      projectName: item.name,
      session: session(`s${index + 1}`, item.worktree, 1_700_000_000_000 + index),
    }))
    const stores = Object.fromEntries(
      records.map((record) => [record.session.directory, { ...emptyStore(), session: [record.session] }]),
    )
    stores["C:/alpha"].permission = {
      s1: [{ id: "perm-1", permission: "shell: npm test" } as never],
    }
    stores["C:/beta"].question = {
      s2: [{ id: "question-1", questions: [{ question: "Pick a branch", header: "Branch" }] } as never],
    }
    stores["C:/gamma"].session_status = {
      s3: { type: "retry", attempt: 2, message: "Provider retry", next: 1_700_000_010_000 } as never,
    }

    const unseenBySession: Record<string, HomeNotification[]> = {
      s4: [{ type: "error", time: 1_700_000_020_000, error: { message: "Provider auth failed" } }],
      s5: [{ type: "message", time: 1_700_000_030_000 }],
    }
    const unseenByDirectory: Record<string, HomeNotification[]> = {
      "C:/zeta": [{ type: "error", time: 1_700_000_040_000 }],
    }

    const result = buildHomeAttentionRecords({
      records,
      projects,
      directories: (item) => [item.worktree, ...(item.sandboxes ?? [])],
      sync: syncFrom(stores),
      permission: { autoResponds: () => false },
      notification: {
        session: { unseen: (id) => unseenBySession[id] ?? [] },
        project: { unseen: (directory) => unseenByDirectory[directory] ?? [] },
      },
      notificationActive: true,
    })

    expect(result.map((record) => record.kind)).toEqual(["permission", "question", "retry", "error", "response", "project"])
    expect(result[0]).toMatchObject({ id: "permission:s1:perm-1", reason: "Permission needed", detail: "shell: npm test" })
    expect(result[1]).toMatchObject({ id: "question:s2:question-1", reason: "Question waiting", detail: "Pick a branch" })
    expect(result[3]).toMatchObject({ reason: "Session error", detail: "Provider auth failed", clearable: true })
    expect(result[5]).toMatchObject({ reason: "Project error", projectName: "Zeta", clearable: true })
  })

  test("builds active goal records from workspace state instead of session titles", async () => {
    const alpha = project("p1", "Alpha", "C:/alpha", ["C:/alpha-sandbox"])
    const beta = project("p2", "Beta", "C:/beta")
    const archived = project("p3", "Done", "C:/done")
    const states = {
      "C:/alpha": {
        ...goalState("g1", "active", "Fix\u0000all tests", 1_700_000_000_000, 1_700_000_060_000),
        metadata: { sessionId: "ses_alpha_owner" },
      },
      "C:/beta": {
        ...goalState("g2", "paused", "Resume release", 1_700_000_050_000),
        metadata: { sessionId: "../not-a-session-route" },
      },
      "C:/done": goalState("g3", "achieved", "Already shipped", 1_700_000_070_000, 1_700_000_080_000),
    }

    const result = await buildHomeGoalRecords({
      projectDirectories: ["C:/beta", "C:/done", "C:/alpha", "C:/missing"],
      projects: [alpha, beta, archived],
      readGoal: async (directory) => ({ state: states[directory as keyof typeof states] ?? null }),
    })

    expect(result.map((record) => record.id)).toEqual(["g1", "g2"])
    expect(result[0]).toMatchObject({
      projectName: "Alpha",
      directory: "C:/alpha",
      sessionID: "ses_alpha_owner",
      condition: "Fixall tests",
    })
    expect(result[1]).toMatchObject({ projectName: "Beta", status: "paused", updated: 1_700_000_050_000 })
    expect(result[1].sessionID).toBeUndefined()
  })

  test("builds goal-derived attention records for limit-hit and stalled runs", async () => {
    const now = 1_700_001_200_000
    const alpha = project("p1", "Alpha", "C:/alpha")
    const beta = project("p2", "Beta", "C:/beta")
    const gamma = project("p3", "Gamma", "C:/gamma")
    const delta = project("p4", "Delta", "C:/delta")
    const epsilon = project("p5", "Epsilon", "C:/epsilon")
    const states = {
      "C:/alpha": {
        ...goalState("g1", "cleared", "Fix failing tests", now - 20 * 60_000, now - 60_000),
        completedAt: now - 30_000,
        turnsEvaluated: 20,
        lastEvaluation: {
          met: false,
          reason: "Turn limit reached: 20/20 turns",
          timestamp: now - 60_000,
          evaluatorType: "deterministic" as const,
        },
      },
      "C:/beta": {
        ...goalState("g2", "cleared", "Ship release", now - 35 * 60_000, now - 2 * 60_000),
        completedAt: now - 90_000,
        lastEvaluation: {
          met: false,
          reason: "Time limit reached: 35/30 minutes",
          timestamp: now - 2 * 60_000,
          evaluatorType: "deterministic" as const,
        },
      },
      "C:/gamma": {
        ...goalState("g3", "active", "Investigate hang", now - 40 * 60_000, now - 11 * 60_000),
        constraints: { maxTurns: 20, maxTimeMinutes: 120, maxTokens: 100_000 },
      },
      "C:/delta": goalState("g4", "paused", "Paused intentionally", now - 40 * 60_000, now - 20 * 60_000),
      "C:/epsilon": goalState("g5", "active", "Fresh run", now - 60_000, now - 30_000),
    }

    const result = await buildHomeGoalAttentionRecords({
      projectDirectories: ["C:/alpha", "C:/beta", "C:/gamma", "C:/delta", "C:/epsilon"],
      projects: [alpha, beta, gamma, delta, epsilon],
      now,
      stalledAfterMinutes: 10,
      readGoal: async (directory) => ({ state: states[directory as keyof typeof states] ?? null }),
    })

    expect(result.map((record) => record.id)).toEqual(["goal-limit:g1", "goal-limit:g2", "goal-stalled:g3"])
    expect(result[0]).toMatchObject({
      kind: "goal-limit",
      reason: "Turn limit hit",
      detail: "Turn limit reached: 20/20 turns",
      projectName: "Alpha",
      clearable: false,
    })
    expect(result[1]).toMatchObject({
      kind: "goal-limit",
      reason: "Time limit hit",
      detail: "Time limit reached: 35/30 minutes",
      projectName: "Beta",
      clearable: false,
    })
    expect(result[2]).toMatchObject({
      kind: "goal-stalled",
      reason: "Goal stalled",
      detail: "No movement for 11 minutes",
      projectName: "Gamma",
      clearable: false,
    })
  })

  test("merges goal-derived attention ahead of retry/error/update notifications", () => {
    const alpha = project("p1", "Alpha", "C:/alpha")
    const beta = project("p2", "Beta", "C:/beta")
    const records = [alpha, beta].map((item, index) => ({
      project: item,
      projectName: item.name,
      session: session(`s${index + 1}`, item.worktree, 1_700_000_000_000 + index),
    }))
    const stores = Object.fromEntries(
      records.map((record) => [record.session.directory, { ...emptyStore(), session: [record.session] }]),
    )
    stores["C:/alpha"].session_status = {
      s1: { type: "retry", attempt: 1, message: "Provider retry", next: 1_700_000_020_000 } as never,
    }

    const sessionAttention = buildHomeAttentionRecords({
      records,
      projects: [alpha, beta],
      directories: (item) => [item.worktree, ...(item.sandboxes ?? [])],
      sync: syncFrom(stores),
      permission: { autoResponds: () => false },
      notification: {
        session: { unseen: (id) => (id === "s2" ? [{ type: "message", time: 1_700_000_030_000 }] : []) },
        project: { unseen: () => [] },
      },
      notificationActive: true,
    })
    const result = mergeHomeAttentionRecords(sessionAttention, [
      {
        id: "goal-limit:g1",
        kind: "goal-limit",
        project: alpha,
        projectName: "Alpha",
        directory: "C:/alpha",
        reason: "Turn limit hit",
        detail: "Turn limit reached: 3/3 turns",
        count: 1,
        time: 1_700_000_010_000,
        clearable: false,
      },
    ])

    expect(result.map((record) => record.kind)).toEqual(["goal-limit", "retry", "response"])
  })

  test("resolves visible server projects from opened state plus live metadata and matches sandbox directories", () => {
    const opened = [{ worktree: "C:/alpha", expanded: false }]
    const known = [
      { id: "p-alpha", name: "Alpha", worktree: "C:/alpha", sandboxes: ["C:/alpha-sandbox"] },
      { id: "p-beta", name: "Beta", worktree: "C:/beta" },
    ]

    const resolved = resolveHomeServerProjects(opened, known)

    expect(resolved.map((project) => project.worktree)).toEqual(["C:/alpha", "C:/beta"])
    expect(resolved[0]).toMatchObject({ id: "p-alpha", name: "Alpha", expanded: false })
    expect(findHomeProjectByDirectory(resolved, "C:/alpha-sandbox")).toMatchObject({ id: "p-alpha" })
    expect(findHomeProjectByDirectory(resolved, "C:/beta")).toMatchObject({ id: "p-beta" })
  })

  test("groups sessions deterministically and uses the selected project title for an older-only board", () => {
    const language = {
      t: (key: string | number, args?: Record<string, string | number | boolean>) =>
        args?.project ? `${key}:${args.project}` : String(key),
    }
    const now = DateTime.fromISO("2026-06-19T12:00:00")
    const today = { session: session("today", "C:/alpha", now.toMillis()), project: project("p1", "Alpha", "C:/alpha"), projectName: "Alpha" }
    const older = {
      session: session("older", "C:/alpha", now.minus({ days: 3 }).toMillis()),
      project: project("p1", "Alpha", "C:/alpha"),
      projectName: "Alpha",
    }

    expect(groupSessions([older], language, "Alpha", now)).toEqual([
      { id: "older", title: "home.sessions.group.project:Alpha", sessions: [older] },
    ])
    expect(groupSessions([today, older], language, "Alpha", now).map((group) => [group.id, group.title])).toEqual([
      ["today", "home.sessions.group.today"],
      ["older", "home.sessions.group.older"],
    ])
  })
})
