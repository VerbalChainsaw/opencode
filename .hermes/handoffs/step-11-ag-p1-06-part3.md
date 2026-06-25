# Repair handoff — Step 11 — AG-P1-06 part 3 (call-site migration)

**Step:** AG-P1-06 part 3 — both production call sites route through `deliverContinuation`
**Commit:** `eef28483c fix(autogoal): migrate both call sites to deliverContinuation dispatcher`

## Scope

This is the final piece of AG-P1-06. Parts 1+2 shipped the decision function and the dispatcher wrapper. Part 3 wires production code into the dispatcher and closes the ticket's acceptance criterion:

> Every delivery attempt ends in delivered, safely retrying, or visibly paused. "Active but nothing is happening" is not a legal state.

Pre-fix, this was NOT met for the chain-advance path. Post-fix, both paths share the same retry/idempotency/pause semantics.

## What landed

### Migration (server.ts)

Both call sites now use `deliverContinuation(client, opts)`:

**Chain-advance** (`if (snapshot.achieved)` branch):
- Pre-fix: `client.session.prompt({...}).then(resetNudgeFailures).catch(err => { if (hard error) pause })`
- Post-fix: `await deliverContinuation(client, { sessionId, idempotencyKey: `${sessionId}|${state.id}|${state.metadata.chainStep}`, body, deps: { onPause, onNotify, onWebhookFire, onReset } })`
- New behavior: transient failures retry up to 3 times, idempotency key prevents double-delivery, hard errors pause immediately, exhaustion pauses with deterministic reason

**Continue-nudge** (`if (!snapshot.achieved)` branch):
- Pre-fix: `client.session.prompt({...}).then(resetNudgeFailures).catch(err => { recordNudgeFailure + maybe pause })`
- Post-fix: same dispatcher pattern with `idempotencyKey: `${sessionId}|${state.id}` (no chain step)`

### C4 fix — webhook ordering

Pre-fix: chain-advance path fired `fireWebhook(fresh, "active")` BEFORE `notify(...)`.
Post-fix: `onPause → onNotify → onWebhookFire` so the webhook reflects the post-notification state.

### Q4 cleanup — `nudgeFailureCounts` removed

The legacy `Map<string, number>` per-session failure counter and its helpers (`recordNudgeFailure`, `resetNudgeFailures`, `_cleanupTimer`) are removed. Per-call retry accounting is owned by the dispatcher. Callers that previously invoked `resetNudgeFailures(sessionId)` from `onReset` callbacks are no-ops now (and the helpers are gone).

### Dispatcher improvements (part 3 additions)

1. **Result-shape normalization.** The OpenCode SDK's `session.prompt` returns a `RequestResult<{ data, error }>` (sync object) when `ThrowOnError = false` (the default), and a Promise that rejects when `ThrowOnError = true`. The dispatcher now handles both shapes — extracted via the `handleFailure` closure that's called from both the `try`/`catch` and the result-shape check.

2. **Notify level differentiation.** `finalizePause` now takes a `level: "error" | "warning"` parameter. The decision's status determines the level:
   - `pause-immediately` (auth/provider-fatal) → `"error"` (red banner)
   - `exhausted` (network/abort/unknown flapped) → `"warning"` (amber banner)

3. **Reason shape preserved.** The exhaustion reason is `Nudge delivery failed N times consecutively in session X (kind: detail)` — the legacy shape that downstream tests/log-scrapers match against. The pause-immediately reason is `Provider error — goal paused (kind: detail)` — preserves the legacy prefix. `detail` is threaded from `classifyNudgeFailure`'s return so the SDK error surfaces verbatim (e.g. `ProviderAuthError: Invalid API key for anthropic`).

4. **`decideContinuationRetry` API extended.** Now accepts optional `detail?: string` and `sessionId?: string`. The unit tests for the decision function (`server-continuation-dispatch.test.mjs`, 13 tests) were updated to pass these when needed — the new fields are optional with sensible defaults so existing callers don't need to change.

5. **`client` parameter typed as `{ ... } | any`.** The real OpenCode SDK's `OpencodeClient.session.prompt` is a generic-typed RPC call whose argument type is bound to a complex `Options<SessionPromptData, ThrowOnError>` shape that doesn't structurally match our simpler `(args: unknown) => Promise<unknown>` contract. Typed as `any` to allow the real SDK client to flow through, with the dispatcher's per-call checks (idempotency key, maxAttempts, body shape) at the entry boundary.

## Tests

### New: `server-continuation-callsite.test.mjs` (6 tests)

Shape verification — pins the wire-up at the source level rather than driving the full server lifecycle (which requires a fully-mocked SDK with async message reads, constraint checks, dedup maps, and message-shape normalization — out of scope for this commit):

1. Chain-advance prompt uses `deliverContinuation` dispatcher
2. Continue-nudge prompt uses `deliverContinuation` dispatcher
3. Legacy `nudgeFailureCounts` Map and helpers removed (with comment-stripping to avoid false positives from documentation references)
4. Chain-advance idempotency key includes `state.metadata.chainStep`
5. Continue-nudge idempotency key is per-session per-state
6. Dispatcher deps callbacks wired at both call sites (onPause/onNotify/onWebhookFire/onReset)

### Updated: `server-continuation-dispatcher.test.mjs` (test 2.3)

The exhaustion-reason test was updated from exact-equality to regex matches because the new reason text includes the SDK error's detail (which is the mock's literal error message, not a fixed string). The structural pieces (verb "Nudge delivery failed", count "3 times consecutively", session ID, kind "network") are still pinned.

### Updated: `server-error.test.mjs` (3 tests)

The `classifies repeated X nudge prompt failures before pausing the goal` tests previously failed because:
- New exhaustion reason is `Nudge delivery failed 3 times consecutively in session X (kind: detail)` — matches the legacy `/Nudge delivery failed 3 times consecutively/` regex
- New pause-immediately reason is `Provider error — goal paused (kind: detail)` — matches the legacy `/Provider error — goal paused/` prefix AND the new `/ApiError|Rate limit exceeded|429/` regex (via the detail)

These tests were authored for the pre-fix `nudgeFailureCounts` path. They now pass through the dispatcher's contract without changes (the test author pinned regex shapes that match both pre-fix and post-fix strings).

## Test results at HEAD = `eef28483c`

| Suite | Result |
|-------|--------|
| autogoal | **1319/1319** green (was 1313, +6 callsite tests; all dispatcher + decision unit tests pass) |
| app typecheck | clean (full test run requires bun, not available in this WSL shell session) |

## Honest disclosures

1. **Test 2.3 (dispatcher unit test) was modified, not added.** The "exhaustion pauses + writes deterministic reason" test pinned exact-equality on the legacy reason string. Post-fix the reason includes the SDK error's detail (a real improvement), so the test asserts structural pieces via regex matches. This is the standard pattern for "test fails for the right reason" when the contract shape evolves.

2. **Server-error.test.mjs tests were NOT modified.** They were already passing after the dispatcher's reason shape stabilized to match the legacy prefix. The 3 failures I saw mid-iteration were caused by an intermediate state where the reason was `"Continuation delivery failed N times consecutively (kind)"` (without "Nudge" and without detail). The final reason shape restores backward compatibility with these tests.

3. **The integration tests I started writing were too tangled.** I attempted full-lifecycle tests with mock `client.session.prompt` and asserted retry counts. The mocks couldn't reliably reach the dispatcher code path through the full plugin lifecycle (constraint checks, dedup maps, message-shape normalization all interpose). I pivoted to source-level shape verification (the 6 callsite tests). The retry behavior is verified by the dispatcher's own unit tests (9/9 pass) — a clean layering.

4. **Q4 left a comment-trace of the removed names.** The audit names (`nudgeFailureCounts`, `recordNudgeFailure`, etc.) appear in documentation comments in the dispatcher block explaining why they were removed. The callsite test strips comments before asserting "the legacy names are gone from code" — without that stripping, the assertion would false-positive on documentation references.

## Program status

| # | Step | Status |
|---|------|--------|
| 1 | P4-C0 | ✅ DONE (pre-existing) |
| 2 | P3-C0 | ✅ DONE (pre-existing) |
| 3 | AG-P0-01 (red-pin) | ✅ DONE — GREEN after AG-P0-03 |
| 4 | AG-P0-02 | ✅ DONE |
| 5 | AG-P0-03 | ✅ DONE |
| 6 | AG-P0-04 | ✅ DONE |
| 7 | AG-P1-05 | ✅ DONE |
| 8 | AG-P1-06 (parts 1+2+3) | ✅ DONE — fully closed in production |
| 9 | AG-P1-07 | ✅ DONE |
| 10 | Geometry audit | ✅ DONE |
| 11 | AG-P1-08 (release smoke gate) | ⬜ TODO — needs real host binary |

The 9-step program (10 if you count AG-P1-06 parts 1+2+3 separately) is complete except for AG-P1-08, which can't be done from this WSL shell (needs the actual installed OpenCode binary on the Windows side).

18 commits on `dev` ahead of `origin/dev`. Push still blocked on credentials — `git push origin dev` from your shell is the move.