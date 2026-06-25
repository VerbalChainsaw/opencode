# Repair handoff — Step 4 of 9 (AG-P0-03)

**Step:** AG-P0-03 — Replace process-wide debounce with event-identity dedup
**Commit:** `2ad60df60 fix(autogoal): replace process-wide debounce with identity-keyed dedup`
**Date:** 2026-06-25
**Status:** Complete. `npm test` autogoal 1278/1278 — AG-P0-01 now green.

---

## What landed

One file changed:
- `packages/autogoal/src/server.ts` (+67/-6) — replaced `lastEvaluationTime: number` stopwatch with `lastEvaluationByIdentity: Map<string, number>` keyed on `sessionID + goalState.id + chainStep + latestAssistantMessageId`. Added `pendingEvaluation` slot for in-flight retention. Updated `session.compacted` and `session.created` handlers to clear the dedup map.

## Proof packet

### Root cause

The `session.idle` handler at `server.ts:1013` (now; was :1774 pre-AG-P0-02) calls `await evaluate(state, sessionId)`. `evaluate` previously checked a process-wide stopwatch: `if (now - lastEvaluationTime < CONFIG.evaluationDebounceSec * 1000) return`. When step-1 of a two-step chain achieves, `evaluate` sets `lastEvaluationTime`, advances the chain, and issues a real `client.session.prompt` for the new step. The model responds, fires a second `session.idle`. But `lastEvaluationTime` was set ~1s ago, so the second `evaluate` returned early — step-2's marker scan never ran, and step-2 sat active with zero evaluations indefinitely.

The fix replaces the process-wide stopwatch with identity-keyed dedup. The dedup window itself is unchanged (still `evaluationDebounceSec`); what changed is the key. A new identity evaluates immediately; an exact-duplicate identity inside the window is skipped. One pending event is retained while evaluation is in flight so a distinct second event that arrives during evaluation is not lost.

### Files changed
- `packages/autogoal/src/server.ts` (debounce replaced)

### Failing-before (committed at `4ebcf1c30`)

```
not ok 587 - AG-P0-01: rapid two-step chain advances both steps without sleep or fresh instance
  failureType: 'testCodeFailure'
  error: `... Likely cause: the lastEvaluationTime debounce at server.ts:939 suppressed the second idle's evaluation.`
```

### Passing-after (after this commit)

```
$ npm test (packages/autogoal)
# tests 1278
# pass 1278
# fail 0
```

AG-P0-01 turns green. Full autogoal suite is end-to-end green for the first time in this branch.

### Compatibility risks

- **Same-session, same-message-ID, within window:** skip (intended; that's the dedup).
- **Same-session, new message-ID, within window:** evaluate immediately (the fix).
- **Cross-session IDs:** different prefix in the dedup key — no false suppression.
- **Pending event during in-flight evaluation:** retained as a single slot; only the most recent distinct event survives. Earlier pendings are intentionally overwritten (distinct events for the same identity inside the same tick are coalesced).
- **`session.compacted` / `session.created`:** dedup map cleared (all identities are stale post-compaction, or prefixed by a new sessionID).
- **Transient SDK error reading messages:** if `getLatestAssistantMeta` returns null, the dedup key is null and we fall through to evaluation rather than blocking indefinitely. This preserves the prior stopwatch's "always evaluate eventually" property.

### Explicit non-scope

- Did **not** touch `evaluateByTranscript` (forbidden by ticket AG-P0-03).
- Did **not** change `CONFIG.evaluationDebounceSec` value (the window stays 5s; the key is what changed).
- Did **not** touch the protected test files.
- Did **not** touch the marker-cutoff semantics (those are pinned by AG-P0-02's helper).

### Test counts

| Suite | Result |
|-------|--------|
| `node --test test/server-chain-runtime.test.mjs` (AG-P0-01) | 1/1 pass |
| `npm test` (full autogoal) | 1278/1278 pass |

---

## Next: AG-P0-04 (chain draft provenance — frontend)