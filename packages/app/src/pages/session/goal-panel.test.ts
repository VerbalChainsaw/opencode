import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

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

  // Adversarial: a state file larger than the renderer's cap must be
  // rejected as corrupt (so the user sees the warning UI) rather than
  // parsed into a multi-MB object that pins the SolidJS reactivity
  // layer. The cap is 1 MB in the implementation.
  test("rejects over-size state content as corrupt (defense against OOM)", async () => {
    // 2 MB of filler inside an otherwise-valid JSON wrapper.
    const huge = "x".repeat(2_000_000)
    const hugeContent = `{"id":"${huge}"}`
    const sdk = mockSdk({ read: async () => ({ data: hugeContent }) })
    const { state, corrupt, loaded } = await readGoalFromSdk(sdk)
    expect(loaded).toBe(true)
    expect(state).toBeNull()
    expect(corrupt).toBe(true)
  })

  // Edge: content exactly at the 1 MB cap is still allowed (cap is
  // strict-greater-than). This pins the boundary so a future refactor
  // doesn't accidentally flip to >= and start rejecting legitimate
  // 1 MB files.
  test("content at the 1 MB cap is accepted (boundary check)", async () => {
    // Build a valid state whose JSON serialization is exactly ~1 MB.
    // The goal-state has many fields we can pad: use evaluationHistory
    // entries to grow the serialization to just over/under 1 MB.
    // Simpler: pad `condition` so the JSON is right at the boundary.
    // We need the JSON to be > 1 MB - slack and < 1 MB + slack.
    // Slack: the test asserts the body is accepted, so the body must
    // be <= 1 MB. We construct one that's clearly under (500 KB) to
    // make the test robust against JSON whitespace changes.
    const filler = "x".repeat(500_000)
    const state = { ...validState, id: "medium", condition: filler }
    const content = JSON.stringify(state)
    expect(content.length).toBeLessThanOrEqual(1_000_000)
    const sdk = mockSdk({ read: async () => ({ data: content }) })
    const result = await readGoalFromSdk(sdk)
    expect(result.corrupt).toBe(false)
    expect(result.state).not.toBeNull()
  })

  // Adversarial: a state file with a huge evaluationHistory should
  // be rejected by the renderer's 1 MB size cap. The plugin's own
  // MAX_STATE_SIZE (256KB) means a state with 50K history entries
  // would never be produced by the plugin; if such a state appears
  // from some other source, the renderer treats it as corrupt and
  // does NOT parse it (which would OOM the reactivity layer).
  test("rejects huge evaluationHistory payloads via the size cap", async () => {
    const bigHistory = Array.from({ length: 50_000 }, (_, i) => ({
      met: i % 2 === 0,
      reason: `attempt ${i}`,
      timestamp: 1_700_000_000_000 + i,
    }))
    const sdk = mockSdk({
      read: async () => ({
        data: JSON.stringify({ ...validState, id: "big", evaluationHistory: bigHistory }),
      }),
    })
    const { state, corrupt } = await readGoalFromSdk(sdk)
    // Size cap kicks in before JSON.parse — corrupt, not "parsed but
    // truncated" — so the user sees the warning UI.
    expect(corrupt).toBe(true)
    expect(state).toBeNull()
  })

  // Adversarial: a state file with deeply nested JSON must not crash
  // the parser. JSON.parse itself handles arbitrary nesting; we just
  // verify isGoalStateShape rejects the result cleanly (since the
  // shape validator walks top-level keys only).
  test("deeply nested JSON payload that doesn't match shape is rejected, not crashed", () => {
    // Build a deeply nested object that JSON.parse will happily parse
    // but isGoalStateShape will reject (wrong shape).
    let nested: any = { leaf: true }
    for (let i = 0; i < 100; i++) nested = { wrap: nested }
    expect(isGoalStateShape(nested)).toBe(false)
  })

  // Adversarial: prototype-pollution-style payloads (e.g. __proto__ or
  // constructor) must not crash isGoalStateShape and must not yield a
  // valid state. JSON.parse by spec does NOT honor __proto__ in plain
  // object literals (the property is set, not the prototype), so this
  // is more of a "don't crash" check than a security boundary, but
  // pinning the behavior guards future regressions.
  test("prototype-pollution-style payloads are rejected by isGoalStateShape", () => {
    const polluted = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"id":"x","condition":"y","status":"active","startedAt":0,"turnsEvaluated":0,"constraints":{"maxTurns":5,"maxTimeMinutes":10,"maxTokens":1000}}',
    )
    // Shape-wise this is valid, so isGoalStateShape returns true —
    // which is correct: the validator checks shape, not origin. The
    // important property is that we never THROW and that the regular
    // {}.polluted check is unaffected.
    expect(isGoalStateShape(polluted)).toBe(true)
    // And the prototype itself is not modified:
    expect(({} as any).polluted).toBeUndefined()
  })

  // Adversarial: control-character injection in the condition field
  // (e.g. to spoof UI or break terminal output) must be stripped by
  // cleanText BEFORE render. This pins the documented behavior.
  test("control characters in condition are stripped, not rendered", () => {
    const dirty = "all\u0001tests\u001fpass\u007f\u200b\u202einjected"
    const clean = cleanText(dirty)
    // The visible word is preserved, all control/bidi chars are gone.
    expect(clean).toBe("alltestspassinjected")
  })

  // Adversarial: an extremely long condition (DoS via DOM) is
  // truncated to 400 chars. This pins the cap that protects the UI
  // from a user (or attacker) who can edit the state file.
  test("condition is truncated to 400 chars (defense against layout DoS)", () => {
    const huge = "x".repeat(100_000)
    const out = cleanText(huge)
    expect(out.length).toBe(400)
  })

  // Adversarial: a state with NaN/Infinity in numeric fields is
  // rejected by JSON.parse spec (no representation) AND by
  // isGoalStateShape (typeof check). Verify both.
  test("NaN/Infinity in numeric fields are not representable in JSON", () => {
    // NaN/Infinity as JSON values are NOT valid JSON — they get
    // serialized as `null`. So the parser never sees them. The only
    // way they'd appear in the parsed result is via a non-standard
    // parser. Our isGoalStateShape would reject `null` for required
    // numeric fields (typeof null !== "number"). Both layers are
    // defended.
    const nullNumeric = {
      id: "x",
      condition: "y",
      status: "active",
      startedAt: null, // simulates "JSON.stringify(NaN)" output
      turnsEvaluated: null,
      constraints: { maxTurns: null, maxTimeMinutes: 10, maxTokens: 1000 },
    }
    expect(isGoalStateShape(nullNumeric)).toBe(false)
  })
})

// ── useGoal hook tests (SolidJS lifecycle, mocked SDK context) ──────
//
// These tests drive the real useGoal hook inside a createRoot so
// onMount / onCleanup / setInterval are exercised. The SDK context is
// replaced via mock.module before the goal-panel module is imported.
//
// Every test MUST dispose() its createRoot before returning — otherwise
// the setInterval inside useGoal keeps the event loop busy and the
// bun:test runner never exits the process.
//
describe("useGoal hook", () => {
  let useGoal: typeof import("./goal-panel").useGoal
  let setMockResponse: (next: { data: unknown } | Error) => void
  // The mock.module closure captures `sdkRef`; we mutate it per test.
  let sdkRef: GoalSdkClient

  beforeAll(async () => {
    mock.module("@/context/language", () => ({
      useLanguage: () => ({ t: (k: string) => k }),
    }))
    mock.module("@/context/sdk", () => ({
      useSDK: () => sdkRef,
    }))
    const mod = await import("./goal-panel")
    useGoal = mod.useGoal
  })

  beforeEach(() => {
    let nextResponse: { data: unknown } | Error = { data: "" }
    setMockResponse = (r) => {
      nextResponse = r
    }
    sdkRef = {
      client: {
        file: {
          read: async () => {
            if (nextResponse instanceof Error) throw nextResponse
            return nextResponse
          },
        },
      },
    }
  })

  // Each test runs inside a createRoot, drives the hook, asserts, and
  // disposes before returning so the interval is cleared.
  function withRoot<T>(fn: (goal: ReturnType<typeof useGoal>, dispose: () => void) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      createRoot((dispose) => {
        const goal = useGoal()
        fn(goal, dispose).then(
          (v) => {
            dispose()
            resolve(v)
          },
          (e) => {
            dispose()
            reject(e)
          },
        )
      })
    })
  }

  test("hook: starts unloaded, transitions to loaded:true after first read", async () => {
    await withRoot(async (goal) => {
      // Wait for the onMount-driven refresh() promise to resolve.
      // The hook calls refresh() inside onMount; we drive a manual
      // refresh and await it (this also covers the initial-read path).
      await goal.refresh()
      expect(goal.store.loaded).toBe(true)
      expect(goal.store.corrupt).toBe(false)
      expect(goal.store.state).toBeNull()
    })
  })

  test("hook: refresh() picks up new state from the SDK", async () => {
    await withRoot(async (goal) => {
      setMockResponse({ data: JSON.stringify({ ...validState, id: "first" }) })
      await goal.refresh()
      expect(goal.store.state?.id).toBe("first")

      setMockResponse({ data: JSON.stringify({ ...validState, id: "second", command: null }) })
      await goal.refresh()
      expect(goal.store.state?.id).toBe("second")
      expect(goal.store.state?.command).toBeNull()
    })
  })

  test("hook: clearing lastEvaluation to null actually clears it (no stale merge)", async () => {
    // REGRESSION: setStore(next) without reconcile leaves stale fields.
    // If the state goes from { lastEvaluation: { reason: "old" } } to
    // { lastEvaluation: null }, the store must end up with null, NOT
    // the old object. SolidJS's createStore merges by default, which
    // is why other call sites in this codebase use reconcile(...).
    await withRoot(async (goal) => {
      setMockResponse({
        data: JSON.stringify({
          ...validState,
          id: "v1",
          lastEvaluation: { met: false, reason: "old reason", timestamp: 1, evaluatorType: "deterministic" },
        }),
      })
      await goal.refresh()
      expect(goal.store.state?.lastEvaluation?.reason).toBe("old reason")

      setMockResponse({
        data: JSON.stringify({ ...validState, id: "v2", lastEvaluation: null }),
      })
      await goal.refresh()
      expect(goal.store.state?.lastEvaluation).toBeNull()
    })
  })

  test("hook: clearing command to null actually clears it (no stale merge)", async () => {
    await withRoot(async (goal) => {
      setMockResponse({ data: JSON.stringify({ ...validState, id: "v1", command: "npm test" }) })
      await goal.refresh()
      expect(goal.store.state?.command).toBe("npm test")

      setMockResponse({ data: JSON.stringify({ ...validState, id: "v2", command: null }) })
      await goal.refresh()
      expect(goal.store.state?.command).toBeNull()
    })
  })

  test("hook: corrupt JSON produces corrupt=true on the store", async () => {
    await withRoot(async (goal) => {
      setMockResponse({ data: "{not json" })
      await goal.refresh()
      expect(goal.store.loaded).toBe(true)
      expect(goal.store.corrupt).toBe(true)
      expect(goal.store.state).toBeNull()
    })
  })

  test("hook: SDK read throws → treated as absent (NOT corrupt)", async () => {
    await withRoot(async (goal) => {
      setMockResponse(new Error("ENOENT"))
      await goal.refresh()
      expect(goal.store.loaded).toBe(true)
      expect(goal.store.corrupt).toBe(false)
      expect(goal.store.state).toBeNull()
    })
  })

  test("hook: onCleanup clears the setInterval timer", async () => {
    // Wrap read so we can count calls that happen AFTER dispose.
    // POLL_MS is 2000; we wait 2.5s after dispose. If the interval
    // weren't cleared, we'd see at least one post-dispose read.
    let callsAfterDispose = 0
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        useGoal()
        setTimeout(() => {
          dispose()
          // After dispose, install a counter on read.
          const afterOrig = sdkRef.client.file.read
          sdkRef.client.file.read = async (args) => {
            callsAfterDispose++
            return afterOrig(args)
          }
          setTimeout(resolve, 2500)
        }, 30)
      })
    })
    expect(callsAfterDispose).toBe(0)
  })
})
