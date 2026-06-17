import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

import {
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
  MAX_RENDERER_STATE_BYTES,
  isGoalStateShape,
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
  readGoalFromSdk,
  templateButtonsFromSnapshot,
  templateDraftFromButton,
  templateVariableDefaults,
  DEFAULT_TEMPLATE_BUTTONS,
  GOAL_TEMPLATE_CATEGORIES,
  GOAL_TEMPLATE_ELEVATIONS,
  GOAL_TEMPLATE_GATES,
  GOAL_TEMPLATE_TONES,
  type GoalSdkClient,
  type GoalChainDraftStep,
  type GoalTemplateButton,
  type GoalTemplateCategory,
  type GoalTemplateElevation,
  type GoalTemplateGate,
  type GoalTemplateTone,
} from "./goal-panel-pure"
import { executeGoalCommand, startGoalRun, stopGoalRun } from "./goal-panel-actions"
// `GoalState` and `GoalStore` are re-exported as types above; aliasing
// them as locals is unnecessary because we only need them as type
// annotations, which the imported type re-exports satisfy directly.

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
    tool: {
      control?: (args: {
        toolID: "goal_control"
        sessionID: string
        arguments: { command: string }
      }) => Promise<unknown>
    }
    session?: {
      command?: (args: { sessionID: string; command: string; arguments: string }) => Promise<unknown>
    }
    file: {
      read: (args: { path: string }) => Promise<{ data: unknown }>
    }
  }
}

type GoalAction = "pause" | "resume" | "restart" | "clear"

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
  category?: GoalTemplateCategory
  gate?: GoalTemplateGate
  tone?: GoalTemplateTone
  elevation?: GoalTemplateElevation
}
export interface ChainData {
  steps: ChainStep[]
  current: number
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
    const steps: ChainStep[] = c.steps
      .filter((s: unknown) => s && typeof (s as ChainStep).condition === "string")
      .map((s: ChainStep) => ({
        condition: s.condition,
        command: s.command ?? null,
        ...((GOAL_TEMPLATE_CATEGORIES as readonly string[]).includes(s.category ?? "") ? { category: s.category } : {}),
        ...((GOAL_TEMPLATE_GATES as readonly string[]).includes(s.gate ?? "") ? { gate: s.gate } : {}),
        ...((GOAL_TEMPLATE_TONES as readonly string[]).includes(s.tone ?? "") ? { tone: s.tone } : {}),
        ...((GOAL_TEMPLATE_ELEVATIONS as readonly string[]).includes(s.elevation ?? "")
          ? { elevation: s.elevation }
          : {}),
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
  label: string
  class?: string
}) {
  return (
    <Button
      variant={props.variant ?? "secondary"}
      size="small"
      class={`${props.class ?? ""} ring-1 ring-transparent transition-shadow hover:ring-border-strong focus-visible:ring-border-strong`}
      onClick={() => props.onClick()}
      disabled={props.disabled}
      aria-label={props.label}
    >
      {props.busy ? "…" : props.label}
    </Button>
  )
}

function RunMetricPill(props: {
  label: string
  value: string
  detail?: string
  tone?: "default" | "success" | "warning" | "danger"
}) {
  return (
    <div
      class="grid min-w-0 grid-cols-[3px_minmax(0,1fr)] overflow-hidden rounded-lg border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
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
      <div class="min-w-0 px-2.5 py-1.5">
        <div class="break-words text-[10px] font-medium uppercase leading-3 tracking-[0.08em] text-text-weaker">
          {props.label}
        </div>
        <div class="mt-0.5 break-words text-12-medium tabular-nums leading-4 text-text-base" title={props.value}>
          {props.value}
        </div>
        <Show when={props.detail}>
          <div class="mt-0.5 break-words text-[11px] leading-4 text-text-weaker">{props.detail}</div>
        </Show>
      </div>
    </div>
  )
}

function BudgetDial(props: {
  label: string
  value: string
  detail: string
  disabled?: boolean
  decreaseLabel: string
  increaseLabel: string
  onDecrease: () => void
  onIncrease: () => void
}) {
  return (
    <div class="rounded-xl border border-border-base bg-background-panel/70 px-3 py-2.5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-[11px] font-medium uppercase tracking-[0.12em] text-text-weaker">{props.label}</div>
          <div class="mt-1 text-base font-semibold tabular-nums text-text-base">{props.value}</div>
          <div class="mt-1 text-[11px] text-text-weaker">{props.detail}</div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-md border border-border-base bg-background-base text-sm text-text-base transition-all hover:border-border-strong hover:bg-white/[0.06] hover:ring-1 hover:ring-border-strong focus-visible:ring-1 focus-visible:ring-border-strong disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={props.decreaseLabel}
            disabled={props.disabled}
            onClick={props.onDecrease}
          >
            -
          </button>
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-md border border-border-base bg-background-base text-sm text-text-base transition-all hover:border-border-strong hover:bg-white/[0.06] hover:ring-1 hover:ring-border-strong focus-visible:ring-1 focus-visible:ring-border-strong disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={props.increaseLabel}
            disabled={props.disabled}
            onClick={props.onIncrease}
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}

const ACTION_CATEGORIES = ["All", ...GOAL_TEMPLATE_CATEGORIES] as const

type ActionCategory = (typeof ACTION_CATEGORIES)[number]

const ACTION_TONE_LABELS: Record<GoalTemplateTone, string> = {
  violet: "Violet",
  blue: "Blue",
  orange: "Orange",
  emerald: "Emerald",
  fuchsia: "Fuchsia",
  sky: "Sky",
}

const ACTION_ELEVATION_LABELS: Record<GoalTemplateElevation, string> = {
  flat: "Flat",
  raised: "Raised",
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
  gate?: GoalTemplateGate
  builtin?: boolean
}

function isActionCategory(value: string): value is ActionCategory {
  return (ACTION_CATEGORIES as readonly string[]).includes(value)
}

function actionLabelText(input: ActionDescriptor) {
  return `${input.label ?? ""} ${input.id ?? ""} ${input.actionID ?? ""}`.toLowerCase()
}

function actionSearchText(input: ActionDescriptor) {
  return `${actionLabelText(input)} ${input.description ?? ""} ${input.condition ?? ""} ${input.command ?? ""}`.toLowerCase()
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

function actionToneClass(input: ActionDescriptor) {
  const tone = input.tone ?? inferredActionTone(input)
  if (tone === "orange") return "border-orange-400/40 bg-orange-500/15 text-orange-200"
  if (tone === "emerald") return "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
  if (tone === "fuchsia") return "border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-200"
  if (tone === "sky") return "border-sky-400/40 bg-sky-500/15 text-sky-200"
  if (tone === "blue") return "border-blue-400/40 bg-blue-500/15 text-blue-200"
  return "border-violet-400/40 bg-violet-500/15 text-violet-200"
}

function actionToneSwatchClass(tone: GoalTemplateTone) {
  if (tone === "orange") return "border-orange-400/70 bg-orange-400"
  if (tone === "emerald") return "border-emerald-400/70 bg-emerald-400"
  if (tone === "fuchsia") return "border-fuchsia-400/70 bg-fuchsia-400"
  if (tone === "sky") return "border-sky-400/70 bg-sky-400"
  if (tone === "blue") return "border-blue-400/70 bg-blue-400"
  return "border-violet-400/70 bg-violet-400"
}

function actionSurfaceClass(input: ActionDescriptor) {
  return input.elevation === "raised"
    ? "shadow-[0_10px_24px_rgba(0,0,0,0.24)] ring-1 ring-white/[0.04]"
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

/** Method Library tags shown on each card and in the detail header: a
 *  BUILT-IN badge for shipped methods, plus PROMPT (no verify command) or
 *  VERIFY (has one) so the method's kind is legible at a glance. */
function methodTags(input: { builtin?: boolean; command?: string | null }): string[] {
  const tags: string[] = []
  if (input.builtin) tags.push("BUILT-IN")
  tags.push(hasVerificationCommand(input) ? "VERIFY" : "PROMPT")
  return tags
}

const ACTION_GATE_LABELS: Record<GoalTemplateGate, string> = {
  required: "Run",
  pass: "Pass gate",
  verify: "Verify",
  review: "Review",
}

/** Resolve a chain step / method's checkpoint gate: an explicit gate wins,
 *  otherwise a method with a verify command is a "verify" checkpoint and a
 *  plain prompt step is a "required" run step. */
function inferActionGate(input: ActionDescriptor): GoalTemplateGate {
  if (input.gate && (GOAL_TEMPLATE_GATES as readonly string[]).includes(input.gate)) return input.gate
  return hasVerificationCommand(input) ? "verify" : "required"
}

function stepGateLabel(input: ActionDescriptor): string {
  return ACTION_GATE_LABELS[inferActionGate(input)]
}

function runtimeCheckLabel(input: ActionDescriptor) {
  return hasVerificationCommand(input) ? "Shell command" : "GOAL_COMPLETE marker"
}

function completionRuleLabel(input: ActionDescriptor) {
  return hasVerificationCommand(input) ? "Done when command exits 0" : "Done when GOAL_COMPLETE is written"
}

function completionRuleShortLabel(input: ActionDescriptor) {
  return hasVerificationCommand(input) ? "command" : "marker"
}

function completionRuleClass(input: ActionDescriptor) {
  return hasVerificationCommand(input)
    ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-200"
    : "border-border-base bg-background-panel/70 text-text-weaker"
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
    const gate: unknown = Reflect.get(step, "gate")
    const tone: unknown = Reflect.get(step, "tone")
    const elevation: unknown = Reflect.get(step, "elevation")
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
      (gate === undefined || (typeof gate === "string" && (GOAL_TEMPLATE_GATES as readonly string[]).includes(gate))) &&
      (tone === undefined || (typeof tone === "string" && (GOAL_TEMPLATE_TONES as readonly string[]).includes(tone))) &&
      (elevation === undefined ||
        (typeof elevation === "string" && (GOAL_TEMPLATE_ELEVATIONS as readonly string[]).includes(elevation))) &&
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
        ...(step.gate ? { gate: step.gate } : {}),
        ...(step.tone ? { tone: step.tone } : {}),
        ...(step.elevation ? { elevation: step.elevation } : {}),
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
  const sdk = useSDK() as unknown as GoalActionClient
  const sync = useSync()
  const state = () => props.goal.store.state

  const [busy, setBusy] = createSignal<GoalAction | "set" | "steer" | "budget" | "step" | "template" | "chain" | null>(
    null,
  )
  // Optimistic pause/resume: the instant the user clicks, we record the status
  // they drove the goal toward so the single toggle flips immediately, instead
  // of lagging the 2s poll (and risking a stale command). Cleared once the
  // polled status catches up — or reverted if the command failed.
  const [optimisticStatus, setOptimisticStatus] = createSignal<"active" | "paused" | null>(null)
  const [confirmingClear, setConfirmingClear] = createSignal(false)
  const [newCondition, setNewCondition] = createSignal("")
  const [newCommand, setNewCommand] = createSignal("")
  const [steerOpen, setSteerOpen] = createSignal(false)
  const [steerText, setSteerText] = createSignal("")
  // When true, show the create form even though a goal exists (the "New goal"
  // affordance), so the panel is never a dead end — including on achieved goals.
  const [showCreate, setShowCreate] = createSignal(false)
  const [activity, setActivity] = createSignal<ActivityEvent[]>([])
  const [chain, setChain] = createSignal<ChainData | null>(null)
  const [templates, setTemplates] = createSignal(DEFAULT_TEMPLATE_BUTTONS)
  const [selectedTemplateID, setSelectedTemplateID] = createSignal<string | null>(null)
  const [templateVars, setTemplateVars] = createSignal<Record<string, string>>({})
  const [templateSearch, setTemplateSearch] = createSignal("")
  const [templateCategory, setTemplateCategory] = createSignal<ActionCategory>("All")
  const [chainDraft, setChainDraft] = createStore<ChainDraftState>(readStoredChainDraft(props.sessionID))
  const [actionDraft, setActionDraft] = createStore<{
    open: boolean
    sourceID: string
    id: string
    label: string
    prompt: string
    command: string
    turns: number
    minutes: number
    category: GoalTemplateCategory
    gate: GoalTemplateGate
    tone: GoalTemplateTone
    elevation: GoalTemplateElevation
  }>({
    open: false,
    sourceID: "",
    id: "",
    label: "",
    prompt: "",
    command: "",
    turns: 5,
    minutes: 20,
    category: "Custom",
    gate: "required",
    tone: "violet",
    elevation: "flat",
  })
  const [archive, setArchive] = createSignal<HistoryRun[]>([])
  const [historyOpen, setHistoryOpen] = createSignal(true)
  const [selectedHistoryGoalID, setSelectedHistoryGoalID] = createSignal<string | null>(null)
  const [addingStep, setAddingStep] = createSignal(false)
  const [stepText, setStepText] = createSignal("")

  createEffect(() => {
    writeStoredChainDraft(props.sessionID, {
      steps: chainDraft.steps.map((step) => ({ ...step })),
      master: {
        maxTurns: chainDraft.master.maxTurns,
        maxTimeMinutes: chainDraft.master.maxTimeMinutes,
      },
    })
  })

  const refreshArchive = () =>
    void readArchive(sdk).then((runs) => {
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
  const refreshTemplates = () =>
    void readTemplates(sdk).then((next) => {
      setTemplates(next)
      if (!selectedTemplateID() || !next.some((template) => template.id === selectedTemplateID())) {
        setSelectedTemplateID(next[0]?.id ?? null)
      }
    })

  onMount(() => {
    const tick = () => {
      void readActivity(sdk).then(setActivity)
      void readChain(sdk).then(setChain)
      refreshTemplates()
      refreshArchive()
    }
    tick()
    const timer = setInterval(tick, 2000)
    onCleanup(() => clearInterval(timer))
  })

  const refreshChain = () => void readChain(sdk).then(setChain)

  /** Sub-goal steps map to the engine's chain. Add appends a step; the up/down
   *  arrows reorder. Both go through `/goal chain …` commands. */
  const addStep = async () => {
    const cond = stepText().trim().replace(/"/g, "")
    if (!cond) return
    const sent = await sendGoalCommand("step", `chain add "${cond}"`)
    if (sent) {
      setStepText("")
      setAddingStep(false)
      refreshChain()
    }
  }
  const moveStep = async (from: number, to: number) => {
    if (to < 0) return
    await sendGoalCommand("step", `chain move ${from} ${to}`)
    refreshChain()
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
    const ok = await executeGoalCommand(sdk.client, { sessionID, arguments: args, directory: sdk.directory })
    try {
      await props.goal.refresh()
      refreshChain()
      refreshArchive()
    } finally {
      setBusy(null)
      if (ok) setConfirmingClear(false)
      if (ok && label === "set") setShowCreate(false)
      if (ok && label === "template") refreshTemplates()
    }
    return ok
  }

  const runAction = (action: GoalAction) => sendGoalCommand(action, action)

  const stopGoal = async () => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return false
    const aborting = stopGoalRun(sdk.client, { sessionID, directory: sdk.directory })
    const clearing = sendGoalCommand("clear", "clear")
    const [cleared] = await Promise.all([clearing, aborting])
    return cleared
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
        await startGoalRun(sdk.client, {
          sessionID: props.sessionID,
          directory: sdk.directory,
        })
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
      setSteerText("")
      setSteerOpen(false)
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
        completionRuleLabel(template),
      ].some((value) => cleanText(value).toLowerCase().includes(query))
    })
  })
  const categoryCounts = createMemo(() => {
    const counts: Record<ActionCategory, number> = {
      All: templates().length,
      Planning: 0,
      Building: 0,
      Debugging: 0,
      Testing: 0,
      Review: 0,
      Documentation: 0,
      Custom: 0,
    }
    for (const template of templates()) counts[inferActionCategory(template)] += 1
    return counts
  })
  const selectedTemplate = createMemo(() => templates().find((t) => t.id === selectedTemplateID()) ?? null)
  const selectedTemplateVariables = createMemo(() => Object.entries(selectedTemplate()?.variables ?? {}))
  const masterTurns = () => chainDraft.master.maxTurns
  const masterMinutes = () => chainDraft.master.maxTimeMinutes
  const budgetSummary = createMemo(() =>
    chainBudgetSummary(chainDraft.steps, {
      maxTurns: chainDraft.master.maxTurns,
      maxTimeMinutes: chainDraft.master.maxTimeMinutes,
    }),
  )
  const chainCommandCheckCount = createMemo(() => chainDraft.steps.filter((step) => hasVerificationCommand(step)).length)
  const chainMarkerCheckCount = createMemo(() => Math.max(0, chainDraft.steps.length - chainCommandCheckCount()))
  const chainGateCount = createMemo(() => chainDraft.steps.filter((step) => inferActionGate(step) !== "required").length)
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
  const applyTemplateDraft = (template: GoalTemplateButton, vars = templateVariableDefaults(template)) => {
    setSelectedTemplateID(template.id)
    setTemplateVars(vars)
    const draft = templateDraftFromButton(template, vars)
    setNewCondition(draft.condition)
    setNewCommand(draft.command)
    setShowCreate(true)
  }
  const selectActionForView = (template: GoalTemplateButton) => {
    setSelectedTemplateID(template.id)
    setTemplateVars(templateVariableDefaults(template))
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
  const openActionEditor = (template?: GoalTemplateButton) => {
    const c = template?.constraints
    setActionDraft({
      open: true,
      sourceID: template?.id ?? "",
      id: template ? (template.builtin ? `${template.id}-custom` : template.id) : uniqueTemplateID("custom-action"),
      label: template?.label ?? "",
      prompt: template?.condition ?? "",
      command: template?.command ?? "",
      turns: typeof c?.maxTurns === "number" ? c.maxTurns : 5,
      minutes: typeof c?.maxTimeMinutes === "number" ? c.maxTimeMinutes : 20,
      category: template ? inferActionCategory(template) : "Custom",
      gate: template ? inferActionGate(template) : "required",
      tone: template?.tone ?? inferredActionTone(template ?? {}),
      elevation: template?.elevation ?? "flat",
    })
  }
  const editTemplateDraft = (template: GoalTemplateButton) => {
    openActionEditor(template)
  }
  const updateTemplateVariable = (key: string, value: string) => {
    const next = { ...templateVars(), [key]: value }
    setTemplateVars(next)
    const template = selectedTemplate()
    if (!template) return
    const draft = templateDraftFromButton(template, next)
    setNewCondition(draft.condition)
    setNewCommand(draft.command)
  }
  const saveTemplateDraft = async () => {
    const id = actionDraft.id.trim()
    const condition = actionDraft.prompt.trim()
    if (!TEMPLATE_SAVE_ID_RE.test(id) || !condition) return
    const label = actionDraft.label.trim() || id
    const payload: Record<string, unknown> = {
      label,
      condition,
      description: label || (condition.length > 80 ? `${condition.slice(0, 77)}...` : condition),
      constraints: {
        maxTurns: Math.max(1, Math.round(actionDraft.turns)),
        maxTimeMinutes: Math.max(1, Math.round(actionDraft.minutes)),
      },
      category: actionDraft.category,
      gate: actionDraft.gate,
      tone: actionDraft.tone,
      elevation: actionDraft.elevation,
    }
    const command = actionDraft.command?.trim()
    if (command) payload.command = command
    const sent = await sendGoalCommand("template", `template import ${id} ${JSON.stringify(payload)}`)
    if (sent) {
      setSelectedTemplateID(id)
      setActionDraft("open", false)
    }
  }
  const duplicateActionTemplate = async (template: GoalTemplateButton) => {
    if (!template.condition) return
    const id = uniqueTemplateID(`${template.id}-copy`)
    const payload = templatePayload(template)
    const sent = await sendGoalCommand("template", `template import ${id} ${JSON.stringify(payload)}`)
    if (sent) {
      setSelectedTemplateID(id)
    }
  }
  const deleteActionTemplate = async (template: GoalTemplateButton) => {
    if (template.builtin) return
    const sent = await sendGoalCommand("template", `template delete ${template.id}`)
    if (sent) {
      setSelectedTemplateID(templates().find((candidate) => candidate.id !== template.id)?.id ?? null)
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
    gate: inferActionGate(template),
    ...(template.tone ? { tone: template.tone } : {}),
    ...(template.elevation ? { elevation: template.elevation } : {}),
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
  const startGoalChain = async () => {
    if (chainDraft.steps.length === 0) return
    const payload = JSON.stringify({
      master: { maxTurns: chainDraft.master.maxTurns, maxMinutes: chainDraft.master.maxTimeMinutes },
      steps: chainDraft.steps.map((step) => ({
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
        ...(step.gate ? { gate: step.gate } : {}),
        ...(step.tone ? { tone: step.tone } : {}),
        ...(step.elevation ? { elevation: step.elevation } : {}),
      })),
    })
    const sent = await sendGoalCommand("chain", `chain start-json ${payload}`)
    if (sent) {
      if (props.sessionID) {
        await startGoalRun(sdk.client, {
          sessionID: props.sessionID,
          directory: sdk.directory,
        })
      }
      setChainDraft("steps", [])
      setShowCreate(false)
    }
  }

  /** Raise/lower a live budget inline. The goal plugin enforces the hard-stop
   *  semantics; the dock just sends the new cap via `/goal turns|time <n>`.
   *  Guards against decreasing below current usage (which would trip the
   *  constraint on the next evaluation). */
  const adjustBudget = (field: "turns" | "time", current: number, delta: number) => {
    const s = state()
    if (!s) return
    const used = field === "turns" ? s.turnsEvaluated : elapsedMinutes()
    const next = Math.max(1, current + delta)
    if (next === current) return
    // Don't let the user set the cap below what's already been used — that
    // would cause an immediate constraint stop on the next evaluation, which
    // reads as a broken button.
    if (next < used) return
    void sendGoalCommand("budget", `${field} ${next}`)
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

  const selectedHistoryRun = createMemo(
    () => archive().find((run) => run.summary.goalID === selectedHistoryGoalID()) ?? null,
  )
  const goalCommandAvailable = createMemo(() => sync.data.command.some((item) => item.name === "goal"))
  const goalCommandUnavailable = createMemo(() => sync.ready && !goalCommandAvailable())

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
  const unarchivedTerminalGoal = createMemo(() => {
    const goal = terminalGoal()
    if (!goal) return null
    if (archive().some((run) => run.summary.goalID === goal.id)) return null
    return goal
  })

  // The pause/resume toggle's next action, honoring the optimistic override.
  const pauseResume = createMemo(() => pauseResumeAction(state()?.status, optimisticStatus()))

  // Drop the optimistic override once the polled status catches up to it (or
  // the goal leaves the active/paused cycle entirely), so the toggle resumes
  // tracking real state. Without this the override could pin a stale label if
  // the command silently no-op'd.
  createEffect(() => {
    const opt = optimisticStatus()
    if (!opt) return
    const real = state()?.status
    if (real === opt || (real !== "active" && real !== "paused")) {
      setOptimisticStatus(null)
    }
  })

  const verifyCommand = createMemo(() => cleanText(liveGoal()?.command ?? ""))
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
        <Match when={props.goal.store.loaded && !props.goal.store.corrupt && showForm()}>
          <div data-component="goal-playbook-workspace" class="flex min-w-0 flex-col gap-2.5 pb-2">
            <Show when={unarchivedTerminalGoal()} keyed>
              {(terminal) => (
                <div
                  data-component="goal-terminal-summary"
                  class="min-w-0 rounded-lg border border-border-base bg-background-panel/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="text-[11px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                        {language.t("session.goal.lastResult")}
                      </div>
                      <div class="mt-1 break-words text-13-medium text-text-base" title={cleanText(terminal.condition)}>
                        {cleanText(terminal.condition)}
                      </div>
                    </div>
                    <span
                      class={`shrink-0 rounded-md border border-border-base bg-background-base/80 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] ${statusMeta(terminal.status).text}`}
                    >
                      {statusMeta(terminal.status).label}
                    </span>
                  </div>
                  <div class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3">
                    <RunMetricPill
                      label="Status"
                      value={statusMeta(terminal.status).label}
                      detail="state file"
                      tone={terminal.status === "achieved" ? "success" : "warning"}
                    />
                    <RunMetricPill label="Turns" value={String(terminal.turnsEvaluated)} detail="evaluated" />
                    <RunMetricPill
                      label="Elapsed"
                      value={formatElapsed((terminal.completedAt ?? Date.now()) - terminal.startedAt)}
                      detail="runtime"
                    />
                  </div>
                  <Show when={terminal.lastEvaluation?.reason}>
                    <div class="mt-3 rounded-md border border-border-base bg-background-base/70 px-3 py-2 text-12-regular leading-5 text-text-weak">
                      {cleanText(terminal.lastEvaluation!.reason)}
                    </div>
                  </Show>
                </div>
              )}
            </Show>
            <div
              data-component="goal-playbook-setup"
              class="grid min-w-0 grid-cols-1 gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(460px,0.78fr)]"
            >
              <div class="min-w-0 rounded-lg border border-border-base bg-background-panel/60 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="h-2 w-2 rounded-full bg-text-weaker/50 shrink-0" aria-hidden />
                    <div class="text-11-regular font-medium uppercase tracking-[0.12em] text-text-weaker truncate">
                      {language.t("session.goal.create.title")}
                    </div>
                  </div>
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
                <Show when={goalCommandUnavailable()}>
                  <div class="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/8 px-3 py-2 text-11-regular text-text-weak">
                    This workspace does not expose <code>/goal</code>. Open the session in a repo with OpenGoal enabled
                    to set or control goals.
                  </div>
                </Show>
                <div class="mt-3 grid grid-cols-1 gap-2">
                  <TextField
                    value={newCondition()}
                    onChange={setNewCondition}
                    label={language.t("session.goal.create.condition")}
                    hideLabel
                    placeholder={language.t("session.goal.create.conditionPlaceholder")}
                    disabled={busy() !== null || !props.sessionID || goalCommandUnavailable()}
                    class="w-full"
                  />
                  <TextField
                    value={newCommand()}
                    onChange={setNewCommand}
                    label={language.t("session.goal.create.command")}
                    hideLabel
                    placeholder={language.t("session.goal.create.commandPlaceholder")}
                    disabled={busy() !== null || !props.sessionID || goalCommandUnavailable()}
                    class="w-full"
                  />
                  <Button
                    variant="primary"
                    class="h-10 w-full"
                    onClick={() => void createGoal()}
                    disabled={!newCondition().trim() || !props.sessionID || busy() !== null || goalCommandUnavailable()}
                  >
                    {busy() === "set" ? "…" : language.t("session.goal.create.submit")}
                  </Button>
                </div>
              </div>

              <div
                data-component="goal-playbook-budget-strip"
                class="grid grid-cols-2 gap-1.5 rounded-lg border border-border-base bg-background-panel/45 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] sm:grid-cols-3 2xl:grid-cols-5"
              >
                <RunMetricPill label="Max turns" value={String(masterTurns())} detail="master cap" />
                <RunMetricPill label="Steps" value={String(budgetSummary().stepCount)} detail="queued" />
                <RunMetricPill
                  label="Est. turns"
                  value={String(budgetSummary().effectiveTurns)}
                  detail="possible max"
                />
                <RunMetricPill
                  label="Checks"
                  value={`${chainCommandCheckCount()} cmd`}
                  detail={`${chainMarkerCheckCount()} marker`}
                />
                <RunMetricPill label="Budget" value={`${masterMinutes()}m`} detail="per run" />
              </div>
            </div>
            <div
              data-component="goal-chain-builder"
              class="overflow-hidden rounded-lg border border-border-base bg-background-panel/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
            >
              <div class="flex items-center justify-between gap-3 border-b border-border-base bg-background-base/55 px-3 py-2">
                <div class="min-w-0">
                  <div class="text-11-regular font-medium uppercase tracking-[0.12em] text-text-weaker">
                    {language.t("session.goal.chainBuilder.title")}
                  </div>
                  <div class="mt-0.5 truncate font-mono text-[10px] text-text-weaker">
                    {language.t("session.goal.chainBuilder.path")}
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <span class="rounded-md border border-border-base bg-background-base/70 px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-text-weaker">
                    {chainDraft.steps.length} {language.t("session.goal.chainBuilder.steps")}
                  </span>
                  <ActionButton
                    label={language.t("session.goal.chainBuilder.start")}
                    variant="primary"
                    busy={busy() === "chain"}
                    disabled={
                      busy() !== null || !props.sessionID || goalCommandUnavailable() || chainDraft.steps.length === 0
                    }
                    onClick={() => void startGoalChain()}
                  />
                </div>
              </div>

              <div class="grid grid-cols-1 items-start lg:grid-cols-[minmax(540px,1.5fr)_minmax(360px,0.82fr)]">
                <div
                  data-component="goal-playbook-chain-pane"
                  class="min-w-0 border-b border-border-base bg-background-base/50 lg:border-b-0 lg:border-r"
                >
                  <div data-component="goal-plan-chain" class="min-w-0 p-2.5">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="text-12-medium text-text-base">
                          {language.t("session.goal.chainBuilder.planChain")}
                        </div>
                        <div class="mt-1 text-11-regular text-text-weaker">
                          {language.t("session.goal.chainBuilder.planChainHint")}
                        </div>
                      </div>
                    </div>

                    <div class="mt-2.5 overflow-x-auto rounded-lg border border-border-base bg-background-panel/70 p-1.5">
                      <Show
                        when={chainDraft.steps.length > 0}
                        fallback={
                          <div class="px-3 py-6 text-center text-11-regular text-text-weaker">
                            {language.t("session.goal.chainBuilder.emptyChain")}
                          </div>
                        }
                      >
                        <div class="flex min-w-[720px] flex-col gap-1">
                          <For each={chainDraft.steps}>
                            {(step, i) => (
                              <div
                                data-component="goal-chain-step-row"
                                data-density="compact-chain-row"
                                class={`group grid min-w-0 grid-cols-[16px_30px_30px_minmax(160px,1fr)_58px_58px_92px_82px] items-center gap-1.5 rounded-md border border-border-base bg-background-base/75 px-2 py-1.5 ${actionSurfaceClass(step)}`}
                              >
                                <span
                                  data-component="goal-chain-run-rail"
                                  class="relative flex h-9 items-center justify-center"
                                  aria-hidden
                                >
                                  <span class="absolute inset-y-[-8px] left-1/2 border-l border-border-base/70" />
                                  <span class="relative h-2 w-2 rounded-full border border-border-strong bg-background-panel" />
                                </span>
                                <span class="flex h-7 items-center justify-center rounded-md border border-border-base bg-background-panel text-11-medium tabular-nums text-text-base">
                                  {i() + 1}
                                </span>
                                <span
                                  class={`flex h-7 w-7 items-center justify-center rounded-md border ${actionToneClass(step)}`}
                                  aria-hidden
                                >
                                  <IconV2 name={actionIconName(step)} size="small" />
                                </span>
                                <div class="min-w-0">
                                  <div class="truncate text-12-medium text-text-base">{step.label}</div>
                                  <div
                                    class="mt-0.5 truncate text-[11px] leading-4 text-text-weaker"
                                    title={cleanText(step.condition)}
                                  >
                                    {inferActionCategory(step)} · {cleanText(step.condition)}
                                  </div>
                                </div>
                                <label class="grid h-8 grid-cols-[auto_minmax(0,1fr)] items-center gap-1 rounded-md border border-border-base bg-background-panel/80 px-1.5">
                                  <span class="text-[9px] uppercase tracking-[0.08em] text-text-weaker">T</span>
                                  <input
                                    aria-label={`Turns for ${step.label}`}
                                    type="number"
                                    min="1"
                                    value={String(step.maxTurns)}
                                    disabled={busy() !== null}
                                    onInput={(event) =>
                                      updateDraftStepBudget(step.id, "maxTurns", event.currentTarget.value)
                                    }
                                    class="w-full bg-transparent text-12-medium tabular-nums text-text-base outline-none"
                                  />
                                </label>
                                <label class="grid h-8 grid-cols-[auto_minmax(0,1fr)] items-center gap-1 rounded-md border border-border-base bg-background-panel/80 px-1.5">
                                  <span class="text-[9px] uppercase tracking-[0.08em] text-text-weaker">M</span>
                                  <input
                                    aria-label={`Minutes for ${step.label}`}
                                    type="number"
                                    min="1"
                                    value={String(step.maxTimeMinutes)}
                                    disabled={busy() !== null}
                                    onInput={(event) =>
                                      updateDraftStepBudget(step.id, "maxTimeMinutes", event.currentTarget.value)
                                    }
                                    class="w-full bg-transparent text-12-medium tabular-nums text-text-base outline-none"
                                  />
                                </label>
                                <span
                                  class="flex h-8 items-center justify-center rounded-md border px-2 text-[10px] font-medium"
                                  classList={{
                                    "border-amber-400/35 bg-amber-400/10 text-amber-200":
                                      inferActionGate(step) !== "required",
                                    "border-emerald-400/25 bg-emerald-400/10 text-emerald-200":
                                      inferActionGate(step) === "required",
                                  }}
                                >
                                  {stepGateLabel(step)}
                                </span>
                                <span class="flex shrink-0 items-center justify-end gap-1 opacity-100">
                                  <button
                                    type="button"
                                    aria-label="Move up"
                                    class="flex h-7 w-7 items-center justify-center rounded-md border border-border-base bg-background-panel text-11-regular text-text-weaker hover:border-border-strong hover:text-text-base disabled:opacity-30"
                                    disabled={busy() !== null || i() === 0}
                                    onClick={() => moveDraftStep(i(), i() - 1)}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    aria-label="Move down"
                                    class="flex h-7 w-7 items-center justify-center rounded-md border border-border-base bg-background-panel text-11-regular text-text-weaker hover:border-border-strong hover:text-text-base disabled:opacity-30"
                                    disabled={busy() !== null || i() === chainDraft.steps.length - 1}
                                    onClick={() => moveDraftStep(i(), i() + 1)}
                                  >
                                    ↓
                                  </button>
                                  <button
                                    type="button"
                                    aria-label="Remove"
                                    class="flex h-7 w-7 items-center justify-center rounded-md border border-border-base bg-background-panel text-11-regular text-text-weaker hover:border-rose-400/50 hover:text-rose-300 disabled:opacity-30"
                                    disabled={busy() !== null}
                                    onClick={() => removeDraftStep(step.id)}
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
                    <div
                      data-component="goal-drop-zone"
                      class="mt-3 flex min-h-14 items-center justify-center rounded-lg border border-dashed border-border-strong bg-background-panel/40 px-3 py-4 text-center text-12-regular text-text-weaker"
                    >
                      Actions added from the library appear here
                    </div>
                    <div data-component="goal-global-budget" class="mt-3 border-t border-border-base pt-3">
                      <div
                        data-component="goal-chain-budget-readout"
                        class="grid grid-cols-2 gap-2 md:grid-cols-3 2xl:grid-cols-5"
                      >
                        <label class="rounded-lg border border-border-base bg-background-panel/70 px-3 py-2">
                          <span class="block text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                            Time limit
                          </span>
                          <input
                            type="number"
                            min="1"
                            value={String(masterMinutes())}
                            disabled={busy() !== null}
                            onInput={(event) => updateMasterBudget("maxTimeMinutes", event.currentTarget.value)}
                            class="mt-1 w-full bg-transparent text-13-medium tabular-nums text-text-base outline-none"
                          />
                        </label>
                        <label class="rounded-lg border border-border-base bg-background-panel/70 px-3 py-2">
                          <span class="block text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                            Turn limit
                          </span>
                          <input
                            type="number"
                            min="1"
                            value={String(masterTurns())}
                            disabled={busy() !== null}
                            onInput={(event) => updateMasterBudget("maxTurns", event.currentTarget.value)}
                            class="mt-1 w-full bg-transparent text-13-medium tabular-nums text-text-base outline-none"
                          />
                        </label>
                        <RunMetricPill
                          label="Checks"
                          value={`${chainCommandCheckCount()} cmd`}
                          detail={`${chainMarkerCheckCount()} marker`}
                        />
                        <RunMetricPill
                          label="Est. total"
                          value={`${budgetSummary().effectiveTurns}t`}
                          detail={`${budgetSummary().effectiveTimeMinutes}m`}
                        />
                        <RunMetricPill
                          label="Checkpoints"
                          value={`${chainGateCount()} set`}
                          detail="non-run checks"
                          tone={chainGateCount() > 0 ? "warning" : "default"}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <aside
                  data-component="goal-action-library-rail"
                  class="min-w-0 bg-background-panel/30 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto"
                >
                  <div data-component="goal-method-library" class="min-w-0 p-2.5">
                    <div
                      data-component="goal-method-library-header"
                      class="flex items-start justify-between gap-3 border-b border-border-base pb-2"
                    >
                      <div class="min-w-0">
                        <div class="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-text-weaker">
                          {language.t("session.goal.create.templates")}
                        </div>
                        <div class="mt-0.5 text-11-regular text-text-weaker">
                          {language.t("session.goal.template.path")}
                        </div>
                      </div>
                      <ActionButton
                        label={language.t("session.goal.template.new")}
                        variant="secondary"
                        disabled={busy() !== null || goalCommandUnavailable()}
                        onClick={() => openActionEditor()}
                      />
                    </div>

                    <div data-component="goal-method-rail-filters" class="mt-2.5">
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
                      class="mt-2.5 flex max-h-[24rem] flex-col gap-1.5 overflow-y-auto rounded-lg border border-border-base bg-background-panel/70 p-1.5"
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
                            <button
                              type="button"
                              data-component="goal-method-row"
                              role="option"
                              aria-selected={selectedTemplateID() === t.id}
                              onClick={() => selectActionForView(t)}
                              title={t.description || t.condition || t.label}
                              class="group flex min-w-0 flex-col gap-1 rounded-md border border-border-base/80 bg-background-base/70 px-3 py-2 text-left transition-all hover:border-border-strong hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
                              classList={{
                                "border-border-strong bg-white/[0.06] shadow-[0_0_0_1px_var(--border-strong)]":
                                  selectedTemplateID() === t.id,
                              }}
                            >
                              <div class="flex min-w-0 items-center justify-between gap-2">
                                <span class="truncate text-12-medium text-text-base">{t.label}</span>
                                <span class="flex shrink-0 items-center gap-1">
                                  <For each={methodTags(t)}>
                                    {(tag) => (
                                      <span class="rounded border border-border-base bg-background-panel/80 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weaker">
                                        {tag}
                                      </span>
                                    )}
                                  </For>
                                </span>
                              </div>
                              <span class="block truncate text-[11px] text-text-weaker">
                                {cleanText(t.description || t.condition || "")}
                              </span>
                            </button>
                          )}
                        </For>
                      </Show>
                    </div>

                    <div
                      data-component="goal-action-inspector"
                      class="mt-2.5 min-w-0 rounded-lg border border-border-base bg-background-base/70 p-2.5"
                    >
                      <Show
                        when={selectedTemplate()}
                        fallback={
                          <div class="text-11-regular text-text-weaker">
                            {language.t("session.goal.template.empty")}
                          </div>
                        }
                        keyed
                      >
                        {(template) => (
                          <div class="flex min-w-0 flex-col gap-3">
                            <div class="flex min-w-0 flex-col gap-1 border-b border-border-base pb-3">
                              <div class="flex min-w-0 flex-wrap items-center gap-2">
                                <span class="truncate text-14-medium text-text-base">{template.label}</span>
                                <For each={methodTags(template)}>
                                  {(tag) => (
                                    <span class="rounded border border-border-base bg-background-panel/80 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weaker">
                                      {tag}
                                    </span>
                                  )}
                                </For>
                              </div>
                              <Show when={template.description}>
                                <div class="text-11-regular leading-4 text-text-weaker">
                                  {cleanText(template.description)}
                                </div>
                              </Show>
                            </div>

                            <div class="rounded-lg border border-border-base bg-background-base/70 px-3 py-2">
                              <div class="text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                                {language.t("session.goal.template.prompt")}
                              </div>
                              <div class="mt-1 text-12-regular leading-5 text-text-base">
                                {cleanText(template.condition || "") || "-"}
                              </div>
                            </div>

                            <div class="rounded-lg border border-border-base bg-background-base/70 px-3 py-2">
                              <div class="text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                                {language.t("session.goal.template.command")}
                              </div>
                              <div
                                class="mt-1 break-all text-[12px] text-text-base"
                                classList={{ "font-mono": !!template.command, "text-text-weaker": !template.command }}
                              >
                                {cleanText(template.command) || language.t("session.goal.template.noCommand")}
                              </div>
                            </div>

                            <div class="rounded-lg border border-border-base bg-background-base/70 px-3 py-2">
                              <div class="text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                                {language.t("session.goal.template.constraints")}
                              </div>
                              <div class="mt-1 text-12-medium text-text-base">
                                {templateConstraintsLabel(template) || language.t("session.goal.template.noLimits")}
                              </div>
                            </div>

                            <Show when={selectedTemplateVariables().length > 0}>
                              <div class="flex flex-col gap-2">
                                <div class="text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                                  {language.t("session.goal.template.variables")}
                                </div>
                                <For each={selectedTemplateVariables()}>
                                  {([key, variable]) => (
                                    <TextField
                                      value={templateVars()[key] ?? ""}
                                      onChange={(value) => updateTemplateVariable(key, value)}
                                      label={variable.description || key}
                                      placeholder={variable.default || key}
                                      disabled={busy() !== null || goalCommandUnavailable()}
                                      class="w-full"
                                    />
                                  )}
                                </For>
                              </div>
                            </Show>

                            <div class="flex flex-wrap items-center gap-2 border-t border-border-base pt-3">
                              <ActionButton
                                label={language.t("session.goal.template.edit")}
                                variant="secondary"
                                disabled={busy() !== null || goalCommandUnavailable()}
                                onClick={() => editTemplateDraft(template)}
                              />
                              <ActionButton
                                label={language.t("session.goal.template.apply")}
                                variant="primary"
                                disabled={busy() !== null || goalCommandUnavailable()}
                                onClick={() => applyTemplateDraft(template, templateVars())}
                              />
                              <ActionButton
                                label={language.t("session.goal.template.duplicate")}
                                variant="secondary"
                                busy={busy() === "template"}
                                disabled={
                                  busy() !== null || !props.sessionID || goalCommandUnavailable() || !template.condition
                                }
                                onClick={() => void duplicateActionTemplate(template)}
                              />
                              <ActionButton
                                label={language.t("session.goal.template.addToChain")}
                                variant="ghost"
                                disabled={busy() !== null || !template.condition}
                                onClick={() => addActionToChain(template, varsForAction(template))}
                              />
                              <Show when={!template.builtin}>
                                <ActionButton
                                  label={language.t("session.goal.template.delete")}
                                  variant="ghost"
                                  busy={busy() === "template"}
                                  disabled={busy() !== null || !props.sessionID || goalCommandUnavailable()}
                                  onClick={() => void deleteActionTemplate(template)}
                                />
                              </Show>
                            </div>

                            <Show when={actionDraft.open}>
                              <div class="grid grid-cols-1 gap-2 border-t border-border-base pt-3">
                                <TextField
                                  value={actionDraft.id}
                                  onChange={(value) => setActionDraft("id", value)}
                                  label={language.t("session.goal.template.saveName")}
                                  placeholder={language.t("session.goal.template.savePlaceholder")}
                                  disabled={busy() !== null || !props.sessionID || goalCommandUnavailable()}
                                  class="w-full"
                                />
                                <TextField
                                  value={actionDraft.label}
                                  onChange={(value) => setActionDraft("label", value)}
                                  label={language.t("session.goal.template.label")}
                                  placeholder={language.t("session.goal.template.labelPlaceholder")}
                                  disabled={busy() !== null || !props.sessionID || goalCommandUnavailable()}
                                  class="w-full"
                                />
                                <TextField
                                  value={actionDraft.prompt}
                                  onChange={(value) => setActionDraft("prompt", value)}
                                  label={language.t("session.goal.template.prompt")}
                                  multiline
                                  disabled={busy() !== null || !props.sessionID || goalCommandUnavailable()}
                                  class="w-full"
                                />
                                <TextField
                                  value={actionDraft.command}
                                  onChange={(value) => setActionDraft("command", value)}
                                  label={language.t("session.goal.template.command")}
                                  placeholder={language.t("session.goal.create.commandPlaceholder")}
                                  disabled={busy() !== null || !props.sessionID || goalCommandUnavailable()}
                                  class="w-full"
                                />
                                <div class="grid grid-cols-2 gap-2">
                                  <label class="rounded-lg border border-border-base bg-background-panel/70 px-3 py-2">
                                    <span class="block text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                                      Turns
                                    </span>
                                    <input
                                      type="number"
                                      min="1"
                                      value={String(actionDraft.turns)}
                                      disabled={busy() !== null}
                                      onInput={(event) =>
                                        setActionDraft(
                                          "turns",
                                          Math.max(1, Number.parseInt(event.currentTarget.value, 10) || 1),
                                        )
                                      }
                                      class="mt-1 w-full bg-transparent text-12-medium tabular-nums text-text-base outline-none"
                                    />
                                  </label>
                                  <label class="rounded-lg border border-border-base bg-background-panel/70 px-3 py-2">
                                    <span class="block text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                                      Minutes
                                    </span>
                                    <input
                                      type="number"
                                      min="1"
                                      value={String(actionDraft.minutes)}
                                      disabled={busy() !== null}
                                      onInput={(event) =>
                                        setActionDraft(
                                          "minutes",
                                          Math.max(1, Number.parseInt(event.currentTarget.value, 10) || 1),
                                        )
                                      }
                                      class="mt-1 w-full bg-transparent text-12-medium tabular-nums text-text-base outline-none"
                                    />
                                  </label>
                                </div>
                                <div class="flex flex-wrap items-center gap-2">
                                  <ActionButton
                                    label={language.t("session.goal.template.save")}
                                    variant="secondary"
                                    busy={busy() === "template"}
                                    disabled={
                                      busy() !== null ||
                                      !props.sessionID ||
                                      goalCommandUnavailable() ||
                                      !actionDraft.prompt.trim() ||
                                      !TEMPLATE_SAVE_ID_RE.test(actionDraft.id.trim())
                                    }
                                    onClick={() => void saveTemplateDraft()}
                                  />
                                  <ActionButton
                                    label={language.t("session.goal.action.cancel")}
                                    variant="ghost"
                                    disabled={busy() !== null}
                                    onClick={() => setActionDraft("open", false)}
                                  />
                                </div>
                              </div>
                            </Show>
                          </div>
                        )}
                      </Show>
                    </div>
                  </div>
                </aside>
              </div>
            </div>
            <Show when={!props.sessionID}>
              <div class="text-11-regular text-text-weaker">{language.t("session.goal.controlsHint")}</div>
            </Show>
          </div>
        </Match>
        <Match when={liveGoal()} keyed>
          {(s) => (
            <div class="flex flex-col gap-4 min-w-0">
              <div class="rounded-2xl border border-border-base bg-background-panel/90 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <div class="flex flex-col gap-3 min-w-0">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="relative flex h-2 w-2 shrink-0">
                          <Show when={s.status === "active"}>
                            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
                          </Show>
                          <span class={`relative inline-flex h-2 w-2 rounded-full ${statusMeta(s.status).dot}`} />
                        </span>
                        <span
                          class={`text-11-regular font-medium uppercase tracking-[0.12em] ${statusMeta(s.status).text}`}
                        >
                          {statusMeta(s.status).label}
                        </span>
                      </div>
                      <div
                        class="mt-2 min-w-0 text-[15px] font-semibold leading-snug text-text-base break-words"
                        title={cleanText(s.condition)}
                      >
                        {cleanText(s.condition)}
                      </div>
                    </div>
                    <div class="shrink-0 rounded-xl border border-border-base bg-background-base/80 px-3 py-2 text-right">
                      <div class="text-[11px] uppercase tracking-[0.12em] text-text-weaker">
                        {language.t("session.goal.progress")}
                      </div>
                      <div class="mt-1 text-2xl font-semibold tabular-nums text-text-base">
                        {s.status === "achieved" ? 100 : progressPct()}%
                      </div>
                    </div>
                  </div>

                  <ProgressBar
                    pct={s.status === "achieved" ? 100 : progressPct()}
                    status={s.status === "paused" ? "paused" : s.status === "achieved" ? "achieved" : "active"}
                  />

                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <BudgetDial
                      label="Turns"
                      value={`${s.turnsEvaluated}/${s.constraints.maxTurns}`}
                      detail={`${Math.max(0, s.constraints.maxTurns - s.turnsEvaluated)} remaining`}
                      disabled={busy() !== null || !props.sessionID}
                      decreaseLabel="Decrease turn limit"
                      increaseLabel="Increase turn limit"
                      onDecrease={() => adjustBudget("turns", s.constraints.maxTurns, -1)}
                      onIncrease={() => adjustBudget("turns", s.constraints.maxTurns, 1)}
                    />
                    <BudgetDial
                      label="Time"
                      value={`${elapsedMinutes()}/${s.constraints.maxTimeMinutes}m`}
                      detail={`${Math.max(0, s.constraints.maxTimeMinutes - elapsedMinutes())}m remaining`}
                      disabled={busy() !== null || !props.sessionID}
                      decreaseLabel="Decrease time limit"
                      increaseLabel="Increase time limit"
                      onDecrease={() => adjustBudget("time", s.constraints.maxTimeMinutes, -1)}
                      onIncrease={() => adjustBudget("time", s.constraints.maxTimeMinutes, 1)}
                    />
                  </div>

                  <Show when={s.lastEvaluation}>
                    <div
                      class="rounded-xl border border-border-base bg-background-base/70 px-3 py-2 text-12-regular text-text-weak"
                      aria-live="polite"
                    >
                      {cleanText(s.lastEvaluation!.reason)}
                    </div>
                  </Show>
                </div>
              </div>

              <Show
                when={(s.status === "active" || s.status === "paused") && props.sessionID}
                fallback={
                  <Show when={s.status === "active" || s.status === "paused"}>
                    <div class="text-11-regular text-text-weaker">{language.t("session.goal.controlsHint")}</div>
                  </Show>
                }
              >
                <div class="rounded-2xl border-2 border-border-strong bg-background-panel/80 p-3.5 shadow-[0_0_0_1px_var(--border-strong)]">
                  <div class="mb-3 text-[11px] font-semibold uppercase tracking-[0.10em] text-text-base opacity-70">
                    {language.t("session.goal.runControls")}
                  </div>
                  <div class="grid grid-cols-2 gap-2 xl:grid-cols-5">
                    {/* Single pause/resume toggle in a STABLE slot — the label
                        changes but the button never swaps position (which used
                        to let a stale click land on the wrong action). It flips
                        optimistically on click so it doesn't lag the 2s poll. */}
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
                          disabled={busy() !== null || goalCommandUnavailable()}
                          class="w-full justify-center"
                          onClick={() => {
                            const next = action()
                            setOptimisticStatus(next === "pause" ? "paused" : "active")
                            void runAction(next).then((ok) => {
                              if (!ok) setOptimisticStatus(null)
                            })
                          }}
                        />
                      )}
                    </Show>
                    <ActionButton
                      label={language.t("session.goal.action.steer")}
                      variant="secondary"
                      disabled={busy() !== null || goalCommandUnavailable()}
                      class="w-full justify-center"
                      onClick={() => setSteerOpen((v) => !v)}
                    />
                    <ActionButton
                      label={language.t("session.goal.action.restart")}
                      variant="secondary"
                      busy={busy() === "restart"}
                      disabled={busy() !== null || goalCommandUnavailable()}
                      class="w-full justify-center"
                      onClick={() => void runAction("restart")}
                    />
                    <ActionButton
                      label={language.t("session.goal.action.stop")}
                      variant={confirmingClear() ? "primary" : "secondary"}
                      busy={busy() === "clear" && confirmingClear()}
                      disabled={busy() !== null || goalCommandUnavailable()}
                      class="w-full justify-center"
                      onClick={() => setConfirmingClear(true)}
                    />
                    <ActionButton
                      label={language.t("session.goal.action.newGoal")}
                      variant="ghost"
                      disabled={busy() !== null || goalCommandUnavailable()}
                      class="w-full justify-center"
                      onClick={() => setShowCreate(true)}
                    />
                  </div>

                  <Show when={confirmingClear()}>
                    <div class="mt-3 flex flex-col gap-2 rounded-xl border border-rose-400/30 bg-rose-500/8 p-3">
                      <div class="text-11-regular text-text-weak">{language.t("session.goal.action.confirmStop")}</div>
                      <div class="flex flex-wrap items-center gap-2">
                        <ActionButton
                          label={language.t("session.goal.action.confirmStop")}
                          variant="primary"
                          busy={busy() === "clear"}
                          disabled={busy() !== null || goalCommandUnavailable()}
                          onClick={() => void stopGoal()}
                        />
                        <ActionButton
                          label={language.t("session.goal.action.cancel")}
                          variant="ghost"
                          disabled={busy() !== null || goalCommandUnavailable()}
                          onClick={() => setConfirmingClear(false)}
                        />
                      </div>
                    </div>
                  </Show>

                  <Show when={steerOpen()}>
                    <div class="mt-3 flex flex-col gap-2 rounded-xl border border-border-base bg-background-base/70 p-3">
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
                          disabled={busy() !== null || !steerText().trim() || goalCommandUnavailable()}
                          onClick={() => void steerGoal()}
                        />
                        <ActionButton
                          label={language.t("session.goal.action.cancel")}
                          variant="ghost"
                          disabled={busy() !== null || goalCommandUnavailable()}
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

              <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <div class="flex min-w-0 flex-col gap-3">
                  <Show when={chain() || s.status === "active" || s.status === "paused"}>
                    <div
                      data-component="goal-chain-board"
                      class="rounded-2xl border border-border-base bg-background-panel/70 p-3 min-w-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                    >
                      <div class="flex items-center justify-between gap-2">
                        <div class="min-w-0">
                          <div class="text-[11px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                            {language.t("session.goal.steps.title")}
                          </div>
                          <Show when={chain()} keyed>
                            {(c) => (
                              <div class="mt-1 text-11-regular text-text-weaker">
                                {c.current}/{c.steps.length} {language.t("session.goal.steps.done")}
                              </div>
                            )}
                          </Show>
                        </div>
                        <Show when={(s.status === "active" || s.status === "paused") && props.sessionID}>
                          <button
                            type="button"
                            class="rounded-lg border border-border-base bg-background-base/70 px-2.5 py-1 text-11-regular text-text-weak transition-all hover:border-border-strong hover:text-text-base disabled:opacity-50"
                            disabled={busy() !== null || goalCommandUnavailable()}
                            onClick={() => setAddingStep((v) => !v)}
                          >
                            + {language.t("session.goal.steps.add")}
                          </button>
                        </Show>
                      </div>

                      <Show
                        when={chain()}
                        fallback={
                          <div class="mt-3 text-11-regular text-text-weaker">
                            {language.t("session.goal.steps.empty")}
                          </div>
                        }
                        keyed
                      >
                        {(c) => (
                          <>
                            <div class="mt-3 flex flex-col gap-2 min-w-0" role="list">
                              <For each={c.steps}>
                                {(step, i) => (
                                  <div
                                    data-component="goal-chain-pill"
                                    role="listitem"
                                    class={`group grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border-base bg-background-base/70 px-3 py-2.5 transition-colors ${actionSurfaceClass(step)}`}
                                    classList={{
                                      "border-emerald-400/30 bg-emerald-400/8": i() < c.current,
                                      "border-border-strong bg-white/[0.06] shadow-[0_0_0_1px_var(--border-strong)]":
                                        i() === c.current,
                                    }}
                                  >
                                    <span
                                      class="flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-[11px] font-semibold tabular-nums"
                                      classList={{
                                        "border-emerald-400/30 bg-emerald-400/10 text-emerald-300": i() < c.current,
                                        "border-border-strong bg-background-panel text-text-base": i() === c.current,
                                        "border-border-base bg-background-panel/60 text-text-weaker": i() > c.current,
                                      }}
                                    >
                                      {i() + 1}
                                    </span>
                                    <div class="min-w-0">
                                      <div
                                        class="truncate text-12-regular"
                                        classList={{
                                          "text-text-weaker line-through": i() < c.current,
                                          "text-text-base font-medium": i() === c.current,
                                          "text-text-weak": i() > c.current,
                                        }}
                                        title={cleanText(step.condition)}
                                      >
                                        {cleanText(step.condition)}
                                      </div>
                                      <div class="mt-1 flex items-center gap-1.5">
                                        <span
                                          class="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]"
                                          classList={{
                                            "border-emerald-400/30 text-emerald-300": i() < c.current,
                                            "border-border-strong text-text-base": i() === c.current,
                                            "border-border-base text-text-weaker": i() > c.current,
                                          }}
                                        >
                                          {i() < c.current
                                            ? language.t("session.goal.steps.status.done")
                                            : i() === c.current
                                              ? language.t("session.goal.steps.status.current")
                                              : language.t("session.goal.steps.status.queued")}
                                        </span>
                                        <span class="rounded-full border border-border-base px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weaker">
                                          {inferActionCategory(step)}
                                        </span>
                                        <span
                                          class="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]"
                                          classList={{
                                            "border-amber-400/35 text-amber-200": inferActionGate(step) !== "required",
                                            "border-border-base text-text-weaker": inferActionGate(step) === "required",
                                          }}
                                        >
                                          {stepGateLabel(step)}
                                        </span>
                                      </div>
                                    </div>
                                    <Show when={(s.status === "active" || s.status === "paused") && props.sessionID}>
                                      <span class="shrink-0 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                        <button
                                          type="button"
                                          aria-label="Move up"
                                          class="flex h-7 w-7 items-center justify-center rounded-md border border-border-base bg-background-panel text-11-regular text-text-weaker hover:border-border-strong hover:text-text-base disabled:opacity-30"
                                          disabled={busy() !== null || i() === 0}
                                          onClick={() => void moveStep(i(), i() - 1)}
                                        >
                                          ↑
                                        </button>
                                        <button
                                          type="button"
                                          aria-label="Move down"
                                          class="flex h-7 w-7 items-center justify-center rounded-md border border-border-base bg-background-panel text-11-regular text-text-weaker hover:border-border-strong hover:text-text-base disabled:opacity-30"
                                          disabled={
                                            busy() !== null || goalCommandUnavailable() || i() === c.steps.length - 1
                                          }
                                          onClick={() => void moveStep(i(), i() + 1)}
                                        >
                                          ↓
                                        </button>
                                      </span>
                                    </Show>
                                  </div>
                                )}
                              </For>
                            </div>
                          </>
                        )}
                      </Show>

                      <Show when={addingStep()}>
                        <div class="mt-3 flex items-center gap-2">
                          <TextField
                            value={stepText()}
                            onChange={setStepText}
                            label={language.t("session.goal.steps.add")}
                            hideLabel
                            placeholder={language.t("session.goal.steps.placeholder")}
                            disabled={busy() !== null}
                            class="w-full"
                          />
                          <ActionButton
                            label={language.t("session.goal.steps.addAction")}
                            variant="primary"
                            busy={busy() === "step"}
                            disabled={busy() !== null || !stepText().trim()}
                            onClick={() => void addStep()}
                          />
                        </div>
                      </Show>
                    </div>
                  </Show>

                  <div class="rounded-2xl border border-border-base bg-background-panel/70 p-3">
                    <div class="mb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                      {language.t("session.goal.constraints")}
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-11-regular">
                      <div class="rounded-xl border border-border-base bg-background-base/70 px-3 py-2">
                        <div class="text-text-weaker">{language.t("session.goal.budget.turnsLabel")}</div>
                        <div class="mt-1 text-12-medium tabular-nums text-text-base">{s.constraints.maxTurns}</div>
                      </div>
                      <div class="rounded-xl border border-border-base bg-background-base/70 px-3 py-2">
                        <div class="text-text-weaker">{language.t("session.goal.budget.timeLabel")}</div>
                        <div class="mt-1 text-12-medium tabular-nums text-text-base">
                          {s.constraints.maxTimeMinutes}m
                        </div>
                      </div>
                      <div class="rounded-xl border border-border-base bg-background-base/70 px-3 py-2">
                        <div class="text-text-weaker">{language.t("session.goal.budget.maxTokensLabel")}</div>
                        <div class="mt-1 text-12-medium tabular-nums text-text-base">
                          {s.constraints.maxTokens.toLocaleString()}
                        </div>
                      </div>
                      <div class="rounded-xl border border-border-base bg-background-base/70 px-3 py-2">
                        <div class="text-text-weaker">{language.t("session.goal.budget.usedTokensLabel")}</div>
                        <div class="mt-1 text-12-medium tabular-nums text-text-base">
                          {s.tokensUsed.toLocaleString()}
                        </div>
                      </div>
                    </div>
                    <Show when={verifyCommand()}>
                      <div class="mt-3 rounded-xl border border-border-base bg-background-base/70 px-3 py-2">
                        <div class="text-[11px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                          {language.t("session.goal.verifyCommand")}
                        </div>
                        <div class="mt-2 break-all font-mono text-[12px] text-text-base">{verifyCommand()}</div>
                      </div>
                    </Show>
                  </div>
                </div>

                <div class="rounded-2xl border border-border-base bg-background-panel/70 p-3">
                  <div class="mb-3 flex items-center justify-between gap-2">
                    <span class="text-[11px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                      {language.t("session.goal.activity.title")}
                    </span>
                    <span class="text-11-regular text-text-weaker">{activity().length}</span>
                  </div>
                  <Show
                    when={activity().length > 0}
                    fallback={
                      <div class="text-11-regular text-text-weaker">{language.t("session.goal.activity.empty")}</div>
                    }
                  >
                    <div role="list" class="flex max-h-80 flex-col gap-1 overflow-y-auto">
                      <For each={activity()}>
                        {(e) => (
                          <div
                            role="listitem"
                            class="rounded-xl border border-border-base bg-background-base/70 px-3 py-2 text-11-regular"
                          >
                            <div class="flex items-start gap-2">
                              <span
                                class="shrink-0"
                                classList={{
                                  "text-icon-success-base": e.kind === "tool-end" && e.ok === true,
                                  "text-text-warning-base": e.kind === "tool-end" && e.ok === false,
                                  "text-text-weaker": e.kind !== "tool-end",
                                }}
                              >
                                {e.kind === "tool-end"
                                  ? e.ok === false
                                    ? "✗"
                                    : "✓"
                                  : e.kind === "tool-start"
                                    ? "▸"
                                    : "•"}
                              </span>
                              <div class="min-w-0 flex-1">
                                <div
                                  class="min-w-0 truncate text-text-base"
                                  title={cleanText(e.summary ?? e.tool ?? "")}
                                >
                                  <Show when={e.tool}>
                                    <span class="font-medium">{e.tool}</span>{" "}
                                  </Show>
                                  {cleanText(e.summary ?? "")}
                                </div>
                              </div>
                              <Show when={e.durationMs !== undefined}>
                                <span class="shrink-0 tabular-nums text-text-weaker">{formatMs(e.durationMs!)}</span>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          )}
        </Match>
      </Switch>

      {/* ── History timeline — always visible (the "history line") ──────────
          A vertical rail of past runs. A cleared goal lands here as
          "Cancelled"; an achieved goal as "Achieved". This is where terminal
          goals go instead of blanking the panel.

          Visibility is keyed ONLY on the archive (goal-history.json, polled
          every 2s into `archive()`) — NOT on the live goal store. Coupling it
          to `store.loaded && !store.corrupt` made history vanish the moment a
          run was stopped/cleared (the live state momentarily reloads/empties),
          even though the archived runs are intact and independent. */}
      <Show when={archive().length > 0}>
        <div class="mt-1 min-w-0 border-t border-border-base pt-3">
          <div class="rounded-2xl border border-border-base bg-background-panel/70 p-3 min-w-0">
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 text-left"
              onClick={() => setHistoryOpen((open) => !open)}
              aria-expanded={historyOpen()}
            >
              <div class="min-w-0">
                <div class="text-[11px] font-medium uppercase tracking-[0.12em] text-text-weaker">
                  {language.t("session.goal.recentRuns")}
                </div>
                <div class="mt-1 text-12-regular text-text-weaker">{archive().length} archived runs</div>
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
                          label="Checks"
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
