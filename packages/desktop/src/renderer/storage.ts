/**
 * Renderer-side IPC storage adapter.
 *
 * Wraps the Electron preload's `window.api.storeGet/Set/Delete/Clear/Keys/
 * Length` bridge into an `AsyncStorage`-shaped object compatible with
 * `@solid-primitives/storage`'s `makePersisted`.
 *
 * Read failures (missing key, allowlist rejection, IPC error) resolve to
 * null — the same shape as "key absent", which is the only value the
 * read consumers can act on anyway.
 *
 * Write failures REJECT the promise. The caller (typically makePersisted)
 * is responsible for surfacing the rejection to the user — silent write
 * success on a failed write is the bug class this module prevents
 * (CENTER-AUDIT perspective-4-cross-process-2026-06-24, defect C0).
 *
 * Both reads and writes coerce any synchronous throws from the bridge
 * into Promise rejections via `tryPromise`, so a coding bug in the
 * preload or main process cannot crash the renderer's effect tree by
 * leaking a synchronous throw into `makePersisted`.
 */

import type { AsyncStorage } from "@solid-primitives/storage"

/** The shape the preload bridge exposes for store IPC. */
export interface DesktopStoreBridge {
  storeGet: (name: string, key: string) => Promise<unknown>
  storeSet: (name: string, key: string, value: string) => Promise<unknown>
  storeDelete: (name: string, key: string) => Promise<unknown>
  storeClear: (name: string) => Promise<unknown>
  storeKeys: (name: string) => Promise<unknown>
  storeLength: (name: string) => Promise<unknown>
}

/**
 * Coerce any synchronous throw or Promise rejection into a single
 * rejection path. Returns the bridge call's return value as a Promise.
 */
function tryPromise<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return Promise.resolve(fn())
  } catch (err) {
    return Promise.reject(err)
  }
}

/**
 * Build an AsyncStorage adapter for a single named store.
 *
 * Each call returns the same cached adapter for the same name; the cache
 * is exposed via `createStorageFactory` for tests and reload hooks.
 */
export function createDesktopStorage(
  bridge: DesktopStoreBridge,
  name: string,
): AsyncStorage {
  return {
    getItem: (key: string) =>
      // Read failure == missing key. The catch is correct here: getItem's
      // return shape (string | null) cannot represent "I tried and failed".
      tryPromise(() => bridge.storeGet(name, key)).then(
        (v) => (typeof v === "string" ? v : v == null ? null : String(v)),
        () => null,
      ),
    setItem: (key: string, value: string) =>
      // Write failures MUST propagate. The previous implementation
      // swallowed the rejection with `.catch(() => {})`, which made a
      // failed settings/draft write indistinguishable from a successful
      // one. The caller (makePersisted) is now expected to handle
      // the rejection via its own error surface.
      tryPromise(() => bridge.storeSet(name, key, value)),
    removeItem: (key: string) => tryPromise(() => bridge.storeDelete(name, key)),
    clear: () => tryPromise(() => bridge.storeClear(name)),
    key: (index: number) =>
      tryPromise(() => bridge.storeKeys(name)).then(
        (keys) => (keys as Array<string> | null | undefined)?.[index],
        () => undefined,
      ),
    getLength: () =>
      tryPromise(() => bridge.storeLength(name)).then(
        (n) => (typeof n === "number" ? n : 0),
        () => 0,
      ),
    get length() {
      return this.getLength()
    },
  } as AsyncStorage
}

/**
 * Cache and factory pair used by the platform adapter. Exposed so the
 * platform adapter can call `createDesktopStorage(bridge, name)` lazily
 * and so tests can construct an adapter directly.
 */
export function createStorageFactory(
  bridge: DesktopStoreBridge,
): (name?: string) => AsyncStorage {
  const cache = new Map<string, AsyncStorage>()
  return (name = "default.dat") => {
    const cached = cache.get(name)
    if (cached) return cached
    const api = createDesktopStorage(bridge, name)
    cache.set(name, api)
    return api
  }
}
