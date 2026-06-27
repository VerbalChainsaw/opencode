# Goal Panel / Mission Control Session Notes

## State persistence model

- The local chain draft lives in `sessionStorage` (`opencode.goalChainDraft.${sessionID || "workspace"}`). It survives navigation within a session but not a browser/Electron restart or storage clear.
- Template customizations (`deletedTemplateIDs`, `localTemplateOverrides`) are merged locally over the plugin snapshot. Hidden template IDs are persisted in sessionStorage with the active session key so poll refreshes do not resurrect hidden action cards.
- Built-in method templates (`DEFAULT_TEMPLATE_BUTTONS` in `goal-panel-pure.ts`) are always prepended by `templateButtonsFromSnapshot()`, but the GoalPanel delete button treats a built-in delete as "hide this action in the GUI session" instead of sending an impossible plugin delete.

## HMR & defensive rendering

- Enum/union-keyed style/object lookups in Solid components are vulnerable to stale Vite HMR instances. If the set of valid keys changes during rapid edits, a stale component instance may pass a key that no longer exists in the current map and white-screen. Provide runtime fallbacks for these lookups rather than assuming the prop value is always current.
