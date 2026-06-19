/**
 * Pure data-shape and sanitization helpers for the goal dock.
 *
 * Extracted from `goal-panel.tsx` so unit tests can import these
 * directly without dragging in the TSX module (which transitively
 * imports Kobalte client-only code that throws under happy-dom). The
 * TSX re-exports the same names from here so existing consumers are
 * unaffected.
 */

/** File path inside the project where the plugin writes its state. */
export const STATE_PATH = ".opencode/.goal-state.json"
/** File path for a pending goal handoff created by `/goal handoff`. */
export const HANDOFF_PATH = ".opencode/.goal-handoff.json"
/** Hard cap on the state-file body we are willing to JSON.parse.
 *  The opencode-autogoal plugin caps writes at 256KB, but the renderer
 *  can't import that constant across repos. A 1MB cap gives a generous
 *  margin (4x the plugin's max) and prevents an accidentally-huge or
 *  malicious state file from OOM-ing the SolidJS renderer's reactivity
 *  layer. */
export const MAX_RENDERER_STATE_BYTES = 1 * 1024 * 1024
/** The plugin caps handoff files at 256KB. Keep the renderer cap aligned
 *  so a planted handoff cannot force JSON.parse on an unbounded payload. */
export const MAX_RENDERER_HANDOFF_BYTES = 256 * 1024

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
    typeof c.maxTurns !== "number" ||
    !Number.isFinite(c.maxTurns) ||
    typeof c.maxTimeMinutes !== "number" ||
    !Number.isFinite(c.maxTimeMinutes) ||
    typeof c.maxTokens !== "number" ||
    !Number.isFinite(c.maxTokens)
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

/** One quick-start template button in the dock. Mirrors the plugin's
 *  `.opencode/goal-templates.json` snapshot entries (goal-templates-snapshot.ts). */
export const GOAL_TEMPLATE_TONES = ["violet", "blue", "orange", "emerald", "fuchsia", "sky"] as const
export type GoalTemplateTone = (typeof GOAL_TEMPLATE_TONES)[number]

export const GOAL_TEMPLATE_ELEVATIONS = ["flat", "raised"] as const
export type GoalTemplateElevation = (typeof GOAL_TEMPLATE_ELEVATIONS)[number]

export const GOAL_TEMPLATE_CATEGORIES = [
  "Planning",
  "Building",
  "Debugging",
  "Testing",
  "Review",
  "Documentation",
  "Custom",
] as const
export type GoalTemplateCategory = (typeof GOAL_TEMPLATE_CATEGORIES)[number]

export const GOAL_TEMPLATE_GATES = ["required", "pass", "verify", "review"] as const
export type GoalTemplateGate = (typeof GOAL_TEMPLATE_GATES)[number]

export interface GoalPinnedModel {
  providerID: string
  modelID: string
}

export type GoalTemplateModel = string | GoalPinnedModel

export interface GoalTemplateButton {
  id: string
  label: string
  description?: string
  condition?: string
  command?: string
  constraints?: Partial<GoalState["constraints"]>
  variables?: Record<string, GoalTemplateVariable>
  skills?: string[]
  model?: GoalTemplateModel
  category?: GoalTemplateCategory
  gate?: GoalTemplateGate
  tone?: GoalTemplateTone
  elevation?: GoalTemplateElevation
  builtin: boolean
}

export interface GoalTemplateVariable {
  description?: string
  default?: string
}

/** Built-in method prompts for the dock. These are deliberately general
 *  coding-method recipes, not project-specific commands like "npm test". */
export const DEFAULT_TEMPLATE_BUTTONS: GoalTemplateButton[] = [
  {
    id: "plan",
    label: "Plan",
    description: "Map the work before editing",
    condition:
      "Create a concise implementation plan for {scope}. Identify the files, sequence, risks, and verification needed before changing code.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current coding request" } },
    category: "Planning",
    tone: "violet",
    elevation: "raised",
    builtin: true,
  },
  {
    id: "build",
    label: "Build",
    description: "Implement the planned change",
    condition:
      "Implement {scope} using the repository's existing patterns. Keep edits scoped, update nearby tests, and preserve unrelated work.",
    constraints: { maxTurns: 8, maxTimeMinutes: 30 },
    variables: { scope: { description: "Scope", default: "the planned coding change" } },
    category: "Building",
    tone: "blue",
    elevation: "raised",
    builtin: true,
  },
  {
    id: "debug",
    label: "Debug",
    description: "Reproduce and isolate a failure",
    condition:
      "Debug {scope}. Reproduce the failure, capture evidence, isolate the root cause, add a regression test where practical, and implement the smallest fix.",
    constraints: { maxTurns: 8, maxTimeMinutes: 30 },
    variables: { scope: { description: "Scope", default: "the reported failure" } },
    category: "Debugging",
    tone: "orange",
    elevation: "raised",
    builtin: true,
  },
  {
    id: "test",
    label: "Test",
    description: "Run and repair behavior tests",
    condition:
      "Run the relevant behavior tests for {scope}. Reproduce failures, fix the underlying issue, and re-run the focused test until it is clean.",
    constraints: { maxTurns: 5, maxTimeMinutes: 20 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Testing",
    tone: "emerald",
    elevation: "flat",
    builtin: true,
  },
  {
    id: "validate",
    label: "Validate",
    description: "Prove the change works",
    condition:
      "Validate {scope}. Run the relevant tests, typechecks, builds, or UI checks; inspect failures; and fix regressions until the verification set is clean.",
    constraints: { maxTurns: 4, maxTimeMinutes: 15 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Testing",
    tone: "sky",
    elevation: "flat",
    builtin: true,
  },
  {
    id: "review",
    label: "Review",
    description: "Review the diff for release risks",
    condition:
      "Review {scope}. Inspect the diff for bugs, missing tests, regressions, security issues, and operator-confusing behavior. Report concrete findings before changing code.",
    constraints: { maxTurns: 4, maxTimeMinutes: 15 },
    variables: { scope: { description: "Scope", default: "the current diff" } },
    category: "Review",
    tone: "fuchsia",
    elevation: "flat",
    builtin: true,
  },
  {
    id: "docs",
    label: "Docs",
    description: "Update relevant docs or handoff notes",
    condition:
      "Update documentation for {scope}. Keep it concise, accurate to the implementation, and focused on commands, operator behavior, and remaining risks.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Documentation",
    tone: "sky",
    elevation: "flat",
    builtin: true,
  },
  {
    id: "wire-check",
    label: "Wire check",
    description: "Trace UI controls to runtime effects",
    condition:
      "Trace the wiring for {scope}. For each visible control, identify the handler, deterministic state write, model-turn boundary, error path, and verification evidence.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current UI flow" } },
    category: "Review",
    tone: "blue",
    elevation: "flat",
    builtin: true,
  },
  {
    id: "adversarial-scan",
    label: "Adversarial scan",
    description: "Try to break the proposed change",
    condition:
      "Adversarially scan {scope}. Exercise invalid inputs, stale state, missing files, repeated clicks, interrupted turns, and upstream/downstream regressions; harden the code where needed.",
    constraints: { maxTurns: 4, maxTimeMinutes: 15 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Review",
    tone: "fuchsia",
    elevation: "raised",
    builtin: true,
  },
  {
    id: "typecheck",
    label: "Typecheck",
    description: "Run and fix type-level verification",
    condition:
      "Typecheck {scope}. Find the repository's relevant typecheck command, run it, fix type errors without broad refactors, and re-run until clean.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Testing",
    tone: "emerald",
    elevation: "flat",
    builtin: true,
  },
  {
    id: "commit",
    label: "Commit",
    description: "Package verified work cleanly",
    condition:
      "Prepare a commit for {scope}. Review the diff, ensure verification has passed, stage only relevant files, and write a concise conventional commit message.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Custom",
    tone: "violet",
    elevation: "flat",
    builtin: true,
  },
]

const DEFAULT_TEMPLATE_BY_ID = new Map(DEFAULT_TEMPLATE_BUTTONS.map((template) => [template.id, template]))
const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]+$/
const TEMPLATE_VAR_RE = /^\w+$/
const MAX_TEMPLATE_BUTTONS = 24
const MAX_TEMPLATE_SKILLS = 8

function templateConstraintsFromSnapshot(value: unknown): Partial<GoalState["constraints"]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const r = value as Record<string, unknown>
  const out: Partial<GoalState["constraints"]> = {}
  if (typeof r.maxTurns === "number" && Number.isFinite(r.maxTurns)) out.maxTurns = r.maxTurns
  if (typeof r.maxTimeMinutes === "number" && Number.isFinite(r.maxTimeMinutes)) out.maxTimeMinutes = r.maxTimeMinutes
  if (typeof r.maxTokens === "number" && Number.isFinite(r.maxTokens)) out.maxTokens = r.maxTokens
  return Object.keys(out).length > 0 ? out : undefined
}

function templateVariablesFromSnapshot(value: unknown): Record<string, GoalTemplateVariable> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, GoalTemplateVariable> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!TEMPLATE_VAR_RE.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const variable = raw as Record<string, unknown>
    out[key] = {
      ...(typeof variable.description === "string" ? { description: cleanText(variable.description) } : {}),
      ...(typeof variable.default === "string" ? { default: cleanText(variable.default) } : {}),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function templateSkillsFromSnapshot(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const skill = cleanText(item).trim().slice(0, 80)
    if (!skill || seen.has(skill)) continue
    seen.add(skill)
    out.push(skill)
    if (out.length >= MAX_TEMPLATE_SKILLS) break
  }
  return out.length > 0 ? out : undefined
}

export function isGoalPinnedModel(value: unknown): value is GoalPinnedModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const model = value as { providerID?: unknown; modelID?: unknown }
  return (
    typeof model.providerID === "string" &&
    model.providerID.trim().length > 0 &&
    typeof model.modelID === "string" &&
    model.modelID.trim().length > 0
  )
}

export function templateModelFromSnapshot(value: unknown): GoalTemplateModel | undefined {
  if (typeof value === "string") {
    const model = cleanText(value).trim().slice(0, 160)
    return model ? model : undefined
  }
  if (!isGoalPinnedModel(value)) return undefined
  const providerID = cleanText(value.providerID).trim().slice(0, 160)
  const modelID = cleanText(value.modelID).trim().slice(0, 160)
  return providerID && modelID ? { providerID, modelID } : undefined
}

function templateToneFromSnapshot(value: unknown): GoalTemplateTone | undefined {
  return typeof value === "string" && (GOAL_TEMPLATE_TONES as readonly string[]).includes(value)
    ? (value as GoalTemplateTone)
    : undefined
}

function templateElevationFromSnapshot(value: unknown): GoalTemplateElevation | undefined {
  return typeof value === "string" && (GOAL_TEMPLATE_ELEVATIONS as readonly string[]).includes(value)
    ? (value as GoalTemplateElevation)
    : undefined
}

function templateCategoryFromSnapshot(value: unknown): GoalTemplateCategory | undefined {
  return typeof value === "string" && (GOAL_TEMPLATE_CATEGORIES as readonly string[]).includes(value)
    ? (value as GoalTemplateCategory)
    : undefined
}

function templateGateFromSnapshot(value: unknown): GoalTemplateGate | undefined {
  return typeof value === "string" && (GOAL_TEMPLATE_GATES as readonly string[]).includes(value)
    ? (value as GoalTemplateGate)
    : undefined
}

/** Validate + sanitize a parsed `goal-templates.json` snapshot into the method
 *  list. The app owns the canonical built-in methods; legacy plugin built-ins
 *  are ignored so old "pass tests" shortcuts don't crowd out method prompts.
 *  Project templates still append after the built-ins. */
export function templateButtonsFromSnapshot(parsed: unknown): GoalTemplateButton[] {
  if (!parsed || typeof parsed !== "object") return DEFAULT_TEMPLATE_BUTTONS
  const list = (parsed as { templates?: unknown }).templates
  if (!Array.isArray(list)) return DEFAULT_TEMPLATE_BUTTONS
  const out: GoalTemplateButton[] = [...DEFAULT_TEMPLATE_BUTTONS]
  const seen = new Set(out.map((template) => template.id))
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    if (r.builtin === true) continue
    if (typeof r.id !== "string" || !TEMPLATE_ID_RE.test(r.id) || seen.has(r.id)) continue
    seen.add(r.id)
    const fallback = DEFAULT_TEMPLATE_BY_ID.get(r.id)
    const label =
      typeof r.label === "string" && r.label.trim().length > 0 ? cleanText(r.label) : (fallback?.label ?? r.id)
    const description = typeof r.description === "string" ? cleanText(r.description) : fallback?.description
    const condition = typeof r.condition === "string" ? cleanText(r.condition) : fallback?.condition
    const command = typeof r.command === "string" ? cleanText(r.command) : fallback?.command
    const constraints = templateConstraintsFromSnapshot(r.constraints) ?? fallback?.constraints
    const variables = templateVariablesFromSnapshot(r.variables) ?? fallback?.variables
    const skills = templateSkillsFromSnapshot(r.skills) ?? fallback?.skills
    const model = templateModelFromSnapshot(r.model) ?? fallback?.model
    const category = templateCategoryFromSnapshot(r.category) ?? fallback?.category
    const gate = templateGateFromSnapshot(r.gate) ?? fallback?.gate
    const tone = templateToneFromSnapshot(r.tone) ?? fallback?.tone
    const elevation = templateElevationFromSnapshot(r.elevation) ?? fallback?.elevation
    out.push({
      id: r.id,
      label,
      description,
      condition,
      command,
      constraints,
      variables,
      ...(skills ? { skills } : {}),
      ...(model ? { model } : {}),
      ...(category ? { category } : {}),
      ...(gate ? { gate } : {}),
      ...(tone ? { tone } : {}),
      ...(elevation ? { elevation } : {}),
      builtin: false,
    })
    if (out.length >= MAX_TEMPLATE_BUTTONS) break
  }
  return out
}

export function templateVariableDefaults(template: Pick<GoalTemplateButton, "variables">): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, variable] of Object.entries(template.variables ?? {})) {
    if (typeof variable.default === "string") out[key] = variable.default
  }
  return out
}

function resolveTemplateText(text: string | undefined, vars: Record<string, string>): string {
  if (!text) return ""
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    typeof vars[key] === "string" ? cleanText(vars[key]) : match,
  )
}

export function templateDraftFromButton(
  template: Pick<GoalTemplateButton, "condition" | "command">,
  vars: Record<string, string> = {},
): { condition: string; command: string } {
  return {
    condition: resolveTemplateText(template.condition, vars),
    command: resolveTemplateText(template.command, vars),
  }
}

export interface GoalChainDraftStep {
  id: string
  actionID: string
  label: string
  condition: string
  command: string
  maxTurns: number
  maxTimeMinutes: number
  category?: GoalTemplateCategory
  gate?: GoalTemplateGate
  tone?: GoalTemplateTone
  elevation?: GoalTemplateElevation
  skills?: string[]
  model?: GoalTemplateModel
  builtin: boolean
}

export interface GoalChainMasterBudget {
  maxTurns: number
  maxTimeMinutes: number
}

export function selectRunnableChainSteps<T>(draftSteps: T[], visibleSteps: T[]): T[] {
  return draftSteps.length > 0 ? draftSteps : visibleSteps
}

export function chainStepFromTemplate(
  template: GoalTemplateButton,
  vars: Record<string, string> = {},
  id = `${template.id}-${Date.now()}`,
): GoalChainDraftStep {
  const draft = templateDraftFromButton(template, vars)
  return {
    id,
    actionID: template.id,
    label: template.label,
    condition: draft.condition,
    command: draft.command,
    maxTurns: clampPositiveInteger(template.constraints?.maxTurns, 5),
    maxTimeMinutes: clampPositiveInteger(template.constraints?.maxTimeMinutes, 20),
    ...(template.category ? { category: template.category } : {}),
    ...(template.gate ? { gate: template.gate } : {}),
    ...(template.tone ? { tone: template.tone } : {}),
    ...(template.elevation ? { elevation: template.elevation } : {}),
    ...(template.skills && template.skills.length > 0 ? { skills: [...template.skills] } : {}),
    ...(template.model ? { model: template.model } : {}),
    builtin: template.builtin,
  }
}

export function chainBudgetSummary(steps: GoalChainDraftStep[], master: GoalChainMasterBudget) {
  const ultimateTurns = steps.reduce((total, step) => total + clampPositiveInteger(step.maxTurns, 0), 0)
  const ultimateTimeMinutes = steps.reduce((total, step) => total + clampPositiveInteger(step.maxTimeMinutes, 0), 0)
  const masterTurns = clampPositiveInteger(master.maxTurns, ultimateTurns)
  const masterTimeMinutes = clampPositiveInteger(master.maxTimeMinutes, ultimateTimeMinutes)
  return {
    stepCount: steps.length,
    ultimateTurns,
    ultimateTimeMinutes,
    masterTurns,
    masterTimeMinutes,
    effectiveTurns: steps.length === 0 ? 0 : Math.min(masterTurns, ultimateTurns),
    effectiveTimeMinutes: steps.length === 0 ? 0 : Math.min(masterTimeMinutes, ultimateTimeMinutes),
    masterTurnsIsCap: steps.length > 0 && masterTurns < ultimateTurns,
    masterTimeIsCap: steps.length > 0 && masterTimeMinutes < ultimateTimeMinutes,
  }
}

export interface ChainValidationError {
  /** -1 for chain-level errors, 0-based step index for step errors */
  stepIndex: number
  message: string
}

const MAX_CONDITION_LEN = 4000
const MAX_STEP_MODEL_FIELD_LEN = 160
const MAX_STEP_SKILLS = 8
const MAX_STEP_SKILL_LEN = 80
const MAX_STEPS = 24

export function validateChainDraft(
  steps: GoalChainDraftStep[],
  master: GoalChainMasterBudget,
): ChainValidationError[] {
  const errors: ChainValidationError[] = []

  // Chain-level checks
  if (steps.length === 0) {
    errors.push({ stepIndex: -1, message: "Add at least one action to the chain." })
  }
  if (steps.length > MAX_STEPS) {
    errors.push({ stepIndex: -1, message: `Chain cannot have more than ${MAX_STEPS} steps.` })
  }

  // Master budget checks
  const budget = chainBudgetSummary(steps, master)
  if (budget.masterTurnsIsCap) {
    errors.push({
      stepIndex: -1,
      message: `Total step turns (${budget.ultimateTurns}) exceeds master turn limit (${budget.masterTurns}).`,
    })
  }
  if (budget.masterTimeIsCap) {
    errors.push({
      stepIndex: -1,
      message: `Total step time (${budget.ultimateTimeMinutes}m) exceeds master time limit (${budget.masterTimeMinutes}m).`,
    })
  }

  // Per-step checks
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    const label = step.label || step.actionID || `Step ${i + 1}`

    if (!step.condition.trim()) {
      errors.push({ stepIndex: i, message: `${label}: condition cannot be empty.` })
    }
    if (step.condition.length > MAX_CONDITION_LEN) {
      errors.push({
        stepIndex: i,
        message: `${label}: condition is ${step.condition.length} chars (max ${MAX_CONDITION_LEN}).`,
      })
    }
    if (step.maxTurns < 1) {
      errors.push({ stepIndex: i, message: `${label}: turns must be at least 1.` })
    }
    if (step.maxTimeMinutes < 1) {
      errors.push({ stepIndex: i, message: `${label}: time must be at least 1 minute.` })
    }

    // Model validation
    if (step.model) {
      if (isGoalPinnedModel(step.model)) {
        if (!step.model.providerID.trim() || !step.model.modelID.trim()) {
          errors.push({ stepIndex: i, message: `${label}: model providerID and modelID are required.` })
        }
        if (step.model.providerID.length > MAX_STEP_MODEL_FIELD_LEN || step.model.modelID.length > MAX_STEP_MODEL_FIELD_LEN) {
          errors.push({ stepIndex: i, message: `${label}: model providerID and modelID must be ${MAX_STEP_MODEL_FIELD_LEN} chars or fewer.` })
        }
      } else if (typeof step.model === "string") {
        const trimmed = step.model.trim()
        if (!trimmed) {
          errors.push({ stepIndex: i, message: `${label}: model cannot be empty.` })
        } else if (trimmed.length > MAX_STEP_MODEL_FIELD_LEN) {
          errors.push({ stepIndex: i, message: `${label}: model must be ${MAX_STEP_MODEL_FIELD_LEN} chars or fewer.` })
        }
      } else {
        errors.push({ stepIndex: i, message: `${label}: model must be a {providerID, modelID} object or a string.` })
      }
    }

    // Skills validation
    if (step.skills && step.skills.length > 0) {
      if (step.skills.length > MAX_STEP_SKILLS) {
        errors.push({ stepIndex: i, message: `${label}: at most ${MAX_STEP_SKILLS} skills.` })
      }
      const seen = new Set<string>()
      for (const skill of step.skills) {
        const name = cleanText(skill).trim()
        if (!name) {
          errors.push({ stepIndex: i, message: `${label}: skill names cannot be empty.` })
        } else if (name.length > MAX_STEP_SKILL_LEN) {
          errors.push({ stepIndex: i, message: `${label}: skill "${name.slice(0, 40)}..." exceeds ${MAX_STEP_SKILL_LEN} chars.` })
        } else if (seen.has(name)) {
          errors.push({ stepIndex: i, message: `${label}: duplicate skill "${name}".` })
        }
        seen.add(name)
      }
    }
  }

  return errors
}

function clampPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Math.max(0, Math.round(fallback))
  return Math.max(0, Math.round(value))
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

export interface GoalStore {
  state: GoalState | null
  corrupt: boolean
  loaded: boolean
}

export interface GoalHandoff {
  createdAt: string
  state: GoalState
  note?: string
}

export interface GoalHandoffStore {
  handoff: GoalHandoff | null
  corrupt: boolean
  loaded: boolean
}

function workspaceFileContent(raw: unknown): string | null {
  return typeof raw === "string"
    ? raw
    : raw && typeof raw === "object" && typeof (raw as { content?: unknown }).content === "string"
      ? (raw as { content: string }).content
      : null
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
    const content = workspaceFileContent(res.data)
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

export async function readHandoffFromSdk(sdk: GoalSdkClient): Promise<GoalHandoffStore> {
  try {
    const res = await sdk.client.file.read({ path: HANDOFF_PATH })
    const content = workspaceFileContent(res.data)
    if (!content || content.trim().length === 0) {
      return { handoff: null, corrupt: false, loaded: true }
    }
    if (content.length > MAX_RENDERER_HANDOFF_BYTES) {
      return { handoff: null, corrupt: true, loaded: true }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return { handoff: null, corrupt: true, loaded: true }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { handoff: null, corrupt: true, loaded: true }
    }
    const record = parsed as Record<string, unknown>
    if (typeof record.createdAt !== "string" || !isGoalStateShape(record.state)) {
      return { handoff: null, corrupt: true, loaded: true }
    }
    return {
      handoff: {
        createdAt: cleanText(record.createdAt),
        state: record.state,
        ...(typeof record.note === "string" && cleanText(record.note).trim()
          ? { note: cleanText(record.note).trim() }
          : {}),
      },
      corrupt: false,
      loaded: true,
    }
  } catch {
    return { handoff: null, corrupt: false, loaded: true }
  }
}
