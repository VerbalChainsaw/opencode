import { createEffect } from "solid-js"

export const newSessionDraftRouteKey = (draftID: string | undefined) => draftID ?? "new-session"

export const nextNewSessionDraftReset = (previousKey: string | undefined, draftID: string | undefined) => {
  const key = newSessionDraftRouteKey(draftID)
  return {
    key,
    shouldReset: previousKey !== key,
  }
}

export const createNewSessionDraftResetEffect = (draftID: () => string | undefined, reset: () => void) => {
  let previousKey: string | undefined
  createEffect(() => {
    const next = nextNewSessionDraftReset(previousKey, draftID())
    previousKey = next.key
    if (next.shouldReset) reset()
  })
}
