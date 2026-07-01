/** Pure action helper for `/goal ...` GUI controls. Extracted from the
 * TSX module so tests can import it without triggering client-only UI code. */
type GoalControlArguments = {
  directory?: string
  workspace?: string
  toolID: "goal_control"
  sessionID: string
  arguments: { command: string }
}

type GoalTransport = {
  post?: (args: {
    url: string
    path?: Record<string, string>
    query?: {
      directory?: string
      workspace?: string
    }
    body?: unknown
  }) => Promise<unknown>
}

type GoalPromptAsyncInput = {
  sessionID: string
  directory?: string
  workspace?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  skills?: string[]
  variant?: string
}

type GoalSessionScope = {
  sessionID: string
  directory?: string
  workspace?: string
}

export interface GoalCommandClient {
  client?: GoalTransport
  tool?: {
    client?: GoalTransport
    control?: (this: { client?: GoalTransport }, args: GoalControlArguments) => Promise<unknown>
  }
  session?: {
    abort?: (args: GoalSessionScope) => Promise<unknown>
    children?: (args: GoalSessionScope) => Promise<unknown>
    prompt?: (args: {
      sessionID: string
      directory?: string
      workspace?: string
      parts: Array<{ type: "text"; text: string }>
    }) => Promise<unknown>
    promptAsync?: (args: {
      sessionID: string
      directory?: string
      workspace?: string
      agent?: string
      model?: { providerID: string; modelID: string }
      variant?: string
      parts: Array<{ type: "text"; text: string }>
    }) => Promise<unknown>
    command?: (args: { sessionID: string; command: string; arguments: string }) => Promise<unknown>
  }
}

export type GoalControlResult = { ok: true; warning?: string } | { ok: false; error: string }
export type GoalPromptRunResult =
  | { ok: true }
  | { ok: false; reason: "delivery-failed" | "stale-suppressed" }

export type GoalPromptAdmissionGuard = {
  shouldContinue?: () => boolean | Promise<boolean>
  onStaleDelivery?: () => Promise<void> | void
}

const START_GOAL_PROMPT =
  "Begin working toward the current OpenGoal goal now. Read .opencode/.goal-state.json for the condition, constraints, steering, and verification command. Continue until the goal is achieved, blocked, or the constraints require stopping."

function errorText(error: unknown) {
  if (error instanceof Error) {
    const parsed = tryParseGoalControlErrorBody(error.message)
    if (parsed) return parsed
    // Effect-TS wraps errors as "Effect.tryPromise: <detail>" or just
    // "Effect.tryPromise" with the real cause on error.cause. Unwrap so
    // the user sees the actionable message, not the framework envelope.
    let msg = error.message
    if (msg.startsWith("Effect.")) {
      const colonIdx = msg.indexOf(": ")
      if (colonIdx > 0) msg = msg.slice(colonIdx + 2)
      else if (error.cause instanceof Error) msg = error.cause.message
      else if (error.cause) msg = String(error.cause)
      else msg = "request failed"
    }
    return msg
  }
  return String(error)
}

function tryParseGoalControlErrorBody(raw: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith("{")) return null
  try {
    const obj = JSON.parse(trimmed)
    const data = obj?.data
    if (data && typeof data === "object" && typeof data.message === "string" && data.message) {
      return data.message
    }
  } catch {
    return null
  }
  return null
}

function cleanPinnedSkills(skills: string[] | undefined) {
  if (!skills) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of skills) {
    if (typeof item !== "string") continue
    const skill = item
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
      .trim()
      .slice(0, 80)
    if (!skill || seen.has(skill)) continue
    seen.add(skill)
    out.push(skill)
    if (out.length >= 8) break
  }
  return out
}

function withPinnedSkills(text: string, skills: string[] | undefined) {
  const clean = cleanPinnedSkills(skills)
  if (clean.length === 0) return text
  return [
    text,
    "",
    `Pinned skills for this OpenGoal action: ${clean.join(", ")}.`,
    "If these skills are available, load and use them before working this action.",
  ].join("\n")
}

function goalSessionScope(input: GoalSessionScope, sessionID = input.sessionID): GoalSessionScope {
  return {
    sessionID,
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
  }
}

function childSessionIDs(response: unknown) {
  const data =
    response && typeof response === "object" && "data" in response
      ? (response as { data?: unknown }).data
      : response
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const item of data) {
    if (!item || typeof item !== "object") continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== "string" || !id.trim()) continue
    ids.push(id)
  }
  return ids
}

async function collectSessionTreeIDs(client: GoalCommandClient, input: GoalSessionScope) {
  if (!client.session?.children) return { ids: [input.sessionID], warnings: [] }
  const ids = [input.sessionID]
  const seen = new Set(ids)
  const queue = [input.sessionID]
  const warnings: string[] = []
  for (let i = 0; i < queue.length; i++) {
    const parentID = queue[i]
    if (!parentID) continue
    let response: unknown
    try {
      response = await client.session.children(goalSessionScope(input, parentID))
    } catch (error) {
      warnings.push(`${parentID} children were not discovered: ${errorText(error)}`)
      continue
    }
    for (const childID of childSessionIDs(response)) {
      if (seen.has(childID)) continue
      seen.add(childID)
      ids.push(childID)
      queue.push(childID)
    }
  }
  return { ids, warnings }
}

async function abortActiveSessionTree(
  client: GoalCommandClient,
  input: GoalSessionScope,
) {
  if (!client.session?.abort) {
    return { attempted: false, warnings: ["this OpenCode client cannot abort the active turn."] } as const
  }

  const tree = await collectSessionTreeIDs(client, input)
  const warnings = [...tree.warnings]

  const abortIDs = [...tree.ids].reverse()
  for (const sessionID of abortIDs) {
    try {
      await client.session.abort(goalSessionScope(input, sessionID))
    } catch (error) {
      warnings.push(`${sessionID} did not abort: ${errorText(error)}`)
    }
  }

  return { attempted: true, warnings } as const
}

export async function abortGoalSessionTree(client: GoalCommandClient, input: GoalSessionScope) {
  return abortActiveSessionTree(client, input)
}

function uniqueMessages(items: string[]) {
  return [...new Set(items.filter(Boolean))]
}

function formatAbortWarning(label: "Goal cleared" | "Goal paused", warnings: string[]) {
  return `${label}, but ${uniqueMessages(warnings).join("; ")}`
}

function formatFailedControlAbortContext(attempted: boolean, warnings: string[]) {
  const status = attempted
    ? "active session tree abort completed before control and after control"
    : "active session tree abort was unavailable"
  const unique = uniqueMessages(warnings)
  if (unique.length === 0) return status
  return `${status}; abort warnings: ${unique.join("; ")}`
}

async function executeGoalCommandWithHardAbort(
  client: GoalCommandClient,
  input: {
    sessionID: string
    directory?: string
    workspace?: string
    abortActiveTurn?: boolean
  },
  command: "clear" | "pause",
  label: "Goal cleared" | "Goal paused",
) {
  if (!input.abortActiveTurn) {
    return executeGoalCommand(client, {
      sessionID: input.sessionID,
      arguments: command,
      directory: input.directory,
      workspace: input.workspace,
    })
  }

  const before = await abortActiveSessionTree(client, input)
  const result = await executeGoalCommand(client, {
    sessionID: input.sessionID,
    arguments: command,
    directory: input.directory,
    workspace: input.workspace,
  })
  const after = before.attempted ? await abortActiveSessionTree(client, input) : { attempted: false, warnings: [] }
  const warnings = uniqueMessages([...before.warnings, ...after.warnings])
  if (result.ok) {
    if (warnings.length > 0) return { ok: true, warning: formatAbortWarning(label, warnings) } as const
    return { ok: true } as const
  }

  return { ok: false, error: `${result.error}; ${formatFailedControlAbortContext(before.attempted, warnings)}` } as const
}

export function goalSteerPrompt(note: string) {
  return `Steering update for the current OpenGoal run. Apply this direction to the active or next continuation without restarting the goal:\n\n${note}`
}

async function sendGoalPromptGuarded(
  client: GoalCommandClient,
  input: GoalPromptAsyncInput,
  text: string,
  guard: GoalPromptAdmissionGuard = {},
): Promise<GoalPromptRunResult> {
  const shouldContinue = async () => guard.shouldContinue ? await guard.shouldContinue() : true
  if (!(await shouldContinue())) return { ok: false, reason: "stale-suppressed" }

  const finalizeAdmission = async (): Promise<GoalPromptRunResult> => {
    if (!(await shouldContinue())) {
      await guard.onStaleDelivery?.()
      return { ok: false, reason: "stale-suppressed" }
    }
    return { ok: true }
  }

  const { skills, ...promptInput } = input
  const payload = {
    ...promptInput,
    parts: [
      {
        type: "text" as const,
        text: withPinnedSkills(text, skills),
      },
    ],
  }
  try {
    // Prefer session.prompt (host composer path) over promptAsync so the
    // nudge enters the same lifecycle as a real composer send.
    if (client.session?.prompt) {
      await client.session.prompt(payload)
      return finalizeAdmission()
    }
    if (client.session?.promptAsync) {
      await client.session.promptAsync(payload)
      return finalizeAdmission()
    }
  } catch {
    // Fall back to the raw transport below. The desktop SDK surface can change
    // shape faster than this local helper, but the HTTP endpoint is stable.
  }

  if (!(await shouldContinue())) return { ok: false, reason: "stale-suppressed" }

  const transport = client.client
  if (!transport?.post) return { ok: false, reason: "delivery-failed" }
  const { sessionID, directory, workspace, ...body } = payload
  const query = {
    ...(directory ? { directory } : {}),
    ...(workspace ? { workspace } : {}),
  }
  try {
    await transport.post({
      url: "/session/{sessionID}/message",
      path: { sessionID },
      query,
      body,
    })
    return finalizeAdmission()
  } catch {
    return { ok: false, reason: "delivery-failed" }
  }
}

async function sendGoalPrompt(client: GoalCommandClient, input: GoalPromptAsyncInput, text: string) {
  return (await sendGoalPromptGuarded(client, input, text)).ok
}

export async function executeGoalCommand(
  client: GoalCommandClient,
  input: {
    sessionID: string
    arguments: string
    directory?: string
    workspace?: string
  },
) {
  const payload = {
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    sessionID: input.sessionID,
    arguments: { command: input.arguments },
  }
  const toolPayload: GoalControlArguments = {
    ...payload,
    toolID: "goal_control",
  }
  const scope = {
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
  }
  const transport = client.client ?? client.tool?.client
  const failures: string[] = []
  if (transport?.post) {
    try {
      await transport.post({
        url: "/experimental/goal/control/{toolID}",
        path: { toolID: "goal_control" },
        query: scope,
        body: payload,
      })
      return { ok: true } as const
    } catch (error) {
      failures.push(`POST /experimental/goal/control failed: ${errorText(error)}`)
      // Fall through to generated SDK control method if present.
    }
  }

  try {
    if (client.tool?.control) {
      await client.tool.control.call(client.tool, toolPayload)
      return { ok: true } as const
    }
    failures.push("native goal control bridge is unavailable")
  } catch (error) {
    failures.push(`generated goal control failed: ${errorText(error)}`)
  }
  return { ok: false, error: failures.join("; ") || "native goal control bridge is unavailable" } as const
}

export async function startGoalRun(client: GoalCommandClient, input: GoalPromptAsyncInput) {
  return sendGoalPrompt(client, input, START_GOAL_PROMPT)
}

export async function startGoalRunGuarded(
  client: GoalCommandClient,
  input: GoalPromptAsyncInput,
  guard: GoalPromptAdmissionGuard = {},
): Promise<GoalPromptRunResult> {
  return sendGoalPromptGuarded(client, input, START_GOAL_PROMPT, guard)
}

export async function stopGoalRun(
  client: GoalCommandClient,
  input: {
    sessionID: string
    directory?: string
    workspace?: string
    abortActiveTurn?: boolean
  },
) {
  return executeGoalCommandWithHardAbort(client, input, "clear", "Goal cleared")
}

export async function resetGoalWorkspaceState(
  client: GoalCommandClient,
  input: {
    sessionID: string
    directory?: string
    workspace?: string
  },
) {
  return executeGoalCommand(client, {
    sessionID: input.sessionID,
    arguments: "fresh",
    directory: input.directory,
    workspace: input.workspace,
  })
}

/** Hard pause: set the goal to `paused` AND abort the in-flight assistant
 *  turn so the chat stops immediately. Unlike `stopGoalRun` the goal is left
 *  resumable (status `paused`, not `cleared`). Without `abortActiveTurn` it is
 *  a plain soft pause (state only, current turn keeps running). */
export async function pauseGoalRun(
  client: GoalCommandClient,
  input: {
    sessionID: string
    directory?: string
    workspace?: string
    abortActiveTurn?: boolean
  },
) {
  return executeGoalCommandWithHardAbort(client, input, "pause", "Goal paused")
}

export async function steerGoalRun(client: GoalCommandClient, input: GoalPromptAsyncInput, note: string) {
  const clean = note.trim()
  if (!clean) return false
  return sendGoalPrompt(client, input, goalSteerPrompt(clean))
}

export async function steerGoalRunGuarded(
  client: GoalCommandClient,
  input: GoalPromptAsyncInput,
  note: string,
  guard: GoalPromptAdmissionGuard = {},
): Promise<GoalPromptRunResult> {
  const clean = note.trim()
  if (!clean) return { ok: false, reason: "delivery-failed" }
  return sendGoalPromptGuarded(client, input, goalSteerPrompt(clean), guard)
}
