# Desktop package notes

- Renderer process should only call `window.api` from `src/preload`.
- Main process should register IPC handlers in `src/main/ipc.ts`.
- This package is the required verification target when the user asks
  for the Electron/Desktop app. Launch it with `bun run dev` from this
  package, keep the Electron window open for live GUI testing, and
  relaunch the owned dev process/sidecar after plugin or server-side
  changes that cannot hot-reload into the running window.
