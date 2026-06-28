# GUI Integration - opencode-autogoal

This document is the current contract for GUI surfaces that render or
control OpenGoal state. The canonical consumer in this monorepo is the
OpenCode Desktop Goal panel:

- `packages/app/src/pages/session/goal-panel.tsx`
- `packages/app/src/pages/session/goal-panel-pure.ts`
- `packages/app/src/pages/session/goal-panel-actions.ts`

The old cross-repo assumption is retired. Desktop integration is in this
monorepo and must use the runtime paths and bridge described below.

## Source of truth

The runtime state is file-backed under the workspace root:

| File | Purpose |
|---|---|
| `.opencode/.goal-state.json` | Current goal state |
| `.opencode/.goal-chain.json` | Optional active chain snapshot |
| `.opencode/.goal-handoff.json` | Optional handoff payload |
| `.opencode/goal-archive.jsonl` | Terminal run history |

There is no event-push or SSE path for the Desktop Goal panel. The
renderer polls the workspace files through the OpenCode SDK and treats
the files as the source of truth.

## Goal state contract

The authoritative shape is the `GoalState` interface in
`packages/autogoal/src/goal-state.ts`.

```typescript
interface GoalState {
  version: number;
  id: string;
  condition: string;
  command?: string | null;
  verification?: Verification | null;
  status: "active" | "paused" | "achieved" | "cleared";
  createdAt: number;
  startedAt: number;
  completedAt: number | null;
  pausedAt: number | null;
  resumedAt: number | null;
  turnsEvaluated: number;
  tokensUsed: number;
  lastEvaluation: GoalEvaluation | null;
  evaluationHistory: GoalEvaluation[];
  constraints: {
    maxTurns: number;
    maxTimeMinutes: number;
    maxTokens: number;
  };
  metadata: {
    setBy: "user" | "template" | "chain";
    sessionId?: string;
    agentName?: string;
    conditionEditedAt?: number;
    previousId?: string;
    restartedAt?: number;
    steering?: Array<{ at: number; note: string }>;
    resumedFromHandoffAt?: number;
    chainId?: string;
    chainStep?: number;
    chainTotal?: number;
    webhook?: { url: string; on: Array<"active" | "paused" | "achieved" | "cleared">; allowLocal?: boolean };
    stepMarkerAt?: number;
  };
}
```

Renderer code cannot import the plugin validator directly, so the
Desktop panel mirrors the trust boundary in `isGoalStateShape`. Anything
that fails this structural check renders as corrupt state, never as a
typed goal.

## Reading state

The Desktop panel reads files with `sdk.client.file.read({ path })`.
The SDK normally returns a `FileContent` object with a `content` field,
but the renderer accepts either that object shape or a plain string.

```typescript
const res = await sdk.client.file.read({ path: ".opencode/.goal-state.json" });
const content = typeof res.data === "string" ? res.data : res.data?.content;
```

The polling interval is 2 seconds. A manual refresh should also run
immediately after a successful control action so the UI does not wait
for the next poll.

Read behavior:

- Missing state file means "no goal set".
- Empty state file means "no goal set".
- Oversized, unparsable, or structurally invalid state means "corrupt".
- Backend/network failure is not "no goal set"; render an unreachable
  backend state so the user can tell the app is not reading the workspace.

The same file-read pattern applies to chain, handoff, activity, and
archive snapshots. Chain data must be cross-checked against
`state.metadata.chainId`; a chain snapshot without a matching current
goal is stale and must not drive live controls.

## Writing controls

Desktop buttons do not mutate files directly. They call the native
goal-control bridge through `executeGoalCommand` in
`goal-panel-actions.ts`.

The plugin still exposes the public tool surface below for plugin/API
consumers. Desktop should treat `goal_control` as the deterministic
button bridge and should read live state through file polling, not
through a tool invocation.

| Tool | Args | Returns |
|---|---|---|
| `set_goal` | `{condition, command?, maxTurns?, maxMinutes?}` | The new state as user-facing text |
| `goal_get_state` | `{}` | JSON string of the current state or `"null"` |
| `goal_status` | `{}` | Short human-readable status string |
| `clear_goal` | `{}` | Confirmation string |
| `pause_goal` | `{}` | Confirmation string |
| `resume_goal` | `{}` | Confirmation string |
| `goal_turns` | `{n}` | Confirmation string; `n` in `[1, 10000]` |
| `goal_time` | `{n}` | Confirmation string; `n` in `[1, 10000]` |
| `goal_tokens` | `{n}` | Confirmation string; `n` in `[1, 10000000]` |
| `goal_condition` | `{text}` | Confirmation string |
| `goal_steer` | `{text}` | Confirmation string |
| `goal_clear_steering` | `{}` | Confirmation string |
| `goal_restart` | `{}` | Confirmation string |
| `goal_handoff` | `{note?}` | Confirmation string |
| `goal_claim` | `{}` | Confirmation string |
| `goal_webhook` | `{url?, on?, allowLocal?}` | Confirmation string |
| `goal_control` | `{command}` | Desktop bridge response text |

Preferred transport:

```typescript
await client.post({
  url: "/experimental/goal/control/{toolID}",
  path: { toolID: "goal_control" },
  query: { directory, workspace },
  body: {
    directory,
    workspace,
    sessionID,
    arguments: { command }
  }
});
```

The generated SDK `client.tool.control` method is a fallback only. A GUI
that cannot reach either bridge should disable write controls and show a
clear unavailable-control state.

`goal_control` returns user-facing dispatcher text only. It must not
return the agent-only "How to proceed" scaffold used when a model is
asked to start or continue work.

## Prompt-start controls

Some GUI actions intentionally start a model turn after the deterministic
state write. Examples include Start, Resume, Restart, and Steer. These
actions must use the guarded prompt helpers in `goal-panel-actions.ts`:

- `startGoalRunGuarded`
- `steerGoalRunGuarded`

The guard is part of the control contract. It checks admission before
delivery and again after delivery. If Stop, Pause, Reset, or another
newer control wins the race, the stale prompt is suppressed and any
late-started session is aborted.

Stop and Pause are hard controls:

- Invalidate pending prompt admissions.
- Abort the active session tree before the state transition.
- Send deterministic `clear` or `pause` through `goal_control`.
- Abort the active session tree again after the transition.
- Refresh the Goal panel surfaces.

This ordering prevents a late prompt from re-arming a cleared or paused
goal after the user pressed Stop or Pause.

## Rendering expectations

A useful Desktop Goal panel should render:

- Current condition and lifecycle status.
- Turns, elapsed time, token usage, and constraint ceilings.
- Verification command or structured verification summary.
- Latest evaluation reason and recent evaluation history.
- Chain progress when `metadata.chainId` matches the chain file.
- Handoff, steering, archive/history, and corrupt/unreachable states.
- Clear disabled states for controls that are invalid for the current
  lifecycle.

Terminal goals (`achieved` or `cleared`) are read-only except for
explicit restart/archive/history flows.

## Edge cases

- **State file missing**: render the new-goal empty state.
- **Corrupt state**: render a warning and do not render readouts from the
  invalid payload.
- **Backend unreachable**: render an unavailable-backend state, not the
  empty new-goal state.
- **Control bridge unavailable**: keep reads active but disable writes.
- **Terminal goal**: show read-only status and archive/history actions.
- **Live chain editing**: only pending future steps can be removed while
  a chain is active. The current or past step requires Stop or Reset.
- **Late prompt delivery**: suppress and abort stale prompt admissions
  after Stop, Pause, Reset, or a newer start/restart wins.

## Security

The state files are user-controlled workspace data. Renderer code must
enforce size caps before `JSON.parse`, structurally validate parsed
payloads, and sanitize user-controlled text before rendering.

Write controls must go through the bridge and the shared state/chain
primitives. A GUI must not hand-edit `.opencode/.goal-state.json` or
`.opencode/.goal-chain.json`.

## Versioning

The on-disk state schema is versioned by `state.version`. Package
version and state schema version are independent. Backward-incompatible
changes to the state file contract require a documented schema change
and corresponding renderer validation updates.
