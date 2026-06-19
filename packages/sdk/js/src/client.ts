export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "./error-interceptor.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

function pick(value: string | null, fallback?: string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (value === encodeURIComponent(fallback)) return fallback
  return value
}

function rewrite(request: Request, directory?: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const value = pick(request.headers.get("x-opencode-directory"), directory)
  if (!value) return request

  const url = new URL(request.url)
  if (!url.searchParams.has("directory")) {
    url.searchParams.set("directory", value)
  }

  const next = new Request(url, request)
  next.headers.delete("x-opencode-directory")
  return next
}

export function createOpencodeClient(config?: Config & { directory?: string }) {
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

  const client = createClient(config)
  client.interceptors.request.use((request) => rewrite(request, config?.directory))
  client.interceptors.error.use(wrapClientError)
  return new OpencodeClient({ client })
}
