# Scratchpad — opencode-source / autogoal refactor planning

> Append-only working notes for subagents. Each entry is a "Order" with a date.
> The format below is the agreed template; agents append new Orders, never overwrite.

---

## Order B — refactor plan (Hermes 2026-06-21)

### Decision
**Option Y — extract `src/dispatcher.ts`.** Both files are full re-implementations
of the same goal-control command language (parse → route action → call goal-state/
goal-chain primitive → format envelope), with the bridge path needing ~600 extra
lines for its `{title,output,metadata}` envelope, async atomic writes (Windows
EPERM/EBUSY retry), and template import/delete. Option X (bridge becomes a thin
adapter over `dispatchGoalCommandStructured`) looks cheaper but pays a hidden cost:
routing every action through goal-state.ts's *sync* writers would regress the
bridge's Windows-friendly atomic-rename-with-retry behavior (the explicit reason
control-state.ts was written with `node:fs/promises` + `renameWithRetry` in the
first place — see `control-state.ts:674-689`). The parity test only compares the
final on-disk state, so the regression would not be caught by `dispatcher-parity.
test.mjs`. Option Y keeps the atomic-write layer where it belongs (control-state.ts)
while extracting the genuine duplicate logic (parser, action routing, set-text
formatter, inline-JSON validators, chain sub-actions) into a shared module. Both
entry points remain independently importable, which is the explicit hard constraint
(CLI = `opencode-autogoal` npm package, bridge = in-process OpenCode Desktop
server plugin).

### Option Y details

- **New files**
  - `src/dispatcher.ts` — shared dispatch core (parser + action routing +
    formatGoalSet + inline-JSON helpers + chain sub-actions). Pure functions on
    top of goal-state.ts / goal-chain.ts / templates.ts. No I/O of its own
    beyond calling those primitives.

- **Files modified**
  - `src/command.ts` (813 lines) — keep: imports + KNOWN_ACTIONS + CLEAR_ALIASES
    + FRESH_STATE_FILES + the structured envelope types
    (`GoalCommandKind`, `GoalCommandResult`, `KIND_TO_EXIT`) +
    `goalInstructions` / `goalInstructionsEnvelope` / `corruptNotice` /
    `corruptReasonLabel` / `viewEnvelope` / `freshStateEnvelope` /
    `dialResultToEnvelope` + `plainStatus` + `formatGoalCommandResult` +
    `presentGoalCommandResult` + `dispatchGoalCommand` +
    `dispatchGoalCommandStructured` (thin glue over dispatcher.ts) +
    `parseInlineChainStartPayload` (or move into dispatcher if cleaner) +
    `userTemplateSeed` (template use-with-`--var`, CLI-only). Delete: the inline
    `if (action === "set") ... if (action === "turns") ...` ladder; import
    shared action functions from dispatcher.ts instead. The prose presenter
    `formatGoalCommandResult` stays here because it's CLI/agent-specific.
  - `src/control-state.ts` (1162 lines) — keep: imports + `GoalControlState` +
    `GoalControlState` / `GoalControlStateFileResult` / `GoalControlStateFileOptions`
    types + `runGoalControlStateFile` (the async entry point) +
    `splitGoalCommand` (or import from dispatcher if shared) + `result()`
    envelope builder + `formatGoalSet` (or import from dispatcher) + ALL the
    atomic-write helpers (`writeJsonAtomic`, `writeTextAtomic`,
    `renameWithRetry`, `unlinkWithRetry`, `isTransientRenameError`,
    `fileExists`, `goalStatePath`/`goalChainPath`/... path helpers) +
    `upsertTemplateSnapshot` / `deleteTemplateSnapshot` /
    `readTemplateSnapshot` (GUI-only template housekeeping) +
    `readGoalStateOptional` / `readGoalChainOptional` / `readHandoffOptional` +
    `requireGoal` / `requireGoalChain` / `requireMutableGoal` +
    `setActiveChainGoal` / `updateActiveChainMetadata` (chain-only state glue
    that exists alongside goal-chain.ts primitives) + the GUI-only `editTemplate`
    (import + delete) + type guards (`isGoalControlState`, `isRecord`,
    `isNumber`, `isNullableNumber`, `isStatus`, `isSetBy`) +
    `sanitizePromptText` / `sanitizeSessionID` / `verificationFromCommand` /
    `sanitizeVerification` / `sanitizeGoalChain` / `sanitizeChainMaster` /
    `sanitizeConstraints` / `sanitizeVariables` / `sanitizeControlMetadata` /
    `sanitizeChainStep` / `sanitizeSkills` / `sanitizePinnedModel` +
    `parseIndex` / `parseBoundedInt` / `clampPositiveInteger` / `readPositiveInteger`
    + `requireTemplateID` + `jsonNestingDepth` / `parseJsonObject` +
    `sanitizeTemplatePayload` / `sanitizeChainPayload`. Delete: the inner
    action bodies (`setGoalState`, `freshGoalState`, `editConstraint`,
    `transitionGoal`, `restartGoal`, `appendSteering`, `clearSteering`,
    `editCondition`, `createHandoff`, `claimHandoff`, `addChainStep`,
    `moveChainStep`, `removeChainStep`, `startGoalChain`) and have them
    delegate to dispatcher.ts, then wrap the result with the bridge's
    `{title, output, metadata}` envelope and (where relevant) its async
    atomic writer.

- **Public API changes**
  - `none` — public surface preserved.
    - `command.ts` continues to export: `GoalCommandKind`, `GoalCommandResult`,
      `KIND_TO_EXIT`, `goalInstructions`, `plainStatus`,
      `dispatchGoalCommandStructured`, `formatGoalCommandResult`,
      `presentGoalCommandResult`, `dispatchGoalCommand`.
    - `control-state.ts` continues to export: `GoalControlState`,
      `GoalControlStateFileResult`, `GoalControlStateFileOptions`,
      `runGoalControlStateFile`.
    - `src/index.ts` re-exports of `runGoalControlStateFile`,
      `GoalControlState`, `GoalControlStateFileResult` unchanged.
    - `package.json` `exports."./control-state"` (`./src/control-state.ts`)
      and `"./cli"` (`./dist/cli.js`) unchanged. The bridge path still
      imports the .ts source directly; the CLI path still imports the built
      dist.
    - `tests/` imports from `../dist/command.js` and `../dist/control-state.js`
      unchanged. `tsconfig.build.json` continues to compile `src/**/*.ts` to
      `dist/`.

- **Information loss assessment**
  - **Action routing + primitive delegation**: zero loss. Both paths were
    already calling the same goal-state.ts / goal-chain.ts primitives; the
    shared dispatcher delegates to the same functions.
  - **Set text (`formatGoalSet`)**: must be unified to a single source. Both
    currently produce the same 4–6 line "A goal has been set and is now your
    top priority. ..." block. The parity test for `set` would already have
    failed if they diverged in any way the test detects — they don't, so
    unification is safe.
  - **Inline-JSON validation (`parseInlineChainStartPayload` in command.ts vs
    `parseJsonObject` + `jsonNestingDepth` in control-state.ts)**: nearly
    identical (both enforce 256KB byte cap + 256-level nesting depth). Will
    be unified. CLI version also validates `master.maxTurns`/`maxMinutes`
    positivity — that check must be preserved.
  - **Chain sub-actions (`chain start-json` / `add` / `move` / `remove`)**:
    both call the same goal-chain.ts primitives (`createGoalChain`,
    `addChainStep`, `reorderChainStep`, `removeChainStep`). CLI and bridge
    both convert 1-based indices to 0-based before calling (the bridge
    comment at `control-state.ts:343-346` explains the historical
    off-by-one fix). Unification is safe — parity test already locks it.
  - **Handoff**: control-state.ts's `createHandoff` (lines 295-316) is a
    near-duplicate of `goal-state.ts:createHandoff` (which is called by
    command.ts). The bridge's version writes the SAME JSON shape (sanitized
    state, ISO createdAt, sanitized note) and uses `writeJsonAtomic` (its
    own atomic rename). Parity test does NOT check handoff on-disk format,
    only the live state and chain. Unification through dispatcher.ts +
    goal-state.createHandoff is safe; the bridge's atomic-rename layer
    remains the underlying write mechanism (goal-state.createHandoff
    already uses `writeHandoffAtomic` which is itself atomic).
  - **Fresh / reset**: both delete the same set of files. Bridge uses
    async `unlink` with retry; CLI uses sync `unlinkSync`. Behavior
    equivalent for parity; the bridge gets to keep its retry behavior.
  - **Template import/delete**: GUI-only (control-state.ts); CLI has the
    richer template surface (list/export/use + --var) which is NOT being
    unified. The GUI's import/delete will be invoked through dispatcher.ts
    ONLY IF the dispatcher exposes a hook for it; otherwise it stays in
    control-state.ts as the GUI-specific surface. **Recommendation: keep
    GUI's template import/delete path in control-state.ts** — it's not
    duplication of CLI's template sub-action, it's a deliberately narrower
    surface for the GUI HTTP endpoint.
  - **Atomic-write layer (Windows retry)**: stays in control-state.ts. The
    CLI does not need it; introducing it into dispatcher.ts would change
    the CLI's I/O characteristics in ways the parity test cannot detect
    (since parity only compares end state). v042-corrupt-surfacing.test.mjs
    scans `src/control-state.ts` for the `randomUUID()` tmp-file pattern
    and would pass unchanged as long as control-state.ts keeps
    `writeTextAtomic` (which it does).
  - **Verification representation difference**: CLI writes
    `verification:null + command`; bridge writes
    `verification:{type:"shell",command}`. Both are produced by the
    underlying goal-state.ts primitives (`setGoal` and the bridge's own
    setGoalState). Parity test normalizes this. **Preserved unchanged** —
    each caller keeps its own writer, which preserves the difference.

- **Risks**
  1. **Behavior drift in the shared dispatch core.** A bug in dispatcher.ts
     affects both surfaces. *Mitigation*: parity test must stay green.
  2. **Cyclic imports.** dispatcher.ts must not import from command.ts or
     control-state.ts (the dependency arrow is one-way: command.ts and
     control-state.ts both import from dispatcher.ts; dispatcher.ts imports
     only from goal-state.ts, goal-chain.ts, templates.ts). *Mitigation*:
     enforce via static review during implementation.
  3. **Async/sync mismatch.** `runGoalControlStateFile` is async;
     `dispatchGoalCommandStructured` is sync. control-state.ts can `await`
     a sync call, but the surrounding I/O helpers (atomic writes) must
     remain async. *Mitigation*: dispatcher.ts is sync; control-state.ts
     wraps each call in its existing async helpers.
  4. **GoalCommandResult message format drift.** If dispatcher.ts's action
     functions return data shaped differently from what command.ts's
     envelope-mappers expect, CLI prose output changes silently. *Mitigation*:
     `command-prose-identity.test.mjs` (which pins byte-identical prose for
     `dispatchGoalCommand`) must stay green unchanged.
  5. **Handoff on-disk format change.** If the bridge is silently rerouted
     through a different writer. *Mitigation*: do not touch the bridge's
     `createHandoff`/`claimHandoff` body during the refactor; only the
     call-sites inside dispatcher.ts.
  6. **v042-corrupt-surfacing.test.mjs.** Reads `src/control-state.ts` as
     text and asserts the `randomUUID()` tmp-file pattern is present.
     *Mitigation*: control-state.ts keeps `writeTextAtomic` unchanged —
     even if dispatcher.ts gains its own writer later, the existing
     control-state.ts writer stays so this test passes.
  7. **Build emits `dist/control-state.js`** — the parity test imports from
     there. `tsconfig.build.json` includes `src/**/*.ts` so as long as
     control-state.ts still compiles cleanly, `dist/control-state.js` will
     be produced. *Mitigation*: keep control-state.ts compilable.

### Open questions for the user

- Is it OK that the atomic-write helpers stay in `control-state.ts` (bridge-
  only), rather than being promoted into `dispatcher.ts` for the CLI to also
  benefit on Windows? *My recommendation: yes, keep them in control-state.ts;
  promoting them is a separate behavior change for the CLI and out of scope
  for a "merge the duplicate logic" refactor.*
- Should `splitGoalCommand` (the quote-aware tokenizer) move into
  `dispatcher.ts` so command.ts can also use it (today command.ts uses
  `argsText.search(/\s/)` + `slice` which is brittle — the parity test's
  "handoff note strips surrounding quotes" case shows command.ts now calls
  `unwrapQuotes` separately for that one command)? *My recommendation:
  yes, move it. It would let command.ts drop its `unwrapQuotes` calls and
  fix the long-standing fragility where `set foo bar` is split into
  action="set" payload="foo bar" but a multi-space argument would break
  parity. This is a small change but worth confirming it's in scope.*
- Should the GUI-only template import/delete path be exposed via
  dispatcher.ts (so the dispatcher's "template" sub-action is a superset
  and command.ts simply doesn't call it for GUI-only sub-actions), or
  should it stay local to control-state.ts? *My recommendation: keep
  local — it's a different file-write surface (snapshot file at
  `goal-templates.json`) and doesn't share state with CLI's template
  surface.*
- The `formatGoalSet` text is currently duplicated between command.ts
  (`goalInstructionsEnvelope`'s top lines) and control-state.ts
  (`formatGoalSet`). Should they share one implementation? *My
  recommendation: yes — they're already producing the same text. Put it
  in dispatcher.ts; command.ts wraps it with the "How to proceed:" agent
  scaffolding; control-state.ts uses it as-is.*

### Estimated diff size

| File                        | Added       | Removed     | Net       |
|-----------------------------|-------------|-------------|-----------|
| `src/dispatcher.ts` (new)   | ~300 lines  | 0           | +300      |
| `src/command.ts`            | ~30 lines   | ~400 lines  | ~−370     |
| `src/control-state.ts`      | ~30 lines   | ~500 lines  | ~−470     |
| `src/index.ts`              | 0           | 0           | 0         |
| `package.json`              | 0           | 0           | 0         |
| `tsconfig.build.json`       | 0           | 0           | 0         |
| `test/**`                   | 0           | 0           | 0         |
| **Total**                   | **~360**    | **~900**    | **~−540** |

- Lines added to `command.ts` are: imports from `./dispatcher.js`, thin
  re-routing in `dispatchGoalCommandStructured`. Lines removed are the
  inline `if (action === "set") ... if (action === "turns") ...` ladder
  (~400 lines from line ~328 to line ~770).
- Lines added to `control-state.ts` are: imports from `./dispatcher.js`,
  thin re-routing in `runGoalControlStateFile`. Lines removed are the
  per-action helper functions (`setGoalState`, `freshGoalState`,
  `editConstraint`, etc. — ~500 lines from line ~184 to line ~490).

### Verification plan

Run in `packages/autogoal/`, in this order:

1. `npm run typecheck` — must pass. Catches type-level issues in dispatcher.ts
   before the build runs.
2. `npm run build` — must produce `dist/command.js`, `dist/control-state.js`,
   `dist/cli.js`. The build script also runs `npm run clean` first; this is
   intentional (start from empty dist/).
3. `node --test test/dispatcher-parity.test.mjs` — **UNCHANGED** parity
   lock. Must pass byte-equivalent state for all 8 sub-tests.
4. `node --test test/control-state-bridge.test.mjs` — **UNCHANGED** bridge
   contract lock. Must pass all 9 sub-tests (chain remove, validateGoalChain
   acceptance, advanceGoalChain end-to-end, remove refuses current step,
   fresh, condition length bound, oversized JSON rejection, deep nesting
   rejection, 1-based chain move, chain add metadata refresh, maxCycles=10
   default).
5. `node --test test/command-envelope.test.mjs` — **UNCHANGED** CLI
   envelope contract. Must pass all 14+ sub-tests covering every
   `GoalCommandKind`.
6. `node --test test/command-prose-identity.test.mjs` — **UNCHANGED** prose
   byte-identity. Must pass all sub-tests covering `dispatchGoalCommand`
   output strings (the OpenCode agent path).
7. `node --test test/v042-corrupt-surfacing.test.mjs` — **UNCHANGED**
   atomic-write tmp-file pattern check. Must pass; requires
   `src/control-state.ts` to still contain `writeTextAtomic` with
   `${process.pid}.${randomUUID()}`.
8. `node --test test/cli.test.mjs` — **UNCHANGED** CLI thin-wrapper
   coverage.
9. `node --test` — full suite, all green.
10. Manual spot-check (one-off, not committed): from a Node REPL in
    `packages/autogoal/`, run
    `await import('./dist/command.js'); await import('./src/control-state.ts')`
    independently and confirm both modules import without dragging in the
    other. This proves the "independently importable" hard constraint.

Order is: typecheck → build → parity → bridge → envelope → prose → corrupt
surfacing → cli → full → manual spot-check. Each gate must pass before the
next runs; if any fails, the refactor stops and the implementation is
revisited.
