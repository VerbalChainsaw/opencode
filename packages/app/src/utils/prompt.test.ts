import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import type { Prompt } from "@/context/prompt"
import { extractPromptFromParts, insertTextIntoPrompt } from "./prompt"

describe("extractPromptFromParts", () => {
  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      { type: "image", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      { type: "image", filename: "b.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBB" },
    ])
  })
})

describe("insertTextIntoPrompt", () => {
  test("inserts text into an empty prompt", () => {
    const result = insertTextIntoPrompt([{ type: "text", content: "", start: 0, end: 0 }], "a", 0)

    expect(result.cursor).toBe(1)
    expect(result.prompt).toEqual([{ type: "text", content: "a", start: 0, end: 1 }])
  })

  test("inserts text inside a text part and updates ranges", () => {
    const prompt: Prompt = [{ type: "text", content: "ac", start: 0, end: 2 }]

    const result = insertTextIntoPrompt(prompt, "b", 1)

    expect(result.cursor).toBe(2)
    expect(result.prompt).toEqual([{ type: "text", content: "abc", start: 0, end: 3 }])
  })

  test("inserts text after inline file parts without flattening them", () => {
    const prompt: Prompt = [
      { type: "text", content: "run ", start: 0, end: 4 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 4, end: 15 },
      { type: "text", content: " now", start: 15, end: 19 },
    ]

    const result = insertTextIntoPrompt(prompt, "!", 10)

    expect(result.cursor).toBe(11)
    expect(result.prompt).toEqual([
      { type: "text", content: "run ", start: 0, end: 4 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 4, end: 15 },
      { type: "text", content: "! now", start: 15, end: 20 },
    ])
  })

  test("preserves image attachments at the end of the prompt", () => {
    const prompt: Prompt = [
      { type: "text", content: "look", start: 0, end: 4 },
      { type: "image", id: "img-1", filename: "shot.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ]

    const result = insertTextIntoPrompt(prompt, "!", 4)

    expect(result.prompt).toEqual([
      { type: "text", content: "look!", start: 0, end: 5 },
      { type: "image", id: "img-1", filename: "shot.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ])
  })

  test("inserts text at the exact start of a non-text part", () => {
    const prompt: Prompt = [
      { type: "text", content: "run ", start: 0, end: 4 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 4, end: 15 },
      { type: "text", content: " now", start: 15, end: 19 },
    ]

    const result = insertTextIntoPrompt(prompt, "!", 4)

    expect(result.cursor).toBe(5)
    expect(result.prompt).toEqual([
      { type: "text", content: "run !", start: 0, end: 5 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 5, end: 16 },
      { type: "text", content: " now", start: 16, end: 20 },
    ])
  })

  test("clamps cursor past the end of inline content", () => {
    const prompt: Prompt = [{ type: "text", content: "ab", start: 0, end: 2 }]

    const result = insertTextIntoPrompt(prompt, "X", 99)

    expect(result.cursor).toBe(3)
    expect(result.prompt).toEqual([{ type: "text", content: "abX", start: 0, end: 3 }])
  })

  test("inserts into a prompt that contains an agent mention", () => {
    const prompt: Prompt = [
      { type: "text", content: "hey ", start: 0, end: 4 },
      { type: "agent", name: "build", content: "@build", start: 4, end: 10 },
    ]

    // cursor inside the agent mention — insertion should land AFTER the agent
    const result = insertTextIntoPrompt(prompt, "!", 7)

    expect(result.cursor).toBe(8)
    expect(result.prompt).toEqual([
      { type: "text", content: "hey ", start: 0, end: 4 },
      { type: "agent", name: "build", content: "@build", start: 4, end: 10 },
      { type: "text", content: "!", start: 10, end: 11 },
    ])
  })
})
