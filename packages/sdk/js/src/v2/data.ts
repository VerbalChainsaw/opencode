import type { Part, UserMessage } from "./client.js"

// Placeholder IDs the SDK will replace at call time. They used to
// be hardcoded "asdasd" (per audit AUDIT-DEFECTS.md MED-36) which
// silently produced runtime ID collisions when consumers ran multiple
// messages back-to-back. crypto.randomUUID is the right replacement.
const PLACEHOLDER_ID = crypto.randomUUID()
const PLACEHOLDER_PART_ID = crypto.randomUUID()

export const message = {
  user(input: Omit<UserMessage, "role" | "time" | "id"> & { parts: Omit<Part, "id" | "sessionID" | "messageID">[] }): {
    info: UserMessage
    parts: Part[]
  } {
    const { parts: _parts, ...rest } = input
    const info: UserMessage = {
      ...rest,
      id: PLACEHOLDER_ID,
      time: {
        created: Date.now(),
      },
      role: "user",
    }
    return {
      info,
      parts: input.parts.map(
        (part) =>
          ({
            ...part,
            id: PLACEHOLDER_PART_ID,
            messageID: info.id,
            sessionID: info.sessionID,
          }) as Part,
      ),
    }
  },
}
