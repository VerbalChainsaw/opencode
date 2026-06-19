import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

import type { JSX } from "solid-js"

import {
  goalIdleMinutes,
  isGoalStalled,
  liveGoal as liveGoalOf,
  nodeColor as nodeColorOf,
  outcomeLabel as outcomeLabelOf,
  pauseResumeAction,
  shouldShowCreateForm as shouldShowCreateFormOf,
  statusMeta as statusMetaOf,
  terminalGoal as terminalGoalOf,
} from "./goal-panel-lifecycle"

export {
  STATE_PATH,
  HANDOFF_PATH,
  MAX_RENDERER_STATE_BYTES,
  MAX_RENDERER_HANDOFF_BYTES,
  isGoalStateShape,
  readHandoffFromSdk,
  readGoalFromSdk,
  type GoalSdkClient,
} from "./goal-panel-pure"

// `GoalState` is a TYPE only and is used as `GoalState["status"]` in
// JSX type positions below. Importing it as a separate `import type`
// line keeps the type available in the module without conflicting with
// the `export type GoalStore = ...` declaration that follows.
import type { GoalState } from "./goal-panel-pure"

// Re-bind the runtime helpers as local names so the JSX below can
// call them. The `export { ... }` block above exposes them to external
// consumers; this import makes them available as in-scope identifiers.
import {
  chainBudgetSummary,
  chainStepFromTemplate,
  cleanText,
  readHandoffFromSdk,
  readGoalFromSdk,
  selectRunnableChainSteps,
  templateButtonsFromSnapshot,
  templateVariableDefaults,
  validateChainDraft,
  DEFAULT_TEMPLATE_BUTTONS,
  GOAL_TEMPLATE_CATEGORIES,
  GOAL_TEMPLATE_ELEVATIONS,
  GOAL_TEMPLATE_TONES,
  isGoalPinnedModel,
  templateModelFromSnapshot,
  type ChainValidationError,
  type GoalSdkClient,
  type GoalHandoffStore,
  type GoalChainDraftStep,
  type GoalPinnedModel,
  type GoalTemplateButton,
  type GoalTemplateCategory,
  type GoalTemplateElevation,
  type GoalTemplateModel,
  type GoalTemplateTone,
} from "./goal-panel-pure"
import { executeGoalCommand, startGoalRun, steerGoalRun, stopGoalRun } from "./goal-panel-actions"
// `GoalState` and `GoalStore` are re-exported as types above; aliasing
// them as locals is unnecessary because we only need them as type
// annotations, which the imported type re-exports satisfy directly.

/**
 * Goal tab — renders the in-tree AutoGoal state file
 * (`.opencode/.goal-state.json`) in the session side panel.
 *
 * Data contract: packages/autogoal/docs/gui-integration.md.
 * The renderer polls via `sdk.client.file.read` every 2 seconds (the
 * native goal runtime has no event-emit API; polling is the documented live-update
 * mechanism). The state file is user-controlled, so everything is
 * structurally validated before rendering and string fields are
 * stripped of control characters.
 *
 * Pure data-shape helpers (STATE_PATH, GoalState, isGoalStateShape,
 * cleanText, readGoalFromSdk) live in `./goal-panel-pure.ts` so they
 * can be unit-tested without dragging in Kobalte's client-only
 * modules. The TSX re-exports the same names from here.
 */

const POLL_MS = 2000

// GoalStore is the public type for the goal panel's store snapshot.
// Aliased to the pure module's GoalStore so consumers using either
// `import type { GoalStore } from "./goal-panel"` (legacy) or
// `import type { GoalStore } from "./goal-panel-pure"` (new) get the
// same shape.
export type GoalStore = import("./goal-panel-pure").GoalStore

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
    setStore("loaded", next.loaded)
    setStore("corrupt", next.corrupt)
    // Reconcile (keyed on the goal `id`) instead of replacing the object so
    // the proxy reference stays stable across polls when it's the same goal.
    // The live-goal subtree is rendered with `<Match … keyed>`; replacing the
    // object every 2s tore that subtree down and rebuilt it, destroying any
    // focused input inside it (the steer field flashing back to chat). With
    // reconcile the fields update in place and focus is preserved; a genuinely
    // new goal (different id) still swaps the reference and rebuilds.
    if (!next.state) {
      setStore("state", null)
    } else if (!store.state) {
      setStore("state", next.state)
    } else {
      setStore("state", reconcile(next.state, { key: "id" }))
    }
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

/** Minimal shape of the SDK surface the action buttons need. GUI controls use
 *  the goal_control endpoint so changing dials/state does not enqueue a chat
 *  command or make the assistant take a turn. */
interface GoalActionClient {
  directory?: string
  client: {
    app?: {
      skills?: (args?: { directory?: string; workspace?: string }) => Promise<{ data?: unknown }>
    }
    tool: {
      control?: (args: {
        toolID: "goal_control"
        sessionID: string
        arguments: { command: string }
      }) => Promise<unknown>
    }
    session?: {
      abort?: (args: { sessionID: string }) => Promise<unknown>
      command?: (args: { sessionID: string; command: string; arguments: string }) => Promise<unknown>
    }
    file: {
      read: (args: { path: string }) => Promise<{ data: unknown }>
    }
  }
}

type GoalAction = "pause" | "resume" | "restart" | "clear" | "handoff" | "claim"

/** One line of the engine's `.opencode/.session-events.jsonl` activity log —
 *  the live "what is the agent doing" feed (session-events.ts in the plugin). */
interface ActivityEvent {
  at: number
  kind: "tool-start" | "tool-end" | "message"
  tool?: string
  durationMs?: number
  ok?: boolean
  summary?: string
}

const ACTIVITY_PATH = ".opencode/.session-events.jsonl"

interface SkillOption {
  name: string
  description?: string
}

function isSkillOption(value: unknown): value is SkillOption {
  if (!value || typeof value !== "object") return false
  const item = value as { name?: unknown; description?: unknown }
  return (
    typeof item.name === "string" &&
    item.name.trim().length > 0 &&
    (item.description === undefined || typeof item.description === "string")
  )
}

async function readAvailableSkills(sdk: GoalActionClient): Promise<SkillOption[]> {
  try {
    const res = await sdk.client.app?.skills?.({
      ...(sdk.directory ? { directory: sdk.directory } : {}),
    })
    const raw = res?.data
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: SkillOption[] = []
    for (const item of raw) {
      if (!isSkillOption(item)) continue
      const name = cleanText(item.name).trim().slice(0, 80)
      if (!name || seen.has(name)) continue
      seen.add(name)
      const description = cleanText(item.description).trim().slice(0, 140)
      out.push({
        name,
        ...(description ? { description } : {}),
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** Read + parse the JSONL activity log, newest first, capped. Tolerant of
 *  the SDK's FileContent ({type,content}) or a plain string; corrupt lines
 *  are skipped. Returns [] on any error (missing file = no activity). */
async function readActivity(sdk: GoalActionClient): Promise<ActivityEvent[]> {
  try {
    const res = await sdk.client.file.read({ path: ACTIVITY_PATH })
    const raw: unknown = res.data
    const content =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && typeof (raw as { content?: unknown }).content === "string"
          ? (raw as { content: string }).content
          : null
    if (!content) return []
    const out: ActivityEvent[] = []
    for (const line of content.split("\n")) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t)
        if (e && typeof e === "object" && typeof e.at === "number" && typeof e.kind === "string") {
          out.push(e as ActivityEvent)
        }
      } catch {
        // skip corrupt line
      }
    }
    return out.slice(-40).reverse()
  } catch {
    return []
  }
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Tolerant read of a workspace file's text via the SDK (FileContent or
 *  string). Returns null on any error or empty content. */
async function readWorkspaceText(sdk: GoalActionClient, path: string): Promise<string | null> {
  try {
    const res = await sdk.client.file.read({ path })
    const raw: unknown = res.data
    const content =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && typeof (raw as { content?: unknown }).content === "string"
          ? (raw as { content: string }).content
          : null
    return content && content.trim().length > 0 ? content : null
  } catch {
    return null
  }
}

export interface ChainStep {
  condition: string
  command?: string | null
  maxTurns?: number
  maxMinutes?: number
  maxTimeMinutes?: number
  category?: GoalTemplateCategory
  tone?: GoalTemplateTone
  elevation?: GoalTemplateElevation
  skills?: string[]
  model?: GoalTemplateModel
}
export interface ChainData {
  steps: ChainStep[]
  current: number
}

type ActionDraftState = {
  sourceID: string
  id: string
  label: string
  prompt: string
  command: string
  turns: number
  minutes: number
  category: GoalTemplateCategory
  tone: GoalTemplateTone
  elevation: GoalTemplateElevation
  skills: string[]
  model: string
}

interface HistoryRun {
  summary: {
    goalID: string
    title: string
    status: "success" | "failure" | "mixed"
    outcome: "achieved" | "cleared" | "replaced"
    turns: number
    elapsedMs: number
    successCount: number
    failureCount: number
    archivedAt: number
  }
  detail: {
    latestReason: string
    cycles: Array<{ turn: number; met: boolean; reason: string; at: number }>
    template: {
      source: "template" | "manual"
      label: string
      reuseCommand: string
      canGenerate: boolean
    }
  }
}

/** Read the engine's `.opencode/.goal-chain.json` so the panel can show
 *  sub-goal steps. Returns null when there's no chain (single goal). */
async function readChain(sdk: GoalActionClient): Promise<ChainData | null> {
  const content = await readWorkspaceText(sdk, ".opencode/.goal-chain.json")
  if (!content) return null
  try {
    const c = JSON.parse(content)
    if (!c || !Array.isArray(c.steps) || c.steps.length === 0) return null
    const rawSteps: unknown[] = c.steps
    const validSteps = rawSteps.filter((s: unknown) => s && typeof (s as ChainStep).condition === "string")
    if (validSteps.length < rawSteps.length) {
      console.warn(
        `[goal-panel] readChain dropped ${rawSteps.length - validSteps.length} of ${rawSteps.length} chain step(s) — missing or invalid "condition" field`,
      )
    }
    const steps: ChainStep[] = (validSteps as ChainStep[]).map((s) => ({
        condition: s.condition,
        command: s.command ?? null,
        ...(typeof (s as { maxTurns?: unknown }).maxTurns === "number"
          ? { maxTurns: (s as { maxTurns: number }).maxTurns }
          : {}),
        ...(typeof s.maxMinutes === "number"
          ? { maxTimeMinutes: s.maxMinutes }
          : typeof (s as { maxTimeMinutes?: unknown }).maxTimeMinutes === "number"
            ? { maxTimeMinutes: (s as { maxTimeMinutes: number }).maxTimeMinutes }
            : {}),
        ...((GOAL_TEMPLATE_CATEGORIES as readonly string[]).includes(s.category ?? "") ? { category: s.category } : {}),
        ...((GOAL_TEMPLATE_TONES as readonly string[]).includes(s.tone ?? "") ? { tone: s.tone } : {}),
        ...((GOAL_TEMPLATE_ELEVATIONS as readonly string[]).includes(s.elevation ?? "")
          ? { elevation: s.elevation }
          : {}),
        ...(Array.isArray(s.skills)
          ? {
              skills: [
                ...new Set(s.skills.map((skill) => cleanText(skill).trim().slice(0, 80)).filter(Boolean)),
              ].slice(0, 8),
            }
          : {}),
        ...(templateModelFromSnapshot(s.model) ? { model: templateModelFromSnapshot(s.model) } : {}),
      }))
    if (steps.length === 0) return null
    const current = typeof c.current === "number" && Number.isFinite(c.current) ? c.current : 0
    return { steps, current }
  } catch {
    return null
  }
}

const TEMPLATES_PATH = ".opencode/goal-templates.json"
const TEMPLATE_SAVE_ID_RE = /^[A-Za-z0-9_-]+$/

function actionIDFromLabel(label: string, fallback = "custom-action") {
  const id = cleanText(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return TEMPLATE_SAVE_ID_RE.test(id) && id.length > 0 ? id : fallback
}

/** Read the plugin's `.opencode/goal-templates.json` snapshot (builtins +
 *  user `.opencode/goals/*.json`) so the dock's quick-start buttons reflect
 *  the actual templates. Falls back to the built-in three when the file is
 *  missing (older plugin) or unparseable. */
async function readTemplates(sdk: GoalActionClient): Promise<GoalTemplateButton[]> {
  const content = await readWorkspaceText(sdk, TEMPLATES_PATH)
  if (!content) return DEFAULT_TEMPLATE_BUTTONS
  try {
    return templateButtonsFromSnapshot(JSON.parse(content))
  } catch {
    return DEFAULT_TEMPLATE_BUTTONS
  }
}

/** Read the engine's `.opencode/goal-history.json` — a UI-ready snapshot
 *  derived by the plugin from archived goal runs. */
async function readArchive(sdk: GoalActionClient): Promise<HistoryRun[]> {
  const content = await readWorkspaceText(sdk, ".opencode/goal-history.json")
  if (!content) return []
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runs)) return []
    return parsed.runs.filter((run: unknown): run is HistoryRun => {
      if (!run || typeof run !== "object") return false
      const summary = (run as HistoryRun).summary
      const detail = (run as HistoryRun).detail
      return (
        !!summary &&
        !!detail &&
        typeof summary.goalID === "string" &&
        typeof summary.title === "string" &&
        Array.isArray(detail.cycles)
      )
    })
  } catch {
    return []
  }
}

function ActionButton(props: {
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  variant?: "primary" | "secondary" | "ghost"
  tone?: "default" | "success" | "danger"
  label: string
  class?: string
  title?: string
}) {
  return (
    <Button
      variant={props.variant ?? "secondary"}
      size="small"
      class={`${goalCommandButtonClass(props.variant ?? "secondary", props.tone ?? "default")} ${props.class ?? ""}`}
      style={goalCommandButtonStyle(props.variant ?? "secondary", props.tone ?? "default")}
      onClick={() => props.onClick()}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.title}
    >
      {props.busy ? "…" : props.label}
    </Button>
  )
}

function goalCommandButtonClass(_variant: "primary" | "secondary" | "ghost", _tone: "default" | "success" | "danger") {
  return "inline-flex items-center justify-center rounded px-2 py-1 text-11-medium font-semibold transition disabled:cursor-not-allowed disabled:opacity-30"
}

function goalCommandButtonStyle(variant: "primary" | "secondary" | "ghost", tone: "default" | "success" | "danger") {
  if (tone === "danger") return { "background-color": "rgba(239, 68, 68, 0.12)", color: "rgb(252, 165, 165)" }
  if (tone === "success") return { "background-color": "rgba(16, 185, 129, 0.12)", color: "rgb(167, 243, 208)" }
  if (variant === "primary") return { "background-color": "rgba(59, 130, 246, 0.14)", color: "rgb(191, 219, 254)" }
  if (variant === "ghost") return { color: "rgb(161, 161, 170)" }
  return { "background-color": "rgba(14, 165, 233, 0.10)", color: "rgb(186, 230, 253)" }
}

function inlineCommandButtonClass(tone: "add" | "edit" | "move" | "remove") {
  const base =
    "goal-inline-command-button flex h-[22px] items-center justify-center rounded-md border px-1 text-center text-11-medium font-semibold leading-none transition-all focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
  if (tone === "add") {
    return `${base} goal-inline-command-add w-6 border-emerald-300/32 bg-emerald-500/10 text-emerald-100 hover:border-emerald-200/58 hover:bg-emerald-500/18 focus-visible:ring-emerald-200/60`
  }
  if (tone === "remove") {
    return `${base} goal-inline-command-remove border-orange-300/75 bg-orange-500/55 text-white shadow-[0_6px_14px_rgba(249,115,22,0.18)] hover:bg-orange-400 hover:ring-orange-300/45 focus-visible:ring-orange-300/65`
  }
  if (tone === "move") {
    return `${base} goal-inline-command-move w-[22px] border-border-base bg-background-panel text-text-weak hover:border-border-strong hover:bg-white/[0.06] hover:text-text-base focus-visible:ring-border-strong`
  }
  return `${base} goal-inline-command-edit w-6 border-sky-300/30 bg-sky-500/8 text-sky-100 hover:border-sky-200/55 hover:bg-sky-500/16 focus-visible:ring-sky-300/55`
}

function inlineCommandButtonStyle(tone: "add" | "edit" | "move" | "remove") {
  if (tone === "add") {
    return {
      "background-color": "rgba(16, 185, 129, 0.10)",
      "border-color": "rgba(110, 231, 183, 0.32)",
      color: "rgb(209, 250, 229)",
    } satisfies JSX.CSSProperties
  }
  if (tone === "remove") {
    return {
      "background-color": "rgba(249, 115, 22, 0.58)",
      "border-color": "rgba(253, 186, 116, 0.84)",
      color: "rgb(255, 255, 255)",
      "box-shadow": "0 6px 14px rgba(249, 115, 22, 0.18)",
    } satisfies JSX.CSSProperties
  }
  if (tone === "edit") {
    return {
      "background-color": "rgba(14, 165, 233, 0.08)",
      "border-color": "rgba(125, 211, 252, 0.30)",
      color: "rgb(224, 242, 254)",
    } satisfies JSX.CSSProperties
  }
  return {
    "background-color": "rgba(24, 24, 24, 0.82)",
    "border-color": "rgba(82, 82, 82, 0.86)",
    color: "rgb(214, 214, 214)",
  } satisfies JSX.CSSProperties
}

function numericHighlightStyle(tone: "blue" | "violet" | "emerald" = "blue") {
  if (tone === "violet") {
    return {
      "background-color": "rgba(139, 92, 246, 0.18)",
      "border-color": "rgba(196, 181, 253, 0.48)",
      color: "rgb(237, 233, 254)",
    } satisfies JSX.CSSProperties
  }
  if (tone === "emerald") {
    return {
      "background-color": "rgba(16, 185, 129, 0.16)",
      "border-color": "rgba(110, 231, 183, 0.46)",
      color: "rgb(209, 250, 229)",
    } satisfies JSX.CSSProperties
  }
  return {
    "background-color": "rgba(59, 130, 246, 0.16)",
    "border-color": "rgba(147, 197, 253, 0.46)",
    color: "rgb(219, 234, 254)",
  } satisfies JSX.CSSProperties
}

function numericHighlightClass(extra = "") {
  return `goal-number-highlight inline-flex min-h-5 items-center rounded-md border px-1.5 text-12-medium tabular-nums ${extra}`
}

function RunMetricPill(props: {
  label: string
  value: string
  detail?: string
  tone?: "default" | "success" | "warning" | "danger"
}) {
  return (
    <div
      class="grid min-w-0 grid-cols-[3px_minmax(0,1fr)] overflow-hidden rounded-md border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      classList={{
        "border-border-base bg-background-panel/70": !props.tone || props.tone === "default",
        "border-emerald-400/35 bg-emerald-400/10": props.tone === "success",
        "border-amber-400/35 bg-amber-400/10": props.tone === "warning",
        "border-rose-400/35 bg-rose-400/10": props.tone === "danger",
      }}
    >
      <span
        classList={{
          "bg-border-strong": !props.tone || props.tone === "default",
          "bg-emerald-400": props.tone === "success",
          "bg-amber-400": props.tone === "warning",
          "bg-rose-400": props.tone === "danger",
        }}
        aria-hidden
      />
      <div class="min-w-0 px-2 py-1">
        <div class="truncate text-[9px] font-medium uppercase leading-3 tracking-[0.08em] text-text-weaker">
          {props.label}
        </div>
        <div class="mt-0.5 truncate text-12-medium tabular-nums leading-4 text-text-base" title={props.value}>
          {props.value}
        </div>
        <Show when={props.detail}>
          <div class="truncate text-[10px] leading-4 text-text-weaker">{props.detail}</div>
        </Show>
      </div>
    </div>
  )
}

function GoalConsoleSection(props: {
  zone:
    | "last-result"
    | "set-goal"
    | "running-status"
    | "run-controls"
    | "chain-builder"
    | "action-library"
    | "action-editor"
    | "activity"
  title: string
  subtitle?: string
  class?: string
  children: JSX.Element
}) {
  const accent = {
    "last-result": {
      class: "border-rose-400/70",
      style: {
        "border-color": "rgba(251, 113, 133, 0.58)",
        "box-shadow": "0 12px 28px rgba(0, 0, 0, 0.20)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(127, 29, 29, 0.88), rgba(30, 30, 30, 0.92))",
        "border-color": "rgba(251, 113, 133, 0.72)",
      },
      marker: "bg-rose-200",
    },
    "set-goal": {
      class: "border-blue-400/70",
      style: {
        "border-color": "rgba(96, 165, 250, 0.58)",
        "box-shadow": "0 12px 28px rgba(0, 0, 0, 0.20)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(30, 64, 175, 0.9), rgba(30, 30, 30, 0.92))",
        "border-color": "rgba(96, 165, 250, 0.72)",
      },
      marker: "bg-blue-200",
    },
    "running-status": {
      class: "border-sky-400/60",
      style: {
        "border-color": "rgba(56, 189, 248, 0.54)",
        "box-shadow": "0 12px 28px rgba(0, 0, 0, 0.20), 0 0 0 1px rgba(56, 189, 248, 0.07)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(12, 74, 110, 0.9), rgba(24, 24, 27, 0.92))",
        "border-color": "rgba(125, 211, 252, 0.58)",
      },
      marker: "bg-sky-200",
    },
    "run-controls": {
      class: "border-indigo-400/55",
      style: {
        "border-color": "rgba(129, 140, 248, 0.5)",
        "box-shadow": "0 12px 28px rgba(0, 0, 0, 0.20), 0 0 0 1px rgba(129, 140, 248, 0.07)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(49, 46, 129, 0.86), rgba(24, 24, 27, 0.92))",
        "border-color": "rgba(165, 180, 252, 0.46)",
      },
      marker: "bg-indigo-200",
    },
    "chain-builder": {
      class: "border-violet-500/22",
      style: {
        "border-color": "rgba(139, 92, 246, 0.22)",
        "box-shadow": "0 12px 28px rgba(0, 0, 0, 0.20), 0 0 0 1px rgba(139, 92, 246, 0.024)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(76, 29, 149, 0.48), rgba(24, 24, 27, 0.92))",
        "border-color": "rgba(167, 139, 250, 0.18)",
      },
      marker: "bg-violet-300/80",
    },
    "action-library": {
      class: "border-emerald-400/70",
      style: {
        "border-color": "rgba(52, 211, 153, 0.58)",
        "box-shadow": "0 12px 28px rgba(0, 0, 0, 0.20)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(6, 95, 70, 0.9), rgba(30, 30, 30, 0.92))",
        "border-color": "rgba(52, 211, 153, 0.72)",
      },
      marker: "bg-emerald-200",
    },
    "action-editor": {
      class: "border-slate-400/28",
      style: {
        "border-color": "rgba(148, 163, 184, 0.26)",
        "box-shadow": "0 10px 22px rgba(0, 0, 0, 0.16)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(39, 39, 42, 0.92), rgba(24, 24, 27, 0.94))",
        "border-color": "rgba(148, 163, 184, 0.22)",
      },
      marker: "bg-slate-300/80",
    },
    activity: {
      class: "border-cyan-400/55",
      style: {
        "border-color": "rgba(34, 211, 238, 0.5)",
        "box-shadow": "0 12px 28px rgba(0, 0, 0, 0.20), 0 0 0 1px rgba(34, 211, 238, 0.07)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(21, 94, 117, 0.86), rgba(24, 24, 27, 0.92))",
        "border-color": "rgba(103, 232, 249, 0.46)",
      },
      marker: "bg-cyan-200",
    },
  }[props.zone]

  return (
    <section
      data-component="goal-console-section"
      data-zone={props.zone}
      class={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-background-panel/80 ${accent.class} ${props.class ?? ""}`}
      style={accent.style}
    >
      <div data-component="goal-console-section-header" class="shrink-0 border-b border-border-base/60 px-2.5 py-1.5" style={accent.headerStyle}>
        <div
          data-component="goal-console-section-title"
          class="flex min-w-0 items-center"
        >
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <span class={`h-4 w-1.5 shrink-0 rounded-sm ${accent.marker}`} aria-hidden />
            <div class="flex min-w-0 flex-1 items-baseline gap-2">
              <span data-component="goal-console-section-title-text" class="shrink-0 truncate text-[13px] font-black uppercase leading-4 tracking-[0.12em] text-white">
                {props.title}
              </span>
              <Show when={props.subtitle}>
                <span data-component="goal-console-section-subtitle" class="min-w-0 truncate border-l border-white/16 pl-2 text-[10px] font-semibold leading-4 text-white/56">{props.subtitle}</span>
              </Show>
            </div>
          </div>
        </div>
      </div>
      <div data-component="goal-console-section-body" class="min-h-0 flex-1 overflow-hidden">
        {props.children}
      </div>
    </section>
  )
}

const ACTION_CATEGORIES = ["All", ...GOAL_TEMPLATE_CATEGORIES] as const

type ActionCategory = (typeof ACTION_CATEGORIES)[number]

function actionCategoryShortLabel(category: ActionCategory) {
  if (category === "Planning") return "Plan"
  if (category === "Building") return "Build"
  if (category === "Debugging") return "Debug"
  if (category === "Testing") return "Verify"
  if (category === "Review") return "Review"
  if (category === "Documentation") return "Docs"
  return category
}

function concreteActionCategory(category: ActionCategory): GoalTemplateCategory {
  return category === "All" ? "Custom" : category
}

function actionCategoryPillStyle(category: ActionCategory, active: boolean): JSX.CSSProperties {
  const palettes: Record<ActionCategory, [string, string, string, string]> = {
    All: ["rgba(67, 56, 202, 0.72)", "rgba(14, 165, 233, 0.34)", "rgba(147, 197, 253, 0.58)", "rgb(219, 234, 254)"],
    Planning: ["rgba(37, 99, 235, 0.72)", "rgba(99, 102, 241, 0.30)", "rgba(147, 197, 253, 0.56)", "rgb(219, 234, 254)"],
    Building: ["rgba(5, 150, 105, 0.72)", "rgba(13, 148, 136, 0.30)", "rgba(94, 234, 212, 0.54)", "rgb(204, 251, 241)"],
    Debugging: ["rgba(194, 65, 12, 0.72)", "rgba(217, 119, 6, 0.30)", "rgba(251, 191, 36, 0.56)", "rgb(254, 243, 199)"],
    Testing: ["rgba(22, 101, 52, 0.72)", "rgba(16, 185, 129, 0.30)", "rgba(134, 239, 172, 0.54)", "rgb(220, 252, 231)"],
    Review: ["rgba(126, 34, 206, 0.70)", "rgba(217, 70, 239, 0.28)", "rgba(216, 180, 254, 0.54)", "rgb(243, 232, 255)"],
    Documentation: ["rgba(30, 64, 175, 0.70)", "rgba(59, 130, 246, 0.28)", "rgba(125, 211, 252, 0.54)", "rgb(224, 242, 254)"],
    Custom: ["rgba(55, 65, 81, 0.72)", "rgba(100, 116, 139, 0.28)", "rgba(203, 213, 225, 0.48)", "rgb(226, 232, 240)"],
  }
  const [from, to, border, text] = palettes[category]
  return {
    "background": active
      ? `linear-gradient(135deg, ${from}, ${to})`
      : "linear-gradient(180deg, rgba(24, 24, 27, 0.84), rgba(12, 12, 14, 0.78))",
    "border-color": border,
    color: active ? text : "rgba(214, 214, 214, 0.76)",
    "box-shadow": active ? `inset 0 1px 0 rgba(255,255,255,0.06), 0 6px 14px rgba(0, 0, 0, 0.18)` : "inset 0 1px 0 rgba(255,255,255,0.025)",
    opacity: "1",
  }
}

interface ActionDescriptor {
  label?: string
  id?: string
  actionID?: string
  description?: string
  condition?: string
  command?: string | null
  tone?: GoalTemplateTone
  elevation?: GoalTemplateElevation
  category?: GoalTemplateCategory
  skills?: string[]
  model?: GoalTemplateModel
  builtin?: boolean
}

type ChainStepRunState = "draft" | "done" | "running" | "paused" | "stalled" | "queued"
type ChainBudgetStatus = "ready" | "turns" | "time" | "both"

type ActionDraftTemplate = GoalTemplateButton & { condition: string; builtin: false }

function actionLabelText(input: ActionDescriptor) {
  return `${input.label ?? ""} ${input.id ?? ""} ${input.actionID ?? ""}`.toLowerCase()
}

function actionSearchText(input: ActionDescriptor) {
  return `${actionLabelText(input)} ${input.description ?? ""} ${input.condition ?? ""} ${input.command ?? ""}`.toLowerCase()
}

function modelKey(model?: GoalTemplateModel): string {
  if (!model) return ""
  if (typeof model === "string") return cleanText(model).trim().slice(0, 200)
  return `${cleanText(model.providerID).trim()}:${cleanText(model.modelID).trim()}`
}

function pinnedModelFromKey(key: string): GoalPinnedModel | undefined {
  const clean = cleanText(key).trim()
  const sep = clean.indexOf(":")
  if (sep <= 0 || sep === clean.length - 1) return undefined
  const providerID = clean.slice(0, sep).trim().slice(0, 160)
  const modelID = clean.slice(sep + 1).trim().slice(0, 160)
  return providerID && modelID ? { providerID, modelID } : undefined
}

function referencedTemplateVariables(condition: string, command: string) {
  const out = new Set<string>()
  for (const text of [condition, command]) {
    for (const match of text.matchAll(/\{(\w+)\}/g)) {
      if (match[1]) out.add(match[1])
    }
  }
  return out
}

function pinnedModelForRuntime(model?: GoalTemplateModel): GoalPinnedModel | undefined {
  if (!model) return undefined
  if (isGoalPinnedModel(model)) {
    const providerID = cleanText(model.providerID).trim().slice(0, 160)
    const modelID = cleanText(model.modelID).trim().slice(0, 160)
    return providerID && modelID ? { providerID, modelID } : undefined
  }
  return pinnedModelFromKey(model)
}

function inferActionCategory(template: ActionDescriptor): GoalTemplateCategory {
  if (template.category) return template.category
  if (!template.builtin) return "Custom"
  const label = `${template.label} ${template.id}`.toLowerCase()
  if (/plan/.test(label)) return "Planning"
  if (/build|patch|implement|construct|compile/.test(label)) return "Building"
  if (/debug|failure|reproduce|investigate/.test(label)) return "Debugging"
  if (/review|risk|adversarial|security/.test(label)) return "Review"
  if (/document|docs|notes/.test(label)) return "Documentation"
  if (/test|typecheck|verify|validate|validation/.test(label)) return "Testing"
  const text = actionSearchText(template)
  if (/review|risk|adversarial|security/.test(text)) return "Review"
  if (/document|docs|notes/.test(text)) return "Documentation"
  if (/build|patch|implement|construct|compile/.test(text)) return "Building"
  if (/debug|failure|reproduce|investigate/.test(text)) return "Debugging"
  if (/test|verify|check|validation/.test(text)) return "Testing"
  return "Planning"
}

function inferredActionTone(input: ActionDescriptor): GoalTemplateTone {
  const label = actionLabelText(input)
  if (/debug|patch|failure|reproduce/.test(label)) return "orange"
  if (/test|typecheck|verify|validate|validation/.test(label)) return "emerald"
  if (/review|security|risk|adversarial/.test(label)) return "fuchsia"
  if (/document|docs|notes/.test(label)) return "sky"
  if (/build|compile|construct/.test(label)) return "blue"
  const text = actionSearchText(input)
  if (/debug|patch|failure|reproduce/.test(text)) return "orange"
  if (/test|verify|check|validation/.test(text)) return "emerald"
  if (/review|security|risk|adversarial/.test(text)) return "fuchsia"
  if (/document|docs|notes/.test(text)) return "sky"
  if (/build|compile|construct/.test(text)) return "blue"
  return "violet"
}

function actionCategoryPalette(input: ActionDescriptor) {
  const category = inferActionCategory(input)
  const styles: Record<
    GoalTemplateCategory,
    { from: string; to: string; border: string; solid: string; soft: string; text: string }
  > = {
    Planning: {
      from: "rgba(30, 64, 175, 0.34)",
      to: "rgba(37, 99, 235, 0.1)",
      border: "rgba(96, 165, 250, 0.5)",
      solid: "rgba(59, 130, 246, 0.84)",
      soft: "rgba(59, 130, 246, 0.16)",
      text: "rgb(219, 234, 254)",
    },
    Building: {
      from: "rgba(15, 118, 110, 0.34)",
      to: "rgba(20, 184, 166, 0.1)",
      border: "rgba(45, 212, 191, 0.48)",
      solid: "rgba(20, 184, 166, 0.82)",
      soft: "rgba(20, 184, 166, 0.16)",
      text: "rgb(204, 251, 241)",
    },
    Debugging: {
      from: "rgba(146, 64, 14, 0.36)",
      to: "rgba(245, 158, 11, 0.1)",
      border: "rgba(251, 191, 36, 0.5)",
      solid: "rgba(245, 158, 11, 0.84)",
      soft: "rgba(245, 158, 11, 0.18)",
      text: "rgb(254, 243, 199)",
    },
    Testing: {
      from: "rgba(22, 101, 52, 0.34)",
      to: "rgba(34, 197, 94, 0.1)",
      border: "rgba(74, 222, 128, 0.48)",
      solid: "rgba(34, 197, 94, 0.82)",
      soft: "rgba(34, 197, 94, 0.16)",
      text: "rgb(220, 252, 231)",
    },
    Review: {
      from: "rgba(88, 28, 135, 0.34)",
      to: "rgba(168, 85, 247, 0.1)",
      border: "rgba(192, 132, 252, 0.48)",
      solid: "rgba(168, 85, 247, 0.82)",
      soft: "rgba(168, 85, 247, 0.16)",
      text: "rgb(243, 232, 255)",
    },
    Documentation: {
      from: "rgba(12, 74, 110, 0.34)",
      to: "rgba(14, 165, 233, 0.1)",
      border: "rgba(56, 189, 248, 0.48)",
      solid: "rgba(14, 165, 233, 0.82)",
      soft: "rgba(14, 165, 233, 0.16)",
      text: "rgb(224, 242, 254)",
    },
    Custom: {
      from: "rgba(51, 65, 85, 0.34)",
      to: "rgba(100, 116, 139, 0.1)",
      border: "rgba(148, 163, 184, 0.44)",
      solid: "rgba(100, 116, 139, 0.82)",
      soft: "rgba(100, 116, 139, 0.16)",
      text: "rgb(226, 232, 240)",
    },
  }
  return styles[category]
}

function actionLibraryRowStyle(input: ActionDescriptor): JSX.CSSProperties {
  const { from, to, border } = actionCategoryPalette(input)
  return {
    "background": `linear-gradient(90deg, ${from}, rgba(24, 24, 27, 0.72) 54%, ${to})`,
    "border-color": border,
    "box-shadow": `inset 3px 0 0 ${border}, inset 0 1px 0 rgba(255, 255, 255, 0.035)`,
  }
}

function actionLibraryPanelStyle(input: ActionDescriptor = { category: "Custom" }): JSX.CSSProperties {
  const { from, to, border } = actionCategoryPalette(input)
  return {
    "background": `linear-gradient(135deg, ${from}, rgba(18, 18, 18, 0.82) 48%, ${to})`,
    "border-color": border,
    "box-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.035)",
  }
}

function actionEditorCurrentStyle(input: ActionDescriptor): JSX.CSSProperties {
  const { from, to, border } = actionCategoryPalette(input)
  return {
    "background": `linear-gradient(90deg, ${from}, rgba(24, 24, 27, 0.76) 54%, ${to})`,
    "border-color": border,
    "box-shadow": `inset 3px 0 0 ${border}, inset 0 1px 0 rgba(255, 255, 255, 0.035)`,
  }
}

function actionEditorPanelStyle(active = false): JSX.CSSProperties {
  return {
    "background": active
      ? "linear-gradient(135deg, rgba(39, 39, 42, 0.84), rgba(18, 18, 18, 0.86) 58%, rgba(148, 163, 184, 0.06))"
      : "linear-gradient(135deg, rgba(39, 39, 42, 0.72), rgba(18, 18, 18, 0.84))",
    "border-color": active ? "rgba(148, 163, 184, 0.24)" : "rgba(148, 163, 184, 0.18)",
    "box-shadow": active
      ? "inset 0 1px 0 rgba(255, 255, 255, 0.035)"
      : "inset 0 1px 0 rgba(255, 255, 255, 0.026)",
  }
}

function chainBuilderHeaderStyle(status: ChainBudgetStatus, live = false): JSX.CSSProperties {
  if (live || status === "ready") {
    return {
      "background": "linear-gradient(90deg, rgba(76, 29, 149, 0.16), rgba(15, 23, 42, 0.42))",
      "border-bottom-color": "rgba(167, 139, 250, 0.10)",
      "box-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.014)",
    }
  }
  return {
    "background": "linear-gradient(90deg, rgba(146, 64, 14, 0.24), rgba(15, 23, 42, 0.44))",
    "border-bottom-color": "rgba(251, 191, 36, 0.34)",
    "box-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.018), 0 0 0 1px rgba(251, 191, 36, 0.08)",
  }
}

function chainBudgetPillStyle(status: ChainBudgetStatus): JSX.CSSProperties {
  if (status === "ready") {
    return {
      "background-color": "rgba(16, 185, 129, 0.08)",
      "border-color": "transparent",
      color: "rgb(167, 243, 208)",
    }
  }
  return {
    "background-color": "rgba(251, 191, 36, 0.10)",
    "border-color": "transparent",
    color: "rgb(253, 230, 138)",
  }
}

function chainStepRowStyle(input: ActionDescriptor, runState: ChainStepRunState = "draft"): JSX.CSSProperties {
  const { from, to, border } = actionCategoryPalette(input)
  if (runState === "done") {
    return {
      "background": "linear-gradient(90deg, rgba(6, 78, 59, 0.28), rgba(18, 18, 18, 0.74) 48%, rgba(16, 185, 129, 0.10))",
      "border-color": "rgba(52, 211, 153, 0.58)",
      "box-shadow": "inset 4px 0 0 rgba(52, 211, 153, 0.72), inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 6px 14px rgba(0, 0, 0, 0.12)",
    }
  }
  if (runState === "running") {
    return {
      "background": `linear-gradient(90deg, rgba(16, 185, 129, 0.24), rgba(18, 18, 18, 0.78) 48%, ${to})`,
      "border-color": "rgba(110, 231, 183, 0.82)",
      "box-shadow": `inset 4px 0 0 rgba(110, 231, 183, 0.92), inset 0 1px 0 rgba(255, 255, 255, 0.048), 0 0 0 1px rgba(110, 231, 183, 0.34), 0 0 24px rgba(16, 185, 129, 0.22), 0 8px 16px rgba(0, 0, 0, 0.18)`,
    }
  }
  if (runState === "stalled") {
    return {
      "background": `linear-gradient(90deg, rgba(194, 65, 12, 0.34), rgba(18, 18, 18, 0.78) 48%, ${to})`,
      "border-color": "rgba(251, 146, 60, 0.82)",
      "box-shadow": "inset 4px 0 0 rgba(251, 146, 60, 0.90), inset 0 1px 0 rgba(255, 255, 255, 0.048), 0 0 0 1px rgba(251, 146, 60, 0.28), 0 0 22px rgba(249, 115, 22, 0.16), 0 8px 16px rgba(0, 0, 0, 0.18)",
    }
  }
  if (runState === "paused") {
    return {
      "background": `linear-gradient(90deg, rgba(146, 64, 14, 0.30), rgba(18, 18, 18, 0.78) 48%, ${to})`,
      "border-color": "rgba(251, 191, 36, 0.78)",
      "box-shadow": "inset 4px 0 0 rgba(251, 191, 36, 0.86), inset 0 1px 0 rgba(255, 255, 255, 0.045), 0 0 0 1px rgba(251, 191, 36, 0.22), 0 0 20px rgba(245, 158, 11, 0.14), 0 8px 16px rgba(0, 0, 0, 0.18)",
    }
  }
  if (runState === "queued") {
    return {
      "background": "linear-gradient(90deg, rgba(51, 65, 85, 0.22), rgba(18, 18, 18, 0.70) 48%, rgba(148, 163, 184, 0.08))",
      "border-color": "rgba(148, 163, 184, 0.34)",
      "box-shadow": "inset 3px 0 0 rgba(148, 163, 184, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.026), 0 6px 14px rgba(0, 0, 0, 0.10)",
    }
  }
  return {
    "background": `linear-gradient(90deg, ${from}, rgba(18, 18, 18, 0.76) 48%, ${to})`,
    "border-color": border,
    "box-shadow": `inset 3px 0 0 ${border}, inset 0 1px 0 rgba(255, 255, 255, 0.028), 0 6px 14px rgba(0, 0, 0, 0.12)`,
  }
}

function chainStepBadgeStyle(input: ActionDescriptor): JSX.CSSProperties {
  const { border, soft, text } = actionCategoryPalette(input)
  return {
    "background-color": soft,
    "border-color": border,
    color: text,
  }
}

function chainStepSoftStyle(input: ActionDescriptor): JSX.CSSProperties {
  const { border, soft, text } = actionCategoryPalette(input)
  return {
    "background-color": soft,
    "border-color": border,
    color: text,
  }
}

function chainStepRunBadgeStyle(runState: ChainStepRunState, input: ActionDescriptor): JSX.CSSProperties {
  if (runState === "running") {
    return {
      "background-color": "rgba(16, 185, 129, 0.34)",
      "border-color": "rgba(110, 231, 183, 0.82)",
      color: "rgb(209, 250, 229)",
    } satisfies JSX.CSSProperties
  }
  if (runState === "paused") {
    return {
      "background-color": "rgba(245, 158, 11, 0.30)",
      "border-color": "rgba(251, 191, 36, 0.82)",
      color: "rgb(254, 243, 199)",
    } satisfies JSX.CSSProperties
  }
  if (runState === "stalled") {
    return {
      "background-color": "rgba(249, 115, 22, 0.30)",
      "border-color": "rgba(251, 146, 60, 0.82)",
      color: "rgb(255, 237, 213)",
    } satisfies JSX.CSSProperties
  }
  if (runState === "done") {
    return {
      "background-color": "rgba(16, 185, 129, 0.20)",
      "border-color": "rgba(52, 211, 153, 0.64)",
      color: "rgb(209, 250, 229)",
    } satisfies JSX.CSSProperties
  }
  if (runState === "queued") {
    return {
      "background-color": "rgba(51, 65, 85, 0.45)",
      "border-color": "rgba(148, 163, 184, 0.42)",
      color: "rgb(203, 213, 225)",
    } satisfies JSX.CSSProperties
  }
  return chainStepBadgeStyle(input)
}

function runningStatusPanelStyle(status: GoalState["status"] | "stalled"): JSX.CSSProperties {
  if (status === "stalled") {
    return {
      background:
        "radial-gradient(circle at 0% 0%, rgba(251, 146, 60, 0.16), transparent 34%), linear-gradient(180deg, rgba(154, 52, 18, 0.24), rgba(15, 23, 42, 0.52))",
      "border-color": "rgba(251, 146, 60, 0.30)",
      "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.035)",
    } satisfies JSX.CSSProperties
  }
  if (status === "active") {
    return {
      background:
        "radial-gradient(circle at 0% 0%, rgba(52, 211, 153, 0.14), transparent 34%), linear-gradient(180deg, rgba(6, 78, 59, 0.22), rgba(15, 23, 42, 0.52))",
      "border-color": "rgba(52, 211, 153, 0.28)",
      "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.035)",
    } satisfies JSX.CSSProperties
  }
  if (status === "paused") {
    return {
      background:
        "radial-gradient(circle at 0% 0%, rgba(251, 191, 36, 0.14), transparent 34%), linear-gradient(180deg, rgba(146, 64, 14, 0.22), rgba(15, 23, 42, 0.52))",
      "border-color": "rgba(251, 191, 36, 0.28)",
      "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.035)",
    } satisfies JSX.CSSProperties
  }
  if (status === "achieved") {
    return {
      background:
        "radial-gradient(circle at 0% 0%, rgba(110, 231, 183, 0.16), transparent 34%), linear-gradient(180deg, rgba(6, 95, 70, 0.28), rgba(15, 23, 42, 0.54))",
      "border-color": "rgba(110, 231, 183, 0.34)",
      "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.035)",
    } satisfies JSX.CSSProperties
  }
  return {
    background:
      "radial-gradient(circle at 0% 0%, rgba(251, 146, 60, 0.15), transparent 34%), linear-gradient(180deg, rgba(124, 45, 18, 0.24), rgba(15, 23, 42, 0.54))",
    "border-color": "rgba(251, 146, 60, 0.30)",
    "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.035)",
  } satisfies JSX.CSSProperties
}

function runningMetricTileStyle(tone: "time" | "turns" | "step" | "progress"): JSX.CSSProperties {
  if (tone === "time") {
    return {
      "background-color": "rgba(15, 23, 42, 0.46)",
      "border-color": "rgba(96, 165, 250, 0.22)",
      "box-shadow": "inset 3px 0 0 rgba(96, 165, 250, 0.48), inset 0 1px 0 rgba(255,255,255,0.035)",
    } satisfies JSX.CSSProperties
  }
  if (tone === "turns") {
    return {
      "background-color": "rgba(15, 23, 42, 0.46)",
      "border-color": "rgba(167, 139, 250, 0.22)",
      "box-shadow": "inset 3px 0 0 rgba(167, 139, 250, 0.48), inset 0 1px 0 rgba(255,255,255,0.035)",
    } satisfies JSX.CSSProperties
  }
  if (tone === "step") {
    return {
      "background-color": "rgba(15, 23, 42, 0.46)",
      "border-color": "rgba(52, 211, 153, 0.22)",
      "box-shadow": "inset 3px 0 0 rgba(52, 211, 153, 0.48), inset 0 1px 0 rgba(255,255,255,0.035)",
    } satisfies JSX.CSSProperties
  }
  return {
    "background-color": "rgba(2, 6, 23, 0.38)",
    "border-color": "rgba(52, 211, 153, 0.24)",
    "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.04)",
  } satisfies JSX.CSSProperties
}

function runningMetricValueClass(tone: "time" | "turns" | "step") {
  if (tone === "time") return "text-blue-50"
  if (tone === "turns") return "text-violet-50"
  return "text-emerald-50"
}

function runningInlinePanelStyle(tone: "stop" | "steer" | "handoff" | "activity"): JSX.CSSProperties {
  if (tone === "stop") {
    return {
      "background-color": "rgba(124, 45, 18, 0.18)",
      "border-color": "rgba(251, 146, 60, 0.24)",
      "box-shadow": "inset 3px 0 0 rgba(251, 146, 60, 0.54), inset 0 1px 0 rgba(255,255,255,0.03)",
    } satisfies JSX.CSSProperties
  }
  if (tone === "steer") {
    return {
      "background-color": "rgba(12, 74, 110, 0.16)",
      "border-color": "rgba(56, 189, 248, 0.22)",
      "box-shadow": "inset 3px 0 0 rgba(56, 189, 248, 0.50), inset 0 1px 0 rgba(255,255,255,0.03)",
    } satisfies JSX.CSSProperties
  }
  if (tone === "handoff") {
    return {
      "background-color": "rgba(67, 56, 202, 0.16)",
      "border-color": "rgba(129, 140, 248, 0.24)",
      "box-shadow": "inset 3px 0 0 rgba(129, 140, 248, 0.52), inset 0 1px 0 rgba(255,255,255,0.03)",
    } satisfies JSX.CSSProperties
  }
  return {
    "background-color": "rgba(15, 23, 42, 0.40)",
    "border-color": "rgba(34, 211, 238, 0.18)",
    "box-shadow": "inset 3px 0 0 rgba(34, 211, 238, 0.42), inset 0 1px 0 rgba(255,255,255,0.03)",
  } satisfies JSX.CSSProperties
}

function actionSurfaceClass(input: ActionDescriptor) {
  return input.elevation === "raised"
    ? "shadow-[0_10px_24px_rgba(0,0,0,0.24)]"
    : "shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
}

function actionIconName(input: ActionDescriptor) {
  const label = actionLabelText(input)
  if (/edit|document|docs|notes/.test(label)) return "edit"
  if (/search|debug|review|verify|test|typecheck|validate|risk/.test(label)) return "status"
  if (/build|patch|construct|compile/.test(label)) return "grid-plus"
  const text = actionSearchText(input)
  if (/edit|document|docs|notes/.test(text)) return "edit"
  if (/search|debug|review|verify|test|risk/.test(text)) return "status"
  if (/build|patch|construct|compile/.test(text)) return "grid-plus"
  return "plus"
}

function hasVerificationCommand(input: ActionDescriptor) {
  return typeof input.command === "string" && input.command.trim().length > 0
}

function completionRuleLabel(input: ActionDescriptor) {
  return hasVerificationCommand(input) ? "Completes after the verify command succeeds" : "Completes after the agent reports completion"
}

function completionRuleClass(input: ActionDescriptor) {
  return hasVerificationCommand(input)
    ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-200"
    : "border-border-base bg-background-panel/70 text-text-weaker"
}

function terminalOutcomeTone(status: GoalState["status"]): { class: string; style: JSX.CSSProperties } {
  if (status === "achieved") {
    return {
      class: "border-emerald-400/70 bg-emerald-500/20 text-emerald-100",
      style: {
        "border-color": "rgba(52, 211, 153, 0.78)",
        "background-color": "rgba(16, 185, 129, 0.28)",
        color: "rgb(209, 250, 229)",
      },
    }
  }
  if (status === "cleared") {
    return {
      class: "border-orange-400/70 bg-orange-500/25 text-orange-100",
      style: {
        "border-color": "rgba(251, 146, 60, 0.86)",
        "background-color": "rgba(249, 115, 22, 0.34)",
        color: "rgb(255, 237, 213)",
      },
    }
  }
  if (status === "paused") {
    return {
      class: "border-amber-400/70 bg-amber-500/20 text-amber-100",
      style: {
        "border-color": "rgba(251, 191, 36, 0.78)",
        "background-color": "rgba(245, 158, 11, 0.26)",
        color: "rgb(254, 243, 199)",
      },
    }
  }
  return {
    class: "border-sky-400/70 bg-sky-500/20 text-sky-100",
    style: {
      "border-color": "rgba(56, 189, 248, 0.78)",
      "background-color": "rgba(14, 165, 233, 0.24)",
      color: "rgb(224, 242, 254)",
    },
  }
}

interface ChainDraftState {
  steps: GoalChainDraftStep[]
  master: { maxTurns: number; maxTimeMinutes: number }
}

function defaultChainDraft(): ChainDraftState {
  return { steps: [], master: { maxTurns: 20, maxTimeMinutes: 60 } }
}

function chainDraftStorageKey(sessionID?: string) {
  return `opencode.goalChainDraft.${sessionID || "workspace"}`
}

function isStoredChainDraft(value: unknown): value is ChainDraftState {
  if (!value || typeof value !== "object") return false
  const draft = value as { steps?: unknown; master?: unknown }
  if (!Array.isArray(draft.steps)) return false
  if (!draft.master || typeof draft.master !== "object") return false
  const master = draft.master as { maxTurns?: unknown; maxTimeMinutes?: unknown }
  if (typeof master.maxTurns !== "number" || !Number.isFinite(master.maxTurns)) return false
  if (typeof master.maxTimeMinutes !== "number" || !Number.isFinite(master.maxTimeMinutes)) return false
  return draft.steps.every((step) => {
    if (!step || typeof step !== "object") return false
    const id: unknown = Reflect.get(step, "id")
    const actionID: unknown = Reflect.get(step, "actionID")
    const label: unknown = Reflect.get(step, "label")
    const condition: unknown = Reflect.get(step, "condition")
    const command: unknown = Reflect.get(step, "command")
    const maxTurns: unknown = Reflect.get(step, "maxTurns")
    const maxTimeMinutes: unknown = Reflect.get(step, "maxTimeMinutes")
    const category: unknown = Reflect.get(step, "category")
    const tone: unknown = Reflect.get(step, "tone")
    const elevation: unknown = Reflect.get(step, "elevation")
    const skills: unknown = Reflect.get(step, "skills")
    const model: unknown = Reflect.get(step, "model")
    const builtin: unknown = Reflect.get(step, "builtin")
    return (
      typeof id === "string" &&
      typeof actionID === "string" &&
      typeof label === "string" &&
      typeof condition === "string" &&
      typeof command === "string" &&
      typeof maxTurns === "number" &&
      Number.isFinite(maxTurns) &&
      typeof maxTimeMinutes === "number" &&
      Number.isFinite(maxTimeMinutes) &&
      (category === undefined ||
        (typeof category === "string" && (GOAL_TEMPLATE_CATEGORIES as readonly string[]).includes(category))) &&
      (tone === undefined || (typeof tone === "string" && (GOAL_TEMPLATE_TONES as readonly string[]).includes(tone))) &&
      (elevation === undefined ||
        (typeof elevation === "string" && (GOAL_TEMPLATE_ELEVATIONS as readonly string[]).includes(elevation))) &&
      (skills === undefined ||
        (Array.isArray(skills) && skills.every((skill) => typeof skill === "string" && skill.trim().length > 0))) &&
      (model === undefined || typeof model === "string" || isGoalPinnedModel(model)) &&
      typeof builtin === "boolean"
    )
  })
}

function readStoredChainDraft(sessionID?: string): ChainDraftState {
  if (typeof window === "undefined") return defaultChainDraft()
  try {
    const raw = window.sessionStorage.getItem(chainDraftStorageKey(sessionID))
    if (!raw) return defaultChainDraft()
    const parsed: unknown = JSON.parse(raw)
    if (!isStoredChainDraft(parsed)) return defaultChainDraft()
    return {
      steps: parsed.steps.map((step) => ({
        id: step.id,
        actionID: step.actionID,
        label: cleanText(step.label),
        condition: cleanText(step.condition),
        command: cleanText(step.command),
        maxTurns: Math.max(1, Math.round(step.maxTurns)),
        maxTimeMinutes: Math.max(1, Math.round(step.maxTimeMinutes)),
        ...(step.category ? { category: step.category } : {}),
        ...(step.tone ? { tone: step.tone } : {}),
        ...(step.elevation ? { elevation: step.elevation } : {}),
        ...(step.skills && step.skills.length > 0
          ? {
              skills: [
                ...new Set(step.skills.map((skill) => cleanText(skill).trim().slice(0, 80)).filter(Boolean)),
              ].slice(0, 8),
            }
          : {}),
        ...(step.model ? { model: templateModelFromSnapshot(step.model) ?? modelKey(step.model) } : {}),
        builtin: step.builtin,
      })),
      master: {
        maxTurns: Math.max(1, Math.round(parsed.master.maxTurns)),
        maxTimeMinutes: Math.max(1, Math.round(parsed.master.maxTimeMinutes)),
      },
    }
  } catch {
    return defaultChainDraft()
  }
}

function writeStoredChainDraft(sessionID: string | undefined, draft: ChainDraftState) {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(chainDraftStorageKey(sessionID), JSON.stringify(draft))
  } catch {
    // Storage is best-effort; local chain controls still work in memory.
  }
}

export function GoalPanel(props: { goal: { store: GoalStore; refresh: () => Promise<void> }; sessionID?: string }) {
  const language = useLanguage()
  const models = useModels()
  const sdk = useSDK() as unknown as GoalActionClient
  const sync = useSync()
  const state = () => props.goal.store.state

  const [busy, setBusy] = createSignal<GoalAction | "set" | "steer" | "budget" | "step" | "template" | "chain" | null>(null)
  // Optimistic pause/resume: the instant the user clicks, we record the status
  // they drove the goal toward so the single toggle flips immediately, instead
  // of lagging the 2s poll (and risking a stale command). Cleared once the
  // polled status catches up — or reverted if the command failed.
  const [optimisticStatus, setOptimisticStatus] = createSignal<"active" | "paused" | null>(null)
  const [controlError, setControlError] = createSignal<string | null>(null)
  const [confirmingClear, setConfirmingClear] = createSignal(false)
  const [newCondition, setNewCondition] = createSignal("")
  const [newCommand, setNewCommand] = createSignal("")
  const [steerOpen, setSteerOpen] = createSignal(false)
  const [steerText, setSteerText] = createSignal("")
  const [handoff, setHandoff] = createSignal<GoalHandoffStore>({ handoff: null, corrupt: false, loaded: false })
  const [handoffOpen, setHandoffOpen] = createSignal(false)
  const [handoffText, setHandoffText] = createSignal("")
  // When true, show the create form even though a goal exists (the "New goal"
  // affordance), so the panel is never a dead end — including on achieved goals.
  const [showCreate, setShowCreate] = createSignal(false)
  const [activity, setActivity] = createSignal<ActivityEvent[]>([])
  const [chain, setChain] = createSignal<ChainData | null>(null)
  const [templates, setTemplates] = createSignal(DEFAULT_TEMPLATE_BUTTONS)
  const [localTemplateOverrides, setLocalTemplateOverrides] = createSignal<Record<string, GoalTemplateButton>>({})
  const [deletedTemplateIDs, setDeletedTemplateIDs] = createSignal<Record<string, true>>({})
  const [selectedTemplateID, setSelectedTemplateID] = createSignal<string | null>(null)
  const [templateVars, setTemplateVars] = createSignal<Record<string, string>>({})
  const [templateSearch, setTemplateSearch] = createSignal("")
  const [templateCategory, setTemplateCategory] = createSignal<ActionCategory>("All")
  const [chainErrors, setChainErrors] = createSignal<ChainValidationError[]>([])
  const [chainDraft, setChainDraft] = createStore<ChainDraftState>(readStoredChainDraft(props.sessionID))
  const [editingChainStepID, setEditingChainStepID] = createSignal<string | null>(null)
  const [actionDraft, setActionDraft] = createStore<ActionDraftState>({
    sourceID: "",
    id: "",
    label: "",
    prompt: "",
    command: "",
    turns: 5,
    minutes: 20,
    category: "Custom",
    tone: "violet",
    elevation: "flat",
    skills: [],
    model: "",
  })
  const [archive, setArchive] = createSignal<HistoryRun[]>([])
  const [availableSkills, setAvailableSkills] = createSignal<SkillOption[]>([])
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [selectedHistoryGoalID, setSelectedHistoryGoalID] = createSignal<string | null>(null)

  createEffect(() => {
    writeStoredChainDraft(props.sessionID, {
      steps: chainDraft.steps.map((step) => ({ ...step })),
      master: {
        maxTurns: chainDraft.master.maxTurns,
        maxTimeMinutes: chainDraft.master.maxTimeMinutes,
      },
    })
  })

  const ignoreRefreshError = (_error?: unknown) => undefined

  const refreshArchive = () =>
    void readArchive(sdk)
      .then((runs) => {
        const previous = archive()
        // goal-history.json is append-only in normal operation. If a poll lands
        // while the file is being rewritten and momentarily reads back empty,
        // keep the last good archive so the drawer doesn't disappear or collapse.
        if (runs.length === 0 && previous.length > 0) return
        setArchive(runs)
        if (!selectedHistoryGoalID() || !runs.some((run) => run.summary.goalID === selectedHistoryGoalID())) {
          setSelectedHistoryGoalID(runs[0]?.summary.goalID ?? null)
        }
      })
      .catch(ignoreRefreshError)
  const mergeTemplates = (
    base: GoalTemplateButton[],
    overrides = localTemplateOverrides(),
    deleted = deletedTemplateIDs(),
  ) => {
    const seen = new Set<string>()
    const merged: GoalTemplateButton[] = []
    for (const template of base) {
      if (deleted[template.id]) continue
      const next = overrides[template.id] ?? template
      seen.add(next.id)
      merged.push(next)
    }
    for (const template of Object.values(overrides)) {
      if (deleted[template.id] || seen.has(template.id)) continue
      seen.add(template.id)
      merged.push(template)
    }
    return merged
  }

  const refreshTemplates = () =>
    readTemplates(sdk)
      .then((next) => {
        const merged = mergeTemplates(next)
        setTemplates(merged)
        if (!selectedTemplateID() || !merged.some((template) => template.id === selectedTemplateID())) {
          setSelectedTemplateID(merged[0]?.id ?? null)
        }
      })
      .catch(ignoreRefreshError)
  const refreshSkills = () =>
    void readAvailableSkills(sdk)
      .then((next) => {
        setAvailableSkills(next)
      })
      .catch(ignoreRefreshError)
  const refreshHandoff = () => void readHandoffFromSdk(sdk as unknown as GoalSdkClient).then(setHandoff).catch(ignoreRefreshError)

  onMount(() => {
    refreshSkills()
    const tick = () => {
      void readActivity(sdk).then(setActivity).catch(ignoreRefreshError)
      void readChain(sdk).then(setChain).catch(ignoreRefreshError)
      refreshHandoff()
      void refreshTemplates()
      refreshArchive()
      void props.goal.refresh().catch(ignoreRefreshError)
    }
    tick()
    const timer = setInterval(tick, 2000)
    onCleanup(() => clearInterval(timer))
  })

  const refreshChain = () => void readChain(sdk).then(setChain).catch(ignoreRefreshError)

  const refreshGoalSurfaces = async (options: { templates?: boolean } = {}) => {
    await props.goal.refresh().catch(ignoreRefreshError)
    refreshChain()
    refreshHandoff()
    refreshArchive()
    if (options.templates) await refreshTemplates()
  }

  /** Send a deterministic `/goal <args>` control call. This intentionally does
   *  not use session.command; the 2s poll + refresh surface the result. */
  const sendGoalCommand = async (
    label: GoalAction | "set" | "steer" | "budget" | "step" | "template" | "chain",
    args: string,
  ): Promise<boolean> => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return false
    setBusy(label)
    const result = await executeGoalCommand(sdk.client, { sessionID, arguments: args, directory: sdk.directory })
    if (result.ok) {
      setControlError(null)
    } else {
      setControlError(result.error)
    }
    try {
      await refreshGoalSurfaces({ templates: result.ok && label === "template" })
    } finally {
      setBusy(null)
      if (result.ok) setConfirmingClear(false)
      if (result.ok && label === "set") setShowCreate(false)
    }
    return result.ok
  }

  const runAction = async (action: GoalAction) => {
    const sent = await sendGoalCommand(action, action)
    if (!sent) return false
    if (props.sessionID && (action === "restart" || action === "resume")) {
      const prompted = await startGoalRun(sdk.client, {
        sessionID: props.sessionID,
        directory: sdk.directory,
      })
      if (!prompted) {
        setOptimisticStatus("paused")
        await sendGoalCommand("pause", "pause")
        return false
      }
    }
    return true
  }

  const stopGoal = async () => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return false
    setBusy("clear")
    const result = await stopGoalRun(sdk.client, {
      sessionID,
      directory: sdk.directory,
      abortActiveTurn: sync.data.session_working(sessionID),
    })
    if (result.ok) {
      setControlError("warning" in result ? result.warning : null)
    } else {
      setControlError(result.error)
    }
    try {
      await refreshGoalSurfaces()
    } finally {
      setBusy(null)
      if (result.ok) {
        setConfirmingClear(false)
        setOptimisticStatus(null)
      }
    }
    return result.ok
  }

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
      if (props.sessionID) {
        const prompted = await startGoalRun(sdk.client, {
          sessionID: props.sessionID,
          directory: sdk.directory,
        })
        if (!prompted) await sendGoalCommand("pause", "pause")
      }
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
      const shouldWakeRun = liveRunStatus() !== "active" || liveRunStalled()
      if (shouldWakeRun && props.sessionID) {
        await steerGoalRun(sdk.client, {
          sessionID: props.sessionID,
          directory: sdk.directory,
        }, note)
      }
      setSteerText("")
      setSteerOpen(false)
    }
  }

  const handoffGoal = async () => {
    const note = handoffText().trim().replace(/"/g, "")
    const sent = await sendGoalCommand("handoff", note ? `handoff ${note}` : "handoff")
    if (sent) {
      setHandoffText("")
      setHandoffOpen(false)
    }
  }

  const claimGoalHandoff = async () => {
    const sent = await sendGoalCommand("claim", "claim")
    if (!sent) return
    if (props.sessionID) {
      const prompted = await startGoalRun(sdk.client, {
        sessionID: props.sessionID,
        directory: sdk.directory,
      })
      if (!prompted) await sendGoalCommand("pause", "pause")
    }
  }

  /** Action-library entries are selectors, not launchers. The right column
   *  stores reusable prompts; the left column stores an editable local chain.
   *  Only `startGoalChain` crosses the run boundary. */
  const filteredTemplates = createMemo(() => {
    const query = templateSearch().trim().toLowerCase()
    const category = templateCategory()
    return templates().filter((template) => {
      const matchesCategory = category === "All" || inferActionCategory(template) === category
      if (!matchesCategory) return false
      if (!query) return true
      return [
        template.id,
        template.label,
        template.description ?? "",
        template.condition ?? "",
        template.command ?? "",
        inferActionCategory(template),
      ].some((value) => cleanText(value).toLowerCase().includes(query))
    })
  })
  const selectedTemplate = createMemo(() => templates().find((t) => t.id === selectedTemplateID()) ?? null)
  const masterTurns = () => chainDraft.master.maxTurns
  const masterMinutes = () => chainDraft.master.maxTimeMinutes
  const budgetSummary = createMemo(() =>
    chainBudgetSummary(chainDraft.steps, {
      maxTurns: chainDraft.master.maxTurns,
      maxTimeMinutes: chainDraft.master.maxTimeMinutes,
    }),
  )
  const chainBudgetStatus = createMemo<ChainBudgetStatus>(() => {
    const budget = budgetSummary()
    if (budget.masterTurnsIsCap && budget.masterTimeIsCap) return "both"
    if (budget.masterTurnsIsCap) return "turns"
    if (budget.masterTimeIsCap) return "time"
    return "ready"
  })
  const chainBudgetStatusLabel = createMemo(() => {
    switch (chainBudgetStatus()) {
      case "both":
        return language.t("session.goal.chainBuilder.budget.bothOver")
      case "turns":
        return language.t("session.goal.chainBuilder.budget.turnsOver")
      case "time":
        return language.t("session.goal.chainBuilder.budget.timeOver")
      default:
        return language.t("session.goal.chainBuilder.budget.ready")
    }
  })
  const chainBudgetStatusDetail = createMemo(() => {
    const budget = budgetSummary()
    if (chainBudgetStatus() === "ready") return language.t("session.goal.chainBuilder.budget.readyDetail")
    return `${chainBudgetStatusLabel()}: ${budget.ultimateTurns}/${budget.masterTurns} turns · ${budget.ultimateTimeMinutes}/${budget.masterTimeMinutes}m`
  })
  const chainLimitSummary = createMemo(() => `${masterTurns()} turns / ${masterMinutes()}m`)
  const templateConstraintsLabel = (template: GoalTemplateButton) => {
    const c = template.constraints
    if (!c) return ""
    return [
      typeof c.maxTurns === "number" ? `${c.maxTurns} turns` : "",
      typeof c.maxTimeMinutes === "number" ? `${c.maxTimeMinutes}m` : "",
      typeof c.maxTokens === "number" ? `${c.maxTokens.toLocaleString()} tokens` : "",
    ]
      .filter(Boolean)
      .join(" / ")
  }
  const seedActionDraft = (template: GoalTemplateButton | undefined) => {
    const c = template?.constraints
    setActionDraft({
      sourceID: template?.id ?? "",
      id: template ? (template.builtin ? `${template.id}-custom` : template.id) : uniqueTemplateID("custom-action"),
      label: template?.label ?? "",
      prompt: template?.condition ?? "",
      command: template?.command ?? "",
      turns: typeof c?.maxTurns === "number" ? c.maxTurns : 5,
      minutes: typeof c?.maxTimeMinutes === "number" ? c.maxTimeMinutes : 20,
      category: template ? inferActionCategory(template) : "Custom",
      tone: template?.tone ?? inferredActionTone(template ?? {}),
      elevation: template?.elevation ?? "flat",
      skills: template?.skills ? [...template.skills] : [],
      model: modelKey(template?.model),
    })
  }
  const selectActionForView = (template: GoalTemplateButton) => {
    setEditingChainStepID(null)
    setSelectedTemplateID(template.id)
    setTemplateVars(templateVariableDefaults(template))
    seedActionDraft(template)
  }
  createEffect(() => {
    const list = filteredTemplates()
    if (list.length === 0) return
    if (selectedTemplateID() && list.some((template) => template.id === selectedTemplateID())) return
    const first = list[0]
    if (first) selectActionForView(first)
  })
  const varsForAction = (template: GoalTemplateButton) => {
    const defaults = templateVariableDefaults(template)
    const scope = newCondition().trim()
    return {
      ...defaults,
      ...templateVars(),
      ...(scope && template.variables?.scope ? { scope } : {}),
    }
  }
  const addActionToChain = (template: GoalTemplateButton, vars = varsForAction(template)) => {
    const step = chainStepFromTemplate(template, vars, `${template.id}-${Date.now()}-${chainDraft.steps.length}`)
    if (!step.condition.trim()) return
    setChainDraft("steps", chainDraft.steps.length, step)
  }
  const moveDraftStep = (from: number, to: number) => {
    if (to < 0 || to >= chainDraft.steps.length) return
    const next = [...chainDraft.steps]
    const [step] = next.splice(from, 1)
    if (!step) return
    next.splice(to, 0, step)
    setChainDraft("steps", next)
  }
  const removeDraftStep = (id: string) => {
    setChainDraft(
      "steps",
      chainDraft.steps.filter((step) => step.id !== id),
    )
  }
  const updateDraftStepBudget = (id: string, field: "maxTurns" | "maxTimeMinutes", raw: string) => {
    const index = chainDraft.steps.findIndex((step) => step.id === id)
    if (index === -1) return
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value)) return
    setChainDraft("steps", index, field, Math.max(1, value))
  }
  const updateMasterBudget = (field: "maxTurns" | "maxTimeMinutes", raw: string) => {
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value)) return
    setChainDraft("master", field, Math.max(1, value))
  }
  const modelOptions = createMemo(() =>
    models
      .list()
      .map((model) => {
        const key = `${model.provider.id}:${model.id}`
        return {
          key,
          label: `${model.provider.name} / ${model.name}`,
          provider: model.provider.name,
          model: model.name,
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
  )
  const modelOptionsForDraft = createMemo(() => {
    const selected = actionDraft.model.trim()
    if (!selected || modelOptions().some((option) => option.key === selected)) return modelOptions()
    return [
      {
        key: selected,
        label: selected,
        provider: language.t("session.goal.template.savedPin"),
        model: selected,
      },
      ...modelOptions(),
    ]
  })
  const modelLabelByKey = createMemo(() => new Map(modelOptionsForDraft().map((option) => [option.key, option.label])))
  const modelLabel = (model?: GoalTemplateModel) => {
    const key = modelKey(model)
    if (!key) return ""
    return modelLabelByKey().get(key) ?? (isGoalPinnedModel(model) ? `${model.providerID} / ${model.modelID}` : key)
  }
  const sessionModelLabel = () => {
    const configured = cleanText(sync.data.config.model).trim()
    const parts = configured.includes("/") ? configured.split("/") : []
    const providerID = cleanText(parts[0]).trim()
    const modelID = cleanText(parts.slice(1).join("/")).trim()
    if (providerID && modelID) {
      return modelLabel({ providerID, modelID }) || `${providerID} / ${modelID}`
    }
    const agentModel = sync.data.agent.find((item) => item.mode !== "subagent" && !item.hidden)?.model
    if (agentModel?.providerID && agentModel.modelID) {
      return modelLabel(agentModel) || `${agentModel.providerID} / ${agentModel.modelID}`
    }
    return "Session default model"
  }
  const stepRuntimeModelLabel = (step: GoalChainDraftStep) => modelLabel(step.model) || sessionModelLabel()
  const stepRuntimeSkillLabel = (step: GoalChainDraftStep) => {
    const count = step.skills?.length ?? 0
    if (count <= 0) return "No pinned skills"
    if (count === 1) return step.skills?.[0] ?? "1 skill"
    return `${count} skills`
  }
  const stepRuntimeTitle = (step: GoalChainDraftStep) => {
    const skills = step.skills?.length ? step.skills.join(", ") : "no pinned skills"
    return `${stepRuntimeModelLabel(step)}; ${skills}; ${completionRuleLabel(step)}`
  }
  const skillOptionsForDraft = createMemo(() => {
    const seen = new Set<string>()
    const out: SkillOption[] = []
    for (const skill of actionDraft.skills) {
      const name = cleanText(skill).trim().slice(0, 80)
      if (!name || seen.has(name)) continue
      seen.add(name)
      out.push({ name, description: language.t("session.goal.template.savedPin") })
    }
    for (const skill of availableSkills()) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      out.push(skill)
    }
    return out
  })
  const skillPickOptions = createMemo(() =>
    skillOptionsForDraft().filter((skill) => !actionDraft.skills.includes(skill.name)),
  )
  const toggleActionSkill = (name: string) => {
    const clean = cleanText(name).trim().slice(0, 80)
    if (!clean) return
    setActionDraft("skills", (current) => {
      if (current.includes(clean)) return current.filter((skill) => skill !== clean)
      return [...current, clean].slice(0, 8)
    })
  }
  const openActionEditor = (template?: GoalTemplateButton) => {
    setEditingChainStepID(null)
    if (!template) {
      setSelectedTemplateID(null)
      setTemplateVars({})
    }
    seedActionDraft(template)
  }
  const editTemplateDraft = (template: GoalTemplateButton) => {
    openActionEditor(template)
  }
  const draftFromChainStep = (step: GoalChainDraftStep): ActionDraftState => ({
    sourceID: step.actionID || step.id,
    id: step.actionID || step.id,
    label: step.label,
    prompt: step.condition,
    command: step.command,
    turns: step.maxTurns,
    minutes: step.maxTimeMinutes,
    category: step.category ?? inferActionCategory(step),
    tone: step.tone ?? inferredActionTone(step),
    elevation: step.elevation ?? "flat",
    skills: step.skills ? [...step.skills] : [],
    model: modelKey(step.model),
  })
  const editChainStepDraft = (step: GoalChainDraftStep) => {
    if (liveGoal()) return
    setSelectedTemplateID(null)
    setTemplateVars({})
    setEditingChainStepID(step.id)
    setActionDraft(draftFromChainStep(step))
  }
  const actionDraftTemplate = (): ActionDraftTemplate => {
    const id = actionDraft.id.trim() || actionIDFromLabel(actionDraft.label)
    const label = actionDraft.label.trim() || id
    const condition = actionDraft.prompt.trim()
    const command = actionDraft.command.trim()
    const sourceTemplate = selectedTemplate()
    const pinnedModel = pinnedModelFromKey(actionDraft.model)
    const referencedVars = referencedTemplateVariables(condition, command)
    const variables =
      sourceTemplate?.variables && referencedVars.size > 0
        ? Object.fromEntries(Object.entries(sourceTemplate.variables).filter(([key]) => referencedVars.has(key)))
        : undefined
    return {
      id,
      label,
      description: label || (condition.length > 80 ? `${condition.slice(0, 77)}...` : condition),
      condition,
      ...(command ? { command } : {}),
      constraints: {
        maxTurns: Math.max(1, Math.round(actionDraft.turns)),
        maxTimeMinutes: Math.max(1, Math.round(actionDraft.minutes)),
      },
      ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
      category: actionDraft.category,
      tone: actionDraft.tone,
      elevation: actionDraft.elevation,
      ...(actionDraft.skills.length > 0 ? { skills: [...actionDraft.skills] } : {}),
      ...(pinnedModel ? { model: pinnedModel } : {}),
      builtin: false,
    }
  }
  const actionEditorDescriptor = createMemo<ActionDescriptor>(() => {
    return actionDraftTemplate()
  })
  const upsertLocalTemplate = (template: GoalTemplateButton) => {
    setDeletedTemplateIDs((current) => {
      const next = { ...current }
      delete next[template.id]
      return next
    })
    setLocalTemplateOverrides((current) => {
      const next = { ...current, [template.id]: template }
      setTemplates(mergeTemplates(templates(), next, deletedTemplateIDs()))
      return next
    })
  }
  const removeLocalTemplate = (id: string) => {
    setLocalTemplateOverrides((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setDeletedTemplateIDs((current) => {
      const next = { ...current, [id]: true as const }
      setTemplates(mergeTemplates(templates(), localTemplateOverrides(), next))
      return next
    })
  }
  const updateEditingChainStep = () => {
    const editingID = editingChainStepID()
    if (!editingID || liveGoal()) return
    const index = chainDraft.steps.findIndex((step) => step.id === editingID)
    if (index === -1) {
      setEditingChainStepID(null)
      return
    }
    const template = actionDraftTemplate()
    if (!template.condition.trim()) return
    const step = chainStepFromTemplate(template, templateVars(), editingID)
    setChainDraft("steps", index, step)
  }
  const actionDraftPayload = () => {
    const template = actionDraftTemplate()
    return {
      label: template.label,
      description: template.description || template.label,
      condition: template.condition,
      ...(template.command ? { command: template.command } : {}),
      ...(template.constraints ? { constraints: template.constraints } : {}),
      ...(template.variables ? { variables: template.variables } : {}),
      category: template.category,
      ...(template.tone ? { tone: template.tone } : {}),
      ...(template.elevation ? { elevation: template.elevation } : {}),
      ...(template.skills && template.skills.length > 0 ? { skills: [...template.skills] } : {}),
      ...(template.model ? { model: template.model } : {}),
    }
  }
  const [saveError, setSaveError] = createSignal("")
  const saveTemplateDraft = async () => {
    const existingID = actionDraft.id.trim()
    const id = TEMPLATE_SAVE_ID_RE.test(existingID)
      ? existingID
      : uniqueTemplateID(actionIDFromLabel(actionDraft.label))
    const condition = actionDraft.prompt.trim()
    if (!condition) return
    const payload = actionDraftPayload()
    const sent = await sendGoalCommand("template", `template import ${id} ${JSON.stringify(payload)}`)
    if (sent) {
      setSaveError("")
      const savedTemplate = { ...actionDraftTemplate(), id, actionID: id, sourceID: id, builtin: false }
      upsertLocalTemplate(savedTemplate)
      setSelectedTemplateID(id)
      setActionDraft("sourceID", id)
      setActionDraft("id", id)
    } else {
      setSaveError("Save failed — check session or retry")
      setTimeout(() => setSaveError(""), 4000)
    }
  }
  const duplicateActionDraft = async () => {
    const condition = actionDraft.prompt.trim()
    if (!condition) return
    const id = uniqueTemplateID(`${actionDraft.id.trim() || "custom-action"}-copy`)
    const sent = await sendGoalCommand("template", `template import ${id} ${JSON.stringify(actionDraftPayload())}`)
    if (sent) {
      const savedTemplate = { ...actionDraftTemplate(), id, actionID: id, sourceID: id, builtin: false }
      upsertLocalTemplate(savedTemplate)
      setSelectedTemplateID(id)
      setActionDraft("sourceID", id)
      setActionDraft("id", id)
    }
  }
  const duplicateActionTemplate = async (template: GoalTemplateButton) => {
    if (!template.condition) return
    const id = uniqueTemplateID(`${template.id}-copy`)
    const payload = templatePayload(template)
    const sent = await sendGoalCommand("template", `template import ${id} ${JSON.stringify(payload)}`)
    if (sent) {
      const duplicatedTemplate = { ...template, id, actionID: id, sourceID: id, label: template.label, builtin: false }
      upsertLocalTemplate(duplicatedTemplate)
      setSelectedTemplateID(id)
    }
  }
  const editorActiveLabel = createMemo(() => {
    if (editingChainStepID()) return language.t("session.goal.template.activeRunStep")
    if (selectedTemplateID()) return language.t("session.goal.template.activeLibrary")
    return language.t("session.goal.template.newDraft")
  })
  const editorActiveHint = createMemo(() => {
    if (editingChainStepID()) return language.t("session.goal.template.activeRunStepHint")
    if (selectedTemplateID()) return language.t("session.goal.template.activeLibraryHint")
    return language.t("session.goal.template.newDraftHint")
  })
  const deleteActionTemplate = async (template: GoalTemplateButton) => {
    if (template.builtin) return
    const sent = await sendGoalCommand("template", `template delete ${template.id}`)
    if (sent) {
      removeLocalTemplate(template.id)
      const next = templates().find((candidate) => candidate.id !== template.id)
      if (next) {
        selectActionForView(next)
      } else {
        openActionEditor()
      }
    }
  }
  const uniqueTemplateID = (base: string) => {
    const existing = new Set(templates().map((template) => template.id))
    const cleanBase = TEMPLATE_SAVE_ID_RE.test(base) ? base : "custom-template"
    if (!existing.has(cleanBase)) return cleanBase
    const match = cleanBase.match(/^(.*?)-(\d+)$/)
    const root = match?.[1] || cleanBase
    const start = match ? Number(match[2]) + 1 : 2
    for (let i = start; i < start + 100; i++) {
      const next = `${root}-${i}`
      if (!existing.has(next)) return next
    }
    return `${root}-${Date.now()}`
  }
  const templatePayload = (template: GoalTemplateButton) => ({
    description: template.description || template.label,
    condition: template.condition || template.label,
    ...(template.command ? { command: template.command } : {}),
    ...(template.constraints ? { constraints: template.constraints } : {}),
    ...(template.variables ? { variables: template.variables } : {}),
    category: inferActionCategory(template),
    ...(template.tone ? { tone: template.tone } : {}),
    ...(template.elevation ? { elevation: template.elevation } : {}),
    ...(template.skills && template.skills.length > 0 ? { skills: [...template.skills] } : {}),
    ...(template.model ? { model: template.model } : {}),
  })
  const selectTemplateAt = (index: number) => {
    const list = filteredTemplates()
    if (list.length === 0) return
    const next = list[Math.max(0, Math.min(list.length - 1, index))]
    if (next) selectActionForView(next)
  }
  const handleTemplateListboxKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    const list = filteredTemplates()
    const current = list.findIndex((template) => template.id === selectedTemplateID())
    if (event.key === "Home") return selectTemplateAt(0)
    if (event.key === "End") return selectTemplateAt(list.length - 1)
    selectTemplateAt(event.key === "ArrowDown" ? current + 1 : current <= 0 ? 0 : current - 1)
  }
  const chainSnapshotSteps = (): GoalChainDraftStep[] => {
    const runningChain = chain()
    if (!runningChain) return []
    const s = state()
    return runningChain.steps.map((step, index) => ({
      id: `running-${index}`,
      actionID: `running-${index}`,
      label: cleanText(step.condition).slice(0, 52) || `Step ${index + 1}`,
      condition: cleanText(step.condition),
      command: cleanText(step.command ?? ""),
      maxTurns: step.maxTurns ?? s?.constraints.maxTurns ?? chainDraft.master.maxTurns,
      maxTimeMinutes: step.maxTimeMinutes ?? s?.constraints.maxTimeMinutes ?? chainDraft.master.maxTimeMinutes,
      category: step.category ?? inferActionCategory(step),
      tone: step.tone ?? inferredActionTone(step),
      elevation: step.elevation ?? "flat",
      builtin: false,
      skills: Array.isArray(step.skills)
        ? [...new Set(step.skills.map((skill) => cleanText(skill).trim().slice(0, 80)).filter(Boolean))].slice(0, 8)
        : [],
      model: templateModelFromSnapshot(step.model) ?? "",
    }))
  }
  const runnableChainSteps = () => {
    if (liveGoal()) return []
    return selectRunnableChainSteps(chainDraft.steps, chainSnapshotSteps())
  }
  const startGoalChain = async () => {
    const steps = runnableChainSteps()
    if (steps.length === 0) return
    const errors = validateChainDraft(steps, {
      maxTurns: chainDraft.master.maxTurns,
      maxTimeMinutes: chainDraft.master.maxTimeMinutes,
    })
    setChainErrors(errors)
    if (errors.length > 0) return
    const firstStepModel = pinnedModelForRuntime(steps[0]?.model)
    const firstStepSkills = steps[0]?.skills
    const payload = JSON.stringify({
      master: { maxTurns: chainDraft.master.maxTurns, maxMinutes: chainDraft.master.maxTimeMinutes },
      steps: steps.map((step) => {
        const model = pinnedModelForRuntime(step.model)
        return {
          condition: step.condition,
          ...(step.command.trim()
            ? {
                command: step.command.trim(),
                verification: { type: "shell", command: step.command.trim() },
              }
            : { verification: { type: "marker" } }),
          maxTurns: step.maxTurns,
          maxMinutes: step.maxTimeMinutes,
          ...(step.category ? { category: step.category } : {}),
          ...(step.tone ? { tone: step.tone } : {}),
          ...(step.elevation ? { elevation: step.elevation } : {}),
          ...(step.skills && step.skills.length > 0 ? { skills: [...step.skills] } : {}),
          ...(model ? { model } : {}),
        }
      }),
    })
    const sent = await sendGoalCommand("chain", `chain start-json ${payload}`)
    if (sent) {
      if (props.sessionID) {
        const prompted = await startGoalRun(sdk.client, {
          sessionID: props.sessionID,
          directory: sdk.directory,
          ...(firstStepModel ? { model: firstStepModel } : {}),
          ...(firstStepSkills && firstStepSkills.length > 0 ? { skills: firstStepSkills } : {}),
        })
        if (!prompted) await sendGoalCommand("pause", "pause")
      }
      setShowCreate(false)
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
  const currentGoalTurns = createMemo(() => state()?.turnsEvaluated ?? 0)
  const maxGoalTurns = createMemo(() => state()?.constraints.maxTurns ?? masterTurns())
  const currentGoalMinutes = createMemo(() => (state() ? elapsedMinutes() : 0))
  const maxGoalMinutes = createMemo(() => state()?.constraints.maxTimeMinutes ?? masterMinutes())

  const selectedHistoryRun = createMemo(
    () => archive().find((run) => run.summary.goalID === selectedHistoryGoalID()) ?? null,
  )
  const goalCommandAvailable = createMemo(() => sync.data.command.some((item) => item.name === "goal"))
  const goalCommandMissing = createMemo(() => sync.ready && !goalCommandAvailable())

  const selectHistoryAt = (index: number) => {
    const runs = archive()
    if (runs.length === 0) return
    const next = runs[Math.max(0, Math.min(runs.length - 1, index))]
    if (next) setSelectedHistoryGoalID(next.summary.goalID)
  }

  const handleHistoryListboxKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    const runs = archive()
    const current = runs.findIndex((run) => run.summary.goalID === selectedHistoryGoalID())
    if (event.key === "Home") return selectHistoryAt(0)
    if (event.key === "End") return selectHistoryAt(runs.length - 1)
    selectHistoryAt(event.key === "ArrowDown" ? current + 1 : current <= 0 ? 0 : current - 1)
  }

  const formatElapsed = (elapsedMs: number) => {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return "<1m"
    const minutes = Math.round(elapsedMs / 60_000)
    return minutes > 0 ? `${minutes}m` : "<1m"
  }

  const reuseHistoryRun = (command: string) => sendGoalCommand("set", command)

  // ── Lifecycle model ──────────────────────────────────────────────────────
  // The panel renders strictly by STATUS, not by "is there a state object?".
  // The pure accessors live in `./goal-panel-lifecycle`; the createMemo
  // wrappers below memoize on the state signal so the render is stable
  // when the underlying JSON hasn't changed.
  //
  // This model makes the two failure modes structurally impossible:
  //   - a goal achieved in one turn never shows a hollow "active" card —
  //     `liveGoal` returns null and the empty + history view renders.
  //   - clearing a goal doesn't blank the panel — `liveGoal` returns
  //     null and the run is already in the history timeline.
  const liveGoal = createMemo(() => liveGoalOf(state()))
  const terminalGoal = createMemo(() => terminalGoalOf(state()))
  const visibleChainSteps = createMemo<GoalChainDraftStep[]>(() => {
    const live = liveGoal()
    if (!live && chainDraft.steps.length > 0) return chainDraft.steps
    const runningChain = chain()
    if (runningChain) return chainSnapshotSteps()
    // A single live goal has no chain file. Render the one running goal as a
    // single step rather than the leftover sessionStorage chain draft — which
    // would otherwise show up as a fake "1/N" executing chain on the running
    // screen, highlighting an unrelated draft step as "running".
    if (live) {
      const descriptor: ActionDescriptor = {
        condition: cleanText(live.condition),
        label: cleanText(live.condition).slice(0, 52),
      }
      return [
        {
          id: "running-single",
          actionID: "running-single",
          label: descriptor.label || "Goal",
          condition: descriptor.condition ?? "",
          command: "",
          maxTurns: live.constraints?.maxTurns ?? chainDraft.master.maxTurns,
          maxTimeMinutes: live.constraints?.maxTimeMinutes ?? chainDraft.master.maxTimeMinutes,
          category: inferActionCategory(descriptor),
          tone: inferredActionTone(descriptor),
          elevation: "flat",
          builtin: false,
          skills: [],
        },
      ]
    }
    return chainDraft.steps
  })
  const visibleStepCount = createMemo(() => visibleChainSteps().length)
  const runningStepIndex = createMemo(() => {
    if (!liveGoal()) return -1
    const runningChain = chain()
    if (runningChain) return Math.max(0, Math.min(runningChain.current, Math.max(0, runningChain.steps.length - 1)))
    return visibleStepCount() > 0 ? 0 : -1
  })
  const liveRunStatus = createMemo<GoalState["status"] | null>(() => optimisticStatus() ?? liveGoal()?.status ?? null)
  const latestActivityAt = createMemo(() => activity()[0]?.at ?? null)
  const liveRunStalled = createMemo(() => isGoalStalled(liveRunStatus() ?? undefined, latestActivityAt(), Date.now()))
  const liveRunIdleMinutes = createMemo(() => goalIdleMinutes(latestActivityAt(), Date.now()))
  const stepRunState = (index: number): ChainStepRunState => {
    if (!liveGoal()) return "draft"
    const current = runningStepIndex()
    if (current < 0) return "draft"
    const status = liveRunStatus()
    if (status === "achieved") return index <= current ? "done" : "queued"
    if (index < current) return "done"
    if (index === current) {
      if (status === "paused") return "paused"
      if (status === "active") return liveRunStalled() ? "stalled" : "running"
      return "queued"
    }
    return "queued"
  }
  const removeLiveChainStep = async (index: number) => {
    if (index <= runningStepIndex()) return false
    return sendGoalCommand("chain", `chain remove ${index + 1}`)
  }
  const removeVisibleStep = (step: GoalChainDraftStep, index: number) => {
    if (liveGoal()) return void removeLiveChainStep(index)
    removeDraftStep(step.id)
  }
  const unarchivedTerminalGoal = createMemo(() => {
    const goal = terminalGoal()
    if (!goal) return null
    if (archive().some((run) => run.summary.goalID === goal.id)) return null
    return goal
  })

  // The pause/resume toggle's next action, honoring the optimistic override.
  const pauseResume = createMemo(() => pauseResumeAction(state()?.status, optimisticStatus()))
  const chainRunStateLabel = createMemo(() => {
    const status = liveRunStatus()
    if (status === "active") return liveRunStalled() ? language.t("session.goal.chainBuilder.stalledButton") : language.t("session.goal.chainBuilder.runningButton")
    if (status === "paused") return language.t("session.goal.chainBuilder.pausedButton")
    if (status === "achieved") return language.t("session.goal.chainBuilder.completedButton")
    if (status === "cleared") return language.t("session.goal.chainBuilder.stoppedButton")
    return language.t("session.goal.chainBuilder.planChain")
  })
  const chainRunStateTitle = createMemo(() => {
    return language.t("session.goal.chainBuilder.title")
  })
  const chainRunStateSubtitle = createMemo(() => {
    if (liveGoal()) return "Progress, controls, and step status stay in this workspace."
    return language.t("session.goal.chainBuilder.subtitle")
  })

  // Drop the optimistic override once polling returns any concrete lifecycle
  // status. A contradictory active/paused value must win over optimism; a
  // provider/session error can pause the goal after prompt admission, and the
  // panel must not keep saying Running in that case.
  createEffect(() => {
    const opt = optimisticStatus()
    if (!opt) return
    const real = state()?.status
    if (real === "active" || real === "paused" || real === "achieved" || real === "cleared") {
      setOptimisticStatus(null)
    }
  })

  const showForm = createMemo(() => shouldShowCreateFormOf(state(), showCreate()))
  const statusMeta = (s: GoalState["status"] | undefined) => statusMetaOf(s)
  const nodeColor = (status: string) => nodeColorOf(status)
  const outcomeLabel = (outcome: string) => outcomeLabelOf(outcome)

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
        <Match when={props.goal.store.loaded && !props.goal.store.corrupt}>
          <div data-component="goal-playbook-workspace" class="flex min-h-0 min-w-0 flex-col gap-3 pb-2">
            <div
              data-testid="chain-workspace"
              data-component="goal-chain-builder-workspace"
              class="grid min-h-0 min-w-0 grid-cols-1 gap-3 xl:h-[calc(100vh-8rem)] xl:grid-cols-[minmax(620px,1fr)_minmax(360px,420px)] xl:gap-3"
            >
              <section data-testid="goal-status-card" data-component="goal-status-card" class="hidden">
            <Show when={unarchivedTerminalGoal()} keyed>
              {(terminal) => (
                <GoalConsoleSection
                  zone="last-result"
                  title={language.t("session.goal.lastResult")}
                  subtitle="Most recent run outcome and evidence."
                >
                  <div data-component="goal-terminal-summary" class="min-w-0 p-3">
                    <div
                      data-component="goal-terminal-output-card"
                      class="rounded-lg border border-border-base bg-background-base/80 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                    >
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-weaker">
                          Last run outcome
                        </span>
                        <span
                          data-component="goal-terminal-outcome-badge"
                          class={`inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ${terminalOutcomeTone(terminal.status).class}`}
                          style={terminalOutcomeTone(terminal.status).style}
                        >
                          <span aria-hidden>{statusMeta(terminal.status).glyph}</span>
                          {statusMeta(terminal.status).label}
                        </span>
                      </div>
                      <div
                        class="mt-3 break-words text-14-medium leading-5 text-text-base"
                        title={cleanText(terminal.condition)}
                      >
                        {cleanText(terminal.condition)}
                      </div>
                      <Show when={terminal.lastEvaluation?.reason}>
                        <div class="mt-3 rounded-md border border-border-base bg-background-panel/80 px-2.5 py-2 text-11-regular leading-5 text-text-weak">
                          {cleanText(terminal.lastEvaluation!.reason)}
                        </div>
                      </Show>
                    </div>
                    <div
                      data-component="goal-terminal-stat-line"
                      class="mt-2 grid grid-cols-2 gap-1.5 rounded-md border border-border-base bg-background-base/70 p-1.5 text-11-regular text-text-weak"
                    >
                      <div class="rounded border border-border-base bg-background-panel/70 px-2 py-1.5">
                        <div class="text-[9px] uppercase tracking-[0.08em] text-text-weaker">Turns</div>
                        <div class={numericHighlightClass("mt-1")} style={numericHighlightStyle("blue")}>
                          {terminal.turnsEvaluated}/{terminal.constraints.maxTurns}
                        </div>
                      </div>
                      <div class="rounded border border-border-base bg-background-panel/70 px-2 py-1.5">
                        <div class="text-[9px] uppercase tracking-[0.08em] text-text-weaker">Time</div>
                        <div class={numericHighlightClass("mt-1")} style={numericHighlightStyle("blue")}>
                          {formatElapsed((terminal.completedAt ?? Date.now()) - terminal.startedAt)}/
                          {terminal.constraints.maxTimeMinutes}m
                        </div>
                      </div>
                    </div>
                  </div>
                </GoalConsoleSection>
              )}
            </Show>
            <GoalConsoleSection
              zone="set-goal"
              title={language.t("session.goal.create.title")}
              subtitle="Create one standalone goal outside the chain."
            >
              <div data-component="goal-playbook-setup" class="min-w-0 p-3">
                <div class="flex justify-end">
                  <Show when={showCreate() && liveGoal()}>
                    <button
                      type="button"
                      class="text-11-regular text-text-weaker hover:text-text-base shrink-0"
                      onClick={() => setShowCreate(false)}
                    >
                      {language.t("session.goal.action.cancel")}
                    </button>
                  </Show>
                </div>
                <Show when={goalCommandMissing()}>
                  <div class="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/8 px-3 py-2 text-11-regular text-text-weak">
                    This session does not expose the <code>/goal</code> slash command. GoalPanel controls will use the
                    native bridge directly.
                  </div>
                </Show>
                <Show when={controlError()}>
                  {(message) => (
                    <div
                      data-component="goal-control-error"
                      class="mt-3 rounded-xl border border-red-400/35 bg-red-500/10 px-3 py-2 text-11-regular leading-5 text-red-100"
                    >
                      Goal control failed: {message()}
                    </div>
                  )}
                </Show>
                <div class="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-border-base bg-background-base/60 p-2">
                  <TextField
                    value={newCondition()}
                    onChange={setNewCondition}
                    label={language.t("session.goal.create.condition")}
                    hideLabel
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
                  <ActionButton
                    variant="primary"
                    class="h-8 w-full"
                    label={language.t("session.goal.create.submit")}
                    onClick={() => void createGoal()}
                    disabled={!newCondition().trim() || !props.sessionID || busy() !== null}
                    busy={busy() === "set"}
                  />
                </div>

                <div
                  data-component="goal-playbook-budget-strip"
                  class="mt-2 flex items-center gap-3 px-1 text-11-regular text-text-weaker"
                >
                  <span>Turns <span class="tabular-nums text-text-base">{currentGoalTurns()}/{maxGoalTurns()}</span></span>
                  <span>Time <span class="tabular-nums text-text-base">{currentGoalMinutes()}m/{maxGoalMinutes()}m</span></span>
                  <span class="ml-auto">{budgetSummary().stepCount} step{budgetSummary().stepCount !== 1 ? "s" : ""}</span>
                </div>
              </div>
            </GoalConsoleSection>
              </section>
              <GoalConsoleSection
                zone="chain-builder"
                title={language.t("session.goal.chainBuilder.shortTitle")}
                subtitle={liveGoal() ? chainRunStateSubtitle() : language.t("session.goal.chainBuilder.sectionHint")}
                class="min-h-0"
              >
              <div
                data-component="goal-chain-builder"
                data-testid="chain-builder"
                class="flex h-full min-h-0 min-w-0 flex-col bg-[radial-gradient(circle_at_16%_0%,rgba(139,92,246,0.075),transparent_34%),linear-gradient(180deg,rgba(24,24,27,0.74),rgba(10,10,10,0.70))]"
              >
              <div
                data-component="goal-chain-builder-header-strip"
                data-budget-status={liveGoal() ? "running" : chainBudgetStatus()}
                class="relative z-10 shrink-0 border-b px-2.5 py-1"
                style={chainBuilderHeaderStyle(chainBudgetStatus(), !!liveGoal())}
              >
                <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 lg:grid-cols-[minmax(260px,1fr)_auto]">
                  <div
                    class="flex min-w-0 items-center gap-1.5"
                    title={liveGoal() ? chainRunStateSubtitle() : language.t("session.goal.chainBuilder.subtitle")}
                  >
                    <span
                      class="h-4 w-1.5 shrink-0 rounded-full"
                      classList={{
                        "bg-orange-300/90": liveRunStalled(),
                        "bg-emerald-300/90": liveRunStatus() === "active" && !liveRunStalled(),
                        "bg-amber-300/90": liveRunStatus() === "paused" || (!liveGoal() && chainBudgetStatus() !== "ready"),
                        "bg-violet-300/80": !liveGoal() && chainBudgetStatus() === "ready",
                      }}
                      aria-hidden
                    />
                    <div class="truncate text-[12px] font-bold uppercase tracking-[0.12em] text-violet-50">
                      {liveGoal() ? language.t("session.goal.chainBuilder.runningHeader") : chainRunStateLabel()}
                    </div>
                    <span
                      class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-violet-100/80"
                      style={{ "background-color": "rgba(139, 92, 246, 0.075)" }}
                      title={language.t("session.goal.chainBuilder.stat.actionsAria", { count: visibleStepCount() })}
                      aria-label={language.t("session.goal.chainBuilder.stat.actionsAria", { count: visibleStepCount() })}
                    >
                      <strong class={numericHighlightClass("mr-1")} style={numericHighlightStyle("violet")}>
                        {visibleStepCount()}
                      </strong>
                      {language.t("session.goal.chainBuilder.steps")}
                    </span>
                    <Show when={!liveGoal()}>
                      <span
                        data-component="goal-chain-budget-status"
                        data-budget-status={chainBudgetStatus()}
                        class="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]"
                        style={chainBudgetPillStyle(chainBudgetStatus())}
                        title={chainBudgetStatusDetail()}
                        aria-label={chainBudgetStatusDetail()}
                      >
                        {chainBudgetStatusLabel()}
                      </span>
                    </Show>
                    <Show when={liveGoal()}>
                      <span class="min-w-0 truncate text-[11px] font-semibold text-violet-100/62">
                        {cleanText(liveGoal()!.condition)}
                      </span>
                    </Show>
                  </div>
                  <div data-component="goal-target-toolbar" class="flex shrink-0 items-center justify-end gap-1.5">
                    <ActionButton
                      label={liveGoal() ? "Running…" : "Start Chain"}
                      variant={liveGoal() ? "secondary" : "primary"}
                      class="h-5 shrink-0 px-2.5 text-11-medium"
                      busy={busy() === "chain"}
                      disabled={
                        !!liveGoal() ||
                        busy() !== null ||
                        !props.sessionID ||
                        runnableChainSteps().length === 0
                      }
                      onClick={() => void startGoalChain()}
                    />
                    <Show when={!liveGoal()}>
                      <div class="flex items-center gap-1">
                        <ActionButton
                          label="Check"
                          variant="secondary"
                          class="h-5 shrink-0 px-2.5 text-11-medium"
                          disabled={busy() !== null || !props.sessionID}
                          onClick={() => {
                            const errors = validateChainDraft(runnableChainSteps(), {
                              maxTurns: chainDraft.master.maxTurns,
                              maxTimeMinutes: chainDraft.master.maxTimeMinutes,
                            })
                            setChainErrors(errors)
                            if (errors.length === 0) {
                              refreshChain()
                              void props.goal.refresh().catch(ignoreRefreshError)
                            }
                          }}
                        />
                        <ActionButton
                          label="Save"
                          variant="secondary"
                          class="h-5 shrink-0 px-2.5 text-11-medium"
                          disabled={busy() !== null}
                          onClick={() => {
                            writeStoredChainDraft(props.sessionID, {
                              steps: chainDraft.steps.map((step) => ({ ...step })),
                              master: {
                                maxTurns: chainDraft.master.maxTurns,
                                maxTimeMinutes: chainDraft.master.maxTimeMinutes,
                              },
                            })
                            refreshChain()
                          }}
                        />
                      </div>
                    </Show>
                  </div>
                </div>
                <Show when={!liveGoal()}>
                  <div
                    data-component="goal-global-budget"
                    data-layout="compact-chain-header"
                    data-budget-status={chainBudgetStatus()}
                    class="mt-1 min-w-0"
                    aria-label={`${chainLimitSummary()} · ${chainBudgetStatusDetail()}`}
                  >
                    <div
                      data-component="goal-target-stat-strip"
                      class="rounded-lg border p-1"
                      style={{
                        "background-color": "rgba(2, 6, 23, 0.28)",
                        "border-color": "rgba(167, 139, 250, 0.10)",
                        "box-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.012)",
                      }}
                    >
                    <div
                      data-component="goal-chain-compact-stats"
                      class="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-3"
                    >
                    <label
                      data-component="goal-chain-compact-stat"
                      data-kind="turns"
                      class="flex h-8 min-w-0 items-center gap-1.5 rounded-md border px-2"
                      style={{
                        "background-color": "rgba(59, 130, 246, 0.055)",
                        "border-color": "rgba(96, 165, 250, 0.14)",
                      }}
                      title={chainLimitSummary()}
                    >
                      <span class="min-w-[48px] text-[9px] font-semibold uppercase tracking-[0.08em] text-blue-100/78">
                        {language.t("session.goal.chainBuilder.stat.turns")}
                      </span>
                      <input
                        aria-label={language.t("session.goal.chainBuilder.stat.turnLimitAria")}
                        type="number"
                        min="1"
                        value={String(masterTurns())}
                        disabled={busy() !== null || !!liveGoal()}
                        onInput={(event) => updateMasterBudget("maxTurns", event.currentTarget.value)}
                        class="h-5 w-11 rounded border border-blue-200/16 bg-blue-950/20 px-1 text-center text-12-bold tabular-nums text-text-base outline-none focus:border-blue-200/45"
                      />
                      <span class="min-w-0 truncate text-[9px] font-semibold text-blue-100/52">
                        {language.t("session.goal.chainBuilder.stat.turnsHint")}
                      </span>
                    </label>
                    <label
                      data-component="goal-chain-compact-stat"
                      data-kind="time"
                      class="flex h-8 min-w-0 items-center gap-1.5 rounded-md border px-2"
                      style={{
                        "background-color": "rgba(139, 92, 246, 0.055)",
                        "border-color": "rgba(167, 139, 250, 0.14)",
                      }}
                      title={chainLimitSummary()}
                    >
                      <span class="min-w-[48px] text-[9px] font-semibold uppercase tracking-[0.08em] text-violet-100/78">
                        {language.t("session.goal.chainBuilder.stat.time")}
                      </span>
                      <input
                        aria-label={language.t("session.goal.chainBuilder.stat.timeLimitAria")}
                        type="number"
                        min="1"
                        value={String(masterMinutes())}
                        disabled={busy() !== null || !!liveGoal()}
                        onInput={(event) => updateMasterBudget("maxTimeMinutes", event.currentTarget.value)}
                        class="h-5 w-11 rounded border border-violet-200/16 bg-violet-950/20 px-1 text-center text-12-bold tabular-nums text-text-base outline-none focus:border-violet-200/45"
                      />
                      <span class="min-w-0 truncate text-[9px] font-semibold text-violet-100/52">
                        {language.t("session.goal.chainBuilder.stat.timeHint")}
                      </span>
                    </label>
                    <div
                      data-component="goal-chain-compact-stat"
                      data-kind="actions"
                      class="flex h-8 min-w-0 items-center gap-1.5 rounded-md border px-2"
                      style={{
                        "background-color": "rgba(16, 185, 129, 0.05)",
                        "border-color": "rgba(110, 231, 183, 0.14)",
                      }}
                      title={language.t("session.goal.chainBuilder.stat.actionsAria", { count: visibleStepCount() })}
                    >
                      <span class="min-w-[48px] text-[9px] font-semibold uppercase tracking-[0.08em] text-emerald-100/78">
                        {language.t("session.goal.chainBuilder.stat.actions")}
                      </span>
                      <span class="flex h-5 w-11 items-center justify-center rounded border border-emerald-200/16 bg-emerald-950/20 px-1 text-center text-12-bold tabular-nums text-text-base">
                        {visibleStepCount()}
                      </span>
                      <span class="min-w-0 truncate text-[9px] font-semibold text-emerald-100/52">
                        {language.t("session.goal.chainBuilder.stat.actionsHint")}
                      </span>
                    </div>
                    </div>
                    </div>
                  </div>
                </Show>
                <Show when={chainErrors().length > 0}>
                  <div class="mt-2 rounded-lg border border-orange-300/35 bg-orange-500/10 px-3 py-2 text-11-regular leading-5 text-orange-50/88">
                    <For each={chainErrors()}>
                      {(error) => (
                        <div>
                          <Show when={error.stepIndex >= 0}>
                            <span class="font-semibold tabular-nums">{`#${error.stepIndex + 1}: `}</span>
                          </Show>
                          {error.message}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <Show when={liveGoal()} keyed>
                {(running) => (
                  <div
                    data-component="goal-chain-running-status"
                    data-state={liveRunStalled() ? "stalled" : running.status}
                    class="border-b px-3 py-2.5"
                    style={runningStatusPanelStyle(liveRunStalled() ? "stalled" : running.status)}
                  >
                    <div
                      data-component="goal-running-deck-header"
                      class="mb-2 flex min-w-0 items-center justify-between gap-2"
                    >
                      <div class="min-w-0">
                        <div class="truncate text-[10px] font-black uppercase tracking-[0.14em] text-emerald-100/70">
                          {language.t("session.goal.chainBuilder.runningHeader")}
                        </div>
                        <div class="mt-0.5 truncate text-12-medium font-semibold text-text-base" title={cleanText(running.condition)}>
                          {cleanText(running.condition)}
                        </div>
                      </div>
                      <span
                        class={`inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] ${terminalOutcomeTone(liveRunStalled() ? "paused" : running.status).class}`}
                        style={terminalOutcomeTone(liveRunStalled() ? "paused" : running.status).style}
                      >
                        <span
                          class={`h-2 w-2 rounded-full ${liveRunStalled() ? "bg-orange-300" : statusMeta(running.status).dot}`}
                          aria-hidden
                        />
                        {liveRunStalled() ? language.t("session.goal.chainBuilder.stalledButton") : statusMeta(running.status).label}
                      </span>
                    </div>
                    <div class="grid min-w-0 gap-2 xl:grid-cols-[minmax(0,1fr)_216px] xl:items-start">
                      <div class="min-w-0">
                        <div
                          data-component="goal-running-execution-contract"
                          class="mb-1.5 truncate rounded-md border px-2 py-1 text-[10px] font-semibold text-emerald-100/68"
                          style={{
                            "background-color": "rgba(16, 185, 129, 0.055)",
                            "border-color": "rgba(110, 231, 183, 0.12)",
                          }}
                        >
                          {chainRunStateSubtitle()}
                        </div>
                        <Show when={liveRunStalled()}>
                          <div
                            data-component="goal-running-stalled-hint"
                            class="mt-2 rounded-md border border-orange-300/24 bg-orange-500/10 px-2 py-1 text-11-regular font-semibold text-orange-50/82"
                          >
                            {language.t("session.goal.chainBuilder.stalledHint")} {liveRunIdleMinutes()}m idle.
                          </div>
                        </Show>
                        <div
                          data-component="goal-running-metric-strip"
                          class="mt-1.5 grid min-w-0 grid-cols-3 gap-1"
                        >
                          <div
                            data-component="goal-running-clock"
                            class="flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border px-2"
                            style={runningMetricTileStyle("time")}
                          >
                            <div class="truncate text-[9px] font-bold uppercase tracking-[0.06em] text-blue-100/78">
                              {language.t("session.goal.metric.time")}
                            </div>
                            <div class={`shrink-0 text-[14px] font-black leading-none tabular-nums ${runningMetricValueClass("time")}`}>
                              {elapsedMinutes()}
                              <span class="text-[10px] font-bold text-blue-100/58">/{running.constraints.maxTimeMinutes}m</span>
                            </div>
                          </div>
                          <div
                            data-component="goal-running-turns"
                            class="flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border px-2"
                            style={runningMetricTileStyle("turns")}
                          >
                            <div class="truncate text-[9px] font-bold uppercase tracking-[0.06em] text-violet-100/78">
                              {language.t("session.goal.metric.turns")}
                            </div>
                            <div class={`shrink-0 text-[14px] font-black leading-none tabular-nums ${runningMetricValueClass("turns")}`}>
                              {running.turnsEvaluated}
                              <span class="text-[10px] font-bold text-violet-100/58">/{running.constraints.maxTurns}</span>
                            </div>
                          </div>
                          <div
                            data-component="goal-running-step"
                            class="flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border px-2"
                            style={runningMetricTileStyle("step")}
                          >
                            <div class="truncate text-[9px] font-bold uppercase tracking-[0.06em] text-emerald-100/78">
                              {language.t("session.goal.metric.chain")}
                            </div>
                            <div class={`shrink-0 text-[14px] font-black leading-none tabular-nums ${runningMetricValueClass("step")}`}>
                              {runningStepIndex() + 1}
                              <span class="text-[10px] font-bold text-emerald-100/58">/{Math.max(visibleStepCount(), 1)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div class="min-w-0">
                        <div
                          data-component="goal-running-progress-hero"
                          class="rounded-md border px-2.5 py-2 text-right"
                          style={runningMetricTileStyle("progress")}
                        >
                          <div class="flex items-center justify-between gap-2">
                            <div class="truncate text-[9px] font-bold uppercase tracking-[0.06em] text-emerald-100/78">
                              {language.t("session.goal.progress")}
                            </div>
                            <div class="shrink-0 text-[22px] font-black leading-none tracking-normal text-emerald-50 tabular-nums">
                              {running.status === "achieved" ? 100 : progressPct()}%
                            </div>
                          </div>
                          <div
                            class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-background-base/70"
                            role="progressbar"
                            aria-valuenow={running.status === "achieved" ? 100 : progressPct()}
                            aria-valuemin="0"
                            aria-valuemax="100"
                          >
                            <div
                              class="h-full rounded-full bg-emerald-300 transition-[width] motion-reduce:transition-none"
                              style={{ width: `${running.status === "achieved" ? 100 : progressPct()}%` }}
                            />
                          </div>
                        </div>
                        <div
                          data-component="goal-running-command-strip"
                          class="mt-1.5 grid grid-cols-5 gap-1 rounded-md border p-1"
                          style={{
                            "background-color": "rgba(2, 6, 23, 0.30)",
                            "border-color": "rgba(148, 163, 184, 0.14)",
                          }}
                        >
                          <Show when={pauseResume()}>
                            {(action) => (
                              <ActionButton
                                label={
                                  action() === "pause"
                                    ? language.t("session.goal.action.pause")
                                    : language.t("session.goal.action.resume")
                                }
                                variant="primary"
                                busy={busy() === "pause" || busy() === "resume"}
                                disabled={busy() !== null || !props.sessionID}
                                class="h-7 px-2 text-11-medium"
                                onClick={() => {
                                  const next = action()
                                  setOptimisticStatus(next === "pause" ? "paused" : "active")
                                  void runAction(next)
                                    .then((ok) => {
                                      if (!ok) setOptimisticStatus(null)
                                    })
                                    .catch(() => setOptimisticStatus(null))
                                }}
                              />
                            )}
                          </Show>
                          <ActionButton
                            label={language.t("session.goal.action.restart")}
                            variant="secondary"
                            busy={busy() === "restart"}
                            disabled={busy() !== null || !props.sessionID}
                            class="h-7 px-2 text-11-medium"
                            onClick={() => void runAction("restart")}
                          />
                          <ActionButton
                            label={
                              confirmingClear()
                                ? language.t("session.goal.action.confirmStop")
                                : language.t("session.goal.action.stop")
                            }
                            variant={confirmingClear() ? "primary" : "secondary"}
                            tone="danger"
                            busy={busy() === "clear" && confirmingClear()}
                            disabled={busy() !== null || !props.sessionID}
                            class="h-7 px-2 text-11-medium"
                            onClick={() => {
                              if (confirmingClear()) void stopGoal()
                              else setConfirmingClear(true)
                            }}
                          />
                          <ActionButton
                            label={language.t("session.goal.action.steer")}
                            variant="secondary"
                            disabled={busy() !== null || !props.sessionID}
                            class="h-7 px-2 text-11-medium"
                            title={language.t("session.goal.steer.hint")}
                            onClick={() => setSteerOpen((v) => !v)}
                          />
                          <ActionButton
                            label={language.t("session.goal.action.handoff")}
                            variant={handoff().handoff ? "primary" : "secondary"}
                            busy={busy() === "handoff"}
                            disabled={busy() !== null || !props.sessionID || !!handoff().handoff}
                            class="h-7 px-2 text-11-medium"
                            title={language.t("session.goal.handoff.hint")}
                            onClick={() => setHandoffOpen((v) => !v)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Show>

              <Show when={liveGoal() && confirmingClear()}>
                <div class="border-b px-3 py-2">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div
                      data-component="goal-running-inline-panel"
                      data-state="stop-confirm"
                      class="flex flex-1 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
                      style={runningInlinePanelStyle("stop")}
                    >
                      <div class="text-11-regular font-semibold text-orange-50/82">
                        {language.t("session.goal.action.confirmStop")}
                      </div>
                      <div class="flex items-center gap-2">
                        <ActionButton
                          label={language.t("session.goal.action.confirmStop")}
                          variant="primary"
                          tone="danger"
                          busy={busy() === "clear"}
                          disabled={busy() !== null || !props.sessionID}
                          class="h-7 shrink-0 px-3 text-12-medium"
                          onClick={() => void stopGoal()}
                        />
                        <ActionButton
                          label={language.t("session.goal.action.cancel")}
                          variant="ghost"
                          disabled={busy() !== null}
                          class="h-7 shrink-0 px-3 text-12-medium"
                          onClick={() => setConfirmingClear(false)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={liveGoal() && steerOpen()}>
                <div class="border-b px-3 py-2">
                  <div
                    data-component="goal-running-inline-panel"
                    data-state="steer"
                    class="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
                    style={runningInlinePanelStyle("steer")}
                  >
                    <TextField
                      value={steerText()}
                      onChange={setSteerText}
                      label={language.t("session.goal.action.steer")}
                      hideLabel
                      placeholder={language.t("session.goal.steer.placeholder")}
                      disabled={busy() !== null}
                      class="min-w-48 flex-1"
                    />
                    <ActionButton
                      label={language.t("session.goal.steer.send")}
                      variant="primary"
                      busy={busy() === "steer"}
                      disabled={busy() !== null || !props.sessionID || !steerText().trim()}
                      class="h-8 shrink-0 px-3"
                      onClick={() => void steerGoal()}
                    />
                    <ActionButton
                      label={language.t("session.goal.action.cancel")}
                      variant="ghost"
                      disabled={busy() !== null}
                      class="h-8 shrink-0 px-3"
                      onClick={() => {
                        setSteerOpen(false)
                        setSteerText("")
                      }}
                    />
                  </div>
                </div>
              </Show>

              <Show when={liveGoal() && handoffOpen()}>
                <div class="border-b px-3 py-2">
                  <div
                    data-component="goal-running-inline-panel"
                    data-state="handoff"
                    class="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
                    style={runningInlinePanelStyle("handoff")}
                  >
                    <TextField
                      value={handoffText()}
                      onChange={setHandoffText}
                      label={language.t("session.goal.action.handoff")}
                      hideLabel
                      placeholder={language.t("session.goal.handoff.placeholder")}
                      disabled={busy() !== null}
                      class="min-w-48 flex-1"
                    />
                    <ActionButton
                      label={language.t("session.goal.handoff.send")}
                      variant="primary"
                      busy={busy() === "handoff"}
                      disabled={busy() !== null || !props.sessionID}
                      class="h-8 shrink-0 px-3"
                      onClick={() => void handoffGoal()}
                    />
                    <ActionButton
                      label={language.t("session.goal.action.cancel")}
                      variant="ghost"
                      disabled={busy() !== null}
                      class="h-8 shrink-0 px-3"
                      onClick={() => {
                        setHandoffOpen(false)
                        setHandoffText("")
                      }}
                    />
                  </div>
                </div>
              </Show>

              <Show when={!liveGoal() && handoff().handoff}>
                {(pending) => (
                  <div class="border-b px-3 py-2">
                    <div
                      data-component="goal-handoff-claim-panel"
                      class="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
                      style={runningInlinePanelStyle("handoff")}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="text-11-regular font-bold uppercase tracking-[0.08em] text-indigo-50">
                          {language.t("session.goal.handoff.pending")}
                        </div>
                        <div class="mt-1 truncate text-12-regular text-indigo-100/78">
                          {cleanText(pending().state.condition)}
                        </div>
                        <Show when={pending().note}>
                          {(note) => <div class="mt-1 truncate text-11-regular text-indigo-100/62">{note()}</div>}
                        </Show>
                      </div>
                      <ActionButton
                        label={language.t("session.goal.action.claim")}
                        variant="primary"
                        busy={busy() === "claim"}
                        disabled={busy() !== null || !props.sessionID}
                        class="h-8 shrink-0 px-3"
                        onClick={() => void claimGoalHandoff()}
                      />
                    </div>
                  </div>
                )}
              </Show>

              <Show when={handoff().corrupt}>
                <div class="border-b px-3 py-2">
                  <div
                    data-component="goal-handoff-corrupt-panel"
                    class="rounded-lg border px-3 py-2 text-12-regular text-orange-100/82"
                    style={runningInlinePanelStyle("stop")}
                  >
                    {language.t("session.goal.handoff.corrupt")}
                  </div>
                </div>
              </Show>

              <div
                  data-component="goal-playbook-chain-pane"
                class="min-h-0 min-w-0 flex-1 overflow-hidden bg-[linear-gradient(180deg,rgba(46,16,101,0.06),rgba(10,10,10,0.42))]"
                >
                  <div data-component="goal-plan-chain" class="flex h-full min-h-0 min-w-0 flex-col p-2">
                    <div
                      class="min-h-0 flex-1 overflow-x-auto overflow-y-auto rounded-lg border bg-background-panel/76 p-1.5"
                      style={{ "border-color": "rgba(167, 139, 250, 0.10)", "box-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.012)" }}
                    >
                      <Show
                        when={visibleStepCount() > 0}
                        fallback={
                            <div
                              data-component="goal-chain-empty-state"
                              class="grid min-h-40 place-items-center rounded-md border px-4 py-6 text-center"
                              style={{
                                "background": "radial-gradient(circle at 50% 0%, rgba(139, 92, 246, 0.12), transparent 45%), linear-gradient(180deg, rgba(46, 16, 101, 0.10), rgba(18, 18, 18, 0.72))",
                                "border-color": "rgba(167, 139, 250, 0.14)",
                              }}
                            >
                            <div class="max-w-sm">
                              <div class="text-13-medium font-bold text-violet-50">
                                {language.t("session.goal.chainBuilder.emptyChain")}
                              </div>
                              <div class="mt-2 text-12-regular leading-5 text-violet-100/72">
                                Add actions from the library. Start Chain writes the ordered steps, activates step 1, and the engine advances after each step is achieved.
                              </div>
                              <div
                                data-component="goal-chain-execution-note"
                                class="mt-3 rounded-md border px-2.5 py-2 text-left text-11-regular leading-5 text-violet-100/72"
                                style={{
                                  "background-color": "rgba(139, 92, 246, 0.06)",
                                  "border-color": "rgba(167, 139, 250, 0.14)",
                                }}
                              >
                                Draft edits stay local. Reorder, remove, turns, minutes, prompt, and command edits do not start a turn until Start Chain.
                              </div>
                            </div>
                          </div>
                        }
                      >
                        <div class="flex min-w-0 flex-col gap-1">
                          <For each={visibleChainSteps()}>
                            {(step, i) => (
                              <div
                                data-component="goal-chain-step-row"
                                data-density="compact-chain-row"
                                data-run-state={stepRunState(i())}
                                data-editing={editingChainStepID() === step.id ? "true" : "false"}
                                class={`group grid min-w-[790px] grid-cols-[30px_40px_minmax(220px,1fr)_96px_154px_194px] items-center gap-2 rounded-lg border px-2.5 py-2 transition hover:brightness-110 ${actionSurfaceClass(step)}`}
                                classList={{
                                  "ring-2 ring-sky-300/70 shadow-[0_0_24px_rgba(56,189,248,0.22)] brightness-110":
                                    editingChainStepID() === step.id,
                                  "ring-2 ring-emerald-300/45 shadow-[0_0_22px_rgba(16,185,129,0.18)]":
                                    stepRunState(i()) === "running" && editingChainStepID() !== step.id,
                                  "ring-2 ring-amber-300/42 shadow-[0_0_22px_rgba(245,158,11,0.16)]":
                                    stepRunState(i()) === "paused" && editingChainStepID() !== step.id,
                                  "ring-2 ring-orange-300/42 shadow-[0_0_22px_rgba(249,115,22,0.16)]":
                                    stepRunState(i()) === "stalled" && editingChainStepID() !== step.id,
                                  "opacity-75": stepRunState(i()) === "done",
                                  "opacity-[0.88]": stepRunState(i()) === "queued",
                                }}
                                style={chainStepRowStyle(step, stepRunState(i()))}
                              >
                                <span
                                  data-component="goal-chain-run-rail"
                                  class="relative flex h-10 items-center justify-center"
                                  aria-hidden
                                >
                                  <span
                                    data-component="goal-chain-step-number"
                                    class="z-10 flex h-7 w-7 items-center justify-center rounded-full text-11-medium font-bold tabular-nums"
                                    classList={{
                                      "bg-gradient-to-br from-emerald-400/40 to-emerald-600/20 text-emerald-100 ring-1 ring-emerald-400/30":
                                        stepRunState(i()) === "running",
                                      "bg-gradient-to-br from-amber-400/40 to-amber-600/20 text-amber-100 ring-1 ring-amber-400/30":
                                        stepRunState(i()) === "paused",
                                      "bg-gradient-to-br from-orange-400/40 to-orange-600/20 text-orange-100 ring-1 ring-orange-400/30":
                                        stepRunState(i()) === "stalled",
                                      "bg-gradient-to-br from-violet-400/30 to-violet-600/15 text-violet-200 ring-1 ring-violet-400/25":
                                        stepRunState(i()) === "queued",
                                      "bg-gradient-to-br from-zinc-400/20 to-zinc-600/10 text-zinc-300 ring-1 ring-zinc-400/20":
                                        stepRunState(i()) === "done",
                                    }}
                                  >
                                    {i() + 1}
                                  </span>
                                </span>
                                <span
                                  data-component="goal-chain-step-icon"
                                  class="flex h-9 w-9 items-center justify-center rounded-md border shadow-[0_6px_12px_rgba(0,0,0,0.14)]"
                                  style={chainStepBadgeStyle(step)}
                                  aria-hidden
                                >
                                  <IconV2 name={actionIconName(step)} size="small" />
                                </span>
                                <div class="flex min-w-0 flex-col gap-1">
                                  <div class="truncate text-13-medium font-semibold text-text-base">{step.label}</div>
                                  <div
                                    class="mt-0.5 truncate text-[11px] leading-4 text-text-weaker"
                                    title={cleanText(step.condition)}
                                  >
                                    {cleanText(step.condition)}
                                  </div>
                                  <Show when={(step.skills?.length ?? 0) > 0 || step.model}>
                                    <div class="flex min-w-0 gap-1 overflow-hidden">
                                      <Show when={step.model}>
                                        <span class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold text-sky-200/80">
                                          {modelLabel(step.model)}
                                        </span>
                                      </Show>
                                      <For each={(step.skills ?? []).slice(0, 2)}>
                                        {(skill) => (
                                          <span class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold text-emerald-200/80">
                                            {skill}
                                          </span>
                                        )}
                                      </For>
                                      <Show when={(step.skills?.length ?? 0) > 2}>
                                        <span class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold text-emerald-200/60">
                                          +{(step.skills?.length ?? 0) - 2}
                                        </span>
                                      </Show>
                                    </div>
                                  </Show>
                                </div>
                                <span
                                  class="flex h-8 items-center justify-center truncate rounded-md border px-2 text-[10px] font-semibold uppercase tracking-[0.08em]"
                                  style={chainStepSoftStyle(step)}
                                  title={inferActionCategory(step)}
                                >
                                  {inferActionCategory(step)}
                                </span>
                                <span data-component="goal-chain-step-budget" class="grid min-w-0 grid-cols-2 gap-1">
                                  <label
                                    class="grid h-6 grid-cols-[42px_32px] items-center gap-1"
                                  >
                                    <span class="text-[9px] font-semibold uppercase opacity-75">Turns</span>
                                    <input
                                      aria-label={`Turns for ${step.label}`}
                                      type="number"
                                      min="1"
                                      value={String(step.maxTurns)}
                                      disabled={busy() !== null || !!liveGoal()}
                                      onInput={(event) =>
                                        updateDraftStepBudget(step.id, "maxTurns", event.currentTarget.value)
                                      }
                                      class="h-5 w-full rounded px-0.5 text-center text-11-medium font-semibold tabular-nums text-text-base bg-transparent outline-none"
                                    />
                                  </label>
                                  <label
                                    class="grid h-6 grid-cols-[30px_40px] items-center gap-1"
                                  >
                                    <span class="text-[9px] font-semibold uppercase opacity-75">Min</span>
                                    <input
                                      aria-label={`Minutes for ${step.label}`}
                                      type="number"
                                      min="1"
                                      value={String(step.maxTimeMinutes)}
                                      disabled={busy() !== null || !!liveGoal()}
                                      onInput={(event) =>
                                        updateDraftStepBudget(step.id, "maxTimeMinutes", event.currentTarget.value)
                                      }
                                      class="h-5 w-full rounded px-0.5 text-center text-11-medium font-semibold tabular-nums text-text-base bg-transparent outline-none"
                                    />
                                  </label>
                                </span>
                                <span data-component="goal-chain-step-actions" class="flex min-w-0 shrink-0 items-center justify-end gap-1 opacity-100">
                                  <span
                                    data-component="goal-chain-step-runtime"
                                    class="mr-0.5 grid min-w-0 flex-1 grid-rows-2 justify-items-start rounded px-1 py-0.5 text-left"
                                    title={stepRuntimeTitle(step)}
                                  >
                                    <span class="max-w-full truncate text-[10px] font-semibold leading-4 text-text-base">
                                      {stepRuntimeModelLabel(step)}
                                    </span>
                                    <span class="max-w-full truncate text-[9px] font-semibold uppercase leading-3 text-text-weaker">
                                      {stepRuntimeSkillLabel(step)}
                                    </span>
                                  </span>
                                  <button
                                    type="button"
                                    aria-label={`Edit ${step.label}`}
                                    title={language.t("session.goal.template.editRunStep")}
                                    class={inlineCommandButtonClass("move")}
                                    style={inlineCommandButtonStyle("edit")}
                                    disabled={busy() !== null || !!liveGoal()}
                                    onClick={() => editChainStepDraft(step)}
                                  >
                                    <IconV2 name="edit" size="small" />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label="Move up"
                                    class={inlineCommandButtonClass("move")}
                                    style={inlineCommandButtonStyle("move")}
                                    disabled={busy() !== null || !!liveGoal() || i() === 0}
                                    onClick={() => moveDraftStep(i(), i() - 1)}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    aria-label="Move down"
                                    class={inlineCommandButtonClass("move")}
                                    style={inlineCommandButtonStyle("move")}
                                    disabled={busy() !== null || !!liveGoal() || i() === visibleStepCount() - 1}
                                    onClick={() => moveDraftStep(i(), i() + 1)}
                                  >
                                    ↓
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={liveGoal() ? "Remove pending step" : "Remove"}
                                    class={inlineCommandButtonClass("remove")}
                                    style={inlineCommandButtonStyle("remove")}
                                    disabled={busy() !== null || (!!liveGoal() && i() <= runningStepIndex())}
                                    onClick={() => removeVisibleStep(step, i())}
                                  >
                                    ×
                                  </button>
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>

                    <Show when={!liveGoal()}>
                      <div
                        data-component="goal-chain-summary-line"
                        class="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-2 px-1 text-[10px] font-semibold text-violet-100/55"
                        title={language.t("session.goal.chainBuilder.planChainHint")}
                      >
                        <span class="min-w-0 truncate">
                          {language.t("session.goal.chainBuilder.planChainHint")}
                        </span>
                        <span class="shrink-0 tabular-nums text-violet-100/72">
                          {chainLimitSummary()}
                        </span>
                      </div>
                    </Show>

                    <Show when={liveGoal()}>
                      <div
                        data-component="goal-chain-running-activity"
                        class="mt-2 rounded-lg border p-2"
                        style={runningInlinePanelStyle("activity")}
                      >
                        <div class="mb-1.5 flex items-center justify-between gap-2">
                          <span class="text-[10px] font-bold uppercase tracking-[0.12em] text-cyan-100/78">
                            {language.t("session.goal.activity.title")}
                          </span>
                          <span class={numericHighlightClass()} style={numericHighlightStyle("blue")}>
                            {activity().length}
                          </span>
                        </div>
                        <Show
                          when={activity().length > 0}
                          fallback={
                            <div class="text-11-regular text-text-weaker">
                              {language.t("session.goal.activity.empty")}
                            </div>
                          }
                        >
                          <div role="list" class="grid max-h-24 gap-1 overflow-y-auto">
                            <For each={activity().slice(0, 4)}>
                              {(event) => (
                                <div
                                  role="listitem"
                                  class="grid min-w-0 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-cyan-300/12 bg-background-base/54 px-2 py-1 text-[11px]"
                                >
                                  <span
                                    class="text-center"
                                    classList={{
                                      "text-icon-success-base": event.kind === "tool-end" && event.ok === true,
                                      "text-text-warning-base": event.kind === "tool-end" && event.ok === false,
                                      "text-cyan-100/65": event.kind !== "tool-end",
                                    }}
                                    aria-hidden
                                  >
                                    {event.kind === "tool-end"
                                      ? event.ok === false
                                        ? "x"
                                        : "✓"
                                      : event.kind === "tool-start"
                                        ? ">"
                                        : "•"}
                                  </span>
                                  <span class="min-w-0 truncate text-text-base" title={cleanText(event.summary ?? event.tool ?? "")}>
                                    <Show when={event.tool}>
                                      <span class="font-semibold">{event.tool}</span>{" "}
                                    </Show>
                                    {cleanText(event.summary ?? "")}
                                  </span>
                                  <Show when={event.durationMs !== undefined}>
                                    <span class="shrink-0 tabular-nums text-text-weaker">
                                      {formatMs(event.durationMs!)}
                                    </span>
                                  </Show>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
              </GoalConsoleSection>

                <aside
                  data-component="goal-method-library-rail"
                  class="grid min-h-0 min-w-0 grid-rows-[minmax(320px,1fr)_minmax(280px,0.88fr)] gap-2 xl:h-[calc(100vh-8rem)]"
                >
                  <GoalConsoleSection
                    zone="action-library"
                    title={language.t("session.goal.template.libraryShortTitle")}
                    subtitle={language.t("session.goal.template.librarySubtitle")}
                    class="min-h-0"
                  >
                  <section data-testid="action-library" data-component="goal-method-library" class="flex h-full min-h-0 min-w-0 flex-col p-2">
                    <div
                      data-component="goal-method-library-header"
                      class="mb-1 flex min-w-0 items-center justify-between gap-2"
                    >
                      <span class="min-w-0 truncate text-[10px] font-medium leading-4 text-text-weaker">
                        Plus adds to Run Order. Edit opens the editor.
                      </span>
                    </div>
                    <div
                      data-component="goal-method-category-tabs"
                      class="grid min-w-0 grid-cols-8 gap-0.5"
                    >
                      <For each={ACTION_CATEGORIES}>
                        {(category) => (
                          <button
                            type="button"
                            class="h-5 min-w-0 rounded px-1 text-center text-[10px] font-semibold leading-none hover:brightness-110"
                            style={actionCategoryPillStyle(category, templateCategory() === category)}
                            onClick={() => setTemplateCategory(category)}
                          >
                            {actionCategoryShortLabel(category)}
                          </button>
                        )}
                      </For>
                    </div>

                    <div
                      data-component="goal-method-rail-filters"
                      class="mt-1 p-0"
                    >
                      <TextField
                        value={templateSearch()}
                        onChange={setTemplateSearch}
                        label={language.t("session.goal.template.search")}
                        hideLabel
                        placeholder={language.t("session.goal.template.searchPlaceholder")}
                        disabled={busy() !== null}
                        class="w-full"
                      />
                    </div>
                    <div
                      role="listbox"
                      aria-label={language.t("session.goal.create.templates")}
                      tabindex={0}
                      class="mt-1.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-0.5"
                      onKeyDown={handleTemplateListboxKeyDown}
                    >
                      <Show
                        when={filteredTemplates().length > 0}
                        fallback={
                          <div class="px-3 py-4 text-11-regular text-text-weaker">
                            {language.t("session.goal.template.empty")}
                          </div>
                        }
                      >
                        <For each={filteredTemplates()}>
                          {(t) => (
                            <div
                              data-component="goal-method-row"
                              role="option"
                              aria-selected={selectedTemplateID() === t.id}
                              title={t.description || t.condition || t.label}
                              class="group grid min-h-[30px] min-w-0 grid-cols-[minmax(0,1fr)_24px_24px] items-center gap-1 overflow-hidden rounded border px-1 py-0.5 hover:brightness-110"
                              style={actionLibraryRowStyle(t)}
                              classList={{
                                "outline outline-1 outline-offset-1 outline-emerald-200/65 brightness-110":
                                  selectedTemplateID() === t.id,
                              }}
                            >
                              <button
                                type="button"
                                data-component="goal-method-select"
                                class="grid w-full min-w-0 grid-cols-[minmax(0,0.72fr)_minmax(0,1fr)_8px] items-center gap-1 overflow-hidden rounded px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
                                onClick={() => selectActionForView(t)}
                              >
                                <span data-component="goal-method-label" class="min-w-0 truncate text-[11px] font-semibold leading-4 text-text-base">{t.label}</span>
                                <span data-component="goal-method-prompt-preview" class="min-w-0 truncate text-[11px] leading-4 text-text-weak">
                                  {cleanText(t.description || t.condition || "")}
                                </span>
                                <span
                                  data-component="goal-method-selected-dot"
                                  aria-hidden="true"
                                  class="h-1.5 w-1.5 justify-self-end rounded-full bg-emerald-200 transition-opacity"
                                  classList={{
                                    "opacity-100": selectedTemplateID() === t.id,
                                    "opacity-0": selectedTemplateID() !== t.id,
                                  }}
                                />
                              </button>
                              <button
                                type="button"
                                data-component="goal-method-add"
                                class={inlineCommandButtonClass("add")}
                                style={inlineCommandButtonStyle("add")}
                                disabled={busy() !== null || !t.condition}
                                aria-label={language.t("session.goal.template.addToChain")}
                                title={language.t("session.goal.template.addToChain")}
                                onClick={() => {
                                  selectActionForView(t)
                                  addActionToChain(t, varsForAction(t))
                                }}
                              >
                                <IconV2 name="plus" size="small" />
                              </button>
                              <button
                                type="button"
                                data-component="goal-method-edit"
                                class={inlineCommandButtonClass("edit")}
                                style={inlineCommandButtonStyle("edit")}
                                disabled={busy() !== null}
                                aria-label={language.t("session.goal.template.edit")}
                                title={language.t("session.goal.template.edit")}
                                onClick={() => {
                                  selectActionForView(t)
                                  editTemplateDraft(t)
                                }}
                              >
                                <IconV2 name="edit" size="small" />
                              </button>
                            </div>
                          )}
                        </For>
                      </Show>
                    </div>
                  </section>
                  </GoalConsoleSection>

                  <GoalConsoleSection
                    zone="action-editor"
                    title={language.t("session.goal.template.editorShortTitle")}
                    subtitle={language.t("session.goal.template.editorSubtitle")}
                    class="min-h-0"
                  >
                    <section
                      data-testid="action-editor"
                      data-component="goal-method-inspector"
                      class="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden overscroll-contain bg-background-base/70 p-2"
                    >
                      <div class="flex min-w-0 flex-col gap-2">
                        <div
                          data-component="goal-action-editor-current"
                          class="rounded-md border px-2 py-1.5"
                          style={actionEditorCurrentStyle(actionEditorDescriptor())}
                        >
                          <div
                            data-component="goal-action-editor-active-state"
                            class="flex min-w-0 items-center gap-2"
                            title={editorActiveHint()}
                          >
                            <div class="min-w-0 flex-1">
                              <div class="flex min-w-0 items-baseline gap-2">
                                <span class="min-w-0 truncate text-13-medium font-semibold text-text-base" title={actionDraft.label}>
                                  {actionDraft.label.trim() || language.t("session.goal.template.newDraft")}
                                </span>
                                <span class="shrink-0 text-[9px] font-semibold uppercase tracking-[0.1em] text-text-weaker">
                                  {editorActiveLabel()}
                                </span>
                              </div>
                            </div>
                            <label data-component="goal-action-editor-category" class="ml-auto min-w-[86px] shrink-0">
                              <span class="sr-only">
                                {language.t("session.goal.template.category")}
                              </span>
                              <select
                                value={actionDraft.category}
                                disabled={busy() !== null || !props.sessionID}
                                onChange={(event) => setActionDraft("category", event.currentTarget.value as GoalTemplateCategory)}
                                class="h-6 w-full rounded border border-border-base/70 bg-background-panel/80 px-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-base outline-none transition focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <For each={GOAL_TEMPLATE_CATEGORIES}>
                                  {(category) => (
                                    <option value={category} class="bg-background-base text-text-base">{category}</option>
                                  )}
                                </For>
                              </select>
                            </label>
                          </div>
                          <div data-component="goal-action-editor-footer" class="mt-1.5 flex flex-wrap gap-1">
                            <span data-component="goal-method-new-action" class="flex flex-1">
                              <ActionButton
                                label={language.t("session.goal.template.new")}
                                variant="secondary"
                                class="h-6 flex-1 px-2 text-11-medium"
                                disabled={busy() !== null}
                                onClick={openActionEditor}
                              />
                            </span>
                            <Show when={editingChainStepID()}>
                              <ActionButton
                                label={language.t("session.goal.template.updateRunStep")}
                                variant="primary"
                                class="h-6 flex-1 px-2 text-11-medium"
                                disabled={busy() !== null || !!liveGoal() || !actionDraft.prompt.trim()}
                                onClick={() => updateEditingChainStep()}
                              />
                            </Show>
                            <ActionButton
                              label={language.t("session.goal.template.save")}
                              variant="primary"
                              tone="success"
                              class="h-6 flex-1 px-2 text-11-medium"
                              busy={busy() === "template"}
                              disabled={
                                busy() !== null ||
                                !props.sessionID ||
                                !actionDraft.prompt.trim()
                              }
                              onClick={() => void saveTemplateDraft()}
                            />
                            <ActionButton
                              label={language.t("session.goal.template.duplicate")}
                              variant="secondary"
                              class="h-6 flex-1 px-2 text-11-medium"
                              busy={busy() === "template"}
                              disabled={
                                busy() !== null || !props.sessionID || !actionDraft.prompt.trim()
                              }
                              onClick={() => void duplicateActionDraft()}
                            />
                            <ActionButton
                              label={language.t("session.goal.template.delete")}
                              variant="secondary"
                              tone="danger"
                              class="h-6 flex-1 px-2 text-11-medium"
                              busy={busy() === "template"}
                              disabled={busy() !== null || !props.sessionID || !selectedTemplate() || !!selectedTemplate()?.builtin}
                              onClick={() => {
                                const template = selectedTemplate()
                                if (template) void deleteActionTemplate(template)
                              }}
                            />
                          </div>
                          <Show when={saveError()}>
                            <div class="mt-1 text-center text-[10px] text-orange-300/90">{saveError()}</div>
                          </Show>
                        </div>

                        <div
                          data-component="goal-action-editor-routing"
                          class="grid grid-cols-1 gap-1 rounded-md border p-1"
                          style={{
                            "background": "linear-gradient(90deg, rgba(15, 23, 42, 0.34), rgba(24, 24, 27, 0.78) 58%, rgba(14, 165, 233, 0.035))",
                            "border-color": "rgba(148, 163, 184, 0.16)",
                            "box-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.018)",
                          }}
                        >
                          <div
                            data-component="goal-action-editor-model"
                            class="grid h-7 min-w-0 grid-cols-[52px_minmax(0,1fr)] items-center gap-1.5 rounded-md border px-1.5"
                            style={{
                              "background-color": "rgba(14, 165, 233, 0.035)",
                              "border-color": "rgba(56, 189, 248, 0.12)",
                            }}
                          >
                            <span class="shrink-0 text-[9px] font-bold uppercase tracking-[0.1em] text-sky-100/82">
                              {language.t("session.goal.template.pinnedModel")}
                            </span>
                            <select
                              value={actionDraft.model}
                              disabled={busy() !== null || !props.sessionID}
                              aria-label={language.t("session.goal.template.pinnedModel")}
                              title={language.t("session.goal.template.pinnedModel")}
                              onChange={(event) => setActionDraft("model", event.currentTarget.value)}
                              class="h-5 min-w-0 truncate rounded bg-transparent px-1 text-11-medium font-semibold text-sky-100/90 outline-none transition disabled:opacity-30"
                            >
                              <option value="" class="bg-background-base text-text-weak">{language.t("session.goal.template.sessionDefaultModel")}</option>
                              <For each={modelOptionsForDraft()}>
                                {(option) => <option value={option.key} class="bg-background-base text-text-base">{option.label}</option>}
                              </For>
                            </select>
                          </div>
                          <div
                            data-component="goal-action-editor-limits"
                            class="grid h-7 min-w-0 grid-cols-[52px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1 rounded-md border px-1.5"
                            style={{
                              "background-color": "rgba(15, 23, 42, 0.30)",
                              "border-color": "rgba(148, 163, 184, 0.13)",
                            }}
                            aria-label={language.t("session.goal.template.constraints")}
                          >
                            <span class="shrink-0 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-100/78">
                              {language.t("session.goal.template.constraints")}
                            </span>
                            <div
                              class="flex h-5 min-w-0 items-center gap-1 rounded-full border px-1.5"
                              style={{
                                "background-color": "rgba(59, 130, 246, 0.045)",
                                "border-color": "rgba(96, 165, 250, 0.12)",
                              }}
                            >
                              <label class="flex min-w-0 flex-1 items-center gap-1" title={language.t("session.goal.chainBuilder.stat.turns")}>
                                <span class="shrink-0 text-[9px] font-semibold text-blue-100/78">
                                  {language.t("session.goal.chainBuilder.stat.turns")}
                                </span>
                                <input
                                  type="number"
                                  min="1"
                                  value={String(actionDraft.turns)}
                                  disabled={busy() !== null || !props.sessionID}
                                  aria-label={language.t("session.goal.chainBuilder.stat.turns")}
                                  onInput={(event) => {
                                    const value = Number.parseInt(event.currentTarget.value, 10)
                                    if (!Number.isFinite(value)) return
                                    setActionDraft("turns", Math.max(1, value))
                                  }}
                                  class="h-5 min-w-0 flex-1 bg-transparent p-0 text-right text-11-medium font-bold tabular-nums text-blue-50/84 outline-none disabled:opacity-40"
                                />
                              </label>
                            </div>
                            <div
                              class="flex h-5 min-w-0 items-center gap-1 rounded-full border px-1.5"
                              style={{
                                "background-color": "rgba(20, 184, 166, 0.045)",
                                "border-color": "rgba(45, 212, 191, 0.12)",
                              }}
                            >
                              <label class="flex min-w-0 flex-1 items-center gap-1" title={language.t("session.goal.chainBuilder.stat.time")}>
                                <span class="shrink-0 text-[9px] font-semibold text-teal-100/78">
                                  {language.t("session.goal.chainBuilder.stat.time")}
                                </span>
                                <input
                                  type="number"
                                  min="1"
                                  value={String(actionDraft.minutes)}
                                  disabled={busy() !== null || !props.sessionID}
                                  aria-label={language.t("session.goal.chainBuilder.stat.time")}
                                  onInput={(event) => {
                                    const value = Number.parseInt(event.currentTarget.value, 10)
                                    if (!Number.isFinite(value)) return
                                    setActionDraft("minutes", Math.max(1, value))
                                  }}
                                  class="h-5 min-w-0 flex-1 bg-transparent p-0 text-right text-11-medium font-bold tabular-nums text-teal-50/84 outline-none disabled:opacity-40"
                                />
                              </label>
                            </div>
                          </div>
                          <div
                            class="grid min-w-0 grid-cols-[52px_minmax(0,1fr)_42px] items-center gap-1 rounded-md border px-1.5 py-1"
                            style={{
                              "background-color": "rgba(16, 185, 129, 0.026)",
                              "border-color": "rgba(110, 231, 183, 0.11)",
                            }}
                          >
                            <span class="text-[9px] font-bold uppercase tracking-[0.1em] text-emerald-100/82">
                              {language.t("session.goal.template.pinnedSkills")}
                            </span>
                            <select
                              value=""
                              disabled={busy() !== null || !props.sessionID || skillPickOptions().length === 0 || actionDraft.skills.length >= 8}
                              onChange={(event) => {
                                const name = event.currentTarget.value
                                if (name) toggleActionSkill(name)
                                event.currentTarget.value = ""
                              }}
                              class="h-5 min-w-0 truncate bg-transparent text-[10px] font-semibold text-emerald-100/82 outline-none transition disabled:opacity-35"
                              title={language.t("session.goal.template.addSkill")}
                              aria-label={language.t("session.goal.template.addSkill")}
                            >
                              <option value="" class="bg-background-base text-text-weak">{language.t("session.goal.template.addSkill")}</option>
                              <For each={skillPickOptions()}>
                                {(skill) => <option value={skill.name} class="bg-background-base text-text-base">{skill.name}</option>}
                              </For>
                            </select>
                            <span class="rounded-full border px-1 py-0.5 text-center text-[10px] font-semibold tabular-nums text-emerald-100/70"
                              style={{
                                "background-color": "rgba(16, 185, 129, 0.035)",
                                "border-color": "rgba(110, 231, 183, 0.12)",
                              }}
                            >
                              {actionDraft.skills.length}/8
                            </span>
                            <Show when={skillOptionsForDraft().length > 0} fallback={
                              <div class="col-span-3 rounded-md border border-dashed border-border-base bg-background-base/35 px-2 py-1.5 text-11-regular text-text-weak">
                                {language.t("session.goal.template.noSkills")}
                              </div>
                            }>
                              <Show when={actionDraft.skills.length > 0}>
                                <div class="col-span-3 flex min-w-0 flex-wrap gap-1 overflow-hidden">
                                  <For each={actionDraft.skills}>
                                    {(skill) => (
                                      <button
                                        type="button"
                                        title={language.t("session.goal.template.removeSkill", { skill })}
                                        aria-label={language.t("session.goal.template.removeSkill", { skill })}
                                        disabled={busy() !== null || !props.sessionID}
                                        onClick={() => toggleActionSkill(skill)}
                                        class="max-w-[118px] truncate rounded border border-emerald-200/24 bg-emerald-500/13 px-1.5 py-0.5 text-left text-[10px] font-semibold text-emerald-100/90 transition hover:border-emerald-200/45 hover:bg-emerald-500/20 disabled:opacity-35"
                                      >
                                        {skill}
                                      </button>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </Show>
                          </div>
                        </div>

                        <div
                          data-component="goal-action-editor-fields"
                          class="flex flex-col gap-2 rounded-md border p-2"
                          style={{
                            "background": "linear-gradient(90deg, rgba(15, 23, 42, 0.34), rgba(24, 24, 27, 0.78) 58%, rgba(148, 163, 184, 0.045))",
                            "border-color": "rgba(148, 163, 184, 0.16)",
                            "box-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.018)",
                          }}
                        >
                          <div class="flex items-center gap-2">
                            <span
                              class="h-4 w-1.5 shrink-0 rounded-sm"
                              style={{ "background-color": "rgba(148, 163, 184, 0.55)" }}
                              aria-hidden
                            />
                            <span class="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-100/78">
                              Details
                            </span>
                          </div>
                          <TextField
                            value={actionDraft.label}
                            onChange={(value) => setActionDraft("label", value)}
                            label={language.t("session.goal.template.label")}
                            placeholder={language.t("session.goal.template.labelPlaceholder")}
                            disabled={busy() !== null || !props.sessionID}
                            class="w-full"
                          />
                          <TextField
                            value={actionDraft.prompt}
                            onChange={(value) => setActionDraft("prompt", value)}
                            label={language.t("session.goal.template.prompt")}
                            multiline
                            disabled={busy() !== null || !props.sessionID}
                            class="w-full"
                          />
                          <TextField
                            value={actionDraft.command}
                            onChange={(value) => setActionDraft("command", value)}
                            label={language.t("session.goal.template.command")}
                            placeholder={language.t("session.goal.create.commandPlaceholder")}
                            disabled={busy() !== null || !props.sessionID}
                            class="w-full"
                          />
                        </div>
                      </div>
                    </section>
                  </GoalConsoleSection>
                </aside>
            </div>
            <Show when={!props.sessionID}>
              <div class="text-11-regular text-text-weaker">{language.t("session.goal.controlsHint")}</div>
            </Show>
          </div>
        </Match>
      </Switch>

      {/* ── History timeline — visible outside the action-editing workspace ─
          A vertical rail of past runs. A cleared goal lands here as
          "Cancelled"; an achieved goal as "Achieved". This is where terminal
          goals go instead of blanking the panel. Hidden while the chain/action
          editor workspace is open so an expanded archive cannot cover controls.

          Visibility is keyed ONLY on the archive (goal-history.json, polled
          every 2s into `archive()`) — NOT on the live goal store. Coupling it
          to `store.loaded && !store.corrupt` made history vanish the moment a
          run was stopped/cleared (the live state momentarily reloads/empties),
          even though the archived runs are intact and independent. */}
      <Show when={archive().length > 0 && !showForm() && !liveGoal()}>
        <div
          data-testid="run-history"
          data-component="goal-history-panel"
          class="mt-1 min-w-0 border-t border-border-base pt-3"
        >
          <div class="rounded-2xl border border-border-base bg-background-panel/70 p-3 min-w-0">
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 text-left"
              onClick={() => setHistoryOpen((open) => !open)}
              aria-expanded={historyOpen()}
            >
              <div class="min-w-0">
                <div class="text-[11px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                  {language.t("session.goal.history.title")}
                </div>
                <div class="mt-1 text-12-regular text-text-weaker">
                  {language.t("session.goal.recentRuns")} · {archive().length} archived runs
                </div>
              </div>
              <span class="shrink-0 text-text-weaker" aria-hidden>
                {historyOpen() ? "▾" : "▸"}
              </span>
            </button>

            <Show when={historyOpen()}>
              <div class="mt-3 flex flex-col gap-3">
                <div
                  role="listbox"
                  aria-label={language.t("session.goal.recentRuns")}
                  tabindex={0}
                  class="max-h-72 overflow-y-auto rounded-xl border border-border-base bg-background-base/70"
                  onKeyDown={handleHistoryListboxKeyDown}
                >
                  <For each={archive()}>
                    {(h) => (
                      <button
                        role="option"
                        type="button"
                        aria-selected={selectedHistoryGoalID() === h.summary.goalID}
                        class="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border-base/70 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-white/[0.04] focus-visible:bg-white/[0.06] focus-visible:outline-none"
                        classList={{
                          "bg-white/[0.06]": selectedHistoryGoalID() === h.summary.goalID,
                        }}
                        onClick={() => setSelectedHistoryGoalID(h.summary.goalID)}
                      >
                        <span class={`h-2.5 w-2.5 rounded-full ${nodeColor(h.summary.status)}`} aria-hidden />
                        <div class="min-w-0">
                          <div class="truncate text-12-medium text-text-base" title={cleanText(h.summary.title)}>
                            {cleanText(h.summary.title)}
                          </div>
                          <div class="mt-0.5 truncate text-[11px] tabular-nums text-text-weaker">
                            {outcomeLabel(h.summary.outcome)} · {h.summary.turns} turns ·{" "}
                            {formatElapsed(h.summary.elapsedMs)}
                          </div>
                        </div>
                        <span
                          class="h-5 w-1 rounded-full opacity-0 transition-opacity group-aria-selected:opacity-100"
                          classList={{
                            "bg-emerald-400": h.summary.status === "success",
                            "bg-amber-400": h.summary.status === "mixed",
                            "bg-rose-400": h.summary.status === "failure",
                          }}
                          aria-hidden
                        />
                      </button>
                    )}
                  </For>
                </div>

                <Show when={selectedHistoryRun()}>
                  {(run) => (
                    <div class="min-w-0 rounded-2xl border border-border-base bg-background-base/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="flex min-w-0 items-center gap-2">
                            <span
                              class={`h-2.5 w-2.5 shrink-0 rounded-full ${nodeColor(run().summary.status)}`}
                              aria-hidden
                            />
                            <div class="truncate text-13-medium text-text-base" title={cleanText(run().summary.title)}>
                              {cleanText(run().summary.title)}
                            </div>
                          </div>
                          <div class="mt-1 text-11-regular text-text-weaker">Archived run details</div>
                        </div>
                        <ActionButton
                          label={language.t("session.goal.history.reuse")}
                          variant="secondary"
                          disabled={busy() !== null || !props.sessionID}
                          onClick={() => void reuseHistoryRun(run().detail.template.reuseCommand)}
                        />
                      </div>

                      <div class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 2xl:grid-cols-5">
                        <RunMetricPill
                          label="Outcome"
                          value={outcomeLabel(run().summary.outcome)}
                          detail={run().summary.status}
                          tone={
                            run().summary.status === "success"
                              ? "success"
                              : run().summary.status === "failure"
                                ? "danger"
                                : "warning"
                          }
                        />
                        <RunMetricPill label="Turns" value={String(run().summary.turns)} detail="evaluated" />
                        <RunMetricPill
                          label="Elapsed"
                          value={formatElapsed(run().summary.elapsedMs)}
                          detail="runtime"
                        />
                        <RunMetricPill
                          label="Passed"
                          value={String(run().summary.successCount)}
                          detail="passed"
                          tone={run().summary.successCount > 0 ? "success" : "default"}
                        />
                        <RunMetricPill
                          label="Failed"
                          value={String(run().summary.failureCount)}
                          detail="not met"
                          tone={run().summary.failureCount > 0 ? "danger" : "default"}
                        />
                      </div>

                      <Show when={run().detail.latestReason}>
                        <div class="mt-3 rounded-xl border border-border-base bg-background-panel/70 px-3 py-2.5">
                          <div class="text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                            Latest reason
                          </div>
                          <div class="mt-1 text-12-regular leading-5 text-text-weak">
                            {cleanText(run().detail.latestReason)}
                          </div>
                        </div>
                      </Show>

                      <div class="mt-3 flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
                        <For each={run().detail.cycles}>
                          {(cycle) => (
                            <div class="flex items-start gap-2 rounded-lg border border-border-base/70 bg-background-panel/50 px-2 py-1.5 text-11-regular">
                              <span class={`mt-0.5 shrink-0 ${cycle.met ? "text-emerald-400" : "text-amber-400"}`}>
                                {cycle.met ? "✓" : "↺"}
                              </span>
                              <span class="shrink-0 tabular-nums text-text-weaker">#{cycle.turn}</span>
                              <span class="min-w-0 flex-1 text-text-weak">{cleanText(cycle.reason)}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
