export * from "./gen/types.gen.js"
export type {
  FileSystemContent as LocationFileSystemContent,
  FileSystemEntry as LocationFileSystemEntry,
} from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "../error-interceptor.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-opencode-directory", "directory"],
    ["x-opencode-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    for (const query of url.pathname.startsWith("/api/") ? [key, `location[${key}]`] : [key]) {
      if (!url.searchParams.has(query)) {
        url.searchParams.set(query, value)
      }
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-opencode-directory")
  next.headers.delete("x-opencode-workspace")
  return next
}

function isHtmlResponse(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase()
  return contentType?.startsWith("text/html") ?? false
}

export function createLegacySessionFallbackRequest(request: Request) {
  if (request.method !== "GET" && request.method !== "HEAD") return

  const url = new URL(request.url)
  if (!/^\/api\/session(?:\/|$)/.test(url.pathname)) return

  url.pathname = url.pathname.replace(/^\/api(?=\/session(?:\/|$))/, "")
  url.searchParams.delete("location[directory]")
  url.searchParams.delete("location[workspace]")

  const next = new Request(url, request)
  next.headers.delete("x-opencode-directory")
  next.headers.delete("x-opencode-workspace")
  return next
}

export function createOpencodeClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  if (!config?.fetch) {
    // Per audit AUDIT-DEFECTS.md MED-43: the customFetch shim used to
    // be `any` for both the variable and the request param, defeating
    // type checking. Define a structural Fetch interface that captures
    // the call signature the SDK client actually uses (which is a
    // strict subset of both Node's fetch and the DOM's fetch) so the
    // local variable and parameter both get real types.
    interface CustomFetch {
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
    }
    const customFetch: CustomFetch = (req) => {
      // @ts-ignore — Node's undici fetch supports `timeout = false` to
      // disable the default request timeout; standard Request type
      // does not include it. Single-site opt-out, not a shim-wide
      // escape hatch.
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      // Config's `fetch` is the DOM Fetch interface (with methods like
      // `preconnect` that Node lacks). The shim is runtime-compatible
      // for the SDK client's actual call pattern; only DOM-only
      // surface methods are missing. Narrow cast at this single
      // boundary is documented and intentional.
      fetch: customFetch as unknown as Config["fetch"],
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-opencode-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use(async (response, request, opts) => {
    if (isHtmlResponse(response)) {
      const fallbackRequest = createLegacySessionFallbackRequest(request)
      if (fallbackRequest) {
        response = await (opts.fetch ?? config?.fetch ?? globalThis.fetch)(fallbackRequest)
      }
    }

    if (isHtmlResponse(response))
      throw new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new OpencodeClient({ client })
}
