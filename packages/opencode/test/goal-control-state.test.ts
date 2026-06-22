import { describe, expect, test } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  runGoalControlStateFile,
  type GoalControlState,
} from "@opencode-ai/autogoal/control-state"
import { tmpdir } from "./fixture/fixture"

function state(input: Partial<GoalControlState> = {}): GoalControlState {
  return {
    version: 1,
    id: "goal-1",
    condition: "ship the GUI",
    command: null,
    status: "active",
    createdAt: 1000,
    startedAt: 1000,
    completedAt: null,
    pausedAt: null,
    resumedAt: null,
    turnsEvaluated: 2,
    tokensUsed: 0,
    lastEvaluation: null,
    evaluationHistory: [],
    constraints: {
      maxTurns: 20,
      maxTimeMinutes: 30,
      maxTokens: 100000,
    },
    metadata: {
      setBy: "user",
    },
    ...input,
  }
}

async function seedGoal(directory: string, next = state()) {
  await mkdir(join(directory, ".opencode"), { recursive: true })
  await Bun.write(join(directory, ".opencode", ".goal-state.json"), JSON.stringify(next, null, 2))
}

async function readGoal(directory: string): Promise<GoalControlState> {
  return Bun.file(join(directory, ".opencode", ".goal-state.json")).json()
}

async function readJson<T>(directory: string, path: string): Promise<T> {
  return Bun.file(join(directory, path)).json()
}

describe("runGoalControlStateFile", () => {
  test("updates max turns from a GUI budget command", async () => {
    await using tmp = await tmpdir()
    await seedGoal(tmp.path)

    const result = await runGoalControlStateFile(tmp.path, "turns 25", 2000)
    const next = await readGoal(tmp.path)

    expect(result.output).toBe("Max turns: 20 → 25")
    expect(result.metadata).toMatchObject({ source: "state-file", command: "turns" })
    expect(next.constraints.maxTurns).toBe(25)
    expect(next.turnsEvaluated).toBe(2)
    expect(next.condition).toBe("ship the GUI")
  })

  test("pauses and resumes without charging paused wall time", async () => {
    await using tmp = await tmpdir()
    await seedGoal(tmp.path, state({ startedAt: 1000 }))

    await runGoalControlStateFile(tmp.path, "pause", 2000)
    let next = await readGoal(tmp.path)
    expect(next.status).toBe("paused")
    expect(next.pausedAt).toBe(2000)

    await runGoalControlStateFile(tmp.path, "resume", 62000)
    next = await readGoal(tmp.path)
    expect(next.status).toBe("active")
    expect(next.startedAt).toBe(61000)
    expect(next.resumedAt).toBe(62000)
  })

  test("sets a fresh goal from the create form command without agent-only instructions", async () => {
    await using tmp = await tmpdir()

    const result = await runGoalControlStateFile(tmp.path, 'set "make tests pass" --command "bun test"', 3000, {
      sessionID: "ses_goal_panel",
    })
    const next = await readGoal(tmp.path)

    expect(result.output).toContain("A goal has been set")
    expect(result.output).not.toContain("How to proceed")
    expect(result.output).not.toContain("Begin now")
    expect(next.condition).toBe("make tests pass")
    expect(next.command).toBe("bun test")
    expect(next.constraints.maxTurns).toBe(20)
    expect(next.metadata.sessionId).toBe("ses_goal_panel")
  })

  test("fresh clears live state files while preserving templates and history", async () => {
    await using tmp = await tmpdir()
    await mkdir(join(tmp.path, ".opencode"), { recursive: true })

    const liveFiles = [
      ".goal-state.json",
      ".goal-chain.json",
      ".goal-handoff.json",
      ".session-events.jsonl",
      ".step-timeline.jsonl",
    ]
    for (const file of liveFiles) {
      await Bun.write(join(tmp.path, ".opencode", file), file.includes(".json") ? "{}\n" : "event\n")
    }
    await Bun.write(join(tmp.path, ".opencode", "goal-templates.json"), '{"templates":[]}\n')
    await Bun.write(join(tmp.path, ".opencode", "goal-history.json"), '{"runs":[]}\n')

    const result = await runGoalControlStateFile(tmp.path, "fresh", 4000)

    expect(result.output).toContain("OpenGoal state reset")
    expect(result.metadata).toMatchObject({ source: "state-file", command: "fresh" })
    for (const file of liveFiles) {
      expect(await Bun.file(join(tmp.path, ".opencode", file)).exists()).toBe(false)
    }
    expect(await Bun.file(join(tmp.path, ".opencode", "goal-templates.json")).text()).toBe('{"templates":[]}\n')
    expect(await Bun.file(join(tmp.path, ".opencode", "goal-history.json")).text()).toBe('{"runs":[]}\n')
  })

  test("adds steering and restarts the current goal", async () => {
    await using tmp = await tmpdir()
    await seedGoal(tmp.path)

    await runGoalControlStateFile(tmp.path, 'steer "look at the button matrix"', 2000)
    let next = await readGoal(tmp.path)
    expect(next.metadata.steering).toEqual([{ at: 2000, note: "look at the button matrix" }])

    await runGoalControlStateFile(tmp.path, "restart", 3000)
    next = await readGoal(tmp.path)
    expect(next.id).not.toBe("goal-1")
    expect(next.turnsEvaluated).toBe(0)
    expect(next.evaluationHistory).toEqual([])
    expect(next.metadata.previousId).toBe("goal-1")
  })

  test("creates and claims a handoff through the native bridge", async () => {
    await using tmp = await tmpdir()
    await seedGoal(tmp.path)

    const handoffResult = await runGoalControlStateFile(tmp.path, "handoff Desktop note", 2000)
    const handoff = await readJson<{ note?: string; state: GoalControlState }>(
      tmp.path,
      ".opencode/.goal-handoff.json",
    )

    expect(handoffResult.output).toContain("Handoff written")
    expect(handoff.note).toBe("Desktop note")
    expect(handoff.state.id).toBe("goal-1")

    await runGoalControlStateFile(tmp.path, "clear", 3000)
    const claimResult = await runGoalControlStateFile(tmp.path, "claim", 4000)
    const claimed = await readGoal(tmp.path)

    expect(claimResult.output).toContain("Handoff claimed")
    expect(claimed.id).toBe("goal-1")
    expect(claimed.status).toBe("active")
    expect(claimed.startedAt).toBe(4000)
    expect(await Bun.file(join(tmp.path, ".opencode", ".goal-handoff.json")).exists()).toBe(false)
  })

  test("rejects controls that are not available in the native bridge", async () => {
    await using tmp = await tmpdir()
    await seedGoal(tmp.path)

    await expect(runGoalControlStateFile(tmp.path, "webhook status")).rejects.toThrow(
      "Goal control action is not available in the native AutoGoal bridge",
    )
  })

  test("imports an action template through the Desktop fallback route", async () => {
    await using tmp = await tmpdir()

    const payload = {
      label: "QA action",
      description: "Use a saved action with spaces",
      condition: "Prove the saved action works",
      command: "bun test",
      constraints: { maxTurns: 4, maxTimeMinutes: 12 },
      category: "Documentation",
      gate: "verify",
      tone: "emerald",
      elevation: "raised",
      skills: ["frontend-testing-debugging", "systematic-debugging"],
      model: { providerID: "openai", modelID: "gpt-5" },
    }
    const result = await runGoalControlStateFile(tmp.path, `template import qa-action ${JSON.stringify(payload)}`, 4000)
    const saved = await readJson<typeof payload>(tmp.path, ".opencode/goals/qa-action.json")
    const snapshot = await readJson<{ templates: Array<typeof payload & { id: string; builtin: boolean }> }>(
      tmp.path,
      ".opencode/goal-templates.json",
    )

    expect(result.output).toBe("Template saved: qa-action")
    expect(result.metadata).toMatchObject({ source: "state-file", command: "template" })
    expect(saved).toMatchObject(payload)
    expect(snapshot.templates).toContainEqual({ id: "qa-action", builtin: false, ...payload })
  })

  test("deletes an imported action template and updates the Desktop snapshot", async () => {
    await using tmp = await tmpdir()
    const payload = {
      label: "Disposable action",
      description: "delete me",
      condition: "Remove this action",
    }
    await runGoalControlStateFile(tmp.path, `template import disposable ${JSON.stringify(payload)}`, 4000)

    const result = await runGoalControlStateFile(tmp.path, "template delete disposable", 5000)
    const snapshot = await readJson<{ templates: Array<{ id: string }> }>(tmp.path, ".opencode/goal-templates.json")

    await expect(readFile(join(tmp.path, ".opencode", "goals", "disposable.json"), "utf8")).rejects.toThrow()
    expect(result.output).toBe("Template deleted: disposable")
    expect(snapshot.templates.some((template) => template.id === "disposable")).toBe(false)
  })

  test("starts a goal chain from JSON and activates the first step", async () => {
    await using tmp = await tmpdir()
    const payload = {
      master: { maxTurns: 8, maxMinutes: 30 },
      steps: [
        {
          condition: "Plan the sidepanel",
          command: "bun test sidepanel",
          verification: { type: "shell", command: "bun test sidepanel" },
          maxTurns: 2,
          maxMinutes: 5,
          category: "Planning",
          gate: "required",
          tone: "blue",
          elevation: "flat",
          model: { providerID: "openai", modelID: "gpt-5" },
          skills: ["frontend-testing-debugging", "systematic-debugging"],
        },
        {
          condition: "Verify the sidepanel",
          verification: { type: "marker" },
          maxTurns: 3,
          maxMinutes: 10,
          category: "Testing",
          gate: "pass",
          tone: "emerald",
          elevation: "raised",
          model: "anthropic/claude-sonnet-4",
          skills: ["verification-before-completion"],
        },
      ],
    }

    const result = await runGoalControlStateFile(tmp.path, `chain start-json ${JSON.stringify(payload)}`, 6000, {
      sessionID: "ses_chain_panel",
    })
    const chain = await readJson<{
      version: number
      current: number
      maxCycles: number
      master: { maxTurns: number; maxMinutes: number; turnsUsed: number; minutesUsed: number }
      steps: typeof payload.steps
      metadata: { setBy: string; sessionId?: string }
    }>(tmp.path, ".opencode/.goal-chain.json")
    const goal = await readGoal(tmp.path)

    expect(result.output).toBe("Chain started: step 1/2 - Plan the sidepanel")
    expect(chain.version).toBe(1)
    expect(chain.current).toBe(0)
    expect(chain.maxCycles).toBe(10)
    // master must carry the validator-required runtime counters: readGoalChain
    // rejects a bridge chain whose master lacks turnsUsed/minutesUsed (the #1
    // critical drift fix), so the chain would never auto-advance past step 0.
    expect(chain.master).toEqual({ ...payload.master, turnsUsed: 0, minutesUsed: 0 })
    expect(chain.steps).toEqual(payload.steps)
    expect(chain.metadata.sessionId).toBe("ses_chain_panel")
    expect(goal.condition).toBe("Plan the sidepanel")
    expect(goal.command).toBe("bun test sidepanel")
    expect(goal.verification).toEqual({ type: "shell", command: "bun test sidepanel" })
    expect(goal.constraints.maxTurns).toBe(2)
    expect(goal.constraints.maxTimeMinutes).toBe(5)
    expect(goal.metadata).toMatchObject({ setBy: "chain", chainStep: 0, chainTotal: 2, sessionId: "ses_chain_panel" })
  })

  test("does not leave an orphan chain when activating the first step fails", async () => {
    await using tmp = await tmpdir()
    await mkdir(join(tmp.path, ".opencode"), { recursive: true })
    await Bun.write(join(tmp.path, ".opencode", ".goal-state.json"), JSON.stringify({ id: 123, status: "bad" }))

    const payload = {
      steps: [
        {
          condition: "This chain must not be orphaned",
          verification: { type: "marker" },
        },
      ],
    }

    await expect(runGoalControlStateFile(tmp.path, `chain start-json ${JSON.stringify(payload)}`, 6200)).rejects.toThrow(
      "Goal state file is invalid.",
    )
    expect(await Bun.file(join(tmp.path, ".opencode", ".goal-chain.json")).exists()).toBe(false)
  })

  test("starts a no-command chain step as a marker-verified runtime check", async () => {
    await using tmp = await tmpdir()
    const payload = {
      steps: [
        {
          condition: "Review the implementation evidence",
          maxTurns: 2,
          maxMinutes: 5,
          category: "Review",
          gate: "review",
          tone: "fuchsia",
          elevation: "raised",
        },
      ],
    }

    await runGoalControlStateFile(tmp.path, `chain start-json ${JSON.stringify(payload)}`, 6100)
    const goal = await readGoal(tmp.path)
    const chain = await readJson<{ steps: Array<{ category?: string; gate?: string; tone?: string; elevation?: string }> }>(
      tmp.path,
      ".opencode/.goal-chain.json",
    )

    expect(goal.condition).toBe("Review the implementation evidence")
    expect(goal.command).toBeNull()
    expect(goal.verification).toEqual({ type: "marker" })
    expect(chain.steps[0]).toMatchObject({
      category: "Review",
      gate: "review",
      tone: "fuchsia",
      elevation: "raised",
    })
  })

  test("adds and reorders chain steps through live sidepanel controls", async () => {
    await using tmp = await tmpdir()
    await runGoalControlStateFile(
      tmp.path,
      `chain start-json ${JSON.stringify({ steps: [{ condition: "First step" }] })}`,
      6000,
    )

    await runGoalControlStateFile(tmp.path, 'chain add "Second step"', 7000)
    // Command language is 1-based (locked by dispatcher-parity.test.mjs `chain
    // move 2 3`): move step 2 ("Second step") to position 1.
    await runGoalControlStateFile(tmp.path, "chain move 2 1", 8000)
    const chain = await readJson<{ current: number; steps: Array<{ condition: string }> }>(
      tmp.path,
      ".opencode/.goal-chain.json",
    )

    expect(chain.current).toBe(1)
    expect(chain.steps.map((step) => step.condition)).toEqual(["Second step", "First step"])
  })
})
