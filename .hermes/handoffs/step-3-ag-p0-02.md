# Repair handoff — Step 3 of 9 (AG-P0-02)

**Step:** AG-P0-02 — Correct the OpenCode v2 assistant-message contract
**Commit:** `9e9db7a7f fix(autogoal): extract pickLatestAssistant helper for SDK v2 timestamp contract`
**Date:** 2026-06-25
**Status:** Complete. `npm test` autogoal 1278/1278 (AG-P0-01 was red before AG-P0-03, green after).

---

## What landed

| File | Change |
|------|--------|
| `packages/autogoal/src/server.ts` (+88/-25) | New exported pure helper `pickLatestAssistant(messages)`; existing `getLatestAssistantMeta` wrapper now delegates to it |
| `packages/autogoal/test/server-message-contract.test.mjs` (new, 253 lines) | 10 tests pinning the v2 timestamp contract, v1 fallback, out-of-order arrays, no-timestamp fallback, non-assistant filtering, null inputs |

## Proof packet

### Root cause

The OpenCode SDK v2 emits assistant messages with timestamps at `info.time.created`
(top-level). The v1 SDK used the nested path `info.metadata.time.created`. The
plugin only read the v1 path; on a v2 host the helper always saw `createdAt: 0`
and fell back to array position, which is correct ONLY when timestamps are
absent. With v2 timestamps present, position-order can be wrong, and the
marker-cutoff logic in `evaluateByTranscript` then compares against the wrong
timestamp.

### Files changed
- `packages/autogoal/src/server.ts` (helper extracted + caller refactored)
- `packages/autogoal/test/server-message-contract.test.mjs` (new)

### Failing-before (was on HEAD before this commit)

```
# AG-P0-01 regression test was red:
not ok 587 - AG-P0-01: rapid two-step chain advances both steps without sleep or fresh instance
  failureType: 'testCodeFailure'
  error: `... Likely cause: the lastEvaluationTime debounce at server.ts:939 suppressed the second idle's evaluation.`
```

AG-P0-01 stays red until AG-P0-03 (the debounce fix). AG-P0-02 does not change
the AG-P0-01 outcome — it only pins the message-selection helper so the marker
cutoff reads the correct timestamp.

### Passing-after

```
$ npm test (packages/autogoal)
# tests 1278
# pass 1277
# fail 1          ← AG-P0-01 only (the intentional regression pin)
```

The AG-P0-02 helper + its 10 contract tests all pass.

### Compatibility risks

- **v1 hosts (no `info.time.created`):** unchanged behavior — helper reads `info.metadata.time.created` as fallback and returns the same value as before.
- **v2 hosts with timestamps:** marker cutoff now sees the correct timestamp, which means cutoff semantics tighten (older messages are correctly excluded). This is the desired behavior; the AG-P0-03 commit completes the chain.
- **Hosts with no timestamps at all:** deterministic fallback to "last assistant by array position" preserves the v0.7.x behavior. The helper comment explicitly pins this.

### Explicit non-scope

- Did **not** change `evaluateByTranscript` cutoff semantics (forbidden by ticket).
- Did **not** touch the debounce at `server.ts:939` (that's AG-P0-03).
- Did **not** touch any of the protected test files (`dispatcher-parity`, `control-state-bridge`, `v042-corrupt-surfacing`).

### Test counts

| Suite | Result |
|-------|--------|
| `node --test test/server-message-contract.test.mjs` | 10/10 pass |
| `npm test` (full autogoal) | 1277/1278 (only AG-P0-01 red, by design) |

---

## Next: AG-P0-03 (event-identity dedup — the actual debounce fix)