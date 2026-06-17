/**
 * Per audit AUDIT-DEFECTS.md MED-25: the fallback path in id.ts
 * (when crypto.getRandomValues is unavailable) must surface a
 * warning so production telemetry can detect low-entropy ID
 * generation. These tests pin both the warning behavior and the
 * happy-path identity semantics.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Identifier } from "./id"

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")
const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random")

const setCrypto = (value: Partial<Crypto> | undefined) => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: value as Crypto | undefined,
  })
}

const setRandom = (value: () => number) => {
  Object.defineProperty(Math, "random", {
    configurable: true,
    value,
  })
}

afterEach(() => {
  if (cryptoDescriptor) {
    Object.defineProperty(globalThis, "crypto", cryptoDescriptor)
  } else {
    delete (globalThis as { crypto?: Crypto }).crypto
  }
  if (randomDescriptor) {
    Object.defineProperty(Math, "random", randomDescriptor)
  }
})

describe("Identifier (id.ts)", () => {
  // Per audit MED-25: warn on the Math.random() fallback so production
  // telemetry can detect low-entropy IDs.
  let warnSpy: ReturnType<typeof mock>
  beforeEach(() => {
    warnSpy = mock(() => {})
    ;(globalThis as unknown as { console: Console }).console = new Proxy(
      console,
      {
        get(target, prop) {
          if (prop === "warn") return warnSpy
          return Reflect.get(target, prop)
        },
      },
    ) as Console
  })
  afterEach(() => {
    ;(globalThis as unknown as { console: Console }).console = console
  })

  test("ascending uses a 3-char prefix and a 26-char body", () => {
    setCrypto(undefined)
    setRandom(() => 0.5)
    const id = Identifier.ascending("session")
    expect(id.startsWith("ses_")).toBe(true)
    // ses_ (4) + 12 hex (timestamp) + 14 base62 (random) = 30
    expect(id.length).toBe(30)
  })

  test("passing a given id that starts with the wrong prefix throws", () => {
    expect(() => Identifier.ascending("session", "msg_abc")).toThrow(
      /does not start with ses/,
    )
  })

  test("passing a given id with the right prefix returns it unchanged", () => {
    const given = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaa"
    expect(Identifier.ascending("user", given)).toBe(given)
  })

  test("warns when getRandomValues is unavailable (fallback to Math.random)", () => {
    setCrypto({}) // crypto exists but getRandomValues is missing
    setRandom(() => 0.5)
    Identifier.ascending("session")
    expect(warnSpy).toHaveBeenCalled()
    const message = (warnSpy.mock.calls[0]?.[0] as string) ?? ""
    expect(message).toContain("getRandomValues unavailable")
  })

  test("warns when crypto itself is unavailable", () => {
    setCrypto(undefined)
    setRandom(() => 0.5)
    Identifier.ascending("session")
    expect(warnSpy).toHaveBeenCalled()
  })

  test("does not warn when crypto.getRandomValues is available", () => {
    setCrypto({
      getRandomValues: <T extends ArrayBufferView>(arr: T) => {
        // Fill with deterministic-but-distinct bytes so different IDs
        // come out.
        const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
        for (let i = 0; i < view.length; i += 1) view[i] = i & 0xff
        return arr
      },
    })
    Identifier.ascending("session")
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
