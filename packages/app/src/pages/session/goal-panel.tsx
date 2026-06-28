import { For, Match, Show, Switch, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"

import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { usePermission } from "@/context/permission"
import { useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { setSessionHandoff } from "@/pages/session/handoff"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { sessionPermissionRequest, sessionQuestionRequest } from "./composer/session-request-tree"

import type { JSX } from "solid-js"

import {
  goalIdleMinutes,
  isGoalStalled,
  liveGoal as liveGoalOf,
  nodeColor as nodeColorOf,
  outcomeLabel as outcomeLabelOf,
  pauseResumeAction,
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
  actionEditorControlState,
  actionEditorDraftFromTemplate,
  actionDraftTemplateFromState,
  actionIDFromLabel,
  agentNameForRuntime,
  agentRoutingOptions,
  applyArchivePoll,
  chainBudgetSummary,
  chainStartControlState,
  chainMatchesGoal,
  chainStartPayload,
  chainStepRuntimeLabels,
  chainStepFromTemplate,
  chainStepVisibleSourceForState,
  resolveStepConditionWithObjective,
  cleanText,
  parseRuntimeChainSnapshot,
  readHandoffFromSdk,
  readGoalFromSdk,
  removeVisibleDraftStep,
  selectRunnableChainSteps,
  skillPickerControlState,
  templateButtonsFromSnapshot,
  templateVariableDefaults,
  validateChainDraft,
  ACTION_CATEGORIES,
  DEFAULT_TEMPLATE_BUTTONS,
  GOAL_TEMPLATE_CATEGORIES,
  GOAL_TEMPLATE_ELEVATIONS,
  GOAL_TEMPLATE_TONES,
  actionCategoryShortLabel,
  handoffPanelMode,
  goalInterruptionWarningKey,
  isGoalPinnedModel,
  steerDraftDisposition,
  templateModelFromSnapshot,
  type ActionCategory,
  type ActionEditorDisabledReason,
  type ChainValidationError,
  type GoalSdkClient,
  type GoalHandoffStore,
  type GoalActionDraftTemplate,
  type GoalChainDraftStep,
  type HistoryRun,
  type GoalTemplateButton,
  type GoalTemplateCategory,
  type GoalTemplateElevation,
  type GoalTemplateModel,
  type GoalTemplateTone,
  type GoalPendingPromptKind,
  type RuntimeChainData,
  type RuntimeChainStep,
  type SkillPickerDisabledReason,
  // AG-P1-05 — pure visible-source routing for chain row actions.
  chainStepVisibleAction,
  type ChainStepVisibleSource,
  // AG-P1-07 — ordered chain refresh guard (gen-counter discard pattern).
  createOrderedChainRefresh,
} from "./goal-panel-pure"
import {
  abortGoalSessionTree,
  executeGoalCommand,
  pauseGoalRun,
  resetGoalWorkspaceState,
  startGoalRunGuarded,
  steerGoalRunGuarded,
  stopGoalRun,
} from "./goal-panel-actions"
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
const ACTION_SKILL_LIMIT = 8

// GoalStore is the public type for the goal panel's store snapshot.
// Aliased to the pure module's GoalStore so consumers using either
// `import type { GoalStore } from "./goal-panel"` (legacy) or
// `import type { GoalStore } from "./goal-panel-pure"` (new) get the
// same shape.
export type GoalStore = import("./goal-panel-pure").GoalStore

function goalStateForSession(state: GoalState | null, sessionID?: string) {
  if (!state || !sessionID) return state
  const metadata = (state as GoalState & { metadata?: { sessionId?: unknown } }).metadata
  const owner = typeof metadata?.sessionId === "string" ? cleanText(metadata.sessionId).trim() : ""
  if (!owner) return state
  return owner === sessionID ? state : null
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
    setStore("loaded", next.loaded)
    setStore("corrupt", next.corrupt)
    // CENTER-AUDIT NCO1 — `unreachable` is undefined on a healthy fetch,
    // true after a non-FileNotFound error. The panel uses this to surface
    // a connectivity hint instead of conflating it with "no goal".
    setStore("unreachable", next.unreachable ?? false)
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

export type ChainStep = RuntimeChainStep
export type ChainData = RuntimeChainData

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
  agent: string
  skills: string[]
  model: string
}

/** Read the engine's `.opencode/.goal-chain.json` so the panel can show
 *  chain steps. Returns null when this is a direct, non-chain goal. */
async function readChain(sdk: GoalActionClient): Promise<ChainData | null> {
  const content = await readWorkspaceText(sdk, ".opencode/.goal-chain.json")
  if (!content) return null
  try {
    return parseRuntimeChainSnapshot(JSON.parse(content))
  } catch {
    return null
  }
}

const TEMPLATES_PATH = ".opencode/goal-templates.json"
const TEMPLATE_SAVE_ID_RE = /^[A-Za-z0-9_-]+$/

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
  return "inline-flex min-w-0 items-center justify-center truncate rounded-md border px-2 py-0 text-11-medium font-semibold leading-none transition disabled:cursor-not-allowed disabled:opacity-30"
}

function goalCommandButtonStyle(variant: "primary" | "secondary" | "ghost", tone: "default" | "success" | "danger") {
  if (tone === "danger") {
    return { "background-color": "rgba(239, 68, 68, 0.12)", "border-color": "rgba(248, 113, 113, 0.38)", color: "rgb(252, 165, 165)" }
  }
  if (tone === "success") {
    return { "background-color": "rgba(16, 185, 129, 0.12)", "border-color": "rgba(52, 211, 153, 0.34)", color: "rgb(167, 243, 208)" }
  }
  if (variant === "primary") {
    return { "background-color": "rgba(59, 130, 246, 0.14)", "border-color": "rgba(96, 165, 250, 0.34)", color: "rgb(191, 219, 254)" }
  }
  if (variant === "ghost") {
    return { "background-color": "rgba(148, 163, 184, 0.06)", "border-color": "rgba(148, 163, 184, 0.16)", color: "rgb(161, 161, 170)" }
  }
  return { "background-color": "rgba(14, 165, 233, 0.10)", "border-color": "rgba(125, 211, 252, 0.24)", color: "rgb(186, 230, 253)" }
}

function inlineCommandButtonClass(tone: "add" | "edit" | "move" | "remove") {
  const base =
    "goal-inline-command-button flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border px-1 text-center text-11-medium font-semibold leading-none transition-all focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
  if (tone === "add") {
    return `${base} goal-inline-command-add w-6 border-emerald-300/32 bg-emerald-500/10 text-emerald-100 hover:border-emerald-200/58 hover:bg-emerald-500/18 focus-visible:ring-emerald-200/60`
  }
  if (tone === "remove") {
    return `${base} goal-inline-command-remove w-6 border-orange-300/48 bg-orange-500/14 text-orange-100 hover:border-orange-200/72 hover:bg-orange-500/22 focus-visible:ring-orange-300/58`
  }
  if (tone === "move") {
    return `${base} goal-inline-command-move w-6 border-border-base bg-background-base text-text-weak hover:border-border-strong hover:bg-white/[0.06] hover:text-text-base focus-visible:ring-border-strong`
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
      "background-color": "rgba(249, 115, 22, 0.16)",
      "border-color": "rgba(253, 186, 116, 0.50)",
      color: "rgb(255, 237, 213)",
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

function metricAccent(ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio))
  const hue = 145 * (1 - r)
  return `hsl(${hue}, 72%, 52%)`
}

function toneAccent(tone: "default" | "success" | "warning" | "danger"): string {
  if (tone === "success") return "hsl(145, 72%, 52%)"
  if (tone === "warning") return "hsl(38, 92%, 56%)"
  if (tone === "danger") return "hsl(0, 72%, 52%)"
  return "hsl(210, 10%, 45%)"
}

function RunMetricPill(props: {
  label: string
  value: string
  detail?: string
  accent?: string
  tone?: "default" | "success" | "warning" | "danger"
}) {
  const c = () => props.accent ?? (props.tone ? toneAccent(props.tone) : "hsl(210, 10%, 45%)")
  return (
    <div
      class="flex min-w-0 flex-col items-center rounded-md px-2 py-1 text-center"
      style={{
        background: `linear-gradient(180deg, color-mix(in srgb, ${c()} 14%, transparent) 0%, transparent 100%)`,
        "box-shadow": `inset 0 1px 0 color-mix(in srgb, ${c()} 20%, transparent), 0 1px 2px rgba(0,0,0,0.25)`,
      }}
    >
      <div class="text-sm font-bold tabular-nums leading-5" style={{ color: `color-mix(in srgb, ${c()} 70%, white)` }} title={props.value}>
        {props.value}
      </div>
      <div class="truncate text-[8px] font-semibold uppercase tracking-[0.06em] text-text-weaker">
        {props.label}
      </div>
    </div>
  )
}

function GoalConsoleSection(props: {
  zone:
    | "running-status"
    | "run-controls"
    | "chain-builder"
    | "action-library"
    | "action-editor"
    | "activity"
    | "history"
    | "terminal-result"
  title: string
  subtitle?: string
  class?: string
  accent?: {
    style: JSX.CSSProperties
    headerStyle: JSX.CSSProperties
    markerStyle: JSX.CSSProperties
  }
  children: JSX.Element
}) {
  // Single inline-style accent system. Inline is the source of truth because
  // dynamically-keyed Tailwind color classes render white under Electron dark
  // mode (verified). Each zone declares border/shadow (style), header gradient
  // (headerStyle), and marker fill (markerStyle) in one place so the two
  // mechanisms can no longer drift.
  // Calm accent system: each zone keeps its identity through the marker dot and
  // a faint border + subtle header tint, but the saturated gradients, bright
  // borders, and colored glow rings were dialed back so content (esp. the goal
  // input) reads as the primary element rather than the chrome.
  const accentByZone = {
    "running-status": {
      style: {
        "border-color": "rgba(56, 189, 248, 0.32)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.16)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(12, 74, 110, 0.38), rgba(24, 24, 27, 0.92))",
        "border-color": "rgba(125, 211, 252, 0.30)",
      },
      markerStyle: { "background-color": "rgb(186, 230, 253)" },
    },
    "run-controls": {
      style: {
        "border-color": "rgba(129, 140, 248, 0.30)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.16)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(49, 46, 129, 0.38), rgba(24, 24, 27, 0.92))",
        "border-color": "rgba(165, 180, 252, 0.28)",
      },
      markerStyle: { "background-color": "rgb(199, 210, 254)" },
    },
    "chain-builder": {
      style: {
        "border-color": "rgba(120, 100, 200, 0.28)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.16)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(55, 35, 110, 0.28), rgba(24, 24, 27, 0.92))",
        "border-color": "rgba(140, 120, 220, 0.16)",
      },
      markerStyle: { "background-color": "rgba(170, 150, 240, 0.75)" },
    },
    "action-library": {
      style: {
        "border-color": "rgba(148, 163, 184, 0.18)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.16)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(39, 39, 42, 0.88), rgba(24, 24, 27, 0.94))",
        "border-color": "rgba(148, 163, 184, 0.12)",
      },
      markerStyle: { "background-color": "rgba(52, 211, 153, 0.7)" },
    },
    "action-editor": {
      style: {
        "border-color": "rgba(148, 163, 184, 0.24)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.14)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(39, 39, 42, 0.88), rgba(24, 24, 27, 0.94))",
        "border-color": "rgba(148, 163, 184, 0.20)",
      },
      markerStyle: { "background-color": "rgba(203, 213, 225, 0.8)" },
    },
    activity: {
      style: {
        "border-color": "rgba(34, 211, 238, 0.30)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.16)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(21, 94, 117, 0.38), rgba(24, 24, 27, 0.92))",
        "border-color": "rgba(103, 232, 249, 0.28)",
      },
      markerStyle: { "background-color": "rgb(165, 243, 252)" },
    },
    history: {
      style: {
        "border-color": "rgba(148, 163, 184, 0.24)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.14)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(39, 39, 42, 0.88), rgba(24, 24, 27, 0.94))",
        "border-color": "rgba(148, 163, 184, 0.20)",
      },
      markerStyle: { "background-color": "rgba(203, 213, 225, 0.8)" },
    },
    "terminal-result": {
      style: {
        "border-color": "rgba(148, 163, 184, 0.24)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.14)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(39, 39, 42, 0.88), rgba(24, 24, 27, 0.94))",
        "border-color": "rgba(148, 163, 184, 0.20)",
      },
      markerStyle: { "background-color": "rgba(203, 213, 225, 0.8)" },
    },
  }
  // HMR can keep a stale component instance whose zone no longer exists in the
  // current accent map (e.g. after a zone rename). Fall back to chain-builder
  // so the app survives the mismatch instead of white-screening.
  const accent = props.accent ?? accentByZone[props.zone] ?? accentByZone["chain-builder"]

  return (
    <section
      data-component="goal-console-section"
      data-zone={props.zone}
      class={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-background-base/80 ${props.class ?? ""}`}
      style={accent.style}
    >
      <div data-component="goal-console-section-header" class="shrink-0 border-b border-border-base/60 px-2.5 py-1.5" style={accent.headerStyle}>
        <div
          data-component="goal-console-section-title"
          class="flex min-w-0 items-center"
        >
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <span class="h-4 w-1.5 shrink-0 rounded-sm" style={accent.markerStyle} aria-hidden />
            <div class="flex min-w-0 flex-1 items-baseline gap-2">
              <span data-component="goal-console-section-title-text" class="shrink-0 truncate text-[13px] font-black uppercase leading-4 tracking-[0.12em] text-white/88">
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
      "background": "linear-gradient(90deg, rgba(30, 58, 95, 0.22), rgba(15, 23, 42, 0.42))",
      "border-bottom-color": "rgba(100, 140, 200, 0.10)",
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

function runningInlinePanelStyle(tone: "stop" | "steer" | "handoff" | "activity" | "evidence" | "steering"): JSX.CSSProperties {
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
  if (tone === "evidence") {
    return {
      "background-color": "rgba(30, 58, 138, 0.18)",
      "border-color": "rgba(96, 165, 250, 0.22)",
      "box-shadow": "inset 3px 0 0 rgba(96, 165, 250, 0.50), inset 0 1px 0 rgba(255,255,255,0.03)",
    } satisfies JSX.CSSProperties
  }
  if (tone === "steering") {
    return {
      "background-color": "rgba(67, 20, 88, 0.18)",
      "border-color": "rgba(192, 132, 252, 0.22)",
      "box-shadow": "inset 3px 0 0 rgba(192, 132, 252, 0.50), inset 0 1px 0 rgba(255,255,255,0.03)",
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

function completionRuleClass(input: ActionDescriptor) {
  return hasVerificationCommand(input)
    ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-200"
    : "border-border-base bg-background-base/70 text-text-weaker"
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

function terminalResultAccent(status: GoalState["status"]): {
  style: JSX.CSSProperties
  headerStyle: JSX.CSSProperties
  markerStyle: JSX.CSSProperties
} {
  if (status === "achieved") {
    return {
      style: {
        "border-color": "rgba(52, 211, 153, 0.40)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.14), 0 0 32px rgba(16, 185, 129, 0.12), inset 0 0 0 1px rgba(16, 185, 129, 0.06)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(6, 78, 59, 0.52), rgba(24, 24, 27, 0.92))",
        "border-color": "rgba(52, 211, 153, 0.30)",
      },
      markerStyle: { "background-color": "rgb(110, 231, 183)" },
    }
  }
  if (status === "cleared") {
    return {
      style: {
        "border-color": "rgba(251, 146, 60, 0.30)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.14), 0 0 24px rgba(249, 115, 22, 0.06)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(124, 45, 18, 0.38), rgba(24, 24, 27, 0.94))",
        "border-color": "rgba(251, 146, 60, 0.22)",
      },
      markerStyle: { "background-color": "rgb(253, 186, 116)" },
    }
  }
  if (status === "paused") {
    return {
      style: {
        "border-color": "rgba(251, 191, 36, 0.28)",
        "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.14), 0 0 24px rgba(245, 158, 11, 0.06)",
      },
      headerStyle: {
        "background": "linear-gradient(90deg, rgba(120, 53, 15, 0.36), rgba(24, 24, 27, 0.94))",
        "border-color": "rgba(251, 191, 36, 0.20)",
      },
      markerStyle: { "background-color": "rgb(252, 211, 77)" },
    }
  }
  return {
    style: {
      "border-color": "rgba(148, 163, 184, 0.24)",
      "box-shadow": "0 6px 16px rgba(0, 0, 0, 0.14)",
    },
    headerStyle: {
      "background": "linear-gradient(90deg, rgba(39, 39, 42, 0.88), rgba(24, 24, 27, 0.94))",
      "border-color": "rgba(148, 163, 184, 0.20)",
    },
    markerStyle: { "background-color": "rgba(203, 213, 225, 0.8)" },
  }
}

// AG-P0-04 — explicit draft provenance. The previous `steps: []` shape
// could not distinguish "no draft ever set" (recoverable from a runtime
// chain) from "user explicitly cleared the draft" (must remain empty).
// `source` records which side of that line the current draft sits on.
type ChainDraftSource = "uninitialized" | "draft";

interface ChainDraftState {
  source: ChainDraftSource;
  steps: GoalChainDraftStep[];
  master: { maxTurns: number; maxTimeMinutes: number };
  /** Run-level objective that fills `{scope}` across every chain step at start. */
  objective: string;
}

function defaultChainDraft(): ChainDraftState {
  return {
    source: "uninitialized",
    steps: [],
    master: { maxTurns: 20, maxTimeMinutes: 60 },
    objective: "",
  };
}

function chainDraftStorageKey(sessionID?: string) {
  return `opencode.goalChainDraft.${sessionID || "workspace"}`
}

function isStoredChainDraft(value: unknown): value is ChainDraftState {
  if (!value || typeof value !== "object") return false
  const draft = value as { source?: unknown; steps?: unknown; master?: unknown; objective?: unknown }
  // AG-P0-04 — `source` is optional on the validator because old stored
  // drafts predate the field. `readStoredChainDraft` always assigns
  // `source: "draft"` on the way out, so an absent field round-trips
  // as `draft` (a persisted explicit-empty stays explicit-empty; only
  // a fresh `defaultChainDraft()` returns `uninitialized`).
  if (draft.source !== undefined && draft.source !== "uninitialized" && draft.source !== "draft") return false;
  if (!Array.isArray(draft.steps)) return false
  if (!draft.master || typeof draft.master !== "object") return false
  if (draft.objective !== undefined && typeof draft.objective !== "string") return false
  const master = draft.master as { maxTurns?: unknown; maxTimeMinutes?: unknown }
  if (typeof master.maxTurns !== "number" || !Number.isFinite(master.maxTurns)) return false
  if (typeof master.maxTimeMinutes !== "number" || !Number.isFinite(master.maxTimeMinutes)) return false
  return draft.steps.every((step) => {
    if (!step || typeof step !== "object") return false
    const id: unknown = Reflect.get(step, "id")
    const actionID: unknown = Reflect.get(step, "actionID")
    const label: unknown = Reflect.get(step, "label")
    const condition: unknown = Reflect.get(step, "condition")
    const conditionTemplate: unknown = Reflect.get(step, "conditionTemplate")
    const command: unknown = Reflect.get(step, "command")
    const maxTurns: unknown = Reflect.get(step, "maxTurns")
    const maxTimeMinutes: unknown = Reflect.get(step, "maxTimeMinutes")
    const category: unknown = Reflect.get(step, "category")
    const tone: unknown = Reflect.get(step, "tone")
    const elevation: unknown = Reflect.get(step, "elevation")
    const agent: unknown = Reflect.get(step, "agent")
    const skills: unknown = Reflect.get(step, "skills")
    const model: unknown = Reflect.get(step, "model")
    const builtin: unknown = Reflect.get(step, "builtin")
    return (
      typeof id === "string" &&
      typeof actionID === "string" &&
      typeof label === "string" &&
      typeof condition === "string" &&
      (conditionTemplate === undefined || typeof conditionTemplate === "string") &&
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
      (agent === undefined || typeof agent === "string") &&
      (skills === undefined ||
        (Array.isArray(skills) && skills.every((skill) => typeof skill === "string"))) &&
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
    // AG-P0-04 — if a key exists in sessionStorage, the user (or a prior
    // load) has touched this draft. Treat it as `draft` regardless of
    // whether steps is empty; an explicitly empty draft is still a draft.
    // Only `defaultChainDraft()` returns `uninitialized`. The persisted
    // `source` field, if present, wins — this lets a future caller store
    // `uninitialized` explicitly (currently no caller does, but the
    // forward-compatibility is cheap).
    const persistedSource: ChainDraftSource =
      parsed.source === "uninitialized" ? "uninitialized" : "draft";
    return {
      source: persistedSource,
      steps: parsed.steps.map((step) => ({
        id: step.id,
        actionID: step.actionID,
        label: cleanText(step.label),
        condition: cleanText(step.condition),
        ...(step.conditionTemplate ? { conditionTemplate: cleanText(step.conditionTemplate) } : {}),
        command: cleanText(step.command),
        maxTurns: Math.max(1, Math.round(step.maxTurns)),
        maxTimeMinutes: Math.max(1, Math.round(step.maxTimeMinutes)),
        ...(step.category ? { category: step.category } : {}),
        ...(step.tone ? { tone: step.tone } : {}),
        ...(step.elevation ? { elevation: step.elevation } : {}),
        ...(agentNameForRuntime(step.agent) ? { agent: agentNameForRuntime(step.agent) } : {}),
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
      objective: typeof parsed.objective === "string" ? cleanText(parsed.objective) : "",
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

function hiddenTemplateStorageKey(sessionID?: string) {
  return `opencode.goalHiddenTemplates.${sessionID || "workspace"}`
}

function readStoredHiddenTemplateIDs(sessionID?: string): Record<string, true> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.sessionStorage.getItem(hiddenTemplateStorageKey(sessionID))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    const ids = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? Object.keys(parsed as Record<string, unknown>)
        : []
    return Object.fromEntries(
      ids
        .filter((id): id is string => typeof id === "string" && TEMPLATE_SAVE_ID_RE.test(id))
        .map((id) => [id, true as const]),
    )
  } catch {
    return {}
  }
}

function writeStoredHiddenTemplateIDs(sessionID: string | undefined, ids: Record<string, true>) {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(hiddenTemplateStorageKey(sessionID), JSON.stringify(Object.keys(ids)))
  } catch {
    // Storage is best-effort; hidden action cards still stay hidden in memory.
  }
}

export function GoalPanel(props: { goal: { store: GoalStore; refresh: () => Promise<void> }; sessionID?: string }) {
  const language = useLanguage()
  const server = useServer()
  const models = useModels()
  const sdk = useSDK() as unknown as GoalActionClient
  const sync = useSync()
  const permission = usePermission()
  const navigate = useNavigate()
  const state = () => goalStateForSession(props.goal.store.state, props.sessionID)
  const pendingPermissionRequest = createMemo(() =>
    sessionPermissionRequest(sync.data.session ?? [], sync.data.permission ?? {}, props.sessionID, (item) => {
      return !permission.autoResponds(item, sdk.directory)
    }),
  )
  const pendingQuestionRequest = createMemo(() =>
    sessionQuestionRequest(sync.data.session ?? [], sync.data.question ?? {}, props.sessionID),
  )
  const pendingPromptKind = createMemo<GoalPendingPromptKind>(() => {
    if (pendingPermissionRequest()) return "permission"
    if (pendingQuestionRequest()) return "question"
    return null
  })
  const interruptionWarningText = (action: "pause" | "stop") => {
    const key = goalInterruptionWarningKey({ action, pendingPrompt: pendingPromptKind() })
    return key ? language.t(key) : null
  }
  const goalControlMessage = (...messages: Array<string | null | undefined>) => {
    const clean = messages.map((message) => cleanText(message).trim()).filter(Boolean)
    return clean.length > 0 ? [...new Set(clean)].join(" ") : null
  }

  const [busy, setBusy] = createSignal<GoalAction | "set" | "steer" | "budget" | "step" | "template" | "chain" | "fresh" | null>(null)
  // Optimistic pause/resume: the instant the user clicks, we record the status
  // they drove the goal toward so the single toggle flips immediately, instead
  // of lagging the 2s poll (and risking a stale command). Cleared once the
  // polled status catches up — or reverted if the command failed.
  const [optimisticStatus, setOptimisticStatus] = createSignal<"active" | "paused" | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const [controlError, setControlError] = createSignal<string | null>(null)
  const [confirmingClear, setConfirmingClear] = createSignal(false)
  const [newCommand, setNewCommand] = createSignal("")
  const [steerOpen, setSteerOpen] = createSignal(false)
  const [steerText, setSteerText] = createSignal("")
  const [handoff, setHandoff] = createSignal<GoalHandoffStore>({ handoff: null, corrupt: false, loaded: false })
  const [handoffOpen, setHandoffOpen] = createSignal(false)
  const [handoffText, setHandoffText] = createSignal("")
  const [activity, setActivity] = createSignal<ActivityEvent[]>([])
  const [chain, setChain] = createSignal<ChainData | null>(null)
  const [chainDismissed, setChainDismissed] = createSignal(false)
  // v0.7.3 / G-2 — set of dismissed terminal-goal IDs. When the user
  // clicks the dismiss-terminal X button on a terminal-history
  // row, the goal's ID is added here so the unarchivedTerminalGoal
  // filter hides it. The set is in-memory only — dismissing a
  // goal does NOT remove it from the on-disk archive, it just
  // hides it from the panel. A server-side poll will re-add it to
  // the archive (the goal is already there from the achievement
  // transition). The distinction:
  //   chainDismissed = "user dismissed the chain entirely" (suppresses
  //                    all chain polling until reset)
  //   dismissedTerminalGoalIDs = "user acknowledged this specific
  //                                terminal goal; hide it from the
  //                                unarchived view"
  const [dismissedTerminalGoalIDs, setDismissedTerminalGoalIDs] = createStore<{ ids: string[] }>({ ids: [] })
  const initialHiddenTemplateIDs = readStoredHiddenTemplateIDs(props.sessionID)
  const [templates, setTemplates] = createSignal(DEFAULT_TEMPLATE_BUTTONS.filter((template) => !initialHiddenTemplateIDs[template.id]))
  const [localTemplateOverrides, setLocalTemplateOverrides] = createSignal<Record<string, GoalTemplateButton>>({})
  const [deletedTemplateIDs, setDeletedTemplateIDs] = createSignal<Record<string, true>>(initialHiddenTemplateIDs)
  const [selectedTemplateID, setSelectedTemplateID] = createSignal<string | null>(null)
  const [loadedTemplateSessionID, setLoadedTemplateSessionID] = createSignal(props.sessionID)
  const [templateVars, setTemplateVars] = createSignal<Record<string, string>>({})
  const [templateSearch, setTemplateSearch] = createSignal("")
  const [templateCategory, setTemplateCategory] = createSignal<ActionCategory>("All")
  const [chainErrors, setChainErrors] = createSignal<ChainValidationError[]>([])
  const [chainDraft, setChainDraft] = createStore<ChainDraftState>(readStoredChainDraft(props.sessionID))
  const [loadedDraftSessionID, setLoadedDraftSessionID] = createSignal(props.sessionID)
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
    agent: "",
    skills: [],
    model: "",
  })
  const [archive, setArchive] = createSignal<HistoryRun[]>([])
  const [availableSkills, setAvailableSkills] = createSignal<SkillOption[]>([])
  const structuredHandoffPrompt = (pending: NonNullable<GoalHandoffStore["handoff"]>) => {
    const goal = pending.state
    return [
      "OpenGoal handoff: continue this goal in a fresh session.",
      "",
      `Repository: ${sdk.directory ?? "current workspace"}`,
      `Goal ID: ${cleanText(goal.id)}`,
      `Status at handoff: ${cleanText(goal.status)}`,
      `Condition: ${cleanText(goal.condition)}`,
      `Constraints: ${goal.constraints.maxTurns} turns, ${goal.constraints.maxTimeMinutes} minutes, ${goal.constraints.maxTokens} tokens.`,
      goal.command ? `Verification command: ${cleanText(goal.command)}` : "Verification command: none recorded.",
      pending.note ? `Operator handoff note: ${cleanText(pending.note)}` : "Operator handoff note: none.",
      goal.lastEvaluation?.reason ? `Last evaluation: ${cleanText(goal.lastEvaluation.reason)}` : "Last evaluation: none recorded.",
      "",
      "Read .opencode/.goal-state.json and .opencode/.goal-handoff.json before changing code.",
      "Treat this as a continuation from handoff, but do not rely on the previous chat context.",
      "Continue until the goal is achieved, blocked, or the configured limits require stopping.",
    ].join("\n")
  }
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [activityExpanded, setActivityExpanded] = createSignal(false)
  const [confirmingReset, setConfirmingReset] = createSignal(false)
  const [selectedHistoryGoalID, setSelectedHistoryGoalID] = createSignal<string | null>(null)

  createEffect(() => {
    const sessionID = props.sessionID
    if (sessionID === loadedDraftSessionID()) return
    const next = readStoredChainDraft(sessionID)
    setLoadedDraftSessionID(sessionID)
    // AG-P0-04 — restore `source` from the freshly-loaded draft so the
    // "explicit empty" state survives session switches (this is what
    // prevents the "last X revives the whole list" sequence when the
    // user cleared the draft in another session).
    // v0.7.3 / scan 2026-06-25 (D-NEW-4) — wrap the multi-field draft
    // restore in batch() so the autosave `effect()` that persists
    // the draft fires once with the final state, not once per
    // intermediate write. Without batch(), if the user closes the
    // tab between writes 1 and 5, the persisted draft ends up with
    // new `source` but old `steps` — silently inconsistent on reload.
    batch(() => {
      setChainDraft("source", next.source)
      setChainDraft("steps", next.steps)
      setChainDraft("master", "maxTurns", next.master.maxTurns)
      setChainDraft("master", "maxTimeMinutes", next.master.maxTimeMinutes)
      setChainDraft("objective", next.objective)
      setChainErrors([])
      setNewCommand("")
    })
  })

  createEffect(() => {
    writeStoredChainDraft(props.sessionID, {
      // AG-P0-04 — persist `source` so the explicit-empty state survives
      // a reload. Without this, a reload of a `{source: "draft", steps: []}`
      // would round-trip through defaultChainDraft() and become
      // `uninitialized` again, re-enabling recovery from runtime.
      source: chainDraft.source,
      steps: chainDraft.steps.map((step) => ({ ...step })),
      master: {
        maxTurns: chainDraft.master.maxTurns,
        maxTimeMinutes: chainDraft.master.maxTimeMinutes,
      },
      objective: chainDraft.objective,
    })
  })

  let errorDismissTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const err = controlError()
    clearTimeout(errorDismissTimer)
    if (err) {
      errorDismissTimer = setTimeout(() => setControlError(null), 8000)
    }
  })
  onCleanup(() => clearTimeout(errorDismissTimer))

  // v0.7.3 / scan 2026-06-25 (D-NEW-5) — silent-catch cleanup.
  // Pre-fix the helper swallowed refresh errors with no telemetry,
  // so SDK-unreachable errors would leave the UI showing stale
  // chain/archive/handoff/activity data forever with no signal.
  // Post-fix the helper logs at the console level so production
  // debugging has a trail. The catch is still silent to the user
  // (UI shows stale data rather than an error toast for transient
  // SDK hiccups) but a log entry is emitted with context.
  //
  // The console.warn call is wrapped in try/catch so a broken
  // logger (overridden in tests, or a browser with no console)
  // doesn't surface as an unhandled rejection from the .catch()
  // call site — which would defeat the fire-and-forget contract.
  const ignoreRefreshError = (context: string) => (error: unknown) => {
    try {
      // eslint-disable-next-line no-console
      console.warn(`[goal-panel] ${context} failed:`, error)
    } catch {
      // Logger is broken; the error is lost. Nothing more we can
      // do without a working telemetry channel.
    }
    return undefined
  }

  const refreshArchive = () =>
    void readArchive(sdk)
      .then((runs) => {
        const next = applyArchivePoll(archive(), runs, selectedHistoryGoalID())
        setArchive(next.runs)
        setSelectedHistoryGoalID(next.selectedGoalID)
      })
      .catch(ignoreRefreshError("refreshArchive"))
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
      .catch(ignoreRefreshError("mergeTemplates"))
  createEffect(() => {
    const sessionID = props.sessionID
    if (sessionID === loadedTemplateSessionID()) return
    const nextDeleted = readStoredHiddenTemplateIDs(sessionID)
    setLoadedTemplateSessionID(sessionID)
    setDeletedTemplateIDs(nextDeleted)
    setTemplates(mergeTemplates(templates(), localTemplateOverrides(), nextDeleted))
    void refreshTemplates()
  })
  createEffect(() => {
    writeStoredHiddenTemplateIDs(props.sessionID, deletedTemplateIDs())
  })
  const refreshSkills = () =>
    void readAvailableSkills(sdk)
      .then((next) => {
        setAvailableSkills(next)
      })
      .catch(ignoreRefreshError("refreshSkills"))
  const refreshHandoff = () => void readHandoffFromSdk(sdk as unknown as GoalSdkClient).then(setHandoff).catch(ignoreRefreshError("refreshHandoff"))

  // AG-P1-07 — single shared ordering guard for the polling tick AND
  // command-triggered refreshes. Both paths funnel through the same
  // generation counter so an in-flight request from one path cannot
  // resurrect older state by overwriting a newer commit from the other.
  const chainRefresh = createOrderedChainRefresh<ChainData | null>(
    () => readChain(sdk),
    (data) => { if (!chainDismissed()) setChain(data) },
  );

  onMount(() => {
    refreshSkills()
    const tick = () => {
      setNow(Date.now())
      void readActivity(sdk).then(setActivity).catch(ignoreRefreshError("readActivity"))
      // AG-P1-07 — shared guard (not a bare `void readChain...then(setChain)`).
      void chainRefresh.request()
      refreshHandoff()
      void refreshTemplates()
      refreshArchive()
      void props.goal.refresh().catch(ignoreRefreshError("goal.refresh (tick)"))
    }
    tick()
    const timer = setInterval(tick, 2000)
    // AG-P1-07 — dispose the guard on unmount so a late network completion
    // from a discarded component instance cannot resurrect older state.
    onCleanup(() => {
      clearInterval(timer)
      chainRefresh.dispose()
    })
  })

  // AG-P1-07 — `refreshChain` now returns a Promise (the ticket requires
  // this). Callers that ignored the return value before still work; the
  // poll loop awaits internally and the guard discards stale results.
  const refreshChain = (): Promise<void> => chainRefresh.request()

  const refreshGoalSurfaces = async (options: { templates?: boolean } = {}) => {
    await props.goal.refresh().catch(ignoreRefreshError("goal.refresh (surfaces)"))
    await refreshChain()
    refreshHandoff()
    refreshArchive()
    if (options.templates) await refreshTemplates()
  }

  let promptAdmissionEpoch = 0
  const invalidatePromptAdmissions = () => {
    promptAdmissionEpoch += 1
  }
  const promptAdmissionGuard = (expectedGoalID: string | null | undefined) => {
    const epoch = promptAdmissionEpoch
    return {
      shouldContinue: async () => {
        if (promptAdmissionEpoch !== epoch) return false
        await props.goal.refresh().catch(ignoreRefreshError("goal.refresh (prompt guard)"))
        if (promptAdmissionEpoch !== epoch) return false
        const current = state()
        if (!expectedGoalID) return true
        return current?.id === expectedGoalID && current.status === "active"
      },
      onStaleDelivery: async () => {
        const sessionID = props.sessionID
        if (!sessionID) return
        await abortGoalSessionTree(sdk.client, { sessionID, directory: sdk.directory })
      },
    }
  }

  /** Send a deterministic `/goal <args>` control call. This intentionally does
   *  not use session.command; the 2s poll + refresh surface the result. */
  const sendGoalCommand = async (
    label: GoalAction | "set" | "steer" | "budget" | "step" | "template" | "chain",
    args: string,
  ): Promise<boolean> => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return false
    invalidatePromptAdmissions()
    setBusy(label)
    const result = await executeGoalCommand(sdk.client, { sessionID, arguments: args, directory: sdk.directory })
    if (result.ok) {
      setControlError(null)
      setChainDismissed(false)
    } else {
      setControlError(result.error)
    }
    try {
      await refreshGoalSurfaces({ templates: result.ok && label === "template" })
    } finally {
      setBusy(null)
      if (result.ok) setConfirmingClear(false)
    }
    return result.ok
  }

  const runAction = async (action: GoalAction) => {
    const sent = await sendGoalCommand(action, action)
    if (!sent) return false
    if (props.sessionID && (action === "restart" || action === "resume")) {
      const expectedGoalID = state()?.id
      const prompted = await startGoalRunGuarded(sdk.client, {
        sessionID: props.sessionID,
        directory: sdk.directory,
      }, promptAdmissionGuard(expectedGoalID))
      if (!prompted.ok && prompted.reason === "delivery-failed") {
        setOptimisticStatus("paused")
        await sendGoalCommand("pause", "pause")
        return false
      }
      if (!prompted.ok) return false
    }
    return true
  }

  /** Hard pause: pause the goal AND abort the in-flight turn so the chat stops
   *  immediately, while leaving the goal resumable. */
  const pauseGoal = async () => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return false
    invalidatePromptAdmissions()
    setBusy("pause")
    const pendingPromptWarning = interruptionWarningText("pause")
    const result = await pauseGoalRun(sdk.client, {
      sessionID,
      directory: sdk.directory,
      abortActiveTurn: true,
    })
    if (result.ok) {
      setControlError(goalControlMessage("warning" in result && typeof result.warning === "string" ? result.warning : null, pendingPromptWarning))
    } else {
      setControlError(result.error)
    }
    try {
      await refreshGoalSurfaces()
    } finally {
      setBusy(null)
    }
    return result.ok
  }

  const stopGoal = async () => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return false
    invalidatePromptAdmissions()
    setBusy("clear")
    const pendingPromptWarning = interruptionWarningText("stop")
    const result = await stopGoalRun(sdk.client, {
      sessionID,
      directory: sdk.directory,
      abortActiveTurn: true,
    })
    if (result.ok) {
      setControlError(goalControlMessage("warning" in result && typeof result.warning === "string" ? result.warning : null, pendingPromptWarning))
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

  const resetGoalState = async () => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return false
    invalidatePromptAdmissions()
    setBusy("fresh")
    const result = await resetGoalWorkspaceState(sdk.client, {
      sessionID,
      directory: sdk.directory,
    })
    if (result.ok) {
      setControlError(null)
      setOptimisticStatus(null)
      setConfirmingClear(false)
      setChain(null)
      setChainDismissed(false)
      setActivity([])
      // AG-P0-04 — explicit reset clears the draft intentionally; mark
      // `source: "draft"` so the empty state survives any later recovery
      // attempt from a runtime chain.
      setChainDraft("source", "draft")
      setChainDraft("steps", [])
      setChainDraft("objective", "")
      setChainErrors([])
      setNewCommand("")
      setHandoff({ handoff: null, corrupt: false, loaded: true })
    } else {
      setControlError(result.error)
    }
    try {
      await refreshGoalSurfaces()
    } finally {
      setBusy(null)
    }
    return result.ok
  }

  /** Create a goal from the main Goal field. Quotes are stripped so they can't
   *  break the `/goal set "<condition>"` quoting; the condition is required,
   *  the verify command optional. */
  const createGoal = async () => {
    const condition = chainDraft.objective.trim().replace(/"/g, "")
    if (!condition) return
    const command = newCommand().trim().replace(/"/g, "")
    const args = command ? `set "${condition}" --command "${command}"` : `set "${condition}"`
    const sent = await sendGoalCommand("set", args)
    if (sent) {
      if (props.sessionID) {
        const expectedGoalID = state()?.id
        const prompted = await startGoalRunGuarded(sdk.client, {
          sessionID: props.sessionID,
          directory: sdk.directory,
        }, promptAdmissionGuard(expectedGoalID))
        if (!prompted.ok && prompted.reason === "delivery-failed") await sendGoalCommand("pause", "pause")
      }
      setChainDraft("objective", "")
      setNewCommand("")
    }
  }

  /** Add a steering note: `/goal steer "<note>"`. The plugin shows it to the
   *  agent on the next nudge. */
  const steerGoal = async () => {
    const note = steerText().trim().replace(/"/g, "")
    if (!note) return
    const sent = await sendGoalCommand("steer", `steer "${note}"`)
    let promptAttempted = false
    let promptAdmitted = false
    if (sent) {
      if (props.sessionID) {
        promptAttempted = true
        const expectedGoalID = state()?.id
        const promptResult = await steerGoalRunGuarded(sdk.client, {
          sessionID: props.sessionID,
          directory: sdk.directory,
        }, note, promptAdmissionGuard(expectedGoalID))
        promptAdmitted = promptResult.ok
        if (!promptResult.ok && promptResult.reason === "delivery-failed") setControlError(language.t("session.goal.steer.failed"))
      }
      if (steerDraftDisposition({ commandSaved: sent, promptAttempted, promptAdmitted }) === "clear") {
        setSteerText("")
        setSteerOpen(false)
      }
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
    const pending = handoff().handoff
    if (!pending) return
    const sent = await sendGoalCommand("claim", "claim")
    if (!sent) return
    const prompt = structuredHandoffPrompt(pending)
    const slug = base64Encode(sdk.directory ?? "")
    setSessionHandoff(SessionStateKey.from(server.scope(), SessionRouteKey.fromRoute(slug)), { prompt, files: {} })
    const href = `/${slug}/session?prompt=${encodeURIComponent(prompt)}`
    navigate(href)
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
  const seedActionDraft = (template: GoalTemplateButton | undefined, vars: Record<string, string> = {}) => {
    const c = template?.constraints
    const draft = actionEditorDraftFromTemplate(template, vars)
    setActionDraft({
      sourceID: template?.id ?? "",
      id: template ? (template.builtin ? `${template.id}-custom` : template.id) : uniqueTemplateID("custom-action"),
      label: template?.label ?? "",
      prompt: draft.prompt,
      command: draft.command,
      turns: typeof c?.maxTurns === "number" ? c.maxTurns : 5,
      minutes: typeof c?.maxTimeMinutes === "number" ? c.maxTimeMinutes : 20,
      category: template ? inferActionCategory(template) : "Custom",
      tone: template?.tone ?? inferredActionTone(template ?? {}),
      elevation: template?.elevation ?? "flat",
      agent: template?.agent ?? "",
      skills: template?.skills ? [...template.skills] : [],
      model: modelKey(template?.model),
    })
  }
  const selectActionForView = (template: GoalTemplateButton) => {
    setEditingChainStepID(null)
    setSelectedTemplateID(template.id)
    const vars = templateVariableDefaults(template)
    setTemplateVars(vars)
    seedActionDraft(template, vars)
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
    const scope = chainDraft.objective.trim()
    return {
      ...defaults,
      ...templateVars(),
      ...(scope && template.variables?.scope ? { scope } : {}),
    }
  }
  // AG-P0-04 — every draft mutation flips `source` to `"draft"` so the
  // "intentionally empty after explicit clear" case is distinguishable
  // from "never touched". Centralize the flip in one helper rather than
  // scattering `setChainDraft("source", "draft")` calls.
  const markDraftTouched = () => {
    if (chainDraft.source !== "draft") setChainDraft("source", "draft");
  };

  const addActionToChain = (template: GoalTemplateButton, vars = varsForAction(template)) => {
    const step = chainStepFromTemplate(template, vars, `${template.id}-${Date.now()}-${chainDraft.steps.length}`)
    if (!step.condition.trim()) return
    markDraftTouched();
    setChainDraft("steps", chainDraft.steps.length, step)
  }
  const moveDraftStep = (from: number, to: number) => {
    if (to < 0 || to >= chainDraft.steps.length) return
    const next = [...chainDraft.steps]
    const [step] = next.splice(from, 1)
    if (!step) return
    next.splice(to, 0, step)
    markDraftTouched();
    setChainDraft("steps", next)
  }
  const removeDraftStep = (id: string, visibleSteps: GoalChainDraftStep[] = []) => {
    markDraftTouched();
    setChainDraft(
      "steps",
      removeVisibleDraftStep({
        draftSteps: chainDraft.steps,
        visibleSteps,
        source: chainDraft.source,
        stepID: id,
      }),
    )
  }
  const updateDraftStepBudget = (id: string, field: "maxTurns" | "maxTimeMinutes", raw: string) => {
    const index = chainDraft.steps.findIndex((step) => step.id === id)
    if (index === -1) return
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value)) return
    markDraftTouched();
    setChainDraft("steps", index, field, Math.max(1, value))
  }
  const updateMasterBudget = (field: "maxTurns" | "maxTimeMinutes", raw: string) => {
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value)) return
    markDraftTouched();
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
  const agentOptions = createMemo(() => agentRoutingOptions(sync.data.agent))
  const agentOptionsForDraft = createMemo(() => {
    const selected = actionDraft.agent.trim()
    if (!selected || agentOptions().some((option) => option.name === selected)) return agentOptions()
    return [
      {
        name: selected,
        mode: "primary" as const,
        label: selected,
        description: language.t("session.goal.template.savedPin"),
      },
      ...agentOptions(),
    ]
  })
  const modelLabelByKey = createMemo(() => new Map(modelOptionsForDraft().map((option) => [option.key, option.label])))
  const agentLabelByName = createMemo(() => new Map(agentOptionsForDraft().map((option) => [option.name, option.label])))
  const modelLabel = (model?: GoalTemplateModel) => {
    const key = modelKey(model)
    if (!key) return ""
    return modelLabelByKey().get(key) ?? (isGoalPinnedModel(model) ? `${model.providerID} / ${model.modelID}` : key)
  }
  const agentLabel = (agent?: string) => {
    const clean = agentNameForRuntime(agent)
    if (!clean) return ""
    return agentLabelByName().get(clean) ?? clean
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
    return language.t("session.goal.template.sessionDefaultModelFallback")
  }
  const sessionAgentLabel = () =>
    agentOptions().find((option) => option.mode === "primary")?.label ||
    language.t("session.goal.template.sessionDefaultAgent")
  const stepRuntime = (step: GoalChainDraftStep) =>
    chainStepRuntimeLabels({
      step,
      sessionAgentLabel: sessionAgentLabel(),
      sessionModelLabel: sessionModelLabel(),
      noPinnedSkillsLabel: language.t("session.goal.template.noPinnedSkills"),
      skillCountLabel: (count) => language.t("session.goal.template.skillCount", { count }),
      completionLabel: (key) => language.t(key),
      resolveAgentLabel: agentLabel,
      resolveModelLabel: modelLabel,
    })
  const stepRuntimeModelLabel = (step: GoalChainDraftStep) => stepRuntime(step).model
  const stepRuntimeAgentLabel = (step: GoalChainDraftStep) => stepRuntime(step).agent
  const stepRuntimeSkillLabel = (step: GoalChainDraftStep) => stepRuntime(step).skills
  const stepRuntimeCompletionLabel = (step: GoalChainDraftStep) => stepRuntime(step).completion
  const stepRuntimeTitle = (step: GoalChainDraftStep) => stepRuntime(step).title
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
      return [...current, clean].slice(0, ACTION_SKILL_LIMIT)
    })
  }
  const openActionEditor = (template?: GoalTemplateButton) => {
    setEditingChainStepID(null)
    if (!template) {
      setSelectedTemplateID(null)
      setTemplateVars({})
      seedActionDraft(undefined)
      return
    }
    const vars = templateVariableDefaults(template)
    setSelectedTemplateID(template.id)
    setTemplateVars(vars)
    seedActionDraft(template, vars)
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
    agent: step.agent ?? "",
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
  const actionDraftTemplate = (): GoalActionDraftTemplate =>
    actionDraftTemplateFromState(actionDraft, selectedTemplate())
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
      ...(template.agent ? { agent: template.agent } : {}),
      ...(template.skills && template.skills.length > 0 ? { skills: [...template.skills] } : {}),
      ...(template.model ? { model: template.model } : {}),
    }
  }
  const [saveError, setSaveError] = createSignal("")
  const actionEditorReasonText = (reason: ActionEditorDisabledReason | null) => {
    if (reason === "busy") return language.t("session.goal.template.disabled.busy")
    if (reason === "missing-session") return language.t("session.goal.template.disabled.missingSession")
    if (reason === "missing-prompt") return language.t("session.goal.template.disabled.missingPrompt")
    if (reason === "no-template") return language.t("session.goal.template.disabled.noTemplate")
    if (reason === "builtin-template") return language.t("session.goal.template.disabled.builtinTemplate")
    return ""
  }
  const skillPickerReasonText = (reason: SkillPickerDisabledReason | null) => {
    if (reason === "busy") return language.t("session.goal.template.disabled.busy")
    if (reason === "missing-session") return language.t("session.goal.template.disabled.missingSession")
    if (reason === "no-skills") return language.t("session.goal.template.skillPicker.noSkills")
    if (reason === "max-skills") return language.t("session.goal.template.skillPicker.maxSkills", { count: ACTION_SKILL_LIMIT })
    return ""
  }
  const saveActionControl = createMemo(() =>
    actionEditorControlState({
      control: "save",
      busy: busy() !== null,
      hasSession: !!props.sessionID,
      prompt: actionDraft.prompt,
      selectedTemplate: selectedTemplate(),
    }),
  )
  const duplicateActionControl = createMemo(() =>
    actionEditorControlState({
      control: "duplicate",
      busy: busy() !== null,
      hasSession: !!props.sessionID,
      prompt: actionDraft.prompt,
      selectedTemplate: selectedTemplate(),
    }),
  )
  const deleteActionControl = createMemo(() =>
    actionEditorControlState({
      control: "delete",
      busy: busy() !== null,
      hasSession: !!props.sessionID,
      prompt: actionDraft.prompt,
      selectedTemplate: selectedTemplate(),
    }),
  )
  const addSkillControl = createMemo(() =>
    skillPickerControlState({
      busy: busy() !== null,
      hasSession: !!props.sessionID,
      availableSkillCount: skillPickOptions().length,
      selectedSkillCount: actionDraft.skills.length,
      maxSkills: ACTION_SKILL_LIMIT,
    }),
  )
  const addSkillStatus = createMemo(() => {
    const reason = addSkillControl().reason
    if (reason === "max-skills") return skillPickerReasonText(reason)
    if (reason === "no-skills" && skillOptionsForDraft().length > 0) return skillPickerReasonText(reason)
    return ""
  })
  const actionEditorStatus = createMemo(() => {
    if (saveError()) return saveError()
    const saveReason = saveActionControl().reason
    if (saveReason) return actionEditorReasonText(saveReason)
    const duplicateReason = duplicateActionControl().reason
    if (duplicateReason) return actionEditorReasonText(duplicateReason)
    const deleteReason = deleteActionControl().reason
    if (deleteReason === "no-template") return ""
    if (deleteReason) return actionEditorReasonText(deleteReason)
    return ""
  })
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
      setSaveError(language.t("session.goal.template.saveFailed"))
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
    if (template.builtin) {
      removeLocalTemplate(template.id)
      const next = templates().find((candidate) => candidate.id !== template.id)
      if (next) {
        selectActionForView(next)
      } else {
        openActionEditor()
      }
      setSaveError(language.t("session.goal.template.builtinHidden"))
      setTimeout(() => setSaveError(""), 4000)
      return
    }
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
    ...(template.agent ? { agent: template.agent } : {}),
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
    // A chain snapshot belongs to exactly one goal/session. If the current
    // session has no matching goal (new session, cleared goal from another
    // session, etc.), the snapshot is stale and must not leak into the runtime
    // chain or the chain builder display.
    if (!chainMatchesGoal(runningChain, s)) return []
    // A cleared goal's chain is dead — the user explicitly killed the run.
    // Don't render the abandoned chain as if it's still executing; let the
    // chain pane fall through to the draft/empty state so the user can
    // start fresh. (`achieved` is intentionally allowed so the user briefly
    // sees the completion checkmarks before chain auto-advance replaces
    // the state.)
    if (s && s.status === "cleared") return []
    return runningChain.steps.map((step, index) => {
      const agent = agentNameForRuntime(step.agent)
      const skills = Array.isArray(step.skills)
        ? [...new Set(step.skills.map((skill) => cleanText(skill).trim().slice(0, 80)).filter(Boolean))].slice(0, 8)
        : []
      const model = templateModelFromSnapshot(step.model)
      return {
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
        ...(agent ? { agent } : {}),
        ...(skills.length > 0 ? { skills } : {}),
        ...(model ? { model } : {}),
      }
    })
  }
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
  const pendingHandoffMode = createMemo(() => handoffPanelMode(liveGoal(), handoff()))
  const terminalGoal = createMemo(() => terminalGoalOf(state()))
  const runnableChainSteps = () => {
    if (liveGoal()) return []
    // AG-P0-04 — pass `source` so the selector knows whether the empty
    // draft is "uninitialized → recoverable" or "explicitly cleared →
    // must remain empty". This is the central fix for the "last X
    // revives the whole list" sequence.
    return selectRunnableChainSteps(chainDraft.steps, chainSnapshotSteps(), chainDraft.source)
  }
  // What a step's condition will actually run as, given the current objective.
  const stepConditionPreview = (step: GoalChainDraftStep) =>
    resolveStepConditionWithObjective(step, chainDraft.objective)
  const chainStartControl = createMemo(() =>
    chainStartControlState({
      busy: busy() !== null,
      hasLiveGoal: !!liveGoal(),
      hasSession: !!props.sessionID,
    }),
  )
  const chainStartTitle = () => {
    switch (chainStartControl().reason) {
      case "busy":
        return language.t("session.goal.template.disabled.busy")
      case "live-goal":
        return chainRunStateSubtitle()
      case "missing-session":
        return language.t("session.goal.chainBuilder.disabled.missingSession")
      default:
        return language.t("session.goal.chainBuilder.startTitle")
    }
  }
  const hasRunnableChain = () => runnableChainSteps().length > 0
  const primaryRunLabel = () => {
    if (liveGoal()) return language.t("session.goal.chainBuilder.runningButton")
    if (hasRunnableChain()) return language.t("session.goal.chainBuilder.start")
    // Empty single-goal input: read as "waiting for you" rather than a dead button.
    if (props.sessionID && busy() === null && !chainDraft.objective.trim())
      return language.t("session.goal.create.waiting")
    return language.t("session.goal.create.submit")
  }
  const primaryRunDisabled = () => {
    if (hasRunnableChain()) return chainStartControl().disabled
    return busy() !== null || !!liveGoal() || !props.sessionID || !chainDraft.objective.trim()
  }
  const primaryRunTitle = () => {
    if (hasRunnableChain()) return chainStartTitle()
    if (busy() !== null) return language.t("session.goal.template.disabled.busy")
    if (liveGoal()) return chainRunStateSubtitle()
    if (!props.sessionID) return language.t("session.goal.chainBuilder.disabled.missingSession")
    return language.t("session.goal.create.quickHint")
  }
  const startGoalOrChain = async () => {
    if (hasRunnableChain()) return startGoalChain()
    setChainErrors([])
    return createGoal()
  }
  const startGoalChain = async () => {
    const steps = runnableChainSteps()
    const errors = validateChainDraft(steps, {
      maxTurns: chainDraft.master.maxTurns,
      maxTimeMinutes: chainDraft.master.maxTimeMinutes,
    })
    setChainErrors(errors)
    if (errors.length > 0) return
    const startPayload = chainStartPayload(steps, chainDraft.master, chainDraft.objective)
    const sent = await sendGoalCommand("chain", `chain start-json ${startPayload.payload}`)
    if (sent) {
      if (props.sessionID) {
        const expectedGoalID = state()?.id
        const prompted = await startGoalRunGuarded(sdk.client, {
          sessionID: props.sessionID,
          directory: sdk.directory,
          ...(startPayload.firstStepAgent ? { agent: startPayload.firstStepAgent } : {}),
          ...(startPayload.firstStepModel ? { model: startPayload.firstStepModel } : {}),
          ...(startPayload.firstStepSkills && startPayload.firstStepSkills.length > 0
            ? { skills: startPayload.firstStepSkills }
            : {}),
        }, promptAdmissionGuard(expectedGoalID))
        if (!prompted.ok && prompted.reason === "delivery-failed") await sendGoalCommand("pause", "pause")
      }
    }
  }

  // 1-second elapsed ticker for live display (independent of 2s poll)
  const [elapsedTick, setElapsedTick] = createSignal(Date.now())
  const hasLiveGoal = createMemo(() => !!liveGoal())
  let elapsedTickTimer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    clearInterval(elapsedTickTimer)
    if (hasLiveGoal()) {
      elapsedTickTimer = setInterval(() => setElapsedTick(Date.now()), 1000)
    }
  })
  onCleanup(() => clearInterval(elapsedTickTimer))

  const progressElapsed = createMemo(() => {
    const s = state()
    if (!s) return 0
    return Math.max(0, (s.completedAt ?? (hasLiveGoal() ? elapsedTick() : now())) - s.startedAt)
  })

  const progressPct = createMemo(() => {
    const s = state()
    if (!s) return 0
    const turnsPct = s.constraints.maxTurns > 0
      ? Math.round((s.turnsEvaluated / s.constraints.maxTurns) * 100)
      : 0
    const timePct = s.constraints.maxTimeMinutes > 0
      ? Math.round((progressElapsed() / (s.constraints.maxTimeMinutes * 60_000)) * 100)
      : 0
    const tokenPct = s.constraints.maxTokens > 0
      ? Math.round((s.tokensUsed / s.constraints.maxTokens) * 100)
      : 0
    return Math.min(100, Math.max(turnsPct, timePct, tokenPct))
  })

  const progressDriver = createMemo<"turns" | "time" | "tokens" | null>(() => {
    const s = state()
    if (!s) return null
    const turnsPct = s.constraints.maxTurns > 0
      ? (s.turnsEvaluated / s.constraints.maxTurns) * 100 : 0
    const timePct = s.constraints.maxTimeMinutes > 0
      ? (progressElapsed() / (s.constraints.maxTimeMinutes * 60_000)) * 100 : 0
    const tokenPct = s.constraints.maxTokens > 0
      ? (s.tokensUsed / s.constraints.maxTokens) * 100 : 0
    if (tokenPct > timePct && tokenPct > turnsPct) return "tokens"
    return timePct > turnsPct ? "time" : "turns"
  })

  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
  }

  const burndownColor = (used: number, max: number): string => {
    if (max <= 0) return "rgb(134, 239, 172)"
    const pct = used / max
    if (pct >= 0.9) return "rgb(248, 113, 113)"
    if (pct >= 0.7) return "rgb(251, 191, 36)"
    return "rgb(134, 239, 172)"
  }

  const burndownPct = (used: number, max: number): number =>
    max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0

  const elapsedMs = createMemo(() => {
    const s = state()
    if (!s) return 0
    const end = s.completedAt ?? (hasLiveGoal() ? elapsedTick() : now())
    return Math.max(0, end - s.startedAt)
  })

  const elapsedMinutes = createMemo(() => Math.round(elapsedMs() / 60_000))

  const elapsedFormatted = createMemo(() => {
    const ms = elapsedMs()
    if (ms <= 0) return "0:00"
    const totalSec = Math.round(ms / 1000)
    const m = Math.floor(totalSec / 60)
    const sec = totalSec % 60
    return `${m}:${sec.toString().padStart(2, "0")}`
  })

  const lastEval = createMemo(() => state()?.lastEvaluation ?? null)
  const evalHistory = createMemo(() => state()?.evaluationHistory ?? [])
  const steeringNotes = createMemo((): Array<{ at: number; note: string }> => {
    const raw = state()?.metadata?.steering
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (item): item is { at: number; note: string } =>
        !!item && typeof item === "object" && typeof (item as { at?: unknown }).at === "number" && typeof (item as { note?: unknown }).note === "string",
    )
  })

  const confidencePct = createMemo(() => {
    const e = lastEval()
    return e && typeof e.confidence === "number" ? Math.round(e.confidence * 100) : null
  })

  const confidenceColor = (pct: number): string => {
    if (pct >= 80) return "rgb(134, 239, 172)"
    if (pct >= 50) return "rgb(251, 191, 36)"
    return "rgb(248, 113, 113)"
  }

  const [evidenceExpanded, setEvidenceExpanded] = createSignal(false)

  const turnVelocity = createMemo(() => {
    const s = state()
    if (!s || s.turnsEvaluated < 1) return null
    const mins = elapsedMs() / 60_000
    if (mins < 0.1) return null
    return s.turnsEvaluated / mins
  })

  const etaFormatted = createMemo<string | null>(() => {
    const s = state()
    const v = turnVelocity()
    if (!s || !v || v <= 0 || !hasLiveGoal()) return null
    const remaining = s.constraints.maxTurns - s.turnsEvaluated
    if (remaining <= 0) return null
    const etaMin = remaining / v
    if (etaMin < 1) return "<1m"
    if (etaMin >= 60) return `~${Math.round(etaMin / 60)}h`
    return `~${Math.round(etaMin)}m`
  })

  const sparklinePoints = createMemo(() => {
    const h = evalHistory()
    if (h.length < 2) return null
    const points = h
      .map((e) => (typeof e.confidence === "number" ? e.confidence : null))
      .filter((v): v is number => v !== null)
    if (points.length < 2) return null
    const w = 64
    const ht = 16
    const pad = 1.5
    const step = w / (points.length - 1)
    return points.map((p, i) => `${(i * step).toFixed(1)},${(pad + (1 - p) * (ht - 2 * pad)).toFixed(1)}`).join(" ")
  })

  const [reportCopied, setReportCopied] = createSignal(false)

  const copyGoalReport = () => {
    const s = state()
    if (!s) return
    const lines: string[] = []
    lines.push(`## Goal Report`)
    lines.push(`**Condition:** ${cleanText(s.condition)}`)
    lines.push(`**Status:** ${s.status}`)
    lines.push(`**Turns:** ${s.turnsEvaluated}/${s.constraints.maxTurns}`)
    lines.push(`**Time:** ${elapsedFormatted()}/${s.constraints.maxTimeMinutes}m`)
    lines.push(`**Tokens:** ${formatTokens(s.tokensUsed)}/${formatTokens(s.constraints.maxTokens)}`)
    lines.push(`**Progress:** ${progressPct()}%`)
    const v = turnVelocity()
    if (v !== null) lines.push(`**Velocity:** ${v.toFixed(1)} turns/min`)
    const eta = etaFormatted()
    if (eta) lines.push(`**ETA:** ${eta}`)
    const eff = tokenEfficiency()
    if (eff !== null) lines.push(`**Token Efficiency:** ${formatTokens(eff)} tok/turn`)
    const burn = tokenBurnRate()
    if (burn !== null) lines.push(`**Token Burn Rate:** ${formatTokens(burn)} tok/min`)
    const peak = bestConfidence()
    if (peak !== null) lines.push(`**Peak Confidence:** ${peak}%`)
    const delta = confidenceDelta()
    if (delta !== null) lines.push(`**Confidence Delta:** ${delta > 0 ? "+" : ""}${delta}%`)
    const health = goalHealth()
    if (health) lines.push(`**Health:** ${health.label} (${health.score}/100)`)
    const sr = evalSuccessRate()
    if (sr !== null) lines.push(`**Success Rate:** ${sr}%`)
    const streak = evalStreak()
    if (streak) lines.push(`**Streak:** ${streak.count}× ${streak.type === "met" ? "met" : "not met"}`)
    const vol = confidenceVolatility()
    if (vol) lines.push(`**Volatility:** ${vol}`)
    const avgCy = avgCycleTime()
    if (avgCy !== null) lines.push(`**Avg Cycle Time:** ${formatCycleDuration(avgCy)}`)
    const tokForecast = tokenExhaustForecast()
    if (tokForecast) lines.push(`**Token Exhaustion:** ${tokForecast}`)
    if (s.lastEvaluation) {
      lines.push(``)
      lines.push(`### Last Evaluation`)
      lines.push(`- **Met:** ${s.lastEvaluation.met ? "Yes" : "No"}`)
      lines.push(`- **Reason:** ${cleanText(s.lastEvaluation.reason)}`)
      if (typeof s.lastEvaluation.confidence === "number")
        lines.push(`- **Confidence:** ${Math.round(s.lastEvaluation.confidence * 100)}%`)
      lines.push(`- **Evaluator:** ${s.lastEvaluation.evaluatorType}`)
      if (s.lastEvaluation.blocked) lines.push(`- **Blocked:** Yes`)
    }
    if (s.evaluationHistory.length > 0) {
      lines.push(``)
      lines.push(`### Evaluation History (${s.evaluationHistory.length} cycles)`)
      for (const cycle of s.evaluationHistory) {
        const conf = typeof cycle.confidence === "number" ? ` (${Math.round(cycle.confidence * 100)}%)` : ""
        lines.push(`- ${cycle.met ? "✓" : "✗"} ${cleanText(cycle.reason)}${conf}`)
      }
    }
    void navigator.clipboard.writeText(lines.join("\n"))
      .then(() => {
        setReportCopied(true)
        setTimeout(() => setReportCopied(false), 2000)
      })
      .catch(ignoreRefreshError("clipboard.writeText (report)"))
  }

  const isCritical = (used: number, max: number): boolean => max > 0 && used / max >= 0.9

  const confidenceTrend = createMemo<"up" | "down" | "flat" | null>(() => {
    const h = evalHistory()
    if (h.length < 2) return null
    const window = h.slice(-4)
    const confs = window.map((e) => e.confidence).filter((v): v is number => typeof v === "number")
    if (confs.length < 2) return null
    const first = confs.slice(0, Math.ceil(confs.length / 2))
    const second = confs.slice(Math.ceil(confs.length / 2))
    const avgFirst = first.reduce((a, b) => a + b, 0) / first.length
    const avgSecond = second.reduce((a, b) => a + b, 0) / second.length
    if (avgSecond > avgFirst + 0.02) return "up"
    if (avgSecond < avgFirst - 0.02) return "down"
    return "flat"
  })

  const trendArrow = (trend: "up" | "down" | "flat"): string =>
    trend === "up" ? "↗" : trend === "down" ? "↘" : "→"

  const trendColor = (trend: "up" | "down" | "flat"): string =>
    trend === "up" ? "rgb(134, 239, 172)" : trend === "down" ? "rgb(248, 113, 113)" : "rgb(148, 163, 184)"

  const goalHealth = createMemo<{ score: number; label: string; color: string } | null>(() => {
    const s = state()
    if (!s || !hasLiveGoal()) return null
    if (s.lastEvaluation?.blocked) return { score: 15, label: "At risk", color: "rgb(248, 113, 113)" }
    const turnHead = s.constraints.maxTurns > 0
      ? 1 - s.turnsEvaluated / s.constraints.maxTurns : 1
    const timeHead = s.constraints.maxTimeMinutes > 0
      ? 1 - (elapsedMs() / 60_000) / s.constraints.maxTimeMinutes : 1
    const tokenHead = s.constraints.maxTokens > 0
      ? 1 - s.tokensUsed / s.constraints.maxTokens : 1
    const headroom = Math.min(turnHead, timeHead, tokenHead)
    const conf = typeof s.lastEvaluation?.confidence === "number" ? s.lastEvaluation.confidence : 0.5
    const trend = confidenceTrend()
    const trendBonus = trend === "up" ? 0.1 : trend === "down" ? -0.1 : 0
    const score = Math.max(0, Math.min(100, Math.round(
      headroom * 50 + (conf + trendBonus) * 40 + (turnVelocity() !== null && turnVelocity()! > 0 ? 10 : 0),
    )))
    if (score >= 60) return { score, label: "Healthy", color: "rgb(134, 239, 172)" }
    if (score >= 35) return { score, label: "Fair", color: "rgb(251, 191, 36)" }
    return { score, label: "At risk", color: "rgb(248, 113, 113)" }
  })

  const evalCycleDurations = createMemo(() => {
    const h = evalHistory()
    if (h.length < 2) return []
    return h.map((cycle, i) => {
      if (i === 0) return null
      const prev = h[i - 1]
      if (!prev) return null
      const delta = cycle.timestamp - prev.timestamp
      return delta > 0 ? delta : null
    })
  })

  const formatCycleDuration = (ms: number): string => {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`
    return `${(ms / 60_000).toFixed(1)}m`
  }

  const elapsedSinceLastEval = createMemo<number | null>(() => {
    const e = lastEval()
    if (!e || !hasLiveGoal()) return null
    return Math.max(0, now() - e.timestamp)
  })

  const formatSinceEval = (ms: number): string => {
    if (ms < 90_000) return `${Math.round(ms / 1000)}s ago`
    return `${Math.round(ms / 60_000)}m ago`
  }

  const tokenEfficiency = createMemo<number | null>(() => {
    const s = state()
    if (!s || s.turnsEvaluated < 1) return null
    return Math.round(s.tokensUsed / s.turnsEvaluated)
  })

  const tokenBurnRate = createMemo<number | null>(() => {
    const s = state()
    if (!s || !hasLiveGoal()) return null
    const mins = elapsedMs() / 60_000
    if (mins < 0.1) return null
    return Math.round(s.tokensUsed / mins)
  })

  const confidenceDelta = createMemo<number | null>(() => {
    const h = evalHistory()
    if (h.length < 2) return null
    const a = h[h.length - 2]?.confidence
    const b = h[h.length - 1]?.confidence
    if (typeof a !== "number" || typeof b !== "number") return null
    return Math.round((b - a) * 100)
  })

  const bestConfidence = createMemo<number | null>(() => {
    const h = evalHistory()
    if (h.length === 0) return null
    let best = -1
    for (const e of h) {
      if (typeof e.confidence === "number" && e.confidence > best) best = e.confidence
    }
    return best >= 0 ? Math.round(best * 100) : null
  })

  const liveRunStatus = createMemo<GoalState["status"] | null>(() => optimisticStatus() ?? liveGoal()?.status ?? null)
  const latestActivityAt = createMemo(() => activity()[0]?.at ?? null)
  const liveRunStalled = createMemo(() => isGoalStalled(liveRunStatus() ?? undefined, latestActivityAt(), now()))
  const liveRunIdleMinutes = createMemo(() => goalIdleMinutes(latestActivityAt(), now()))

  const smartStatus = createMemo<string | null>(() => {
    const s = state()
    if (!s || !hasLiveGoal()) return null
    if (s.lastEvaluation?.blocked) return language.t("session.goal.smart.blocked")
    if (liveRunStalled()) return language.t("session.goal.smart.stalled")
    if (s.status === "paused") return language.t("session.goal.smart.paused")
    const turnRatio = s.constraints.maxTurns > 0 ? s.turnsEvaluated / s.constraints.maxTurns : 0
    const timeRatio = s.constraints.maxTimeMinutes > 0 ? (elapsedMs() / 60_000) / s.constraints.maxTimeMinutes : 0
    const tokenRatio = s.constraints.maxTokens > 0 ? s.tokensUsed / s.constraints.maxTokens : 0
    if (turnRatio >= 0.9 || timeRatio >= 0.9 || tokenRatio >= 0.9) return language.t("session.goal.smart.critical")
    const trend = confidenceTrend()
    if (trend === "down") return language.t("session.goal.smart.declining")
    if (trend === "up") return language.t("session.goal.smart.improving")
    if (s.turnsEvaluated === 0) return language.t("session.goal.smart.starting")
    return language.t("session.goal.smart.running")
  })

  const isBlocked = createMemo(() => !!state()?.lastEvaluation?.blocked && hasLiveGoal())

  const evalSuccessRate = createMemo<number | null>(() => {
    const h = evalHistory()
    if (h.length < 2) return null
    const met = h.filter((e) => e.met).length
    return Math.round((met / h.length) * 100)
  })

  const evalStreak = createMemo<{ count: number; type: "met" | "notMet" } | null>(() => {
    const h = evalHistory()
    if (h.length < 2) return null
    const last = h[h.length - 1]
    if (!last) return null
    const target = last.met
    let count = 0
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i]!.met === target) count++
      else break
    }
    if (count < 2) return null
    return { count, type: target ? "met" : "notMet" }
  })

  const formatForecastMins = (minsLeft: number): string =>
    minsLeft < 1 ? "<1m" : minsLeft >= 60 ? `~${Math.round(minsLeft / 60)}h` : `~${Math.round(minsLeft)}m`

  const tokenExhaustForecast = createMemo<string | null>(() => {
    const s = state()
    if (!s || !hasLiveGoal()) return null
    const mins = elapsedMs() / 60_000
    if (mins < 0.1 || s.tokensUsed <= 0 || s.constraints.maxTokens <= 0) return null
    const remaining = s.constraints.maxTokens - s.tokensUsed
    if (remaining <= 0) return null
    const rate = s.tokensUsed / mins
    return rate > 0 ? formatForecastMins(remaining / rate) : null
  })

  const confidenceVolatility = createMemo<"low" | "med" | "high" | null>(() => {
    const h = evalHistory()
    const confs = h.map((e) => e.confidence).filter((v): v is number => typeof v === "number")
    if (confs.length < 3) return null
    const mean = confs.reduce((a, b) => a + b, 0) / confs.length
    const variance = confs.reduce((sum, c) => sum + (c - mean) ** 2, 0) / confs.length
    const stddev = Math.sqrt(variance)
    if (stddev < 0.05) return "low"
    if (stddev < 0.15) return "med"
    return "high"
  })
  const volatilityColor = (v: "low" | "med" | "high"): string =>
    v === "low" ? "rgb(134, 239, 172)" : v === "med" ? "rgb(251, 191, 36)" : "rgb(248, 113, 113)"

  const avgCycleTime = createMemo<number | null>(() => {
    const durations = evalCycleDurations()
    const valid = durations.filter((d): d is number => typeof d === "number" && d > 0)
    if (valid.length === 0) return null
    return valid.reduce((a, b) => a + b, 0) / valid.length
  })

  const constraintHeadroom = createMemo(() => {
    const s = state()
    if (!s || !hasLiveGoal()) return null
    const turns = s.constraints.maxTurns > 0 ? Math.max(0, s.constraints.maxTurns - s.turnsEvaluated) : null
    const timeMins = s.constraints.maxTimeMinutes > 0 ? Math.max(0, s.constraints.maxTimeMinutes - elapsedMs() / 60_000) : null
    const tokens = s.constraints.maxTokens > 0 ? Math.max(0, s.constraints.maxTokens - s.tokensUsed) : null
    if (turns === null && timeMins === null && tokens === null) return null
    return { turns, timeMins, tokens }
  })

  const [shortcutHelpOpen, setShortcutHelpOpen] = createSignal(false)

  const selectedHistoryRun = createMemo(
    () => archive().find((run) => run.summary.goalID === selectedHistoryGoalID()) ?? null,
  )

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

  const visibleChainSteps = createMemo<GoalChainDraftStep[]>(() => {
    const live = liveGoal()
    const runningChain = chain()
    if (runningChain) {
      const snapshot = chainSnapshotSteps()
      if (!live) {
        const selected = selectRunnableChainSteps(chainDraft.steps, snapshot, chainDraft.source)
        if (selected.length > 0 || chainDraft.source === "draft") return selected
      }
      if (live && snapshot.length > 0) return snapshot
    }
    if (!live && chainDraft.steps.length > 0) return chainDraft.steps
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
  const visibleChainStepSource = createMemo<ChainStepVisibleSource>(() =>
    chainStepVisibleSourceForState({
      hasLiveGoal: !!liveGoal(),
      hasTerminalGoal: !!terminalGoal(),
      hasChainSnapshot: chainSnapshotSteps().length > 0,
      draftSource: chainDraft.source,
      hasDraftSteps: chainDraft.steps.length > 0,
    }),
  )
  const visibleChainRowsAreDraft = createMemo(() => visibleChainStepSource() === "draft")
  const chainStepRemoveDisabled = (index: number) =>
    busy() !== null || (visibleChainStepSource() === "live" && index <= runningStepIndex())
  const chainStepRemoveLabel = (index: number) => {
    if (visibleChainStepSource() === "live" && index <= runningStepIndex()) {
      return language.t("session.goal.chainBuilder.stepRemoveLocked")
    }
    if (visibleChainStepSource() === "terminal-history") {
      return language.t("session.goal.chainBuilder.stepRemove")
    }
    return language.t(
      visibleChainStepSource() === "live"
        ? "session.goal.chainBuilder.stepRemovePending"
        : "session.goal.chainBuilder.stepRemove",
    )
  }
  const runningStepIndex = createMemo(() => {
    if (!liveGoal()) return -1
    const runningChain = chain()
    if (runningChain && chainSnapshotSteps().length > 0)
      return Math.max(0, Math.min(runningChain.current, Math.max(0, runningChain.steps.length - 1)))
    return visibleStepCount() > 0 ? 0 : -1
  })
  const runningStep = createMemo(() => {
    const index = runningStepIndex()
    if (index < 0) return
    return visibleChainSteps()[index]
  })
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
    // v0.7.3 / audit June 2026 — terminal-state escape hatch.
    // The default guard below blocks deletion of "running or done"
    // steps because the engine may still be driving them. But
    // when the live run is in a terminal state (achieved /
    // cleared) the engine is no longer driving the run — the
    // chain isn't going to advance, and the user should be able
    // to clear leftover steps from a previous run. The chain
    // file's `current` index is the last ADVANCED step, not the
    // last ACHIEVED step, so a chain whose step 0 was achieved
    // but never advanced can still have `current === 0` and
    // block the user from deleting step 0.
    const liveStatus = liveRunStatus();
    if (index <= runningStepIndex() && liveStatus !== "achieved" && liveStatus !== "cleared") {
      return false;
    }
    return sendGoalCommand("chain", `chain remove ${index + 1}`)
  }
  // AG-P1-05 — every X button routes by visible-source metadata, not
  // by `liveGoal()` as a proxy. The pure selector `chainStepVisibleAction`
  // decides the action kind from (source, run-state); this function
  // dispatches on the returned kind. Callers MUST pass an explicit
  // `source` matching the data the user is actually viewing on the row.
  const removeVisibleStep = (
    step: GoalChainDraftStep,
    index: number,
    source: ChainStepVisibleSource,
  ) => {
    const action = chainStepVisibleAction({
      source,
      stepID: step.id,
      index,
      runningStepIndex: runningStepIndex(),
      liveRunStatus: liveRunStatus(),
    });
    switch (action.kind) {
      case "edit-draft":
        removeDraftStep(step.id, visibleChainSteps());
        return;
      case "remove-live-pending":
        if (!liveGoal() && !terminalGoal()) {
          // v0.7.3 / scan 2026-06-25 (D-NEW-3) — no live or terminal chain
          // means there's nothing to remove. Pre-fix the handler did
          // `setChainDismissed(true); setChain(null)` here, which
          // silently dismissed the entire chain panel — a UX
          // regression masquerading as a noop. Correct behavior:
          // silent noop. Terminal goals are allowed through so completed
          // chain rows can be cleaned up instead of becoming inert.
          return
        }
        return void removeLiveChainStep(action.index);
      case "remove-terminal-chain-step":
        if (liveGoal() || !terminalGoal()) {
          // Terminal cleanup must never mutate the current live chain. If a
          // live run appeared between render and click, fall back to dismissing
          // the stale terminal affordance only.
          const tGoal = terminalGoal();
          if (tGoal) {
            setDismissedTerminalGoalIDs("ids", (prev) =>
              prev.includes(tGoal.id) ? prev : [...prev, tGoal.id],
            );
          }
          return;
        }
        return void removeLiveChainStep(action.index);
      case "dismiss-terminal":
        // v0.7.3 / G-2 — record the dismissed terminal goal's id
        // so unarchivedTerminalGoal hides it. Do NOT null the
        // chain — the terminal goal is still meaningful for the
        // archive polling and history panel; the user is just
        // acknowledging the "still needs archiving" prompt.
        const tGoal = terminalGoal();
        if (tGoal) {
          setDismissedTerminalGoalIDs("ids", (prev) =>
            prev.includes(tGoal.id) ? prev : [...prev, tGoal.id],
          );
        }
        return;
      case "noop":
        return;
    }
  }
  const unarchivedTerminalGoal = createMemo(() => {
    const goal = terminalGoal()
    if (!goal) return null
    if (archive().some((run) => run.summary.goalID === goal.id)) return null
    // v0.7.3 / G-2 — hide terminal goals the user has dismissed.
    // The goal remains in the on-disk archive; this just hides it
    // from the in-panel "still needs archiving" view.
    if (dismissedTerminalGoalIDs.ids.includes(goal.id)) return null
    return goal
  })

  // The pause/resume toggle's next action, honoring the optimistic override.
  const pauseResume = createMemo(() => pauseResumeAction(state()?.status, optimisticStatus()))
  const runtimeDetailState = createMemo<"ready" | "stop" | "steer" | "handoff">(() => {
    if (confirmingClear()) return "stop"
    if (steerOpen()) return "steer"
    if (handoffOpen()) return "handoff"
    return "ready"
  })
  const runtimeCanInteract = createMemo(() => !!liveGoal() && state()?.status !== "achieved" && state()?.status !== "cleared")
  const runtimeCanRestart = createMemo(() => !!liveGoal() && (state()?.status === "paused" || liveRunStalled()))
  const openRuntimePanel = (panel: "stop" | "steer" | "handoff") => {
    setConfirmingClear(panel === "stop")
    setSteerOpen(panel === "steer")
    setHandoffOpen(panel === "handoff")
  }
  const closeRuntimePanel = () => {
    setConfirmingClear(false)
    setSteerOpen(false)
    setHandoffOpen(false)
  }

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null
    if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return
    if (e.key === "Escape") {
      if (shortcutHelpOpen()) {
        e.preventDefault()
        setShortcutHelpOpen(false)
        return
      }
      if (confirmingClear() || steerOpen() || handoffOpen()) {
        e.preventDefault()
        closeRuntimePanel()
        return
      }
      if (confirmingReset()) {
        e.preventDefault()
        setConfirmingReset(false)
        return
      }
    }
    if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      setShortcutHelpOpen((v) => !v)
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p" && liveGoal() && busy() === null && props.sessionID) {
      e.preventDefault()
      const action = pauseResume()
      if (!action) return
      setOptimisticStatus(action === "pause" ? "paused" : "active")
      void (action === "pause" ? pauseGoal() : runAction("resume"))
        .then((ok) => { if (!ok) setOptimisticStatus(null) })
        .catch((err) => {
          setOptimisticStatus(null)
          ignoreRefreshError(`pauseResume shortcut (${action})`)(err)
        })
    }
  }
  onMount(() => document.addEventListener("keydown", handleGlobalKeyDown))
  onCleanup(() => document.removeEventListener("keydown", handleGlobalKeyDown))

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
    if (liveGoal()) return language.t("session.goal.chainBuilder.runningSubtitle")
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
    if (real === opt || real === "achieved" || real === "cleared") {
      setOptimisticStatus(null)
    }
  })

  const statusMeta = (s: GoalState["status"] | undefined) => statusMetaOf(s)
  const nodeColor = (status: string) => nodeColorOf(status)
  const outcomeLabel = (outcome: string) => outcomeLabelOf(outcome)

  return (
    <div class="flex flex-col gap-3 p-4 flex-1 min-h-0 overflow-y-auto" aria-label={language.t("session.tab.goal")}>
      <style>{`@keyframes goal-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }`}</style>
      <Show when={shortcutHelpOpen()}>
        <div
          data-component="goal-shortcut-overlay"
          class="absolute inset-0 z-50 flex items-center justify-center"
          style={{ "background-color": "rgba(0, 0, 0, 0.6)", "backdrop-filter": "blur(4px)" }}
          onClick={() => setShortcutHelpOpen(false)}
        >
          <div
            class="w-72 rounded-lg border p-4"
            style={{ "background-color": "rgba(15, 23, 42, 0.95)", "border-color": "rgba(148, 163, 184, 0.2)" }}
            onClick={(e: MouseEvent) => e.stopPropagation()}
          >
            <div class="mb-3 flex items-center justify-between">
              <span class="text-[12px] font-bold uppercase tracking-[0.08em] text-text-base">
                {language.t("session.goal.shortcuts.title")}
              </span>
              <button
                type="button"
                class="rounded-md px-1.5 py-0.5 text-[10px] text-text-weaker transition hover:bg-background-base/40 hover:text-text-weak"
                onClick={() => setShortcutHelpOpen(false)}
              >
                Esc
              </button>
            </div>
            <div class="grid gap-1.5">
              <div class="flex items-center justify-between gap-2 text-[11px]">
                <span class="text-text-weak">{language.t("session.goal.shortcuts.pauseResume")}</span>
                <kbd class="rounded-sm border border-slate-500/30 bg-slate-700/40 px-1.5 py-0.5 font-mono text-[10px] text-text-weaker">Ctrl+P</kbd>
              </div>
              <div class="flex items-center justify-between gap-2 text-[11px]">
                <span class="text-text-weak">{language.t("session.goal.shortcuts.closePanel")}</span>
                <kbd class="rounded-sm border border-slate-500/30 bg-slate-700/40 px-1.5 py-0.5 font-mono text-[10px] text-text-weaker">Esc</kbd>
              </div>
              <div class="flex items-center justify-between gap-2 text-[11px]">
                <span class="text-text-weak">{language.t("session.goal.shortcuts.showHelp")}</span>
                <kbd class="rounded-sm border border-slate-500/30 bg-slate-700/40 px-1.5 py-0.5 font-mono text-[10px] text-text-weaker">?</kbd>
              </div>
            </div>
          </div>
        </div>
      </Show>
      <Switch>
        <Match when={!props.goal.store.loaded}>
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak">
            {language.t("session.goal.loading")}
          </div>
        </Match>
        <Match when={props.goal.store.corrupt}>
          <div class="flex flex-col gap-2" data-component="goal-corrupt-banner">
            <div class="text-14-medium text-text-warning-base">⚠ {language.t("session.goal.error.corrupt")}</div>
            <div class="text-12-regular text-text-weak">{language.t("session.goal.error.corrupt.hint")}</div>
            <div class="flex" data-component="goal-corrupt-reset">
              <ActionButton
                label={language.t("session.goal.error.corrupt.reset")}
                tone="danger"
                variant="primary"
                busy={busy() === "fresh"}
                disabled={busy() !== null || !props.sessionID}
                onClick={async () => {
                  if (!props.sessionID || busy()) return
                  setBusy("fresh")
                  try {
                    const result = await resetGoalWorkspaceState(sdk.client, {
                      sessionID: props.sessionID,
                      directory: sdk.directory,
                    })
                    if (result.ok) {
                      setControlError(null)
                      await props.goal.refresh()
                    } else {
                      setControlError(result.error)
                    }
                  } finally {
                    setBusy(null)
                  }
                }}
              />
            </div>
          </div>
        </Match>
        <Match when={props.goal.store.loaded && !props.goal.store.corrupt}>
          <div data-component="goal-playbook-workspace" class="flex min-h-0 min-w-0 flex-col gap-3 pb-2">
            <div
              data-testid="chain-workspace"
              data-component="goal-chain-builder-workspace"
              class="grid min-h-0 min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))] items-stretch gap-3 overflow-x-hidden overflow-y-auto overscroll-contain"
            >
              <section
                data-testid="goal-status-card"
                data-component="goal-status-card"
                class={unarchivedTerminalGoal() ? "col-span-full h-fit" : "hidden"}
            >
            <Show when={unarchivedTerminalGoal()} keyed>
              {(terminal) => {
                const elapsedMs = (terminal.completedAt ?? Date.now()) - terminal.startedAt
                const elapsedLabel = formatElapsed(elapsedMs)
                const turns = terminal.turnsEvaluated
                const maxTurns = terminal.constraints.maxTurns
                const isAchieved = terminal.status === "achieved"
                const outcome = statusMeta(terminal.status)
                const tone = terminalOutcomeTone(terminal.status)
                return (
                  <GoalConsoleSection
                    zone="terminal-result"
                    accent={terminalResultAccent(terminal.status)}
                    title={language.t("session.goal.lastResult")}
                    subtitle={language.t(
                      isAchieved
                        ? "session.goal.terminal.subtitleAchieved"
                        : "session.goal.terminal.subtitleCleared",
                      { elapsed: elapsedLabel },
                    )}
                  >
                    <div
                      data-component="goal-terminal-result-banner"
                      role="status"
                      aria-live="polite"
                      class="flex h-full min-h-0 min-w-0 flex-col gap-0"
                      style={{
                        background: isAchieved
                          ? "linear-gradient(180deg, rgba(16,185,129,0.06) 0%, transparent 70%)"
                          : "linear-gradient(180deg, rgba(251,191,36,0.04) 0%, transparent 70%)",
                      }}
                    >
                      <div
                        class="flex min-w-0 items-center gap-2.5 rounded-t-lg px-3 py-2"
                        style={{
                          background: isAchieved
                            ? "linear-gradient(135deg, rgba(16,185,129,0.18) 0%, rgba(16,185,129,0.06) 60%, transparent 100%)"
                            : "linear-gradient(135deg, rgba(251,191,36,0.14) 0%, rgba(251,191,36,0.04) 60%, transparent 100%)",
                          "box-shadow": isAchieved
                            ? "inset 0 1px 0 rgba(110,231,183,0.15)"
                            : "inset 0 1px 0 rgba(251,191,36,0.12)",
                        }}
                      >
                        <span
                          data-component="goal-terminal-outcome-badge"
                          class={`inline-flex shrink-0 cursor-default select-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] ${tone.class}`}
                          style={tone.style}
                        >
                          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
                          {outcome.label}
                        </span>
                        <div
                          data-component="goal-terminal-summary"
                          class="flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 py-1"
                          style={{
                            "border-color": isAchieved ? "rgba(110,231,183,0.20)" : "rgba(251,191,36,0.18)",
                            background: isAchieved ? "rgba(16,185,129,0.06)" : "rgba(251,191,36,0.05)",
                          }}
                        >
                          <span class="shrink-0 text-[8px] font-bold uppercase tracking-[0.1em] text-text-weaker">GOAL</span>
                          <span class="truncate text-[13px] font-semibold leading-5 text-text-base" title={cleanText(terminal.condition)}>
                            {cleanText(terminal.condition)}
                          </span>
                        </div>
                        <Show when={terminal.lastEvaluation}>
                          {(finalEval) => (
                            <div data-component="goal-terminal-final-evidence" class="flex shrink-0 items-center gap-1.5">
                              <Show when={typeof finalEval().confidence === "number"}>
                                {(() => {
                                  const pct = () => Math.round((finalEval().confidence ?? 0) * 100)
                                  return (
                                    <span class="text-[12px] font-bold tabular-nums" style={{ color: confidenceColor(pct()) }}>
                                      {pct()}%
                                    </span>
                                  )
                                })()}
                              </Show>
                              <span
                                class={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] ${finalEval().met ? "bg-emerald-500/25 text-emerald-300" : "bg-amber-500/25 text-amber-300"}`}
                              >
                                <span class={`h-1.5 w-1.5 rounded-full ${finalEval().met ? "bg-emerald-400" : "bg-amber-400"}`} aria-hidden />
                                {finalEval().met ? language.t("session.goal.evidence.met") : language.t("session.goal.evidence.notMet")}
                              </span>
                            </div>
                          )}
                        </Show>
                      </div>
                      <div data-component="goal-terminal-banner-metrics" class="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-1.5 px-3 py-2">
                        <RunMetricPill
                          label={language.t("session.goal.history.turns")}
                          value={`${turns}/${maxTurns}`}
                          accent={metricAccent(maxTurns > 0 ? turns / maxTurns : 0)}
                        />
                        <RunMetricPill
                          label={language.t("session.goal.history.elapsed")}
                          value={elapsedLabel}
                          accent="hsl(190, 60%, 50%)"
                        />
                        <RunMetricPill
                          label={language.t("session.goal.metric.tokens")}
                          value={formatTokens(terminal.tokensUsed)}
                          accent={metricAccent(terminal.tokensUsed > 0 ? Math.min(1, terminal.tokensUsed / 50000) : 0)}
                        />
                        <RunMetricPill
                          label={language.t("session.goal.evidence.history")}
                          value={String(terminal.evaluationHistory.length)}
                          accent={metricAccent(maxTurns > 0 ? terminal.evaluationHistory.length / maxTurns : 0)}
                        />
                      </div>
                      <div
                        class="flex min-w-0 items-center justify-end gap-1 px-3 py-1"
                        style={{ "border-top": "1px solid rgba(255,255,255,0.04)" }}
                      >
                        <Show when={confirmingReset()}>
                          <span class="mr-auto text-[10px] text-text-weaker">{language.t("session.goal.action.confirmResetHint")}</span>
                          <ActionButton
                            label={language.t("session.goal.action.confirmReset")}
                            variant="primary"
                            tone="danger"
                            busy={busy() === "fresh"}
                            disabled={busy() !== null || !props.sessionID}
                            class="h-6 px-2 text-[10px]"
                            onClick={() => {
                              void resetGoalState().then(() => setConfirmingReset(false))
                            }}
                          />
                          <ActionButton
                            label={language.t("session.goal.action.cancel")}
                            variant="ghost"
                            disabled={busy() !== null}
                            class="h-6 px-2 text-[10px]"
                            onClick={() => setConfirmingReset(false)}
                          />
                        </Show>
                        <Show when={!confirmingReset()}>
                          <button
                            type="button"
                            class="h-5 shrink-0 rounded-md px-1.5 text-[9px] font-semibold text-text-weaker transition hover:bg-background-base/40 hover:text-text-weak"
                            title={language.t("session.goal.report.copy")}
                            onClick={copyGoalReport}
                          >
                            {reportCopied() ? language.t("session.goal.report.copied") : language.t("session.goal.report.copy")}
                          </button>
                          <ActionButton
                            label={language.t("session.goal.action.resetState")}
                            variant="ghost"
                            busy={busy() === "fresh"}
                            disabled={busy() !== null || !props.sessionID}
                            class="h-5 px-1.5 text-[9px]"
                            title={language.t("session.goal.action.resetStateHint")}
                            onClick={() => setConfirmingReset(true)}
                          />
                        </Show>
                      </div>
                    </div>
                  </GoalConsoleSection>
                )
              }}
            </Show>
              </section>
              <Show when={controlError()}>
                {(error) => (
                  <div
                    data-component="goal-control-error"
                    role="alert"
                    class="flex items-start gap-2 rounded-md border border-red-400/35 bg-red-400/8 px-3 py-2 text-12-regular text-red-100/86"
                  >
                    <span class="min-w-0 flex-1">{error()}</span>
                    <button
                      type="button"
                      aria-label={language.t("session.goal.action.cancel")}
                      class="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-red-200/70 transition hover:bg-red-400/15 hover:text-red-100"
                      onClick={() => setControlError(null)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </Show>
              {/* CENTER-AUDIT NCO1 banner: backend connectivity hint. Only
                  surfaces when the most recent fetch failed with something
                  other than file-not-found — i.e., the server itself is
                  unreachable. Suppressed once a live goal is showing so a
                  transient blip during an active run doesn't blank the panel
                  state. */}
              <Show when={props.goal.store.unreachable && !liveGoal() && !terminalGoal()}>
                <div
                  data-component="goal-backend-unreachable"
                  role="status"
                  class="flex items-center gap-2 rounded-md border border-amber-400/35 bg-amber-400/8 px-3 py-2 text-12-regular text-amber-100/86"
                >
                  <span class="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-300" aria-hidden />
                  <span class="min-w-0 flex-1">{language.t("session.goal.backendUnreachable")}</span>
                </div>
              </Show>
              <div class="flex min-w-0 flex-col gap-3">
              <GoalConsoleSection
                zone="chain-builder"
                title={language.t("session.goal.chainBuilder.shortTitle")}
                subtitle={liveGoal() ? chainRunStateSubtitle() : language.t("session.goal.chainBuilder.sectionHint")}
                class="min-h-[520px]"
              >
              <div
                data-component="goal-chain-builder"
                data-testid="chain-builder"
                class="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-[radial-gradient(circle_at_16%_0%,rgba(139,92,246,0.075),transparent_34%),linear-gradient(180deg,rgba(24,24,27,0.74),rgba(10,10,10,0.70))]"
              >
              <div
                data-component="goal-chain-builder-header-strip"
                data-budget-status={liveGoal() ? "running" : chainBudgetStatus()}
                class="relative z-10 shrink-0 border-b px-2.5 py-1"
                style={chainBuilderHeaderStyle(chainBudgetStatus(), !!liveGoal())}
              >
                <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <div
                    class="flex min-w-[160px] flex-1 flex-wrap items-center gap-1.5"
                    title={liveGoal() ? chainRunStateSubtitle() : language.t("session.goal.chainBuilder.subtitle")}
                  >
                    <span
                      class="h-4 w-1.5 shrink-0 rounded-full"
                      classList={{
                        "bg-orange-300/90": liveRunStalled(),
                        "bg-emerald-300/90": liveRunStatus() === "active" && !liveRunStalled(),
                        "bg-amber-300/90": liveRunStatus() === "paused" || (!liveGoal() && chainBudgetStatus() !== "ready"),
                        "bg-slate-300/60": !liveGoal() && chainBudgetStatus() === "ready",
                      }}
                      aria-hidden
                    />
                    <div class="shrink-0 text-[12px] font-bold uppercase tracking-[0.12em] text-sky-50/85">
                      {liveGoal() ? language.t("session.goal.chainBuilder.runningHeader") : chainRunStateLabel()}
                    </div>
                    <span
                      class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-text-base/80"
                      style={{ "background-color": "rgba(148, 163, 184, 0.08)" }}
                      title={language.t("session.goal.chainBuilder.stat.actionsAria", { count: visibleStepCount() })}
                      aria-label={language.t("session.goal.chainBuilder.stat.actionsAria", { count: visibleStepCount() })}
                    >
                      <strong class={numericHighlightClass("mr-1")} style={numericHighlightStyle("blue")}>
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
                      {(goal) => (
                        <span class="min-w-0 flex-1 basis-[120px] truncate text-[11px] font-semibold text-text-weak">
                          {cleanText(goal().condition)}
                        </span>
                      )}
                    </Show>
                  </div>
                  <div data-component="goal-target-toolbar" class="flex min-w-[160px] flex-1 flex-wrap items-center justify-end gap-1.5">
                    <ActionButton
                      label={primaryRunLabel()}
                      variant={liveGoal() ? "secondary" : "primary"}
                      class="min-h-7 shrink-0 px-2.5 text-11-medium leading-tight"
                      busy={busy() === "chain" || busy() === "set"}
                      disabled={primaryRunDisabled()}
                      title={primaryRunTitle()}
                      onClick={() => void startGoalOrChain()}
                    />
                    <Show when={!liveGoal()}>
                      <div class="flex items-center gap-1">
                        <Show when={hasRunnableChain()}>
                          <ActionButton
                            label={language.t("session.goal.chainBuilder.check")}
                            variant="secondary"
                            class="min-h-7 shrink-0 px-2.5 text-11-medium leading-tight"
                            disabled={busy() !== null || !props.sessionID}
                            onClick={() => {
                              const errors = validateChainDraft(runnableChainSteps(), {
                                maxTurns: chainDraft.master.maxTurns,
                                maxTimeMinutes: chainDraft.master.maxTimeMinutes,
                              })
                              setChainErrors(errors)
                              if (errors.length === 0) {
                                refreshChain()
                                void props.goal.refresh().catch(ignoreRefreshError("goal.refresh (chain-apply)"))
                              }
                            }}
                          />
                        </Show>
                        <span
                          data-component="goal-chain-draft-autosave"
                          class="inline-flex h-5 shrink-0 cursor-default select-none items-center rounded-md border border-border-base/55 bg-background-base/45 px-2 text-[10px] font-semibold text-text-weaker"
                          title={language.t("session.goal.chainBuilder.autosaveHint")}
                        >
                          {language.t("session.goal.chainBuilder.autosave")}
                        </span>
                      </div>
                    </Show>
                  </div>
                </div>
                <Show when={!liveGoal()}>
                  <div
                    data-component="goal-chain-target-field"
                    class="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5 rounded-md border px-2 py-1"
                    style={{
                      "background-color": "rgba(15, 23, 42, 0.22)",
                      "border-color": "rgba(100, 140, 200, 0.12)",
                    }}
                  >
                    <span class="shrink-0 text-[9px] font-semibold uppercase tracking-[0.08em] text-sky-100/70">
                      {language.t("session.goal.chainBuilder.objective")}
                    </span>
                    <input
                      value={chainDraft.objective}
                      onInput={(event) => setChainDraft("objective", event.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !primaryRunDisabled()) void startGoalOrChain() }}
                      disabled={busy() !== null || !props.sessionID}
                      placeholder={language.t("session.goal.chainBuilder.objectivePlaceholder")}
                      title={language.t("session.goal.chainBuilder.objectiveHint")}
                      aria-label={language.t("session.goal.chainBuilder.objective")}
                      class="h-6 min-w-0 bg-transparent px-1 text-11-medium text-text-base outline-none placeholder:text-sky-100/30 disabled:opacity-40"
                    />
                  </div>
                  <Show when={!hasRunnableChain()}>
                    <div
                      data-component="goal-standalone-command-field"
                      class="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5 rounded-md border px-2 py-1"
                      style={{
                        "background-color": "rgba(14, 165, 233, 0.05)",
                        "border-color": "rgba(56, 189, 248, 0.12)",
                      }}
                    >
                      <span class="shrink-0 text-[9px] font-semibold uppercase tracking-[0.08em] text-sky-100/74">
                        {language.t("session.goal.create.command")}
                      </span>
                      <input
                        value={newCommand()}
                        onInput={(event) => setNewCommand(event.currentTarget.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !primaryRunDisabled()) void startGoalOrChain() }}
                        disabled={busy() !== null || !props.sessionID}
                        placeholder={language.t("session.goal.create.commandPlaceholder")}
                        aria-label={language.t("session.goal.create.command")}
                        class="h-6 min-w-0 bg-transparent px-1 text-11-medium text-sky-50 outline-none placeholder:text-sky-100/32 disabled:opacity-40"
                      />
                    </div>
                  </Show>
                </Show>
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
                      class="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-1.5"
                    >
                    <label
                      data-component="goal-chain-compact-stat"
                      data-kind="turns"
                      class="flex h-8 min-w-0 items-center gap-1.5 rounded-md border px-2"
                      style={{
                        "background-color": "rgba(59, 130, 246, 0.04)",
                        "border-color": "rgba(100, 140, 200, 0.14)",
                      }}
                      title={chainLimitSummary()}
                    >
                      <span class="min-w-[48px] text-[9px] font-semibold uppercase tracking-[0.08em] text-sky-100/70">
                        {language.t("session.goal.chainBuilder.stat.turns")}
                      </span>
                      <input
                        aria-label={language.t("session.goal.chainBuilder.stat.turnLimitAria")}
                        type="number"
                        min="1"
                        value={String(masterTurns())}
                        disabled={busy() !== null || !!liveGoal()}
                        onInput={(event) => updateMasterBudget("maxTurns", event.currentTarget.value)}
                        class="h-6 w-11 rounded-md border border-sky-200/14 bg-sky-950/16 px-1 text-center text-12-bold tabular-nums text-text-base outline-none focus:border-sky-200/35"
                      />
                      <span class="min-w-0 truncate text-[9px] font-semibold text-sky-100/45">
                        {language.t("session.goal.chainBuilder.stat.turnsHint")}
                      </span>
                    </label>
                    <label
                      data-component="goal-chain-compact-stat"
                      data-kind="time"
                      class="flex h-8 min-w-0 items-center gap-1.5 rounded-md border px-2"
                      style={{
                        "background-color": "rgba(59, 130, 246, 0.04)",
                        "border-color": "rgba(100, 140, 200, 0.14)",
                      }}
                      title={chainLimitSummary()}
                    >
                      <span class="min-w-[48px] text-[9px] font-semibold uppercase tracking-[0.08em] text-sky-100/70">
                        {language.t("session.goal.chainBuilder.stat.time")}
                      </span>
                      <input
                        aria-label={language.t("session.goal.chainBuilder.stat.timeLimitAria")}
                        type="number"
                        min="1"
                        value={String(masterMinutes())}
                        disabled={busy() !== null || !!liveGoal()}
                        onInput={(event) => updateMasterBudget("maxTimeMinutes", event.currentTarget.value)}
                        class="h-6 w-11 rounded-md border border-sky-200/14 bg-sky-950/16 px-1 text-center text-12-bold tabular-nums text-text-base outline-none focus:border-sky-200/35"
                      />
                      <span class="min-w-0 truncate text-[9px] font-semibold text-sky-100/45">
                        {language.t("session.goal.chainBuilder.stat.timeHint")}
                      </span>
                    </label>
                    <div
                      data-component="goal-chain-compact-stat"
                      data-kind="actions"
                      class="flex h-8 min-w-0 items-center gap-1.5 rounded-md border px-2"
                      style={{
                        "background-color": "rgba(59, 130, 246, 0.04)",
                        "border-color": "rgba(100, 140, 200, 0.14)",
                      }}
                      title={language.t("session.goal.chainBuilder.stat.actionsAria", { count: visibleStepCount() })}
                    >
                      <span class="min-w-[48px] text-[9px] font-semibold uppercase tracking-[0.08em] text-sky-100/70">
                        {language.t("session.goal.chainBuilder.stat.actions")}
                      </span>
                      <span class="flex h-6 w-11 items-center justify-center rounded-md border border-sky-200/14 bg-sky-950/16 px-1 text-center text-12-bold tabular-nums text-text-base">
                        {visibleStepCount()}
                      </span>
                      <span class="min-w-0 truncate text-[9px] font-semibold text-sky-100/45">
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
                    <div class="flex min-w-0 flex-col gap-2">
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
                            {language.t("session.goal.chainBuilder.stalledHint")} {language.t("session.goal.chainBuilder.stalledIdleMinutes", { minutes: liveRunIdleMinutes() })}
                          </div>
                        </Show>
                        <Show when={runningStep()} keyed>
                          {(step) => {
                            const title = () => cleanText(step.label || step.condition || language.t("session.goal.chainBuilder.steps"))
                            const detail = () => cleanText(step.condition || step.label || "")
                            return (
                              <div
                                data-component="goal-running-now-step"
                                class="mb-1.5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-1.5"
                                style={{
                                  "border-color": "rgba(96, 165, 250, 0.22)",
                                  "background-color": "rgba(59, 130, 246, 0.06)",
                                  "box-shadow": "inset 0 1px 0 rgba(147, 197, 253, 0.08)",
                                }}
                              >
                                <div class="min-w-0">
                                  <div class="truncate text-[9px] font-black uppercase tracking-[0.08em] text-blue-100/62">
                                    {language.t("session.goal.chainBuilder.currentStep")}
                                  </div>
                                  <div class="mt-0.5 truncate text-[12px] font-semibold leading-4 text-blue-50/92" title={detail() || title()}>
                                    {title()}
                                  </div>
                                  <div
                                    data-component="goal-running-now-step-runtime"
                                    class="mt-1 flex min-w-0 flex-wrap gap-1"
                                    title={stepRuntimeTitle(step)}
                                  >
                                    <span class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-blue-300/14 bg-blue-500/8 px-1.5 py-0.5 text-[9px] font-semibold leading-3 text-blue-50/82">
                                      <span class="shrink-0 uppercase tracking-[0.04em] text-blue-100/50">
                                        {language.t("session.goal.runtime.agent")}
                                      </span>
                                      <span class="min-w-0 truncate">{stepRuntimeAgentLabel(step)}</span>
                                    </span>
                                    <span class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-violet-300/14 bg-violet-500/8 px-1.5 py-0.5 text-[9px] font-semibold leading-3 text-violet-50/82">
                                      <span class="shrink-0 uppercase tracking-[0.04em] text-violet-100/50">
                                        {language.t("session.goal.runtime.model")}
                                      </span>
                                      <span class="min-w-0 truncate">{stepRuntimeModelLabel(step)}</span>
                                    </span>
                                    <span class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-emerald-300/14 bg-emerald-500/8 px-1.5 py-0.5 text-[9px] font-semibold leading-3 text-emerald-50/82">
                                      <span class="shrink-0 uppercase tracking-[0.04em] text-emerald-100/50">
                                        {language.t("session.goal.runtime.skills")}
                                      </span>
                                      <span class="min-w-0 truncate">{stepRuntimeSkillLabel(step)}</span>
                                    </span>
                                    <span class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-amber-300/14 bg-amber-500/8 px-1.5 py-0.5 text-[9px] font-semibold leading-3 text-amber-50/82">
                                      <span class="shrink-0 uppercase tracking-[0.04em] text-amber-100/50">
                                        {language.t("session.goal.runtime.completion")}
                                      </span>
                                      <span class="min-w-0 truncate">{stepRuntimeCompletionLabel(step)}</span>
                                    </span>
                                  </div>
                                </div>
                                <div
                                  class="grid h-8 min-w-[64px] shrink-0 place-items-center rounded-md border px-2 text-[14px] font-black leading-none tabular-nums text-blue-50"
                                  style={{
                                    "border-color": "rgba(147, 197, 253, 0.22)",
                                    "background-color": "rgba(15, 23, 42, 0.34)",
                                  }}
                                  aria-label={language.t("session.goal.chainBuilder.currentStepAria", {
                                    current: runningStepIndex() + 1,
                                    total: Math.max(visibleStepCount(), 1),
                                  })}
                                >
                                  <span>
                                    {runningStepIndex() + 1}
                                    <span class="text-[10px] font-bold text-blue-100/52">/{Math.max(visibleStepCount(), 1)}</span>
                                  </span>
                                </div>
                              </div>
                            )
                          }}
                        </Show>
                        <div
                          data-component="goal-running-metric-strip"
                          class="mt-1.5 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-1"
                        >
                          <div
                            data-component="goal-running-clock"
                            class="relative flex h-9 min-w-0 items-center justify-between gap-2 overflow-hidden rounded-md border px-2"
                            style={isCritical(elapsedMs() / 60_000, running.constraints.maxTimeMinutes)
                              ? { "border-color": "rgba(248, 113, 113, 0.4)", "box-shadow": "inset 0 0 8px rgba(248, 113, 113, 0.25)" } : { "border-color": "rgba(96, 165, 250, 0.2)" }}
                          >
                            <div class="absolute inset-y-0 left-0 rounded-l-md opacity-20 transition-[width] motion-reduce:transition-none" style={{ width: `${burndownPct(elapsedMs() / 60_000, running.constraints.maxTimeMinutes)}%`, "background-color": burndownColor(elapsedMs() / 60_000, running.constraints.maxTimeMinutes) }} />
                            <div class="relative truncate text-[9px] font-bold uppercase tracking-[0.06em] text-blue-200/70">
                              {language.t("session.goal.metric.time")}
                            </div>
                            <div class="relative shrink-0 text-[14px] font-black leading-none tabular-nums text-blue-100">
                              {elapsedFormatted()}
                              <span class="text-[10px] font-bold text-blue-100/50">/{running.constraints.maxTimeMinutes}m</span>
                            </div>
                          </div>
                          <div
                            data-component="goal-running-turns"
                            class="relative flex h-9 min-w-0 items-center justify-between gap-2 overflow-hidden rounded-md border px-2"
                            style={isCritical(running.turnsEvaluated, running.constraints.maxTurns)
                              ? { "border-color": "rgba(248, 113, 113, 0.4)", "box-shadow": "inset 0 0 8px rgba(248, 113, 113, 0.25)" } : { "border-color": "rgba(167, 139, 250, 0.2)" }}
                          >
                            <div class="absolute inset-y-0 left-0 rounded-l-md opacity-20 transition-[width] motion-reduce:transition-none" style={{ width: `${burndownPct(running.turnsEvaluated, running.constraints.maxTurns)}%`, "background-color": burndownColor(running.turnsEvaluated, running.constraints.maxTurns) }} />
                            <div class="relative truncate text-[9px] font-bold uppercase tracking-[0.06em] text-violet-200/70">
                              {language.t("session.goal.metric.turns")}
                            </div>
                            <div class="relative shrink-0 text-[14px] font-black leading-none tabular-nums text-violet-100">
                              {running.turnsEvaluated}
                              <span class="text-[10px] font-bold text-violet-100/50">/{running.constraints.maxTurns}</span>
                            </div>
                          </div>
                          <div
                            data-component="goal-running-step"
                            class="relative flex h-9 min-w-0 items-center justify-between gap-2 overflow-hidden rounded-md border px-2"
                            style={{ "border-color": "rgba(134, 239, 172, 0.2)" }}
                          >
                            <div class="absolute inset-y-0 left-0 rounded-l-md opacity-20 transition-[width] motion-reduce:transition-none" style={{ width: `${burndownPct(runningStepIndex() + 1, Math.max(visibleStepCount(), 1))}%`, "background-color": "rgb(134, 239, 172)" }} />
                            <div class="relative truncate text-[9px] font-bold uppercase tracking-[0.06em] text-emerald-200/70">
                              {language.t("session.goal.metric.chain")}
                            </div>
                            <div class="relative shrink-0 text-[14px] font-black leading-none tabular-nums text-emerald-100">
                              {runningStepIndex() + 1}
                              <span class="text-[10px] font-bold text-emerald-100/50">/{Math.max(visibleStepCount(), 1)}</span>
                            </div>
                          </div>
                          <div
                            data-component="goal-running-tokens"
                            class="relative flex h-9 min-w-0 items-center justify-between gap-2 overflow-hidden rounded-md border px-2"
                            style={isCritical(running.tokensUsed, running.constraints.maxTokens)
                              ? { "border-color": "rgba(248, 113, 113, 0.4)", "box-shadow": "inset 0 0 8px rgba(248, 113, 113, 0.25)" } : { "border-color": "rgba(251, 191, 36, 0.2)" }}
                          >
                            <div class="absolute inset-y-0 left-0 rounded-l-md opacity-20 transition-[width] motion-reduce:transition-none" style={{ width: `${burndownPct(running.tokensUsed, running.constraints.maxTokens)}%`, "background-color": burndownColor(running.tokensUsed, running.constraints.maxTokens) }} />
                            <div class="relative truncate text-[9px] font-bold uppercase tracking-[0.06em] text-amber-200/70">
                              {language.t("session.goal.metric.tokens")}
                            </div>
                            <div class="relative shrink-0 text-[14px] font-black leading-none tabular-nums text-amber-100">
                              {formatTokens(running.tokensUsed)}
                              <span class="text-[10px] font-bold text-amber-100/50">/{formatTokens(running.constraints.maxTokens)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div class="flex min-w-0 flex-col">
                        <Show when={visibleStepCount() > 1}>
                          <div
                            data-component="goal-chain-minimap"
                            class="mb-1.5 flex items-center gap-1 rounded-md border px-2.5 py-1.5"
                            style={{ "background-color": "rgba(16, 185, 129, 0.05)", "border-color": "rgba(110, 231, 183, 0.1)" }}
                          >
                            <span class="mr-1 text-[9px] font-bold uppercase tracking-[0.06em] text-emerald-200/55">
                              {language.t("session.goal.metric.chain")}
                            </span>
                            <For each={Array.from({ length: visibleStepCount() }, (_, i) => i)}>
                              {(i) => {
                                const st = () => stepRunState(i)
                                return (
                                  <div
                                    class="h-2 rounded-full transition-all motion-reduce:transition-none"
                                    style={{
                                      width: `${Math.max(6, Math.min(24, Math.round(120 / visibleStepCount())))}px`,
                                      "background-color":
                                        st() === "done" ? "rgb(134, 239, 172)"
                                          : st() === "running" ? "rgb(96, 165, 250)"
                                          : st() === "paused" ? "rgb(251, 191, 36)"
                                          : st() === "stalled" ? "rgb(251, 146, 60)"
                                          : "rgba(148, 163, 184, 0.25)",
                                      opacity: st() === "running" || st() === "done" ? "1" : "0.6",
                                    }}
                                    title={`${language.t("session.goal.chainBuilder.steps")} ${i + 1}: ${st()}`}
                                  />
                                )
                              }}
                            </For>
                          </div>
                        </Show>
                        <div
                          data-component="goal-running-progress-hero"
                          class="rounded-md border px-2.5 py-2 text-right"
                          style={{ "border-color": "rgba(110, 231, 183, 0.12)", "background-color": "rgba(16, 185, 129, 0.04)" }}
                        >
                          <div class="flex items-center justify-between gap-2">
                            <div class="flex items-baseline gap-1.5">
                              <span class="truncate text-[9px] font-bold uppercase tracking-[0.06em] text-emerald-200/70">
                                {language.t("session.goal.progress")}
                              </span>
                              <Show when={progressDriver()}>
                                {(driver) => (
                                  <span class="text-[8px] font-semibold uppercase tracking-[0.06em] text-emerald-200/42">
                                    {language.t(driver() === "tokens" ? "session.goal.metric.tokens" : driver() === "time" ? "session.goal.metric.time" : "session.goal.metric.turns")}
                                  </span>
                                )}
                              </Show>
                            </div>
                            <div class="flex shrink-0 items-center gap-2">
                              <Show when={goalHealth()}>
                                {(health) => (
                                  <span
                                    class="rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em]"
                                    style={{
                                      color: health().color,
                                      "border-color": health().color.replace("rgb", "rgba").replace(")", ", 0.35)"),
                                      "background-color": health().color.replace("rgb", "rgba").replace(")", ", 0.1)"),
                                    }}
                                  >
                                    {language.t(`session.goal.health.${health().label === "Healthy" ? "healthy" : health().label === "Fair" ? "fair" : "risk"}`)}
                                  </span>
                                )}
                              </Show>
                              <span class="text-[18px] font-black leading-none tabular-nums text-emerald-100">
                                {running.status === "achieved" ? 100 : progressPct()}%
                              </span>
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
                              classList={{
                                "motion-safe:animate-[goal-pulse_2s_ease-in-out_infinite]": running.status === "active" && !liveRunStalled(),
                              }}
                              style={{
                                width: `${running.status === "achieved" ? 100 : progressPct()}%`,
                                ...(running.status === "active" && !liveRunStalled() ? {
                                  "box-shadow": "0 0 6px rgba(110, 231, 183, 0.4)",
                                } : {}),
                              }}
                            />
                          </div>
                          <Show when={turnVelocity() !== null || etaFormatted()}>
                            <div class="mt-1 flex items-center justify-between gap-2">
                              <Show when={turnVelocity() !== null}>
                                {(() => {
                                  const vel = () => turnVelocity() ?? 0
                                  return (
                                    <span class="text-[9px] font-semibold tabular-nums text-emerald-200/55">
                                      {vel().toFixed(1)} {language.t("session.goal.velocity.unit")}
                                    </span>
                                  )
                                })()}
                              </Show>
                              <Show when={etaFormatted()}>
                                {(eta) => (
                                  <span class="text-[9px] font-semibold tabular-nums text-emerald-200/55">
                                    {language.t("session.goal.eta.label")} {eta()}
                                  </span>
                                )}
                              </Show>
                            </div>
                          </Show>
                          <Show when={smartStatus()}>
                            {(status) => {
                              const smartColor = (): string => {
                                if (isBlocked() || liveRunStalled()) return "rgb(251, 146, 60)"
                                const s = state()
                                if (s?.status === "paused") return "rgb(251, 191, 36)"
                                const turnR = s && s.constraints.maxTurns > 0 ? s.turnsEvaluated / s.constraints.maxTurns : 0
                                const timeR = s && s.constraints.maxTimeMinutes > 0 ? (elapsedMs() / 60_000) / s.constraints.maxTimeMinutes : 0
                                const tokenR = s && s.constraints.maxTokens > 0 ? s.tokensUsed / s.constraints.maxTokens : 0
                                if (turnR >= 0.9 || timeR >= 0.9 || tokenR >= 0.9) return "rgb(248, 113, 113)"
                                if (confidenceTrend() === "down") return "rgb(251, 191, 36)"
                                if (confidenceTrend() === "up") return "rgb(134, 239, 172)"
                                return "rgb(148, 163, 184)"
                              }
                              return (
                                <div
                                  class="mt-1.5 truncate rounded-md border px-2 py-0.5 text-[10px] font-semibold"
                                  style={{ color: smartColor(), "border-color": smartColor().replace("rgb", "rgba").replace(")", ", 0.25)"), "background-color": smartColor().replace("rgb", "rgba").replace(")", ", 0.08)") }}
                                >
                                  {status()}
                                </div>
                              )
                            }}
                          </Show>
                          <Show when={tokenEfficiency() !== null || tokenBurnRate() !== null || elapsedSinceLastEval() !== null || bestConfidence() !== null || confidenceDelta() !== null || evalSuccessRate() !== null || evalStreak() !== null || confidenceVolatility() !== null || avgCycleTime() !== null || tokenExhaustForecast() !== null}>
                            <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2 py-1" style={{ "border-color": "rgba(148, 163, 184, 0.1)", "background-color": "rgba(148, 163, 184, 0.03)" }}>
                              <Show when={tokenEfficiency() !== null}>
                                {(() => {
                                  const eff = () => tokenEfficiency() ?? 0
                                  return (
                                    <span class="text-[9px] tabular-nums text-slate-400/70">
                                      {formatTokens(eff())} {language.t("session.goal.stats.tokensPerTurn")}
                                    </span>
                                  )
                                })()}
                              </Show>
                              <Show when={tokenBurnRate() !== null}>
                                {(() => {
                                  const rate = () => tokenBurnRate() ?? 0
                                  return (
                                    <span class="text-[9px] tabular-nums text-slate-400/70">
                                      {formatTokens(rate())} {language.t("session.goal.stats.tokensPerMin")}
                                    </span>
                                  )
                                })()}
                              </Show>
                              <Show when={elapsedSinceLastEval() !== null}>
                                {(() => {
                                  const since = () => elapsedSinceLastEval() ?? 0
                                  return (
                                    <span class="text-[9px] tabular-nums text-slate-400/70">
                                      {language.t("session.goal.stats.sinceEval")}: {formatSinceEval(since())}
                                    </span>
                                  )
                                })()}
                              </Show>
                              <Show when={bestConfidence() !== null}>
                                {(() => {
                                  const peak = () => bestConfidence() ?? 0
                                  return (
                                    <span class="text-[9px] tabular-nums" style={{ color: confidenceColor(peak()) }}>
                                      {language.t("session.goal.stats.peakConf")}: {peak()}%
                                    </span>
                                  )
                                })()}
                              </Show>
                              <Show when={confidenceDelta() !== null}>
                                {(() => {
                                  const d = () => confidenceDelta() ?? 0
                                  return (
                                    <span class="text-[9px] font-semibold tabular-nums" style={{
                                      color: d() > 0 ? "rgb(134, 239, 172)" : d() < 0 ? "rgb(248, 113, 113)" : "rgb(148, 163, 184)"
                                    }}>
                                      {language.t("session.goal.stats.delta")}: {d() > 0 ? "+" : ""}{d()}%
                                    </span>
                                  )
                                })()}
                              </Show>
                              <Show when={evalSuccessRate() !== null}>
                                {(() => {
                                  const rate = () => evalSuccessRate() ?? 0
                                  return (
                                    <span class="text-[9px] tabular-nums" style={{
                                      color: rate() >= 50 ? "rgb(134, 239, 172)" : "rgb(251, 191, 36)"
                                    }}>
                                      {language.t("session.goal.stats.successRate")}: {rate()}%
                                    </span>
                                  )
                                })()}
                              </Show>
                              <Show when={evalStreak()}>
                                {(streak) => (
                                  <span class="text-[9px] font-semibold tabular-nums" style={{
                                    color: streak().type === "met" ? "rgb(134, 239, 172)" : "rgb(251, 191, 36)"
                                  }}>
                                    {streak().count}× {language.t(`session.goal.stats.streak${streak().type === "met" ? "Met" : "NotMet"}`)}
                                  </span>
                                )}
                              </Show>
                              <Show when={confidenceVolatility()}>
                                {(vol) => (
                                  <span class="text-[9px] tabular-nums" style={{ color: volatilityColor(vol()) }}>
                                    {language.t("session.goal.stats.volatility")}: {vol()}
                                  </span>
                                )}
                              </Show>
                              <Show when={avgCycleTime() !== null}>
                                {(() => {
                                  const avg = () => avgCycleTime() ?? 0
                                  return (
                                    <span class="text-[9px] tabular-nums text-slate-400/70">
                                      {language.t("session.goal.stats.avgCycle")}: {formatCycleDuration(avg())}
                                    </span>
                                  )
                                })()}
                              </Show>
                              <Show when={tokenExhaustForecast()}>
                                {(tok) => (
                                  <span class="text-[9px] tabular-nums text-amber-300/65">
                                    {language.t("session.goal.stats.tokenExhaust")}: {tok()}
                                  </span>
                                )}
                              </Show>
                            </div>
                          </Show>
                          <Show when={constraintHeadroom()}>
                            {(headroom) => (
                              <div class="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1" style={{ "border-color": "rgba(148, 163, 184, 0.12)", "background-color": "rgba(148, 163, 184, 0.04)" }}>
                                <Show when={headroom().turns !== null}>
                                  {(() => {
                                    const t = () => headroom().turns ?? 0
                                    return (
                                      <span
                                        class="rounded-full px-1.5 py-0.5 text-[8px] font-bold tabular-nums"
                                        style={{
                                          color: t() <= 2 ? "rgb(248, 113, 113)" : "rgb(167, 139, 250)",
                                          "background-color": t() <= 2 ? "rgba(248, 113, 113, 0.12)" : "rgba(167, 139, 250, 0.1)",
                                        }}
                                      >
                                        {t()} {language.t("session.goal.stats.turnsLeft")}
                                      </span>
                                    )
                                  })()}
                                </Show>
                                <Show when={headroom().timeMins !== null}>
                                  {(() => {
                                    const m = () => headroom().timeMins ?? 0
                                    return (
                                      <span
                                        class="rounded-full px-1.5 py-0.5 text-[8px] font-bold tabular-nums"
                                        style={{
                                          color: m() < 1 ? "rgb(248, 113, 113)" : "rgb(96, 165, 250)",
                                          "background-color": m() < 1 ? "rgba(248, 113, 113, 0.12)" : "rgba(96, 165, 250, 0.1)",
                                        }}
                                      >
                                        {m() < 1 ? "<1" : Math.round(m())}m {language.t("session.goal.stats.timeLeft")}
                                      </span>
                                    )
                                  })()}
                                </Show>
                                <Show when={headroom().tokens !== null}>
                                  {(() => {
                                    const tok = () => headroom().tokens ?? 0
                                    return (
                                      <span
                                        class="rounded-full px-1.5 py-0.5 text-[8px] font-bold tabular-nums"
                                        style={{
                                          color: tok() < 1000 ? "rgb(248, 113, 113)" : "rgb(251, 191, 36)",
                                          "background-color": tok() < 1000 ? "rgba(248, 113, 113, 0.12)" : "rgba(251, 191, 36, 0.1)",
                                        }}
                                      >
                                        {formatTokens(tok())} {language.t("session.goal.stats.tokensLeft")}
                                      </span>
                                    )
                                  })()}
                                </Show>
                              </div>
                            )}
                          </Show>
                        </div>
                        <Show when={lastEval()}>
                          {(evaluation) => (
                            <div
                              data-component="goal-running-evidence"
                              class="mt-1.5 rounded-lg border p-2"
                              style={isBlocked()
                                ? { ...runningInlinePanelStyle("evidence"), "box-shadow": `${runningInlinePanelStyle("evidence")["box-shadow"]}, 0 0 12px rgba(251, 146, 60, 0.3), inset 0 0 0 1px rgba(251, 146, 60, 0.35)` }
                                : runningInlinePanelStyle("evidence")}
                            >
                              <div class="mb-1.5 flex items-center justify-between gap-2">
                                <span class="text-[10px] font-bold uppercase tracking-[0.12em] text-blue-100/78">
                                  {language.t("session.goal.evidence.title")}
                                </span>
                                <div class="flex items-center gap-2">
                                  <Show when={confidencePct() !== null}>
                                    {(() => {
                                      const pct = () => confidencePct() ?? 0
                                      return (
                                        <div class="flex items-center gap-1.5">
                                          <div class="h-1.5 w-16 overflow-hidden rounded-full bg-background-base/70">
                                            <div
                                              class="h-full rounded-full transition-[width] motion-reduce:transition-none"
                                              style={{ width: `${pct()}%`, "background-color": confidenceColor(pct()) }}
                                            />
                                          </div>
                                          <span class="text-[10px] font-bold tabular-nums" style={{ color: confidenceColor(pct()) }}>
                                            {pct()}%
                                          </span>
                                          <Show when={confidenceTrend()}>
                                            {(trend) => (
                                              <span class="text-[11px] font-bold" style={{ color: trendColor(trend()) }}>
                                                {trendArrow(trend())}
                                              </span>
                                            )}
                                          </Show>
                                        </div>
                                      )
                                    })()}
                                  </Show>
                                  <Show when={sparklinePoints()}>
                                    {(pts) => (
                                      <svg width="64" height="16" viewBox="0 0 64 16" class="shrink-0" aria-label={language.t("session.goal.evidence.trend")}>
                                        <polyline
                                          points={pts()}
                                          fill="none"
                                          stroke="rgb(96, 165, 250)"
                                          stroke-width="1.5"
                                          stroke-linejoin="round"
                                          stroke-linecap="round"
                                        />
                                      </svg>
                                    )}
                                  </Show>
                                  <span
                                    class={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] ${evaluation().met ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200" : "border-amber-400/40 bg-amber-500/15 text-amber-200"}`}
                                  >
                                    <span class={`h-1.5 w-1.5 rounded-full ${evaluation().met ? "bg-emerald-400" : "bg-amber-400"}`} aria-hidden />
                                    {evaluation().met ? language.t("session.goal.evidence.met") : language.t("session.goal.evidence.notMet")}
                                  </span>
                                </div>
                              </div>
                              <Show when={evaluation().reason}>
                                <div class="rounded-md border border-blue-300/12 bg-background-base/54 px-2 py-1.5 text-11-regular leading-4 text-text-weak">
                                  {cleanText(evaluation().reason)}
                                </div>
                              </Show>
                              <div class="mt-1.5 flex items-center gap-3 text-[9px] text-text-weaker">
                                <span class="uppercase tracking-[0.06em]">{evaluation().evaluatorType}</span>
                                <Show when={evaluation().blocked}>
                                  <span class="font-semibold uppercase text-orange-300">
                                    {language.t("session.goal.evidence.blocked")}
                                  </span>
                                </Show>
                                <Show when={elapsedSinceLastEval() !== null}>
                                  {(() => {
                                    const since = () => elapsedSinceLastEval() ?? 0
                                    return (
                                      <span class="tabular-nums text-blue-200/45">
                                        {formatSinceEval(since())}
                                      </span>
                                    )
                                  })()}
                                </Show>
                              </div>
                            </div>
                          )}
                        </Show>
                        <Show when={evalHistory().length > 1}>
                          <div
                            data-component="goal-running-eval-timeline"
                            class="mt-1.5 rounded-lg border p-2"
                            style={runningInlinePanelStyle("evidence")}
                          >
                            <div class="mb-1.5 flex items-center justify-between gap-2">
                              <span class="text-[10px] font-bold uppercase tracking-[0.12em] text-blue-100/78">
                                {language.t("session.goal.evidence.history")}
                              </span>
                              <div class="flex items-center gap-2">
                                <Show when={evalHistory().length > 3}>
                                  <button
                                    type="button"
                                    class="text-[10px] font-semibold text-blue-200/60 transition hover:text-blue-100"
                                    onClick={() => setEvidenceExpanded((v) => !v)}
                                  >
                                    {evidenceExpanded()
                                      ? language.t("session.goal.activity.showRecent")
                                      : language.t("session.goal.activity.showAll")}
                                  </button>
                                </Show>
                                <span class={numericHighlightClass()} style={numericHighlightStyle("blue")}>
                                  {evalHistory().length}
                                </span>
                              </div>
                            </div>
                            <div role="list" class={`grid gap-1 overflow-y-auto ${evidenceExpanded() ? "max-h-64" : "max-h-20"}`}>
                              {(() => {
                                const h = evalHistory()
                                const durations = evalCycleDurations()
                                const visible = evidenceExpanded() ? h : h.slice(-3)
                                const offset = evidenceExpanded() ? 0 : Math.max(0, h.length - 3)
                                return (
                                  <For each={visible}>
                                    {(cycle, localIdx) => {
                                      const realIdx = offset + localIdx()
                                      const dur = durations[realIdx]
                                      return (
                                        <div
                                          role="listitem"
                                          class="grid min-w-0 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-blue-300/12 bg-background-base/54 px-2 py-1 text-[11px]"
                                        >
                                          <span class={cycle.met ? "text-center text-emerald-400" : "text-center text-amber-400"} aria-hidden>
                                            {cycle.met ? "✓" : "↺"}
                                          </span>
                                          <span class="min-w-0 truncate text-text-weak" title={cleanText(cycle.reason)}>
                                            {cleanText(cycle.reason)}
                                          </span>
                                          <div class="flex shrink-0 items-center gap-1.5">
                                            <Show when={typeof dur === "number" && dur > 0}>
                                              <span class="tabular-nums text-[9px] text-blue-200/45">
                                                {formatCycleDuration(dur as number)}
                                              </span>
                                            </Show>
                                            <Show when={typeof cycle.confidence === "number"}>
                                              <span class="tabular-nums text-text-weaker">
                                                {Math.round((cycle.confidence ?? 0) * 100)}%
                                              </span>
                                            </Show>
                                          </div>
                                        </div>
                                      )
                                    }}
                                  </For>
                                )
                              })()}
                            </div>
                          </div>
                        </Show>
                        <Show when={steeringNotes().length > 0}>
                          <div
                            data-component="goal-running-steering"
                            class="mt-1.5 rounded-lg border p-2"
                            style={runningInlinePanelStyle("steering")}
                          >
                            <div class="mb-1.5 flex items-center justify-between gap-2">
                              <span class="text-[10px] font-bold uppercase tracking-[0.12em] text-purple-100/78">
                                {language.t("session.goal.steering.title")}
                              </span>
                              <span class={numericHighlightClass()} style={numericHighlightStyle("blue")}>
                                {steeringNotes().length}
                              </span>
                            </div>
                            <div role="list" class="grid gap-1 overflow-y-auto max-h-20">
                              <For each={steeringNotes()}>
                                {(note) => (
                                  <div
                                    role="listitem"
                                    class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5 rounded-md border border-purple-300/12 bg-background-base/54 px-2 py-1 text-[11px]"
                                  >
                                    <span class="shrink-0 tabular-nums text-[9px] text-text-weaker">
                                      {new Date(note.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                    <span class="min-w-0 truncate text-text-weak">
                                      {cleanText(note.note)}
                                    </span>
                                  </div>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>
                        <div
                          data-component="goal-runtime-command-tray"
                          data-state={runtimeDetailState()}
                          class="order-first mb-1.5 rounded-lg border p-2"
                          style={{
                            "background-color": "rgba(2, 6, 23, 0.36)",
                            "border-color": "rgba(148, 163, 184, 0.18)",
                            "box-shadow": "inset 0 1px 0 rgba(255,255,255,0.035)",
                          }}
                        >
                          <div class="mb-2 flex min-w-0 items-center justify-between gap-2">
                            <div class="min-w-0 truncate text-[10px] font-bold uppercase tracking-[0.08em] text-cyan-100/78">
                              {language.t("session.goal.runControls")}
                            </div>
                            <button
                              type="button"
                              class="shrink-0 rounded-md border border-cyan-300/16 bg-cyan-500/8 px-2 py-1 text-[10px] font-semibold text-cyan-100/70 transition hover:border-cyan-200/36 hover:bg-cyan-500/14 hover:text-cyan-50"
                              title={language.t("session.goal.report.copy")}
                              onClick={copyGoalReport}
                            >
                              {reportCopied() ? language.t("session.goal.report.copied") : language.t("session.goal.report.copy")}
                            </button>
                          </div>
                          <div data-component="goal-runtime-actions" class="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(116px,1fr))] gap-1.5">
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
                                    class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                    onClick={() => {
                                      closeRuntimePanel()
                                      const next = action()
                                      setOptimisticStatus(next === "pause" ? "paused" : "active")
                                      // Pause is a HARD pause: it aborts the in-flight turn so the
                                      // chat stops immediately (resume re-nudges via runAction).
                                      void (next === "pause" ? pauseGoal() : runAction("resume"))
                                        .then((ok) => {
                                          if (!ok) setOptimisticStatus(null)
                                        })
                                        .catch((err) => {
                                          setOptimisticStatus(null)
                                          ignoreRefreshError(`pauseResume button (${next})`)(err)
                                        })
                                    }}
                                  />
                                )}
                              </Show>
                              <Show when={runtimeCanInteract()}>
                                <ActionButton
                                  label={language.t("session.goal.action.stop")}
                                  variant={confirmingClear() ? "primary" : "secondary"}
                                  tone="danger"
                                  disabled={busy() !== null || !props.sessionID}
                                  class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                  onClick={() => openRuntimePanel("stop")}
                                />
                              </Show>
                              <Show when={runtimeCanRestart()}>
                                <ActionButton
                                  label={language.t("session.goal.action.restart")}
                                  variant="secondary"
                                  busy={busy() === "restart"}
                                  disabled={busy() !== null || !props.sessionID}
                                  class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                  onClick={() => {
                                    closeRuntimePanel()
                                    void runAction("restart")
                                  }}
                                />
                              </Show>
                              <Show when={runtimeCanInteract()}>
                                <ActionButton
                                  label={language.t("session.goal.action.steer")}
                                  variant={steerOpen() ? "primary" : "secondary"}
                                  disabled={busy() !== null || !props.sessionID}
                                  class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                  title={language.t("session.goal.steer.hint")}
                                  onClick={() => (steerOpen() ? closeRuntimePanel() : openRuntimePanel("steer"))}
                                />
                              </Show>
                              <Show when={runtimeCanInteract() && !handoff().handoff}>
                                <ActionButton
                                  label={language.t("session.goal.action.handoff")}
                                  variant={handoffOpen() ? "primary" : "secondary"}
                                  busy={busy() === "handoff"}
                                  disabled={busy() !== null || !props.sessionID}
                                  class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                  title={language.t("session.goal.handoff.hint")}
                                  onClick={() => (handoffOpen() ? closeRuntimePanel() : openRuntimePanel("handoff"))}
                                />
                              </Show>
                          </div>
                          <Show when={confirmingClear() || steerOpen() || handoffOpen()}>
                            <div
                              data-component="goal-runtime-detail-slot"
                              data-state={runtimeDetailState()}
                              class="mt-2 rounded-md border p-2"
                              style={{
                                "background-color": "rgba(15, 23, 42, 0.34)",
                                "border-color": "rgba(148, 163, 184, 0.14)",
                              }}
                            >
                              <Switch>
                              <Match when={confirmingClear()}>
                                <div
                                  data-component="goal-running-inline-panel"
                                  data-state="stop-confirm"
                                  class="grid min-h-9 min-w-0 gap-2 rounded-md border px-2 py-1.5"
                                  style={runningInlinePanelStyle("stop")}
                                >
                                  <div class="min-w-0 text-11-regular font-semibold text-orange-50/82">
                                    {language.t("session.goal.action.confirmStop")}
                                  </div>
                                  <div class="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(92px,1fr))] gap-1">
                                    <ActionButton
                                      label={language.t("session.goal.action.confirmStop")}
                                      variant="primary"
                                      tone="danger"
                                      busy={busy() === "clear"}
                                      disabled={busy() !== null || !props.sessionID}
                                      class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                      onClick={() => void stopGoal()}
                                    />
                                    <ActionButton
                                      label={language.t("session.goal.action.cancel")}
                                      variant="ghost"
                                      disabled={busy() !== null}
                                      class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                      onClick={closeRuntimePanel}
                                    />
                                  </div>
                                </div>
                              </Match>
                              <Match when={steerOpen()}>
                                <div
                                  data-component="goal-running-inline-panel"
                                  data-state="steer"
                                  class="grid min-h-9 min-w-0 grid-cols-[minmax(0,1fr)_minmax(124px,1fr)] gap-1.5 rounded-md border px-2 py-1.5"
                                  style={runningInlinePanelStyle("steer")}
                                >
                                  <div data-component="goal-runtime-steer-field" class="[grid-column:1/-1] min-w-0">
                                    <TextField
                                      value={steerText()}
                                      onChange={setSteerText}
                                      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" && steerText().trim() && busy() === null) void steerGoal() }}
                                      label={language.t("session.goal.action.steer")}
                                      hideLabel
                                      placeholder={language.t("session.goal.steer.placeholder")}
                                      aria-label={language.t("session.goal.action.steer")}
                                      disabled={busy() !== null}
                                      class="w-full min-w-0"
                                    />
                                  </div>
                                  <ActionButton
                                    label={language.t("session.goal.steer.send")}
                                    variant="primary"
                                    busy={busy() === "steer"}
                                    disabled={busy() !== null || !props.sessionID || !steerText().trim()}
                                    class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                    onClick={() => void steerGoal()}
                                  />
                                  <ActionButton
                                    label={language.t("session.goal.action.cancel")}
                                    variant="ghost"
                                    disabled={busy() !== null}
                                    class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                    onClick={() => {
                                      closeRuntimePanel()
                                      setSteerText("")
                                    }}
                                  />
                                </div>
                              </Match>
                              <Match when={handoffOpen()}>
                                <div
                                  data-component="goal-running-inline-panel"
                                  data-state="handoff"
                                  class="grid min-h-9 min-w-0 grid-cols-[minmax(0,1fr)_minmax(124px,1fr)] gap-1.5 rounded-md border px-2 py-1.5"
                                  style={runningInlinePanelStyle("handoff")}
                                >
                                  <div data-component="goal-runtime-handoff-field" class="[grid-column:1/-1] min-w-0">
                                    <TextField
                                      value={handoffText()}
                                      onChange={setHandoffText}
                                      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" && busy() === null) void handoffGoal() }}
                                      label={language.t("session.goal.action.handoff")}
                                      hideLabel
                                      placeholder={language.t("session.goal.handoff.placeholder")}
                                      aria-label={language.t("session.goal.action.handoff")}
                                      disabled={busy() !== null}
                                      class="w-full min-w-0"
                                    />
                                  </div>
                                  <ActionButton
                                    label={language.t("session.goal.handoff.send")}
                                    variant="primary"
                                    busy={busy() === "handoff"}
                                    disabled={busy() !== null || !props.sessionID}
                                    class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                    onClick={() => void handoffGoal()}
                                  />
                                  <ActionButton
                                    label={language.t("session.goal.action.cancel")}
                                    variant="ghost"
                                    disabled={busy() !== null}
                                    class="min-h-8 w-full min-w-0 px-2 text-center text-11-medium leading-tight"
                                    onClick={() => {
                                      closeRuntimePanel()
                                      setHandoffText("")
                                    }}
                                  />
                                </div>
                              </Match>
                            </Switch>
                            </div>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Show>

              <Show when={pendingHandoffMode() !== "hidden" ? handoff().handoff : null}>
                {(pending) => (
                  <div class="border-b px-3 py-2">
                    <div
                      data-component="goal-handoff-claim-panel"
                      data-mode={pendingHandoffMode()}
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
                      <Show
                        when={pendingHandoffMode() === "claim"}
                        fallback={
                          <div class="max-w-[220px] text-right text-11-regular leading-4 text-indigo-100/62">
                            {language.t("session.goal.handoff.liveRunPending")}
                          </div>
                        }
                      >
                        <ActionButton
                          label={language.t("session.goal.action.claim")}
                          variant="primary"
                          busy={busy() === "claim"}
                          disabled={busy() !== null || !props.sessionID}
                          class="h-8 shrink-0 px-3"
                          onClick={() => void claimGoalHandoff()}
                        />
                      </Show>
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
                      class="min-h-0 flex-1 overflow-x-auto overflow-y-auto rounded-lg border bg-background-base/76 p-1.5"
                      style={{ "border-color": "rgba(167, 139, 250, 0.10)", "box-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.012)" }}
                    >
                      <Show
                        when={visibleStepCount() > 0}
                        fallback={
                            <div
                              data-component="goal-chain-empty-state"
                              class="grid min-h-40 place-items-center rounded-md border px-4 py-6 text-center"
                              style={{
                                "background": "radial-gradient(circle at 50% 0%, rgba(120, 100, 200, 0.10), transparent 45%), linear-gradient(180deg, rgba(30, 25, 65, 0.10), rgba(18, 18, 18, 0.72))",
                                "border-color": "rgba(140, 120, 220, 0.14)",
                              }}
                            >
                            <div class="max-w-sm">
                              <div class="text-13-medium font-bold text-slate-50">
                                {language.t("session.goal.chainBuilder.emptyChain")}
                              </div>
                              <div class="mt-2 text-12-regular leading-5 text-slate-200/72">
                                {language.t("session.goal.chainBuilder.emptyChainDesc")}
                              </div>
                              <div
                                data-component="goal-chain-execution-note"
                                class="mt-3 rounded-md border px-2.5 py-2 text-left text-11-regular leading-5 text-slate-200/72"
                                style={{
                                  "background-color": "rgba(120, 100, 200, 0.06)",
                                  "border-color": "rgba(140, 120, 220, 0.14)",
                                }}
                              >
                                {language.t("session.goal.chainBuilder.emptyChainNote")}
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
                                class={`group grid min-w-0 grid-cols-[24px_32px_minmax(0,1fr)] items-center gap-x-1 gap-y-1 rounded-lg border px-1.5 py-2 transition hover:brightness-110 ${actionSurfaceClass(step)}`}
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
                                  class="relative row-span-2 flex h-full min-h-9 items-center justify-center"
                                  aria-hidden
                                >
                                  <span
                                    data-component="goal-chain-step-number"
                                    class="z-10 flex h-6 w-6 items-center justify-center rounded-full text-11-medium font-bold tabular-nums"
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
                                  class="row-span-2 flex h-8 w-8 items-center justify-center rounded-md border shadow-[0_6px_12px_rgba(0,0,0,0.14)]"
                                  style={chainStepBadgeStyle(step)}
                                  aria-hidden
                                >
                                  <IconV2 name={actionIconName(step)} size="small" />
                                </span>
                                <div class="flex min-w-0 flex-col self-center" title={stepRuntimeTitle(step)}>
                                  <div class="truncate text-13-medium font-semibold text-text-base">{step.label}</div>
                                  <Show when={cleanText(stepConditionPreview(step)) !== step.label}>
                                    <div
                                      class="mt-0.5 truncate text-[11px] leading-4 text-text-weaker"
                                      title={cleanText(stepConditionPreview(step))}
                                    >
                                      {cleanText(stepConditionPreview(step))}
                                    </div>
                                  </Show>
                                </div>
                                <div data-component="goal-chain-step-meta" class="col-start-3 flex min-w-0 flex-wrap items-center gap-1">
                                  <span
                                    class="flex h-6 max-w-[88px] min-w-[52px] items-center justify-center truncate rounded-md border px-1 text-[10px] font-semibold uppercase tracking-[0.08em]"
                                    style={chainStepSoftStyle(step)}
                                    title={inferActionCategory(step)}
                                  >
                                    {actionCategoryShortLabel(inferActionCategory(step))}
                                  </span>
                                  <span data-component="goal-chain-step-budget" class="grid w-[126px] shrink-0 grid-cols-[minmax(58px,1fr)_minmax(58px,1fr)] gap-1">
                                    <label
                                      class="grid h-6 grid-cols-[30px_minmax(26px,1fr)] items-center gap-1"
                                    >
                                      <span class="text-[9px] font-semibold uppercase text-sky-100/70">{language.t("session.goal.chainBuilder.stepTurns")}</span>
                                      <input
                                        aria-label={language.t("session.goal.chainBuilder.stepTurnsAria", { label: step.label })}
                                        type="number"
                                        min="1"
                                        value={String(step.maxTurns)}
                                        disabled={busy() !== null || !visibleChainRowsAreDraft()}
                                        onInput={(event) =>
                                          updateDraftStepBudget(step.id, "maxTurns", event.currentTarget.value)
                                        }
                                        class="h-6 w-full min-w-0 rounded-md border border-sky-200/14 bg-sky-950/16 px-0.5 text-center text-11-medium font-semibold tabular-nums text-text-base outline-none focus:border-sky-200/35"
                                      />
                                    </label>
                                    <label
                                      class="grid h-6 grid-cols-[22px_minmax(30px,1fr)] items-center gap-1"
                                    >
                                      <span class="text-[9px] font-semibold uppercase text-sky-100/70">{language.t("session.goal.chainBuilder.stepMinutes")}</span>
                                      <input
                                        aria-label={language.t("session.goal.chainBuilder.stepMinutesAria", { label: step.label })}
                                        type="number"
                                        min="1"
                                        value={String(step.maxTimeMinutes)}
                                        disabled={busy() !== null || !visibleChainRowsAreDraft()}
                                        onInput={(event) =>
                                          updateDraftStepBudget(step.id, "maxTimeMinutes", event.currentTarget.value)
                                        }
                                        class="h-6 w-full min-w-0 rounded-md border border-sky-200/14 bg-sky-950/16 px-0.5 text-center text-11-medium font-semibold tabular-nums text-text-base outline-none focus:border-sky-200/35"
                                      />
                                    </label>
                                  </span>
                                  <span data-component="goal-chain-step-actions" class="flex min-w-[108px] shrink-0 items-center justify-end gap-1">
                                    <button
                                      type="button"
                                      aria-label={language.t("session.goal.chainBuilder.stepEditAria", { label: step.label })}
                                      title={language.t("session.goal.template.editRunStep")}
                                      class={inlineCommandButtonClass("edit")}
                                      style={inlineCommandButtonStyle("edit")}
                                      disabled={busy() !== null || !visibleChainRowsAreDraft()}
                                      onClick={() => editChainStepDraft(step)}
                                    >
                                      <IconV2 name="edit" size="small" />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={language.t("session.goal.chainBuilder.moveUp")}
                                      title={language.t("session.goal.chainBuilder.moveUp")}
                                      class={inlineCommandButtonClass("move")}
                                      style={inlineCommandButtonStyle("move")}
                                      disabled={busy() !== null || !visibleChainRowsAreDraft() || i() === 0}
                                      onClick={() => moveDraftStep(i(), i() - 1)}
                                    >
                                      ↑
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={language.t("session.goal.chainBuilder.moveDown")}
                                      title={language.t("session.goal.chainBuilder.moveDown")}
                                      class={inlineCommandButtonClass("move")}
                                      style={inlineCommandButtonStyle("move")}
                                      disabled={busy() !== null || !visibleChainRowsAreDraft() || i() === visibleStepCount() - 1}
                                      onClick={() => moveDraftStep(i(), i() + 1)}
                                    >
                                      ↓
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={chainStepRemoveLabel(i())}
                                      title={chainStepRemoveLabel(i())}
                                      class={inlineCommandButtonClass("remove")}
                                      style={inlineCommandButtonStyle("remove")}
                                      disabled={chainStepRemoveDisabled(i())}
                                      // AG-P1-05 — pass the visible source
                                      // explicitly so the pure selector
                                      // decides the action kind instead
                                      // of `liveGoal()` being used as a
                                      // proxy inside removeVisibleStep.
                                      onClick={() =>
                                        removeVisibleStep(
                                          step,
                                          i(),
                                          visibleChainStepSource(),
                                        )
                                      }
                                    >
                                      ×
                                    </button>
                                  </span>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>

                    <Show when={!liveGoal()}>
                      <div
                        data-component="goal-chain-summary-line"
                        class="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-2 px-1 text-[10px] font-semibold text-text-weaker/60"
                        title={language.t("session.goal.chainBuilder.planChainHint")}
                      >
                        <span class="min-w-0 truncate">
                          {language.t("session.goal.chainBuilder.planChainHint")}
                        </span>
                        <div class="flex shrink-0 items-center gap-2">
                          <Show when={chainDraft.steps.length > 0}>
                            <button
                              type="button"
                              class="text-[10px] font-semibold text-text-weaker/50 transition hover:text-text-base"
                              title={language.t("session.goal.chainBuilder.clearDraftHint")}
                              disabled={busy() !== null}
                              onClick={() => {
                                // AG-P0-04 — explicit Clear Draft keeps
                                // `source: "draft"` so the empty state
                                // is recognized as intentional, not as
                                // "uninitialized → recoverable from runtime".
                                setChainDraft("source", "draft")
                                setChainDraft("steps", [])
                                setChainErrors([])
                              }}
                            >
                              {language.t("session.goal.chainBuilder.clearDraft")}
                            </button>
                          </Show>
                          <span class="tabular-nums text-text-weak">
                            {chainLimitSummary()}
                          </span>
                        </div>
                      </div>
                    </Show>

                    <Show when={liveGoal() || (unarchivedTerminalGoal() && activity().length > 0)}>
                      <div
                        data-component="goal-chain-running-activity"
                        class="mt-2 rounded-lg border p-2"
                        style={runningInlinePanelStyle("activity")}
                      >
                        <div class="mb-1.5 flex items-center justify-between gap-2">
                          <span class="text-[10px] font-bold uppercase tracking-[0.12em] text-cyan-100/78">
                            {language.t("session.goal.activity.title")}
                          </span>
                          <div class="flex items-center gap-2">
                            <Show when={activity().length > 4}>
                              <button
                                type="button"
                                class="text-[10px] font-semibold text-cyan-200/60 transition hover:text-cyan-100"
                                onClick={() => setActivityExpanded((v) => !v)}
                              >
                                {activityExpanded()
                                  ? language.t("session.goal.activity.showRecent")
                                  : language.t("session.goal.activity.showAll")}
                              </button>
                            </Show>
                            <span class={numericHighlightClass()} style={numericHighlightStyle("blue")}>
                              {activity().length}
                            </span>
                          </div>
                        </div>
                        <Show
                          when={activity().length > 0}
                          fallback={
                            <div class="text-11-regular text-text-weaker">
                              {language.t("session.goal.activity.empty")}
                            </div>
                          }
                        >
                          <div role="list" class={`grid gap-1 overflow-y-auto ${activityExpanded() ? "max-h-64" : "max-h-24"}`}>
                            <For each={activityExpanded() ? activity() : activity().slice(0, 4)}>
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
              <Show when={archive().length > 0 && !liveGoal()}>
                <GoalConsoleSection
                  zone="history"
                  title={language.t("session.goal.history.title")}
                  subtitle={language.t("session.goal.history.archivedRuns", { count: archive().length })}
                  class="bg-background-weak"
                >
                  <div
                    data-testid="run-history"
                    data-component="goal-history-panel"
                    class="min-h-0 flex-1 overflow-hidden p-2"
                  >
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 text-left"
                    onClick={() => setHistoryOpen((open) => !open)}
                    aria-expanded={historyOpen()}
                  >
                    <span class="text-12-regular text-text-weaker">
                      {language.t("session.goal.recentRuns")} ·{" "}
                      {language.t("session.goal.history.archivedRuns", { count: archive().length })}
                    </span>
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
                        class="max-h-72 overflow-y-auto rounded-lg border border-border-base bg-background-base"
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
                                  {outcomeLabel(h.summary.outcome)} ·{" "}
                                  {language.t("session.goal.history.turnCount", { count: h.summary.turns })} ·{" "}
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
                          <div class="min-w-0 rounded-lg border border-border-base bg-background-base p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
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
                                <div class="mt-1 text-11-regular text-text-weaker">
                                  {language.t("session.goal.history.details")}
                                </div>
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
                                label={language.t("session.goal.history.outcome")}
                                value={outcomeLabel(run().summary.outcome)}
                                tone={
                                  run().summary.status === "success"
                                    ? "success"
                                    : run().summary.status === "failure"
                                      ? "danger"
                                      : "warning"
                                }
                              />
                              <RunMetricPill
                                label={language.t("session.goal.history.turns")}
                                value={String(run().summary.turns)}
                              />
                              <RunMetricPill
                                label={language.t("session.goal.history.elapsed")}
                                value={formatElapsed(run().summary.elapsedMs)}
                              />
                              <RunMetricPill
                                label={language.t("session.goal.history.passed")}
                                value={String(run().summary.successCount)}
                                tone={run().summary.successCount > 0 ? "success" : "default"}
                              />
                              <RunMetricPill
                                label={language.t("session.goal.history.failed")}
                                value={String(run().summary.failureCount)}
                                tone={run().summary.failureCount > 0 ? "danger" : "default"}
                              />
                            </div>

                            <Show when={run().detail.latestReason}>
                              <div class="mt-3 rounded-md border border-border-base bg-background-stronger px-3 py-2.5">
                                <div class="text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                                  {language.t("session.goal.history.latestReason")}
                                </div>
                                <div class="mt-1 text-12-regular leading-5 text-text-weak">
                                  {cleanText(run().detail.latestReason)}
                                </div>
                              </div>
                            </Show>

                            <div class="mt-3 flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
                              <For each={run().detail.cycles}>
                                {(cycle) => (
                                  <div class="flex items-start gap-2 rounded-lg border border-border-base/70 bg-background-stronger/70 px-2 py-1.5 text-11-regular">
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
                </GoalConsoleSection>
              </Show>
              </div>


                <aside
                  data-component="goal-method-library-rail"
                  class="grid h-[min(100%,calc(100vh-9rem))] min-h-[520px] min-w-0 grid-cols-1 grid-rows-[minmax(220px,0.95fr)_minmax(260px,1.05fr)] gap-2 overflow-hidden"
                >
                  <GoalConsoleSection
                    zone="action-library"
                    title={language.t("session.goal.template.libraryShortTitle")}
                    subtitle={language.t("session.goal.template.librarySubtitle")}
                    class="min-h-[240px]"
                  >
                  <section data-testid="action-library" data-component="goal-method-library" class="flex h-full min-h-0 min-w-0 flex-col p-2">
                    <div
                      data-component="goal-method-library-header"
                      class="mb-1 flex min-w-0 items-center justify-between gap-2"
                    >
                      <span class="min-w-0 truncate text-[10px] font-medium leading-4 text-text-weaker">
                        {language.t("session.goal.template.libraryHint")}
                      </span>
                    </div>
                    <div
                      data-component="goal-method-category-tabs"
                      class="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(54px,1fr))] gap-0.5"
                    >
                      <For each={ACTION_CATEGORIES}>
                        {(category) => (
                          <button
                            type="button"
                            class="h-6 min-w-0 truncate rounded-md px-1.5 text-center text-[10px] font-semibold leading-tight hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
                            style={actionCategoryPillStyle(category, templateCategory() === category)}
                            title={category}
                            aria-label={category}
                            aria-pressed={templateCategory() === category}
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
                        aria-label={language.t("session.goal.template.search")}
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
                              class="group grid min-h-[30px] min-w-0 grid-cols-[minmax(0,1fr)_24px_24px] items-center gap-1 overflow-hidden rounded-md border px-1 py-0.5 hover:brightness-110"
                              style={actionLibraryRowStyle(t)}
                              classList={{
                                "outline outline-1 outline-offset-1 outline-emerald-200/65 brightness-110":
                                  selectedTemplateID() === t.id,
                              }}
                            >
                              <button
                                type="button"
                                data-component="goal-method-select"
                                class="grid w-full min-w-0 grid-cols-[minmax(0,0.72fr)_minmax(0,1fr)_8px] items-center gap-1 overflow-hidden rounded-md px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
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
                                disabled={busy() !== null || !t.condition || !!liveGoal()}
                                aria-label={language.t("session.goal.template.addToChain")}
                                title={liveGoal() ? language.t("session.goal.chainBuilder.addDisabledRunning") : language.t("session.goal.template.addToChain")}
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
                    class="min-h-[280px]"
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
                                class="h-6 w-full rounded-md border border-border-base/70 bg-background-base/80 px-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-base outline-none transition focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <For each={GOAL_TEMPLATE_CATEGORIES}>
                                  {(category) => (
                                    <option value={category} class="bg-background-base text-text-base">
                                      {actionCategoryShortLabel(category)}
                                    </option>
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
                              disabled={saveActionControl().disabled}
                              title={actionEditorReasonText(saveActionControl().reason) || undefined}
                              onClick={() => void saveTemplateDraft()}
                            />
                            <ActionButton
                              label={language.t("session.goal.template.duplicate")}
                              variant="secondary"
                              class="h-6 flex-1 px-2 text-11-medium"
                              busy={busy() === "template"}
                              disabled={duplicateActionControl().disabled}
                              title={actionEditorReasonText(duplicateActionControl().reason) || undefined}
                              onClick={() => void duplicateActionDraft()}
                            />
                            <ActionButton
                              label={language.t("session.goal.template.delete")}
                              variant="secondary"
                              tone="danger"
                              class="h-6 flex-1 px-2 text-11-medium"
                              busy={busy() === "template"}
                              disabled={deleteActionControl().disabled}
                              title={actionEditorReasonText(deleteActionControl().reason) || undefined}
                              onClick={() => {
                                const template = selectedTemplate()
                                if (template) void deleteActionTemplate(template)
                              }}
                            />
                          </div>
                          <Show when={actionEditorStatus()}>
                            <div data-component="goal-action-editor-status" class="mt-1 text-center text-[10px] text-orange-300/90">
                              {actionEditorStatus()}
                            </div>
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
                            data-component="goal-action-editor-agent"
                            class="grid h-7 min-w-0 grid-cols-[52px_minmax(0,1fr)] items-center gap-1.5 rounded-md border px-1.5"
                            style={{
                              "background-color": "rgba(129, 140, 248, 0.04)",
                              "border-color": "rgba(165, 180, 252, 0.14)",
                            }}
                          >
                            <span class="shrink-0 text-[9px] font-bold uppercase tracking-[0.1em] text-indigo-100/82">
                              {language.t("session.goal.template.pinnedAgent")}
                            </span>
                            <select
                              value={actionDraft.agent}
                              disabled={busy() !== null || !props.sessionID}
                              aria-label={language.t("session.goal.template.pinnedAgent")}
                              title={language.t("session.goal.template.pinnedAgent")}
                              onChange={(event) => setActionDraft("agent", event.currentTarget.value)}
                              class="h-6 min-w-0 truncate rounded-md bg-transparent px-1 text-11-medium font-semibold text-indigo-100/90 outline-none transition disabled:opacity-30"
                            >
                              <option value="" class="bg-background-base text-text-weak">{language.t("session.goal.template.sessionDefaultAgent")}</option>
                              <For each={agentOptionsForDraft()}>
                                {(option) => (
                                  <option value={option.name} class="bg-background-base text-text-base">
                                    {option.label}{option.mode === "subagent" ? " / subagent" : ""}
                                  </option>
                                )}
                              </For>
                            </select>
                          </div>
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
                              class="h-6 min-w-0 truncate rounded-md bg-transparent px-1 text-11-medium font-semibold text-sky-100/90 outline-none transition disabled:opacity-30"
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
                              class="flex h-6 min-w-0 items-center gap-1 rounded-full border px-1.5"
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
                                  class="h-6 min-w-0 flex-1 bg-transparent p-0 text-right text-11-medium font-bold tabular-nums text-blue-50/84 outline-none disabled:opacity-40"
                                />
                              </label>
                            </div>
                            <div
                              class="flex h-6 min-w-0 items-center gap-1 rounded-full border px-1.5"
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
                                  class="h-6 min-w-0 flex-1 bg-transparent p-0 text-right text-11-medium font-bold tabular-nums text-teal-50/84 outline-none disabled:opacity-40"
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
                              disabled={addSkillControl().disabled}
                              onChange={(event) => {
                                const name = event.currentTarget.value
                                if (name) toggleActionSkill(name)
                                event.currentTarget.value = ""
                              }}
                              class="h-6 min-w-0 truncate bg-transparent text-[10px] font-semibold text-emerald-100/82 outline-none transition disabled:opacity-35"
                              title={skillPickerReasonText(addSkillControl().reason) || language.t("session.goal.template.addSkill")}
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
                              {actionDraft.skills.length}/{ACTION_SKILL_LIMIT}
                            </span>
                            <Show when={addSkillStatus()}>
                              <div class="col-span-3 rounded-md border border-emerald-200/14 bg-emerald-500/8 px-2 py-1 text-[10px] font-medium text-emerald-100/76">
                                {addSkillStatus()}
                              </div>
                            </Show>
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
                                        class="max-w-[118px] truncate rounded-md border border-emerald-200/24 bg-emerald-500/13 px-1.5 py-0.5 text-left text-[10px] font-semibold text-emerald-100/90 transition hover:border-emerald-200/45 hover:bg-emerald-500/20 disabled:opacity-35"
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
                              {language.t("session.goal.template.detailsHeader")}
                            </span>
                          </div>
                          <TextField
                            value={actionDraft.label}
                            onChange={(value) => setActionDraft("label", value)}
                            label={language.t("session.goal.template.label")}
                            placeholder={language.t("session.goal.template.labelPlaceholder")}
                            aria-label={language.t("session.goal.template.label")}
                            disabled={busy() !== null || !props.sessionID}
                            class="w-full"
                          />
                          <TextField
                            value={actionDraft.prompt}
                            onChange={(value) => setActionDraft("prompt", value)}
                            label={language.t("session.goal.template.prompt")}
                            aria-label={language.t("session.goal.template.prompt")}
                            multiline
                            disabled={busy() !== null || !props.sessionID}
                            class="min-h-[76px] w-full"
                          />
                          <TextField
                            value={actionDraft.command}
                            onChange={(value) => setActionDraft("command", value)}
                            label={language.t("session.goal.template.command")}
                            placeholder={language.t("session.goal.create.commandPlaceholder")}
                            aria-label={language.t("session.goal.template.command")}
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

     
    </div>
  )
}
