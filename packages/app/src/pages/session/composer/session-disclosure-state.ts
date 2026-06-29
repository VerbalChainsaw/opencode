import { createEffect, untrack, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

export function reconcileDisclosureCollapsed(input: {
  collapsed: boolean
  defaultCollapsed: boolean
  previousResetKey?: string
  nextResetKey?: string
}) {
  if (input.nextResetKey === undefined) return input.collapsed
  if (input.nextResetKey === input.previousResetKey) return input.collapsed
  return input.defaultCollapsed
}

export function createSessionDisclosureState(input: {
  defaultCollapsed?: boolean
  resetKey?: Accessor<string | undefined>
}) {
  const defaultCollapsed = input.defaultCollapsed ?? false
  const [store, setStore] = createStore({
    collapsed: defaultCollapsed,
    resetKey: input.resetKey?.(),
  })

  createEffect(() => {
    const nextResetKey = input.resetKey?.()
    const previousResetKey = untrack(() => store.resetKey)
    const collapsed = untrack(() => store.collapsed)
    const nextCollapsed = reconcileDisclosureCollapsed({
      collapsed,
      defaultCollapsed,
      previousResetKey,
      nextResetKey,
    })
    if (nextCollapsed !== collapsed) setStore("collapsed", nextCollapsed)
    if (nextResetKey !== previousResetKey) setStore("resetKey", nextResetKey)
  })

  return {
    collapsed: () => store.collapsed,
    toggle() {
      setStore("collapsed", (value) => !value)
    },
    reset() {
      setStore("collapsed", defaultCollapsed)
    },
  }
}
