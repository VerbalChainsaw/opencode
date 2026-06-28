export function isSessionSyncNotFound(error: unknown) {
  const status = (error as { cause?: { status?: unknown } } | undefined)?.cause?.status
  return status === 404
}

export async function syncSessionOrIgnoreNotFound<T>(
  sessionID: string | undefined,
  syncSession: (sessionID: string) => Promise<T>,
) {
  if (!sessionID) return undefined
  try {
    return await syncSession(sessionID)
  } catch (error) {
    if (isSessionSyncNotFound(error)) return undefined
    throw error
  }
}
