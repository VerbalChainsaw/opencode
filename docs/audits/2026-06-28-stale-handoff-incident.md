# Stale-handoff runaway — incident + fix (2026-06-28)

## Incident (SunoSavvy)
Opening a fresh session in `C:/Users/zerop/Development/SunoSavvy` showed a
"claim this handoff" prompt already in the box. The handoff had been written
~Jun 24 and sat **unclaimed for ~3 days**; claiming it (`resumedFromHandoffAt`,
`metadata.setBy: "chain"`) **resumed an 8-step chain** and the auto-loop began
nudging through it. The operator could not stop it.

Emergency response: the SunoSavvy goal state was set `active → cleared` and the
chain file removed (auto-loop only drives `active`). Backed up to
`%TEMP%/sunosavvy-goal-backup-20260627-233705/` (reversible). Confirmed not
re-arming over a 15s window.

## Root cause (CENTER-AUDIT wf_5e11b0c7-efe, Angle A — CONFIRMED)
A handoff is intentionally cross-session, but:
1. **No age gate** on the claim path — `handoffPanelMode` returned `"claim"`
   purely on `(handoff exists) && (no live goal)`; `createdAt` was never
   consulted (`goal-panel-pure.ts`).
2. **Not in boot cleanup** — the plugin boot block unlinked terminal state +
   orphan chains but never touched `.goal-handoff.json` (`server.ts`), so a
   handoff lingered forever and auto-presented as a one-click claim.

(Adversarial verification of Angle A and Angles B/C did not complete — the
workflow hit a session token limit. Angle B's orchestration concern — a late
continuation firing at the chain — was independently addressed by the
`stale-suppressed` continuation work shipped in v1.17.9-vc1.)

## Fix (two-part, operator chose "both")

### Renderer guard (any age) — `goal-panel-pure.ts`, `goal-panel.tsx`, `en.ts`
- New pure helpers: `handoffAgeMs`, `isHandoffStale` (warn ≥ 1 day or
  unparseable), `formatHandoffAge` ("3 days ago"), `handoffOriginLabel`
  (short origin session id), plus `MAX_HANDOFF_AGE_MS` (7d) /
  `HANDOFF_WARN_AGE_MS` (1d).
- The claim panel now shows **age + origin session + "resumes an N-step chain"**,
  amber-warns when stale, and requires a **two-step confirm** ("Claim" →
  "Claim anyway"/"Cancel"). A bare click can never auto-claim. The confirm
  resets if the handoff stops being claimable.

### Boot auto-expire backstop (7 days) — `goal-state.ts`, `server.ts`
- Exported `MAX_HANDOFF_AGE_MS`. Boot cleanup quarantines a handoff older than
  7 days by renaming to `.goal-handoff.json.stale.<ts>` (recoverable, mirrors
  corrupt-file quarantine). A fresh handoff (legit "resume tomorrow") is
  preserved.

## Tests
- `goal-panel-pure.test.ts` (+10): age parsing, stale thresholds (incl. the
  3-day incident case), format buckets, origin label, threshold ordering.
- `boot-stale-handoff.test.mjs` (+3): 8-day handoff quarantined (recoverable),
  1-hour preserved, just-under-7-days preserved.

Verification: autogoal 1421/1424 (3 unrunnable shell tests), app 196/196 +
typecheck clean, desktop tsgo clean.
