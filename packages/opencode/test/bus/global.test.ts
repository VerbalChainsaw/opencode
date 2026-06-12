import { describe, expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

/**
 * Behavior parity tests for the @ts-expect-error on GlobalBusEmitter.emit.
 *
 * The F-5 commit (and the unblock for the F-5 commit's pre-push hook)
 * added `// @ts-expect-error` on the emit override to silence a TS5
 * variance error that surfaced because TypeScript 5+ can no longer
 * reconcile the narrow override signature with the base EventEmitter's
 * complex generic emit. The behavior of the override is unchanged; we
 * pin the runtime contract here so a future refactor doesn't silently
 * break the id-injection behavior or the syncEvent passthrough.
 *
 * These tests deliberately exercise the public surface only — they
 * import GlobalBus and call emit/on — so they are robust against
 * internal renames.
 */
describe("GlobalBus.emit behavior parity", () => {
  test("emits a 'event' with a payload object and the listener receives it", () => {
    const received: GlobalEvent[] = []
    const handler = (e: GlobalEvent) => received.push(e)
    GlobalBus.on("event", handler)
    try {
      const event: GlobalEvent = {
        directory: "/repo",
        payload: { type: "test", properties: { ok: true } },
      }
      const ok = GlobalBus.emit("event", event)
      expect(ok).toBe(true)
      expect(received).toHaveLength(1)
      expect(received[0].directory).toBe("/repo")
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  test("injects a generated id when payload is an object missing 'id'", () => {
    const received: GlobalEvent[] = []
    const handler = (e: GlobalEvent) => received.push(e)
    GlobalBus.on("event", handler)
    try {
      const event: GlobalEvent = { payload: { type: "test", properties: {} } }
      GlobalBus.emit("event", event)
      expect(received).toHaveLength(1)
      const payload = received[0].payload as { id?: string; type: string }
      expect(typeof payload.id).toBe("string")
      // Generated ids are non-empty and look like an event id.
      expect(payload.id!.length).toBeGreaterThan(0)
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  test("does NOT overwrite an explicit id on the payload", () => {
    const received: GlobalEvent[] = []
    const handler = (e: GlobalEvent) => received.push(e)
    GlobalBus.on("event", handler)
    try {
      const event: GlobalEvent = { payload: { type: "test", properties: {}, id: "explicit-id" } }
      GlobalBus.emit("event", event)
      const payload = received[0].payload as { id: string }
      expect(payload.id).toBe("explicit-id")
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  test("uses syncEvent.id when present and payload.id is absent", () => {
    const received: GlobalEvent[] = []
    const handler = (e: GlobalEvent) => received.push(e)
    GlobalBus.on("event", handler)
    try {
      const event: GlobalEvent = {
        payload: {
          type: "test",
          properties: {},
          syncEvent: { id: "from-sync" },
        },
      }
      GlobalBus.emit("event", event)
      const payload = received[0].payload as { id: string; syncEvent: { id: string } }
      expect(payload.id).toBe("from-sync")
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  test("prefers explicit payload.id over syncEvent.id", () => {
    const received: GlobalEvent[] = []
    const handler = (e: GlobalEvent) => received.push(e)
    GlobalBus.on("event", handler)
    try {
      const event: GlobalEvent = {
        payload: {
          type: "test",
          properties: {},
          id: "explicit",
          syncEvent: { id: "from-sync" },
        },
      }
      GlobalBus.emit("event", event)
      const payload = received[0].payload as { id: string }
      expect(payload.id).toBe("explicit")
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  test("does not crash when payload is null (degenerate but possible)", () => {
    const received: GlobalEvent[] = []
    const handler = (e: GlobalEvent) => received.push(e)
    GlobalBus.on("event", handler)
    try {
      // Cast to bypass the GlobalEvent.pull; we want to verify the
      // override's typeof guard is robust against odd payloads.
      const event = { payload: null } as unknown as GlobalEvent
      // Must not throw.
      GlobalBus.emit("event", event)
      expect(received).toHaveLength(1)
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  test("does not crash when payload is a primitive (e.g. number)", () => {
    const received: GlobalEvent[] = []
    const handler = (e: GlobalEvent) => received.push(e)
    GlobalBus.on("event", handler)
    try {
      const event = { payload: 42 } as unknown as GlobalEvent
      // Must not throw — the override's `typeof === "object"` guard
      // skips id-injection for non-objects.
      GlobalBus.emit("event", event)
      expect(received).toHaveLength(1)
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  test("emit returns false when there are no listeners (standard EventEmitter behavior)", () => {
    // We exercise the runtime path by casting to the base type. The
    // narrow override signature intentionally only allows "event" at
    // compile time — we want to verify the BASE EventEmitter.emit
    // still returns false when there are no listeners, in case a
    // future refactor changes the override.
    const bus = GlobalBus as unknown as {
      on: (name: string, fn: (...args: unknown[]) => void) => void
      off: (name: string, fn: (...args: unknown[]) => void) => void
      emit: (name: string, ...args: unknown[]) => boolean
    }
    const handler = () => {}
    bus.on("__test_unique_event__", handler)
    try {
      expect(bus.emit("__test_unique_event__", { payload: null })).toBe(true)
    } finally {
      bus.off("__test_unique_event__", handler)
    }
    expect(bus.emit("__test_unique_event__", { payload: null })).toBe(false)
  })
})
