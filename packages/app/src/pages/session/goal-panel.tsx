import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"

import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"

import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

/**
 * Goal tab — renders the opencode-autogoal plugin's state file
 * (`.opencode/.goal-state.json`) in the session side panel.
 *
 * Data contract: docs/gui-integration.md in the opencode-autogoal repo.
 * The renderer polls via `sdk.client.file.read` every 2 seconds (the
 * plugin has no event-emit API; polling is the documented live-update
 * mechanism). The state file is user-controlled, so everything is
 * structurally validated before rendering and string fields are
 * stripped of control characters.
 */

const POLL_MS = 2000
const STATE_PATH = ".opencode/.goal-state.json"
/** Hard cap on the state-file body we are willing to JSON.parse.
 *  The opencode-autogoal plugin caps writes at 256KB, but the renderer
 *  can't import that constant across repos. A 1MB cap gives a generous
 *  margin (4x the plugin's max) and prevents an accidentally-huge or
 *  malicious state file from OOM-ing the SolidJS renderer's reactivity
 *  layer (which would touch the parsed object on every poll). */
const MAX_RENDERER_STATE_BYTES = 1 * 1024 * 1024

/** Minimal mirror of the plugin's GoalState — only the fields this
 *  panel renders. The plugin's own validateGoalState is not importable
 *  across repos; `isGoalStateShape` below is the structural gate. */
export interface GoalState {
  /** Schema version from the plugin. Optional for backward compat with
   *  pre-v0.5.0 state files; mandatory for future migration logic. */
  version?: number
  id: string
  condition: string
  command?: string | null
  status: "active" | "paused" | "achieved" | "cleared"
  startedAt: number
  completedAt: number | null
  turnsEvaluated: number
  tokensUsed: number
  lastEvaluation: {
    met: boolean
    reason: string
    timestamp: number
    evaluatorType: "deterministic" | "model" | "heuristic"
  } | null
  evaluationHistory: Array<{ met: boolean; reason: string; timestamp: number }>
  constraints: {
    maxTurns: number
    maxTimeMinutes: number
    maxTokens: number
  }
}

const GOAL_STATUSES = new Set(["active", "paused", "achieved", "cleared"])

/** Structural gate for a parsed goal-state payload. Exported for unit
 *  tests (and for any future consumer in the renderer). This is the
 *  renderer's trust boundary: anything that fails this check renders as
 *  a "corrupt" UI state, never as a typed GoalState. */
export function isGoalStateShape(v: unknown): v is GoalState {
  if (!v || typeof v !== "object") return false
  const s = v as Record<string, unknown>
  if (typeof s.id !== "string" || typeof s.condition !== "string") return false
  if (typeof s.status !== "string" || !GOAL_STATUSES.has(s.status)) return false
  if (typeof s.turnsEvaluated !== "number" || !Number.isFinite(s.turnsEvaluated)) return false
  if (typeof s.startedAt !== "number" || !Number.isFinite(s.startedAt)) return false
  const c = s.constraints as Record<string, unknown> | undefined
  if (!c || typeof c !== "object") return false
  if (
    typeof c.maxTurns !== "number" || !Number.isFinite(c.maxTurns) ||
    typeof c.maxTimeMinutes !== "number" || !Number.isFinite(c.maxTimeMinutes) ||
    typeof c.maxTokens !== "number" || !Number.isFinite(c.maxTokens)
  )
    return false
  return true
}

/** Strip C0/C1 control chars and Unicode bidi/format chars before
 *  rendering user-controlled text (same character classes the plugin's
 *  sanitizeForPrompt drops). Accepts unknown — returns "" for non-string
 *  input — so a corrupted state file with a non-string in
 *  evaluationHistory[].reason, lastEvaluation.reason, or command
 *  cannot crash the renderer via .replace(). Exported so tests can
 *  pin the behavior. */
export function cleanText(s: unknown): string {
  if (typeof s !== "string") return ""
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").slice(0, 400)
}

/** Minimal shape of the SDK client surface the hook needs. Defined
 *  here so tests can pass a mock without pulling the whole context. */
export interface GoalSdkClient {
  client: {
    file: {
      read: (args: { path: string }) => Promise<{ data: unknown }>
    }
  }
}

/** Pure fetch + parse. Pulled out of the hook so it can be unit-tested
 *  with a mock SDK and so the hook itself stays a thin lifecycle
 *  wrapper. Returns the next store snapshot the caller should apply. */
export async function readGoalFromSdk(sdk: GoalSdkClient): Promise<GoalStore> {
  try {
    const res = await sdk.client.file.read({ path: STATE_PATH })
    // The SDK's FileContent is `{ type, content }` (object), but accept a
    // plain string too so an SDK shape change degrades to "still works"
    // rather than a silently-hidden tab.
    const raw: unknown = res.data
    const content =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && typeof (raw as { content?: unknown }).content === "string"
          ? (raw as { content: string }).content
          : null
    if (!content || content.trim().length === 0) {
      return { state: null, corrupt: false, loaded: true }
    }
    // Cap BEFORE JSON.parse: a multi-GB string would force the parser
    // to allocate proportional memory, and the resulting object would
    // pin the renderer even though we'd never display it. Treat
    // over-size as corrupt so the user sees the warning UI.
    if (content.length > MAX_RENDERER_STATE_BYTES) {
      return { state: null, corrupt: true, loaded: true }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return { state: null, corrupt: true, loaded: true }
    }
    if (!isGoalStateShape(parsed)) {
      return { state: null, corrupt: true, loaded: true }
    }
    return { state: parsed, corrupt: false, loaded: true }
  } catch {
    // Read error: file missing or unreadable. A missing file is the
    // normal "no goal" case — never alarm on it.
    return { state: null, corrupt: false, loaded: true }
  }
}

export interface GoalStore {
  state: GoalState | null
  corrupt: boolean
  loaded: boolean
}

/**
 * Poll the goal state file. Distinguishes:
 *  - absent (read failed or empty content) → state null, corrupt false
 *  - corrupt (content present but unparseable / wrong shape) → corrupt true
 *  - ok → state set
 * The poll interval matches the plugin's documented 2s recommendation.
 */
export function useGoal() {
  const sdk = useSDK()
  const [store, setStore] = createStore<GoalStore>({ state: null, corrupt: false, loaded: false })

  const refresh = async () => {
    const next = await readGoalFromSdk(sdk as unknown as GoalSdkClient)
    setStore(next)
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  return { store, refresh }
}

function ProgressBar(props: { pct: number; status: "active" | "paused" | "achieved" }) {
  const pct = () => Math.min(100, Math.max(0, props.pct))
  return (
    <div
      class="h-2.5 w-full rounded-full bg-background-stronger overflow-hidden"
      role="progressbar"
      aria-valuenow={pct()}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        class="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
        classList={{
          "bg-icon-success-base": props.status !== "paused",
          "bg-icon-warning-base": props.status === "paused",
        }}
        style={{ width: `${pct()}%` }}
      />
    </div>
  )
}

/** Minimal shape of the SDK surface the action buttons need: the
 *  session.command endpoint, which runs OpenGoal's registered `/goal`
 *  command deterministically (the plugin's command.execute.before mutates
 *  the state file). Same call the prompt input uses (submit.ts). */
interface GoalActionClient {
  directory?: string
  client: {
    session: {
      command: (args: { sessionID: string; command: string; arguments: string }) => Promise<unknown>
    }
  }
}

type GoalAction = "pause" | "resume" | "restart" | "clear"

function ActionButton(props: {
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  variant?: "primary" | "secondary" | "ghost"
  label: string
}) {
  return (
    <Button
      variant={props.variant ?? "secondary"}
      size="small"
      onClick={() => props.onClick()}
      disabled={props.disabled}
      aria-label={props.label}
    >
      {props.busy ? "…" : props.label}
    </Button>
  )
}

export function GoalPanel(props: { goal: { store: GoalStore; refresh: () => Promise<void> }; sessionID?: string }) {
  const language = useLanguage()
  const sdk = useSDK() as unknown as GoalActionClient
  const state = () => props.goal.store.state

  const [busy, setBusy] = createSignal<GoalAction | "set" | "steer" | "budget" | null>(null)
  const [confirmingClear, setConfirmingClear] = createSignal(false)
  const [newCondition, setNewCondition] = createSignal("")
  const [newCommand, setNewCommand] = createSignal("")
  const [steerOpen, setSteerOpen] = createSignal(false)
  const [steerText, setSteerText] = createSignal("")
  const [editingBudget, setEditingBudget] = createSignal<"turns" | "time" | null>(null)
  const [budgetText, setBudgetText] = createSignal("")
  // When true, show the create form even though a goal exists (the "New goal"
  // affordance), so the panel is never a dead end — including on achieved goals.
  const [showCreate, setShowCreate] = createSignal(false)

  /** Send a `/goal <args>` command to the current session. The plugin handles
   *  it deterministically (atomic state write); the 2s poll + the refresh here
   *  surface the result in the panel. Returns false (no-op) without a session. */
  const sendGoalCommand = async (label: GoalAction | "set" | "steer" | "budget", args: string): Promise<boolean> => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return false
    setBusy(label)
    try {
      await sdk.client.session.command({ sessionID, command: "goal", arguments: args })
    } catch {
      // Swallow — the refresh below reflects whatever actually happened on disk.
    } finally {
      await props.goal.refresh()
      setBusy(null)
      setConfirmingClear(false)
      if (label === "set") setShowCreate(false)
    }
    return true
  }

  const runAction = (action: GoalAction) => sendGoalCommand(action, action)

  /** Create a goal from the panel's form. Quotes are stripped so they can't
   *  break the `/goal set "<condition>"` quoting; the condition is required,
   *  the verify command optional. */
  const createGoal = async () => {
    const condition = newCondition().trim().replace(/"/g, "")
    if (!condition) return
    const command = newCommand().trim().replace(/"/g, "")
    const args = command ? `set "${condition}" --command "${command}"` : `set "${condition}"`
    const sent = await sendGoalCommand("set", args)
    if (sent) {
      setNewCondition("")
      setNewCommand("")
    }
  }

  /** Add a steering note: `/goal steer "<note>"`. The plugin shows it to the
   *  agent on the next nudge. */
  const steerGoal = async () => {
    const note = steerText().trim().replace(/"/g, "")
    if (!note) return
    const sent = await sendGoalCommand("steer", `steer "${note}"`)
    if (sent) {
      setSteerText("")
      setSteerOpen(false)
    }
  }

  /** Built-in quick-start templates the plugin ships (src/templates.ts). One
   *  click runs `/goal template <id>`, which sets the goal + verify command. */
  const TEMPLATES: Array<{ id: string; label: string }> = [
    { id: "pass-tests", label: "Pass tests" },
    { id: "fix-lint", label: "Fix lint" },
    { id: "fix-types", label: "Fix types" },
  ]
  const useTemplate = (id: string) => sendGoalCommand("set", `template ${id}`)

  /** Raise/lower a live budget by clicking the turns/time readout. Maps to the
   *  engine dials `/goal turns <n>` and `/goal time <n>`. */
  const openBudget = (field: "turns" | "time", current: number) => {
    setBudgetText(String(current))
    setEditingBudget(field)
  }
  const submitBudget = async () => {
    const field = editingBudget()
    const n = parseInt(budgetText().trim(), 10)
    if (!field || !Number.isFinite(n) || n <= 0) {
      setEditingBudget(null)
      return
    }
    const sent = await sendGoalCommand("budget", `${field} ${n}`)
    if (sent) {
      setEditingBudget(null)
      setBudgetText("")
    }
  }

  const progressPct = createMemo(() => {
    const s = state()
    if (!s || s.constraints.maxTurns <= 0) return 0
    return Math.min(100, Math.round((s.turnsEvaluated / s.constraints.maxTurns) * 100))
  })

  const elapsedMinutes = createMemo(() => {
    const s = state()
    if (!s) return 0
    const end = s.completedAt ?? Date.now()
    return Math.max(0, Math.round((end - s.startedAt) / 60_000))
  })

  const statusIcon = () => {
    switch (state()?.status) {
      case "active":
        return "🎯"
      case "paused":
        return "⏸"
      case "achieved":
        return "✅"
      default:
        return "🎯"
    }
  }


  return (
    <div class="flex flex-col gap-3 p-4 flex-1 min-h-0 overflow-y-auto" aria-label={language.t("session.tab.goal")}>
      <Switch>
        <Match when={!props.goal.store.loaded}>
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak">
            {language.t("session.goal.loading")}
          </div>
        </Match>
        <Match when={props.goal.store.corrupt}>
          <div class="flex flex-col gap-2">
            <div class="text-14-medium text-text-warning-base">⚠ {language.t("session.goal.error.corrupt")}</div>
            <div class="text-12-regular text-text-weak">{language.t("session.goal.error.corrupt.hint")}</div>
          </div>
        </Match>
        <Match
          when={
            props.goal.store.loaded &&
            !props.goal.store.corrupt &&
            (props.goal.store.state === null || showCreate())
          }
        >
          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-2">
              <div class="text-14-medium text-text-base">{language.t("session.goal.create.title")}</div>
              <Show when={showCreate() && props.goal.store.state !== null}>
                <button
                  type="button"
                  class="text-11-regular text-text-weaker hover:text-text-base"
                  onClick={() => setShowCreate(false)}
                >
                  {language.t("session.goal.action.cancel")}
                </button>
              </Show>
            </div>
            <div class="text-11-regular text-text-weaker">{language.t("session.goal.create.hint")}</div>
            <TextField
              value={newCondition()}
              onChange={setNewCondition}
              label={language.t("session.goal.create.condition")}
              hideLabel
              multiline
              placeholder={language.t("session.goal.create.conditionPlaceholder")}
              disabled={busy() !== null || !props.sessionID}
              class="w-full"
            />
            <TextField
              value={newCommand()}
              onChange={setNewCommand}
              label={language.t("session.goal.create.command")}
              hideLabel
              placeholder={language.t("session.goal.create.commandPlaceholder")}
              disabled={busy() !== null || !props.sessionID}
              class="w-full"
            />
            <Button
              variant="primary"
              onClick={() => void createGoal()}
              disabled={!newCondition().trim() || !props.sessionID || busy() !== null}
            >
              {busy() === "set" ? "…" : language.t("session.goal.create.submit")}
            </Button>
            <div class="flex flex-col gap-1.5 pt-1">
              <div class="text-11-regular text-text-weaker">{language.t("session.goal.create.templates")}</div>
              <div class="flex flex-wrap gap-1.5">
                <For each={TEMPLATES}>
                  {(t) => (
                    <button
                      type="button"
                      onClick={() => void useTemplate(t.id)}
                      disabled={busy() !== null || !props.sessionID}
                      class="text-11-regular px-2 py-1 rounded-md border border-border-base text-text-weak hover:text-text-base disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {t.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <Show when={!props.sessionID}>
              <div class="text-11-regular text-text-weaker">{language.t("session.goal.controlsHint")}</div>
            </Show>
          </div>
        </Match>
        <Match when={state()} keyed>
          {(s) => (
            <div class="flex flex-col gap-4">
              {/* Condition */}
              <div class="flex items-start gap-2">
                <div class="text-14-regular shrink-0" aria-hidden>
                  {statusIcon()}
                </div>
                <div class="text-14-medium text-text-base line-clamp-3" title={cleanText(s.condition)}>
                  {cleanText(s.condition)}
                </div>
              </div>

              {/* Big completion % + colored bar + turn/time */}
              <div class="flex flex-col gap-2">
                <div class="flex items-baseline justify-between gap-2">
                  <span class="text-2xl font-semibold tabular-nums text-text-base">
                    {s.status === "achieved" ? 100 : progressPct()}%
                  </span>
                  <span class="text-11-regular text-text-weaker text-right">
                    <Show
                      when={(s.status === "active" || s.status === "paused") && props.sessionID}
                      fallback={
                        <>
                          {s.turnsEvaluated}/{s.constraints.maxTurns} turns · {elapsedMinutes()}m
                        </>
                      }
                    >
                      <button
                        type="button"
                        class="hover:text-text-base underline-offset-2 hover:underline"
                        title={language.t("session.goal.budget.editTurns")}
                        onClick={() => openBudget("turns", s.constraints.maxTurns)}
                      >
                        {s.turnsEvaluated}/{s.constraints.maxTurns} turns
                      </button>
                      {" · "}
                      <button
                        type="button"
                        class="hover:text-text-base underline-offset-2 hover:underline"
                        title={language.t("session.goal.budget.editTime")}
                        onClick={() => openBudget("time", s.constraints.maxTimeMinutes)}
                      >
                        {elapsedMinutes()}/{s.constraints.maxTimeMinutes}m
                      </button>
                    </Show>
                    <Show when={s.status === "paused"}>
                      <span class="text-text-warning-base"> · {language.t("session.goal.paused")}</span>
                    </Show>
                    <Show when={s.status === "achieved"}>
                      <span class="text-icon-success-base"> · {language.t("session.goal.achieved")}</span>
                    </Show>
                  </span>
                </div>
                <ProgressBar
                  pct={s.status === "achieved" ? 100 : progressPct()}
                  status={s.status === "paused" ? "paused" : s.status === "achieved" ? "achieved" : "active"}
                />
                <Show when={editingBudget() !== null}>
                  <div class="flex items-center gap-2">
                    <span class="text-11-regular text-text-weaker shrink-0">
                      {editingBudget() === "turns"
                        ? language.t("session.goal.budget.turnsLabel")
                        : language.t("session.goal.budget.timeLabel")}
                    </span>
                    <TextField
                      value={budgetText()}
                      onChange={setBudgetText}
                      label="budget"
                      hideLabel
                      disabled={busy() !== null}
                      class="w-20"
                    />
                    <ActionButton
                      label={language.t("session.goal.budget.save")}
                      variant="primary"
                      busy={busy() === "budget"}
                      disabled={busy() !== null || !budgetText().trim()}
                      onClick={() => void submitBudget()}
                    />
                    <ActionButton
                      label={language.t("session.goal.action.cancel")}
                      variant="ghost"
                      disabled={busy() !== null}
                      onClick={() => setEditingBudget(null)}
                    />
                  </div>
                </Show>
              </div>

              {/* Latest evaluation — one line, not a wall of stats */}
              <Show when={s.lastEvaluation}>
                <div class="text-12-regular text-text-weak" aria-live="polite">
                  {cleanText(s.lastEvaluation!.reason)}
                </div>
              </Show>

              {/* Controls: Pause/Resume · Steer · Stop */}
              <Show
                when={(s.status === "active" || s.status === "paused") && props.sessionID}
                fallback={
                  <Show when={s.status === "active" || s.status === "paused"}>
                    <div class="text-11-regular text-text-weaker">{language.t("session.goal.controlsHint")}</div>
                  </Show>
                }
              >
                <div class="flex flex-col gap-2 pt-3 border-t border-border-base">
                  <div class="flex items-center gap-2 flex-wrap">
                    <Show when={s.status === "active"}>
                      <ActionButton
                        label={language.t("session.goal.action.pause")}
                        variant="primary"
                        busy={busy() === "pause"}
                        disabled={busy() !== null}
                        onClick={() => runAction("pause")}
                      />
                    </Show>
                    <Show when={s.status === "paused"}>
                      <ActionButton
                        label={language.t("session.goal.action.resume")}
                        variant="primary"
                        busy={busy() === "resume"}
                        disabled={busy() !== null}
                        onClick={() => runAction("resume")}
                      />
                    </Show>
                    <ActionButton
                      label={language.t("session.goal.action.steer")}
                      variant="secondary"
                      disabled={busy() !== null}
                      onClick={() => setSteerOpen((v) => !v)}
                    />
                    <Show
                      when={confirmingClear()}
                      fallback={
                        <ActionButton
                          label={language.t("session.goal.action.stop")}
                          variant="secondary"
                          disabled={busy() !== null}
                          onClick={() => setConfirmingClear(true)}
                        />
                      }
                    >
                      <ActionButton
                        label={language.t("session.goal.action.confirmStop")}
                        variant="primary"
                        busy={busy() === "clear"}
                        disabled={busy() !== null}
                        onClick={() => runAction("clear")}
                      />
                      <ActionButton
                        label={language.t("session.goal.action.cancel")}
                        variant="ghost"
                        disabled={busy() !== null}
                        onClick={() => setConfirmingClear(false)}
                      />
                    </Show>
                  </div>

                  {/* Steer input */}
                  <Show when={steerOpen()}>
                    <div class="flex flex-col gap-2">
                      <TextField
                        value={steerText()}
                        onChange={setSteerText}
                        label={language.t("session.goal.action.steer")}
                        hideLabel
                        placeholder={language.t("session.goal.steer.placeholder")}
                        disabled={busy() !== null}
                        class="w-full"
                      />
                      <div class="flex items-center gap-2">
                        <ActionButton
                          label={language.t("session.goal.steer.send")}
                          variant="primary"
                          busy={busy() === "steer"}
                          disabled={busy() !== null || !steerText().trim()}
                          onClick={() => void steerGoal()}
                        />
                        <ActionButton
                          label={language.t("session.goal.action.cancel")}
                          variant="ghost"
                          disabled={busy() !== null}
                          onClick={() => {
                            setSteerOpen(false)
                            setSteerText("")
                          }}
                        />
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Always available — never a dead end, including on achieved goals */}
              <div classList={{ "mt-auto pt-2": s.status === "achieved" || s.status === "cleared" }}>
                <Button
                  variant={s.status === "achieved" || s.status === "cleared" ? "primary" : "ghost"}
                  size="small"
                  onClick={() => setShowCreate(true)}
                  disabled={busy() !== null}
                >
                  {language.t("session.goal.action.newGoal")}
                </Button>
              </div>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  )
}
