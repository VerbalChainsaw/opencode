## Debugging

- Prefer using the currently running app/server when validating
  renderer-only changes.
- For Desktop/Electron E2E, server-side changes, plugin reloads, or
  stale-runtime bugs, restart or relaunch the owned local dev
  app/server/sidecar deliberately. First identify the target process or
  port, avoid killing unrelated processes, and record the PID/log path
  when practical.
- Browser validation is diagnostic only when the user asks for
  Electron, Desktop, or "the app". In that case, final GUI proof must
  come from the native Desktop window.

## Local Dev

- `opencode dev web` proxies `https://app.opencode.ai`, so local UI/CSS changes will not show there.
- For local UI changes, run the backend and app dev servers separately.
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- App (from `packages/app`): `bun dev -- --port 4444`
- Open `http://localhost:4444` to verify UI changes (it targets the backend at `http://localhost:4096`).
- For native Desktop verification, run `bun run dev` from
  `packages/desktop` and verify the Electron window. Plugin changes
  need the plugin package rebuilt and the Desktop sidecar relaunched.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
