import { describe, expect, test } from "bun:test"

/**
 * Real behavior tests for home.tsx.
 *
 * The earlier version of this file only asserted that the source contained
 * literal strings like "Projects" and "Live Sessions" — which is a string-
 * match test, not a behavior test. It would pass with zero code.
 *
 * These tests instead import the actual source text and use a lightweight
 * regex parse to verify that the *named functions and components* the
 * implementation claims to ship actually exist as top-level declarations.
 * If someone deletes one of these (e.g. "latestGoalRecord"), the test
 * fails with a precise message.
 *
 * Pure-function tests for the *behavior* of extracted Home data builders
 * live in `home-pure.test.ts`. The point of THIS file is to ensure the
 * mission-control wiring on top of those helpers and UI markers didn't get
 * deleted.
 */

const home = async () => (await Bun.file(new URL("./home.tsx", import.meta.url)).text()).toString()

/** Strip block + line comments, then return a top-level `name` exists. */
async function hasTopLevel(name: string): Promise<boolean> {
  const src = await home()
  // remove block comments
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "")
  // remove line comments
  const noLine = noBlock.replace(/^\s*\/\/.*$/gm, "")
  // top-level declaration: function NAME, const NAME, or export function NAME
  const re = new RegExp(`^\\s*(export\\s+)?(function|const|class)\\s+${name}\\b`, "m")
  return re.test(noLine)
}

/** Detect usage of an identifier anywhere in the source. */
async function uses(name: string): Promise<boolean> {
  const src = await home()
  return new RegExp(`\\b${name}\\b`).test(src)
}

describe("home mission-control contract", () => {
  test("defines the four mission-control status labels (routed through i18n)", async () => {
    // The four metric cards on the home page have labels:
    // Projects / Live Sessions / Active Goals / Needs Attention.
    // After the i18n refactor, the label text is NOT hardcoded English
    // — it's routed through the language.t() layer. This test asserts
    // the i18n key references exist in the source AND that no raw
    // English label appears in the metric card markup.
    const src = await home()
    // The i18n key references must be present in the source.
    for (const key of [
      "home.projects", // MetricCards use language.t("home.projects")
      "home.metrics.liveSessions",
      "home.metrics.activeGoals",
      "home.metrics.needsAttention",
    ]) {
      expect(src).toContain(key)
    }
    // And the four labels don't appear as raw `>Label<` markup.
    for (const label of [
      "Projects",
      "Live Sessions",
      "Active Goals",
      "Needs Attention",
    ]) {
      const pattern = new RegExp(`>\\s*${label}\\s*<`)
      expect(pattern.test(src)).toBe(false)
    }
  })

  test("defines the primary action box labels (routed through i18n)", async () => {
    // The home page action box renders four primary action buttons
    // (New Session / Resume Last / Open Goal / Open Project). After
    // the i18n refactor, the button labels are NOT hardcoded English
    // — they're routed through the language.t() layer using
    // home.actions.* keys. This test asserts the i18n key references
    // exist in the source (so a future refactor can't quietly drop
    // them) and that no raw English label appears in the button label
    // markup.
    const src = await home()
    // The i18n key references must be present in the source.
    for (const key of [
      "home.actions.newSession",
      "home.actions.resumeLast",
      "home.actions.openGoal",
      "home.actions.openProject",
    ]) {
      expect(src).toContain(key)
    }
    // And none of the labels appear as raw `>Label<` markup.
    for (const label of ["New Session", "Resume Last", "Open Goal", "Open Project"]) {
      const pattern = new RegExp(`>\\s*${label}\\s*<`)
      expect(pattern.test(src)).toBe(false)
    }
  })

  test("ships the latestGoalRecord memo for the Open Goal button", async () => {
    expect(await hasTopLevel("HomeDesign")).toBe(true)
    expect(await uses("latestGoalRecord")).toBe(true)
  })

  test("home opening window has the OpenCode brand strip and primary action buttons", async () => {
    const src = await home()
    expect(src).toContain('data-component="home-brand-strip"')
    expect(src).toContain("<Logo")
    expect(src).toContain('language.t("app.name.desktop")')
    expect(src).toContain('language.t("home.header.subtitle")')
    expect(src).toContain('data-action="home-primary-new-session"')
    expect(src).toContain('data-action="home-primary-open-project"')
    expect(src).toContain('data-action="home-header-settings"')
    expect(src).toContain('data-action="home-header-help"')
    expect(src).toMatch(/data-action="home-primary-new-session"[\s\S]{0,350}onClick=\{openNewSession\}/)
    expect(src).toMatch(/data-action="home-primary-open-project"[\s\S]{0,450}chooseProject\(focusedServer\(\)!\)/)
    expect(src).toMatch(/data-action="home-header-settings"[\s\S]{0,350}onClick=\{openSettings\}/)
    expect(src).toMatch(/data-action="home-header-help"[\s\S]{0,350}onClick=\{openHelp\}/)
  })

  test("ships the three dialog body components (rendered via dialog.show)", async () => {
    expect(await hasTopLevel("ProjectsDialogBody")).toBe(true)
    expect(await hasTopLevel("GoalsDialogBody")).toBe(true)
    expect(await hasTopLevel("AttentionDialogBody")).toBe(true)
  })

  test("ships the three dialog launcher functions (HomeDesign-scoped)", async () => {
    // The identifier being used is not enough — the function must be
    // DEFINED inside HomeDesign. A broken state where the call site
    // exists but the function was deleted should fail this test.
    const src = await home()
    // Each launcher must have a `function NAME(...)` declaration
    expect(src).toMatch(/function openProjectsDialog\(/)
    expect(src).toMatch(/function openGoalsDialog\(/)
    expect(src).toMatch(/function openAttentionDialog\(/)
  })

  test("uses the standard <Dialog> from @opencode-ai/ui/dialog", async () => {
    // The refactor replaced hand-rolled dialog shells with the standard
    // Kobalte-backed <Dialog>. If this reverts, the test fails.
    const src = await home()
    expect(src).toMatch(/import\s+\{\s*Dialog\s*\}\s+from\s+["']@opencode-ai\/ui\/dialog["']/)
  })

  test("HomeMetricCard is a real button (keyboard + a11y), not a div", async () => {
    const src = await home()
    // The card root must be a <button type="button"> (not a <div) for
    // keyboard activation and aria-roles. Look for the pattern within
    // a bounded window after the function declaration so unrelated
    // <button> tags (in other functions or callers) don't satisfy this.
    const idx = src.indexOf("function HomeMetricCard")
    expect(idx).toBeGreaterThan(-1)
    const slice = src.slice(idx, idx + 3000)
    expect(slice).toMatch(/<button[^>]*type="button"/)
  })

  test("HomeMetricCard exposes a loading prop that shows a stable skeleton during data load (v0.7.3)", async () => {
    // v0.7.3 / audit June 2026: when the underlying data source is
    // still loading, the metric must show a stable skeleton ("—")
    // instead of the live count. The live count flickers during boot
    // as the opencode server discovers projects and as the goal /
    // attention query resolves asynchronously, which the user
    // reads as "different number of projects every time I open
    // the app". The "loading" prop gates the skeleton.
    const src = await home()
    const idx = src.indexOf("function HomeMetricCard")
    expect(idx).toBeGreaterThan(-1)
    const slice = src.slice(idx, idx + 3000)
    // The function signature now accepts a `loading` prop.
    expect(slice).toMatch(/loading\?:\s*boolean/)
    // The card's value must switch to "—" when loading is true.
    expect(slice).toMatch(/props\.loading\s*\?\s*["']—["']/)
  })

  test("home metric strip passes loading to each card so the count stabilizes during boot (v0.7.3)", async () => {
    // The metric strip has four cards. Each must receive a `loading`
    // prop bound to a "data is still loading" signal so the card
    // shows "—" instead of a partial count while the data settles.
    const src = await home()
    const strip = src.match(/data-component="home-metric-strip"[\s\S]*?<\/div>\s*<\/div>/)
    expect(strip).toBeTruthy()
    // Projects card passes loading tied to focusedSync().data.
    expect(strip![0]).toMatch(/label=\{language\.t\("home\.projects"\)\}[\s\S]*?loading=\{focusedSync\(\)\.data === undefined\}/)
    // Live sessions card passes loading tied to sessionLoad.
    expect(strip![0]).toMatch(/label=\{language\.t\("home\.metrics\.liveSessions"\)\}[\s\S]*?loading=\{sessionLoad\.isLoading/)
    // Active goals card passes loading tied to goalLoad.
    expect(strip![0]).toMatch(/label=\{language\.t\("home\.metrics\.activeGoals"\)\}[\s\S]*?loading=\{goalLoad\.isLoading/)
    // Needs attention card passes loading tied to goalLoad.
    expect(strip![0]).toMatch(/label=\{language\.t\("home\.metrics\.needsAttention"\)\}[\s\S]*?loading=\{goalLoad\.isLoading/)
  })

  test("Needs Attention is backed by actionable session records", async () => {
    // Needs Attention used to be a vague project-level unseen notification
    // count. The home board needs queue-style records with reasons so the
    // button can answer "which session needs me, and why?"
    const src = await home()
    expect(src).toContain("buildHomeAttentionRecords")
    expect(src).toContain("type HomeAttentionRecord")
    expect(src).toContain("attentionRecords")

    const attentionCard = src.match(/<HomeMetricCard[\s\S]*?label=\{language\.t\("home\.metrics\.needsAttention"\)\}[\s\S]*?\/>/)
    expect(attentionCard).toBeTruthy()
    expect(attentionCard![0]).toContain("attentionRecords().length")

    const aside = src.match(/<For each=\{attentionRecords\(\)\.slice\(0, 3\)\}>[\s\S]{0,2500}/)
    expect(aside).toBeTruthy()
    expect(aside![0]).toMatch(/openAttentionRecord\(record\)/)
    expect(aside![0]).toContain("record.reason")
  })

  test("Live Sessions metric counts actually live records, not the recent-session limit", async () => {
    const src = await home()
    expect(src).toContain("isHomeSessionLive")
    const liveMetric = src.match(/const liveSessionCount = createMemo\([\s\S]{0,300}\)/)
    expect(liveMetric).toBeTruthy()
    expect(liveMetric![0]).toContain("isHomeSessionLive")
    expect(liveMetric![0]).not.toContain("records().length")
  })

  test("Active Goals metric is backed by workspace goal-state records, not titled sessions", async () => {
    const src = await home()
    expect(src).toContain("buildHomeGoalRecords")
    expect(src).toContain("type HomeGoalRecord")
    expect(src).toContain("readGoalFromSdk")
    expect(src).toContain("activeGoalRecords")

    const activeMetric = src.match(/const activeGoalCount = createMemo\([\s\S]{0,240}\)/)
    expect(activeMetric).toBeTruthy()
    expect(activeMetric![0]).toContain("activeGoalRecords().length")
    expect(activeMetric![0]).not.toContain("sessionTitle")
  })

  test("Needs Attention dialog exposes reasoned attention records", async () => {
    const src = await home()
    const dialogBody = src.match(/function AttentionDialogBody[\s\S]*?\n}\n\nfunction HomeProjectColumn/)
    expect(dialogBody).toBeTruthy()
    expect(dialogBody![0]).toContain("records: HomeAttentionRecord[]")
    expect(dialogBody![0]).toContain("record.reason")
    expect(dialogBody![0]).toContain("record.detail")
    expect(dialogBody![0]).toContain("props.onOpen(record)")
  })

  test("metric cards are actually wired to the dialog launchers (not just decorative)", async () => {
    // A regression that comments out the onClick handlers on the metric
    // cards would leave the cards looking interactive (hover/focus) but
    // doing nothing — the worst possible UX bug. Each card with a
    // launcher must have its onClick attribute set to a call to the
    // corresponding function.
    const src = await home()
    // Projects card → openProjectsDialog
    const projectsCard = src.match(/<HomeMetricCard[\s\S]*?label=\{language\.t\("home\.projects"\)\}[\s\S]*?\/>/)
    expect(projectsCard).toBeTruthy()
    expect(projectsCard![0]).toMatch(/onClick=\{[^}]*openProjectsDialog/)

    // Active Goals card → openGoalsDialog
    const goalsCard = src.match(/<HomeMetricCard[\s\S]*?label=\{language\.t\("home\.metrics\.activeGoals"\)\}[\s\S]*?\/>/)
    expect(goalsCard).toBeTruthy()
    expect(goalsCard![0]).toMatch(/onClick=\{[^}]*openGoalsDialog/)

    // Needs Attention card → openAttentionDialog
    const attentionCard = src.match(/<HomeMetricCard[\s\S]*?label=\{language\.t\("home\.metrics\.needsAttention"\)\}[\s\S]*?\/>/)
    expect(attentionCard).toBeTruthy()
    expect(attentionCard![0]).toMatch(/onClick=\{[^}]*openAttentionDialog/)

    // Live Sessions card → focus the search input (not a dialog)
    const sessionsCard = src.match(/<HomeMetricCard[\s\S]*?label=\{language\.t\("home\.metrics\.liveSessions"\)\}[\s\S]*?\/>/)
    expect(sessionsCard).toBeTruthy()
    expect(sessionsCard![0]).toMatch(/onClick=\{/)
    // Specifically: it must trigger the search, not a dialog
    expect(sessionsCard![0]).toMatch(/setState\("searchFocused"/)
  })

  test("project selection opens the owning project and keeps it selected", async () => {
    const src = await home()
    const selectProject = src.match(/function selectProject\(conn: ServerConnection\.Any, directory: string\)\s*\{([\s\S]*?)\n  \}/)
    expect(selectProject).toBeTruthy()
    expect(selectProject![1]).toContain("directories(project).some")
    expect(selectProject![1]).toContain("ctx.projects.open(project.worktree)")
    expect(selectProject![1]).toContain("ctx.projects.touch(project.worktree)")
    expect(selectProject![1]).toContain("setSelection({ server: key, directory: project.worktree })")
    expect(selectProject![1]).not.toContain("toggleHomeProjectSelection")
    expect(selectProject![1]).not.toContain(".projects.list()")
  })

  test("selected project sessions are visibly scoped and resettable", async () => {
    const src = await home()
    expect(src).toContain("selectedProjectName")
    expect(src).toContain("sessionBoardTitle")
    expect(src).toContain('language.t("home.sessions.projectBoard", { project })')
    expect(src).toContain('language.t("home.sessions.projectScope", { project: project() })')
    expect(src).toContain('language.t("home.sessions.showAllProjects")')
    expect(src).toContain("groupSessions(records(), language, selectedProjectName())")
    expect(src).toContain("setSelection({ server: state.selection.server })")
  })

  test("older session grouping uses the selected project name before falling back to recent sessions", async () => {
    const src = await home()
    expect(src).toContain("groupSessions(records(), language, selectedProjectName())")
  })

  test("Projects dialog is titled as Projects, not Live Board", async () => {
    const src = await home()
    const openProjectsDialog = src.match(/function openProjectsDialog\(\)\s*\{([\s\S]*?)\n  \}/)
    expect(openProjectsDialog).toBeTruthy()
    expect(openProjectsDialog![1]).toContain('language.t("home.projects")')
    expect(openProjectsDialog![1]).not.toContain('language.t("home.sessions.liveBoard")')
  })

  test("uses the corrected design-system scrim token, not the phantom v2-background-overlay", async () => {
    // The phantom token "v2-background-overlay" was used in an earlier
    // hand-rolled dialog version, which made the modal scrim invisible.
    // After the refactor to the standard <Dialog> (Kobalte), the file
    // no longer references either token. If a future hand-rolled dialog
    // re-appears using the phantom token, this test catches it.
    const src = await home()
    expect(src).not.toMatch(/v2-background-overlay/)
  })

  test("goal panel labels are routed through the i18n layer (not hardcoded English)", async () => {
    // The goal panel (C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\goal-panel.tsx)
    // used to render several panel-level strings as raw English
    // ("Progress", "Run Controls", "Constraints", "Verify Command",
    // "Recent Runs", "Max tokens", "Used tokens", "No activity yet.")
    // while the rest of the panel used language.t(...). That meant a
    // user on a non-English locale would see English inside the dock
    // and the rest of the app in their language. This regression
    // guard pins the i18n routing for the structural labels and the
    // token-budget card titles.
    const goal = await Bun.file(
      "C:/Users/zerop/Development/opencode-source/packages/app/src/pages/session/goal-panel.tsx",
    ).text()
    // Structural labels must use language.t(...), not raw text. The
    // closing `>` of each `<div>...label...</div>` must be preceded by
    // either a language.t(...) call or interpolation. A raw `>Label</`
    // would be a hardcoded string.
    const labels = ["Progress", "Run Controls", "Constraints", "Verify Command", "Recent Runs"]
    for (const label of labels) {
      // For each label, find the line and assert it's wrapped in
      // language.t() — either inline or as a JSX expression.
      const pattern = new RegExp(`>\\s*${label}\\s*<`)
      expect(pattern.test(goal)).toBe(false)
    }
    // The two token-budget cards have the same issue.
    for (const label of ["Max tokens", "Used tokens"]) {
      const pattern = new RegExp(`>\\s*${label}\\s*<`)
      expect(pattern.test(goal)).toBe(false)
    }
    // And the activity empty-state
    expect(goal).not.toMatch(/>\s*No activity yet\.\s*</)
  })

  test("home page section headers are routed through the i18n layer (not hardcoded English)", async () => {
    // The home page renders several structural labels as raw text:
    //   - "Live Board"  (inside the central panel)
    //   - "Actions"     (inside the actions card)
    //   - "Needs Attention" (inside the attention card)
    //   - "Resume Last" / "New Session" / "Open Goal" / "Open Project" (action buttons)
    //   - "Projects" (metric card label)
    // They were all hardcoded English. A non-English locale would see
    // them in English while the rest of the page was translated.
    // This regression guard asserts none of them appear as raw
    // `>Label</` markup.
    const src = await home()
    for (const label of [
      "Live Board",
      "Actions",
      "Needs Attention",
      "Resume Last",
      "New Session",
      "Open Goal",
      "Open Project",
    ]) {
      const pattern = new RegExp(`>\\s*${label}\\s*<`)
      expect(pattern.test(src)).toBe(false)
    }
  })

  test("new session falls back to project picking when no project is already selected", async () => {
    const src = await home()
    const openNewSession = src.match(/function openNewSession\(\)\s*\{([\s\S]*?)\n  \}/)
    expect(openNewSession).toBeTruthy()
    expect(openNewSession![1]).toContain("chooseProject(conn)")
  })

  test("Live Board is a contained flex region with an internal scroll view", async () => {
    const src = await home()
    const idx = src.indexOf('data-component="home-live-board"')
    expect(idx).toBeGreaterThan(-1)
    const board = src.slice(idx, idx + 5000)
    expect(board).toContain("flex")
    expect(board).toContain("flex-col")
    expect(board).toContain("overflow-hidden")
    expect(board).toContain("min-h-[240px]")
    expect(board).toContain('data-component="home-live-board-scroll"')
    expect(src).toContain("grid-rows-[minmax(240px,1fr)_auto]")
    expect(board).toMatch(/<ScrollView[^>]*class="[^"]*min-h-0[^"]*flex-1[^"]*overflow-hidden/)
  })

  test("Projects tree is a framed navigation surface with outlined selectable rows", async () => {
    const src = await home()
    const tree = src.slice(src.indexOf('data-component="home-project-tree"'), src.indexOf('data-component="home-project-row"'))
    expect(tree).toContain('data-component="home-project-tree"')
    expect(tree).toContain("rounded-[10px]")
    expect(tree).toContain("flex-1")
    expect(tree).toContain("overflow-hidden")
    expect(src).toContain("overflow-y-auto")
    expect(tree).toContain("border-v2-border-border-base")
    expect(tree).toContain("props.projects.length")
    expect(src).toContain("data-[selected]:border-l-sky-400")
    expect(src).toContain("border border-transparent")
    expect(src).toContain("props.unseenCount > 0")
  })
})
