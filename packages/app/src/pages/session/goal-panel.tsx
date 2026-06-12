import { Match, Show, Switch, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"

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
      class="h-1.5 w-full rounded-full bg-background-stronger overflow-hidden"
      role="progressbar"
      aria-valuenow={pct()}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        class="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
        classList={{
          "bg-icon-success-base": props.status === "active",
          "bg-icon-warning-base": props.status === "paused",
          "bg-text-weak": props.status === "achieved",
        }}
        style={{ width: `${pct()}%` }}
      />
    </div>
  )
}

export function GoalPanel(props: { goal: { store: GoalStore } }) {
  const language = useLanguage()
  const state = () => props.goal.store.state

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

  const history = createMemo(() => {
    const s = state()
    if (!s || !Array.isArray(s.evaluationHistory)) return []
    return s.evaluationHistory.slice(-5).reverse()
  })

  return (
    <div class="flex flex-col gap-3 p-4 h-full overflow-y-auto" aria-label={language.t("session.tab.goal")}>
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
        <Match when={props.goal.store.loaded && !props.goal.store.corrupt && props.goal.store.state === null}>
          <div class="flex-1 flex flex-col items-center justify-center text-center gap-3 pb-32">
            <div class="text-12-regular text-text-weak">{language.t("session.goal.noActive")}</div>
            <div class="text-11-regular text-text-weaker max-w-56">
              {language.t("session.goal.noActive.hint")}
            </div>
          </div>
        </Match>
        <Match when={state()} keyed>
          {(s) => (
            <>
              <div class="flex items-start gap-2">
                <div class="text-14-regular shrink-0" aria-hidden>
                  {statusIcon()}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-14-medium text-text-base line-clamp-2" title={cleanText(s.condition)}>
                    {cleanText(s.condition)}
                  </div>
                  <div class="text-11-regular text-text-weaker mt-0.5">
                    {s.turnsEvaluated}/{s.constraints.maxTurns} turns · {elapsedMinutes()}/
                    {s.constraints.maxTimeMinutes}m
                    <Show when={s.status === "paused"}>
                      <span class="text-text-warning-base"> · {language.t("session.goal.paused")}</span>
                    </Show>
                    <Show when={s.status === "achieved"}>
                      <span> · {language.t("session.goal.achieved")}</span>
                    </Show>
                  </div>
                </div>
              </div>

              <Show when={s.status !== "achieved"} fallback={<ProgressBar pct={100} status="achieved" />}>
                <ProgressBar pct={progressPct()} status={s.status === "paused" ? "paused" : "active"} />
              </Show>

              <div class="flex flex-col gap-1" aria-live="polite">
                <div class="text-12-regular text-text-weak">
                  {language.t("session.goal.lastEvaluation")}:{" "}
                  {s.lastEvaluation ? cleanText(s.lastEvaluation.reason) : language.t("session.goal.history.empty")}
                </div>
                <Show when={s.command}>
                  <div class="text-11-regular text-text-weaker truncate" title={cleanText(s.command ?? "")}>
                    $ {cleanText(s.command ?? "")}
                  </div>
                </Show>
              </div>

              <Show when={history().length > 0}>
                <div class="flex flex-col gap-1 border-t border-border-weaker-base pt-2">
                  <div class="text-11-regular text-text-weaker">{language.t("session.goal.history")}</div>
                  <div role="list" class="flex flex-col gap-0.5">
                    {history().map((e) => (
                      <div role="listitem" class="text-11-regular text-text-weaker truncate">
                        {e.met ? "✓" : "·"} {cleanText(e.reason)}
                      </div>
                    ))}
                  </div>
                </div>
              </Show>

              <div class="mt-auto pt-3 border-t border-border-weaker-base text-11-regular text-text-weaker">
                {language.t("session.goal.controlsHint")}
              </div>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
