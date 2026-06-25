# AutoGoal Repair Program — Live Status & Next Packet

> **Consolidation page.** This is the single document to look at when you
> feel like the program has fragmented. The full 9-step program lives in
> [`integrated-repair-plan-2026-06-24.md`](./integrated-repair-plan-2026-06-24.md);
> the ticket file is at `~/Downloads/autogoal-production-repair-tickets.md`;
> per-step proof packets are in `.hermes/handoffs/step-N-*.md`. This page
> only carries live state, dependency order, and the next concrete action.

**Last refreshed:** 2026-06-25 (WPG-style accounting pass; refresh after every commit)
**Branch:** `dev`
**Remote:** 3 commits ahead of `origin/dev` (not yet pushed)

---

## Live Status

| # | Ticket | State | Commit | Test status | Notes |
|---|--------|-------|--------|-------------|-------|
| 1 | **P4-C0** IPC silent drop (audit fix) | ✅ **DONE** | `ced246cac` | green | Handoff: `step-1-p4-ipc-silent-drop.md` |
| 2 | **P3-C0** corrupt goal state (audit fix) | ✅ **DONE** | `6a8a8fa71` | green | Predates this program |
| 3 | **AG-P0-01** rapid two-step regression test | ✅ **GREEN** | `4ebcf1c30` | green (after AG-P0-03) | Was intentionally-red pin; AG-P0-03 turned it green |
| 4 | **AG-P0-02** v2 assistant-message contract | ✅ **DONE** | `9e9db7a7f` | green (10/10) | Diff + test on disk, sound |
| 5 | **AG-P0-03** event-identity dedup | ✅ **DONE** | `2ad60df60` | green (1278/1278) | The actual fix; AG-P0-01 now passes |
| 6 | **AG-P0-04** chain draft provenance | ✅ **DONE** | `d6033a3b9` | green (657 pass, 12 pre-existing failures unrelated) | `ChainDraftSource` + selector with source param |
| 7 | **AG-P1-05** separate draft/live/terminal actions | ✅ **DONE** | `b22ba7f84` | green (665 pass, 12 pre-existing failures unrelated) | `chainStepVisibleAction` selector; X-button routes by visible source |
| 8 | **AG-P1-06** unify continuation delivery | 🟠 **PART 1 DONE** | `d9844d806` | green (1291/1291) | Decision function `decideContinuationRetry` shipped + 13 tests; dispatcher wrapper is a follow-up |
| 9 | **AG-P1-07** ordered chain refresh commits | ⬜ not started | — | — | `goal-panel.tsx` |
| 10 | **AG-P1-08** release smoke gate | ⬜ not started | — | — | Final |

### Working tree right now

```
$ git status --short
 M packages/autogoal/src/server.ts                                    ← AG-P0-02 (uncommitted)
?? packages/autogoal/test/server-message-contract.test.mjs           ← AG-P0-02 contract pin (untracked)
?? .claude/                                                           ← ignore
?? .hermes/{audit-reports,handoffs,plans}/                            ← context (ignore)
?? AUTOGOAL_CHAIN_REPAIR_PROOF{,/,.zip}                              ← historical (ignore)
```

**The only two files that matter for the next commit are:**
- `M packages/autogoal/src/server.ts` — `pickLatestAssistant` extraction (88+/25-)
- `?? packages/autogoal/test/server-message-contract.test.mjs` — 10-test contract pin

---

## Dependency Graph

```
P4-C0 ────────────────────────► DONE (ced246cac)
P3-C0 ────────────────────────► DONE (6a8a8fa71)

AG-P0-01 ─► AG-P0-02 ─► AG-P0-03 ─► AG-P1-06
   │           │                       │
   │           └──► AG-P0-04 ─► AG-P1-05
   │                                │
   └─► (sets the bar for) AG-P1-07 ─┘
                                  │
                                  └─► AG-P1-08 (release gate)
```

**Critical chain:** AG-P0-01 → AG-P0-02 → AG-P0-03. Without AG-P0-03,
AG-P0-01 stays red and `npm test` is red. Everything else is downstream.

---

## Test Status (just verified, 2026-06-25)

```
$ npm test (packages/autogoal)
# tests 1278
# pass 1277
# fail 1          ← AG-P0-01 (intentional red pin)
```

The single failure is the AG-P0-01 regression test at
`packages/autogoal/test/server-chain-runtime.test.mjs:140`. It fails
**for the exact reason the ticket predicted** (debounce at
`server.ts:939` suppresses second idle's evaluation). The fix is
AG-P0-03, not anything in AG-P0-02.

The AG-P0-02 helper (`pickLatestAssistant`) and its 10 contract tests
all pass.

---

## Next Concrete Action

**Commit AG-P0-02 as one atomic commit.** The diff and test are already
on disk and verified. This is the smallest unit of progress that
doesn't bundle tickets.

### Commit sequence (exact)

```bash
cd /mnt/c/Users/zerop/Development/opencode-source

# 1. Verify state hasn't drifted since this plan was written
git status --short
# Expect:
#   M packages/autogoal/src/server.ts
#   ?? packages/autogoal/test/server-message-contract.test.mjs

# 2. Stage both files
git add packages/autogoal/src/server.ts \
        packages/autogoal/test/server-message-contract.test.mjs

# 3. Verify what's about to be committed
git diff --cached --stat
# Expect:
#   packages/autogoal/src/server.ts                                    | 113 +++++++++++--------
#   packages/autogoal/test/server-message-contract.test.mjs            | 253 ++++++++++++

# 4. Commit (per AGENTS.md spec citation rule)
git commit -m "$(cat <<'EOF'
fix(autogoal): extract pickLatestAssistant helper for SDK v2 timestamp contract

AG-P0-02. Adds a pure helper `pickLatestAssistant(messages)` that reads
the canonical OpenCode SDK v2 timestamp at `info.time.created`, with
`info.metadata.time.created` retained as legacy fallback. Out-of-order
arrays select by max timestamp; array position is the fallback only
when all candidates lack timestamps.

The existing `getLatestAssistantMeta` wrapper now delegates to the
helper, so the v2 timestamp contract is enforced in one place.

(specs/v0.5.0-feature-work-orders.md §F-1)

Refs: AG-P0-01 (unblocks), AG-P0-03 (will turn AG-P0-01 green via the
marker-cutoff correctness this helper enables).
EOF
)"

# 5. Run the full test suite to confirm only the AG-P0-01 pin is red
cd packages/autogoal && npm test
# Expect: 1278/1278 pass on AG-P0-02 path. The AG-P0-01 test stays red
# as documented.
```

### Do NOT do in this commit

- ❌ Touch `server.ts:939` (that's AG-P0-03)
- ❌ Touch any test file other than `server-message-contract.test.mjs`
- ❌ Touch the protected test files (`dispatcher-parity`, `control-state-bridge`, `v042-corrupt-surfacing`)
- ❌ `git push` (that's a separate decision after the commit lands)

---

## After AG-P0-02 Lands

The next packet is **AG-P0-03** (event-identity dedup). It is the
ticket that makes AG-P0-01's red test turn green and `npm test` pass
end-to-end. Until AG-P0-03 lands, the tree is documented-red.

AG-P0-03 is a real center-audit-shaped question because it touches
the hot evaluation loop and changes timing semantics across every
chain runtime. The right move is **not** to bundle it into AG-P0-02 —
the ticket file says so explicitly, and the standing execution rule
"smallest contract-complete implementation change" forbids it.

When you're ready for AG-P0-03, the packet is:

1. Load center-audit skill
2. Center anchor: `server.ts:939` (the `lastEvaluationTime` debounce)
3. Claim: the process-wide stopwatch suppresses legitimate rapid
   evaluation of distinct message IDs in the same step or in
   back-to-back chain steps
4. Falsifier: identity-keyed dedup (per ticket: `sessionID + goalState.id + chainStep + latestAssistantMessageId`) lets distinct identities evaluate immediately while suppressing exact duplicates
5. Allowed files: `packages/autogoal/src/server.ts` +
   `packages/autogoal/test/server-chain-runtime.test.mjs`
6. Run AG-P0-01 test as the regression gate

That's the next packet. Not bundled. Not skipped. Just queued.

---

## What Lives Where (so you don't have to dig)

| Where | What |
|-------|------|
| `.hermes/plans/integrated-repair-plan-2026-06-24.md` | Full 9-step plan, invariants, ticket files |
| `.hermes/plans/2026-06-25-live-status-and-next-packet.md` | **This file** — live status, next action |
| `.hermes/handoffs/step-1-p4-ipc-silent-drop.md` | P4-C0 proof packet (done) |
| `.hermes/handoffs/step-2-ag-p0-01.md` | AG-P0-01 proof packet (done-as-red-pin) |
| `.hermes/audit-reports/` | 6-perspective audit + combined report (P3, P4 source) |
| `~/Downloads/autogoal-production-repair-tickets.md` | Ticket file (AG-P0-01..AG-P1-08) |
| `HANDOFF_AUTOGOAL_AUDIT.md` (repo root) | Pre-program audit handoff (Jun 22) — historical, do not orient on current state from this |

---

## Refresh Cadence

Refresh this plan after every commit, and whenever the working tree
state drifts. Quick refresh checklist:

```bash
git log --oneline -10                          # what's committed
git status --short                            # what's uncommitted
git diff --stat                                # size of uncommitted diff
ls .hermes/handoffs/                           # latest proof packets
cd packages/autogoal && npm test 2>&1 | tail -5  # current test state
```

If you feel lost again, run those four commands and update the Live
Status table. That alone re-anchors the program.