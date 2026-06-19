import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

type GoalControlStatus = "active" | "paused" | "achieved" | "cleared"
type GoalControlSetBy = "user" | "template" | "chain"
type TemplateCategory =
  | "Planning"
  | "Building"
  | "Debugging"
  | "Testing"
  | "Review"
  | "Documentation"
  | "Release"
  | "Custom"
type TemplateGate = "required" | "pass" | "verify" | "review"
type TemplateTone = "violet" | "blue" | "orange" | "emerald" | "fuchsia" | "sky"
type TemplateElevation = "flat" | "raised"
type GoalControlPinnedModel = { providerID: string; modelID: string }
type GoalControlVerification =
  | { type: "shell"; command: string }
  | { type: "http"; url: string; expectStatus?: number; expectBody?: string; timeoutMs?: number }
  | { type: "file"; path: string; exists?: boolean; contains?: string }
  | { type: "marker" }

interface GoalControlChainStep {
  condition: string
  command?: string | null
  verification?: GoalControlVerification | null
  maxTurns?: number
  maxMinutes?: number
  category?: TemplateCategory
  gate?: TemplateGate
  tone?: TemplateTone
  elevation?: TemplateElevation
  skills?: string[]
  model?: GoalControlPinnedModel | string
}

interface GoalControlChain {
  version: 1
  id: string
  steps: GoalControlChainStep[]
  current: number
  maxCycles: number
  onComplete: "stop" | "loop"
  master?: {
    maxTurns?: number
    maxMinutes?: number
  }
  metadata: {
    createdAt: number
    setBy: "chain"
  }
}

export interface GoalControlState {
  version: number
  id: string
  condition: string
  command?: string | null
  verification?: GoalControlVerification | null
  status: GoalControlStatus
  createdAt: number
  startedAt: number
  completedAt: number | null
  pausedAt: number | null
  resumedAt: number | null
  turnsEvaluated: number
  tokensUsed: number
  lastEvaluation: unknown | null
  evaluationHistory: unknown[]
  constraints: {
    maxTurns: number
    maxTimeMinutes: number
    maxTokens: number
  }
  metadata: Record<string, unknown> & {
    setBy: GoalControlSetBy
    steering?: Array<{ at: number; note: string }>
    previousId?: string
    restartedAt?: number
  }
}

export interface GoalControlStateFileResult {
  title: string
  output: string
  metadata: Record<string, unknown>
}

const DEFAULT_CONSTRAINTS = {
  maxTurns: 20,
  maxTimeMinutes: 30,
  maxTokens: 100000,
}

const CONSTRAINT_BOUNDS = {
  minTurns: 1,
  maxTurns: 10000,
  minMinutes: 1,
  maxMinutes: 10000,
  minTokens: 1,
  maxTokens: 10000000,
}

const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]+$/
const TEMPLATE_CATEGORIES = [
  "Planning",
  "Building",
  "Debugging",
  "Testing",
  "Review",
  "Documentation",
  "Release",
  "Custom",
] as const
const TEMPLATE_GATES = ["required", "pass", "verify", "review"] as const
const TEMPLATE_TONES = ["violet", "blue", "orange", "emerald", "fuchsia", "sky"] as const
const TEMPLATE_ELEVATIONS = ["flat", "raised"] as const
const MAX_STEP_SKILLS = 8
const MAX_STEP_SKILL_LEN = 120
const MAX_STEP_MODEL_FIELD_LEN = 160
const TEMPLATE_IMPORT_PREFIX = ["template", "import", ""].join(" ")
const TEMPLATE_DELETE_PREFIX = ["template", "delete", ""].join(" ")
const CHAIN_START_JSON_PREFIX = ["chain", "start-json", ""].join(" ")

export async function runGoalControlStateFile(
  directory: string,
  command: string,
  now = Date.now(),
): Promise<GoalControlStateFileResult> {
  const tokens = splitGoalCommand(command)
  const action = tokens[0]?.toLowerCase()
  if (!action) throw new Error("Goal control command is empty.")

  if (action === "set") return setGoalState(directory, tokens, now)
  if (action === "turns") return editConstraint(directory, "turns", parseBoundedInt(tokens[1], "turns"), now)
  if (action === "time") return editConstraint(directory, "time", parseBoundedInt(tokens[1], "time"), now)
  if (action === "tokens") return editConstraint(directory, "tokens", parseBoundedInt(tokens[1], "tokens"), now)
  if (action === "pause") return transitionGoal(directory, "pause", now)
  if (action === "resume") return transitionGoal(directory, "resume", now)
  if (action === "clear") return transitionGoal(directory, "clear", now)
  if (action === "restart") return restartGoal(directory, now)
  if (action === "steer") return appendSteering(directory, tokens.slice(1).join(" "), now)
  if (action === "unsteer") return clearSteering(directory, now)
  if (action === "condition") return editCondition(directory, tokens.slice(1).join(" "), now)
  if (action === "template") return editTemplate(directory, command, now)
  if (action === "chain") return editChain(directory, command, tokens, now)

  throw new Error(`Goal control action is not available in the native AutoGoal bridge: ${action}`)
}

async function setGoalState(directory: string, tokens: string[], now: number) {
  const commandIndex = tokens.indexOf("--command")
  const condition = sanitizePromptText(tokens.slice(1, commandIndex === -1 ? undefined : commandIndex).join(" "))
  if (!condition) throw new Error("Goal condition cannot be empty.")
  const verificationCommand =
    commandIndex === -1 ? null : sanitizePromptText(tokens.slice(commandIndex + 1).join(" ")) || null

  const existing = await readGoalStateOptional(directory)
  const next: GoalControlState = {
    version: 1,
    id: randomUUID(),
    condition,
    command: verificationCommand,
    verification: verificationFromCommand(verificationCommand),
    status: "active",
    createdAt: now,
    startedAt: now,
    completedAt: null,
    pausedAt: null,
    resumedAt: null,
    turnsEvaluated: 0,
    tokensUsed: 0,
    lastEvaluation: null,
    evaluationHistory: [],
    constraints: { ...DEFAULT_CONSTRAINTS },
    metadata: { setBy: "user" },
  }
  if (existing?.metadata.webhook) next.metadata.webhook = existing.metadata.webhook

  await writeGoalState(directory, next)
  return result(formatGoalSet(next, existing), "set")
}

async function editConstraint(directory: string, field: "turns" | "time" | "tokens", value: number, now: number) {
  const state = await requireMutableGoal(directory)
  if (field === "turns") {
    if (value < CONSTRAINT_BOUNDS.minTurns || value > CONSTRAINT_BOUNDS.maxTurns) {
      throw new Error(`maxTurns must be in [${CONSTRAINT_BOUNDS.minTurns}, ${CONSTRAINT_BOUNDS.maxTurns}].`)
    }
    const oldValue = state.constraints.maxTurns
    state.constraints.maxTurns = value
    await writeGoalState(directory, state)
    return result(
      `Max turns: ${oldValue} -> ${value}${value <= state.turnsEvaluated ? " (loop will trip on next idle)" : ""}`,
      field,
      now,
    )
  }
  if (field === "time") {
    if (value < CONSTRAINT_BOUNDS.minMinutes || value > CONSTRAINT_BOUNDS.maxMinutes) {
      throw new Error(`maxTimeMinutes must be in [${CONSTRAINT_BOUNDS.minMinutes}, ${CONSTRAINT_BOUNDS.maxMinutes}].`)
    }
    const oldValue = state.constraints.maxTimeMinutes
    state.constraints.maxTimeMinutes = value
    await writeGoalState(directory, state)
    return result(`Max time: ${oldValue} -> ${value} min`, field, now)
  }

  if (value < CONSTRAINT_BOUNDS.minTokens || value > CONSTRAINT_BOUNDS.maxTokens) {
    throw new Error(`maxTokens must be in [${CONSTRAINT_BOUNDS.minTokens}, ${CONSTRAINT_BOUNDS.maxTokens}].`)
  }
  const oldValue = state.constraints.maxTokens
  state.constraints.maxTokens = value
  await writeGoalState(directory, state)
  return result(`Max tokens: ${oldValue} -> ${value}`, field, now)
}

async function transitionGoal(directory: string, action: "pause" | "resume" | "clear", now: number) {
  const state = await requireGoal(directory)
  if (action === "clear") {
    if (state.status !== "active" && state.status !== "paused") throw new Error("No active goal to clear.")
    state.status = "cleared"
    state.completedAt = now
    await writeGoalState(directory, state)
    return result(`Goal cleared. ${state.turnsEvaluated} turns were evaluated before clearing.`, action, now)
  }
  if (action === "pause") {
    if (state.status === "paused") return result("Goal is already paused.", action, now)
    if (state.status !== "active") throw new Error("No active goal to pause.")
    state.status = "paused"
    state.pausedAt = now
    await writeGoalState(directory, state)
    return result("Goal paused. Resume with `/goal resume`.", action, now)
  }

  if (state.status === "active") return result("Goal is already active.", action, now)
  if (state.status === "achieved") throw new Error("This goal was already achieved. Set a new goal instead.")
  if (state.status === "cleared") throw new Error("This goal was cleared. Set a new goal instead.")
  state.startedAt += state.pausedAt == null ? 0 : Math.max(0, now - state.pausedAt)
  state.status = "active"
  state.resumedAt = now
  await writeGoalState(directory, state)
  return result(`Goal resumed. ${state.turnsEvaluated} turns completed so far.`, action, now)
}

async function restartGoal(directory: string, now: number) {
  const state = await requireMutableGoal(directory)
  const next: GoalControlState = {
    ...state,
    id: randomUUID(),
    status: "active",
    createdAt: now,
    startedAt: now,
    completedAt: null,
    pausedAt: null,
    resumedAt: null,
    turnsEvaluated: 0,
    tokensUsed: 0,
    lastEvaluation: null,
    evaluationHistory: [],
    metadata: {
      ...state.metadata,
      previousId: state.id,
      restartedAt: now,
      steering: undefined,
    },
  }
  delete next.metadata.steering
  await writeGoalState(directory, next)
  return result(`Goal restarted. New id: ${next.id.slice(0, 8)}.`, "restart", now)
}

async function appendSteering(directory: string, note: string, now: number) {
  const cleaned = sanitizePromptText(note).slice(0, 500)
  if (!cleaned) throw new Error("Steering note is empty after sanitization.")
  const state = await requireMutableGoal(directory)
  const existing = Array.isArray(state.metadata.steering) ? state.metadata.steering : []
  const next = [...existing, { at: now, note: cleaned }].slice(-20)
  state.metadata.steering = next
  await writeGoalState(directory, state)
  return result(`Steering note added (${next.length} total).`, "steer", now)
}

async function clearSteering(directory: string, now: number) {
  const state = await requireGoal(directory)
  const cleared = Array.isArray(state.metadata.steering) ? state.metadata.steering.length : 0
  delete state.metadata.steering
  await writeGoalState(directory, state)
  return result(cleared === 0 ? "No steering notes to clear." : `Cleared ${cleared} steering notes.`, "unsteer", now)
}

async function editCondition(directory: string, condition: string, now: number) {
  const cleaned = sanitizePromptText(condition).slice(0, 4000)
  if (!cleaned) throw new Error("Condition is empty after sanitization.")
  const state = await requireMutableGoal(directory)
  const oldValue = state.condition
  state.condition = cleaned
  state.metadata.conditionEditedAt = now
  await writeGoalState(directory, state)
  return result(`Condition updated (${oldValue.length} -> ${cleaned.length} chars).`, "condition", now)
}

async function editTemplate(directory: string, command: string, now: number) {
  const trimmed = command.trim()
  if (trimmed.startsWith(TEMPLATE_IMPORT_PREFIX)) {
    const match = trimmed
      .slice(TEMPLATE_IMPORT_PREFIX.length)
      .trim()
      .match(/^([A-Za-z0-9_-]+)\s+([\s\S]+)$/)
    if (!match) throw new Error("Usage: /goal template import <id> <json>.")
    const id = requireTemplateID(match[1])
    const payload = sanitizeTemplatePayload(parseJsonObject(match[2], "template payload"))
    await writeJsonAtomic(templatePath(directory, id), payload)
    await upsertTemplateSnapshot(directory, id, payload)
    return result(`Template saved: ${id}`, "template", now)
  }
  if (trimmed.startsWith(TEMPLATE_DELETE_PREFIX)) {
    const id = requireTemplateID(trimmed.slice(TEMPLATE_DELETE_PREFIX.length).trim())
    await unlink(templatePath(directory, id)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    })
    await deleteTemplateSnapshot(directory, id)
    return result(`Template deleted: ${id}`, "template", now)
  }
  throw new Error("Usage: /goal template import <id> <json> or /goal template delete <id>.")
}

async function editChain(directory: string, command: string, tokens: string[], now: number) {
  const trimmed = command.trim()
  if (trimmed.startsWith(CHAIN_START_JSON_PREFIX))
    return startGoalChain(directory, trimmed.slice(CHAIN_START_JSON_PREFIX.length), now)
  if (tokens[1] === "add") return addChainStep(directory, tokens.slice(2).join(" "), now)
  if (tokens[1] === "move")
    return moveChainStep(directory, parseIndex(tokens[2], "from"), parseIndex(tokens[3], "to"), now)
  throw new Error("Usage: /goal chain start-json <json>, /goal chain add <condition>, or /goal chain move <from> <to>.")
}

async function startGoalChain(directory: string, payload: string, now: number) {
  const chainPayload = sanitizeChainPayload(parseJsonObject(payload, "chain payload"))
  const path = goalChainPath(directory)
  const previousChain = await readFile(path, "utf8").catch(() => null)
  const chain: GoalControlChain = {
    version: 1,
    id: randomUUID(),
    steps: chainPayload.steps,
    current: 0,
    maxCycles: 1,
    onComplete: "stop",
    ...(chainPayload.master ? { master: chainPayload.master } : {}),
    metadata: {
      createdAt: now,
      setBy: "chain",
    },
  }
  await writeJsonAtomic(path, chain)
  try {
    await setActiveChainGoal(directory, chain, now)
  } catch (error) {
    await restoreChainAfterFailedStart(path, previousChain)
    throw error
  }
  return result(`Chain started: step 1/${chain.steps.length} - ${chain.steps[0]!.condition}`, "chain", now)
}

async function addChainStep(directory: string, condition: string, now: number) {
  const chain = await requireGoalChain(directory)
  const cleaned = sanitizePromptText(condition).slice(0, 4000)
  if (!cleaned) throw new Error("Chain step condition cannot be empty.")
  chain.steps = [...chain.steps, { condition: cleaned }]
  await writeJsonAtomic(goalChainPath(directory), chain)
  return result(`Chain step added: ${chain.steps.length} - ${cleaned}`, "chain", now)
}

async function moveChainStep(directory: string, from: number, to: number, now: number) {
  const chain = await requireGoalChain(directory)
  if (from < 0 || from >= chain.steps.length || to < 0 || to >= chain.steps.length) {
    throw new Error("Chain move indexes are out of range.")
  }
  const active = chain.steps[chain.current]
  const next = [...chain.steps]
  const [step] = next.splice(from, 1)
  if (!step) throw new Error("Chain move indexes are out of range.")
  next.splice(to, 0, step)
  const current = active ? next.indexOf(active) : Math.min(chain.current, next.length - 1)
  chain.steps = next
  chain.current = current < 0 ? 0 : current
  await writeJsonAtomic(goalChainPath(directory), chain)
  await updateActiveChainMetadata(directory, chain)
  return result(`Chain step moved: ${from + 1} -> ${to + 1}`, "chain", now)
}

function result(output: string, command: string, now = Date.now()): GoalControlStateFileResult {
  return {
    title: "Goal control",
    output,
    metadata: {
      source: "state-file",
      command,
      updatedAt: now,
    },
  }
}

function formatGoalSet(state: GoalControlState, existing: GoalControlState | null) {
  return [
    "A goal has been set and is now your top priority.",
    existing && (existing.status === "active" || existing.status === "paused")
      ? `(Replaced previous goal: ${existing.condition})`
      : "",
    "",
    `GOAL: ${state.condition}`,
    state.command ? `Verification command: \`${state.command}\` - the goal is met when this exits 0.` : "",
    `Limits: up to ${state.constraints.maxTurns} turns / ${state.constraints.maxTimeMinutes} minutes.`,
  ]
    .filter((line) => line !== "")
    .join("\n")
}

async function requireMutableGoal(directory: string) {
  const state = await requireGoal(directory)
  if (state.status === "cleared" || state.status === "achieved") throw new Error(`Cannot edit a ${state.status} goal.`)
  return state
}

async function requireGoal(directory: string) {
  const state = await readGoalStateOptional(directory)
  if (!state) throw new Error("No active goal.")
  return state
}

async function readGoalStateOptional(directory: string): Promise<GoalControlState | null> {
  let content: string
  try {
    content = await readFile(goalStatePath(directory), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const parsed = JSON.parse(content)
  if (!isGoalControlState(parsed)) throw new Error("Goal state file is invalid.")
  return parsed
}

async function readGoalChainOptional(directory: string): Promise<GoalControlChain | null> {
  let content: string
  try {
    content = await readFile(goalChainPath(directory), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  return sanitizeGoalChain(JSON.parse(content))
}

async function requireGoalChain(directory: string) {
  const chain = await readGoalChainOptional(directory)
  if (!chain) throw new Error("No goal chain.")
  return chain
}

async function setActiveChainGoal(directory: string, chain: GoalControlChain, now: number) {
  const step = chain.steps[chain.current]
  if (!step) throw new Error("Goal chain has no active step.")
  const existing = await readGoalStateOptional(directory)
  const next: GoalControlState = {
    version: 1,
    id: randomUUID(),
    condition: step.condition,
    command: step.command ?? null,
    verification: step.verification ?? verificationFromCommand(step.command ?? null),
    status: "active",
    createdAt: now,
    startedAt: now,
    completedAt: null,
    pausedAt: null,
    resumedAt: null,
    turnsEvaluated: 0,
    tokensUsed: 0,
    lastEvaluation: null,
    evaluationHistory: [],
    constraints: {
      maxTurns: clampPositiveInteger(step.maxTurns, DEFAULT_CONSTRAINTS.maxTurns),
      maxTimeMinutes: clampPositiveInteger(step.maxMinutes, DEFAULT_CONSTRAINTS.maxTimeMinutes),
      maxTokens: DEFAULT_CONSTRAINTS.maxTokens,
    },
    metadata: {
      setBy: "chain",
      chainId: chain.id,
      chainStep: chain.current,
      chainTotal: chain.steps.length,
    },
  }
  if (existing?.metadata.webhook) next.metadata.webhook = existing.metadata.webhook
  await writeGoalState(directory, next)
}

async function updateActiveChainMetadata(directory: string, chain: GoalControlChain) {
  const state = await readGoalStateOptional(directory)
  if (!state || state.metadata.chainId !== chain.id) return
  state.metadata.chainStep = chain.current
  state.metadata.chainTotal = chain.steps.length
  await writeGoalState(directory, state)
}

async function writeGoalState(directory: string, state: GoalControlState) {
  await writeJsonAtomic(goalStatePath(directory), state)
}

async function restoreChainAfterFailedStart(path: string, previousChain: string | null) {
  if (previousChain === null) {
    await unlink(path).catch(() => undefined)
    return
  }
  await writeTextAtomic(path, previousChain).catch(() => undefined)
}

async function writeJsonAtomic(path: string, value: unknown) {
  await writeTextAtomic(path, JSON.stringify(value, null, 2) + "\n")
}

async function writeTextAtomic(path: string, value: string) {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, value, "utf8")
  await renameWithRetry(tmp, path).catch(async (error: unknown) => {
    await unlink(tmp).catch(() => undefined)
    throw error
  })
}

async function renameWithRetry(from: string, to: string) {
  const delays = [25, 50, 100, 200]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!isTransientRenameError(error) || attempt >= delays.length) throw error
      await sleep(delays[attempt]!)
    }
  }
}

function isTransientRenameError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const code = (error as { code?: unknown }).code
  return code === "EPERM" || code === "EACCES" || code === "EBUSY"
}

function goalStatePath(directory: string) {
  return join(directory, ".opencode", ".goal-state.json")
}

function goalChainPath(directory: string) {
  return join(directory, ".opencode", ".goal-chain.json")
}

function templatePath(directory: string, id: string) {
  return join(directory, ".opencode", "goals", `${id}.json`)
}

function templateSnapshotPath(directory: string) {
  return join(directory, ".opencode", "goal-templates.json")
}

async function upsertTemplateSnapshot(directory: string, id: string, payload: Record<string, unknown>) {
  const existing = await readTemplateSnapshot(directory)
  const next = [
    ...existing.filter((template) => template.id !== id),
    {
      id,
      builtin: false,
      ...payload,
    },
  ].slice(-24)
  await writeJsonAtomic(templateSnapshotPath(directory), { templates: next })
}

async function deleteTemplateSnapshot(directory: string, id: string) {
  const existing = await readTemplateSnapshot(directory)
  await writeJsonAtomic(templateSnapshotPath(directory), {
    templates: existing.filter((template) => template.id !== id),
  })
}

async function readTemplateSnapshot(directory: string): Promise<Array<Record<string, unknown> & { id: string }>> {
  let content: string
  try {
    content = await readFile(templateSnapshotPath(directory), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const parsed = JSON.parse(content)
  if (!isRecord(parsed) || !Array.isArray(parsed.templates)) return []
  return parsed.templates.filter((template): template is Record<string, unknown> & { id: string } => {
    return isRecord(template) && typeof template.id === "string" && TEMPLATE_ID_RE.test(template.id)
  })
}

function requireTemplateID(id: string | undefined) {
  if (!id || !TEMPLATE_ID_RE.test(id)) throw new Error("Template id must use letters, numbers, dashes, or underscores.")
  return id
}

function parseJsonObject(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required.`)
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object.`)
  return parsed
}

function sanitizeTemplatePayload(value: Record<string, unknown>): Record<string, unknown> {
  const condition = typeof value.condition === "string" ? sanitizePromptText(value.condition).slice(0, 4000) : ""
  if (!condition) throw new Error("Template condition cannot be empty.")
  const constraints = sanitizeConstraints(value.constraints)
  const variables = sanitizeVariables(value.variables)
  const skills = sanitizeSkills(value.skills)
  const model = sanitizePinnedModel(value.model)
  return {
    ...(typeof value.label === "string" ? { label: sanitizePromptText(value.label).slice(0, 120) } : {}),
    ...(typeof value.description === "string"
      ? { description: sanitizePromptText(value.description).slice(0, 400) }
      : {}),
    condition,
    ...(typeof value.command === "string" ? { command: sanitizePromptText(value.command).slice(0, 1000) } : {}),
    ...(constraints ? { constraints } : {}),
    ...(variables ? { variables } : {}),
    ...(isTemplateCategory(value.category) ? { category: value.category } : {}),
    ...(isTemplateGate(value.gate) ? { gate: value.gate } : {}),
    ...(isTemplateTone(value.tone) ? { tone: value.tone } : {}),
    ...(isTemplateElevation(value.elevation) ? { elevation: value.elevation } : {}),
    ...(skills ? { skills } : {}),
    ...(model ? { model } : {}),
  }
}

function sanitizeChainPayload(value: Record<string, unknown>) {
  if (!Array.isArray(value.steps)) throw new Error("Chain payload requires a steps array.")
  const steps = value.steps
    .map(sanitizeChainStep)
    .filter((step): step is GoalControlChainStep => !!step)
    .slice(0, 100)
  if (steps.length === 0) throw new Error("Goal chain requires at least one step.")
  const master = sanitizeChainMaster(value.master)
  return {
    steps,
    ...(master ? { master } : {}),
  }
}

function verificationFromCommand(command: string | null | undefined): GoalControlVerification {
  const cleaned = typeof command === "string" ? sanitizePromptText(command).slice(0, 1000) : ""
  return cleaned ? { type: "shell", command: cleaned } : { type: "marker" }
}

function sanitizeVerification(value: unknown): GoalControlVerification | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === "marker") return { type: "marker" }
  if (value.type === "shell") {
    const command = typeof value.command === "string" ? sanitizePromptText(value.command).slice(0, 1000) : ""
    return command ? { type: "shell", command } : undefined
  }
  if (value.type === "http") {
    const url = typeof value.url === "string" ? sanitizePromptText(value.url).slice(0, 2000) : ""
    if (!url) return undefined
    return {
      type: "http",
      url,
      ...(isNumber(value.expectStatus) ? { expectStatus: value.expectStatus } : {}),
      ...(typeof value.expectBody === "string"
        ? { expectBody: sanitizePromptText(value.expectBody).slice(0, 1000) }
        : {}),
      ...(readPositiveInteger(value.timeoutMs) ? { timeoutMs: readPositiveInteger(value.timeoutMs) } : {}),
    }
  }
  if (value.type === "file") {
    const path = typeof value.path === "string" ? sanitizePromptText(value.path).slice(0, 2000) : ""
    if (!path) return undefined
    return {
      type: "file",
      path,
      ...(typeof value.exists === "boolean" ? { exists: value.exists } : {}),
      ...(typeof value.contains === "string" ? { contains: sanitizePromptText(value.contains).slice(0, 1000) } : {}),
    }
  }
  return undefined
}

function sanitizeChainStep(value: unknown): GoalControlChainStep | undefined {
  if (!isRecord(value)) return undefined
  const condition = typeof value.condition === "string" ? sanitizePromptText(value.condition).slice(0, 4000) : ""
  if (!condition) return undefined
  const verification = sanitizeVerification(value.verification)
  const skills = sanitizeSkills(value.skills)
  const model = sanitizePinnedModel(value.model)
  return {
    condition,
    ...(typeof value.command === "string" ? { command: sanitizePromptText(value.command).slice(0, 1000) } : {}),
    ...(verification ? { verification } : {}),
    ...(readPositiveInteger(value.maxTurns) ? { maxTurns: readPositiveInteger(value.maxTurns) } : {}),
    ...(readPositiveInteger(value.maxMinutes) ? { maxMinutes: readPositiveInteger(value.maxMinutes) } : {}),
    ...(isTemplateCategory(value.category) ? { category: value.category } : {}),
    ...(isTemplateGate(value.gate) ? { gate: value.gate } : {}),
    ...(isTemplateTone(value.tone) ? { tone: value.tone } : {}),
    ...(isTemplateElevation(value.elevation) ? { elevation: value.elevation } : {}),
    ...(skills ? { skills } : {}),
    ...(model ? { model } : {}),
  }
}

function sanitizeSkills(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string") continue
    const skill = sanitizePromptText(item).slice(0, MAX_STEP_SKILL_LEN)
    if (!skill || seen.has(skill)) continue
    seen.add(skill)
    out.push(skill)
    if (out.length >= MAX_STEP_SKILLS) break
  }
  return out.length > 0 ? out : undefined
}

function sanitizePinnedModel(value: unknown): GoalControlPinnedModel | string | undefined {
  if (typeof value === "string") {
    const model = sanitizePromptText(value).slice(0, MAX_STEP_MODEL_FIELD_LEN)
    return model || undefined
  }
  if (!isRecord(value)) return undefined
  const providerID =
    typeof value.providerID === "string" ? sanitizePromptText(value.providerID).slice(0, MAX_STEP_MODEL_FIELD_LEN) : ""
  const modelID =
    typeof value.modelID === "string" ? sanitizePromptText(value.modelID).slice(0, MAX_STEP_MODEL_FIELD_LEN) : ""
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

function sanitizeGoalChain(value: unknown): GoalControlChain {
  if (!isRecord(value)) throw new Error("Goal chain file is invalid.")
  if (value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.steps)) {
    throw new Error("Goal chain file is invalid.")
  }
  const steps = value.steps.map(sanitizeChainStep).filter((step): step is GoalControlChainStep => !!step)
  if (steps.length === 0) throw new Error("Goal chain file is invalid.")
  const current = typeof value.current === "number" && Number.isInteger(value.current) ? value.current : 0
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const master = sanitizeChainMaster(value.master)
  return {
    version: 1,
    id: value.id,
    steps,
    current: Math.max(0, Math.min(steps.length - 1, current)),
    maxCycles: clampPositiveInteger(Reflect.get(value, "maxCycles"), 1),
    onComplete: Reflect.get(value, "onComplete") === "loop" ? "loop" : "stop",
    ...(master ? { master } : {}),
    metadata: {
      createdAt: isNumber(metadata.createdAt) ? metadata.createdAt : Date.now(),
      setBy: "chain",
    },
  }
}

function sanitizeChainMaster(value: unknown) {
  if (!isRecord(value)) return undefined
  const maxTurns = readPositiveInteger(value.maxTurns)
  const maxMinutes = readPositiveInteger(value.maxMinutes)
  if (!maxTurns && !maxMinutes) return undefined
  return {
    ...(maxTurns ? { maxTurns } : {}),
    ...(maxMinutes ? { maxMinutes } : {}),
  }
}

function sanitizeConstraints(value: unknown) {
  if (!isRecord(value)) return undefined
  const out: Record<string, number> = {}
  const maxTurns = readPositiveInteger(value.maxTurns)
  const maxTimeMinutes = readPositiveInteger(value.maxTimeMinutes)
  const maxTokens = readPositiveInteger(value.maxTokens)
  if (maxTurns) out.maxTurns = maxTurns
  if (maxTimeMinutes) out.maxTimeMinutes = maxTimeMinutes
  if (maxTokens) out.maxTokens = maxTokens
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeVariables(value: unknown) {
  if (!isRecord(value)) return undefined
  const out: Record<string, { description?: string; default?: string }> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^\w+$/.test(key) || !isRecord(raw)) continue
    out[key] = {
      ...(typeof raw.description === "string"
        ? { description: sanitizePromptText(raw.description).slice(0, 200) }
        : {}),
      ...(typeof raw.default === "string" ? { default: sanitizePromptText(raw.default).slice(0, 200) } : {}),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseIndex(value: string | undefined, label: string) {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`Chain move ${label} index must be a number.`)
  return Number(value)
}

function readPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function clampPositiveInteger(value: unknown, fallback: number) {
  return readPositiveInteger(value) ?? fallback
}

function isTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === "string" && (TEMPLATE_CATEGORIES as readonly string[]).includes(value)
}

function isTemplateGate(value: unknown): value is TemplateGate {
  return typeof value === "string" && (TEMPLATE_GATES as readonly string[]).includes(value)
}

function isTemplateTone(value: unknown): value is TemplateTone {
  return typeof value === "string" && (TEMPLATE_TONES as readonly string[]).includes(value)
}

function isTemplateElevation(value: unknown): value is TemplateElevation {
  return typeof value === "string" && (TEMPLATE_ELEVATIONS as readonly string[]).includes(value)
}

function parseBoundedInt(value: string | undefined, action: string) {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`Usage: /goal ${action} <number>.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Usage: /goal ${action} <number>.`)
  return parsed
}

function splitGoalCommand(command: string) {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (quote) throw new Error("Unclosed quote in goal control command.")
  if (current) tokens.push(current)
  return tokens
}

function sanitizePromptText(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff\ufff9-\ufffb]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
}

function isGoalControlState(value: unknown): value is GoalControlState {
  if (!isRecord(value)) return false
  if (typeof value.version !== "number") return false
  if (typeof value.id !== "string" || value.id.length === 0) return false
  if (typeof value.condition !== "string") return false
  if (!isStatus(value.status)) return false
  if (!isNumber(value.createdAt) || !isNumber(value.startedAt)) return false
  if (!isNullableNumber(value.completedAt) || !isNullableNumber(value.pausedAt) || !isNullableNumber(value.resumedAt)) {
    return false
  }
  if (!isNumber(value.turnsEvaluated) || !isNumber(value.tokensUsed)) return false
  if (!Array.isArray(value.evaluationHistory)) return false
  if (!isRecord(value.constraints)) return false
  if (!isNumber(value.constraints.maxTurns)) return false
  if (!isNumber(value.constraints.maxTimeMinutes)) return false
  if (!isNumber(value.constraints.maxTokens)) return false
  if (!isRecord(value.metadata)) return false
  if (!isSetBy(value.metadata.setBy)) return false
  if (!(value.command === undefined || value.command === null || typeof value.command === "string")) return false
  return value.verification === undefined || value.verification === null || sanitizeVerification(value.verification) !== undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value)
}

function isStatus(value: unknown): value is GoalControlStatus {
  return value === "active" || value === "paused" || value === "achieved" || value === "cleared"
}

function isSetBy(value: unknown): value is GoalControlSetBy {
  return value === "user" || value === "template" || value === "chain"
}
