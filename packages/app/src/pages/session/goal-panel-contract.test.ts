import { describe, expect, test } from "bun:test"

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

  test("default built-ins are empty — only user-created actions appear in the library", async () => {
    const { DEFAULT_TEMPLATE_BUTTONS } = await load()
    expect(DEFAULT_TEMPLATE_BUTTONS).toEqual([])
  })

  test("returns project templates from the snapshot (no built-in defaults)", async () => {
    const { templateButtonsFromSnapshot } = await load()
    const out = templateButtonsFromSnapshot({
      version: 1,
      templates: [
        { id: "pass-tests", label: "Pass tests", description: "run tests", builtin: true },
        { id: "ship-it", label: "Ship it", description: "deploy", builtin: false },
      ],
    })
    expect(out.map((t) => t.id)).toEqual(["ship-it"])
    expect(out.at(-1)).toMatchObject({ id: "ship-it", label: "Ship it", builtin: false })
  })

  test("drops older project-specific built-ins when a snapshot still includes them", async () => {
    const { templateButtonsFromSnapshot, DEFAULT_TEMPLATE_BUTTONS } = await load()
    const out = templateButtonsFromSnapshot({
      version: 1,
      templates: [{ id: "pass-tests", label: "Pass tests", description: "run tests", builtin: true }],
    })
    // old project-specific "built-in" snapshots are filtered — only
    // user templates with `builtin: false` survive
    expect(out.filter((t) => !t.builtin)).toEqual([])
    expect(DEFAULT_TEMPLATE_BUTTONS).toEqual([])
  })

  test("drops entries with a malformed id and de-duplicates", async () => {
    const { templateButtonsFromSnapshot } = await load()
    const out = templateButtonsFromSnapshot({
      version: 1,
      templates: [
        { id: "ok-one", builtin: false },
        { id: "bad id!", builtin: false }, // space + bang → rejected
        { id: "../escape", builtin: false }, // path-y → rejected
        { id: "ok-one", builtin: false }, // duplicate → dropped
      ],
    })
    expect(out.map((t) => t.id)).toEqual(["ok-one"])
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

  describe("validateChainDraft", () => {
    let steps: Array<{ id: string; actionID: string; label: string; condition: string; command: string; maxTurns: number; maxTimeMinutes: number; builtin: boolean }>
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

    test("validates duplicate skills", async () => {
      ;({ validateChainDraft } = await load())
      const errors = validateChainDraft(
        [{ id: "1", actionID: "x", label: "X", condition: "ok", command: "", maxTurns: 5, maxTimeMinutes: 10, builtin: false, skills: ["dup", "dup"] }],
        { maxTurns: 20, maxTimeMinutes: 60 },
      )
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain("duplicate skill")
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
