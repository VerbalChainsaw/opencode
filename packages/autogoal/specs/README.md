# AutoGoal specifications

This directory is the **canonical, authoritative** home of AutoGoal
specifications. Specs previously lived in a sibling repository
(`../OpenGoal/specs/`) that was retired on 2026-06-22. The four files
below are byte-identical copies of the originals, verified by SHA-256 at
migration time.

## What lives here

| File | Purpose |
|------|---------|
| `cli-hardening-work-order.md` | CLI/budget hardening work order. |
| `desktop-ui-design.md` | GUI feature work orders for the Desktop GoalPanel. |
| `v0.4.0-roadmap.md` | Phase 1–4 planning (chains, verification, webhooks, templates). |
| `v0.5.0-feature-work-orders.md` | Feature work orders including F-1 (`--json`), F-2 (`doctor`), F-3 (archive), F-4 (`watch`). |

## What lives elsewhere (still in this monorepo)

- AutoGoal implementation: `packages/autogoal/src/`
- AutoGoal tests: `packages/autogoal/test/`
- AutoGoal design notes: `packages/autogoal/docs/`
- AutoGoal package AGENTS.md: `packages/autogoal/AGENTS.md`
- Monorepo root AGENTS.md (includes the AutoGoal authority rule): `../../AGENTS.md`

## What does NOT exist

There is no dual-repo mirroring. The former sibling repository at
`C:\Users\zerop\Development\OpenGoal` was retired on 2026-06-22 and the
path must not be recreated, cloned, edited, tested, or committed to.
A read-only historical bundle exists at
`C:\Users\zerop\Archives\Retired-Repositories\OpenGoal-legacy-2026-06-22\OpenGoal-complete.bundle`
for inspection only — it is **not** an active development repository.

Other `specs/` directories in this monorepo (e.g. `../../specs/` and
`../opencode/specs/`) are unrelated to AutoGoal and must not be cited as
AutoGoal spec sources. When referencing a spec in a commit, use the
path relative to the autogoal package root, e.g.
`specs/v0.5.0-feature-work-orders.md §F-1`.