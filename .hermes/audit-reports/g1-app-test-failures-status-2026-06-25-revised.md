# G-1 status check — REVISED (cross-validation flag)

**Date:** 2026-06-26
**REVISION:** The original G-1 status check (2026-06-25) cited a `packages/app/goal-panel-full-test.log` snapshot that is **10 days stale** relative to the hardening window. This is the cross-validation RED flag from the minimax audit.

## Original claim (now withdrawn)

> The "12 pre-existing app test failures" flagged in earlier session context were verified against the current test log: 558 pass / 0 fail / 1430 expect() calls.

## Why this is wrong

```
File:     packages/app/goal-panel-full-test.log
Modify:   2026-06-16 22:04 -0500  ← 10 days before the audit date
Size:     55,051 bytes
Commits to packages/app/src/ since 2026-06-16: 9+ (the entire hardening window)
```

The log predates **all 31 hardening commits**. The 558/0/1430 claim may still be true (the new tests may all pass), but I have **no evidence** for that — the audit cited stale data as if it were current.

The cross-validator flagged this correctly:
> "Do not push to `origin/dev` with stale test logs as the verification source."

## What I CAN verify (real evidence available here)

1. **No regression test was added that targets the 12 historical failures.** The hardening commits added new tests for new features, not regression tests for the historical 12. If the 12 failures were real, they're still latent (uncovered by the new tests).

2. **The 12 failures were not re-tested.** A fresh `bun test --preload ./happydom.ts` run is the only way to know the current state.

3. **The hardening commits don't touch the code paths that produced the original 12 failures** (visual-contract, i18n, etc.) per the audit's claim in the prior session.

## Honest disposition

**The "12 pre-existing failures" claim is unverified.** It may be true (the failures resolved on their own), it may be false (the failures persist), or it may be partially true (some resolved, some didn't). I have no way to know without running bun, which is unavailable in this WSL session.

## Required action (the user must do this)

```bash
# On any machine with bun installed:
cd /mnt/c/Users/zerop/Development/opencode-source/packages/app
bun test --preload ./happydom.ts

# Compare the new result to the stale log's:
#   558 pass
#     0 fail
# 1430 expect() calls

# If the result matches: G-1 disposition holds; no action needed.
# If the result diverges: investigate the failures, do not xfail
# (per the original audit's recommendation).
```

The final polish doc (`2026-06-25-final-polish-production-validation.md`)
already lists the verification command and the "log is stale" warning.
The test count in that doc must be re-validated before any push
to `origin/dev` with this as evidence.

## Lessons for the audit trail

- **Snapshot files are evidence, not facts.** The G-1 doc captured a number from a log file without noting the file's mtime. A 10-day-stale snapshot is a snapshot of a past state, not the current state.
- **Verification commands should be executable, not deferred.** The original doc said "the user can re-run bun test" — but didn't surface that the EXISTING doc used a stale number as the verdict. Verification status must be visible in the doc itself, not in a footnote.
- **Independent audits catch self-deception.** The primary agent (me) cited a stale log 31 commits later because the writing felt authoritative. The cross-validator caught it by checking mtime — a 30-second check that would have failed a self-audit too. Future audits should include a "verification freshness" check on every cited artifact.

## What this means for the goal

The hardening work itself is sound (Q1, Q2, Q3, Q4, Q5, Q7 all GREEN).
The G-1 question is **still open** and requires the user to run `bun test` to resolve.

The push to `origin/dev` should NOT happen until the user runs that command and either:
- confirms the 558/0/1430 number (G-1 disposition holds, no action)
- reports a different number (G-1 needs real investigation)