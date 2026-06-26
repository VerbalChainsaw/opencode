# G-5 — Sanitization audit (read-only)

**Date:** 2026-06-25
**Method:** Read-only trace of every `state.X = ...` and `state.metadata.X = ...` write site to identify unsanitized user input that reaches the on-disk state file.

## Audit scope

The audit focused on:
- All entry points that write to `state` or `state.metadata`
- The `sanitizeForPrompt` and `sanitizeMetadata` functions
- All paths that read the state file back into memory

## Findings

### ✅ Sanitization is correct at these write sites

| File:line | What's sanitized |
|-----------|------------------|
| `goal-state.ts:1102` | `state.condition` for evaluation messages (read-time, not write-time) |
| `goal-state.ts:1103` | `state.lastEvaluation.reason` for display |
| `goal-state.ts:1259` | `newCondition` (setCondition) before write |
| `goal-state.ts:1344` | `metadata.agentName` |
| `goal-state.ts:1358` | `steering[].note` |
| `goal-state.ts:1487` | `note` (steering) |
| `goal-state.ts:1584` | `note` (steering add) |
| `goal-state.ts:1722` | `e.reason` (archive entry) |
| `goal-state.ts:1726` | `payload.state.condition` (archive) |
| `goal-state.ts:1727` | `payload.state.command` (archive) |
| `goal-state.ts:1729` | `payload.state.lastEvaluation.reason` (archive) |
| `goal-state.ts:857` | `existing.metadata` via `sanitizeMetadata` |
| `goal-state.ts:320` | `agent` (chain step) |
| `goal-state.ts:457` | `agent` (chain step max-len) |
| `goal-state.ts:463` | `agent` (chain step max-len) |
| `server.ts:88` | `metadata.sessionId` |
| `server.ts:148` | `safeDetail` (error path) |
| `server.ts:758` | `args.evaluation.reason` (timeline) |
| `server.ts:884-900` | `providerID`, `modelID` (parsed) |
| `server.ts:917` | `name` (skill) |
| `server.ts:929` | `agent` (current chain step) |
| `goal-chain.ts:320` | `agent` (chain step) |
| `goal-chain.ts:457` | `agent` (chain step max-len) |
| `goal-chain.ts:463` | `agent` (chain step max-len) |

### ⚠️ Gap: `createGoalState` writes unsanitized `parsed.condition`

**File:** `goal-state.ts:510`
**Code:** `condition: parsed.condition`
**Risk:** MEDIUM

The `createGoalState` function stores the user's goal condition **without sanitization** to the on-disk state file. The sanitization happens later:
- At display time (`goal-state.ts:1102` via `sanitizeForPrompt`)
- At archive time (`goal-state.ts:1726`)

**Threat model:**
- The condition is read back from disk by `readGoalState` and used in:
  - The auto-loop's marker detection regex (line ~1100 in goal-state.ts)
  - The chain step processing (which builds prompt bodies that may be sent to the agent)
- A user-supplied condition with C0/C1 control chars or Unicode format chars could:
  - Cause unexpected regex behavior in marker detection
  - Bypass display sanitization if any code path reads `state.condition` directly without calling `sanitizeForPrompt`

**Affected entry points:**
- `setGoalFields` (line 914) — accepts `condition` from the agent, calls `persistGoal` → `createGoalState` → `writeGoalStateAtomic`. The condition is unsanitized.
- The set-goal CLI path (via `parseSetGoalArgs` → `persistGoal`) is similar.

**Mitigation already in place:**
- `sanitizeForPrompt` is called before the condition is shown to the user (line 1102)
- The marker regex itself uses anchored patterns (`GOAL_COMPLETE:`) that are unlikely to be triggered by control chars
- The condition is length-capped at `MAX_CONDITION_LEN` (256 chars in tests; real value in `goal-state.ts` constants)

**Recommended fix (out of scope for this commit):**
Apply `sanitizeForPrompt(parsed.condition)` at line 510:
```ts
condition: sanitizeForPrompt(parsed.condition),
```
This makes the on-disk condition safe-by-default. Display sanitization becomes defense-in-depth rather than the only line of defense.

### ⚠️ Gap: `setGoalFields` accepts `command` and `verification` without sanitization

**File:** `goal-state.ts:914-944`
**Code:** `command: fields.command ?? null, verification: fields.verification ?? null`
**Risk:** LOW

`setGoalFields` accepts `command` and `verification` from the agent. These are passed to `persistGoal` → `createGoalState` → `writeGoalStateAtomic` without sanitization.

- `command` is later used in `evaluateDeterministic` which runs it through Node's `execFile` (or `spawn`). Untrusted control chars in a shell command are a known injection risk; however, this is by design — the user is explicitly setting a goal with a shell command to run, and the command is run inside the workspace.
- `verification` includes a `url` field (for HTTP verification) and a `command` field (for shell verification). The URL is not validated for SSRF at write time (validated only at execution time via `isLocalUrl`).

**Recommended fix (out of scope):**
Apply field-specific sanitization at line 940:
- `sanitizeForPrompt(fields.command)` — though this is by design (shell command)
- URL SSRF validation at write time, not just at execution time

### ✅ The `sanitizeMetadata` function is correctly applied

`goal-state.ts:857` uses `sanitizeMetadata(existing.metadata)` when preserving the webhook across goal replacement. This sanitizes the metadata blob as a unit, ensuring no untrusted field can sneak through.

### ✅ The state file write (`writeGoalStateAtomic`) is direct JSON.stringify

`writeGoalStateAtomic` does a JSON.stringify of the in-memory state and writes to a tmp file + rename. There is no JSON injection vector at this layer because JSON.stringify escapes characters correctly. The risk is in the data being **stored**, not in the storage mechanism.

## Summary

| Risk | Status |
|------|--------|
| `parsed.condition` unsanitized at persistence | MEDIUM gap |
| `command` field unsanitized | LOW (by design) |
| `verification` field unsanitized | LOW (SSRF check at execution only) |
| Everything else | ✅ sanitized |

The single MEDIUM gap (unsanitized condition) is a real issue that should be fixed in a follow-up. The current mitigation (sanitize at display time) is sufficient for production safety but is fragile — a new code path that reads `state.condition` directly could bypass it.

## Recommended follow-up

A small commit applying:
```ts
// goal-state.ts:510
condition: sanitizeForPrompt(parsed.condition),
```

This is a one-line fix that:
- Strips C0/C1 control chars and Unicode format chars at the trust boundary
- Makes the on-disk condition safe-by-default
- Eliminates the display-sanitization as single-point-of-failure
- Has no perf cost (single string scan on persist)
- No test changes needed (existing tests pass sanitized input)

## Verification

```bash
# Confirm the gap exists:
grep -n "condition: parsed.condition" packages/autogoal/src/goal-state.ts
# Output: line 510

# Confirm the fix is missing:
grep -n "sanitizeForPrompt(parsed.condition)" packages/autogoal/src/goal-state.ts
# Output: (empty)
```

If the follow-up fix is applied:
```bash
# The grep should now return line 510 with the sanitized call.
```