# AGENTS.md — OpenCode Desktop & Mission Control

Codex / Claude Code session-load file. Loaded at session start.
Covers the monorepo surface: this repo (GUI + AutoGoal plugin + Desktop shell).
Current as of 2026-06-22. Sources cited inline.

---

## AutoGoal repository authority

**The sole authoritative AutoGoal implementation lives in this monorepo.**

| Resource | Location |
|----------|----------|
| AutoGoal source | `packages/autogoal/src/` |
| AutoGoal tests | `packages/autogoal/test/` |
| AutoGoal specifications | `packages/autogoal/specs/` |
| AutoGoal docs / design notes | `packages/autogoal/docs/` |
| AutoGoal entry AGENTS.md | `packages/autogoal/AGENTS.md` |

The former sibling repository `../OpenGoal` was retired on 2026-06-22. It
must not be recreated, cloned, edited, tested, committed to, or used as a
task working directory. Any text in chat, scratchpads, or handoffs that
references it is stale. Verify repo identity before AutoGoal work:

```bash
git rev-parse --show-toplevel
# Must print: <something>/opencode-source
test -d packages/autogoal/src && test -d packages/autogoal/test && test -d packages/autogoal/specs
```

If either check fails, abort. Do not proceed under the assumption that the
legacy sibling can be re-created or substituted.

---

## Package layout

| Concern | Path |
|---------|------|
| Role | Desktop app UI (SolidJS + Electron) + AutoGoal plugin + HTTP bridge |
| Branch | `dev` |
| Test runner | `bun test --preload ./happydom.ts` (app/desktop), `node --test test/*.test.mjs` (autogoal) |
| Typecheck | `bun run typecheck` (tsgo -b), `npx tsc -p tsconfig.json` (autogoal) |
| Package dirs | `packages/app`, `packages/autogoal`, `packages/desktop`, `packages/opencode`, `packages/ui`, `packages/core` |
| Key deps | `@opencode-ai/sdk` (1.17.6), `@opencode-ai/plugin`, SolidJS, Kobalte, Electron |

The plugin defines the DATA; this app DRAWS the data.

---

## Spec Surface (read before any non-trivial work)

In `packages/autogoal/specs/` (canonical, this repo only):
- `desktop-ui-design.md` — GUI feature work orders (426 lines)
- `v0.4.0-roadmap.md` — Phase planning (635 lines)
- `v0.5.0-feature-work-orders.md` — Feature specs (301 lines)
- `cli-hardening-work-order.md` — CLI/budget hardening (326 lines)
- `README.md` — directory purpose and retirement notice

In `packages/autogoal/docs/` (design notes, secondary):
- `SPEC.md` — reconstructed product requirements and acceptance matrix
- `TRACEABILITY.md` — requirement-to-test/source traceability
- `gui-integration.md` — Desktop GUI integration contract for AutoGoal state and controls
- `FEATURE-BACKLOG.md` — secondary backlog and deferred work notes

Other `specs/` directories in this monorepo (e.g. `specs/`, `packages/opencode/specs/`) are unrelated to AutoGoal. Cite the AutoGoal-specific spec by its relative path from the package root (e.g. `specs/v0.5.0-feature-work-orders.md §F-1`).

**Rule:** Read the relevant spec file fully before writing code. The spec wins over chat instructions.
If the spec and the user's words conflict, surface the conflict before coding.

---

## Commands (exact invocations)

### This repo (opencode-source)

```bash
# App typecheck
cd packages/app && bun run typecheck

# App tests (must preload happydom for DOM-dependent components)
cd packages/app && bun test --preload ./happydom.ts

# Run specific test file
cd packages/app && bun test --preload ./happydom.ts src/pages/session/goal-panel-pure.test.ts

# Desktop typecheck
cd packages/desktop && bun run typecheck

# Desktop build
cd packages/desktop && bun run build

# Start Electron desktop app (what "start the tool" means)
cd packages/desktop && bun dev

# NOT the web dev server — user wants Electron, not the webserver
# cd packages/app && bun dev -- --port 4444  ← only for web-only debugging
```

### Sibling repo (OpenGoal)

The sibling repository was retired on 2026-06-22. The commands below are
intentionally NOT provided — they were removed because invoking them
recreates or references the legacy checkout, which is forbidden. All
AutoGoal work runs in `packages/autogoal/` against this monorepo.

### OpenCode SDK (used by this repo)

```bash
npm install @opencode-ai/sdk   # v1.17.6 current
```

```ts
// Quickstart — programmatic session control
import { createOpencode } from "@opencode-ai/sdk"
const { client, server } = await createOpencode()
const session = await client.session.create({ body: { title: "...", agent: "build" } })
await client.session.prompt({ path: { id: session.data.id }, body: { parts: [{ type: "text", text: "..." }] } })
await server.close()
```

Docs: https://opencode.ai/docs/sdk/ | npm: https://www.npmjs.com/package/@opencode-ai/sdk | GitHub: https://github.com/anomalyco/opencode-sdk-js

---

## Mission Control GUI — What We're Building

**Visual language:** steel-and-signal, dark theme, operator-console accents.
**Product surfaces:** Global Ops Board (home page) → conversation-first work surface (session) → Dual-Band Dock (right sidebar).

### Key files (this repo)

| Surface | File |
|---------|------|
| Home page / Global Ops Board | `packages/app/src/pages/home.tsx` |
| Session shell + resize | `packages/app/src/pages/session.tsx` |
| Goal dock / Dual-Band Dock | `packages/app/src/pages/session/goal-panel.tsx` |
| Goal panel pure logic (testable) | `packages/app/src/pages/session/goal-panel-pure.ts` |
| Goal panel lifecycle | `packages/app/src/pages/session/goal-panel-lifecycle.ts` |
| Session header (goal toggle) | `packages/app/src/components/session/session-header.tsx` |
| New Session draft page | `packages/app/src/pages/new-session.tsx` |
| Theme system | `packages/ui/src/theme/context.tsx` |
| Theme tokens (oc-2) | `packages/ui/src/theme/themes/oc-2.json` |
| Tailwind color tokens | `packages/ui/src/styles/tailwind/colors.css` |
| Standard `<Dialog>` component | `packages/ui/src/dialog.tsx` |
| Dialog context (global stack) | `packages/ui/src/context/dialog.tsx` |
| Desktop renderer entry | `packages/desktop/src/renderer/index.tsx` |
| Titlebar / session tabs | `packages/app/src/components/titlebar.tsx` |
| i18n strings (English source) | `packages/app/src/i18n/en.ts` |
| i18n (zh / zht) | `packages/app/src/i18n/zh.ts`, `zht.ts` |

### Key files (AutoGoal package)

| Concern | File |
|---------|------|
| Goal state + budget enforcement | `packages/autogoal/src/goal-state.ts` |
| Server plugin (auto-loop) | `packages/autogoal/src/server.ts` |
| RenderBlock types + factories | `packages/autogoal/src/blocks/goal-blocks.ts` |
| Goal chain (sub-goals) | `packages/autogoal/src/goal-chain.ts` |
| Goal templates | `packages/autogoal/src/templates.ts` |
| GUI integration contract | `packages/autogoal/docs/gui-integration.md` |

---

## SolidJS Gotchas (these bite)

1. **TDZ: `createMemo` referencing a `const` defined later.** Reorder — define dependency before consumer.
2. **`<Show when={accessor}>` without `()`** — always truthy. Fix: `<Show when={accessor()}>`.
3. **Barrel imports crash Vite `lazy()` imports.** Import leaf modules directly, never through barrels.
4. **`!` non-null assertion on signals in event handlers** — signal value can change between render and click. Guard inside handler: `const val = signal(); if (!val) return`.
5. **Vite HMR can keep stale component instances** with prop values that no longer exist in the updated code (e.g., removed enum/union keys). Add defensive fallbacks for enum-keyed style/object lookups to avoid white-screen crashes.
6. **`createStore` preferred over multiple `createSignal` calls.**
7. **Prefer `const` over `let`. Avoid `else` — use early returns. Never alias imports. Never star imports.**

Full style guide: see § Style Guide below.

---

## Theme Rules

- **Default is dark.** `ThemeProvider` receives `defaultColorScheme="dark"` in `app.tsx`.
- **Token classes format:** `v2-{category}-{token-name}` — e.g., `v2-background-bg-layer-01`, `v2-border-border-muted`, `text-v2-text-text-base`.
- **Modal scrim token:** `v2-overlay-simple-overlay-scrim` (NOT `v2-background-overlay` — that token doesn't exist).
- **Verify tokens exist** before using: `grep -r "v2-<name>" packages/ui/src/styles/tailwind/colors.css`.
- **Shadow token:** `shadow-[var(--v2-elevation-overlay)]` for modal panels.

---

## Dialogs: Use the Standard `<Dialog>`, Not Hand-Rolled

The shared `<Dialog>` (`packages/ui/src/dialog.tsx`) handles focus trap, Esc, click-outside, ARIA, scroll lock.
Use via `dialog.show(() => <Dialog>...body...</Dialog>)`. Do NOT build new `fixed inset-0 z-50` overlays.

Pattern:
```tsx
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"

function openMyDialog() {
  const snapshot = data()  // snapshot at click time
  dialog.show(() => (
    <Dialog title="My Dialog">
      <MyDialogBody data={snapshot} onSelect={(item) => { doThing(item); dialog.close() }} />
    </Dialog>
  ))
}
```

---

## i18n: Never Hardcode English in JSX

All user-facing strings go through `language.t("dotted.key")`. Source of truth: `packages/app/src/i18n/en.ts`.
Every key added to `en.ts` MUST also be added to `zh.ts` and `zht.ts`.

---

## Testing: Behavior Tests, Not String-Match

- **Test real functions**, not file contents. `await import("./goal-panel-pure")` then call the function and assert return values.
- **String-match tests** (`Bun.file(...).text(); expect(src).toContain("string")`) have near-zero value. Migrate them to behavioral tests.
- **Extract pure logic to `<name>-pure.ts`** when the TSX crashes in test (Kobalte SSR, Electron imports).
- **Use `await import()` inside test bodies** for modules with side effects.

---

## What NOT to Do

- **Do NOT build standalone terminal TUIs for "GUI" requests.** The deliverable is `RenderBlock[]` payloads + app-side rendering, not `src/control-center.ts`.
- **Do NOT use `v2-background-overlay`** — it doesn't exist. Use `v2-overlay-simple-overlay-scrim`.
- **Do NOT add new `state.openDialog` enums.** Use the standard `dialog.show()` API.
- **Do NOT use `!` non-null assertions on signals in handlers.**
- **Do NOT import from barrels** (`@/components/session`) in lazily-loaded routes.
- **Do NOT hardcode English strings in JSX.** Route through `language.t()`.
- **Do NOT run `bun dev` from `packages/app` when the user says "start the tool"** — they mean the Electron desktop (`packages/desktop && bun dev`).
- **Do NOT run `tsc` directly** — use `bun run typecheck`.
- **Do NOT run tests from repo root** — run from the package directory.

---

## Definition of Done

A task is complete when ALL pass:
1. `bun run typecheck` exits 0 (from the changed package dir)
2. `bun test --preload ./happydom.ts` exits 0 (app) or `bun test src/...` exits 0 (desktop)
3. If plugin code changed: `cd packages/autogoal && npm test` exits 0
4. Changed files staged, commit message follows `type(scope): summary` format
5. No new hardcoded English strings in JSX (grep check)
6. No new `!` non-null assertions on signals (grep check)
7. For visual changes: confirmed in the Electron window, not just browser

---

## When Blocked (Escalation)

- Tests fail after 3 fix attempts: **stop** and report the failing test with full output. Do not delete tests.
- Dependency missing: check `package.json` first, then ask. Do not install globally.
- Merge conflicts: **stop** and show conflicting files. Do not force-resolve.
- Unsure which surface: re-read the spec. Still unsure: ask with spec file + line references.
- **Never:** delete files to resolve errors, force push, skip tests, or bypass the pre-commit hook.

---

## Branch Names & Commits

- Branch names: ≤3 words, hyphens. No slashes, no type prefixes. Examples: `goal-dock-resize`, `fix-scroll-state`.
- Commits: `type(scope): summary` — types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Default branch is `dev`. Local `main` may not exist; use `dev` or `origin/dev`.

---

## Director Gabriel's launch preference

When Director Gabriel says "start the tool" or "run the app," he means:

```bash
bun dev
```

from `packages/desktop` (electron-vite), **NEVER** from `packages/app`
(Vite web). Getting this wrong causes significant frustration — "I want
the desktop app, not the god damn webserver!" Verify which process is
being started before assuming.

*(Migrated from `C:\hermes\memories\USER.md` on 2026-06-18.)*

---

## Style Guide (preserved from existing conventions)

- Keep things in one function unless composable or reusable.
- Do not extract single-use helpers preemptively. Inline at call site.
- Avoid `try`/`catch` where possible. Avoid `any`. Prefer `const` over `let`.
- Use Bun APIs when possible (`Bun.file()`).
- Rely on type inference; avoid explicit annotations unless for exports.
- Prefer functional array methods (`flatMap`, `filter`, `map`).
- Avoid unnecessary destructuring — use dot notation to preserve context.
- Never alias imports. Never star imports.
- Avoid `else` — use early returns.
- Drizzle schemas: use snake_case field names.
- Avoid mocks as much as possible. Test actual implementation.

---

## Sources

- OpenCode SDK docs: https://opencode.ai/docs/sdk/ (updated 2026-06-15, SDK v1.17.6)
- Claude Code best practices: https://code.claude.com/docs/en/best-practices
- AGENTS.md patterns (Blake Crosley): https://blakecrosley.com/blog/agents-md-patterns ("operational policy, not documentation")
- Claude Code memory/CLAUDE.md: https://code.claude.com/docs/en/memory
- npm: https://www.npmjs.com/package/@opencode-ai/sdk
- GitHub SDK: https://github.com/anomalyco/opencode-sdk-js
