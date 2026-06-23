// ─── PARITY CONTRACT ───
// This file is the Desktop bridge for the goal-control command language.
// It is the experimental-HTTP-API surface the GUI calls via
// /experimental/goal/control. Its public entry point is
// `runGoalControlStateFile`, and its return shape is
// {title, output, metadata}. Its behavior must match `command.ts` (the
// CLI dispatcher) on the shared command set so a GUI-set goal behaves
// identically to a /goal-set goal.
//
// That contract is locked by:
//   - test/dispatcher-parity.test.mjs
//   - test/control-state-bridge.test.mjs
// If you change action grammar, error mapping, or state-mutating
// primitive calls, BOTH test files must stay green UNCHANGED. Do not
// edit the parity tests to make a refactor pass.
//
// Atomic-write layer note: this file owns the randomUUID() tmp-rename
// pattern for the bridge's state files. The string-match test
// `test/v042-corrupt-surfacing.test.mjs:165-191` scans this file's
// source for the pattern, so the atomic-write code must stay here and
// must keep using randomUUID() (not Date.now()).
// ────────────────────────

import { randomUUID } from "node:crypto"
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { splitGoalCommand } from "./dispatcher.js"

// Canonical types from the plugin's state layer — single source of truth.
// control-state.ts is the EXPERIMENTAL API backend; it delegates type
// authority to goal-state.ts so the two implementations cannot drift.
import { editMaxTurns, editMaxTime, editMaxTokens, transitionGoal as goalTransitionGoal, restartGoal as goalRestartGoal, appendSteering as goalAppendSteering, clearSteering as goalClearSteering, editCondition as goalEditCondition, createHandoff as goalCreateHandoff, claimHandoff as goalClaimHandoff, type GoalStatus, type Verification } from "./goal-state.js"
import type { ChainWebhook, GoalPinnedModel } from "./goal-chain.js";
import { sanitizeChainWebhook } from "./goal-chain.js";

// Type aliases for backward compat with existing control-state callers.
// These are the SAME types, re-exported under the control-state naming
// convention so the experimental API surface is unchanged.
type GoalControlStatus = GoalStatus
type GoalControlVerification = Verification
type GoalControlPinnedModel = GoalPinnedModel

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
  // `cycles` and the master usage counters are REQUIRED by the runtime's
  // validateGoalChain (goal-chain.ts) — server.ts reads/advances chains through
  // that strict reader. A bridge chain missing them is rejected as corrupt and
  // never auto-advances. Keep these in lockstep with goal-chain.ts's GoalChain.
  cycles: number
  maxCycles: number
  onComplete: "stop" | "loop"
  // v0.4.1 E-1 (audit, June 2026): `webhook` is the chain-level webhook
  // projected to every step's `metadata.webhook` by
  // `applyChainWebhookToState` on advance. The CLI path promotes the
  // pre-chain state's webhook to this field. The bridge does the same
  // (see `startGoalChain`). Mirrors `GoalChain.webhook` in goal-chain.ts.
  webhook?: ChainWebhook
  master?: {
    maxTurns?: number
    maxMinutes?: number
    turnsUsed: number
    minutesUsed: number
  }
  metadata: {
    createdAt: number
    setBy: "chain"
    sessionId?: string
  }
}

interface GoalControlHandoff {
  createdAt: string
  state: GoalControlState
  note?: string
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
    sessionId?: string
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

export interface GoalControlStateFileOptions {
  sessionID?: string
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
  options: GoalControlStateFileOptions = {},
): Promise<GoalControlStateFileResult> {
  const tokens = splitGoalCommand(command)
  const action = tokens[0]?.toLowerCase()
  if (!action) throw new Error("Goal control command is empty.")

  if (action === "fresh" || action === "reset-state") return freshGoalState(directory, now)
  if (action === "set") return setGoalState(directory, tokens, now, options)
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
  if (action === "handoff") return createHandoff(directory, tokens.slice(1).join(" "), now)
  if (action === "claim") return claimHandoff(directory, now)
  if (action === "template") return editTemplate(directory, command, now)
  if (action === "chain") return editChain(directory, command, tokens, now, options)

  throw new Error(`Goal control action is not available in the native AutoGoal bridge: ${action}`)
}

async function setGoalState(
  directory: string,
  tokens: string[],
  now: number,
  options: GoalControlStateFileOptions = {},
) {
  const commandIndex = tokens.indexOf("--command")
  // Bound condition (4000) and verification command (1000) to match editCondition
  // and the template/chain paths — the CLI's `set` rejects over-length conditions,
  // so the bridge must not silently store an unbounded one.
  const condition = sanitizePromptText(
    tokens.slice(1, commandIndex === -1 ? undefined : commandIndex).join(" "),
  ).slice(0, 4000)
  if (!condition) throw new Error("Goal condition cannot be empty.")
  const verificationCommand =
    commandIndex === -1 ? null : sanitizePromptText(tokens.slice(commandIndex + 1).join(" ")).slice(0, 1000) || null

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
  const sessionId = sanitizeSessionID(options.sessionID)
  if (sessionId) next.metadata.sessionId = sessionId
  if (existing?.metadata.webhook) next.metadata.webhook = existing.metadata.webhook

  await writeGoalState(directory, next)
  return result(formatGoalSet(next, existing), "set")
}

async function freshGoalState(directory: string, now: number) {
  const paths = [
    goalStatePath(directory),
    goalChainPath(directory),
    goalHandoffPath(directory),
    sessionEventsPath(directory),
    stepTimelinePath(directory),
  ]
  let removed = 0
  for (const path of paths) {
    try {
      await unlinkWithRetry(path)
      removed += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return result(
    `OpenGoal state reset. Removed ${removed} live state file(s). Templates and history were left intact.`,
    "fresh",
    now,
  )
}

async function editConstraint(directory: string, field: "turns" | "time" | "tokens", value: number, now: number) {
  const edit = field === "turns" ? editMaxTurns : field === "time" ? editMaxTime : editMaxTokens
  const res = edit(directory, value, now)
  if (!res.ok) throw new Error(res.error ?? `Cannot edit ${field}.`)
  return result(res.message, field, now)
}

async function transitionGoal(directory: string, action: "pause" | "resume" | "clear", now: number) {
  const res = goalTransitionGoal(directory, action, now)
  // "already-in-state" is not a hard error — it means the goal was already
  // paused/active, which the bridge surfaces as a success with an info message.
  if (!res.ok && res.reason !== "already-in-state") {
    throw new Error(res.error ?? `Cannot ${action} goal.`)
  }
  const message = res.ok ? res.message! : res.error!
  return result(message, action, now)
}

async function restartGoal(directory: string, now: number) {
  const res = goalRestartGoal(directory, now)
  if (!res.ok) throw new Error(res.error ?? "Cannot restart goal.")
  return result(res.message, "restart", now)
}

async function appendSteering(directory: string, note: string, now: number) {
  const res = goalAppendSteering(directory, note, now)
  if (!res.ok) throw new Error(res.error ?? "Cannot append steering note.")
  return result(res.message, "steer", now)
}

async function clearSteering(directory: string, now: number) {
  const res = goalClearSteering(directory, now)
  if (!res.ok) throw new Error(res.error ?? "Cannot clear steering notes.")
  return result(res.message, "unsteer", now)
}

async function editCondition(directory: string, condition: string, now: number) {
  const res = goalEditCondition(directory, condition, now)
  if (!res.ok) throw new Error(res.error ?? "Cannot edit condition.")
  return result(res.message, "condition", now)
}

async function createHandoff(directory: string, note: string, now: number) {
  const res = goalCreateHandoff(directory, note, now)
  if (!res.ok) throw new Error(res.error ?? "Cannot create handoff.")
  return result(res.message, "handoff", now)
}

async function claimHandoff(directory: string, now: number) {
  const res = goalClaimHandoff(directory, now)
  if (!res.ok) throw new Error(res.error ?? "Cannot claim handoff.")
  return result(res.message, "claim", now)
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

async function editChain(
  directory: string,
  command: string,
  tokens: string[],
  now: number,
  options: GoalControlStateFileOptions = {},
) {
  const trimmed = command.trim()
  if (trimmed.startsWith(CHAIN_START_JSON_PREFIX))
    return startGoalChain(directory, trimmed.slice(CHAIN_START_JSON_PREFIX.length), now, options)
  if (tokens[1] === "add") return addChainStep(directory, tokens.slice(2).join(" "), now)
  // GUI sends 1-based positions; convert to 0-based for the move/remove ops
  // (move was previously passing 1-based straight through, so a 3-step chain's
  // `chain move 2 3` silently threw "out of range" and never moved anything).
  if (tokens[1] === "move")
    return moveChainStep(
      directory,
      parseIndex(tokens[2], "from") - 1,
      parseIndex(tokens[3], "to") - 1,
      now,
    )
  if (tokens[1] === "remove")
    return removeChainStep(directory, parseIndex(tokens[2], "index") - 1, now)
  throw new Error(
    "Usage: /goal chain start-json <json>, /goal chain add <condition>, /goal chain move <from> <to>, or /goal chain remove <index>.",
  )
}

async function startGoalChain(
  directory: string,
  payload: string,
  now: number,
  options: GoalControlStateFileOptions = {},
) {
  const chainPayload = sanitizeChainPayload(parseJsonObject(payload, "chain payload"))
  const path = goalChainPath(directory)
  const previousChain = await readFile(path, "utf8").catch(() => null)
  const sessionId = sanitizeSessionID(options.sessionID)
  // v0.4.1 E-1 parity (audit, June 2026): the CLI's `chain start` passes
  // `webhook: "from-state"` to `createGoalChain`, which projects the
  // pre-chain state's webhook onto `chain.webhook`. `applyChainWebhookToState`
  // (goal-chain.ts:518) then re-projects it onto every step's state on
  // advance. The bridge did not have this propagation — step 0 inherited
  // the webhook via `setActiveChainGoal`'s `existing.metadata.webhook`
  // copy, but step 1+ lost it because `chain.webhook` was undefined and
  // the same function DELETES any state-level webhook in that case.
  // The fix: read the prior state's webhook here and project it onto
  // `chain.webhook` so the canonical advance path keeps it.
  const existingState = await readGoalStateOptional(directory)
  const chainWebhook = existingState?.metadata?.webhook
    ? sanitizeChainWebhook(existingState.metadata.webhook)
    : null
  const chain: GoalControlChain = {
    version: 1,
    id: randomUUID(),
    steps: chainPayload.steps,
    current: 0,
    cycles: 0,
    // Default 10 cycles (matches goal-chain.ts createGoalChain / CLI parity),
    // not 1 — a chain with onComplete:"loop" must actually be able to loop, and
    // a bridge-started chain with no cycle limit set shouldn't stop at one pass.
    maxCycles: 10,
    onComplete: "stop",
    ...(chainWebhook ? { webhook: chainWebhook } : {}),
    ...(chainPayload.master
      ? { master: { ...chainPayload.master, turnsUsed: 0, minutesUsed: 0 } }
      : {}),
    metadata: {
      createdAt: now,
      setBy: "chain",
      ...(sessionId ? { sessionId } : {}),
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
  // The active step's metadata.chainTotal must reflect the new total so the
  // GUI's "step X of N" display doesn't go stale after an add.
  await updateActiveChainMetadata(directory, chain)
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

async function removeChainStep(directory: string, index: number, now: number) {
  const chain = await requireGoalChain(directory)
  if (index < 0 || index >= chain.steps.length) {
    throw new Error("Chain remove index is out of range.")
  }
  if (chain.steps.length <= 1) {
    throw new Error("Cannot remove the only step in the chain; clear the goal instead.")
  }
  if (index === chain.current) {
    throw new Error("Cannot remove the step that is currently running.")
  }
  // Preserve which step is active by identity, then re-derive its index after splice.
  const active = chain.steps[chain.current]
  const next = [...chain.steps]
  next.splice(index, 1)
  const current = active ? next.indexOf(active) : Math.min(chain.current, next.length - 1)
  chain.steps = next
  chain.current = current < 0 ? 0 : current
  await writeJsonAtomic(goalChainPath(directory), chain)
  await updateActiveChainMetadata(directory, chain)
  return result(`Chain step removed: ${index + 1}`, "chain", now)
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

async function readHandoffOptional(directory: string): Promise<GoalControlHandoff | null> {
  let content: string
  try {
    content = await readFile(goalHandoffPath(directory), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (content.length > 256 * 1024) throw new Error("Handoff file is too large.")
  const parsed = JSON.parse(content)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Handoff file is invalid.")
  const handoff = parsed as { createdAt?: unknown; state?: unknown; note?: unknown }
  if (typeof handoff.createdAt !== "string" || !isGoalControlState(handoff.state)) {
    throw new Error("Handoff file is invalid.")
  }
  return {
    createdAt: sanitizePromptText(handoff.createdAt),
    state: handoff.state,
    ...(typeof handoff.note === "string" && sanitizePromptText(handoff.note).trim()
      ? { note: sanitizePromptText(handoff.note).trim().slice(0, 500) }
      : {}),
  }
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
      ...(chain.metadata.sessionId ? { sessionId: chain.metadata.sessionId } : {}),
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

// Reset (`fresh`) deletes the live state files. On Windows the state/chain files
// are frequently held open by the plugin reader/watcher, so a bare unlink throws
// EPERM/EBUSY and the bridge maps it to a 400. Retry transient locks (ENOENT and
// other errors still throw so the caller can treat "already gone" as success).
async function unlinkWithRetry(path: string) {
  const delays = [25, 50, 100, 200]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(path)
      return
    } catch (error) {
      if (!isTransientRenameError(error) || attempt >= delays.length) throw error
      await sleep(delays[attempt]!)
    }
  }
}

function goalStatePath(directory: string) {
  return join(directory, ".opencode", ".goal-state.json")
}

function goalChainPath(directory: string) {
  return join(directory, ".opencode", ".goal-chain.json")
}

function goalHandoffPath(directory: string) {
  return join(directory, ".opencode", ".goal-handoff.json")
}

function sessionEventsPath(directory: string) {
  return join(directory, ".opencode", ".session-events.jsonl")
}

function stepTimelinePath(directory: string) {
  return join(directory, ".opencode", ".step-timeline.jsonl")
}

function templatePath(directory: string, id: string) {
  return join(directory, ".opencode", "goals", `${id}.json`)
}

function templateSnapshotPath(directory: string) {
  return join(directory, ".opencode", "goal-templates.json")
}

async function fileExists(path: string) {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
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

// Hardening caps for inline JSON command payloads (chain start-json, template
// import). The bridge accepts an unbounded command string, so a hostile/buggy
// client could otherwise feed a huge or deeply-nested payload straight into
// JSON.parse (CPU/memory DoS). Mirrors the CLI's parseInlineChainStartPayload.
const MAX_COMMAND_JSON_BYTES = 256 * 1024;
const MAX_COMMAND_JSON_DEPTH = 256;

/** Maximum bracket-nesting depth, counted outside JSON strings (pre-parse). */
function jsonNestingDepth(raw: string): number {
  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  let escape = false;
  for (const ch of raw) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") { depth++; if (depth > maxDepth) maxDepth = depth; }
    else if (ch === "}" || ch === "]") { depth--; }
  }
  return maxDepth;
}

function parseJsonObject(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required.`)
  // Bound size + nesting BEFORE JSON.parse to prevent CPU/memory DoS.
  if (Buffer.byteLength(value, "utf-8") > MAX_COMMAND_JSON_BYTES) {
    throw new Error(`${label} too large (max ${MAX_COMMAND_JSON_BYTES} bytes / 256KB).`)
  }
  if (jsonNestingDepth(value) > MAX_COMMAND_JSON_DEPTH) {
    throw new Error(`${label} exceeds maximum nesting depth of ${MAX_COMMAND_JSON_DEPTH} levels.`)
  }
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
    // Preserve cycles (required by goal-chain.ts validateGoalChain). Re-reading
    // a chain for an edit op must not strip it, or the chain becomes invalid.
    cycles: isNumber(value.cycles) && value.cycles >= 0 ? Math.floor(value.cycles) : 0,
    maxCycles: clampPositiveInteger(Reflect.get(value, "maxCycles"), 1),
    onComplete: Reflect.get(value, "onComplete") === "loop" ? "loop" : "stop",
    ...(master ? { master } : {}),
    metadata: {
      createdAt: isNumber(metadata.createdAt) ? metadata.createdAt : Date.now(),
      setBy: "chain",
      ...(sanitizeSessionID(metadata.sessionId) ? { sessionId: sanitizeSessionID(metadata.sessionId) } : {}),
    },
  }
}

function sanitizeChainMaster(value: unknown) {
  if (!isRecord(value)) return undefined
  const maxTurns = readPositiveInteger(value.maxTurns)
  const maxMinutes = readPositiveInteger(value.maxMinutes)
  if (!maxTurns && !maxMinutes) return undefined
  // turnsUsed/minutesUsed are REQUIRED by goal-chain.ts validateGoalChain when a
  // master budget is present — preserve them across reads (default 0) so an
  // advancing chain's accumulated usage survives an edit op.
  return {
    ...(maxTurns ? { maxTurns } : {}),
    ...(maxMinutes ? { maxMinutes } : {}),
    turnsUsed: isNumber(value.turnsUsed) && value.turnsUsed >= 0 ? Math.floor(value.turnsUsed) : 0,
    minutesUsed: isNumber(value.minutesUsed) && value.minutesUsed >= 0 ? Math.floor(value.minutesUsed) : 0,
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

function sanitizeControlMetadata(value: unknown): GoalControlState["metadata"] {
  const metadata = isRecord(value) ? value : {}
  const out: GoalControlState["metadata"] = {
    setBy: isSetBy(metadata.setBy) ? metadata.setBy : "user",
  }
  if (typeof metadata.previousId === "string") out.previousId = sanitizePromptText(metadata.previousId).slice(0, 160)
  if (typeof metadata.sessionId === "string") {
    const sessionId = sanitizeSessionID(metadata.sessionId)
    if (sessionId) out.sessionId = sessionId
  }
  if (isNumber(metadata.restartedAt)) out.restartedAt = metadata.restartedAt
  if (typeof metadata.chainId === "string") out.chainId = sanitizePromptText(metadata.chainId).slice(0, 160)
  if (isNumber(metadata.chainStep)) out.chainStep = metadata.chainStep
  if (isNumber(metadata.chainTotal)) out.chainTotal = metadata.chainTotal
  if (Array.isArray(metadata.steering)) {
    const steering = metadata.steering
      .filter((item): item is { at: number; note: string } => isRecord(item) && isNumber(item.at) && typeof item.note === "string")
      .map((item) => ({ at: item.at, note: sanitizePromptText(item.note).slice(0, 500) }))
      .filter((item) => item.note.length > 0)
      .slice(-20)
    if (steering.length > 0) out.steering = steering
  }
  if (isRecord(metadata.webhook) && typeof metadata.webhook.url === "string" && Array.isArray(metadata.webhook.on)) {
    const on = metadata.webhook.on.filter(isStatus)
    if (on.length > 0) {
      out.webhook = {
        url: sanitizePromptText(metadata.webhook.url).slice(0, 2048),
        on,
        ...(metadata.webhook.allowLocal === true ? { allowLocal: true } : {}),
      }
    }
  }
  return out
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

function sanitizePromptText(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff\ufff9-\ufffb]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
}

function sanitizeSessionID(value: unknown) {
  if (typeof value !== "string") return undefined
  const sessionId = sanitizePromptText(value).slice(0, 160)
  return sessionId || undefined
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
