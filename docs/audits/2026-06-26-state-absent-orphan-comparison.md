# CENTER-AUDIT vs Ad-Hoc — Same Target, Two Methods

## The target

The boot orphan-chain cleanup at `packages/autogoal/src/server.ts:1075-1111`. Suspected defect: when the state file is absent or corrupt, the cleanup block is skipped and the chain file lingers forever.

## Ad-hoc debugging — what it would have looked like

1. Read commit `6d7d0c049`'s message: "orphan-chain cleanup, cleared-chain UI..."
2. Note: the commit fixed three orphan cases. Skim the block to see if there are more.
3. Notice the `bootTerminalState` guard on line 1087.
4. Notice `bootTerminalState` is only set when state-read returns `ok` and status is `achieved`/`cleared`.
5. Conclude: "the cleanup skips when state is absent or corrupt."
6. Write one sentence: "Add a fourth case to the orphan cleanup to handle missing state files."

That's a 30-second analysis. The finding would be correct.

**What ad-hoc would have got right**: the core insight (cleanup skips on missing state).

**What ad-hoc would have got wrong or missed**:

| # | Item | Ad-hoc would... |
|---|---|---|
| 1 | Falsifier | ...not state one. A reader can't verify or refute the claim. |
| 2 | Evidence ledger (E1–E5) | ...write a paragraph instead. Reader has to trust the author's synthesis. |
| 3 | The "is this actually an orphan?" question | ...not ask. The state-belongs-to-chain and state-is-orphaned distinction exists for a reason — confirming this case satisfies it is non-trivial. |
| 4 | The "was this considered-and-rejected?" question | ...not ask. The commit message enumeration is the only signal. |
| 5 | Confidence vs impact separation | ...just say "MEDIUM." Conflates the two. |
| 6 | Reproducibility classification | ...omit. Implicitly deterministic. |
| 7 | Non-center observations | ...fold into the main finding as noise, or skip them entirely. The corrupt-chain-file and unlink-failure-silent paths deserve their own audits. |
| 8 | Non-scope list | ...omit. The "I'll get to that later" items become invisible. |
| 9 | Repair contract (allowed/forbidden scope, compatibility, reversibility) | ...write a one-line fix without scope constraints. A junior reviewer could "fix" by unlinking all chains when state is missing — which would break the active/paused-preserves-chain invariant. |
| 10 | Verification meta-check (oracle independence, fixture validity, isolation) | ...write a single test. The CENTER-AUDIT named two failing-before tests with different scenarios and explicit oracle-independence claims. |
| 11 | The chainMatchesGoal cross-reference | ...miss. The fact that the UI does NOT misrender despite the file lingering is non-obvious and worth documenting so the reader doesn't panic about UI corruption. |

## What CENTER-AUDIT produced

A 16KB JSON file containing:
- Falsifiable claim + center anchor + falsifier
- 5 evidence entries with channels, strength grades (A/B), independence groups
- 5-link trajectory, all proven, no unproven links
- 2 disproven concerns (was this an orphan? was this considered-and-rejected?)
- 2 unknowns (frequency in production; corrupt-chain-file separate audit)
- 5 non-center observations with explicit exclusion reasons
- Blast radius (direct, edge bundles, indirect, boundary, excluded)
- Repair contract with allowed_scope, forbidden_scope, 4 compatibility invariants, reversibility statement
- Verification plan with 2 failing-before tests, 2 passing-after checks, 2 test_meta entries
- Explicit independent_witness decision (declined, with reason)

Schema-valid against the v2.5.1 JSON schema.

## The honest scorecard

| Dimension | Ad-hoc | CENTER-AUDIT | Winner |
|---|---|---|---|
| Speed | 30 seconds | ~10 minutes | Ad-hoc, by 20x |
| Core finding correct? | Yes | Yes | Tie |
| Verifiable by reader? | No (paragraph) | Yes (evidence IDs + anchors) | CENTER-AUDIT |
| Fix scope constrained? | No | Yes (forbidden_scope) | CENTER-AUDIT |
| Multi-defect awareness? | No | Yes (non-center observations) | CENTER-AUDIT |
| Reproducibility explicit? | No | Yes (DETERMINISTIC) | CENTER-AUDIT |
| Confidence separated from impact? | No | Yes | CENTER-AUDIT |
| Verification oracle explicit? | No | Yes (oracle_independent) | CENTER-AUDIT |
| Compression ratio | 1 sentence : 1 finding | 16KB JSON : 1 finding | Ad-hoc |
| Auditability of the audit itself | Low | High (schema-validated, evidence-traceable) | CENTER-AUDIT |

## What CENTER-AUDIT cost

- **Time**: ~10 minutes for the full audit (pre-flight + 5 evidence ops + 5 trajectory links + JSON assembly).
- **Tokens**: 16KB JSON output for a finding that fits in one sentence.
- **Cognitive overhead**: maintaining the discipline (every claim needs an evidence ID, every trajectory link needs a mechanism, every fusion has 4 separate dimensions) when the underlying finding is simple.

For a one-line bug in a small file, CENTER-AUDIT is overkill. For a contract edge in a layered system with cross-process state, it's the right shape.

## What CENTER-AUDIT bought

- **A reviewer can audit the audit.** The schema-validated JSON, the evidence ledger, the falsifier, the trajectory with explicit proven/unproven links — all of this is auditable without re-running the investigation.
- **A repair agent has a contract, not a paragraph.** The repair_contract section has objective, allowed_scope, forbidden_scope, 4 compatibility invariants, and reversibility. The repair agent cannot accidentally "fix" by unlinking all chains — that would violate `compatibility[0]`.
- **The trajectory is verifiable.** Each link has `from_anchor`, `to_anchor`, `edge_type`, `edge_token`, `mechanism`, `evidence_ids`, `proven`. A reader can trace any claim back to its source.
- **Future investigators have a map.** The unknowns and non_scope items name what this audit didn't cover. A follow-up audit on "corrupt chain file" or "unlink failure silent path" can start from this output instead of from scratch.

## Verdict

For this target — a contract edge in a layered system with cross-process state, a recent fix that didn't quite finish the job — CENTER-AUDIT produced the right shape of artifact at 20x the cost of ad-hoc. The cost is the price of doing the audit in a form a future reader can verify.

For a one-line typo in a small file, it would be wasteful. The skill's trigger cases explicitly say "Do not invoke for ... routine test-only changes" — that's the right boundary.

The doctrine is **load-bearing at this scope**. Whether it's load-bearing at smaller scopes is a separate question this audit doesn't answer.

---

*Audit JSON: `center-audit-state-absent-orphan.json` (16KB, schema-valid)*
*Methodology: CENTER-AUDIT v2.5.1*
*Target: opencode-source `packages/autogoal/src/server.ts:1075-1111` at HEAD `6d7d0c049`*