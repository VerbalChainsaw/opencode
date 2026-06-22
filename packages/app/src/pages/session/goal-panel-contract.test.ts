import { describe, expect, test } from "bun:test"

import type { GoalHandoffStore, GoalState } from "./goal-panel-pure"

/**
 * Real behavior tests for the mission-control goal dock.
 *
 * The earlier version of this file was pure string-match — it asserted
 * the file *contained* literal substrings, which would pass with zero
 * code. The new tests import the actual exported functions and assert
 * their behavior. If someone deletes a function or changes its
 * semantics, these tests fail with a precise message.
 *
 * Note: `goal-panel.tsx` imports UI components that throw "Client-only
 * API" under happy-dom if touched at module load. We import the
 * specific pure exports via `await import()` so the test environment
 * is fully set up before the module loads.
 */

const load = async () => {
  // Import from the pure module — it has no UI/Kobalte dependencies, so
  // it loads cleanly under happy-dom. The TSX file (goal-panel.tsx)
  // transitively imports Kobalte client-only modules that throw on
  // module init in this environment.
  const mod = await import("./goal-panel-pure")
  return mod
}

describe("archive poll retention", () => {
  const run = (goalID: string) => ({
    summary: {
      goalID,
      title: `Goal ${goalID}`,
      status: "success" as const,
      outcome: "achieved" as const,
      turns: 3,
      elapsedMs: 60_000,
      successCount: 1,
      failureCount: 0,
      archivedAt: 1_700_000_000_000,
    },
    detail: {
      latestReason: "done",
      cycles: [{ turn: 1, met: true, reason: "ok", at: 1_700_000_000_000 }],
      template: {
        source: "manual" as const,
        label: "Manual",
        reuseCommand: "set x",
        canGenerate: false,
      },
    },
  })

  test("keeps the last good archive on a transient empty poll and preserves valid selection", async () => {
    const { applyArchivePoll } = await load()
    const previous = [run("a"), run("b")]

    expect(applyArchivePoll(previous, [], "b")).toEqual({
      runs: previous,
      selectedGoalID: "b",
    })
  })

  test("uses the incoming archive when present and selects a valid fallback row", async () => {
    const { applyArchivePoll } = await load()
    const incoming = [run("new"), run("older")]

    expect(applyArchivePoll([run("stale")], incoming, "older")).toEqual({
      runs: incoming,
      selectedGoalID: "older",
    })
    expect(applyArchivePoll([run("stale")], incoming, "missing")).toEqual({
      runs: incoming,
      selectedGoalID: "new",
    })
    expect(applyArchivePoll([], [], "missing")).toEqual({
      runs: [],
      selectedGoalID: null,
    })
  })
})

describe("cleanText (sanitization for safe rendering)", () => {
  let cleanText: typeof import("./goal-panel-pure").cleanText
  test("returns empty string for non-string input", async () => {
    ;({ cleanText } = await load())
    expect(cleanText(undefined)).toBe("")
    expect(cleanText(null)).toBe("")
    expect(cleanText(42)).toBe("")
    expect(cleanText({})).toBe("")
    expect(cleanText([])).toBe("")
  })

  test("returns the original string for normal text", async () => {
    ;({ cleanText } = await load())
    expect(cleanText("hello world")).toBe("hello world")
    expect(cleanText("")).toBe("")
  })

  test("strips control characters and bidirectional override codepoints", async () => {
    ;({ cleanText } = await load())
    // 6 visible letters interleaved with 6 dangerous codepoints: \u0000
    // (null), \u001f (unit separator), \u007f (delete), \u200b (zero-width
    // space), \u200e (LTR mark), \u2028 (line separator). These are the
    // character classes the plugin's sanitizeForPrompt drops and the
    // characters commonly used to spoof UI in copied prompt strings.
    expect(cleanText("a\u0000b\u001fc\u007fd\u200b\u200ee\u2028f")).toBe("abcdef")
    expect(cleanText("\u2028\u2029")).toBe("")
  })

  test("caps the result at 400 characters", async () => {
    ;({ cleanText } = await load())
    const long = "x".repeat(500)
    expect(cleanText(long).length).toBe(400)
  })
})

describe("isGoalStateShape (defensive shape guard for corrupted state files)", () => {
  test("accepts a minimal valid GoalState", async () => {
    const { isGoalStateShape } = await load()
    // The shape guard requires these fields to be present and well-typed:
    // id, condition, status (in the active/paused/achieved/cleared set),
    // turnsEvaluated, startedAt, constraints{maxTurns,maxTimeMinutes,maxTokens}
    expect(
      isGoalStateShape({
        id: "abc",
        condition: "ship it",
        status: "active",
        startedAt: 0,
        turnsEvaluated: 0,
        constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
      }),
    ).toBe(true)
  })

  test("rejects non-objects", async () => {
    const { isGoalStateShape } = await load()
    expect(isGoalStateShape(null)).toBe(false)
    expect(isGoalStateShape(undefined)).toBe(false)
    expect(isGoalStateShape(42)).toBe(false)
    expect(isGoalStateShape("goal")).toBe(false)
    expect(isGoalStateShape([])).toBe(false)
  })

  test("rejects objects with wrong status", async () => {
    const { isGoalStateShape } = await load()
    expect(
      isGoalStateShape({
        id: "x",
        condition: "y",
        status: "deleted",
        createdAt: 0,
        constraints: { maxTurns: 1, maxTimeMinutes: 1, maxTokens: 1 },
      }),
    ).toBe(false)
  })

  test("rejects objects with empty condition", async () => {
    const { isGoalStateShape } = await load()
    expect(
      isGoalStateShape({
        id: "x",
        condition: "   ",
        status: "active",
        createdAt: 0,
        constraints: { maxTurns: 1, maxTimeMinutes: 1, maxTokens: 1 },
      }),
    ).toBe(false)
  })
})

describe("chainMatchesGoal (chain snapshot scoping)", () => {
  const baseState: GoalState = {
    id: "goal-1",
    condition: "ship it",
    status: "active",
    startedAt: 0,
    completedAt: null,
    turnsEvaluated: 0,
    tokensUsed: 0,
    lastEvaluation: null,
    evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
  }

  test("matches when the goal's chainId equals the chain id", async () => {
    const { chainMatchesGoal } = await load()
    expect(
      chainMatchesGoal(
        { id: "chain-1" },
        { ...baseState, metadata: { chainId: "chain-1" } },
      ),
    ).toBe(true)
  })

  test("rejects when the goal's chainId differs", async () => {
    const { chainMatchesGoal } = await load()
    expect(
      chainMatchesGoal(
        { id: "chain-1" },
        { ...baseState, metadata: { chainId: "chain-2" } },
      ),
    ).toBe(false)
  })

  test("rejects when the goal has no chainId (new session / non-chain goal)", async () => {
    const { chainMatchesGoal } = await load()
    expect(chainMatchesGoal({ id: "chain-1" }, baseState)).toBe(false)
    expect(chainMatchesGoal({ id: "chain-1" }, null)).toBe(false)
    expect(chainMatchesGoal({ id: "chain-1" }, undefined)).toBe(false)
  })
})

describe("readGoalFromSdk (file.read defensive layer)", () => {
  test("returns an empty store when the file is missing", async () => {
    const { readGoalFromSdk } = await load()
    const sdk = {
      client: {
        file: {
          read: async () => {
            throw new Error("ENOENT")
          },
        },
      },
    }
    const store = await readGoalFromSdk(sdk)
    expect(store.loaded).toBe(true)
    expect(store.state).toBe(null)
    expect(store.corrupt).toBe(false)
  })

  test("returns an empty store when read returns null", async () => {
    const { readGoalFromSdk } = await load()
    const sdk = {
      client: {
        file: { read: async () => ({ data: null }) },
      },
    }
    const store = await readGoalFromSdk(sdk)
    expect(store.loaded).toBe(true)
    expect(store.state).toBe(null)
  })

  test("extracts content from the SDK's FileContent object form", async () => {
    const { readGoalFromSdk } = await load()
    const sdk = {
      client: {
        file: {
          read: async () => ({
            data: {
              type: "text",
              content:
                '{"id":"x","condition":"y","status":"active","startedAt":0,"turnsEvaluated":0,"constraints":{"maxTurns":1,"maxTimeMinutes":1,"maxTokens":1}}',
            },
          }),
        },
      },
    }
    const store = await readGoalFromSdk(sdk)
    expect(store.state).not.toBeNull()
    expect(store.state?.id).toBe("x")
  })

  test("accepts a bare string (degrades gracefully on SDK shape change)", async () => {
    const { readGoalFromSdk } = await load()
    const sdk = {
      client: {
        file: {
          read: async () => ({
            data: '{"id":"x","condition":"y","status":"active","startedAt":0,"turnsEvaluated":0,"constraints":{"maxTurns":1,"maxTimeMinutes":1,"maxTokens":1}}',
          }),
        },
      },
    }
    const store = await readGoalFromSdk(sdk)
    expect(store.state?.id).toBe("x")
  })

  test("marks store as corrupt when JSON is invalid", async () => {
    const { readGoalFromSdk } = await load()
    const sdk = {
      client: {
        file: { read: async () => ({ data: { type: "text", content: "{not json" } }) },
      },
    }
    const store = await readGoalFromSdk(sdk)
    expect(store.corrupt).toBe(true)
    expect(store.state).toBe(null)
  })

  test("marks store as corrupt when JSON parses but shape is wrong", async () => {
    const { readGoalFromSdk } = await load()
    const sdk = {
      client: {
        file: {
          read: async () => ({
            data: { type: "text", content: '{"id":"x","status":"banana"}' },
          }),
        },
      },
    }
    const store = await readGoalFromSdk(sdk)
    expect(store.corrupt).toBe(true)
  })
})

describe("templateButtonsFromSnapshot (dynamic quick-start template buttons)", () => {
  test("falls back to the built-in method prompts when the snapshot is missing/invalid", async () => {
    const { templateButtonsFromSnapshot, DEFAULT_TEMPLATE_BUTTONS } = await load()
    expect(templateButtonsFromSnapshot(null)).toEqual(DEFAULT_TEMPLATE_BUTTONS)
    expect(templateButtonsFromSnapshot({})).toEqual(DEFAULT_TEMPLATE_BUTTONS)
    expect(templateButtonsFromSnapshot({ templates: "nope" })).toEqual(DEFAULT_TEMPLATE_BUTTONS)
    // A well-formed but empty list also falls back — never render zero methods.
    expect(templateButtonsFromSnapshot({ version: 1, templates: [] })).toEqual(DEFAULT_TEMPLATE_BUTTONS)
  })

  test("default built-ins provide the shipped action library pack", async () => {
    const { DEFAULT_TEMPLATE_BUTTONS } = await load()
    expect(DEFAULT_TEMPLATE_BUTTONS.map((t) => t.id)).toEqual([
      "plan",
      "build",
      "debug",
      "test",
      "validate",
      "review",
      "docs",
      "wire-check",
      "adversarial-scan",
      "typecheck",
      "commit",
    ])
    expect(DEFAULT_TEMPLATE_BUTTONS.every((template) => template.builtin)).toBe(true)
    expect(DEFAULT_TEMPLATE_BUTTONS.every((template) => template.condition?.includes("{scope}"))).toBe(true)
  })

  test("appends project templates after the shipped defaults", async () => {
    const { templateButtonsFromSnapshot, DEFAULT_TEMPLATE_BUTTONS } = await load()
    const out = templateButtonsFromSnapshot({
      version: 1,
      templates: [
        { id: "pass-tests", label: "Pass tests", description: "run tests", builtin: true },
        { id: "ship-it", label: "Ship it", description: "deploy", builtin: false },
      ],
    })
    expect(out.map((t) => t.id)).toEqual([...DEFAULT_TEMPLATE_BUTTONS.map((t) => t.id), "ship-it"])
    expect(out.at(-1)).toMatchObject({ id: "ship-it", label: "Ship it", builtin: false })
  })

  test("drops older project-specific built-ins when a snapshot still includes them", async () => {
    const { templateButtonsFromSnapshot, DEFAULT_TEMPLATE_BUTTONS } = await load()
    const out = templateButtonsFromSnapshot({
      version: 1,
      templates: [{ id: "pass-tests", label: "Pass tests", description: "run tests", builtin: true }],
    })
    // old project-specific "built-in" snapshots are filtered — only
    // the app-owned defaults and user templates with `builtin: false` survive
    expect(out.filter((t) => !t.builtin)).toEqual([])
    expect(out).toEqual(DEFAULT_TEMPLATE_BUTTONS)
  })

  test("drops entries with a malformed id and de-duplicates", async () => {
    const { templateButtonsFromSnapshot, DEFAULT_TEMPLATE_BUTTONS } = await load()
    const out = templateButtonsFromSnapshot({
      version: 1,
      templates: [
        { id: "ok-one", builtin: false },
        { id: "bad id!", builtin: false }, // space + bang → rejected
        { id: "../escape", builtin: false }, // path-y → rejected
        { id: "ok-one", builtin: false }, // duplicate → dropped
      ],
    })
    expect(out.map((t) => t.id)).toEqual([...DEFAULT_TEMPLATE_BUTTONS.map((t) => t.id), "ok-one"])
    // A missing label defaults to the id.
    expect(out.at(-1)?.label).toBe("ok-one")
  })

  test("sanitizes control characters out of labels/descriptions", async () => {
    const { templateButtonsFromSnapshot } = await load()
    const out = templateButtonsFromSnapshot({
      version: 1,
      templates: [{ id: "x", label: "a\u0000b", description: "c‎d", builtin: false }],
    })
    expect(out.at(-1)?.label).toBe("ab")
    expect(out.at(-1)?.description).toBe("cd")
  })

  test("preserves inspectable template payload fields for preview/editing", async () => {
    const { templateButtonsFromSnapshot } = await load()
    const out = templateButtonsFromSnapshot({
      version: 1,
      templates: [
        {
          id: "ship-it",
          label: "Ship it",
          description: "Deploy {branch}",
          builtin: false,
          condition: "the deploy script exits 0 on {branch}",
          command: "npm run deploy -- --branch {branch}",
          constraints: { maxTurns: 7, maxTimeMinutes: 12, maxTokens: 50000 },
          variables: { branch: { description: "Target branch", default: "main" } },
          category: "Testing",
          gate: "verify",
          tone: "emerald",
          elevation: "raised",
        },
      ],
    })
    expect(out.at(-1)).toMatchObject({
      id: "ship-it",
      label: "Ship it",
      description: "Deploy {branch}",
      builtin: false,
      condition: "the deploy script exits 0 on {branch}",
      command: "npm run deploy -- --branch {branch}",
      constraints: { maxTurns: 7, maxTimeMinutes: 12, maxTokens: 50000 },
      variables: { branch: { description: "Target branch", default: "main" } },
      category: "Testing",
      gate: "verify",
      tone: "emerald",
      elevation: "raised",
    })
  })

  test("drops invalid operator metadata instead of trusting arbitrary values", async () => {
    const { templateButtonsFromSnapshot } = await load()
    const out = templateButtonsFromSnapshot({
      version: 1,
      templates: [
        {
          id: "styled",
          label: "Styled",
          builtin: false,
          category: "Everything",
          gate: "maybe",
          tone: "url(javascript:alert(1))",
          elevation: "huge",
        },
      ],
    })

    expect(out.at(-1)).toMatchObject({ id: "styled", label: "Styled", builtin: false })
    expect(out.at(-1)).not.toHaveProperty("category")
    expect(out.at(-1)).not.toHaveProperty("gate")
    expect(out.at(-1)).not.toHaveProperty("tone")
    expect(out.at(-1)).not.toHaveProperty("elevation")
  })

  test("resolves template defaults and overrides into an editable goal draft", async () => {
    const { templateDraftFromButton, templateVariableDefaults } = await load()
    const template = {
      id: "ship-it",
      label: "Ship it",
      builtin: false,
      condition: "the deploy script exits 0 on {branch}",
      command: "npm run deploy -- --branch {branch}",
      variables: { branch: { description: "Target branch", default: "main" } },
    }

    expect(templateVariableDefaults(template)).toEqual({ branch: "main" })
    expect(templateDraftFromButton(template, templateVariableDefaults(template))).toEqual({
      condition: "the deploy script exits 0 on main",
      command: "npm run deploy -- --branch main",
    })
    expect(templateDraftFromButton(template, { branch: "release" })).toEqual({
      condition: "the deploy script exits 0 on release",
      command: "npm run deploy -- --branch release",
    })
  })

  test("builds action preset drafts with only variables still referenced by condition or command", async () => {
    const { actionDraftTemplateFromState, referencedTemplateVariables } = await load()
    expect([...referencedTemplateVariables("Deploy {branch} from {scope}", "npm test -- --branch {branch}")]).toEqual([
      "branch",
      "scope",
    ])

    const template = actionDraftTemplateFromState(
      {
        sourceID: "ship-template",
        id: "",
        label: " Ship Release ",
        prompt: " Deploy {branch} from {scope} ",
        command: " npm test -- --branch {branch} ",
        turns: 2.6,
        minutes: 9.2,
        category: "Testing",
        tone: "emerald",
        elevation: "raised",
        agent: "explore",
        skills: ["superpowers:test-driven-development"],
        model: "openai:gpt-5-codex",
      },
      {
        variables: {
          branch: { description: "Target branch", default: "main" },
          scope: { description: "Release scope", default: "desktop app" },
          stale: { description: "Previously used but no longer referenced", default: "old" },
        },
      },
    )

    expect(template).toEqual({
      id: "ship-release",
      label: "Ship Release",
      description: "Ship Release",
      condition: "Deploy {branch} from {scope}",
      command: "npm test -- --branch {branch}",
      constraints: { maxTurns: 3, maxTimeMinutes: 9 },
      variables: {
        branch: { description: "Target branch", default: "main" },
        scope: { description: "Release scope", default: "desktop app" },
      },
      category: "Testing",
      tone: "emerald",
      elevation: "raised",
      agent: "explore",
      skills: ["superpowers:test-driven-development"],
      model: { providerID: "openai", modelID: "gpt-5-codex" },
      builtin: false,
    })
    expect(template.variables).not.toHaveProperty("stale")
  })

  test("copies an action template into an independently editable chain step with budgets", async () => {
    const { chainStepFromTemplate } = await load()
    const step = chainStepFromTemplate(
      {
        id: "build",
        label: "Build",
        condition: "Implement {scope} using the repository's existing patterns.",
        constraints: { maxTurns: 8, maxTimeMinutes: 30 },
        builtin: true,
      },
      { scope: "the renderer chain builder" },
      "step-1",
    )

    expect(step).toEqual({
      id: "step-1",
      actionID: "build",
      label: "Build",
      condition: expect.stringContaining("the renderer chain builder"),
      conditionTemplate: "Implement {scope} using the repository's existing patterns.",
      command: "",
      maxTurns: 8,
      maxTimeMinutes: 30,
      builtin: true,
    })
  })

  test("copies explicit operator metadata into chain steps", async () => {
    const { chainStepFromTemplate } = await load()
    const step = chainStepFromTemplate(
      {
        id: "ship",
        label: "Ship",
        condition: "ship it",
        constraints: { maxTurns: 2, maxTimeMinutes: 5 },
        category: "Testing",
        gate: "pass",
        tone: "emerald",
        elevation: "raised",
        agent: "reviewer",
        builtin: false,
      },
      {},
      "step-1",
    )

    expect(step).toMatchObject({
      id: "step-1",
      actionID: "ship",
      category: "Testing",
      gate: "pass",
      tone: "emerald",
      elevation: "raised",
      agent: "reviewer",
    })
  })

  test("summarizes chain budgets with independent master caps and sub-step totals", async () => {
    const { chainBudgetSummary } = await load()
    expect(
      chainBudgetSummary(
        [
          {
            id: "a",
            actionID: "plan",
            label: "Plan",
            condition: "plan",
            command: "",
            maxTurns: 3,
            maxTimeMinutes: 10,
            builtin: true,
          },
          {
            id: "b",
            actionID: "build",
            label: "Build",
            condition: "build",
            command: "",
            maxTurns: 8,
            maxTimeMinutes: 30,
            builtin: true,
          },
          {
            id: "c",
            actionID: "validate",
            label: "Validate",
            condition: "validate",
            command: "",
            maxTurns: 4,
            maxTimeMinutes: 15,
            builtin: true,
          },
        ],
        { maxTurns: 12, maxTimeMinutes: 40 },
      ),
    ).toEqual({
      stepCount: 3,
      ultimateTurns: 15,
      ultimateTimeMinutes: 55,
      masterTurns: 12,
      masterTimeMinutes: 40,
      effectiveTurns: 12,
      effectiveTimeMinutes: 40,
      masterTurnsIsCap: true,
      masterTimeIsCap: true,
    })
  })

  test("builds chain start payload with ordered steps and operator metadata", async () => {
    const { chainStartPayload } = await load()
    const firstStepSkills = ["superpowers:test-driven-development", "build-web-apps:frontend-testing-debugging"]
    const start = chainStartPayload(
      [
        {
          id: "build-1",
          actionID: "build",
          label: "Build",
          condition: "Implement the GoalPanel payload builder",
          command: "  bun test --preload ./happydom.ts src/pages/session/goal-panel-contract.test.ts  ",
          maxTurns: 8,
          maxTimeMinutes: 30,
          category: "Building",
          gate: "required",
          tone: "sky",
          elevation: "raised",
          agent: "explore",
          skills: firstStepSkills,
          model: { providerID: "openai", modelID: "gpt-5-codex" },
          builtin: true,
        },
        {
          id: "verify-1",
          actionID: "verify",
          label: "Verify",
          condition: "Confirm the refactor did not change runtime flow",
          command: "   ",
          maxTurns: 3,
          maxTimeMinutes: 12,
          category: "Testing",
          tone: "emerald",
          elevation: "flat",
          model: "anthropic:claude-sonnet-4",
          builtin: false,
        },
      ],
      { maxTurns: 11, maxTimeMinutes: 42 },
    )

    expect(start.firstStepModel).toEqual({ providerID: "openai", modelID: "gpt-5-codex" })
    expect(start.firstStepAgent).toBe("explore")
    expect(start.firstStepSkills).toEqual(firstStepSkills)
    expect(start.firstStepSkills).not.toBe(firstStepSkills)

    const parsed = JSON.parse(start.payload)
    expect(parsed).toEqual({
      master: { maxTurns: 11, maxMinutes: 42 },
      steps: [
        {
          condition: "Implement the GoalPanel payload builder",
          command: "bun test --preload ./happydom.ts src/pages/session/goal-panel-contract.test.ts",
          verification: {
            type: "shell",
            command: "bun test --preload ./happydom.ts src/pages/session/goal-panel-contract.test.ts",
          },
          maxTurns: 8,
          maxMinutes: 30,
          category: "Building",
          tone: "sky",
          elevation: "raised",
          agent: "explore",
          skills: firstStepSkills,
          model: { providerID: "openai", modelID: "gpt-5-codex" },
        },
        {
          condition: "Confirm the refactor did not change runtime flow",
          verification: { type: "marker" },
          maxTurns: 3,
          maxMinutes: 12,
          category: "Testing",
          tone: "emerald",
          elevation: "flat",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
        },
      ],
    })
    expect(parsed.steps[0]).not.toHaveProperty("gate")
    expect(parsed.steps[1]).not.toHaveProperty("command")
  })

  test("omits session-default agent and model pins from chain runtime payload", async () => {
    const { chainStartPayload } = await load()
    const start = chainStartPayload(
      [
        {
          id: "default-runtime",
          actionID: "default-runtime",
          label: "Default runtime",
          condition: "Use the session defaults",
          command: "",
          maxTurns: 4,
          maxTimeMinutes: 10,
          agent: "",
          model: "",
          builtin: false,
        },
      ],
      { maxTurns: 10, maxTimeMinutes: 30 },
    )

    expect(start.firstStepAgent).toBeUndefined()
    expect(start.firstStepModel).toBeUndefined()
    const parsed = JSON.parse(start.payload)
    expect(parsed.steps[0]).toMatchObject({
      condition: "Use the session defaults",
      verification: { type: "marker" },
      maxTurns: 4,
      maxMinutes: 10,
    })
    expect(parsed.steps[0]).not.toHaveProperty("agent")
    expect(parsed.steps[0]).not.toHaveProperty("model")
  })

  test("run-level objective fills {scope} across chain steps without editing the action", async () => {
    const { chainStepFromTemplate, chainStartPayload, resolveStepConditionWithObjective } = await load()
    const planTemplate = {
      id: "plan",
      label: "Plan",
      condition: "Create a concise implementation plan for {scope}.",
      constraints: { maxTurns: 3, maxTimeMinutes: 10 },
      variables: { scope: { description: "Scope", default: "the current coding request" } },
      builtin: true,
    }
    const debugTemplate = {
      id: "debug",
      label: "Debug",
      condition: "Debug {scope}. Reproduce, isolate, and fix.",
      constraints: { maxTurns: 8, maxTimeMinutes: 30 },
      variables: { scope: { description: "Scope", default: "the reported failure" } },
      builtin: true,
    }
    // The UI adds actions with their variable defaults applied (varsForAction),
    // while the raw {scope} template is retained on the step for re-resolution.
    const steps = [
      chainStepFromTemplate(planTemplate, { scope: "the current coding request" }, "plan-1"),
      chainStepFromTemplate(debugTemplate, { scope: "the reported failure" }, "debug-1"),
    ]

    // With no objective the steps keep each action's own default.
    expect(steps[0].condition).toBe("Create a concise implementation plan for the current coding request.")
    expect(resolveStepConditionWithObjective(steps[0], "")).toBe(
      "Create a concise implementation plan for the current coding request.",
    )

    // A run-level objective overrides {scope} in every step at start time.
    const objective = "make the login page validate emails"
    expect(resolveStepConditionWithObjective(steps[1], objective)).toBe(
      `Debug ${objective}. Reproduce, isolate, and fix.`,
    )
    const parsed = JSON.parse(chainStartPayload(steps, { maxTurns: 11, maxTimeMinutes: 40 }, objective).payload)
    expect(parsed.steps[0].condition).toBe(`Create a concise implementation plan for ${objective}.`)
    expect(parsed.steps[1].condition).toBe(`Debug ${objective}. Reproduce, isolate, and fix.`)
  })

  test("builds agent routing options from visible primary and subagent entries", async () => {
    const { agentRoutingOptions } = await load()

    expect(
      agentRoutingOptions([
        { name: "build", mode: "primary", description: "Default builder" },
        { name: "explore", mode: "subagent", description: "Read-only exploration" },
        { name: "review", mode: "all" },
        { name: "hidden", mode: "subagent", hidden: true },
        { name: "", mode: "primary" },
      ]),
    ).toEqual([
      { name: "build", mode: "primary", label: "build", description: "Default builder" },
      { name: "review", mode: "primary", label: "review" },
      { name: "explore", mode: "subagent", label: "explore", description: "Read-only exploration" },
    ])
  })

  test("makes chain step shell verification explicit and marker fallback structured", async () => {
    const { chainStepVerificationContract, completionRuleTranslationKey } = await load()

    expect(chainStepVerificationContract("  npm test -- --runInBand  ")).toEqual({
      mode: "shell",
      command: "npm test -- --runInBand",
      verification: { type: "shell", command: "npm test -- --runInBand" },
    })
    expect(chainStepVerificationContract("   ")).toEqual({
      mode: "marker",
      verification: { type: "marker" },
    })
    expect(completionRuleTranslationKey({ command: " npm test " })).toBe("session.goal.template.completionShell")
    expect(completionRuleTranslationKey({ command: "" })).toBe("session.goal.template.completionMarker")
  })

  test("classifies action editor controls with operator-visible disabled reasons", async () => {
    const { actionEditorControlState } = await load()
    const customTemplate = { builtin: false }
    const builtinTemplate = { builtin: true }

    expect(
      actionEditorControlState({
        control: "save",
        busy: false,
        hasSession: true,
        prompt: "",
        selectedTemplate: customTemplate,
      }),
    ).toEqual({ disabled: true, reason: "missing-prompt" })
    expect(
      actionEditorControlState({
        control: "duplicate",
        busy: false,
        hasSession: true,
        prompt: "  Run the test suite  ",
        selectedTemplate: customTemplate,
      }),
    ).toEqual({ disabled: false, reason: null })
    expect(
      actionEditorControlState({
        control: "delete",
        busy: false,
        hasSession: true,
        prompt: "anything",
        selectedTemplate: builtinTemplate,
      }),
    ).toEqual({ disabled: true, reason: "builtin-template" })
    expect(
      actionEditorControlState({
        control: "delete",
        busy: false,
        hasSession: true,
        prompt: "anything",
        selectedTemplate: null,
      }),
    ).toEqual({ disabled: true, reason: "no-template" })
    expect(
      actionEditorControlState({
        control: "delete",
        busy: false,
        hasSession: true,
        prompt: "anything",
        selectedTemplate: customTemplate,
      }),
    ).toEqual({ disabled: false, reason: null })
    expect(
      actionEditorControlState({
        control: "save",
        busy: true,
        hasSession: true,
        prompt: "ready",
        selectedTemplate: customTemplate,
      }),
    ).toEqual({ disabled: true, reason: "busy" })
    expect(
      actionEditorControlState({
        control: "save",
        busy: false,
        hasSession: false,
        prompt: "ready",
        selectedTemplate: customTemplate,
      }),
    ).toEqual({ disabled: true, reason: "missing-session" })
  })

  test("classifies action skill picker controls with operator-visible disabled reasons", async () => {
    const { skillPickerControlState } = await load()

    expect(
      skillPickerControlState({
        busy: false,
        hasSession: true,
        availableSkillCount: 2,
        selectedSkillCount: 7,
      }),
    ).toEqual({ disabled: false, reason: null })
    expect(
      skillPickerControlState({
        busy: true,
        hasSession: true,
        availableSkillCount: 2,
        selectedSkillCount: 0,
      }),
    ).toEqual({ disabled: true, reason: "busy" })
    expect(
      skillPickerControlState({
        busy: false,
        hasSession: false,
        availableSkillCount: 2,
        selectedSkillCount: 0,
      }),
    ).toEqual({ disabled: true, reason: "missing-session" })
    expect(
      skillPickerControlState({
        busy: false,
        hasSession: true,
        availableSkillCount: 3,
        selectedSkillCount: 8,
      }),
    ).toEqual({ disabled: true, reason: "max-skills" })
    expect(
      skillPickerControlState({
        busy: false,
        hasSession: true,
        availableSkillCount: 0,
        selectedSkillCount: 3,
      }),
    ).toEqual({ disabled: true, reason: "no-skills" })
    expect(
      skillPickerControlState({
        busy: false,
        hasSession: true,
        availableSkillCount: 0,
        selectedSkillCount: 4,
        maxSkills: 4,
      }),
    ).toEqual({ disabled: true, reason: "max-skills" })
  })

  describe("validateChainDraft", () => {
    let validateChainDraft: typeof import("./goal-panel-pure").validateChainDraft

    test("returns empty array for a valid single-step chain", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [
          { id: "1", actionID: "plan", label: "Plan", condition: "make a plan", command: "", maxTurns: 3, maxTimeMinutes: 10, builtin: true },
        ],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toEqual([])
    })

    test("reports error for empty chain", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft([], { maxTurns: 20, maxTimeMinutes: 60 })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain("Add at least one action")
    })

    test("keeps Start Chain clickable for empty drafts so validation can explain the rejection", async () => {
      const { chainStartControlState, validateChainDraft } = await load()

      expect(chainStartControlState({ busy: false, hasLiveGoal: false, hasSession: true })).toEqual({
        disabled: false,
        reason: null,
      })
      expect(validateChainDraft([], { maxTurns: 20, maxTimeMinutes: 60 })[0]?.message).toContain(
        "Add at least one action",
      )
      expect(chainStartControlState({ busy: true, hasLiveGoal: false, hasSession: true })).toEqual({
        disabled: true,
        reason: "busy",
      })
      expect(chainStartControlState({ busy: false, hasLiveGoal: true, hasSession: true })).toEqual({
        disabled: true,
        reason: "live-goal",
      })
      expect(chainStartControlState({ busy: false, hasLiveGoal: false, hasSession: false })).toEqual({
        disabled: true,
        reason: "missing-session",
      })
    })

    test("reports error for empty condition", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [{ id: "1", actionID: "x", label: "X", condition: "", command: "", maxTurns: 5, maxTimeMinutes: 10, builtin: false }],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toHaveLength(1)
      expect(errors[0].stepIndex).toBe(0)
      expect(errors[0].message).toContain("condition cannot be empty")
    })

    test("reports error for zero turns", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [{ id: "1", actionID: "x", label: "X", condition: "ok", command: "", maxTurns: 0, maxTimeMinutes: 5, builtin: false }],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain("turns must be at least 1")
    })

    test("reports error for zero time", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [{ id: "1", actionID: "x", label: "X", condition: "ok", command: "", maxTurns: 5, maxTimeMinutes: 0, builtin: false }],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain("time must be at least 1 minute")
    })

    test("reports master time cap when steps exceed limit", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [
          { id: "1", actionID: "a", label: "A", condition: "a", command: "", maxTurns: 5, maxTimeMinutes: 30, builtin: false },
          { id: "2", actionID: "b", label: "B", condition: "b", command: "", maxTurns: 5, maxTimeMinutes: 30, builtin: false },
        ],
        { maxTurns: 20, maxTimeMinutes: 40 },
      )
      // ultimate time = 60m, master = 40m — should report cap
      const capError = errors.find((e: { stepIndex: number }) => e.stepIndex === -1)
      expect(capError).toBeTruthy()
      expect(capError?.message).toContain("exceeds master time limit")
    })

    test("reports master turn cap when steps exceed limit", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [
          { id: "1", actionID: "a", label: "A", condition: "a", command: "", maxTurns: 8, maxTimeMinutes: 10, builtin: false },
          { id: "2", actionID: "b", label: "B", condition: "b", command: "", maxTurns: 8, maxTimeMinutes: 10, builtin: false },
        ],
        { maxTurns: 12, maxTimeMinutes: 60 },
      )
      const capError = errors.find((e: { stepIndex: number; message: string }) => e.stepIndex === -1 && e.message.includes("turn"))
      expect(capError).toBeTruthy()
      expect(capError?.message).toContain("exceeds master turn limit")
    })

    test("validates model format (malformed object)", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [{ id: "1", actionID: "x", label: "X", condition: "ok", command: "", maxTurns: 5, maxTimeMinutes: 10, builtin: false, model: { providerID: "", modelID: "" } }],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain("model must be a")
    })

    test("accepts valid { providerID, modelID } object", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [{ id: "1", actionID: "x", label: "X", condition: "ok", command: "", maxTurns: 5, maxTimeMinutes: 10, builtin: false, model: { providerID: "openai", modelID: "gpt-4" } }],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toEqual([])
    })

    test("treats empty default agent/model pins as omitted", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [
          {
            id: "1",
            actionID: "x",
            label: "X",
            condition: "ok",
            command: "",
            maxTurns: 5,
            maxTimeMinutes: 10,
            builtin: false,
            agent: "",
            model: "",
          },
        ],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toEqual([])
    })

    test("validates duplicate skills", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [{ id: "1", actionID: "x", label: "X", condition: "ok", command: "", maxTurns: 5, maxTimeMinutes: 10, builtin: false, skills: ["dup", "dup"] }],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain("duplicate skill")
    })

    test("validates overlong agent pins", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [{ id: "1", actionID: "x", label: "X", condition: "ok", command: "", maxTurns: 5, maxTimeMinutes: 10, builtin: false, agent: "x".repeat(81) }],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain("agent must be")
    })

    test("reports max chain steps exceeded", async () => {
      ;({ validateChainDraft } = await load())
      const bigSteps = Array.from({ length: 25 }, (_, i) => ({
        id: String(i), actionID: String(i), label: `S${i}`, condition: "x", command: "", maxTurns: 1, maxTimeMinutes: 1, builtin: false,
      }))
      const errors = validateChainDraft(bigSteps, { maxTurns: 50, maxTimeMinutes: 60 })
      expect(errors).toHaveLength(1)
      expect(errors[0].stepIndex).toBe(-1)
      expect(errors[0].message).toContain("Chain cannot have more than")
    })
  })
})

describe("actionCategoryShortLabel (compact routing labels)", () => {
  test("maps action categories to the short labels shown in rows and pickers", async () => {
    const { ACTION_CATEGORIES, actionCategoryShortLabel } = await load()
    expect(ACTION_CATEGORIES).toEqual([
      "All",
      "Planning",
      "Building",
      "Debugging",
      "Testing",
      "Review",
      "Documentation",
      "Custom",
    ])
    expect(ACTION_CATEGORIES.map(actionCategoryShortLabel)).toEqual([
      "All",
      "Plan",
      "Build",
      "Debug",
      "Verify",
      "Review",
      "Docs",
      "Custom",
    ])
  })
})

describe("handoffPanelMode (pending handoff visibility)", () => {
  test("keeps a pending handoff visible while a live goal is running, but only allows claim when idle", async () => {
    const { handoffPanelMode } = await load()
    const liveGoal: GoalState = {
      id: "live",
      condition: "Finish current run",
      status: "active",
      startedAt: 1,
      completedAt: null,
      turnsEvaluated: 0,
      tokensUsed: 0,
      lastEvaluation: null,
      evaluationHistory: [],
      constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    }
    const pendingHandoff: GoalHandoffStore = {
      handoff: {
        createdAt: "2026-06-19T12:00:00.000Z",
        state: {
          ...liveGoal,
          id: "handoff",
          condition: "Continue handed-off run",
          status: "paused",
        },
      },
      corrupt: false,
      loaded: true,
    }

    expect(handoffPanelMode(liveGoal, pendingHandoff)).toBe("pending")
    expect(handoffPanelMode(null, pendingHandoff)).toBe("claim")
    expect(handoffPanelMode(liveGoal, { handoff: null, corrupt: false, loaded: true })).toBe("hidden")
  })
})

describe("steerDraftDisposition (prompt admission failure)", () => {
  test("retains the steer draft when the note saves but prompt admission fails", async () => {
    const { steerDraftDisposition } = await load()

    expect(steerDraftDisposition({ commandSaved: true, promptAttempted: true, promptAdmitted: false })).toBe("retain")
    expect(steerDraftDisposition({ commandSaved: true, promptAttempted: true, promptAdmitted: true })).toBe("clear")
    expect(steerDraftDisposition({ commandSaved: true, promptAttempted: false, promptAdmitted: false })).toBe("clear")
    expect(steerDraftDisposition({ commandSaved: false, promptAttempted: true, promptAdmitted: false })).toBe("retain")
  })
})
