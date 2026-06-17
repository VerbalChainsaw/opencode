import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { uuid } from "./uuid"

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")
const secureDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext")
const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random")

const setCrypto = (value: Partial<Crypto>) => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: value as Crypto,
  })
}

const setSecure = (value: boolean) => {
  Object.defineProperty(globalThis, "isSecureContext", {
    configurable: true,
    value,
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
  }

  if (secureDescriptor) {
    Object.defineProperty(globalThis, "isSecureContext", secureDescriptor)
  }

  if (!secureDescriptor) {
    delete (globalThis as { isSecureContext?: boolean }).isSecureContext
  }

  if (randomDescriptor) {
    Object.defineProperty(Math, "random", randomDescriptor)
  }
})

describe("uuid", () => {
  // Per audit AUDIT-DEFECTS.md MED-25: the fallback path must surface
  // a warning so production telemetry can detect low-entropy ID
  // generation. Capture and restore console.warn around the suite.
  let warnSpy: ReturnType<typeof mock>
  beforeEach(() => {
    warnSpy = mock(() => {})
    // Replace the global console.warn so we can observe without
    // spamming test output. The implementation calls console.warn
    // via the global; assigning to the property here intercepts.
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

  test("uses randomUUID in secure contexts", () => {
    setCrypto({ randomUUID: () => "00000000-0000-0000-0000-000000000000" })
    setSecure(true)
    expect(uuid()).toBe("00000000-0000-0000-0000-000000000000")
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("falls back in insecure contexts", () => {
    setCrypto({ randomUUID: () => "00000000-0000-0000-0000-000000000000" })
    setSecure(false)
    setRandom(() => 0.5)
    expect(uuid()).toBe("8")
    expect(warnSpy).toHaveBeenCalled()
  })

  test("falls back when randomUUID throws", () => {
    setCrypto({
      randomUUID: () => {
        throw new DOMException("Failed", "OperationError")
      },
    })
    setSecure(true)
    setRandom(() => 0.5)
    expect(uuid()).toBe("8")
    expect(warnSpy).toHaveBeenCalled()
  })

  test("falls back when randomUUID is unavailable", () => {
    setCrypto({})
    setSecure(true)
    setRandom(() => 0.5)
    expect(uuid()).toBe("8")
    expect(warnSpy).toHaveBeenCalled()
  })
})
