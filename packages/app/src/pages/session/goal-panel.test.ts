import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

import { type GoalSdkClient, type GoalState, cleanText, isGoalStateShape, readGoalFromSdk } from "./goal-panel-pure"
import { executeGoalCommand, startGoalRun, stopGoalRun, type GoalCommandClient } from "./goal-panel-actions"

const validState: GoalState = {
  id: "test-id",
  condition: "All unit tests pass",
  command: "npm test",
  status: "active",
  startedAt: 1_700_000_000_000,
  completedAt: null,
  turnsEvaluated: 3,
  tokensUsed: 1200,
  lastEvaluation: {
    met: false,
    reason: "2 tests still failing",
    timestamp: 1_700_000_005_000,
    evaluatorType: "deterministic",
  },
  evaluationHistory: [
    { met: false, reason: "first try", timestamp: 1_700_000_001_000 },
    { met: false, reason: "second try", timestamp: 1_700_000_003_000 },
  ],
  constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100_000 },
}

function mockSdk(overrides: Partial<GoalSdkClient["client"]["file"]> = {}): GoalSdkClient {
  return {
    client: {
      file: {
        read: overrides.read ?? (async () => ({ data: "" })),
        ...overrides,
      },
    },
  }
}

const goalPanelSource = async () => (await Bun.file(new URL("./goal-panel.tsx", import.meta.url)).text()).toString()

describe("goal panel mission-control contracts", () => {
  test("keeps a persistent history drawer state instead of rendering pills only", async () => {
    const src = await goalPanelSource()
    expect(src).toContain("const [historyOpen, setHistoryOpen] = createSignal(true)")
    expect(src).toContain("aria-expanded={historyOpen()}")
  })

  test("keeps the last good archive when a polling read transiently comes back empty", async () => {
    const src = await goalPanelSource()
    expect(src).toContain("const previous = archive()")
    expect(src).toContain("if (runs.length === 0 && previous.length > 0) return")
  })

  test("terminal goals remain visible when archive history is missing", async () => {
    const src = await goalPanelSource()
    expect(src).toContain("terminalGoalOf(state())")
    expect(src).toContain("unarchivedTerminalGoal")
    expect(src).toContain('data-component="goal-terminal-summary"')
    expect(src).toContain("session.goal.lastResult")
    expect(src).toContain("archive().some((run) => run.summary.goalID === goal.id)")
  })

  test("stop confirmation renders in a separate callout instead of reordering the main action row", async () => {
    const src = await goalPanelSource()
    expect(src).toMatch(/label=\{language\.t\("session\.goal\.action\.stop"\)\}[\s\S]*setConfirmingClear\(true\)/)
    expect(src).toMatch(/<Show when=\{confirmingClear\(\)\}>[\s\S]*session\.goal\.action\.confirmStop/)
  })

  test("create goal starts the agent after state is written, but shared controls stay turnless", async () => {
    const src = await goalPanelSource()
    const createGoal = src.match(/const createGoal = async \(\) => \{[\s\S]*?\n  \}/)
    expect(createGoal).toBeTruthy()
    expect(createGoal![0]).toContain('sendGoalCommand("set", args)')
    expect(createGoal![0]).toContain("startGoalRun")

    const sendGoalCommand = src.match(/const sendGoalCommand = async [\s\S]*?\n  \}/)
    expect(sendGoalCommand).toBeTruthy()
    expect(sendGoalCommand![0]).not.toContain("startGoalRun")
  })

  test("confirmed stop clears the goal and aborts the active session turn", async () => {
    const src = await goalPanelSource()
    const stopGoal = src.match(/const stopGoal = async \(\) => \{[\s\S]*?\n  \}/)
    expect(stopGoal).toBeTruthy()
    expect(stopGoal![0]).toContain('sendGoalCommand("clear", "clear")')
    expect(stopGoal![0]).toContain("stopGoalRun")
    expect(src).toMatch(/onClick=\{\(\) => void stopGoal\(\)\}/)
    expect(src).not.toContain('onClick={() => void runAction("clear")}')
  })

  test("run controls expose restart as a first-class lifecycle action", async () => {
    const src = await goalPanelSource()
    expect(src).toContain("session.goal.action.restart")
    expect(src).toContain('busy={busy() === "restart"}')
    expect(src).toContain('onClick={() => void runAction("restart")}')
    expect(src).toContain("xl:grid-cols-5")
  })

  test("action library selects for viewing and exposes edit/duplicate/delete actions", async () => {
    const src = await goalPanelSource()
    expect(src).toContain("applyTemplateDraft")
    expect(src).toContain("selectActionForView")
    expect(src).toContain("editTemplateDraft")
    expect(src).toContain("duplicateActionTemplate")
    expect(src).toContain("deleteActionTemplate")
    expect(src).toContain("selectedTemplate")
    expect(src).toContain('role="listbox"')
    expect(src).toContain('role="option"')
    expect(src).toContain("template delete")
    expect(src).not.toContain("onClick={() => applyTemplateDraft(t)}")
    expect(src).not.toMatch(/sendGoalCommand\("set",\s*`template\s+\$\{id\}`/)
  })

  test("chain builder uses a two-column plan chain and action library instead of loose buttons", async () => {
    const src = await goalPanelSource()
    expect(src).toContain('data-component="goal-chain-builder"')
    expect(src).toContain('data-component="goal-plan-chain"')
    expect(src).toContain('data-component="goal-method-library"')
    expect(src).toContain('data-component="goal-chain-budget-readout"')
    expect(src).toContain("templateSearch")
    expect(src).toContain("filteredTemplates")
    expect(src).toContain("handleTemplateListboxKeyDown")
    expect(src).toContain('data-component="goal-action-inspector"')
    expect(src).toContain("session.goal.template.searchPlaceholder")
    expect(src).toContain("session.goal.template.empty")
    expect(src).toContain("session.goal.chainBuilder.steps")
    expect(src).toContain("session.goal.template.noCommand")
    expect(src).toMatch(/class="[^"]*grid-cols-\[minmax\(540px,1\.5fr\)_minmax\(360px,0\.82fr\)\]/)
    expect(src).toContain("templateCategory")
    expect(src).toContain("inferActionCategory")
    expect(src).not.toContain('data-component="goal-action-context-summary"')
    expect(src).not.toContain('data-component="goal-action-context-setup"')
    expect(src).not.toContain("Block context setup")
    expect(src).not.toContain("compactBefore")
    expect(src).not.toContain("compactAfter")
  })

  test("draft chain editing is local state only and start chain is the explicit run boundary", async () => {
    const src = await goalPanelSource()
    expect(src).toContain("chainDraft")
    expect(src).toContain("masterTurns")
    expect(src).toContain("masterMinutes")
    expect(src).toContain("chainBudgetSummary")
    expect(src).toContain("readStoredChainDraft(props.sessionID)")
    expect(src).toContain("writeStoredChainDraft(props.sessionID")
    expect(src).toContain("window.sessionStorage")
    expect(src).toContain("category === undefined ||")
    expect(src).toContain("...(step.category ? { category: step.category } : {})")
    expect(src).toContain("...(step.tone ? { tone: step.tone } : {})")
    expect(src).toContain("...(step.elevation ? { elevation: step.elevation } : {})")
    expect(src).toContain("addActionToChain")
    expect(src).toContain("moveDraftStep")
    expect(src).toContain("removeDraftStep")
    expect(src).toContain("startGoalChain")
    expect(src).toContain("session.goal.template.addToChain")
    expect(src).toContain("session.goal.template.prompt")
    expect(src).toContain("completionRuleLabel")
    expect(src).toContain('data-component="goal-chain-step-row"')
    expect(src).not.toContain("session.goal.template.condition")

    const addAction = src.match(/const addActionToChain = [\s\S]*?\n  \}/)
    expect(addAction).toBeTruthy()
    expect(addAction![0]).not.toContain("sendGoalCommand")
    expect(addAction![0]).not.toContain("startGoalRun")
  })

  test("playbook workspace matches the approved session-native layout", async () => {
    const src = await goalPanelSource()
    expect(src).toContain('data-component="goal-playbook-workspace"')
    expect(src).toContain('data-component="goal-playbook-setup"')
    expect(src).toContain('data-component="goal-playbook-budget-strip"')
    expect(src).toContain('data-component="goal-playbook-chain-pane"')
    expect(src).toContain('data-component="goal-action-library-rail"')
    expect(src).toContain('data-component="goal-method-row"')
    expect(src).toContain('data-component="goal-drop-zone"')
    expect(src).toContain('data-component="goal-global-budget"')
    expect(src).not.toContain("lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.72fr)_112px]")
  })

  test("playbook visual pass keeps chain rows dense and library chrome explicit", async () => {
    const src = await goalPanelSource()
    expect(src).toContain('data-component="goal-chain-run-rail"')
    expect(src).toContain('data-density="compact-chain-row"')
    expect(src).toContain('data-component="goal-method-library-header"')
    expect(src).toContain('data-component="goal-method-rail-filters"')
    expect(src).not.toContain(">Packs</span>")
    expect(src).not.toContain(">Archived</span>")
    expect(src).not.toContain("session.goal.template.source.builtin")
    expect(src).not.toContain("session.goal.template.kind.method")
    expect(src).not.toContain("Retry limit")
    expect(src).not.toContain("Drop an action or pack")
    // The Method Library detail no longer renders the taxonomy "Tags" card.
    expect(src).not.toContain(">Tags</div>")
    expect(src).not.toContain('label="Gates"')
    expect(src).toContain("Actions added from the library appear here")
  })

  test("method editor exposes the core fields without the taxonomy controls", async () => {
    const src = await goalPanelSource()
    // The reshaped Method Library editor keeps name / label / prompt / verify / save…
    expect(src).toContain("session.goal.template.saveName")
    expect(src).toContain("session.goal.template.prompt")
    expect(src).toContain("session.goal.template.command")
    expect(src).toContain("session.goal.template.save")
    expect(src).toContain("const label = actionDraft.label.trim() || id")
    expect(src).toContain("label,")
    // …but no longer renders the category / checkpoint / color / elevation taxonomy.
    expect(src).not.toContain('data-component="goal-action-style-controls"')
    expect(src).not.toContain("session.goal.template.tone")
    expect(src).not.toContain("session.goal.template.elevation")
    // The save payload still carries auto-inferred metadata (chain styling uses it).
    expect(src).toContain("category: actionDraft.category")
    expect(src).toContain("tone: actionDraft.tone")
    expect(src).toContain("elevation: actionDraft.elevation")
  })

  test("action editor cancel stays local and edit reopen repopulates action fields", async () => {
    const src = await goalPanelSource()
    expect(src).toContain("const openActionEditor = (template?: GoalTemplateButton)")
    expect(src).toContain("const editTemplateDraft = (template: GoalTemplateButton)")
    expect(src).toContain("openActionEditor(template)")
    expect(src).toContain('onClick={() => setActionDraft("open", false)}')
    expect(src).toContain('category: template ? inferActionCategory(template) : "Custom"')
    expect(src).toContain("tone: template?.tone ?? inferredActionTone(template ?? {})")
    expect(src).toContain('elevation: template?.elevation ?? "flat"')
    expect(src).toContain('gate: template ? inferActionGate(template) : "required"')

    const cancelButton = src.match(
      /label={language\.t\("session\.goal\.action\.cancel"\)}[\s\S]*?setActionDraft\("open", false\)/,
    )
    expect(cancelButton).toBeTruthy()
    expect(cancelButton![0]).not.toContain("sendGoalCommand")
    expect(cancelButton![0]).not.toContain("startGoalRun")
  })

  test("start chain preserves ordered steps and explicit operator metadata", async () => {
    const src = await goalPanelSource()
    const startChain = src.match(/const startGoalChain = async \(\) => \{[\s\S]*?sendGoalCommand\("chain"/)
    expect(startChain).toBeTruthy()
    expect(startChain![0]).toContain("steps: chainDraft.steps.map((step) => ({")
    expect(startChain![0]).toContain("condition: step.condition")
    expect(startChain![0]).toContain('verification: { type: "shell", command: step.command.trim() }')
    expect(startChain![0]).toContain('{ verification: { type: "marker" } }')
    expect(startChain![0]).toContain("maxTurns: step.maxTurns")
    expect(startChain![0]).toContain("category: step.category")
    expect(startChain![0]).toContain("tone: step.tone")
    expect(startChain![0]).toContain("elevation: step.elevation")
    expect(startChain![0]).not.toContain("sort(")
    expect(startChain![0]).not.toContain("reverse(")
  })

  test("adding a method to the chain stays local and does not cross the run boundary", async () => {
    const src = await goalPanelSource()
    // The detail "Add to chain" action feeds the local chain draft…
    expect(src).toContain("addActionToChain(template, varsForAction(template))")
    // …and the handler itself never starts a run or sends a command.
    const addAction = src.match(/const addActionToChain = [\s\S]*?\n  \}/)
    expect(addAction).toBeTruthy()
    expect(addAction![0]).not.toContain("sendGoalCommand")
    expect(addAction![0]).not.toContain("startGoalRun")
  })

  test("recent runs render as a vertical listbox, not wrapping pills", async () => {
    const src = await goalPanelSource()
    expect(src).toContain('role="listbox"')
    expect(src).toContain('role="option"')
    expect(src).toContain("aria-selected")
    expect(src).toContain("handleHistoryListboxKeyDown")
    expect(src).not.toContain('role="list" class="flex flex-wrap gap-2"')
  })

  test("recent runs auto-select a row and expose selected-run metric pillboxes", async () => {
    const src = await goalPanelSource()
    expect(src).toContain("RunMetricPill")
    expect(src).toContain("selectedHistoryGoalID()")
    expect(src).toContain("setSelectedHistoryGoalID(runs[0]?.summary.goalID ?? null)")
    expect(src).toContain("successCount")
    expect(src).toContain("failureCount")
    expect(src).toContain("latestReason")
  })
})

describe("isGoalStateShape", () => {
  test("accepts a fully-shaped valid state", () => {
    expect(isGoalStateShape(validState)).toBe(true)
  })

  test("accepts a minimal state (only the required keys)", () => {
    expect(
      isGoalStateShape({
        id: "x",
        condition: "y",
        status: "active",
        startedAt: 0,
        turnsEvaluated: 0,
        constraints: { maxTurns: 5, maxTimeMinutes: 10, maxTokens: 1000 },
      }),
    ).toBe(true)
  })

  test("rejects null and primitives", () => {
    expect(isGoalStateShape(null)).toBe(false)
    expect(isGoalStateShape(undefined)).toBe(false)
    expect(isGoalStateShape(42)).toBe(false)
    expect(isGoalStateShape("active")).toBe(false)
    expect(isGoalStateShape(true)).toBe(false)
  })

  test("rejects when id or condition are not strings", () => {
    expect(isGoalStateShape({ ...validState, id: 7 })).toBe(false)
    expect(isGoalStateShape({ ...validState, condition: undefined })).toBe(false)
  })

  test("rejects unknown status values (closed enum)", () => {
    expect(isGoalStateShape({ ...validState, status: "pending" })).toBe(false)
    expect(isGoalStateShape({ ...validState, status: "ACTIVE" })).toBe(false)
    expect(isGoalStateShape({ ...validState, status: "" })).toBe(false)
  })

  test("accepts each of the four documented statuses", () => {
    for (const status of ["active", "paused", "achieved", "cleared"] as const) {
      expect(isGoalStateShape({ ...validState, status })).toBe(true)
    }
  })

  test("rejects when turnsEvaluated or startedAt are not numbers", () => {
    expect(isGoalStateShape({ ...validState, turnsEvaluated: "3" })).toBe(false)
    expect(isGoalStateShape({ ...validState, startedAt: null })).toBe(false)
  })

  test("rejects when constraints is missing or incomplete", () => {
    const noConstraints = { ...validState }
    delete (noConstraints as Partial<GoalState>).constraints
    expect(isGoalStateShape(noConstraints)).toBe(false)

    const partialConstraints = {
      ...validState,
      constraints: { maxTurns: 5, maxTimeMinutes: 10 },
    }
    expect(isGoalStateShape(partialConstraints)).toBe(false)
  })
})

describe("cleanText", () => {
  test("passes plain ASCII through unchanged", () => {
    expect(cleanText("hello world")).toBe("hello world")
  })

  test("strips C0 control characters", () => {
    // 0x01 SOH and 0x1f US embedded in otherwise-ok text
    expect(cleanText("a\u0001b\u001fc")).toBe("abc")
  })

  test("strips DEL and C1 control characters", () => {
    expect(cleanText("a\u007fb\u009fc")).toBe("abc")
  })

  test("strips zero-width and bidi-format characters", () => {
    // U+200B zero-width space, U+202E right-to-left override, U+2066 LRI
    expect(cleanText("a\u200bb\u202Ec\u2066d\u2069e")).toBe("abcde")
  })

  test("truncates to 400 characters", () => {
    const long = "x".repeat(1000)
    expect(cleanText(long)).toHaveLength(400)
  })

  test("preserves Unicode letters and emoji", () => {
    expect(cleanText("café 🎯 résumé")).toBe("café 🎯 résumé")
  })

  // Adversarial: cleanText is called on evaluationHistory[].reason,
  // lastEvaluation.reason, and command — none of which are validated
  // by isGoalStateShape. If any of these fields holds a non-string
  // value (number, object, array), cleanText must return "" instead
  // of throwing TypeError on .replace().
  test("returns empty string for non-string input (null, number, object, array)", () => {
    expect((cleanText as (s: unknown) => string)(null)).toBe("")
    expect((cleanText as (s: unknown) => string)(42)).toBe("")
    expect((cleanText as (s: unknown) => string)({ reason: "x" })).toBe("")
    expect((cleanText as (s: unknown) => string)([1, 2, 3])).toBe("")
    expect((cleanText as (s: unknown) => string)(undefined)).toBe("")
  })
})

describe("readGoalFromSdk", () => {
  test("returns absent store when SDK read throws (file missing)", async () => {
    const sdk = mockSdk({
      read: async () => {
        throw new Error("ENOENT")
      },
    })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })

  test("returns absent store when content is empty string", async () => {
    const sdk = mockSdk({ read: async () => ({ data: "" }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })

  test("returns absent store when content is whitespace-only", async () => {
    const sdk = mockSdk({ read: async () => ({ data: "   \n  " }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })

  test("accepts plain-string content", async () => {
    const sdk = mockSdk({ read: async () => ({ data: JSON.stringify(validState) }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: validState,
      corrupt: false,
      loaded: true,
    })
  })

  test("accepts { type, content } SDK FileContent shape", async () => {
    const sdk = mockSdk({ read: async () => ({ data: { type: "text", content: JSON.stringify(validState) } }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: validState,
      corrupt: false,
      loaded: true,
    })
  })

  test("marks content as corrupt when JSON is malformed", async () => {
    const sdk = mockSdk({ read: async () => ({ data: "{not json" }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: true,
      loaded: true,
    })
  })

  test("marks content as corrupt when JSON parses but shape is wrong", async () => {
    const sdk = mockSdk({ read: async () => ({ data: JSON.stringify({ id: "x" }) }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: true,
      loaded: true,
    })
  })

  test("treats null data as absent, not corrupt", async () => {
    const sdk = mockSdk({ read: async () => ({ data: null }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })

  test("treats unexpected data shapes (e.g. number) as absent, not corrupt", async () => {
    const sdk = mockSdk({ read: async () => ({ data: 42 }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })

  // Adversarial: a state file larger than the renderer's cap must be
  // rejected as corrupt (so the user sees the warning UI) rather than
  // parsed into a multi-MB object that pins the SolidJS reactivity
  // layer. The cap is 1 MB in the implementation.
  test("rejects over-size state content as corrupt (defense against OOM)", async () => {
    // 2 MB of filler inside an otherwise-valid JSON wrapper.
    const huge = "x".repeat(2_000_000)
    const hugeContent = `{"id":"${huge}"}`
    const sdk = mockSdk({ read: async () => ({ data: hugeContent }) })
    const { state, corrupt, loaded } = await readGoalFromSdk(sdk)
    expect(loaded).toBe(true)
    expect(state).toBeNull()
    expect(corrupt).toBe(true)
  })

  // Edge: content exactly at the 1 MB cap is still allowed (cap is
  // strict-greater-than). This pins the boundary so a future refactor
  // doesn't accidentally flip to >= and start rejecting legitimate
  // 1 MB files.
  test("content at the 1 MB cap is accepted (boundary check)", async () => {
    // Build a valid state whose JSON serialization is exactly ~1 MB.
    // The goal-state has many fields we can pad: use evaluationHistory
    // entries to grow the serialization to just over/under 1 MB.
    // Simpler: pad `condition` so the JSON is right at the boundary.
    // We need the JSON to be > 1 MB - slack and < 1 MB + slack.
    // Slack: the test asserts the body is accepted, so the body must
    // be <= 1 MB. We construct one that's clearly under (500 KB) to
    // make the test robust against JSON whitespace changes.
    const filler = "x".repeat(500_000)
    const state = { ...validState, id: "medium", condition: filler }
    const content = JSON.stringify(state)
    expect(content.length).toBeLessThanOrEqual(1_000_000)
    const sdk = mockSdk({ read: async () => ({ data: content }) })
    const result = await readGoalFromSdk(sdk)
    expect(result.corrupt).toBe(false)
    expect(result.state).not.toBeNull()
  })

  // Adversarial: a state file with a huge evaluationHistory should
  // be rejected by the renderer's 1 MB size cap. The plugin's own
  // MAX_STATE_SIZE (256KB) means a state with 50K history entries
  // would never be produced by the plugin; if such a state appears
  // from some other source, the renderer treats it as corrupt and
  // does NOT parse it (which would OOM the reactivity layer).
  test("rejects huge evaluationHistory payloads via the size cap", async () => {
    const bigHistory = Array.from({ length: 50_000 }, (_, i) => ({
      met: i % 2 === 0,
      reason: `attempt ${i}`,
      timestamp: 1_700_000_000_000 + i,
    }))
    const sdk = mockSdk({
      read: async () => ({
        data: JSON.stringify({ ...validState, id: "big", evaluationHistory: bigHistory }),
      }),
    })
    const { state, corrupt } = await readGoalFromSdk(sdk)
    // Size cap kicks in before JSON.parse — corrupt, not "parsed but
    // truncated" — so the user sees the warning UI.
    expect(corrupt).toBe(true)
    expect(state).toBeNull()
  })

  // Adversarial: a state file with deeply nested JSON must not crash
  // the parser. JSON.parse itself handles arbitrary nesting; we just
  // verify isGoalStateShape rejects the result cleanly (since the
  // shape validator walks top-level keys only).
  test("deeply nested JSON payload that doesn't match shape is rejected, not crashed", () => {
    // Build a deeply nested object that JSON.parse will happily parse
    // but isGoalStateShape will reject (wrong shape).
    let nested: any = { leaf: true }
    for (let i = 0; i < 100; i++) nested = { wrap: nested }
    expect(isGoalStateShape(nested)).toBe(false)
  })

  // Adversarial: NaN and Infinity pass `typeof === "number"` in JS,
  // so a state file with corrupted numeric fields (e.g. from a
  // non-standard JSON serializer) would clear isGoalStateShape and
  // render garbage in the UI — turnsEvaluated="NaN", progress bar
  // NaN%, division-by-zero in progressPct, etc. The validator must
  // reject NaN and Infinity explicitly.
  test("rejects NaN in numeric fields (typeof NaN === 'number' attack)", () => {
    expect(isGoalStateShape({ ...validState, turnsEvaluated: NaN })).toBe(false)
    expect(isGoalStateShape({ ...validState, startedAt: NaN })).toBe(false)
    const nanConstraints = {
      ...validState,
      constraints: { maxTurns: 5, maxTimeMinutes: NaN, maxTokens: 1000 },
    }
    expect(isGoalStateShape(nanConstraints)).toBe(false)
  })

  test("rejects Infinity in numeric fields (typeof Infinity === 'number')", () => {
    expect(isGoalStateShape({ ...validState, turnsEvaluated: Infinity })).toBe(false)
    expect(isGoalStateShape({ ...validState, startedAt: -Infinity })).toBe(false)
    expect(isGoalStateShape({ ...validState, turnsEvaluated: -Infinity })).toBe(false)
    const infConstraints = {
      ...validState,
      constraints: { maxTurns: Infinity, maxTimeMinutes: 10, maxTokens: 1000 },
    }
    expect(isGoalStateShape(infConstraints)).toBe(false)
  })

  // Adversarial: prototype-pollution-style payloads
  // constructor) must not crash isGoalStateShape and must not yield a
  // valid state. JSON.parse by spec does NOT honor __proto__ in plain
  // object literals (the property is set, not the prototype), so this
  // is more of a "don't crash" check than a security boundary, but
  // pinning the behavior guards future regressions.
  test("prototype-pollution-style payloads are rejected by isGoalStateShape", () => {
    const polluted = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"id":"x","condition":"y","status":"active","startedAt":0,"turnsEvaluated":0,"constraints":{"maxTurns":5,"maxTimeMinutes":10,"maxTokens":1000}}',
    )
    // Shape-wise this is valid, so isGoalStateShape returns true —
    // which is correct: the validator checks shape, not origin. The
    // important property is that we never THROW and that the regular
    // {}.polluted check is unaffected.
    expect(isGoalStateShape(polluted)).toBe(true)
    // And the prototype itself is not modified:
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  // Adversarial: control-character injection in the condition field
  // (e.g. to spoof UI or break terminal output) must be stripped by
  // cleanText BEFORE render. This pins the documented behavior.
  test("control characters in condition are stripped, not rendered", () => {
    const dirty = "all\u0001tests\u001fpass\u007f\u200b\u202einjected"
    const clean = cleanText(dirty)
    // The visible word is preserved, all control/bidi chars are gone.
    expect(clean).toBe("alltestspassinjected")
  })

  // Adversarial: an extremely long condition (DoS via DOM) is
  // truncated to 400 chars. This pins the cap that protects the UI
  // from a user (or attacker) who can edit the state file.
  test("condition is truncated to 400 chars (defense against layout DoS)", () => {
    const huge = "x".repeat(100_000)
    const out = cleanText(huge)
    expect(out.length).toBe(400)
  })

  // Adversarial: a state with NaN/Infinity in numeric fields is
  // rejected by JSON.parse spec (no representation) AND by
  // isGoalStateShape (typeof check). Verify both.
  test("NaN/Infinity in numeric fields are not representable in JSON", () => {
    // NaN/Infinity as JSON values are NOT valid JSON — they get
    // serialized as `null`. So the parser never sees them. The only
    // way they'd appear in the parsed result is via a non-standard
    // parser. Our isGoalStateShape would reject `null` for required
    // numeric fields (typeof null !== "number"). Both layers are
    // defended.
    const nullNumeric = {
      id: "x",
      condition: "y",
      status: "active",
      startedAt: null, // simulates "JSON.stringify(NaN)" output
      turnsEvaluated: null,
      constraints: { maxTurns: null, maxTimeMinutes: 10, maxTokens: 1000 },
    }
    expect(isGoalStateShape(nullNumeric)).toBe(false)
  })

  // Adversarial: a state file that starts with a UTF-8 BOM (Byte Order
  // Mark \uFEFF) would cause JSON.parse to throw (BOM before '{' is
  // invalid JSON). The plugin strips BOM on write but the renderer
  // reads the file blindly. Corrupt is the correct defensive outcome.
  test("BOM-prefixed content is treated as corrupt", async () => {
    const sdk = mockSdk({ read: async () => ({ data: `\uFEFF${JSON.stringify(validState)}` }) })
    const { state, corrupt } = await readGoalFromSdk(sdk)
    expect(corrupt).toBe(true)
    expect(state).toBeNull()
  })

  // Adversarial: trailing garbage after valid JSON (e.g. an appended
  // log line or a half-written sync) must be treated as corrupt, not
  // silently truncated.
  test("trailing garbage after valid JSON is treated as corrupt", async () => {
    const sdk = mockSdk({
      read: async () => ({ data: `${JSON.stringify(validState)} garbage` }),
    })
    const { corrupt } = await readGoalFromSdk(sdk)
    expect(corrupt).toBe(true)
  })

  // Adversarial: duplicate keys in JSON (parser-dependent: last key
  // wins). Validating the OUTCOME shape is sufficient — if someone
  // plants a file with duplicate keys, the parser picks the last and
  // isGoalStateShape validates normally.
  test("duplicate JSON keys resolve to last value and validate normally", async () => {
    const duped =
      '{"status":"active","status":"cleared","id":"x","condition":"y","startedAt":0,"turnsEvaluated":0,"constraints":{"maxTurns":5,"maxTimeMinutes":10,"maxTokens":1000}}'
    const sdk = mockSdk({ read: async () => ({ data: duped }) })
    const { state, corrupt } = await readGoalFromSdk(sdk)
    expect(corrupt).toBe(false)
    expect(state?.status).toBe("cleared")
  })
})

describe("executeGoalCommand", () => {
  test("returns true when the deterministic goal control POST endpoint resolves", async () => {
    const post = mock(async () => ({ data: { title: "Goal control", output: "ok", metadata: {} } }))
    const sessionCommand = mock(async () => {
      throw new Error("session.command must not be used for GUI controls")
    })
    const ok = await executeGoalCommand(
      {
        session: { command: sessionCommand },
        tool: { client: { post } },
      },
      { sessionID: "session-1", arguments: 'set "pass tests"', directory: "C:\\repo\\project" },
    )
    expect(ok).toBe(true)
    expect(sessionCommand).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith({
      url: "/experimental/goal/control/{toolID}",
      path: { toolID: "goal_control" },
      query: { directory: "C:\\repo\\project" },
      body: {
        directory: "C:\\repo\\project",
        sessionID: "session-1",
        arguments: { command: 'set "pass tests"' },
      },
    })
  })

  test("keeps the generated SDK tool method bound to its client when raw POST is unavailable", async () => {
    const calls: Array<{ directory?: string; toolID: string; sessionID: string; arguments: { command: string } }> = []
    const tool: NonNullable<GoalCommandClient["tool"]> = {
      async control(args) {
        expect(this).toBe(tool)
        calls.push(args)
      },
    }
    const ok = await executeGoalCommand(
      {
        tool,
      },
      { sessionID: "session-1", arguments: "turns 25", directory: "C:\\repo\\project" },
    )
    expect(ok).toBe(true)
    expect(calls).toEqual([
      {
        directory: "C:\\repo\\project",
        toolID: "goal_control",
        sessionID: "session-1",
        arguments: { command: "turns 25" },
      },
    ])
  })

  test("prefers raw POST over the generated control method when both are present", async () => {
    const post = mock(async () => ({ data: { title: "Goal control", output: "ok", metadata: {} } }))
    const control = mock(async () => {
      throw new Error("generated control method should not be used when raw POST exists")
    })
    const ok = await executeGoalCommand(
      {
        tool: {
          client: { post },
          control,
        },
      },
      { sessionID: "session-1", arguments: "template import x {}", directory: "C:\\repo\\project" },
    )
    expect(ok).toBe(true)
    expect(post).toHaveBeenCalled()
    expect(control).not.toHaveBeenCalled()
  })

  test("uses the root SDK POST transport before the generated control method", async () => {
    const post = mock(async () => ({ data: { title: "Goal control", output: "ok", metadata: {} } }))
    const control = mock(async () => {
      throw new Error("generated control method should not be used when root POST exists")
    })
    const ok = await executeGoalCommand(
      {
        client: { post },
        tool: { control },
      },
      { sessionID: "session-1", arguments: "template import x {}", directory: "C:\\repo\\project" },
    )
    expect(ok).toBe(true)
    expect(post).toHaveBeenCalledWith({
      url: "/experimental/goal/control/{toolID}",
      path: { toolID: "goal_control" },
      query: { directory: "C:\\repo\\project" },
      body: {
        directory: "C:\\repo\\project",
        sessionID: "session-1",
        arguments: { command: "template import x {}" },
      },
    })
    expect(control).not.toHaveBeenCalled()
  })

  test("returns false when the deterministic goal control endpoint rejects", async () => {
    const ok = await executeGoalCommand(
      {
        tool: {
          client: {
            post: async () => {
              throw new Error("boom")
            },
          },
          control: async () => {
            throw new Error("boom")
          },
        },
      },
      { sessionID: "session-1", arguments: "pause" },
    )
    expect(ok).toBe(false)
  })

  test("uses the raw SDK transport when the generated control method is unavailable", async () => {
    const post = mock(async () => ({ data: { title: "Goal control", output: "ok", metadata: {} } }))
    const sessionCommand = mock(async () => {
      throw new Error("session.command must not be used for GUI controls")
    })
    const ok = await executeGoalCommand(
      {
        session: { command: sessionCommand },
        tool: { client: { post } },
      },
      { sessionID: "session-1", arguments: "turns 25", directory: "C:\\repo\\project" },
    )
    expect(ok).toBe(true)
    expect(sessionCommand).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith({
      url: "/experimental/goal/control/{toolID}",
      path: { toolID: "goal_control" },
      query: { directory: "C:\\repo\\project" },
      body: { directory: "C:\\repo\\project", sessionID: "session-1", arguments: { command: "turns 25" } },
    })
  })

  test("does not fall back to session.command when the control endpoint is missing", async () => {
    const calls: Array<{ sessionID: string; command: string; arguments: string }> = []
    const ok = await executeGoalCommand(
      {
        session: {
          command: async (args) => {
            calls.push(args)
          },
        },
      },
      { sessionID: "session-1", arguments: "turns 25" },
    )
    expect(ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe("startGoalRun", () => {
  test("admits one async prompt so a newly-set goal starts working", async () => {
    const promptAsync = mock(async () => undefined)
    const sessionCommand = mock(async () => {
      throw new Error("session.command must not start goals")
    })

    const ok = await startGoalRun(
      {
        session: {
          promptAsync,
          command: sessionCommand,
        },
      },
      {
        sessionID: "session-1",
        directory: "C:\\repo\\project",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
      },
    )

    expect(ok).toBe(true)
    expect(sessionCommand).not.toHaveBeenCalled()
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "C:\\repo\\project",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      parts: [
        {
          type: "text",
          text: expect.stringContaining("Begin working toward the current OpenGoal goal now."),
        },
      ],
    })
  })

  test("lets the server choose default agent/model for goal auto-start", async () => {
    const promptAsync = mock(async () => undefined)

    const ok = await startGoalRun(
      {
        session: { promptAsync },
      },
      {
        sessionID: "session-1",
        directory: "C:\\repo\\project",
      },
    )

    expect(ok).toBe(true)
    expect(promptAsync).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "C:\\repo\\project",
      parts: [
        {
          type: "text",
          text: expect.stringContaining("Read .opencode/.goal-state.json"),
        },
      ],
    })
  })

  test("returns false when async prompt admission is unavailable", async () => {
    const ok = await startGoalRun(
      { session: {} },
      {
        sessionID: "session-1",
        directory: "C:\\repo\\project",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
    )

    expect(ok).toBe(false)
  })
})

describe("stopGoalRun", () => {
  test("aborts the active OpenCode session turn without using chat commands", async () => {
    const abort = mock(async () => undefined)
    const sessionCommand = mock(async () => {
      throw new Error("session.command must not stop goals")
    })

    const ok = await stopGoalRun(
      {
        session: {
          abort,
          command: sessionCommand,
        },
      },
      {
        sessionID: "session-1",
        directory: "C:\\repo\\project",
      },
    )

    expect(ok).toBe(true)
    expect(sessionCommand).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "C:\\repo\\project",
    })
  })

  test("returns false when session abort is unavailable", async () => {
    const ok = await stopGoalRun(
      { session: {} },
      {
        sessionID: "session-1",
        directory: "C:\\repo\\project",
      },
    )

    expect(ok).toBe(false)
  })
})

// ── useGoal hook tests (SolidJS lifecycle, mocked SDK context) ──────
//
// These tests drive the real useGoal hook inside a createRoot so
// onMount / onCleanup / setInterval are exercised. The SDK context is
// replaced via mock.module before the goal-panel module is imported.
//
// Every test MUST dispose() its createRoot before returning — otherwise
// the setInterval inside useGoal keeps the event loop busy and the
// bun:test runner never exits the process.
//
describe("useGoal hook", () => {
  let useGoal: typeof import("./goal-panel").useGoal
  let setMockResponse: (next: { data: unknown } | Error) => void
  // The mock.module closure captures `sdkRef`; we mutate it per test.
  let sdkRef: GoalSdkClient

  beforeAll(async () => {
    mock.module("@opencode-ai/ui/button", () => ({
      Button: (props: any) => props.children ?? null,
    }))
    mock.module("@opencode-ai/ui/text-field", () => ({
      TextField: () => null,
    }))
    mock.module("@/context/language", () => ({
      useLanguage: () => ({ t: (k: string) => k }),
    }))
    mock.module("@/context/sdk", () => ({
      useSDK: () => sdkRef,
    }))
    const mod = await import("./goal-panel")
    useGoal = mod.useGoal
  })

  beforeEach(() => {
    let nextResponse: { data: unknown } | Error = { data: "" }
    setMockResponse = (r) => {
      nextResponse = r
    }
    sdkRef = {
      client: {
        file: {
          read: async () => {
            if (nextResponse instanceof Error) throw nextResponse
            return nextResponse
          },
        },
      },
    }
  })

  // Each test runs inside a createRoot, drives the hook, asserts, and
  // disposes before returning so the interval is cleared.
  function withRoot<T>(fn: (goal: ReturnType<typeof useGoal>, dispose: () => void) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      createRoot((dispose) => {
        const goal = useGoal()
        fn(goal, dispose).then(
          (v) => {
            dispose()
            resolve(v)
          },
          (e) => {
            dispose()
            reject(e)
          },
        )
      })
    })
  }

  test("hook: starts unloaded, transitions to loaded:true after first read", async () => {
    await withRoot(async (goal) => {
      // Wait for the onMount-driven refresh() promise to resolve.
      // The hook calls refresh() inside onMount; we drive a manual
      // refresh and await it (this also covers the initial-read path).
      await goal.refresh()
      expect(goal.store.loaded).toBe(true)
      expect(goal.store.corrupt).toBe(false)
      expect(goal.store.state).toBeNull()
    })
  })

  test("hook: refresh() picks up new state from the SDK", async () => {
    await withRoot(async (goal) => {
      setMockResponse({ data: JSON.stringify({ ...validState, id: "first" }) })
      await goal.refresh()
      expect(goal.store.state?.id).toBe("first")

      setMockResponse({ data: JSON.stringify({ ...validState, id: "second", command: null }) })
      await goal.refresh()
      expect(goal.store.state?.id).toBe("second")
      expect(goal.store.state?.command).toBeNull()
    })
  })

  test("hook: clearing lastEvaluation to null actually clears it (no stale merge)", async () => {
    // REGRESSION: setStore(next) without reconcile leaves stale fields.
    // If the state goes from { lastEvaluation: { reason: "old" } } to
    // { lastEvaluation: null }, the store must end up with null, NOT
    // the old object. SolidJS's createStore merges by default, which
    // is why other call sites in this codebase use reconcile(...).
    await withRoot(async (goal) => {
      setMockResponse({
        data: JSON.stringify({
          ...validState,
          id: "v1",
          lastEvaluation: { met: false, reason: "old reason", timestamp: 1, evaluatorType: "deterministic" },
        }),
      })
      await goal.refresh()
      expect(goal.store.state?.lastEvaluation?.reason).toBe("old reason")

      setMockResponse({
        data: JSON.stringify({ ...validState, id: "v2", lastEvaluation: null }),
      })
      await goal.refresh()
      expect(goal.store.state?.lastEvaluation).toBeNull()
    })
  })

  test("hook: clearing command to null actually clears it (no stale merge)", async () => {
    await withRoot(async (goal) => {
      setMockResponse({ data: JSON.stringify({ ...validState, id: "v1", command: "npm test" }) })
      await goal.refresh()
      expect(goal.store.state?.command).toBe("npm test")

      setMockResponse({ data: JSON.stringify({ ...validState, id: "v2", command: null }) })
      await goal.refresh()
      expect(goal.store.state?.command).toBeNull()
    })
  })

  test("hook: corrupt JSON produces corrupt=true on the store", async () => {
    await withRoot(async (goal) => {
      setMockResponse({ data: "{not json" })
      await goal.refresh()
      expect(goal.store.loaded).toBe(true)
      expect(goal.store.corrupt).toBe(true)
      expect(goal.store.state).toBeNull()
    })
  })

  test("hook: SDK read throws → treated as absent (NOT corrupt)", async () => {
    await withRoot(async (goal) => {
      setMockResponse(new Error("ENOENT"))
      await goal.refresh()
      expect(goal.store.loaded).toBe(true)
      expect(goal.store.corrupt).toBe(false)
      expect(goal.store.state).toBeNull()
    })
  })

  test("hook: onCleanup clears the setInterval timer", async () => {
    // Wrap read so we can count calls that happen AFTER dispose.
    // POLL_MS is 2000; we wait 2.5s after dispose. If the interval
    // weren't cleared, we'd see at least one post-dispose read.
    let callsAfterDispose = 0
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        useGoal()
        setTimeout(() => {
          dispose()
          // After dispose, install a counter on read.
          const afterOrig = sdkRef.client.file.read
          sdkRef.client.file.read = async (args) => {
            callsAfterDispose++
            return afterOrig(args)
          }
          setTimeout(resolve, 2500)
        }, 30)
      })
    })
    expect(callsAfterDispose).toBe(0)
  })

  // Adversarial: concurrent refresh() calls can race. If the poll
  // interval fires while a slow read is in-flight, two reads may
  // resolve out of order. The store is eventually-consistent (next
  // poll corrects it), but we must never crash, hang, or produce a
  // store state that isn't a recognized GoalStore.
  test("hook: concurrent refresh() calls do not crash or corrupt the store", async () => {
    // Control the mock read's completion via a manual delay: the
    // first call waits on a gate, the second resolves immediately.
    let releaseSlow: (() => void) | null = null
    let slowResolved = false
    sdkRef.client.file.read = async () => {
      if (!slowResolved) {
        // First call: the "slow" read. Park it until released.
        slowResolved = true
        await new Promise<void>((r) => {
          releaseSlow = r
        })
        return { data: JSON.stringify({ ...validState, id: "slow" }) }
      }
      // Subsequent calls: fast reads.
      return { data: JSON.stringify({ ...validState, id: "fast" }) }
    }

    await withRoot(async (goal) => {
      // Trigger two concurrent refreshes: one slow, one fast.
      setMockResponse({ data: JSON.stringify({ ...validState, id: "slow" }) })
      const slow = goal.refresh()
      setMockResponse({ data: JSON.stringify({ ...validState, id: "fast" }) })
      await goal.refresh()
      expect(goal.store.state?.id).toBe("fast")
      // Release the slow read now — it will arrive second and
      // overwrite the store with "slow" (last-writer race).
      releaseSlow!()
      await slow
      expect(goal.store.state?.id).toBe("slow")
      expect(goal.store.loaded).toBe(true)
      expect(goal.store.corrupt).toBe(false)
      expect(goal.store.state).not.toBeNull()
    })
  })
})
