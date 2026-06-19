/**
 * Built-in goal templates, bundled with the package so `/goal template <name>`
 * works out of the box. Users can still add their own at `.opencode/goals/<name>.json`
 * (the server checks that directory first, then falls back to these).
 */

import type { GoalPinnedModel } from "./goal-chain.js";
import type { GoalConstraints } from "./goal-state.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface GoalTemplate {
  description: string;
  condition: string;
  command?: string;
  constraints?: Partial<GoalConstraints>;
  /** v0.4.0+ — variable definitions with descriptions and optional defaults. */
  variables?: Record<string, { description: string; default?: string }>;
  /** v0.7.x — optional Desktop action metadata. */
  skills?: string[];
  model?: GoalPinnedModel | string;
  category?: string;
  tone?: string;
  elevation?: string;
}

export const BUILTIN_TEMPLATES: Record<string, GoalTemplate> = {
  // ── Prompt methods (no verify command — completion via the GOAL_COMPLETE
  // marker). These mirror the desktop dock's built-in Method Library
  // (opencode-source goal-panel-pure.ts DEFAULT_TEMPLATE_BUTTONS) so
  // `/goal template <id>` works the same from the CLI/TUI and the GUI. ──
  plan: {
    description: "Map the work before editing",
    condition:
      "Create a concise implementation plan for {scope}. Identify the files, sequence, risks, and verification needed before changing code.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current coding request" } },
    category: "Planning",
    tone: "violet",
    elevation: "raised",
  },
  build: {
    description: "Implement the planned change",
    condition:
      "Implement {scope} using the repository's existing patterns. Keep edits scoped, update nearby tests, and preserve unrelated work.",
    constraints: { maxTurns: 8, maxTimeMinutes: 30 },
    variables: { scope: { description: "Scope", default: "the planned coding change" } },
    category: "Building",
    tone: "blue",
    elevation: "raised",
  },
  debug: {
    description: "Reproduce and isolate a failure",
    condition:
      "Debug {scope}. Reproduce the failure, capture evidence, isolate the root cause, add a regression test where practical, and implement the smallest fix.",
    constraints: { maxTurns: 8, maxTimeMinutes: 30 },
    variables: { scope: { description: "Scope", default: "the reported failure" } },
    category: "Debugging",
    tone: "orange",
    elevation: "raised",
  },
  test: {
    description: "Run and repair behavior tests",
    condition:
      "Run the relevant behavior tests for {scope}. Reproduce failures, fix the underlying issue, and re-run the focused test until it is clean.",
    constraints: { maxTurns: 5, maxTimeMinutes: 20 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Testing",
    tone: "emerald",
    elevation: "flat",
  },
  validate: {
    description: "Prove the change works",
    condition:
      "Validate {scope}. Run the relevant tests, typechecks, builds, or UI checks; inspect failures; and fix regressions until the verification set is clean.",
    constraints: { maxTurns: 4, maxTimeMinutes: 15 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Testing",
    tone: "sky",
    elevation: "flat",
  },
  review: {
    description: "Review the diff for release risks",
    condition:
      "Review {scope}. Inspect the diff for bugs, missing tests, regressions, security issues, and operator-confusing behavior. Report concrete findings before changing code.",
    constraints: { maxTurns: 4, maxTimeMinutes: 15 },
    variables: { scope: { description: "Scope", default: "the current diff" } },
    category: "Review",
    tone: "fuchsia",
    elevation: "flat",
  },
  docs: {
    description: "Update relevant docs or handoff notes",
    condition:
      "Update documentation for {scope}. Keep it concise, accurate to the implementation, and focused on commands, operator behavior, and remaining risks.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Documentation",
    tone: "sky",
    elevation: "flat",
  },
  "wire-check": {
    description: "Trace UI controls to runtime effects",
    condition:
      "Trace the wiring for {scope}. For each visible control, identify the handler, deterministic state write, model-turn boundary, error path, and verification evidence.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current UI flow" } },
    category: "Review",
    tone: "blue",
    elevation: "flat",
  },
  "adversarial-scan": {
    description: "Try to break the proposed change",
    condition:
      "Adversarially scan {scope}. Exercise invalid inputs, stale state, missing files, repeated clicks, interrupted turns, and upstream/downstream regressions; harden the code where needed.",
    constraints: { maxTurns: 4, maxTimeMinutes: 15 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Review",
    tone: "fuchsia",
    elevation: "raised",
  },
  typecheck: {
    description: "Run and fix type-level verification",
    condition:
      "Typecheck {scope}. Find the repository's relevant typecheck command, run it, fix type errors without broad refactors, and re-run until clean.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Testing",
    tone: "emerald",
    elevation: "flat",
  },
  commit: {
    description: "Package verified work cleanly",
    condition:
      "Prepare a commit for {scope}. Review the diff, ensure verification has passed, stage only relevant files, and write a concise conventional commit message.",
    constraints: { maxTurns: 3, maxTimeMinutes: 10 },
    variables: { scope: { description: "Scope", default: "the current change" } },
    category: "Custom",
    tone: "violet",
    elevation: "flat",
  },
  "fix-lint": {
    description: "Fix all lint errors in the project",
    condition: "the lint command exits with code 0",
    command: "npm run lint",
    constraints: { maxTurns: 10, maxTimeMinutes: 15, maxTokens: 50000 },
  },
  "fix-types": {
    description: "Make the TypeScript type-check pass",
    condition: "tsc reports no type errors",
    command: "npx tsc --noEmit",
    constraints: { maxTurns: 10, maxTimeMinutes: 15, maxTokens: 50000 },
  },
  "pass-tests": {
    description: "Make the test suite pass",
    condition: "the test command exits with code 0 with no failing tests",
    command: "npm test",
    constraints: { maxTurns: 15, maxTimeMinutes: 20 },
  },
  "code-review": {
    // Heuristic mode (no `command`) — agent reviews by reading the diff
    // and emits GOAL_COMPLETE: when the review is done. Mirrors the
    // validate/debug pattern. Closes GAP-1 from the v0.7.0 audit
    // (SPEC REQ-011 listed code-review as a builtin; the entry was
    // missing from src/templates.ts).
    description: "Review recent code changes for quality and correctness",
    condition:
      "Review the recent code changes in this repository. Look for correctness issues, missing test coverage on changed paths, edge cases not handled, security concerns (especially anything touching user input, paths, or eval-equivalent), and readability regressions. Report findings as a numbered list. End with `GOAL_COMPLETE: <one-line summary>` when done.",
    constraints: { maxTurns: 5, maxTimeMinutes: 15 },
  },
};

// ── v0.4.0+ template engine ─────────────────────────────────────────────────

// Cap on template import file size. The `importTemplate` primitive already
// caps the content string length (line 175) — exported here so the CLI's
// file/stdin readers can apply the same cap at the read boundary, BEFORE
// allocating a 50MB+ string. (Red-team audit, Pass 2 — file I/O with user
// paths: a 50MB file is read in full and then rejected downstream.)
export const MAX_TEMPLATE_IMPORT_SIZE = 256 * 1024;

/** Replace {var} placeholders with values. Unresolved vars stay as literal "{var}". */
export function resolveTemplateVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/**
 * Pull every `{name}` token from a string. Matches the same shape
 * `resolveTemplateVars` replaces, so the validator and the resolver
 * stay in lock-step. Names are restricted to \w+ (letters, digits,
 * underscore) — same as the resolver regex.
 */
function referencedVars(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]!);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTemplateSkills(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length > 8) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return false;
    const skill = item.trim();
    if (!skill || skill.length > 80 || seen.has(skill)) return false;
    seen.add(skill);
  }
  return true;
}

function validTemplateModel(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0 && value.length <= 160;
  if (!isPlainObject(value)) return false;
  return (
    typeof value.providerID === "string" &&
    value.providerID.trim().length > 0 &&
    value.providerID.length <= 160 &&
    typeof value.modelID === "string" &&
    value.modelID.trim().length > 0 &&
    value.modelID.length <= 160
  );
}

/**
 * Validate a template:
 *  - shape check (condition is a string, command/description optional strings,
 *    variables is an optional object);
 *  - **v0.4.0**: every declared variable must appear in `condition` OR `command`
 *    (spec §"Template import security" step 5);
 *  - **v0.4.0**: no UNDEFINED variable may appear in `condition` (spec
 *    "validateTemplate: undefined vars in condition detected").
 *
 * Returning false in either case is what the import path relies on
 * (see `importTemplate`); the dispatcher never sees the difference
 * between "wrong shape" and "wrong variables" — both are
 * `Template must have at least a 'condition' string field.`
 */
export function validateTemplate(tpl: unknown): tpl is GoalTemplate {
  if (!tpl || typeof tpl !== "object" || Array.isArray(tpl)) return false;
  const t = tpl as Record<string, unknown>;
  if (typeof t.condition !== "string") return false;
  if (t.condition.trim().length === 0) return false;
  if (t.command !== undefined && t.command !== null && typeof t.command !== "string") return false;
  if (t.description !== undefined && typeof t.description !== "string") return false;
  if (t.skills !== undefined && !validTemplateSkills(t.skills)) return false;
  if (t.model !== undefined && !validTemplateModel(t.model)) return false;
  if (t.category !== undefined && typeof t.category !== "string") return false;
  if (t.tone !== undefined && typeof t.tone !== "string") return false;
  if (t.elevation !== undefined && typeof t.elevation !== "string") return false;
  // variables is optional
  if (t.variables !== undefined) {
    if (typeof t.variables !== "object" || Array.isArray(t.variables) || t.variables === null) return false;
  }

  const declaredKeys = t.variables ? Object.keys(t.variables as Record<string, unknown>) : [];
  const condRefs = referencedVars(t.condition as string);
  const cmdRefs = typeof t.command === "string" ? referencedVars(t.command) : new Set<string>();

  // Every declared var must be referenced in condition OR command.
  for (const k of declaredKeys) {
    if (!condRefs.has(k) && !cmdRefs.has(k)) return false;
  }
  // No undeclared var may appear in condition (command can have ad-hoc
  // tokens, but condition text drives the goal so we hold the line there).
  for (const r of condRefs) {
    if (!declaredKeys.includes(r)) return false;
  }
  return true;
}

/**
 * Discover all available templates (builtins + user).
 * Returns array of {name, description, builtin}.
 */
export function discoverTemplates(directory: string): { name: string; description: string; builtin: boolean }[] {
  const results: { name: string; description: string; builtin: boolean }[] = [];

  // Builtins
  for (const [name, tpl] of Object.entries(BUILTIN_TEMPLATES)) {
    results.push({ name, description: tpl.description, builtin: true });
  }

  // User templates in .opencode/goals/
  const userDir = join(directory, ".opencode", "goals");
  if (existsSync(userDir)) {
    try {
      for (const entry of readdirSync(userDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const name = entry.name.slice(0, -5);
        if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
        try {
          const filePath = join(userDir, entry.name);
          // v0.4.1 (E-4) — skip templates larger than the import cap
          // (same DoS class as B1/B2/B3 in the red-team report).
          if (statSync(filePath).size > MAX_TEMPLATE_IMPORT_SIZE) continue;
          const raw = JSON.parse(readFileSync(filePath, "utf-8"));
          // Run the same validator the import path uses. A user file
          // missing `condition` (or with declared-but-unused vars) is
          // a corrupt template, not a usable one — skip it from `list`
          // AND from `use` (see exportTemplate).
          if (validateTemplate(raw)) {
            results.push({ name, description: (raw as GoalTemplate).description, builtin: false });
          }
        } catch { /* skip invalid files */ }
      }
    } catch { /* directory read failed */ }
  }

  return results;
}

/** Export a template by name. User template takes priority over builtin. */
export function exportTemplate(directory: string, name: string): GoalTemplate | null {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const userPath = join(directory, ".opencode", "goals", `${name}.json`);
  if (existsSync(userPath)) {
    try {
      const raw = JSON.parse(readFileSync(userPath, "utf-8"));
      if (validateTemplate(raw)) return raw;
    } catch { /* fall through to builtin */ }
  }
  return BUILTIN_TEMPLATES[name] ?? null;
}

/** Import a user template. Returns ok or error.
 *
 * Order of checks is deliberate:
 *  1. **name regex** — reject path traversal / special chars before any I/O.
 *  2. **size cap** — 256KB (spec §"Template import oversized"). Done
 *     BEFORE `JSON.parse` so a 10MB attack payload doesn't burn CPU
 *     on parse just to be rejected.
 *  3. **JSON.parse** + **validateTemplate** — shape + variable rules.
 *  4. **atomic write** — temp + rename into `.opencode/goals/`.
 *
 * The temp filename includes pid + timestamp so two concurrent imports
 * with the same name (e.g. from the CLI test suite) don't clobber
 * each other's temp files.
 */
export function importTemplate(
  directory: string,
  name: string,
  content: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, error: `Invalid template name '${name}'. Use letters, numbers, hyphens, and underscores only.` };
  }
  if (content.length > MAX_TEMPLATE_IMPORT_SIZE) {
    return { ok: false, error: `Template file too large (max ${MAX_TEMPLATE_IMPORT_SIZE} bytes / 256KB).` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    return { ok: false, error: `Invalid JSON: ${err?.message ?? err}` };
  }
  if (!validateTemplate(parsed)) {
    return { ok: false, error: "Template must have at least a 'condition' string field, and every declared variable must be referenced in condition or command." };
  }

  const userDir = join(directory, ".opencode", "goals");
  if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true });

  const targetPath = join(userDir, `${name}.json`);
  const tmp = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    renameSync(tmp, targetPath);
  } catch (err: any) {
    try { unlinkSync(tmp); } catch { }
    return { ok: false, error: `Failed to write template: ${err?.message ?? err}` };
  }

  return { ok: true, path: targetPath };
}

/** Delete a user template from `.opencode/goals/`.
 * Built-in templates are intentionally not deletable; if a user file overrides
 * a built-in name, deleting it reveals the built-in again. */
export function deleteTemplate(
  directory: string,
  name: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, error: `Invalid template name '${name}'. Use letters, numbers, hyphens, and underscores only.` };
  }
  const targetPath = join(directory, ".opencode", "goals", `${name}.json`);
  if (!existsSync(targetPath)) {
    if (BUILTIN_TEMPLATES[name]) {
      return { ok: false, error: `Built-in template '${name}' cannot be deleted. Duplicate it to create an editable project template.` };
    }
    return { ok: false, error: `Project template '${name}' not found.` };
  }
  try {
    unlinkSync(targetPath);
    return { ok: true, path: targetPath };
  } catch (err: any) {
    return { ok: false, error: `Failed to delete template: ${err?.message ?? err}` };
  }
}
