import { useToast } from "../ui/toast"
import path from "path"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"
import type { PromptInfo } from "./history"

export type StashEntry = {
  input: string
  parts: PromptInfo["parts"]
  timestamp: number
}

export const MAX_STASH_ENTRIES = 50

export function parsePromptStash(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as StashEntry
      } catch {
        return undefined
      }
    })
    .filter((line): line is StashEntry => line !== undefined)
    .slice(-MAX_STASH_ENTRIES)
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const paths = useTuiPaths()
    const toast = useToast()
    const stashPath = path.join(paths.state, "prompt-stash.jsonl")
    onMount(async () => {
      const lines = parsePromptStash(await readText(stashPath).catch((err) => { console.warn("Failed to read prompt stash", err); return "" }))
      setStore("entries", lines)
      if (lines.length > 0)
        writeText(stashPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n").catch((err) => { console.warn("Failed to write prompt stash", err); toast.show({ variant: "error", message: "Failed to save prompt stash" }) })
    })

    const [store, setStore] = createStore({ entries: [] as StashEntry[] })

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.entries.push(stash)
            if (draft.entries.length > MAX_STASH_ENTRIES) {
              draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
              trimmed = true
            }
          }),
        )

        if (trimmed) {
          writeText(stashPath, store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n").catch((err) => { console.warn("Failed to write prompt stash", err); toast.show({ variant: "error", message: "Failed to save prompt stash" }) })
          return
        }
        appendText(stashPath, JSON.stringify(stash) + "\n").catch((err) => { console.warn("Failed to append prompt stash", err); toast.show({ variant: "error", message: "Failed to save prompt stash" }) })
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(produce((draft) => void draft.entries.pop()))
        writeText(
          stashPath,
          store.entries.length > 0 ? store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n" : "",
        ).catch((err) => { console.warn("Failed to write prompt stash after pop", err); toast.show({ variant: "error", message: "Failed to save prompt stash" }) })
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        setStore(produce((draft) => void draft.entries.splice(index, 1)))
        writeText(
          stashPath,
          store.entries.length > 0 ? store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n" : "",
        ).catch((err) => { console.warn("Failed to write prompt stash after remove", err); toast.show({ variant: "error", message: "Failed to save prompt stash" }) })
      },
    }
  },
})
