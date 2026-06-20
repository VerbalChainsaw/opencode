export const MIN_TITLEBAR_ZOOM = 0.25
export const WINDOWS_CONTROLS_BASE_WIDTH = 138

export type TitlebarDraftRequest<ServerKey extends string = string> = {
  server: ServerKey
  directory: string
}

export function resolveTitlebarNewSessionDirectory(input: {
  currentDirectory?: string | null
  projectWorktrees: readonly (string | null | undefined)[]
}) {
  if (input.currentDirectory) return input.currentDirectory

  const firstProject = input.projectWorktrees[0]
  if (firstProject) return firstProject

  return undefined
}

export function readTitlebarDirectoryPickerSelection(result: string | readonly string[] | null | undefined) {
  const directory = typeof result === "string" ? result : result?.[0]
  if (!directory) return undefined

  return directory
}

export function titlebarDraftRequest<ServerKey extends string>(
  server: ServerKey,
  directory: string,
): TitlebarDraftRequest<ServerKey> {
  return { server, directory }
}

export function windowsControlsWidthCSS(zoom: number, baseWidth = WINDOWS_CONTROLS_BASE_WIDTH) {
  return `${baseWidth / Math.max(zoom, 1)}px`
}

export function electronTitlebarWidthCSS(windowsControlsWidth: string) {
  return `min(env(titlebar-area-width, calc(100vw - ${windowsControlsWidth})), calc(100vw - ${windowsControlsWidth}))`
}
