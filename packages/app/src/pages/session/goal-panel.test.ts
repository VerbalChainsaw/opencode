import { describe, expect, test } from "bun:test"

import {
  type GoalSdkClient,
  type GoalState,
  cleanText,
  isGoalStateShape,
  readGoalFromSdk,
} from "./goal-panel"

const validState: GoalState = {
  id: "test-id",
  condition: "All unit tests pass",
  command: "npm test",
  status: "active",
  startedAt: 1_700_000_000_000,
  completedAt: null,
  turnsEvaluated: 3,
  tokensUsed: 1200,
  lastEvaluation: {
    met: false,
    reason: "2 tests still failing",
    timestamp: 1_700_000_005_000,
    evaluatorType: "deterministic",
  },
  evaluationHistory: [
    { met: false, reason: "first try", timestamp: 1_700_000_001_000 },
    { met: false, reason: "second try", timestamp: 1_700_000_003_000 },
  ],
  constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100_000 },
}

function mockSdk(overrides: Partial<GoalSdkClient["client"]["file"]> = {}): GoalSdkClient {
  return {
    client: {
      file: {
        read: overrides.read ?? (async () => ({ data: "" })),
        ...overrides,
      },
    },
  }
}

describe("isGoalStateShape", () => {
  test("accepts a fully-shaped valid state", () => {
    expect(isGoalStateShape(validState)).toBe(true)
  })

  test("accepts a minimal state (only the required keys)", () => {
    expect(
      isGoalStateShape({
        id: "x",
        condition: "y",
        status: "active",
        startedAt: 0,
        turnsEvaluated: 0,
        constraints: { maxTurns: 5, maxTimeMinutes: 10, maxTokens: 1000 },
      }),
    ).toBe(true)
  })

  test("rejects null and primitives", () => {
    expect(isGoalStateShape(null)).toBe(false)
    expect(isGoalStateShape(undefined)).toBe(false)
    expect(isGoalStateShape(42)).toBe(false)
    expect(isGoalStateShape("active")).toBe(false)
    expect(isGoalStateShape(true)).toBe(false)
  })

  test("rejects when id or condition are not strings", () => {
    expect(isGoalStateShape({ ...validState, id: 7 })).toBe(false)
    expect(isGoalStateShape({ ...validState, condition: undefined })).toBe(false)
  })

  test("rejects unknown status values (closed enum)", () => {
    expect(isGoalStateShape({ ...validState, status: "pending" })).toBe(false)
    expect(isGoalStateShape({ ...validState, status: "ACTIVE" })).toBe(false)
    expect(isGoalStateShape({ ...validState, status: "" })).toBe(false)
  })

  test("accepts each of the four documented statuses", () => {
    for (const status of ["active", "paused", "achieved", "cleared"] as const) {
      expect(isGoalStateShape({ ...validState, status })).toBe(true)
    }
  })

  test("rejects when turnsEvaluated or startedAt are not numbers", () => {
    expect(isGoalStateShape({ ...validState, turnsEvaluated: "3" })).toBe(false)
    expect(isGoalStateShape({ ...validState, startedAt: null })).toBe(false)
  })

  test("rejects when constraints is missing or incomplete", () => {
    const noConstraints = { ...validState }
    delete (noConstraints as Partial<GoalState>).constraints
    expect(isGoalStateShape(noConstraints)).toBe(false)

    const partialConstraints = {
      ...validState,
      constraints: { maxTurns: 5, maxTimeMinutes: 10 },
    }
    expect(isGoalStateShape(partialConstraints)).toBe(false)
  })
})

describe("cleanText", () => {
  test("passes plain ASCII through unchanged", () => {
    expect(cleanText("hello world")).toBe("hello world")
  })

  test("strips C0 control characters", () => {
    // 0x01 SOH and 0x1f US embedded in otherwise-ok text
    expect(cleanText("a\u0001b\u001fc")).toBe("abc")
  })

  test("strips DEL and C1 control characters", () => {
    expect(cleanText("a\u007fb\u009fc")).toBe("abc")
  })

  test("strips zero-width and bidi-format characters", () => {
    // U+200B zero-width space, U+202E right-to-left override, U+2066 LRI
    expect(cleanText("a\u200bb\u202Ec\u2066d\u2069e")).toBe("abcde")
  })

  test("truncates to 400 characters", () => {
    const long = "x".repeat(1000)
    expect(cleanText(long)).toHaveLength(400)
  })

  test("preserves Unicode letters and emoji", () => {
    expect(cleanText("café 🎯 résumé")).toBe("café 🎯 résumé")
  })
})

describe("readGoalFromSdk", () => {
  test("returns absent store when SDK read throws (file missing)", async () => {
    const sdk = mockSdk({
      read: async () => {
        throw new Error("ENOENT")
      },
    })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })

  test("returns absent store when content is empty string", async () => {
    const sdk = mockSdk({ read: async () => ({ data: "" }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })

  test("returns absent store when content is whitespace-only", async () => {
    const sdk = mockSdk({ read: async () => ({ data: "   \n  " }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })

  test("accepts plain-string content", async () => {
    const sdk = mockSdk({ read: async () => ({ data: JSON.stringify(validState) }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: validState,
      corrupt: false,
      loaded: true,
    })
  })

  test("accepts { type, content } SDK FileContent shape", async () => {
    const sdk = mockSdk({ read: async () => ({ data: { type: "text", content: JSON.stringify(validState) } }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: validState,
      corrupt: false,
      loaded: true,
    })
  })

  test("marks content as corrupt when JSON is malformed", async () => {
    const sdk = mockSdk({ read: async () => ({ data: "{not json" }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: true,
      loaded: true,
    })
  })

  test("marks content as corrupt when JSON parses but shape is wrong", async () => {
    const sdk = mockSdk({ read: async () => ({ data: JSON.stringify({ id: "x" }) }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: true,
      loaded: true,
    })
  })

  test("treats null data as absent, not corrupt", async () => {
    const sdk = mockSdk({ read: async () => ({ data: null }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })

  test("treats unexpected data shapes (e.g. number) as absent, not corrupt", async () => {
    const sdk = mockSdk({ read: async () => ({ data: 42 }) })
    await expect(readGoalFromSdk(sdk)).resolves.toEqual({
      state: null,
      corrupt: false,
      loaded: true,
    })
  })
})
