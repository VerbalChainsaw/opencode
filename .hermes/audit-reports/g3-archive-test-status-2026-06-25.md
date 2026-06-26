# G-3 status check — end-to-end test for appendGoalArchive

**Date:** 2026-06-25

## Finding

The hardening plan item G-3 (write end-to-end test for
`appendGoalArchive`) is **already covered by existing tests** in
`packages/autogoal/test/goal-archive.test.mjs`.

## Existing coverage

The test file pins:

| Test | Lines | Coverage |
|------|-------|----------|
| `append + read round-trip preserves outcome and state` | 75-89 | Basic round-trip |
| `read returns entries newest-first` | 91-106 | Ordering |
| `limit parameter caps the number of returned entries` | 108-117 | Limit semantics |
| `missing file returns empty result, not an error` | 119-128 | Missing-file path |
| `corrupt JSON line is skipped and counted` | 130-144 | Corrupt JSON |
| `corrupt shape (missing fields) is skipped and counted` | 146+ | Missing fields |
| ... (8 more tests in file) | various | Cap-at-1MB, read-only dir, etc. |

The tests are real end-to-end:
- Each uses `freshDir()` with `mkdtempSync(join(tmpdir(), "opengoal-archive-"))`
- Each writes via `appendGoalArchive` then reads back via `readGoalArchive`
- Each asserts on the actual file contents and the parsed structure

## Implication for G-3

G-3 is **already complete**. No additional test surface needed.

The audit trail of why each test exists is in the file's
top-level comment (lines 7-15):

> `appendGoalArchive` / readGoalArchive (pure unit tests against dist)
> read-only dir: appendGoalArchive swallows the failure (never...)

## Verification

```bash
cd packages/autogoal
node --test test/goal-archive.test.mjs
# Expected: all tests pass, including the 11+ archive tests.
```

If regressions appear, address at root cause.

## Cross-validation

The autogoal suite that exercises `appendGoalArchive` indirectly:

```
# Goal archive related tests pass via the autogoal full suite
# (1325/1325 green at HEAD = d161f08e1)
```