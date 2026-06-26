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
    confidence?: number
    timestamp: number
    evaluatorType: "deterministic" | "model" | "heuristic"
    blocked?: boolean
  } | null
  evaluationHistory: Array<{ met: boolean; reason: string; confidence?: number; timestamp: number }>
  constraints: {
    maxTurns: number
    maxTimeMinutes: number
    maxTokens: number
  }
  metadata?: {
    sessionId?: string
    [key: string]: unknown
  }
}

export interface HistoryRun {
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

export function applyArchivePoll(
  previousRuns: HistoryRun[],
  incomingRuns: HistoryRun[],
  selectedGoalID: string | null,
): { runs: HistoryRun[]; selectedGoalID: string | null } {
  const runs = incomingRuns.length === 0 && previousRuns.length > 0 ? previousRuns : incomingRuns
  const selectedStillExists = selectedGoalID !== null && runs.some((run) => run.summary.goalID === selectedGoalID)
  return {
    runs,
    selectedGoalID: selectedStillExists ? selectedGoalID : runs[0]?.summary.goalID ?? null,
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

/** A chain snapshot belongs to exactly one goal. The GUI must not treat a
 *  stale `.opencode/.goal-chain.json` from a previous session/goal as the
 *  current runtime chain for a new session. */
export function chainMatchesGoal(chain: { id: string }, state: GoalState | null | undefined): boolean {
  // Cross-validation 2026-06-26 — REVERTED the 7684bb013 sibling
  // change. The sibling's "return true for null/undefined/no
  // chainId" was correct for session-binding (handled by
  // goalBelongsToSession at server.ts:91) but WRONG for chain-
  // snapshot scoping. The contract test at goal-panel-contract
  // .test.ts:206-210 pins "state without chainId does NOT match
  // any chain" — which is the correct semantic for this function.
  //
  // The original (pre-sibling, pre-7684bb013) implementation was:
  //   const chainId = state?.metadata?.chainId
  //   return typeof chainId === "string" && chainId === chain.id
  // This returned false for null/undefined/missing-chainId — which
  // is what the test pins. The sibling's "return true" for the
  // null case was a regression that broke 1 contract test.
  //
  // Restored to the original 99243e2d0 contract.
  const chainId = state?.metadata?.chainId
  return typeof chainId === "string" && chainId === chain.id
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

export const ACTION_CATEGORIES = ["All", ...GOAL_TEMPLATE_CATEGORIES] as const
export type ActionCategory = (typeof ACTION_CATEGORIES)[number]

export function actionCategoryShortLabel(category: ActionCategory) {
  if (category === "Planning") return "Plan"
  if (category === "Building") return "Build"
  if (category === "Debugging") return "Debug"
  if (category === "Testing") return "Verify"
  if (category === "Review") return "Review"
  if (category === "Documentation") return "Docs"
  return category
}

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
  agent?: string
  skills?: string[]
  model?: GoalTemplateModel
  category?: GoalTemplateCategory
  gate?: GoalTemplateGate
  tone?: GoalTemplateTone
  elevation?: GoalTemplateElevation
  builtin: boolean
}

export interface GoalActionDraftState {
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

export type GoalActionDraftTemplate = GoalTemplateButton & { condition: string; builtin: false }

export interface GoalTemplateVariable {
  description?: string
  default?: string
}

export interface GoalAgentRoutingOption {
  name: string
  mode: "primary" | "subagent"
  label: string
  description?: string
}

export type ActionEditorControl = "save" | "duplicate" | "delete"
export type ActionEditorDisabledReason = "busy" | "missing-session" | "missing-prompt" | "no-template" | "builtin-template"

export function actionEditorControlState(input: {
  control: ActionEditorControl
  busy: boolean
  hasSession: boolean
  prompt: string
  selectedTemplate?: Pick<GoalTemplateButton, "builtin"> | null
}): { disabled: boolean; reason: ActionEditorDisabledReason | null } {
  if (input.busy) return { disabled: true, reason: "busy" }
  if (!input.hasSession) return { disabled: true, reason: "missing-session" }
  if (input.control === "delete") {
    if (!input.selectedTemplate) return { disabled: true, reason: "no-template" }
    if (input.selectedTemplate.builtin) return { disabled: true, reason: "builtin-template" }
    return { disabled: false, reason: null }
  }
  if (!cleanText(input.prompt).trim()) return { disabled: true, reason: "missing-prompt" }
  return { disabled: false, reason: null }
}

export type SkillPickerDisabledReason = "busy" | "missing-session" | "max-skills" | "no-skills"

export function skillPickerControlState(input: {
  busy: boolean
  hasSession: boolean
  availableSkillCount: number
  selectedSkillCount: number
  maxSkills?: number
}): { disabled: boolean; reason: SkillPickerDisabledReason | null } {
  const maxSkills = Math.max(1, Math.round(Number.isFinite(input.maxSkills) ? input.maxSkills ?? 8 : 8))
  const selectedSkillCount = Math.max(0, Math.round(Number.isFinite(input.selectedSkillCount) ? input.selectedSkillCount : 0))
  const availableSkillCount = Math.max(0, Math.round(Number.isFinite(input.availableSkillCount) ? input.availableSkillCount : 0))
  if (input.busy) return { disabled: true, reason: "busy" }
  if (!input.hasSession) return { disabled: true, reason: "missing-session" }
  if (selectedSkillCount >= maxSkills) return { disabled: true, reason: "max-skills" }
  if (availableSkillCount === 0) return { disabled: true, reason: "no-skills" }
  return { disabled: false, reason: null }
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

export function actionIDFromLabel(label: string, fallback = "custom-action") {
  const id = cleanText(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return TEMPLATE_ID_RE.test(id) && id.length > 0 ? id : fallback
}
const TEMPLATE_VAR_RE = /^\w+$/
const MAX_TEMPLATE_BUTTONS = 24
const MAX_TEMPLATE_SKILLS = 8
const MAX_AGENT_NAME_LEN = 80

export function agentNameForRuntime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const agent = cleanText(value).trim().slice(0, MAX_AGENT_NAME_LEN)
  return agent ? agent : undefined
}

export function agentRoutingOptions(value: unknown): GoalAgentRoutingOption[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const primary: GoalAgentRoutingOption[] = []
  const subagent: GoalAgentRoutingOption[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (record.hidden === true) continue
    const name = agentNameForRuntime(record.name)
    if (!name || seen.has(name)) continue
    const rawMode = record.mode
    if (rawMode !== "primary" && rawMode !== "subagent" && rawMode !== "all") continue
    seen.add(name)
    const description = cleanText(record.description).trim().slice(0, 140)
    const option: GoalAgentRoutingOption = {
      name,
      mode: rawMode === "subagent" ? "subagent" : "primary",
      label: name,
      ...(description ? { description } : {}),
    }
    if (option.mode === "subagent") subagent.push(option)
    else primary.push(option)
  }
  return [...primary, ...subagent]
}

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

function templateAgentFromSnapshot(value: unknown): string | undefined {
  return agentNameForRuntime(value)
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
    const agent = templateAgentFromSnapshot(r.agent) ?? fallback?.agent
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
      ...(agent ? { agent } : {}),
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

export function referencedTemplateVariables(condition: string, command: string) {
  const out = new Set<string>()
  for (const text of [condition, command]) {
    for (const match of text.matchAll(/\{(\w+)\}/g)) {
      if (match[1]) out.add(match[1])
    }
  }
  return out
}

export function actionDraftTemplateFromState(
  actionDraft: GoalActionDraftState,
  sourceTemplate?: Pick<GoalTemplateButton, "variables"> | null,
): GoalActionDraftTemplate {
  const id = actionDraft.id.trim() || actionIDFromLabel(actionDraft.label)
  const label = actionDraft.label.trim() || id
  const condition = actionDraft.prompt.trim()
  const command = actionDraft.command.trim()
  const referencedVars = referencedTemplateVariables(condition, command)
  const variables =
    sourceTemplate?.variables && referencedVars.size > 0
      ? (Object.fromEntries(
          Object.entries(sourceTemplate.variables).filter(([key]) => referencedVars.has(key)),
        ) as Record<string, GoalTemplateVariable>)
      : undefined
  const model = pinnedModelForRuntime(actionDraft.model)
  const agent = agentNameForRuntime(actionDraft.agent)
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
    ...(agent ? { agent } : {}),
    ...(actionDraft.skills.length > 0 ? { skills: [...actionDraft.skills] } : {}),
    ...(model ? { model } : {}),
    builtin: false,
  }
}

export interface GoalChainDraftStep {
  id: string
  actionID: string
  label: string
  condition: string
  /**
   * The raw condition before variable substitution (e.g. "Debug {scope}.").
   * Retained so the chain-level objective can fill `{scope}` at start time,
   * order-independently, without baking the objective into the saved action.
   * Optional for back-compat: older drafts/snapshots fall back to `condition`.
   */
  conditionTemplate?: string
  command: string
  maxTurns: number
  maxTimeMinutes: number
  category?: GoalTemplateCategory
  gate?: GoalTemplateGate
  tone?: GoalTemplateTone
  elevation?: GoalTemplateElevation
  agent?: string
  skills?: string[]
  model?: GoalTemplateModel
  builtin: boolean
}

export interface GoalChainMasterBudget {
  maxTurns: number
  maxTimeMinutes: number
}

/**
 * AG-P0-04 — choose which chain steps are runnable.
 *
 * Returns `draftSteps` if the user has populated the local draft.
 * Returns `visibleSteps` (the runtime chain snapshot) only when the
 * local draft is `uninitialized` — i.e. the user has never touched
 * the draft in this session. If `source === "draft"` but the steps
 * are empty, that is an EXPLICIT clear and we return empty (no
 * fallback). Without this guard, deleting the last step in a draft
 * would resurrect the runtime chain's steps ("the last X revives
 * the whole list" sequence).
 */
export function selectRunnableChainSteps<T>(
  draftSteps: T[],
  visibleSteps: T[],
  source: "uninitialized" | "draft" = "uninitialized",
): T[] {
  if (draftSteps.length > 0) return draftSteps;
  if (source === "draft") return [];
  return visibleSteps;
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
    conditionTemplate: template.condition,
    command: draft.command,
    maxTurns: clampPositiveInteger(template.constraints?.maxTurns, 5),
    maxTimeMinutes: clampPositiveInteger(template.constraints?.maxTimeMinutes, 20),
    ...(template.category ? { category: template.category } : {}),
    ...(template.gate ? { gate: template.gate } : {}),
    ...(template.tone ? { tone: template.tone } : {}),
    ...(template.elevation ? { elevation: template.elevation } : {}),
    ...(template.agent ? { agent: template.agent } : {}),
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

export interface GoalChainStartPayload {
  payload: string
  firstStepAgent?: string
  firstStepModel?: GoalPinnedModel
  firstStepSkills?: string[]
}

export type ChainStepVerificationContract =
  | { mode: "shell"; command: string; verification: { type: "shell"; command: string } }
  | { mode: "marker"; verification: { type: "marker" } }

export function pinnedModelForRuntime(model?: GoalTemplateModel): GoalPinnedModel | undefined {
  if (!model) return undefined
  if (isGoalPinnedModel(model)) {
    const providerID = cleanText(model.providerID).trim().slice(0, 160)
    const modelID = cleanText(model.modelID).trim().slice(0, 160)
    return providerID && modelID ? { providerID, modelID } : undefined
  }
  const clean = cleanText(model).trim()
  const sep = clean.indexOf(":")
  if (sep <= 0 || sep === clean.length - 1) return undefined
  const providerID = clean.slice(0, sep).trim().slice(0, 160)
  const modelID = clean.slice(sep + 1).trim().slice(0, 160)
  return providerID && modelID ? { providerID, modelID } : undefined
}

export function chainStepVerificationContract(commandInput: string | null | undefined): ChainStepVerificationContract {
  const command = (commandInput ?? "").trim()
  if (command) {
    return {
      mode: "shell",
      command,
      verification: { type: "shell", command },
    }
  }
  return {
    mode: "marker",
    verification: { type: "marker" },
  }
}

export function completionRuleTranslationKey(input: { command?: string | null }) {
  return chainStepVerificationContract(input.command).mode === "shell"
    ? "session.goal.template.completionShell"
    : "session.goal.template.completionMarker"
}

/**
 * Resolve a chain step's condition for execution. When the operator has typed a
 * run-level objective, it fills the `{scope}` slot in the step's raw template
 * ("Debug {scope}." → "Debug <objective>."). With no objective, the step keeps
 * its already-resolved condition (the per-action default). This is what lets a
 * generic action chain target a specific goal without editing the saved action.
 */
export function resolveStepConditionWithObjective(step: GoalChainDraftStep, objective: string): string {
  const scope = cleanText(objective).trim()
  if (!scope) return step.condition
  const template = step.conditionTemplate ?? step.condition
  if (!template.includes("{scope}")) return step.condition
  return template.replace(/\{scope\}/g, scope)
}

export function chainStartPayload(
  steps: GoalChainDraftStep[],
  master: GoalChainMasterBudget,
  objective = "",
): GoalChainStartPayload {
  const firstStepAgent = agentNameForRuntime(steps[0]?.agent)
  const firstStepModel = pinnedModelForRuntime(steps[0]?.model)
  const firstStepSkills = steps[0]?.skills && steps[0].skills.length > 0 ? [...steps[0].skills] : undefined
  const payload = JSON.stringify({
    master: { maxTurns: master.maxTurns, maxMinutes: master.maxTimeMinutes },
    steps: steps.map((step) => {
      const verification = chainStepVerificationContract(step.command)
      const agent = agentNameForRuntime(step.agent)
      const model = pinnedModelForRuntime(step.model)
      return {
        condition: resolveStepConditionWithObjective(step, objective),
        ...(verification.mode === "shell" ? { command: verification.command } : {}),
        verification: verification.verification,
        maxTurns: step.maxTurns,
        maxMinutes: step.maxTimeMinutes,
        ...(step.category ? { category: step.category } : {}),
        ...(step.tone ? { tone: step.tone } : {}),
        ...(step.elevation ? { elevation: step.elevation } : {}),
        ...(agent ? { agent } : {}),
        ...(step.skills && step.skills.length > 0 ? { skills: [...step.skills] } : {}),
        ...(model ? { model } : {}),
      }
    }),
  })
  return {
    payload,
    ...(firstStepAgent ? { firstStepAgent } : {}),
    ...(firstStepModel ? { firstStepModel } : {}),
    ...(firstStepSkills ? { firstStepSkills } : {}),
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

    if (step.agent !== undefined) {
      const agent = cleanText(step.agent).trim()
      if (agent && agent.length > MAX_AGENT_NAME_LEN) {
        errors.push({ stepIndex: i, message: `${label}: agent must be ${MAX_AGENT_NAME_LEN} chars or fewer.` })
      }
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
        if (trimmed && trimmed.length > MAX_STEP_MODEL_FIELD_LEN) {
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

export type ChainStartDisabledReason = "busy" | "live-goal" | "missing-session"

export function chainStartControlState(input: {
  busy: boolean
  hasLiveGoal: boolean
  hasSession: boolean
}): { disabled: boolean; reason: ChainStartDisabledReason | null } {
  if (input.busy) return { disabled: true, reason: "busy" }
  if (input.hasLiveGoal) return { disabled: true, reason: "live-goal" }
  if (!input.hasSession) return { disabled: true, reason: "missing-session" }
  return { disabled: false, reason: null }
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
  /** True when the most recent fetch failed with something other than
   *  a file-not-found / file-empty signal. Distinguishes "no goal" from
   *  "backend unreachable" so the panel can surface a connectivity hint
   *  instead of silently showing the empty state. (CENTER-AUDIT NCO1 fix.) */
  unreachable?: boolean
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

export type HandoffPanelMode = "hidden" | "pending" | "claim"

export function handoffPanelMode(liveGoal: GoalState | null, store: GoalHandoffStore): HandoffPanelMode {
  if (!store.handoff) return "hidden"
  return liveGoal ? "pending" : "claim"
}

export type SteerDraftDisposition = "retain" | "clear"

export function steerDraftDisposition(input: {
  commandSaved: boolean
  promptAttempted: boolean
  promptAdmitted: boolean
}): SteerDraftDisposition {
  if (!input.commandSaved) return "retain"
  if (input.promptAttempted && !input.promptAdmitted) return "retain"
  return "clear"
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
  } catch (err) {
    // CENTER-AUDIT NCO1 (2026-06-26): distinguish legitimate file-not-found
    // (no goal set) from backend-unreachable (server crashed, network blip,
    // 5xx). The pre-fix catch-all returned `{state: null}` for everything,
    // making a dead backend look identical to "no goal" — a user whose
    // server died mid-run saw the empty state with no signal.
    if (isFileNotFoundError(err)) {
      return { state: null, corrupt: false, loaded: true }
    }
    return { state: null, corrupt: false, loaded: true, unreachable: true }
  }
}

/** True when the error from sdk.client.file.read corresponds to the file
 *  not existing (the legitimate "no goal" case) rather than the backend
 *  itself being unreachable. The opencode SDK surfaces file-not-found as
 *  HTTP 404 or an Error whose message contains "ENOENT" / "not found" /
 *  "no such file". Any other shape (network error, 5xx, TypeError from a
 *  rejected fetch, etc.) means the backend is the problem — not absence. */
function isFileNotFoundError(err: unknown): boolean {
  if (!err) return false
  const probe = err as { status?: unknown; response?: { status?: unknown } }
  if (typeof probe.status === "number" && probe.status === 404) return true
  if (probe.response && typeof probe.response.status === "number" && probe.response.status === 404) return true
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : ""
  if (!msg) return false
  const lower = msg.toLowerCase()
  return (
    lower.includes("enoent") ||
    lower.includes("not found") ||
    lower.includes("no such file") ||
    lower.includes("does not exist")
  )
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

// ── AG-P1-05: visible-source routing for chain row actions ──────────────────
//
// The chain panel renders the same row layout for three distinct data
// sources: the local draft, the live runtime chain (current run), and
// the terminal run history (last completed run). The previous code used
// `liveGoal()` as a proxy to route the X button, which silently merged
// "user is editing the draft" with "user is viewing a live run" — the
// symptom was that X buttons claimed an operation the receiving backend
// rejected or interpreted differently (e.g. the X on a terminal-history
// row tried to delete from the live chain file).
//
// `ChainStepVisibleSource` is the metadata the row layout carries; the
// tsx layer attaches it to each row and the X-button handler routes by
// it, not by `liveGoal()`. This is testable in pure form here so the
// invariant survives future tsx refactors.

export type ChainStepVisibleSource = "draft" | "live" | "terminal-history";

export type ChainStepVisibleAction =
  | { kind: "edit-draft"; stepID: string }
  | { kind: "remove-live-pending"; index: number }
  | { kind: "dismiss-terminal" }
  | { kind: "noop" };

/**
 * AG-P1-05 — pick what action the X button (or any other row-level
 * destructive button) performs, given the visible source of the row
 * and the run-state metadata. The handler in the tsx layer dispatches
 * on `kind`; the pure module does not know about the backend.
 *
 * Invariants this function enforces (matches ticket AG-P1-05):
 *   1. Draft rows always edit local draft; they never reach the
 *      runtime chain file.
 *   2. Live rows route to the live-pending remover; the runner's
 *      own protection against removing running/done steps is
 *      preserved by the live layer (`removeLiveChainStep` already
 *      guards `index <= runningStepIndex()` for active runs).
 *   3. Terminal-history rows never touch the live chain file; the
 *      action is a distinct `dismiss-terminal` command, not a
 *      remove. The tsx layer wires this to archive/reset.
 *   4. Rows with `noop` action render the X as disabled (the tsx
 *      layer also handles `disabled` from run-state — this function
 *      just makes the contract explicit).
 */
export function chainStepVisibleAction(args: {
  source: ChainStepVisibleSource;
  stepID: string;
  index: number;
  /** Index of the currently-running live step, or -1 if no live run. */
  runningStepIndex: number;
  /** Live run status, or null if no live run. */
  liveRunStatus: "achieved" | "cleared" | "paused" | "active" | null;
}): ChainStepVisibleAction {
  if (args.source === "draft") {
    return { kind: "edit-draft", stepID: args.stepID };
  }
  if (args.source === "live") {
    // v0.7.3 / audit June 2026 — terminal-state escape hatch: when
    // the live run is in a terminal state (achieved / cleared) the
    // engine is no longer driving the run, and the chain file's
    // `current` index may still point at a step that the user wants
    // to clear. In that case we allow the remove; otherwise we
    // suppress it (the tsx layer's `disabled` already does the same).
    if (
      args.liveRunStatus === "achieved" ||
      args.liveRunStatus === "cleared"
    ) {
      return { kind: "remove-live-pending", index: args.index };
    }
    if (args.index > args.runningStepIndex) {
      return { kind: "remove-live-pending", index: args.index };
    }
    return { kind: "noop" };
  }
  // terminal-history: never mutate live chain. The action is a
  // distinct dismiss command (archives the terminal run).
  return { kind: "dismiss-terminal" };
}

// ── AG-P1-07: ordered chain refresh dispatch ────────────────────────────────
//
// The chain panel polls the runtime chain file every 2 seconds and also
// refreshes on user actions (start, advance, archive). The pre-fix code
// fired `void readChain(sdk).then(setChain)` from both paths; if two
// requests raced on the network, request 2 could finish first and commit,
// then request 1's late completion would overwrite the newer state.
// "Polling can no longer resurrect older chain state through out-of-order
// network completion." (ticket acceptance criterion.)
//
// `createOrderedChainRefresh` is the central ordering guard. Each
// `request()` bumps a monotonic generation counter and stores it on the
// in-flight Promise. When the Promise resolves, the result is committed
// ONLY if its generation matches the current generation — stale results
// are discarded.
//
// `dispose()` cancels future late commits (component cleanup). The
// returned `request()` Promise always resolves (never hangs forever),
// so `await refreshGoalSurfaces()` and the polling tick can rely on it.

export interface OrderedChainRefresh {
  /**
   * Request a refresh. Returns a Promise that resolves when this request's
   * result is either committed (and matched the current generation) or
   * discarded (because a newer request superseded it).
   */
  request(): Promise<void>;
  /**
   * Cancel any in-flight requests and prevent future late commits.
   * Idempotent. Safe to call from a SolidJS `onCleanup` handler.
   */
  dispose(): void;
}

export interface OrderedChainRefreshOptions {
  /**
   * v0.7.3 / scan 2026-06-25 (C3) — when true, concurrent calls to
   * `request()` while a previous request is still in flight return
   * the in-flight promise without starting a new read. The default
   * (false) preserves the pre-existing behavior of allowing
   * concurrent reads; the newer read wins via the generation
   * counter, the older read's result is discarded. Backpressure
   * trades potential stale-read-rejection for actual network
   * bandwidth savings under slow conditions.
   */
  backpressure?: boolean;
}

export function createOrderedChainRefresh<T>(
  readFn: () => Promise<T | null>,
  onCommit: (data: T | null) => void,
  opts: OrderedChainRefreshOptions = {},
): OrderedChainRefresh {
  const backpressure = opts.backpressure === true;
  // The current generation. Every request bumps it. Only the request
  // whose generation matches `current` at the moment its result resolves
  // gets to commit. After dispose(), the flag flips and all pending
  // resolves see it and skip the commit.
  let current = 0;
  let disposed = false;
  // v0.7.3 / scan 2026-06-25 (C3) — the in-flight promise when
  // backpressure is enabled. Concurrent request() calls return this
  // promise rather than starting a new read. Cleared on settle
  // (resolve OR reject — the next request starts a fresh read).
  let inFlight: Promise<void> | null = null;

  function request(): Promise<void> {
    if (disposed) return Promise.resolve();
    // v0.7.3 / scan 2026-06-25 (C3) — backpressure: if a request is
    // already in flight, return its promise. The caller can chain
    // off it; the underlying read will not be duplicated.
    if (backpressure && inFlight) return inFlight;
    const myGeneration = ++current;
    // Build the read promise. In backpressure mode, we wrap the
    // read's own onCommit callback to also clear inFlight when it
    // runs. Doing this synchronously inside the read's `.then`
    // (rather than via `.finally` on a returned promise) avoids a
    // microtask race where a sequential request() sees a stale
    // inFlight before the .finally microtask runs.
    const readPromise = readFn().then(
      (data) => {
        if (backpressure && inFlight && (inFlight as unknown) === (readPromise as unknown)) {
          inFlight = null;
        }
        if (disposed) return;
        // Discard stale results: if a newer request bumped the counter
        // beyond myGeneration, my result is no longer the latest. Drop it.
        if (myGeneration !== current) return;
        onCommit(data);
      },
      (err) => {
        if (backpressure && inFlight && (inFlight as unknown) === (readPromise as unknown)) {
          inFlight = null;
        }
        // Errors are also discarded if stale; the caller is responsible
        // for any logging (the tsx layer uses an `ignoreRefreshError` helper).
        // The throw is swallowed because the dispatch contract is
        // fire-and-forget — errors don't poison the ordering guard.
        void err;
      },
    );
    if (backpressure) {
      inFlight = readPromise;
    }
    return readPromise;
  }

  function dispose(): void {
    disposed = true;
    // Note: we don't clear `current` — any pending requests still in
    // flight will see `myGeneration !== current` and skip the commit.
    // That is the desired cleanup behavior: late network completions
    // can no longer resurrect older state.
  }

  return { request, dispose };
}
