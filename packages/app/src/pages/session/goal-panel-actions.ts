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

export interface GoalCommandClient {
  client?: GoalTransport
  tool?: {
    client?: GoalTransport
    control?: (this: { client?: GoalTransport }, args: GoalControlArguments) => Promise<unknown>
  }
  session?: {
    command?: (args: { sessionID: string; command: string; arguments: string }) => Promise<unknown>
    promptAsync?: (args: GoalPromptAsyncInput & { parts: Array<{ type: "text"; text: string }> }) => Promise<unknown>
    prompt?: (args: GoalPromptAsyncInput & { parts: Array<{ type: "text"; text: string }> }) => Promise<unknown>
  }
}

const START_GOAL_PROMPT =
  "Begin working toward the current OpenGoal goal now. Read .opencode/.goal-state.json for the condition, constraints, steering, and verification command. Continue until the goal is achieved, blocked, or the constraints require stopping."

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

export function goalSteerPrompt(note: string) {
  return `Steering update for the current OpenGoal run. Apply this direction to the active or next continuation without restarting the goal:\n\n${note}`
}

async function sendGoalPrompt(client: GoalCommandClient, input: GoalPromptAsyncInput, text: string) {
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
      return true
    }
    if (client.session?.promptAsync) {
      await client.session.promptAsync(payload)
      return true
    }
  } catch {
    // Fall back to the raw transport below. The desktop SDK surface can change
    // shape faster than this local helper, but the HTTP endpoint is stable.
  }

  const transport = client.client
  if (!transport?.post) return false
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
    return true
  } catch {
    return false
  }
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
  const tool = client.tool
  const scope = {
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
  }
  const payload = {
    ...scope,
    sessionID: input.sessionID,
    arguments: { command: input.arguments },
  }
  try {
    const transport = client.client ?? tool?.client
    if (transport?.post) {
      await transport.post({
        url: "/experimental/goal/control/{toolID}",
        path: { toolID: "goal_control" },
        query: scope,
        body: payload,
      })
      return true
    }
    if (tool?.control) {
      // Fallback for SDK/client shapes that expose only the generated method.
      // Keep the method call bound to the SDK Tool instance; the generated
      // method reads `this.client` and fails before issuing a request if it is
      // called as a detached function.
      await tool.control({
        toolID: "goal_control",
        ...payload,
      })
      return true
    }
    return false
  } catch {
    return false
  }
}

export async function startGoalRun(client: GoalCommandClient, input: GoalPromptAsyncInput) {
  return sendGoalPrompt(client, input, START_GOAL_PROMPT)
}

export async function steerGoalRun(client: GoalCommandClient, input: GoalPromptAsyncInput, note: string) {
  const clean = note.trim()
  if (!clean) return false
  return sendGoalPrompt(client, input, goalSteerPrompt(clean))
}
