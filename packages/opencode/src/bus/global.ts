import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  // @ts-expect-error - the base EventEmitter.emit signature is a complex
  // generic that constrains the args by eventName, so a narrow override
  // typed for a single literal eventName fails TS variance checks under
  // TypeScript 5+. The override is correct: every internal caller passes
  // the literal "event" with a single GlobalEvent argument (see
  // packages/opencode/src/{control-plane,event-v2-bridge,cli/upgrade,
  // worktree}/*), and the base call `super.emit("event", event)` matches
  // the parent's "event" branch. If a future caller passes a different
  // eventName, runtime falls through to EventEmitter's default behavior.
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()
