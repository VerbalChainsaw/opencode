import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
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
})
