import type { Accessor } from "solid-js"
import { pathKey } from "@/utils/path-key"

export function ensureSessionKey(key: string, touch: (key: string) => void, seed: (key: string) => void) {
  touch(key)
  seed(key)
  return key
}

export function createSessionKeyReader(sessionKey: string | Accessor<string>, ensure: (key: string) => void) {
  const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey
  return () => {
    const value = key()
    ensure(value)
    return value
  }
}

export function pruneSessionKeys(input: {
  keep?: string
  max: number
  used: Map<string, number>
  view: string[]
  tabs: string[]
}) {
  if (!input.keep) return []

  const keys = new Set<string>([...input.view, ...input.tabs])
  if (keys.size <= input.max) return []

  const score = (key: string) => {
    if (key === input.keep) return Number.MAX_SAFE_INTEGER
    return input.used.get(key) ?? 0
  }

  return Array.from(keys)
    .sort((a, b) => score(b) - score(a))
    .slice(input.max)
}

export type ProjectDirectorySource = {
  worktree?: string
  sandboxes?: readonly string[]
}

export type OpenProjectDirectory = {
  worktree: string
}

export function knownProjectDirectoryKeys(projects: readonly ProjectDirectorySource[]) {
  const keys = new Set<string>()

  for (const project of projects) {
    if (project.worktree) keys.add(pathKey(project.worktree))

    for (const sandbox of project.sandboxes ?? []) {
      keys.add(pathKey(sandbox))
    }
  }

  return keys
}

export function shouldRestoreOpenProject(
  directory: string,
  known: ReadonlySet<string>,
  pending: ReadonlySet<string> = new Set(),
) {
  const key = pathKey(directory)
  // The server project table is metadata, not deletion authority. Home can add
  // a local folder before the backend has a project row for it, so keep
  // explicit user-opened directories visible and merge backend metadata later.
  return key.length > 0 || known.has(key) || pending.has(key)
}

export function staleOpenProjectDirectories(
  projects: readonly OpenProjectDirectory[],
  known: ReadonlySet<string>,
  pending: ReadonlySet<string> = new Set(),
) {
  return projects
    .filter((project) => !shouldRestoreOpenProject(project.worktree, known, pending))
    .map((project) => project.worktree)
}

export function unconfirmedOpenProjectDirectories(
  projects: readonly OpenProjectDirectory[],
  known: ReadonlySet<string>,
  pending: ReadonlySet<string> = new Set(),
) {
  return projects.flatMap((project) => {
    const key = pathKey(project.worktree)
    if (!key) return []
    if (known.has(key)) return []
    if (pending.has(key)) return []
    return [project.worktree]
  })
}

export function restorableOpenProjects<T extends OpenProjectDirectory>(
  projects: readonly T[],
  known: ReadonlySet<string>,
  pending: ReadonlySet<string> = new Set(),
) {
  return projects.filter((project) => shouldRestoreOpenProject(project.worktree, known, pending))
}
