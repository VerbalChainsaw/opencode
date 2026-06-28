export type SessionAbortClient = {
  session: {
    abort(input: { sessionID: string }): Promise<unknown>
  }
}

export async function abortWorkingSessionTurn(input: {
  client: SessionAbortClient
  sessionID: string
  working: boolean
}): Promise<{ ok: true; attempted: boolean } | { ok: false; attempted: true; error: unknown }> {
  if (!input.working) return { ok: true, attempted: false }

  try {
    await input.client.session.abort({ sessionID: input.sessionID })
    return { ok: true, attempted: true }
  } catch (error) {
    return { ok: false, attempted: true, error }
  }
}
