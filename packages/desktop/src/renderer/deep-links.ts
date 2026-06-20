import type { ElectronAPI } from "../preload/types"

export const DEEP_LINK_EVENT = "opencode:deep-link"

export type DesktopDeepLinkTarget = EventTarget & {
  __OPENCODE__?: {
    deepLinks?: string[]
  }
}

export type DesktopDeepLinkApi = Pick<ElectronAPI, "consumeInitialDeepLinks" | "onDeepLink">

export function emitDesktopDeepLinks(target: DesktopDeepLinkTarget, urls: readonly string[]) {
  if (urls.length === 0) return

  target.__OPENCODE__ ??= {}
  const pending = target.__OPENCODE__.deepLinks ?? []
  const next = [...urls]
  target.__OPENCODE__.deepLinks = [...pending, ...next]
  target.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT, { detail: { urls: next } }))
}

export function listenForDesktopDeepLinks(api: DesktopDeepLinkApi, target: DesktopDeepLinkTarget) {
  void api.consumeInitialDeepLinks().then((urls) => emitDesktopDeepLinks(target, urls))
  return api.onDeepLink((urls) => emitDesktopDeepLinks(target, urls))
}
