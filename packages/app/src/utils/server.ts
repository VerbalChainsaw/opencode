import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

function normalizeUrl(input: string) {
  return input.trim().replace(/\/+$/, "")
}

export function resolveCurrentServerUrl(input: {
  devOverride?: string | null
  isDev: boolean
  hostname: string
  origin: string
  viteHost?: string
  vitePort?: string
}) {
  if (input.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (!input.isDev) return input.origin
  if (input.devOverride) return normalizeUrl(input.devOverride)
  if (input.viteHost && input.vitePort) return `http://${input.viteHost}:${input.vitePort}`
  return input.origin
}

function isLoopbackUrl(input: string) {
  try {
    const host = new URL(normalizeUrl(input)).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
  } catch {
    return false
  }
}

export function pickDefaultServerUrl(input: { stored: string | null; current: string }) {
  if (!input.stored) return input.current
  const stored = normalizeUrl(input.stored)
  const current = normalizeUrl(input.current)
  if (stored !== current && isLoopbackUrl(stored) && isLoopbackUrl(current)) return current
  return input.stored
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}
