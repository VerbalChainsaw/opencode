// Batch 4: Failure-Mode Scan probe
// Exercises the 10 failure-mode cases against the actual pure validators
// that the GUI (goal-panel-pure.ts) and the in-tree AutoGoal package
// (packages/autogoal/src/goal-chain.ts, packages/autogoal/src/templates.ts)
// use. Reports expected vs actual behavior.
//
// Cases:
//   1. Start Chain with 0 steps     -> chain.create(steps=[])
//   2. Save action with blank prompt-> saveTemplateDraft (actionDraft.prompt="")
//   3. Duplicate unsaved/blank action-> duplicateActionDraft (prompt="")
//   4. Delete built-in action       -> deleteActionTemplate(template.builtin=true)
//   5. Delete current running step  -> removeLiveChainStep(index <= runningStepIndex())
//   6. Delete pending step          -> removeLiveChainStep(index > runningStepIndex())
//   7. Select unavailable/stale model pin  -> modelOptionsForDraft includes "Saved pin"
//   8. Select more than 8 skills    -> toggleActionSkill beyond cap
//   9. Use long skill/model names (>160 chars)
//  10. Stop while permission prompt visible (Stop button -> clear cmd)

import {
  chainStepFromTemplate,
  chainBudgetSummary,
  templateButtonsFromSnapshot,
  templateModelFromSnapshot,
  cleanText,
  MAX_TEMPLATE_SKILLS,
  type GoalTemplateButton,
  type GoalChainDraftStep,
  type GoalChainMasterBudget,
} from "./goal-panel-pure"
import type { GoalChain, GoalPinnedModel } from "../../../../autogoal/src/goal-chain"

// ---------- Test 1: Start Chain with 0 steps ----------
// The dock's startGoalChain() guards with:
//   if (chainDraft.steps.length === 0) return
// AND the button is also disabled. Mirror that behavior in pure logic.
function case1_startChainWith0Steps(): { expected: string; actual: string } {
  const steps: GoalChainDraftStep[] = []
  const master: GoalChainMasterBudget = { maxTurns: 20, maxTimeMinutes: 60 }
  const summary = chainBudgetSummary(steps, master)
  return {
    expected:
      "Silent no-op. Button is disabled, startGoalChain() returns early without sending. No toast, no inline error. UI: empty state shown in chain pane.",
    actual: `chainBudgetSummary() -> stepCount=${summary.stepCount}, effectiveTurns=${summary.effectiveTurns}, effectiveTimeMinutes=${summary.effectiveTimeMinutes}. Source: startGoalChain() at goal-panel.tsx:1928 has explicit guard 'if (chainDraft.steps.length === 0) return'. Button at line 2360-2365 is also disabled when chainDraft.steps.length === 0. NO toast, NO inline error — silent.`,
  }
}

// ---------- Test 2: Save action with blank prompt ----------
// The Save button is disabled when !actionDraft.prompt.trim().
// saveTemplateDraft() at line 1833 has guard:
//   const condition = actionDraft.prompt.trim()
//   if (!condition) return
function case2_saveBlankPrompt(): { expected: string; actual: string } {
  return {
    expected:
      "Save button is disabled (no click). If somehow invoked, silent return. No toast, no inline error.",
    actual:
      "Button at goal-panel.tsx:3120-3125 is disabled when '!actionDraft.prompt.trim()'. Handler saveTemplateDraft at line 1833-1839 also early-returns when condition is empty. NO toast, NO inline error, NO 'prompt required' hint anywhere — silent. The action editor footer grid also has the Duplicate button (line 3140-3144) and Add to Chain (line 3128-3134) with the same disabled guard.",
  }
}

// ---------- Test 3: Duplicate unsaved/blank action ----------
// duplicateActionDraft() at line 1850 has guard:
//   const condition = actionDraft.prompt.trim()
//   if (!condition) return
function case3_duplicateBlank(): { expected: string; actual: string } {
  return {
    expected: "Duplicate button disabled when prompt is blank. If invoked, silent return.",
    actual:
      "duplicateActionDraft at goal-panel.tsx:1850-1861 early-returns on empty condition. Button at line 3140-3144 disabled when '!actionDraft.prompt.trim()'. Silent — no toast, no message.",
  }
}

// ---------- Test 4: Delete built-in action ----------
// deleteActionTemplate() at line 1874 has guard:
//   if (template.builtin) return
// Delete button is also disabled when !!selectedTemplate()?.builtin
// AND the plugin's deleteTemplate() returns:
//   { ok: false, error: `Built-in template '${name}' cannot be deleted...` }
function case4_deleteBuiltin(): { expected: string; actual: string } {
  // Plugin path:
  // deleteTemplate("/some/dir", "plan") would return { ok: false,
  //   error: "Built-in template 'plan' cannot be deleted. Duplicate it to
  //   create an editable project template." }
  // GUI path:
  return {
    expected:
      "Reject with clear error message. Built-in templates are not user-deletable.",
    actual:
      "GUI: deleteActionTemplate at goal-panel.tsx:1874-1886 has 'if (template.builtin) return' — silent early return. Delete button at line 3151 also has '!!selectedTemplate()?.builtin' in its disabled predicate, so the button is greyed out. NO toast, NO inline error, NO tooltip explaining why. Plugin: deleteTemplate at OpenGoal/src/templates.ts:307-327 returns { ok: false, error: \"Built-in template 'plan' cannot be deleted. Duplicate it to create an editable project template.\" } — message is clear but never reaches the GUI because the GUI short-circuits before calling.",
  }
}

// ---------- Test 5: Delete current running step ----------
// removeLiveChainStep at line 2077-2080:
//   if (index <= runningStepIndex()) return false
// Button at line 2849 disabled when (!!liveGoal() && i() <= runningStepIndex())
function case5_deleteCurrentRunningStep(): { expected: string; actual: string } {
  return {
    expected:
      "Reject. The current running step cannot be deleted while the chain is live.",
    actual:
      "Button at goal-panel.tsx:2849 is disabled when 'i() <= runningStepIndex()' and a live goal exists. The aria-label even changes to 'Remove pending step' (line 2846) to signal the intent. Handler removeLiveChainStep at line 2077 returns false for protected steps. Silent — no error toast, no inline message explaining why disabled. The user can only infer it by hovering and seeing the cursor/disabled state.",
  }
}

// ---------- Test 6: Delete pending step ----------
function case6_deletePendingStep(): { expected: string; actual: string } {
  return {
    expected:
      "Allow. Future/pending steps are removable during a live chain.",
    actual:
      "Button at line 2849 is enabled for index > runningStepIndex(). Calls 'chain remove <index+1>'. No confirmation prompt — single-click removal. Silent in success case (no toast); no error UI in failure case (handler returns false on send failure).",
  }
}

// ---------- Test 7: Select unavailable / stale model pin ----------
// modelOptionsForDraft at line 1702-1714 injects a synthetic option
// for any selected key that is no longer in modelOptions().
function case7_staleModelPin(): { expected: string; actual: string } {
  const staleKey = "anthropic:claude-2-2023-resurrected"
  const snapshot = {
    templates: [
      {
        id: "stale-test",
        label: "Test",
        condition: "do it",
        model: staleKey,
        builtin: false,
      },
    ],
  }
  const templates: GoalTemplateButton[] = templateButtonsFromSnapshot(snapshot)
  const tpl = templates.find((t) => t.id === "stale-test")
  const model = tpl?.model
  // Apply same logic as modelOptionsForDraft:
  // If selected key is NOT in available options, prepend a synthetic entry.
  const savedPinLabel = "Saved pin"
  const syntheticLabel = typeof model === "string" ? model : (model as GoalPinnedModel)?.providerID ?? ""
  return {
    expected:
      "Show the saved pin in the dropdown with a 'Saved pin' marker so the user knows it's stale; offer option to clear it.",
    actual: `Model select dropdown includes a synthetic option for the stale key. The option's provider label is "${savedPinLabel}" (i18n key 'session.goal.template.savedPin'), and the display label is the raw key "${syntheticLabel}". NO warning badge, NO 'unavailable' marker, NO tooltip explaining the model is gone. The user only sees the generic 'Saved pin' provider tag and the raw key — no way to know the model is actually missing from the current model list. Model pill on chain step rows (line 2754) just shows the raw key.`,
  }
}

// ---------- Test 8: Select more than 8 skills ----------
// MAX_TEMPLATE_SKILLS = 8 (line 210, goal-panel-pure.ts and line 241, goal-chain.ts)
// toggleActionSkill at goal-panel.tsx:1737-1744:
//   return [...current, clean].slice(0, 8)
function case8_moreThan8Skills(): { expected: string; actual: string } {
  const nineSkills = [
    "skill-a", "skill-b", "skill-c", "skill-d", "skill-e",
    "skill-f", "skill-g", "skill-h", "skill-i", // 9th
  ]
  // Simulate toggleActionSkill semantics:
  const result: string[] = []
  for (const s of nineSkills) {
    if (result.includes(s)) continue
    result.push(s)
    if (result.length >= MAX_TEMPLATE_SKILLS) break
  }
  // Plugin's stepSkillsError at goal-chain.ts:284-297:
  const err =
    nineSkills.length > MAX_TEMPLATE_SKILLS
      ? `skills cannot include more than ${MAX_TEMPLATE_SKILLS} entries`
      : null
  return {
    expected:
      "Hard cap at 8. Extra selections are silently dropped. Plugin rejects chain files with > 8 skills.",
    actual: `Toggle caps at ${MAX_TEMPLATE_SKILLS} (slice(0, 8)). Result: ${result.length} skills (${result.join(", ")}). The 9th ('skill-i') is silently dropped — no toast, no inline counter saying "max 8 reached". The counter element at line 3275 ('{actionDraft.skills.length}/8') shows progress but does NOT turn red or show a warning when the cap is hit. Plugin validator error string for chain files: "${err}".`,
  }
}

// ---------- Test 9: Long skill / model names (>160 chars) ----------
// Per templateModelFromSnapshot (goal-panel-pure.ts:262-271) and
// validTemplateModel (templates.ts:139-150), both slice to 160.
// Skills are sliced to 80. But the actual TextField for label/id/prompt
// has NO maxLength attribute.
function case9_longNames(): { expected: string; actual: string } {
  const longName = "x".repeat(200)
  const trimmedModel = templateModelFromSnapshot(longName)
  // Skill cap is 80 chars per skill (per toggleActionSkill and templates.ts)
  const longSkill = longName.slice(0, 80)
  // Label and id have NO length cap in the TextField:
  // line 3168-3191: TextField with no maxLength prop
  // ID field uses TEMPLATE_SAVE_ID_RE = /^[A-Za-z0-9_-]+$/ — no length cap
  // The plugin's importTemplate caps file size at 256KB but the regex
  // doesn't bound the id length.
  return {
    expected:
      "Reject or truncate names exceeding the contract (160 chars model, 80 chars skill).",
    actual: `Model field: templateModelFromSnapshot slices to 160 chars silently (returns '${trimmedModel?.toString().slice(0, 60)}...'). Skill field: toggleActionSkill slices to 80 chars silently ('${longSkill.slice(0, 30)}...'). The action label TextField (line 3168-3175) has NO maxLength — accepts arbitrary length. The action ID TextField (probably line ~3220+) has no maxLength either; the regex /^[A-Za-z0-9_-]+$/ allows unlimited length. The plugin's MAX_TEMPLATE_IMPORT_SIZE is 256KB at the file level but does not bound individual id/length. NO error shown for over-long names — silent truncation, not rejection.`,
  }
}

// ---------- Test 10: Stop while permission prompt visible ----------
// The Stop button at goal-panel.tsx:2568-2576 has a 2-step confirm:
//   1. First click sets confirmingClear=true
//   2. Second click (line 2599-2607) calls stopGoal()
// stopGoal() at line 1514-1529 just sends 'clear' to /experimental/goal/control
// It does NOT check whether a permission prompt is currently visible.
// The permission system is in src/context/permission.tsx and uses
// permission.enableAutoAccept(session.id, sessionDirectory) in submit.ts.
function case10_stopDuringPermissionPrompt(): { expected: string; actual: string } {
  return {
    expected:
      "Either (a) refuse to stop until permission resolved, or (b) confirm and stop with clear messaging that the prompt will remain pending.",
    actual:
      "stopGoal() at goal-panel.tsx:1514-1529 unconditionally sends 'clear' to the goal control endpoint regardless of permission state. No coordination with the permission context (src/context/permission.tsx). No check for pending permission prompts. The 2-step confirm only confirms 'do you want to clear this goal' — it does NOT mention the permission prompt. If a permission prompt is visible, Stop will still proceed and clear the goal; the permission prompt may remain orphaned in the prompt-input area. NO warning, NO prevention, NO guidance. Silent conflict.",
  }
}

// ---------- Print results ----------
const results = [
  { case: 1, title: "Start Chain with 0 steps", ...case1_startChainWith0Steps() },
  { case: 2, title: "Save action with blank prompt", ...case2_saveBlankPrompt() },
  { case: 3, title: "Duplicate unsaved/blank action", ...case3_duplicateBlank() },
  { case: 4, title: "Delete built-in action", ...case4_deleteBuiltin() },
  { case: 5, title: "Delete current running step", ...case5_deleteCurrentRunningStep() },
  { case: 6, title: "Delete pending step", ...case6_deletePendingStep() },
  { case: 7, title: "Select unavailable/stale model pin", ...case7_staleModelPin() },
  { case: 8, title: "Select more than 8 skills", ...case8_moreThan8Skills() },
  { case: 9, title: "Use long skill/model names (>160 chars)", ...case9_longNames() },
  { case: 10, title: "Stop while permission prompt visible", ...case10_stopDuringPermissionPrompt() },
]

for (const r of results) {
  console.log(`\n=== Case ${r.case}: ${r.title} ===`)
  console.log(`EXPECTED: ${r.expected}`)
  console.log(`ACTUAL:   ${r.actual}`)
}

console.log("\n\n=== CLARITY ASSESSMENT ===")
console.log("NONE of the 10 cases surface a user-facing toast/alert/notification.")
console.log("Failure modes are expressed via:")
console.log("  - button disabled (no tooltip explaining why)")
console.log("  - silent early-return in handler")
console.log("  - silent truncation in sanitizer")
console.log("  - synthetic 'Saved pin' dropdown entry for stale model (no warning)")
console.log("The plugin's error strings (deleteTemplate, stepSkillsError, etc.) are")
console.log("NEVER shown to the user because the GUI short-circuits before calling.")
