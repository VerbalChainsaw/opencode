# Architecture & Defect List

**Audit Date:** 2026-06-14
**Rounds:** 6 (initial audit, re-validation, deep-dive coverage, cross-cutting analysis, generated/web/containers/edge-cases, structural/infra/nix/build)
**Inspector:** big-pickle
**Scope:** Full monorepo — all ~30 workspace packages, TypeScript/TSX code quality, UI component architecture, spec compliance, wiring defects, dependency drift, security, infrastructure
**Packages Examined:** All workspace packages under `packages/`, plus `sdks/vscode/`, `github/`, `infra/`, `script/`, `perf/`, `nix/`, `patches/`
**Typecheck Status:** ✅ All 5 core packages typecheck clean (`bun typecheck` exits 0)
**Total Findings:** 131 (6 Critical, 16 High, 63 Medium, 42 Low, 4 Informational)

---

## 🔴 CRITICAL

### CRIT-01: TUI Package Depends on `@opencode-ai/core` — Spec Isolation Violated

**Severity:** Critical | **Confidence:** Confirmed | **Category:** ARC, SPEC

**Spec Reference:** `specs/tui-package.md` lines 26–28: "It must not depend on `packages/opencode`, `packages/cli`, or `@opencode-ai/core`."

**Evidence:** `packages/tui/package.json:50` declares `"@opencode-ai/core": "workspace:*"`. 8 source files import from it (app.tsx, kv.tsx, theme.tsx, sdk.tsx, dialog.tsx, error-component.tsx, sidebar.tsx, prompt/index.tsx).

**Impact:** TUI cannot be standalone; the spec's primary isolation invariant is violated; blocks independent bundling, testing, and distribution.

**Recommendation:** Remove `@opencode-ai/core` from package.json. Replace imports with TUI's own types, local mutex for `Flock`, and Bun's Glob.

---

### CRIT-02: Dual V1/V2 UI Component System — Incomplete Migration

**Severity:** Critical | **Confidence:** Confirmed | **Category:** ARC, DUP

**Evidence:** 18 duplicated component pairs. 7 consumer files mix both versions. 45 v1-only components with no v2 counterpart. Different APIs between versions.

**Impact:** Visual inconsistency (4 files render both versions side by side), doubled maintenance, no migration plan.

**Recommendation:** Create MIGRATION.md, choose survivor per pair, remove loser from exports, update all consumers.

---

### CRIT-03: `===` Password Comparisons Enable Timing Attacks on HTTP Auth

**Severity:** Critical | **Confidence:** Confirmed | **Category:** SEC

**Evidence:**
- `packages/server/src/auth.ts:48` — `Redacted.value(credentials.password) === config.password.value`
- `packages/opencode/src/server/auth.ts:32` — same pattern

Both use `===` (string comparison) which short-circuits on first differing character. The console and stats packages already have proper `timingSafeEqual` implementations as reference.

**Impact:** The HTTP Basic Auth password for both v2 and v3 API servers can be brute-forced via timing attack (~N*256 requests for an N-character password).

**Recommendation:** Replace with `timingSafeEqual`. Reference: `packages/console/core/src/util/crypto.ts`.

---

### CRIT-04: Hardcoded Stripe Account ID in Source

**Severity:** Critical | **Confidence:** Confirmed | **Category:** SEC

**Evidence:** `packages/console/support/src/lib/lookup.ts:294` — hardcoded `acct_1RszBH2StuRr0lbX`.

**Impact:** Production financial infrastructure identifier exposed in source.

**Recommendation:** Move to SST secret or env variable.

---

### CRIT-05: Cloudflare Zone ID Hardcoded in Infrastructure Code

**Severity:** Critical | **Confidence:** Confirmed | **Category:** SEC

**Evidence:** `infra/stage.ts:7` — `export const zoneID = "430ba34c138cfb5360826c4909f99be8"`.

**Impact:** Zone ID exposure enables targeted DNS/SSL attacks.

**Recommendation:** Move to `sst.Secret` or `process.env`.

---

### CRIT-06: `packages/containers` Has tsconfig but No package.json

**Severity:** Critical | **Confidence:** Confirmed | **Category:** CON

**Evidence:** `packages/containers/tsconfig.json` exists, matches workspace glob `packages/*`, but has NO `package.json`.

**Impact:** Bun workspace resolution fails silently or emits warnings. Build script is orphaned.

**Recommendation:** Add `package.json` or exclude from workspace glob.

---

## 🔴 HIGH

### HIGH-01: Empty Catch Blocks Swallow Errors (~65+ instances)

**Severity:** High | **Confidence:** Confirmed | **Category:** ERR

**Highest risk clusters:**

| Cluster | File(s) | Count | Risk |
|---------|---------|-------|------|
| Persistence (stash/history/frecency) | `packages/tui/src/prompt/{stash,history,frecency}.tsx` | 11 | Data loss |
| LSP operations | `packages/opencode/src/lsp/server.ts` | 8 | Silent install failures |
| Runtime stream lifecycle | `packages/opencode/src/cli/cmd/run/runtime.ts` | 12 | Silent session failures |
| Desktop WSL | `packages/desktop/src/main/wsl/{runtime,servers}.ts` | 6 | Silent process errors |
| LLM response body | `packages/llm/src/route/executor.ts:282` | 1 | Silent body-read failure |
| Config write | `packages/opencode/src/config/config.ts:274` | 1 | Silent config save failure |

**Recommendation:** Add `console.warn(error)` to every `.catch(() => {})`. For persistence use `toast.error`.

---

### HIGH-02: No UI Component Design Spec

**Severity:** High | **Confidence:** Confirmed | **Category:** ARC, OBS

No `DESIGN.md` exists. Component APIs differ between v1 and v2 without documentation. See prior listing.

---

### HIGH-03: LLM Provider Requests Have No Timeout — Infinite Hangs

**Severity:** High | **Confidence:** Confirmed | **Category:** ERR, PERF

**Evidence:**
- `packages/llm/src/route/executor.ts:374` — `http.execute(request)` has no `Effect.timeout()`
- `src/route/transport/websocket.ts:62-101` — `waitOpen` has no connection timeout
- `src/route/transport/websocket.ts:180-182` — No heartbeat or idle timeout

**Impact:** Provider-side stall locks up caller forever.

**Recommendation:** Wrap with `Effect.timeout(120_000)`. Add connection timeout to waitOpen.

---

### HIGH-04: Race Condition in Shared `approvedToolsForSession` Set

**Severity:** High | **Confidence:** Confirmed | **Category:** FRG

**Evidence:** `packages/opencode/src/session/llm.ts:155-197` — `Set` shared across concurrent approval handler calls without synchronization.

**Impact:** Under concurrent tool calls, approvals can be incorrectly denied or granted.

**Recommendation:** Use `SynchronizedRef` or add mutex.

---

### HIGH-05: `new Function()` Code Execution in Debug CLI Handler

**Severity:** High | **Confidence:** Confirmed | **Category:** SEC

**Evidence:** `packages/opencode/src/cli/cmd/debug/agent.handler.ts:110` — `return new Function(return (${trimmed}))()` after JSON.parse fails.

**Impact:** Arbitrary JS execution from CLI input.

**Recommendation:** Remove the fallback. Throw clear error instead of eval.

---

### HIGH-06: Desktop Pinned to TypeScript ~5.6.2 — 2 Major Versions Behind

**Severity:** High | **Confidence:** Confirmed | **Category:** DEP, CON

**Evidence:** `packages/desktop/package.json:56` — `"typescript": "~5.6.2"` vs catalog `5.8.2`.

**Impact:** Incompatible type features, IDE confusion, two TS versions in workspace.

**Recommendation:** Update to `"catalog:"`. Verify `bun typecheck`.

---

### HIGH-07: 19 Duplicate `@ai-sdk/*` Provider Packages in `packages/opencode`

**Severity:** High | **Confidence:** Confirmed | **Category:** DEP

**Evidence:** `packages/opencode/package.json` declares 19 identical `@ai-sdk/*` packages ALSO declared in `packages/core/package.json`.

**Impact:** Doubles node_modules weight, creates version drift risk.

**Recommendation:** Remove 19 duplicates from opencode. Re-export from core.

---

### HIGH-08: `as any` Abuse in Console App Zen Provider Layer (150+ Casts)

**Severity:** High | **Confidence:** Confirmed | **Category:** FRG

**Evidence:** `packages/console/app/src/routes/zen/util/provider/{openai-compatible,anthropic,openai}.ts` — 150+ `as any` casts.

**Impact:** Zero type safety. Upstream API changes silently produce runtime errors.

**Recommendation:** Define proper provider-agnostic types and convert through typed interfaces.

---

### HIGH-09: `@ts-nocheck` Disables All Type Safety in Console Mail Styles

**Severity:** High | **Confidence:** Confirmed | **Category:** SEC, STD

**Evidence:** `packages/console/mail/emails/styles.ts:1` — `// @ts-nocheck`.

**Impact:** Silent type errors in email rendering.

**Recommendation:** Remove and fix underlying type issues.

---

### HIGH-10: `pull_request_target` Checks Out PR Code Before Team Filter

**Severity:** High | **Confidence:** Confirmed | **Category:** SEC

**Evidence:** `.github/workflows/pr-management.yml:4,14-17` — Uses `pull_request_target` and checks out PR code before team filter.

**Impact:** Malicious PR could modify workflow files in checked-out code.

**Recommendation:** Move team check before checkout.

---

### HIGH-11: WebSocket Event Listener Registration Race — Lost Messages

**Severity:** High | **Confidence:** Confirmed | **Category:** FRG

**Evidence:** `packages/llm/src/route/transport/websocket.ts:143-182` — Event listeners registered AFTER waitOpen completes.

**Impact:** Messages lost during the gap between connection and listener registration.

**Recommendation:** Register listeners BEFORE waitOpen resolves.

---

### HIGH-12: XSS Risk in Share Page — Unsanitized innerHTML

**Severity:** High | **Confidence:** Confirmed | **Category:** SEC

**Evidence:**
- `packages/web/src/components/share/content-markdown.tsx:53` — `innerHTML={html()}` with user/AI-generated markdown content
- `packages/web/src/components/share/content-code.tsx:27` — `innerHTML={html()}` with user-generated code

While `marked` renders HTML and adds `target="_blank" rel="noopener noreferrer"` to links, other HTML tags pass through unsanitized. No DOMPurify or equivalent sanitization is applied.

**Impact:** XSS payloads in user/AI-generated content could execute in the browser context.

**Recommendation:** Add HTML sanitization (e.g., DOMPurify) before setting innerHTML, or use a safer rendering approach.

---

### HIGH-13: Missing Fetch Error Handling in SSR Share Page

**Severity:** High | **Confidence:** Confirmed | **Category:** ERR

**Evidence:** `packages/web/src/pages/s/[id].astro:73-74`:
```ts
const res = await fetch(`${apiUrl}/share_data?id=${id}`)
const data = (await res.json()) as { ... }
```
No error handling if the fetch fails (network error) or if the response is not JSON. If `res` is not OK, `res.json()` could throw, causing an unhandled 500 error to the user. No `AbortController` timeout either — if the API server hangs, the SSR page hangs indefinitely.

**Impact:** Unhandled fetch failures produce cryptic 500 errors to users. No timeout means page hangs on slow API.

**Recommendation:** Wrap fetch in try/catch, check `res.ok`, add `AbortController` timeout (e.g., 10 seconds).

---

### HIGH-14: Supply-Chain Risk — curl-pipe-to-bash in Dockerfiles

**Severity:** High | **Confidence:** Confirmed | **Category:** SEC

**Evidence:**
- `packages/containers/bun-node/Dockerfile:21` — `curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"`
- `packages/containers/rust/Dockerfile:11` — `curl -fsSL https://sh.rustup.rs | sh -s -- ...`

Classic supply-chain risk: piping remote scripts directly to bash without checksum verification. If the CDN or domain is compromised, arbitrary code executes during build.

**Impact:** Malicious code could execute during Docker build if upstream script is compromised.

**Recommendation:** Download script, verify checksum, then execute. Or use a pre-built image with a pinned digest.

---

### HIGH-15: Nix Build Broken by Filename Typo (node-modules vs node_modules)

**Severity:** High | **Confidence:** Confirmed | **Category:** BUILD

**Evidence:** `packages/nix/opencode.nix:14` — references `./node-modules.nix` (with hyphen) but the actual file is `node_modules.nix` (with underscore). Nix is case-sensitive and hyphen vs underscore matters.

```
node_modules ? callPackage ./node-modules.nix { }
```
Actual filename: `node_modules.nix` (underscore)

**Impact:** The entire Nix build fails at evaluation time. This blocks `nix build`, `nix develop`, `nix build .#opencode-desktop`, and `node_modules_updater`.

**Recommendation:** Change `./node-modules.nix` to `./node_modules.nix` on line 14 of `packages/nix/opencode.nix`.

---

### HIGH-16: 26MB of MP4 Video Tracked Without Git LFS

**Severity:** High | **Confidence:** Confirmed | **Category:** PERF

**Evidence:**
- `packages/console/app/src/asset/lander/opencode-comparison-min.mp4` — **16.1 MB**
- `packages/console/app/src/asset/lander/opencode-min.mp4` — **9.9 MB**

These MP4 files are tracked directly in git with no Git LFS configuration. No `.gitattributes` entry for MP4 files exists. Every clone fetches 26MB of compressed video.

**Impact:** Bloated clone sizes, slower CI, no history optimization. The repository has 5732 tracked files and these two video files account for a disproportionate share of the total size.

**Recommendation:** Either:
1. Remove MP4 files and host them externally (CDN/S3)
2. Configure Git LFS for `*.mp4` files
3. Compress further or generate video from still frames

---

## 🟡 MEDIUM

### MED-01: UI Package Imports Utility Functions from Core

**Severity:** Medium | **Confidence:** Confirmed | **Category:** ARC

9 imports of `checksum`, `getDirectory`, `getFilename`, `Binary` from `@opencode-ai/core/util/*`.

**Recommendation:** Inline utilities or extract to shared package.

---

### MED-02: 54 Individual Component CSS Files + Tailwind + Inline Styles

**Severity:** Medium | **Confidence:** Confirmed | **Category:** STD

Three styling strategies simultaneously. No consistent approach.

---

### MED-03: `any` Types in Core Infrastructure (~80+ annotations, 29 Schema.Any)

**Severity:** Medium | **Confidence:** Confirmed | **Category:** FRG

Expanded coverage now includes:
- TUI: KV.get/set, Dialog.replace, Toast.error
- opencode/src: tool/tool.ts, util/rpc.ts, bus/global.ts, provider/provider.ts, provider/transform.ts, session/llm.ts
- slack: sessions Map with `client: any; server: any`
- function: `publish(key, content: any)`
- console: 150+ `as any` in Zen provider (see HIGH-08)
- core: 29 Schema.Any instances disabling runtime validation

---

### MED-04: Editorconfig / Prettier max_line_length Conflict

`.editorconfig` says 80, Prettier says 120.

---

### MED-05: Stale Test Snapshots

Snapshot fixtures in `inline-tool-wrap-snapshot.test.tsx` reference old paths.

---

### MED-06: Commented-Out Code in Production

`packages/app/src/app.tsx:222-225` — Suspense/Loading wrapper commented out.

---

### MED-07: TUI Uses Flag/Global from Core Despite Migration Plan

Overlaps with CRIT-01.

---

### MED-08: `globalThis.AI_SDK_LOG_WARNINGS = false` Duplicated in Two Files

**Evidence:** `packages/opencode/src/server/server.ts:16-17` and `src/session/prompt.ts:64-65`. Same global side effect applied in two entry points. Uses `@ts-ignore`.

**Recommendation:** Consolidate to single location.

---

### MED-09: `throw new Error()` Inside Effect Generator — Unmanaged Defect (3 instances)

**Evidence:**
- `packages/core/src/plugin/provider/dynamic.ts:25`
- `packages/core/src/plugin/provider/sap-ai-core.ts:22,30`

**Impact:** Unmanaged defects that crash Effect runtime.

**Recommendation:** Use `Effect.die()` or `Effect.fail()`.

---

### MED-10: Race Condition in Slack Session Map — Duplicate Sessions

**Evidence:** `packages/slack/src/index.ts:72-94` — Shared mutable `sessions: Map` without synchronization.

**Recommendation:** Use `ConcurrentMap` or add mutex.

---

### MED-11: Self-Referencing Namespace Re-exports (2 packages)

**Evidence:**
- `packages/effect-sqlite-node/src/index.ts:1` — `export * as NodeSqliteClient from "./index"`
- `packages/server/src/auth.ts:1` — `export * as ServerAuth from "./auth"`

**Recommendation:** Remove self-referencing exports.

---

### MED-12: `process.env` Mutation Alongside Async Operations (6+ instances)

**Evidence:** Multiple files in `packages/opencode/src/provider/provider.ts` and `packages/core/src/plugin/provider/*.ts` mutate `process.env` for AWS/AICore credentials during async setup.

**Recommendation:** Use Effect's `Ref` or dedicated config service.

---

### MED-13: Self-XSS via innerHTML in Share Components

**Evidence:** `packages/web/src/components/share/{content-bash,content-markdown,content-code}.tsx` — user/AI generated content set via `innerHTML`.

**Recommendation:** Audit markdown sanitization pipeline.

---

### MED-14: Overly Permissive CSP — `connect-src *`

**Evidence:** `packages/opencode/src/server/shared/ui.ts:11-12` — `connect-src *` allows data exfiltration. No `object-src` or `base-uri` restriction.

**Recommendation:** Tighten to specific origins. Add `object-src 'none'` and `base-uri 'self'`.

---

### MED-15: `.oxlintrc.json` — Three Duplicate `options` Keys

**Evidence:** `.oxlintrc.json` has `options` key THREE times (lines 4, 44, 47).

**Recommendation:** Deduplicate.

---

### MED-16: 6 Workflow Files Missing `permissions:` Block

**Evidence:** `.github/workflows/{storybook,typecheck,notify-discord,review,stats,pr-management}.yml` have no top-level `permissions:`.

**Recommendation:** Add `permissions: contents: read`.

---

### MED-17: Multiple IAM Policies with `resources: ["*"]`

**Evidence:** `infra/lake.ts` — multiple statements with `resources: ["*"]`. Default catalog grants `["ALL"]` to `IAM_ALLOWED_PRINCIPALS`.

**Recommendation:** Scope to specific resource ARNs.

---

### MED-18: R2 Credentials Default to Literal String "unknown"

**Evidence:** `infra/secret.ts:8-9` — `R2AccessKey: new sst.Secret("R2AccessKey", "unknown")`.

**Recommendation:** Remove defaults or ensure explicit setting per stage.

---

### MED-19: `flake.nix` Provides Node 20, but 7 Packages Require Node >= 22

**Recommendation:** Update to `nodejs_22`.

---

### MED-20: Desktop Uses `marked` v15 While Catalog Is v17

**Evidence:** `packages/desktop/package.json:34` — `"marked": "^15"` vs catalog `17.0.1`.

**Recommendation:** Update to `"catalog:"`.

---

### MED-21: Root tsconfig Has No `include`/`exclude`

**Evidence:** Root `tsconfig.json` has no include/files/exclude — would type-check everything.

**Recommendation:** Add `"include": ["packages/*/src"]`.

---

### MED-22: Missing `"type": "module"` in Two Packages

**Evidence:** `packages/script/package.json` and `packages/console/resource/package.json` missing `"type": "module"`, defaulting to CJS.

**Recommendation:** Add `"type": "module"`.

---

### MED-23: Cross-Package Include References in Stats tsconfigs

**Evidence:** `packages/stats/{server,app}/tsconfig.json` include `"../core/src/resource.d.ts"`.

**Recommendation:** Use project references.

---

### MED-24: `as any` in Effect Drizzle SQLite Adapter (25+ casts)

**Evidence:** Across `packages/effect-drizzle-sqlite/src/sqlite-core/effect/{select,insert,update,delete}.ts`.

---

### MED-25: `Math.random()` Fallback for UUID Generation

**Evidence:**
- `packages/app/src/utils/uuid.ts` — falls back to `Math.random()` when `crypto.randomUUID()` unavailable
- `packages/app/src/utils/id.ts` — falls back to `Math.floor(Math.random() * 256)`

**Recommendation:** Log warning on fallback. Consider removing fallback for security-critical operations.

---

### MED-26: Unsafe Array Access in GitHub App Token Exchange

**Evidence:** `packages/function/src/api.ts:279` — `sub.split(":")[1].split("/")` — if sub has no ":", `[1]` is undefined.

**Recommendation:** Add guard.

---

### MED-27: `minimatch` Version Drift

**Evidence:** opencode 10.0.3 vs core 10.2.5.

---

### MED-28: `@smithy/*` Version Drift

**Evidence:** llm at 4.2.14 vs console/app at 4.2.7 (eventstream-codec). Same for util-utf8.

---

### MED-29: `@solid-primitives/resize-observer` Version Drift

**Evidence:** ui uses 2.1.3, consumers app/web use 2.1.5.

---

### MED-30: Multiple Packages Bypass Catalog for `semver`, `fuzzysort`, `@tsconfig/*`

**Evidence:** 4 packages literal `^7.6.x` for semver, 2 packages literal for fuzzysort, etc.

**Recommendation:** Migrate to `"catalog:"`.

---

### MED-31: `@standard-schema/spec` in Both deps and devDeps

**Evidence:** `packages/opencode/package.json` lists in both dependency sections.

---

### MED-32: `@tsconfig/bun` in Runtime Dependencies

**Evidence:** `packages/console/mail/package.json:7` — TypeScript config package in `dependencies`.

**Recommendation:** Move to devDependencies.

---

### MED-33: Desktop Open-Link IPC Has No URL Validation

**Evidence:** `packages/desktop/src/main/ipc.ts:166-168` — `shell.openExternal(url)` without protocol validation.

**Recommendation:** Only allow `https://`.

---

### MED-34: `updaterSubscription` Overwrite Race

**Evidence:** `packages/desktop/src/preload/index.ts:7` — shared variable overwritten on concurrent calls.

---

### MED-35: Server Sidecar Spawn — postMessage Race

**Evidence:** `packages/desktop/src/main/server.ts:88-140` — message may arrive before child listener is registered.

**Recommendation:** Implement handshake protocol.

---

### MED-36: SDK v2/data.ts Uses "asdasd" as Placeholder ID

**Evidence:** `packages/sdk/js/src/v2/data.ts:12,25` — keyboard-mashing string used as message/part IDs.

**Recommendation:** Replace with `crypto.randomUUID()`.

---

### MED-37: containers/ Has tsconfig but No package.json

Duplicate of CRIT-06.

---

### MED-38: 8 Packages Override @tsconfig/node22 Base Settings

**Evidence:** 8 packages override module to ESNext and moduleResolution to bundler, defeating base config.

**Recommendation:** Switch to @tsconfig/bun.

---

### MED-39: 6 Standalone tsconfigs Duplicate Base Settings

**Evidence:** `packages/{app,desktop,enterprise,console/support,console/app}/tsconfig.json` and `github/tsconfig.json` independently repeat base settings.

**Recommendation:** Extend @tsconfig/bun.

---

### MED-40: `noUncheckedIndexedAccess` Split

Root enforces `true`, every package overrides to `false`.

---

### MED-41: app tsconfig Emits to `node_modules/.ts-dist`

**Evidence:** `packages/app/tsconfig.json` — `outDir: "node_modules/.ts-dist"`.

**Recommendation:** Use `dist/types/`.

---

### MED-42: executeStream Not Implemented in effect-sqlite-node

**Evidence:** `packages/effect-sqlite-node/src/index.ts:119` — `return Stream.die("executeStream not implemented")`.

---

### MED-43: `as any` Casts in SDK Client

**Evidence:** `packages/sdk/js/src/client.ts:35` and `v2/client.ts:55` — `const customFetch: any`.

---

### MED-44: Hardcoded Social Card URL in Multiple Files

**Evidence:** `packages/enterprise/src/routes/share/[shareID].tsx:182`, `packages/web/src/pages/s/[id].astro:109`, `github/index.ts:834`.

**Recommendation:** Move to shared config constant.

---

### MED-45: Generated SDK Has Hardcoded localhost Base URL

**Severity:** Medium | **Confidence:** Confirmed | **Category:** SEC, CON

**Evidence:** `packages/sdk/js/src/gen/client.gen.ts:20` — defaults to `http://localhost:4096` (insecure HTTP, not HTTPS). If consumers forget to override this, the SDK will make insecure HTTP requests. No runtime warning if the default is used.

**Impact:** Insecure HTTP requests if default baseUrl is used in production.

**Recommendation:** Change default to `https://` or require explicit baseUrl configuration.

---

### MED-46: Generated SDK Has `any` Types in v2 Variant

**Severity:** Medium | **Confidence:** Confirmed | **Category:** FRG

**Evidence:** `packages/sdk/js/src/v2/gen/client/client.gen.ts` — `body?: any` (line 18), `let emptyData: any` (line 134), `let data: any` (line 160).

**Impact:** Type safety bypassed in generated SDK code.

**Recommendation:** Generate proper types from OpenAPI spec.

---

### MED-47: Generated SDK Has `@ts-expect-error` Suppression

**Severity:** Medium | **Confidence:** Confirmed | **Category:** FRG

**Evidence:**
- `packages/sdk/js/src/gen/client/client.gen.ts:67`
- `packages/sdk/js/src/v2/gen/client/client.gen.ts:69`

Generated code uses `@ts-expect-error` that may mask real type errors.

**Recommendation:** Fix root cause of type errors in code generation.

---

### MED-48: Stale Copyright Year "2025" in Lander

**Severity:** Medium | **Confidence:** Confirmed | **Category:** DOC

**Evidence:** `packages/web/src/components/Lander.astro:194` — `<span>&copy;2025 <a href="https://anoma.ly"...>Anomaly Innovations</a></span>`. Current year is 2026.

**Impact:** Outdated copyright notice on marketing site.

**Recommendation:** Update to 2026 or use dynamic year.

---

### MED-49: WebSocket URL Validation Missing in Share Component

**Severity:** Medium | **Confidence:** Confirmed | **Category:** SEC

**Evidence:** `packages/web/src/components/Share.tsx:108-111`:
```ts
const wsBaseUrl = apiUrl.replace(/^https?:\/\//, "wss://")
const wsUrl = `${wsBaseUrl}/share_poll?id=${props.id}`
socket = new WebSocket(wsUrl)
```
Blindly replaces `http`/`https` with `wss://`. If `apiUrl` is already `wss://` or has an unexpected scheme, this produces a malformed URL. No validation of the final URL scheme is done.

**Impact:** Malformed WebSocket URL could cause connection failures or unexpected behavior.

**Recommendation:** Validate final URL scheme before creating WebSocket connection.

---

### MED-50: Unused `solid-js` Dependency in Email Package

**Severity:** Medium | **Confidence:** Confirmed | **Category:** DEP

**Evidence:** `packages/console/mail/package.json:10` — `"solid-js": "catalog:"`. Email templates use React (`@jsx-email/all`), not SolidJS.

**Impact:** Dead dependency increases node_modules weight and confusion.

**Recommendation:** Remove `solid-js` from dependencies.

---

### MED-51: Math.random() for Email Body ID

**Severity:** Medium | **Confidence:** Confirmed | **Category:** FRG

**Evidence:** `packages/console/mail/emails/templates/InviteEmail.tsx:41` — `<Body style={body} id={Math.random().toString()}>`. Using `Math.random()` for an HTML element `id` is non-deterministic and could cause subtle rendering issues. The `id` attribute on `<Body>` serves no clear purpose.

**Impact:** Non-deterministic element IDs. The `id` on `<Body>` is unusual and may cause issues.

**Recommendation:** Remove the `id` attribute or use a deterministic value.

---

### MED-52: 73+ Storybook Files Use `@ts-nocheck`

**Severity:** Medium | **Confidence:** Confirmed | **Category:** FRG

**Evidence:** All `packages/ui/src/components/*.stories.tsx` and `packages/ui/src/v2/components/*.stories.tsx` files (69+ files) all begin with `// @ts-nocheck`. Zero type safety in Storybook stories.

**Impact:** Large surface area with no type checking — regressions in component examples won't be caught.

**Recommendation:** Remove `@ts-nocheck` and fix underlying type issues in story files.

---

### MED-53: Missing Ukrainian Locale Config in Astro

**Severity:** Medium | **Confidence:** Confirmed | **Category:** CON

**Evidence:**
- `packages/web/src/i18n/locales.ts:17` — includes `"uk"` (Ukrainian)
- `packages/web/astro.config.mjs:36-126` — The locales map does NOT include `uk`

Ukrainian is listed as a docs locale but has no Astro locale configuration, potentially causing build issues or broken locale routing.

**Impact:** Ukrainian locale route broken or silently ignored.

**Recommendation:** Add Ukrainian locale configuration to `astro.config.mjs`.

---

### MED-54: CI/CD Inconsistencies — Different Checkout Action SHAs

**Severity:** Medium | **Confidence:** Confirmed | **Category:** CI

**Evidence:**
- `.github/workflows/test.yml:40` — `actions/checkout@34e114876b0b...` (v4.3.1)
- `.github/workflows/deploy.yml:22` — `actions/checkout@f43a0e5ff2bd...` (v3.6.0)
- `.github/workflows/publish.yml:39` — `actions/checkout@f43a0e5ff2bd...` (v3.6.0)

Deploy and publish workflows use an older checkout action (v3.6.0) while test.yml uses v4.3.1.

**Impact:** Inconsistent action versions across workflows, older versions may lack security fixes.

**Recommendation:** Upgrade deploy.yml and publish.yml to v4.3.1.

---

### MED-55: No Test Script in effect-sqlite-node

**Severity:** Medium | **Confidence:** Confirmed | **Category:** TST

**Evidence:** `packages/effect-sqlite-node/package.json` — has no `test` script at all. Only `typecheck`.

**Impact:** Bugs in this package would go undetected.

**Recommendation:** Add a test script or document why tests are not applicable.

---

### MED-56: Hardcoded Beta Peer Dependencies in http-recorder

**Severity:** Medium | **Confidence:** Confirmed | **Category:** DEP

**Evidence:** `packages/http-recorder/package.json` — hardcodes `"@effect/platform-node": "4.0.0-beta.74"` and `"effect": "4.0.0-beta.74"` as peer dependencies.

**Impact:** Will break when effect moves to a new beta or GA without updating this package.

**Recommendation:** Use version ranges or update when effect GA is released.

---

### MED-57: containers Build Script Has Duplicated If/Else Logic

**Severity:** Medium | **Confidence:** Confirmed | **Category:** MAINT

**Evidence:** `packages/containers/script/build.ts:36-76` — Three near-identical blocks for `base`, `bun-node`, and others, each with `if (push)` / `if (!push)` branches. This is 6 nearly identical docker command invocations.

**Impact:** Hard to maintain, easy to introduce inconsistencies when updating one block.

**Recommendation:** Factor into a single function call with parameters.

---

### MED-58: web config.mjs Hardcodes Dev Email

**Severity:** Medium | **Confidence:** Confirmed | **Category:** CON

**Evidence:** `packages/web/config.mjs:6` — `email: "help@anoma.ly"`. Hardcoded email may be stale or incorrect.

**Impact:** Contact email may be wrong or need updating in multiple places.

**Recommendation:** Move to environment variable or shared config constant.

---

### MED-59: typecheck Workflow Missing Concurrency Group

**Severity:** Medium | **Confidence:** Confirmed | **Category:** CI

**Evidence:** `.github/workflows/typecheck.yml` — Unlike `test.yml` and `storybook.yml`, the typecheck workflow has no `concurrency` configuration.

**Impact:** Multiple typecheck runs on rapid pushes can stack up unnecessarily.

**Recommendation:** Add `concurrency` block similar to other workflows.

---

### MED-60: 3 Workspace Globs Match Directories Without package.json

**Severity:** Medium | **Confidence:** Confirmed | **Category:** CON

**Evidence:** The `packages/*` workspace glob matches these directories that lack `package.json`:
1. `packages/docs/` — Mintlify documentation site (no package.json, no tsconfig)
2. `packages/identity/` — Logo/brand images only (no package.json, no tsconfig)
3. `packages/containers/` — Docker build scripts (CRIT-06)

Same defect pattern as CRIT-06 (containers). These directories hit the workspace glob and will trigger Bun workspace resolution warnings or failures.

**Impact:** Bun workspace resolution fails silently or emits warnings during install.

**Recommendation:** Add a `package.json` to each or exclude from the workspace glob via `.gitignore` or workspace config.

---

### MED-61: packages/docs Is Uncustomized Mintlify Template

**Severity:** Medium | **Confidence:** Confirmed | **Category:** DOC

**Evidence:**
- `packages/docs/README.md:1` — Still says **"Mintlify Starter Kit"**
- `packages/docs/docs.json:33-34` — Navbar "Support" button links to `mailto:hi@mintlify.com`
- `packages/docs/docs.json:39-41` — "Dashboard" button links to `https://dashboard.mintlify.com`
- `packages/docs/docs.json:48-51` — Footer social links point to Mintlify's X/GitHub/LinkedIn, not the project's
- `packages/docs/LICENSE:3` — Copyright says "Copyright (c) 2023 Mintlify"

The docs package was generated from the Mintlify starter template and never customized for the opencode project.

**Impact:** Users see Mintlify branding and links instead of project branding. The license is incorrect — it says Mintlify copyright.

**Recommendation:** Replace with project-specific docs, breadcrumb, and license. Update docs.json with the project's own support channels, dashboard URL, and social links.

---

### MED-62: 73 Files Use @ts-nocheck Across the Monorepo

**Severity:** Medium | **Confidence:** Confirmed | **Category:** STD

**Evidence:**

| Package | Count | Files |
|---------|-------|-------|
| `packages/ui/` | 69 | All Storybook stories (.stories.tsx) |
| `packages/console/mail/` | 3 | Email template files |
| `packages/opencode/` | 1 | Unknown |

73 files across the monorepo have `// @ts-nocheck`, disabling all TypeScript type checking. The previous audit only documented the email and console mail packages — it missed the 69 Storybook files.

**Impact:** Zero type safety on 73 files. Component API changes won't surface as type errors in stories, leading to broken examples.

**Recommendation:** Remove `@ts-nocheck` from story files and fix underlying type issues. Configure per-directory linting to prevent adding new `@ts-nocheck` files.

---

### MED-63: Large Binary Test Fixtures Bloat Clone

**Severity:** Medium | **Confidence:** Confirmed | **Category:** PERF

**Evidence:**
- `packages/opencode/test/image/fixtures/picture-5mb-base64.png` — **3.8 MB**
- `packages/opencode/test/tool/fixtures/large-image.png` — **2.6 MB**
- `packages/opencode/test/tool/fixtures/models-api.json` — **3.0 MB**

These large test fixtures are tracked directly in git. The 5MB-base64 PNG is particularly wasteful — it's a PNG that contains base64-encoded data, making it larger than necessary. The models-api.json at 3MB is also very large for a JSON fixture.

**Impact:** Bloated clone size (9.4MB for these 3 fixtures alone). No Git LFS configured for test fixtures. Harder to review in PRs.

**Recommendation:** Generate fixtures on-the-fly in tests, compress PNGs, or use Git LFS for large test artifacts.

---

## 🟢 LOW

### LOW-01: One-Line Package Entrypoint Fragility

`packages/tui/src/index.tsx:1` — single re-export.

---

### LOW-02: Long Import Lines Exceeding printWidth

Multiple files with import blocks spanning 5+ lines.

---

### LOW-03: V2 Feature Backlog

Roadmap items from `specs/v2/todo.md`. Not code defects.

---

### LOW-04: console.log in Production Code (Non-CLI)

- slack: 15x including config state leak
- function: 7x including full request body logging (PII risk)
- console/app stripe webhook: logs PII-possible data
- console/function: 8x debug logging

---

### LOW-05: console.log in GitHub Actions Workflow (50+ instances)

`github/index.ts` — noisy ANSI-colored output in log files.

---

### LOW-06: process.exit() Usage (14+ instances)

Abrupt termination without cleanup across `packages/opencode/src/{index.ts,cli/cmd/*}`.

---

### LOW-07: while(true) Loops Without Safeguards (12+ instances)

Filesystem traversal, session processing, streaming loops all depend on proper abort signaling.

---

### LOW-08: process.kill(-pid) Kills Process Groups

`packages/opencode/src/shell/shell.ts:45,48` and `src/mcp/index.ts:482`.

---

### LOW-09: @ts-ignore / @ts-expect-error Suppressions (14+ total)

Mix of fragile `@ts-ignore` and better `@ts-expect-error`.

---

### LOW-10: `[key: string]: any` in Plugin SDK Metadata

`packages/plugin/src/tool.ts:18,26,41`.

---

### LOW-11: Buffer.from/Buffer.allocUnsafe (Node-specific APIs)

`packages/http-recorder/src/{socket,websocket}.ts` and `desktop/src/main/attachment-picker.ts`.

---

### LOW-12: Number.parseInt(checksum, 36)

`packages/core/src/tool/websearch.ts:90` — non-standard radix may produce unexpected results.

---

### LOW-13: async (req: any): Promise<any> in SDK Custom Fetch

Both SDK client versions fully type-erase the fetch wrapper.

---

### LOW-14: Storybook Playground CSS Plugin — Unvalidated File Writes

`packages/storybook/.storyboard/playground-css-plugin.ts:96-127` — dev-only, but no auth.

---

### LOW-15: Schema.Any in 29 Places Disabling Runtime Validation

`packages/core/src/` — tool output, provider options, permission rulesets.

---

### LOW-16: Enterprise Share Secret Comparison Not Constant-Time

`packages/enterprise/src/core/share.ts:137,158,176` — uses `!==` instead of `timingSafeEqual`.

---

### LOW-17: Hardcoded Model Names in honeycomb-backfill.ts

`packages/stats/core/src/honeycomb-backfill.ts:25-28` — `FREE_MODELS = new Set(["gpt-5-nano", "grok-code", "big-pickle"])`.

---

### LOW-18: env Property Access Without Guard in VSCode Extension

`sdks/vscode/src/extension.ts:36-37` — `@ts-ignore` on `terminal.creationOptions.env`.

---

### LOW-19: Unused Import for http Module in Desktop

`packages/desktop/src/main/index.ts:3` — `import * as http from "node:http"` used only once via `(http as any)`.

---

### LOW-20: package.json Included in tsconfig `include`

`packages/{app,desktop}/tsconfig.json` include `"package.json"` in compilation.

---

### LOW-21: No Shebang Consistency in script/ Files

Some scripts have `#!/usr/bin/env bun`, others don't.

---

### LOW-22: Self-Referencing Namespace in effect-sqlite-node package.json

`packages/effect-sqlite-node/package.json` — ns shorthand referencing own package name.

---

### LOW-23: No `version` Field in 2 Packages

`packages/script/package.json` and `packages/console/resource/package.json` missing version.

---

### LOW-24: `main` + `exports` Redundant in stats/server

`packages/stats/server/package.json` has both `main` and `exports` pointing to same file.

---

### LOW-25: Env Var Validation via Non-null Assertions

`infra/console.ts:275-276` — `process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID!` non-null assertions.

---

### LOW-26: `@ts-ignore` in Composite Action Setup-Git-Committer

`.github/actions/setup-git-committer/action.yml:42` — token injection via git remote URL.

---

### LOW-27: Clipboard Error Silently Swallowed in Lander

**Severity:** Low | **Confidence:** Confirmed | **Category:** ERR

**Evidence:** `packages/web/src/components/Lander.astro:714` — `navigator.clipboard.writeText(button.dataset.command!)` — No `.catch()` on clipboard write. Will throw unhandled rejection if clipboard permission is denied.

**Impact:** Unhandled promise rejection in browser console if clipboard permission denied.

**Recommendation:** Add `.catch()` handler like `copy-button.tsx` and `common.tsx` do.

---

### LOW-28: Dead Test Code in ContentCode Component

**Severity:** Low | **Confidence:** Confirmed | **Category:** MAINT

**Evidence:** `packages/web/src/components/share/content-code.tsx:14-15`:
```ts
// TODO: For testing delays
// await new Promise((resolve) => setTimeout(resolve, 3000))
```
Dead test code left in production component.

**Impact:** Code clutter, confusing for developers.

**Recommendation:** Remove commented-out test code.

---

### LOW-29: Array Access Without Bounds Check in Share Page

**Severity:** Low | **Confidence:** Confirmed | **Category:** ERR

**Evidence:** `packages/web/src/pages/s/[id].astro:102-107` — When `modelsArray.length === 0`, the fallback branch executes `${modelsArray[0]} & ${modelsArray.length - 1} others` which becomes `"undefined & -1 others"`.

**Impact:** Renders "undefined & -1 others" for sessions with no models.

**Recommendation:** Add guard for empty modelsArray.

---

### LOW-30: Missing READMEs for Several Packages

**Severity:** Low | **Confidence:** Confirmed | **Category:** DOC

**Evidence:** The following packages have no README.md:
- `packages/cli/`
- `packages/tui/`
- `packages/ui/`
- `packages/storybook/`
- `packages/script/`
- `packages/function/`
- `packages/core/` (has src READMEs but no package-level README)

**Impact:** New developers have no documentation for package purpose and usage.

**Recommendation:** Add README.md files for each package.

---

### LOW-31: Missing CHANGELOG

**Severity:** Low | **Confidence:** Confirmed | **Category:** DOC

**Evidence:** No root `CHANGELOG.md` file. While some packages reference `CHANGELOG.md` in their `files` array (like http-recorder), the file may not exist at build time.

**Impact:** No release history documentation.

**Recommendation:** Add root CHANGELOG.md or document release process.

---

### LOW-32: containers/README.md Build Instructions May Be Stale

**Severity:** Low | **Confidence:** Confirmed | **Category:** DOC

**Evidence:** `packages/containers/README.md:18` — Build script extracts bun version from root `package.json`'s `packageManager` field. If that field changes, the documentation example could become misleading.

**Impact:** Build instructions may become outdated.

**Recommendation:** Verify instructions match current build process.

---

### LOW-33: web configSchema Uses spawnSync (Blocking)

**Severity:** Low | **Confidence:** Confirmed | **Category:** BUILD

**Evidence:** `packages/web/astro.config.mjs:319` — `spawnSync("../opencode/script/schema.ts", ["./dist/config.json", "./dist/tui.json"])`. Runs synchronously during `astro:build:done`. The return code is never checked.

**Impact:** Build fails silently if schema generation fails.

**Recommendation:** Check spawnSync return code for errors.

---

### LOW-34: Share Component Has Dual onMount Calls

**Severity:** Low | **Confidence:** Confirmed | **Category:** MAINT

**Evidence:** `packages/web/src/components/Share.tsx:81,209` — Two separate `onMount()` calls in the same component. While SolidJS supports multiple onMount hooks, having them in the same component without clear separation is fragile.

**Impact:** Error context lost if either onMount throws.

**Recommendation:** Consolidate into single onMount or separate into child components.

---

### LOW-35: Share Component Error Message Misleading

**Severity:** Low | **Confidence:** Confirmed | **Category:** DOC

**Evidence:** `packages/web/src/components/Share.tsx:89` — Error message says "API URL not found in environment variables" but `apiUrl` comes from props, not environment variables directly.

**Impact:** Misleading error message for debugging.

**Recommendation:** Update error message to reflect actual source.

---

### LOW-36: close-issues.yml Uses Third-Party Setup-Bun Action

**Severity:** Low | **Confidence:** Confirmed | **Category:** CI

**Evidence:** `.github/workflows/close-issues.yml:17` — Uses `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6` instead of `./.github/actions/setup-bun` like other workflows.

**Impact:** Inconsistent setup could cause version drift.

**Recommendation:** Use consistent setup-bun action across all workflows.

---

### LOW-37: review.yml Installs opencode via curl pipe to bash

**Severity:** Low | **Confidence:** Confirmed | **Category:** SEC

**Evidence:** `.github/workflows/review.yml:35` — `curl -fsSL https://opencode.ai/install | bash`. Unversioned installation could break workflow without notice.

**Impact:** Workflow could break if install script changes.

**Recommendation:** Pin to specific version or use a versioned action.

---

### LOW-38: Email Template Components Use Undefined Type Props

**Severity:** Low | **Confidence:** Confirmed | **Category:** FRG

**Evidence:** `packages/console/mail/emails/components.tsx` references `TitleProps`, `AProps`, `SpanProps`, `WbrProps` that are never defined — these are implicit `any`.

**Impact:** Zero type checking on email component props.

**Recommendation:** Define proper prop types.

---

### LOW-39: 31 Generated sst-env.d.ts Files Tracked Without Final Newlines

**Severity:** Low | **Confidence:** Confirmed | **Category:** STD

**Evidence:** 31 `sst-env.d.ts` files across the monorepo and root lack trailing newlines. Generated by SST framework. Files found in every package directory plus root and `github/`.

**Impact:** Minor style inconsistency. Prettier/editorconfig may flag these.

**Recommendation:** Add a post-generation step that ensures trailing newlines, or configure SST to emit them.

---

### LOW-40: github/package.json Uses `typescript: ^5` Instead of Catalog

**Severity:** Low | **Confidence:** Confirmed | **Category:** DEP

**Evidence:** `github/package.json:11` — `"peerDependencies": { "typescript": "^5" }`. The rest of the monorepo uses `"typescript": "catalog:"` resolving to `5.8.2`.

**Impact:** Minor inconsistency. The GitHub action package may get a different TypeScript version than the rest of the workspace.

**Recommendation:** Change to `"typescript": "catalog:"`.

---

### LOW-41: Duplicate Brand Assets ZIP Files in Console App (Different Hashes)

**Severity:** Low | **Confidence:** Confirmed | **Category:** MAINT

**Evidence:**
- `packages/console/app/public/opencode-brand-assets.zip` — SHA256: `776374C5...`
- `packages/console/app/src/asset/brand/opencode-brand-assets.zip` — SHA256: `77029234...`

Two copies of brand assets ZIP with different hashes. One is in `public/` (served as static asset), the other is in `src/asset/` (build import). They are NOT identical files.

**Impact:** Confusion about which is canonical. Extra weight in the repo.

**Recommendation:** Consolidate to a single location. Use a symlink or build-time copy.

---

### LOW-42: packages/docs Has Mintlify License Instead of Project License

**Severity:** Low | **Confidence:** Confirmed | **Category:** DOC, LEGAL

**Evidence:** `packages/docs/LICENSE:3` — Copyright line reads `Copyright (c) 2023 Mintlify` instead of the project's own copyright.

**Impact:** Incorrect copyright attribution included in the repository. Could cause confusion about licensing terms.

**Recommendation:** Replace with the project's standard LICENSE file or remove the duplicate license.

---

## ℹ️ INFORMATIONAL

### INFO-01: Clean Dependency Graph — No Circular Dependencies

The cross-package dependency graph is a clean DAG. No cycles detected in either declared workspace deps or source imports.

### INFO-02: Strong Layering Preserved

Leaf packages (sdk, llm, script, effect-*, http-recorder, function) have zero internal dependents. Core is a hub. No package imports from anything that depends on it.

### INFO-03: No Unused Imports in Core, LLM, or Server

Systematic check found all imports used in these packages.

### INFO-04: V2 Session Core Architecture Is Clean

The session runner, store, and execution patterns follow the spec correctly. No architectural defects found in the V2 session layer.

---

## 📊 Summary

| Severity | Count | Key Areas |
|----------|-------|-----------|
| **Critical** | 6 | Spec violations, timing attacks, hardcoded infra IDs, workspace resolution |
| **High** | 16 | Empty catches, missing timeouts, race conditions, code eval, TS version drift, duplicate deps, as any casts, no-check, CI security, lost messages, XSS risk, fetch error handling, supply-chain risk, Nix build typo, 26MB MP4 files without LFS |
| **Medium** | 63 | Any types, CSS fragmentation, throw-in-effect, self-XSS, CSP, catalog drift, tsconfig inconsistencies, IPC validation, R2 defaults, flake.nix mismatch, generated SDK issues, locale config, CI inconsistencies, test gaps, email template issues, Storybook type safety, workspace glob orphans, uncustomized Mintlify template, 73 ts-nocheck files, large binary test fixtures |
| **Low** | 42 | console.log, process.exit, while(true), process.kill, @ts-ignore, Buffer API, Schema.Any, timing in enterprise, env guards, clipboard errors, dead code, array bounds, missing docs, build issues, component organization, 31 sst-env.d.ts missing newlines, github/ peer dep inconsistency, duplicate brand ZIPs, Mintlify license |
| **Info** | 4 | Clean dep graph, strong layering, no unused imports, clean V2 architecture |
| **Total** | **131** | |

### Top 10 Actions (by impact + effort)

1. **CRIT-03** — Fix `===` password comparison → timingSafeEqual (2 files, low effort)
2. **HIGH-15** — Fix Nix build typo: `node-modules.nix` → `node_modules.nix` (1 character fix, high impact)
3. **HIGH-01** — Add error logging to empty catch blocks (~65 instances, ~4 hours)
4. **HIGH-03** — Add timeouts to LLM provider requests (3 files, low effort)
5. **HIGH-04** — Fix race condition in approvedToolsForSession Set (1 file, low effort)
6. **CRIT-01** — Remove TUI core dependency (8 files, medium effort)
7. **HIGH-07** — Deduplicate 19 @ai-sdk/* provider deps from opencode (1 file, low effort)
8. **HIGH-16** — Remove or LFS-track 26MB MP4 files (2 files, low effort)
9. **HIGH-06** — Upgrade desktop TypeScript to catalog (1 change, verify typecheck)
10. **MED-16** — Add permissions: block to 6 workflow files (6 files, trivial)
