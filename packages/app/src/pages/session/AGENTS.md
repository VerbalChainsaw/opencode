# Goal Panel / Mission Control Session Notes

## State persistence model

- The local chain draft lives in `sessionStorage` (`opencode.goalChainDraft.${sessionID || "workspace"}`). It survives navigation within a session but not a browser/Electron restart or storage clear.
- Template customizations (`deletedTemplateIDs`, `localTemplateOverrides`) are in-memory signals only. Deleting or overriding a built-in template hides it for the current session; it returns on the next reload.
- Built-in method templates (`DEFAULT_TEMPLATE_BUTTONS` in `goal-panel-pure.ts`) are always prepended to the action library. `templateButtonsFromSnapshot()` has no "replace" or "hide built-ins" mode, so users cannot permanently remove shipped defaults through the UI.

## HMR & defensive rendering

- Enum/union-keyed style/object lookups in Solid components are vulnerable to stale Vite HMR instances. If the set of valid keys changes during rapid edits, a stale component instance may pass a key that no longer exists in the current map and white-screen. Provide runtime fallbacks for these lookups rather than assuming the prop value is always current.
