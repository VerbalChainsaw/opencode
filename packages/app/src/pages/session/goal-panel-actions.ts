/** Pure action helper for `/goal ...` GUI controls. Extracted from the
 * TSX module so tests can import it without triggering client-only UI code. */
type GoalControlArguments = {
  directory?: string
  workspace?: string
  toolID: "goal_control"
  sessionID: string
  arguments: { command: string }
}

type GoalControlTransport = {
  post?: (args: {
    url: string
    path?: { toolID: "goal_control" }
    query?: {
      directory?: string
      workspace?: string
    }
    body: {
      directory?: string
      workspace?: string
      arguments: { command: string }
      sessionID: string
    }
  }) => Promise<unknown>
}

type GoalPromptAsyncInput = {
  sessionID: string
  directory?: string
  workspace?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

type GoalAbortInput = {
  sessionID: string
  directory?: string
  workspace?: string
}

export interface GoalCommandClient {
  client?: GoalControlTransport
  tool?: {
    client?: GoalControlTransport
    control?: (this: { client?: GoalControlTransport }, args: GoalControlArguments) => Promise<unknown>
  }
  session?: {
    abort?: (args: GoalAbortInput) => Promise<unknown>
    command?: (args: { sessionID: string; command: string; arguments: string }) => Promise<unknown>
    promptAsync?: (args: GoalPromptAsyncInput & { parts: Array<{ type: "text"; text: string }> }) => Promise<unknown>
  }
}

const START_GOAL_PROMPT =
  "Begin working toward the current OpenGoal goal now. Read .opencode/.goal-state.json for the condition, constraints, steering, and verification command. Continue until the goal is achieved, blocked, or the constraints require stopping."

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
  try {
    if (!client.session?.promptAsync) return false
    await client.session.promptAsync({
      ...input,
      parts: [
        {
          type: "text",
          text: START_GOAL_PROMPT,
        },
      ],
    })
    return true
  } catch {
    return false
  }
}

export async function stopGoalRun(client: GoalCommandClient, input: GoalAbortInput) {
  try {
    if (!client.session?.abort) return false
    await client.session.abort(input)
    return true
  } catch {
    return false
  }
}
