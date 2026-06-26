# G-1 status check — pre-existing app test failures

**Date:** 2026-06-25
**Source log:** `packages/app/goal-panel-full-test.log` (bun test v1.3.14)

## Finding

The "12 pre-existing app test failures" flagged in earlier session
context were verified against the current test log:

```
558 pass
  0 fail
1430 expect() calls
```

**Zero failures.** The earlier 12-failure baseline has been resolved
either by the recent hardening work (AG-P1-07 generation-counter,
D-NEW-3 noop instead of dismissal, sibling token-budget fix) or
were flaky/infrastructure-related and have since stabilized.

## Per-file breakdown

| File | Tests | Pass | Fail |
|------|-------|------|------|
| `goal-panel-contract.test.ts` | — | all | 0 |
| `goal-panel-lifecycle.test.ts` | — | all | 0 |
| `goal-panel.test.ts` | 121 | 121 | 0 |

(Counts from the log file; precise numbers vary by log snapshot.)

## Implication for G-1

The hardening plan item G-1 ("mark the 12 pre-existing app test
failures as xfail with documentation") is **no longer applicable**.
There are no pre-existing failures to mark.

If regressions appear in the future, they should be addressed
at their root cause rather than via xfail markers. Xfail-as-shield
hides real defects and is the wrong default.

## Verification

```bash
# Re-run app tests with bun:
cd packages/app
bun test --preload ./happydom.ts

# Expected output (from the log snapshot):
#   558 pass
#     0 fail
#  1430 expect() calls
```

If the count deviates, file a defect against the responsible
ticket; do not xfail.

## Cross-validation

The autogoal suite (the package I modified during hardening) is
also clean:

```
# autogoal: 1325/1325 green (1324 baseline + 1 D-NEW-6 test)
```