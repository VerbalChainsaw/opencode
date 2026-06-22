# AGENTS.md — AutoGoal package

Per-package session-load file. Read after the monorepo root
`AGENTS.md`. Covers the AutoGoal plugin, CLI, and TUI inside
`packages/autogoal/`.

## Authority

This package is the **sole authoritative AutoGoal implementation**. The
former sibling repository `../OpenGoal` was retired on 2026-06-22. Do not
recreate it, do not work in it, do not commit to it, do not point new
code at it.

For every AutoGoal work session:

```bash
# Confirm you are inside the canonical monorepo
git rev-parse --show-toplevel
# Must print a path ending in /opencode-source

# Confirm the AutoGoal package is present
test -d packages/autogoal/src \
  && test -d packages/autogoal/test \
  && test -d packages/autogoal/specs
```

A helper script, `scripts/assert-autogoal-repo.sh`, wraps these checks and
is wired into the repo identity pipeline. Prefer running it over re-typing
the checks by hand.

## Package layout

| Path | Purpose |
|------|---------|
| `src/` | TypeScript source (server plugin, CLI, TUI, GUI adapter, blocks). |
| `test/` | `node --test` regression suite. All tests must remain green. |
| `specs/` | Authoritative AutoGoal specifications. Read before non-trivial work. |
| `docs/` | Design notes and architecture context. Secondary to `specs/`. |
| `dist/` | `tsc` build output. Tests import from here; rebuild after source edits. |
| `package.json` | Test command: `npm test` (typecheck → build → `node --test`). |

## Commands (exact invocations)

From `packages/autogoal/`:

```bash
# Full pipeline (typecheck + build + node --test)
npm test

# Typecheck only
npx tsc -p tsconfig.json

# Build only
npm run build

# Focused test file
node --test test/cli.test.mjs

# Protected parity tests (must stay green)
node --test test/dispatcher-parity.test.mjs
node --test test/control-state-bridge.test.mjs
node --test test/v042-corrupt-surfacing.test.mjs
```

From the monorepo root:

```bash
# App typecheck
cd packages/app && bun run typecheck

# App tests
cd packages/app && bun test --preload ./happydom.ts

# Desktop typecheck + build
cd packages/desktop && bun run typecheck
cd packages/desktop && bun run build
```

## Spec citation convention

When a commit touches `src/**/*` or `test/**/*`, the commit message must
cite the relevant `specs/<file>.md` section, e.g.:

```
fix(autogoal): preserve stepMarkerAt through handoff (specs/v0.5.0-feature-work-orders.md §F-1)
```

Trivial commits (typo fixes, log tweaks) that genuinely do not touch a
spec may use the `[no-spec]` tag.

## Protected tests

These tests pin load-bearing contracts. Do not edit them, weaken them, or
delete them to make a gate pass:

- `test/dispatcher-parity.test.mjs` — CLI/bridge equivalence contract.
- `test/control-state-bridge.test.mjs` — control-state ↔ bridge round-trip.
- `test/v042-corrupt-surfacing.test.mjs` — atomic-write pattern.

If a fix appears to require modifying one of these, stop and surface the
conflict. The contract is more important than the fix.

## Spec ↔ impl drift discipline

Before any non-trivial work:

1. `ls specs/` — see the spec surface.
2. Read the spec file(s) in full.
3. Write a one-line "Spec reconciliation" entry in the active scratchpad
   naming the user's words, the spec file:line, and the chosen surface.
4. Re-read the spec section after writing the reconciliation.

The spec wins. The user's words in chat are a requirement; the spec is
the architecture. When they conflict, surface the conflict before coding.

## Hard-stop checklist before claiming done

1. `npm test` in `packages/autogoal/` exits 0.
2. Protected parity tests pass.
3. Bridge gate passes (`packages/opencode` `bun test` for the
   `goal-control-state` suite, if the bridge shape changed).
4. `git diff --check` clean.
5. Commit message cites `specs/<file>.md §N.M` (or `[no-spec]` if
   genuinely appropriate).
6. No edits to `test/dispatcher-parity.test.mjs`,
   `test/control-state-bridge.test.mjs`, or
   `test/v042-corrupt-surfacing.test.mjs`.