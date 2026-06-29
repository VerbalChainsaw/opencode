import { createSignal, type Accessor } from "solid-js"

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

/**
 * Disclosure (collapsed/expanded) state that snaps back to `defaultCollapsed`
 * whenever the `resetKey` accessor changes — e.g. a dock that re-collapses when
 * the session changes.
 *
 * The reconcile happens on READ rather than via a `createEffect`/`createMemo`.
 * The previous effect-based version was a no-op outside the browser (effects
 * don't run in Solid's SSR/test server build), so the reset silently never
 * fired in tests and could regress unnoticed. Read-time reconcile against a
 * tracked `resetKey` signal works in every build: `collapsed()` subscribes to
 * the resetKey and a toggle tick, and clears the user's override the moment the
 * resetKey moves on. Only plain locals are mutated during the read (never a
 * signal write), so there is no reactive loop.
 */
export function createSessionDisclosureState(input: {
  defaultCollapsed?: boolean
  resetKey?: Accessor<string | undefined>
}) {
  const defaultCollapsed = input.defaultCollapsed ?? false

  // Plain (non-reactive) state: the user's explicit value and the resetKey it
  // was set under. `null` value means "follow the default".
  let userValue: boolean | null = null
  let lastKey = input.resetKey?.()

  // A bump-only signal so toggle()/reset() re-trigger consumers of collapsed().
  const [tick, setTick] = createSignal(0)

  /** Reconcile the override against the current resetKey (mutating only locals). */
  function syncKey(): void {
    const key = input.resetKey?.()
    if (key !== lastKey) {
      lastKey = key
      userValue = null // snap back to default on a resetKey change
    }
  }

  const collapsed = (): boolean => {
    tick() // subscribe so toggle/reset re-render
    syncKey() // subscribe to resetKey + reconcile on read
    return userValue ?? defaultCollapsed
  }

  return {
    collapsed,
    toggle() {
      syncKey()
      userValue = !(userValue ?? defaultCollapsed)
      setTick((t) => t + 1)
    },
    reset() {
      userValue = null
      setTick((t) => t + 1)
    },
  }
}
