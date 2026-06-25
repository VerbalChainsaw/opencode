/**
 * Regression test for CENTER-AUDIT perspective-4-cross-process-2026-06-24,
 * defect C0 (MEDIUM impact, MEDIUM confidence):
 *
 *   "Every method in the AsyncStorage factory catches the IPC rejection
 *    silently. A failed write (disk full, EACCES, electron-store
 *    atomic-rename failure, corrupt store) is indistinguishable from
 *    a successful write."
 *
 * Invariant: read failures resolve to null (the missing-key shape);
 * write failures REJECT the promise so the caller can surface the error.
 *
 * The pre-fix implementation wrapped every method in `.catch(() => null)`
 * or `.catch(() => {})`, which silently dropped write failures. The
 * post-fix implementation propagates write rejections while keeping the
 * read-on-failure-returns-null contract.
 */

import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"

import {
  type DesktopStoreBridge,
  createDesktopStorage,
  createStorageFactory,
} from "./storage"

/**
 * Build a stub bridge with controllable per-method behavior.
 * Each method's `pending` array receives the (name, key?, value?) tuples
 * it was called with, and returns whatever its corresponding action
 * (`get`, `set`, ...) says — a value, an Error, or a Promise of either.
 */
function makeBridge(actions: {
  get?: (key: string) => unknown
  set?: (key: string, value: string) => unknown
  delete?: (key: string) => unknown
  clear?: () => unknown
  keys?: () => unknown
  length?: () => unknown
} = {}): DesktopStoreBridge & { pending: Array<{ method: string; args: unknown[] }> } {
  const pending: Array<{ method: string; args: unknown[] }> = []
  return {
    pending,
    storeGet: ((name: string, key: string) => {
      pending.push({ method: "storeGet", args: [name, key] })
      return actions.get?.(key)
    }) as DesktopStoreBridge["storeGet"],
    storeSet: ((name: string, key: string, value: string) => {
      pending.push({ method: "storeSet", args: [name, key, value] })
      return actions.set?.(key, value)
    }) as DesktopStoreBridge["storeSet"],
    storeDelete: ((name: string, key: string) => {
      pending.push({ method: "storeDelete", args: [name, key] })
      return actions.delete?.(key)
    }) as DesktopStoreBridge["storeDelete"],
    storeClear: ((name: string) => {
      pending.push({ method: "storeClear", args: [name] })
      return actions.clear?.()
    }) as DesktopStoreBridge["storeClear"],
    storeKeys: ((name: string) => {
      pending.push({ method: "storeKeys", args: [name] })
      return actions.keys?.()
    }) as DesktopStoreBridge["storeKeys"],
    storeLength: ((name: string) => {
      pending.push({ method: "storeLength", args: [name] })
      return actions.length?.()
    }) as DesktopStoreBridge["storeLength"],
  }
}

// ── Read path ──────────────────────────────────────────────────────────

describe("createDesktopStorage — read path", () => {
  test("getItem returns the value when the bridge resolves", async () => {
    const bridge = makeBridge({ get: (k) => (k === "prompt" ? "hello" : null) })
    const storage = createDesktopStorage(bridge, "draft.dat")
    expect(await storage.getItem("prompt")).toBe("hello")
    expect(await storage.getItem("missing")).toBeNull()
  })

  test("getItem resolves to null when the bridge rejects (IPC failure)", async () => {
    const bridge = makeBridge({
      get: () => Promise.reject(new Error("EACCES: permission denied")),
    })
    const storage = createDesktopStorage(bridge, "draft.dat")
    // The audit invariant: a read failure has the same observable shape
    // as a missing key. We cannot return "I tried and failed" because
    // the AsyncStorage contract only allows string | null.
    expect(await storage.getItem("anything")).toBeNull()
  })

  test("getItem resolves to null when the bridge rejects synchronously (allowlist throw)", async () => {
    const bridge = makeBridge({
      get: () => {
        throw new Error(`Store "draft.x" is not accessible from the renderer.`)
      },
    })
    const storage = createDesktopStorage(bridge, "draft.dat")
    expect(await storage.getItem("anything")).toBeNull()
  })
})

// ── Write path — the regression ────────────────────────────────────────

describe("createDesktopStorage — write path (regression)", () => {
  test("setItem propagates the rejection when the bridge rejects (IPC failure)", async () => {
    const bridge = makeBridge({
      set: () => Promise.reject(new Error("EACCES: permission denied")),
    })
    const storage = createDesktopStorage(bridge, "draft.dat")
    // The audit invariant: a write failure MUST reject. The pre-fix
    // implementation silently swallowed this and resolved to undefined,
    // which made a failed settings/draft write indistinguishable from
    // a successful one. The post-fix behavior is the failing-before
    // anchor: if this test passes silently, the silent-drop bug is back.
    await expect(storage.setItem("prompt", "draft text")).rejects.toThrow(
      /EACCES/,
    )
  })

  test("setItem propagates the rejection when the bridge throws synchronously (allowlist throw)", async () => {
    const bridge = makeBridge({
      set: () => {
        throw new Error(`Store "draft.x" is not accessible from the renderer.`)
      },
    })
    const storage = createDesktopStorage(bridge, "draft.dat")
    await expect(storage.setItem("prompt", "draft text")).rejects.toThrow(
      /not accessible from the renderer/,
    )
  })

  test("removeItem propagates the rejection when the bridge rejects", async () => {
    const bridge = makeBridge({
      delete: () => Promise.reject(new Error("ENOENT: no such file")),
    })
    const storage = createDesktopStorage(bridge, "draft.dat")
    await expect(storage.removeItem("prompt")).rejects.toThrow(/ENOENT/)
  })

  test("clear propagates the rejection when the bridge rejects", async () => {
    const bridge = makeBridge({
      clear: () => Promise.reject(new Error("EROFS: read-only filesystem")),
    })
    const storage = createDesktopStorage(bridge, "draft.dat")
    await expect(storage.clear()).rejects.toThrow(/EROFS/)
  })

  test("setItem resolves when the bridge resolves (no regression on the happy path)", async () => {
    const bridge = makeBridge({ set: () => Promise.resolve("ok") })
    const storage = createDesktopStorage(bridge, "draft.dat")
    // The fix must not break the working path. A successful setItem
    // should resolve, not reject.
    await expect(storage.setItem("prompt", "draft text")).resolves.toBeDefined()
  })
})

// ── Length / keys helpers — error tolerance preserved ────────────────

describe("createDesktopStorage — length/keys helpers", () => {
  test("getLength returns 0 when the bridge rejects", async () => {
    const bridge = makeBridge({
      length: () => Promise.reject(new Error("IPC failure")),
    })
    const storage = createDesktopStorage(bridge, "draft.dat")
    expect(await storage.getLength()).toBe(0)
  })

  test("key() returns undefined when the bridge rejects (no crash)", async () => {
    const bridge = makeBridge({
      keys: () => Promise.reject(new Error("IPC failure")),
    })
    const storage = createDesktopStorage(bridge, "draft.dat") as AsyncStorage & {
      key: (i: number) => Promise<string | undefined>
    }
    expect(await storage.key(0)).toBeUndefined()
  })
})

// ── Factory cache ─────────────────────────────────────────────────────

describe("createStorageFactory", () => {
  test("returns the same adapter instance for the same name (caching)", () => {
    const bridge = makeBridge()
    const factory = createStorageFactory(bridge)
    expect(factory("draft.dat")).toBe(factory("draft.dat"))
  })

  test("returns a fresh adapter for a different name", () => {
    const bridge = makeBridge()
    const factory = createStorageFactory(bridge)
    expect(factory("draft.dat")).not.toBe(factory("settings.dat"))
  })

  test("the cached adapter is wired to the same bridge (write goes through)", async () => {
    const bridge = makeBridge({ set: () => Promise.resolve("ok") })
    const factory = createStorageFactory(bridge)
    const a = factory("draft.dat")
    const b = factory("draft.dat")
    await a.setItem("k", "v")
    expect(bridge.pending).toEqual([{ method: "storeSet", args: ["draft.dat", "k", "v"] }])
    // The second adapter instance is the same as the first (cached).
    expect(a).toBe(b)
  })
})
