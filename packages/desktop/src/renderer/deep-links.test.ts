import { describe, expect, test } from "bun:test"
import { DEEP_LINK_EVENT, emitDesktopDeepLinks, listenForDesktopDeepLinks } from "./deep-links"

function target() {
  const events: string[][] = []
  const dispatcher = new EventTarget() as EventTarget & { __OPENCODE__?: { deepLinks?: string[] } }
  dispatcher.addEventListener(DEEP_LINK_EVENT, (event) => {
    events.push((event as CustomEvent<{ urls: string[] }>).detail.urls)
  })
  return { dispatcher, events }
}

describe("desktop renderer deep links", () => {
  test("queues links on the OpenCode window bridge and emits an event", () => {
    const { dispatcher, events } = target()

    emitDesktopDeepLinks(dispatcher, ["opencode://first"])
    emitDesktopDeepLinks(dispatcher, ["opencode://second", "opencode://third"])

    expect(dispatcher.__OPENCODE__?.deepLinks).toEqual([
      "opencode://first",
      "opencode://second",
      "opencode://third",
    ])
    expect(events).toEqual([["opencode://first"], ["opencode://second", "opencode://third"]])
  })

  test("ignores empty batches without creating bridge state", () => {
    const { dispatcher, events } = target()

    emitDesktopDeepLinks(dispatcher, [])

    expect(dispatcher.__OPENCODE__).toBeUndefined()
    expect(events).toEqual([])
  })

  test("connects initial and live Electron preload deep-link sources", async () => {
    const { dispatcher, events } = target()
    let live: ((urls: string[]) => void) | undefined
    let disposed = false

    const dispose = listenForDesktopDeepLinks(
      {
        consumeInitialDeepLinks: async () => ["opencode://initial"],
        onDeepLink: (callback) => {
          live = callback
          return () => {
            disposed = true
          }
        },
      },
      dispatcher,
    )

    await Promise.resolve()
    live?.(["opencode://live"])
    dispose()

    expect(dispatcher.__OPENCODE__?.deepLinks).toEqual(["opencode://initial", "opencode://live"])
    expect(events).toEqual([["opencode://initial"], ["opencode://live"]])
    expect(disposed).toBe(true)
  })
})
