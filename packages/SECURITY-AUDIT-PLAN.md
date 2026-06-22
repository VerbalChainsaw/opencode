# Security Defect Plan — C:\Users\zerop\Development\opencode-source\packages

**Date**: 2026-06-21  
**Source**: `bun audit` output, manual codebase inspection  
**Total**: 156 vulnerabilities (2 critical, 45 high, 83 moderate, 26 low)

---

## PRIORITY 1: DOMPurify Mutation-XSS in User Content Rendering

### Vulnerability
DOMPurify has a mutation-XSS via re-contextualization bypass. When the `afterSanitizeAttributes` hook is polluted by prior usage (e.g., from iframes or cross-realm objects), the sanitize function can produce output that allows script execution. Additionally, DOMPurify contains 16 total vulnerabilities including prototype pollution and IN_PLACE mode issues.

### Impact
All user content rendered in the app flows through this path. A crafted markdown payload could inject scripts into displayed messages, especially if the user interacts with cross-realm objects (e.g., pasting content from an iframe or a web page).

### Evidence
**File**: `packages/ui/src/components/markdown.tsx`  
**Lines 18-38**:

```typescript
// Line 19: Custom hook added to DOMPurify — this is persistent and not reset between renders
if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => { ... })
}

// Line 31-38: Shared config object — if this is mutated by external code, it affects all subsequent sanitizations
const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,        // Protects against prototype pollution via named props
  FORBID_TAGS: ["style"],            // Only style is forbidden — script tags are allowed
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],         // svg and path are allowed (with attributes)
  ADD_ATTR: ["d", "viewBox", ...],   // Limited attribute whitelist
}

// Line 45-48: The sanitize function — called for every block of markdown
function sanitize(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}
```

**Line 279**: `const safe = sanitize(next)` is the critical sanitization point where user content becomes rendered HTML.  
**Lines 308-310**: The sanitized content is then merged into the DOM via `morphdom` — if a script survives sanitization, it's now in the live DOM and will execute.

### Remediation
1. **Clone the config object before each sanitize call** (prevents hook pollution):  
   ```typescript
   function sanitize(html: string) {
     return DOMPurify.sanitize(html, JSON.parse(JSON.stringify(config)))
   }
   ```
2. **Add `KEEP_CONTENT` to FORBID_TAGS** if you want script tags explicitly blocked in content (not just forbidden contents).  
3. **Consider upgrading DOMPurify** to the latest version where most of these vulnerabilities have been patched. The audit shows multiple medium-severity issues that are fixed in 3.4.6+.

---

## PRIORITY 2: Seroval RCE via JSON Deserialization

### Vulnerability
Seroval has multiple high-severity vulnerabilities including RCE through arbitrary constructor invocation during deserialization, prototype pollution, and DoS via deeply nested objects or RegExp serialization. The critical risk is that crafted JSON payloads can execute arbitrary JavaScript when passed to `seroval.deserialize()`.

### Impact
If untrusted data (e.g., from API responses, user inputs, or serialized state) flows through Seroval's deserialization path with an attacker-controlled payload, it could lead to RCE. This affects any part of the codebase that uses Seroval for state management.

### Evidence
**Seroval is used in**: `packages/app`, `packages/autogoal` (as a dependency via `@opentui/solid`).  
**Version in audit**: 1.4.0 and earlier are vulnerable. Check the current version with:  
```bash
bun pm list seroval --json
```

### Remediation
1. **Audit all Seroval deserialization sites** — grep for `seroval` or `deserialize` calls.  
2. **Ensure all deserialized data comes from trusted sources**. If untrusted data must be deserialized, sanitize it first or use a whitelist of allowed constructors.  
3. **Upgrade Seroval to > 1.4.0** if available — the RCE and prototype pollution fixes are included in newer versions.

---

## PRIORITY 3: Hono JWT Algorithm Confusion

### Vulnerability
Hono's `jwt` middleware has a critical vulnerability where tokens with missing `alg` header fields fall back to HS256 (symmetric), allowing attackers to forge valid tokens if they know the secret key. This is an algorithm confusion attack that bypasses authentication entirely.

### Impact
All API requests authenticated via Hono's JWT middleware are at risk. An attacker could craft a token signed with a known public key as HMAC, and it would be accepted by any Hono service configured to use HS256 fallback.

### Evidence
**File**: `packages/enterprise/src/routes/api/[...path].ts`  
**Line 2**: `import { Hono } from "hono"`  
**Lines 3-4**: Uses `hono-openapi` for route description and validation.  
**Other services using Hono**: `packages/enterprise`, `packages/function`.

### Remediation
1. **Check all Hono JWT middleware setups** in `packages/enterprise/src/routes/api/[...path].ts` and `packages/function/`. Ensure the `key` is a cryptographic key (not just any string) or that you explicitly set `alg: "RS256"` if using asymmetric keys.  
2. **Force algorithm validation**: Use the Hono `jwt` middleware with an explicit `algorithm` option to prevent fallback.  
3. **Audit all JWT issuers** in your codebase — ensure tokens are signed by trusted authorities and that the `alg` field is never omitted in outgoing tokens.

---

## PRIORITY 4: fast-xml-parser Entity Encoding Bypass (critical)

### Vulnerability
fast-xml-parser has an entity encoding bypass via regex injection in DOCTYPE entity names. This allows attackers to inject malicious entities that expand beyond the normal limits, potentially leading to RCE or DoS depending on how XML data is processed downstream.

### Impact
This is a **critical** vulnerability. It affects any part of the codebase that processes untrusted XML input (e.g., API responses, file uploads) via fast-xml-parser. An attacker could craft a malicious XML payload with nested entities that cause exponential expansion or execute code in certain configurations.

### Evidence
**fast-xml-parser is used by**:  
- `@aws-sdk/client-s3` (`packages/stats-core`) — for AWS S3 operations.  
- `astro` (`packages/web`) — for Astro build process.  
- `nitro` (`packages/console-app`) — for Nitro server-side rendering.  
- Multiple other packages (console-support, storybook).

### Remediation
1. **Upgrade fast-xml-parser to > 5.7.0** where this vulnerability is fixed.  
2. **If upgrading is not feasible**, add explicit entity expansion limits when using the parser:  
   ```typescript
   const parser = new Parser({
     ignoreDeclaration: true,
     keepCommentNodes: false,
     // Explicitly limit entity expansion
     maxEntities: 10,
     maxLengthOfOpenEntityRef: 20,
   })
   ```

---

## PRIORITY 5: Wrangler OS Command Injection

### Vulnerability
Wrangler (Cloudflare's CLI) has an OS command injection vulnerability in `wrangler pages deploy`. If the user provides untrusted input to the deployment process, they could inject arbitrary shell commands.

### Impact
This affects any automated deployment pipeline that uses Wrangler for Cloudflare Pages deployments. An attacker who can control parts of the deployed URL or metadata (e.g., via a vulnerable API endpoint) could inject malicious commands into the deployment process.

### Evidence
**Wrangler is used in**: `packages/console-app`, `packages/console-support`.  
**Audit entry**: `wrangler >=4.0.0 <4.59.1` — check your current version with:  
```bash
bun pm list wrangler --json
```

### Remediation
1. **Upgrade Wrangler to > 4.59.1**.  
2. **Audit all Wrangler `deploy` calls** in your codebase for untrusted user input that could end up in shell commands.

---

## PRIORITY 6: Vite fs.deny Bypass on Windows

### Vulnerability
Vite has multiple `fs.deny` bypass vulnerabilities on Windows, including path traversal via alternate paths and query parameters. This allows attackers to read arbitrary files from the server's filesystem by crafting requests with backslash-separated paths or encoded characters.

### Impact
This affects any part of your codebase that uses Vite in development mode (which is most of it). An attacker could potentially read sensitive files like `.env`, `package.json`, or even configuration files by requesting URLs with crafted paths.

### Evidence
**Vite is used extensively**:  
- `packages/app` — main app dev server.  
- `packages/desktop` — Electron + Vite bundling.  
- `packages/web` — Astro + Vite for web builds.  
- `packages/storybook` — component documentation.  

### Remediation
1. **Upgrade Vite to > 5.4.19** (recommended). This addresses the Windows-specific bypass issues.  
2. If you cannot upgrade, ensure that your dev server configuration explicitly denies backslash-separated paths and query parameters:  
   ```typescript
   export default defineConfig({
     server: {
       fs: {
         allow: ["."],
         deny: ["/"],
       },
     },
   })
   ```

---

## PRIORITY 7: Undici Unbounded Decompression + DoS

### Vulnerability
Undici has multiple vulnerabilities including unbounded decompression chain (resource exhaustion), HTTP request/response smuggling, and WebSocket denial of service via cumulative fragment bypass. These are high-severity issues that can lead to server crashes or unauthorized access through smuggled requests.

### Impact
All fetch-based code paths in your codebase use Undici (directly or transitively). This includes:  
- `packages/core` — for API calls and file transfers.  
- `packages/cli` — for external HTTP operations.  
- `packages/console-app`, `packages/web` — via `@actions/github` and `wrangler`.

### Evidence
**Audit entry**: `undici <6.23.0` has 18+ vulnerabilities including:
- Unbounded decompression chain (high)  
- HTTP request/response smuggling (moderate)  
- WebSocket DoS via cumulative fragment bypass (high)  

### Remediation
1. **Upgrade Undici to > 6.23.0** in the `packages/core` package (or wherever it's a direct dependency).  
2. If you cannot upgrade, add explicit decompression limits when using fetch:  
   ```typescript
   const response = await fetch(url, {
     headers: { "Accept-Encoding": "identity" },  // Disable compression for untrusted data
   })
   ```

---

## PRIORITY 8: Seroval Prototype Pollution (critical)

### Vulnerability
Seroval has a prototype pollution vulnerability that allows attackers to modify the `Object.prototype` of any object that is deserialized. This can lead to unexpected behavior in downstream code, including information disclosure or remote code execution if the polluted properties affect security checks.

### Impact
Any part of the codebase that uses Seroval for state management is at risk. If an attacker can inject a crafted payload into serialized state (e.g., via local storage or API responses), they could pollute `Object.prototype` and affect all subsequent deserialization operations.

### Evidence
**Seroval is used in**:  
- `packages/app`: For Solid.js component state management.  
- `packages/autogoal`: For plugin tool state.  

### Remediation
1. **Check for prototype pollution vectors**: Search the codebase for any place where Seroval's deserialized data is merged into existing objects using `Object.assign` or spread operators. These operations are vulnerable to prototype pollution.  
2. **Use a fresh Object.prototype** when merging:  
   ```typescript
   const result = { ...existingData, ...deserializedData }
   // Or use Object.create(null) for the merge target:
   const result = Object.assign(Object.create(null), existingData, deserializedData)
   ```

---

## REMEDIATION CHECKLIST

1. [ ] **Run `bun update`** to patch all dependencies at once (recommended as first step).  
2. [ ] **Audit Hono JWT middleware**: Check all `jwt` usages in `packages/enterprise/src/routes/api/[...path].ts` and `packages/function`. Ensure explicit `alg` handling.  
3. [ ] **Upgrade Seroval to > 1.4.0** for RCE fix.  
4. [ ] **Audit DOMPurify hook pollution**: Add deep clone of config in the sanitize function (see PRIORITY 1).  
5. [ ] **Check fast-xml-parser version**: Ensure it's > 5.7.0 or has explicit entity limits configured.  
6. [ ] **Upgrade Wrangler to > 4.59.1** for command injection fix.  
7. [ ] **Review all user content flows**: Ensure any data that ends up in the DOM is sanitized via DOMPurify, and that cross-realm objects are handled correctly.  
8. [ ] **Test with untrusted input**: Run security regression tests using payloads from the vulnerability reports (GHSA-66fc-rw6m-c2q6 for Seroval DoS, GHSA-3rxj-6cgf-8cfw for Seroval RCE).  

---

## ADDITIONAL DEFECTS TO INVESTIGATE

### Minimatch ReDoS in Core
**Package**: `packages/core`  
**Function**: `match(pattern: string, filepath: string)` in `util/glob.ts` (line 32).  
**Risk**: While minimatch is not called in hot loops on untrusted data directly, any place where users provide input to these functions could theoretically trigger the vulnerability.  
**Fix**: Upgrade minimatch to > 10.2.1 or add explicit pattern validation before calling `minimatch()`.

### Protobufjs Schema-Shadowing
**Package**: `packages/core` (`@opentelemetry/exporter-trace-otlp-http`)  
**Risk**: Schema-derived names can shadow runtime-significant properties, leading to prototype pollution if untrusted protobuf data flows through the system.  
**Fix**: Audit all protobuf schema definitions and ensure no user-controlled fields are used as property names in sensitive code paths.

### PostCSS XSS via Unescaped </style>
**Package**: `packages/app` (`tailwindcss`, `vite-plugin-solid`)  
**Risk**: Malformed CSS can inject a script into the DOM via an unescaped `</style>` tag.  
**Fix**: Upgrade postcss to > 8.5.10 or ensure all CSS is escaped before injection.

---

## SUMMARY: TOP 5 DEFECTS TO FIX FIRST

1. **DOMPurify Mutation-XSS** (Priority 1) — All user content flows through this path; low barrier to exploitation.  
2. **Seroval RCE** (Priority 2) — If untrusted data is deserialized, it could lead to remote code execution.  
3. **Hono JWT Algorithm Confusion** (Priority 3) — Affects all API authentication; requires minimal config changes.  
4. **fast-xml-parser Entity Encoding Bypass** (Priority 4) — Critical vulnerability in XML processing path.  
5. **Undici Unbounded Decompression** (Priority 7) — High-severity DoS vector in all fetch-based code paths.
