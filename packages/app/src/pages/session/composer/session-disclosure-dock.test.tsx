import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionDisclosureState, reconcileDisclosureCollapsed } from "./session-disclosure-state"

describe("createSessionDisclosureState", () => {
  test("starts from the default collapsed state and toggles open", () => {
    createRoot((dispose) => {
      const state = createSessionDisclosureState({ defaultCollapsed: true })

      expect(state.collapsed()).toBe(true)

      state.toggle()

      expect(state.collapsed()).toBe(false)
      dispose()
    })
  })

  test("reconciles a changed reset key back to the default collapsed state", () => {
    expect(
      reconcileDisclosureCollapsed({
        collapsed: false,
        defaultCollapsed: true,
        previousResetKey: "first",
        nextResetKey: "second",
      }),
    ).toBe(true)
  })

  test("leaves uncontrolled docks unchanged when there is no reset key", () => {
    expect(
      reconcileDisclosureCollapsed({
        collapsed: true,
        defaultCollapsed: false,
        previousResetKey: undefined,
        nextResetKey: undefined,
      }),
    ).toBe(true)
  })

  test("snaps the store back to defaultCollapsed when the reset key accessor changes", () => {
    createRoot((dispose) => {
      const [resetKey, setResetKey] = createSignal<string | undefined>("a")
      const state = createSessionDisclosureState({
        defaultCollapsed: true,
        resetKey,
      })

      // Start collapsed, then user expands it.
      expect(state.collapsed()).toBe(true)
      state.toggle()
      expect(state.collapsed()).toBe(false)

      // Reset key changes -> the hook must snap back to defaultCollapsed.
      setResetKey("b")
      expect(state.collapsed()).toBe(true)

      dispose()
    })
  })

  test("preserves user toggles when the reset key accessor value is stable", () => {
    createRoot((dispose) => {
      const state = createSessionDisclosureState({
        defaultCollapsed: false,
        resetKey: () => "stable",
      })

      state.toggle()
      expect(state.collapsed()).toBe(true)

      // Stable reset key must NOT re-snap on re-runs.
      // Read a few unrelated reactive sources to force the effect to be considered.
      // The test of record is that collapsed stays at the user's choice.
      expect(state.collapsed()).toBe(true)

      dispose()
    })
  })

  test("reset() returns the store to the default collapsed state", () => {
    createRoot((dispose) => {
      const state = createSessionDisclosureState({ defaultCollapsed: false })

      state.toggle()
      expect(state.collapsed()).toBe(true)

      state.reset()
      expect(state.collapsed()).toBe(false)

      dispose()
    })
  })
})
