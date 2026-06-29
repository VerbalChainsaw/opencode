type PromptPlaceholderInput = {
  mode: "normal" | "shell"
  commentCount: number
  example: string
  suggest: boolean
  surface?: "legacy" | "design"
  t: (key: string, params?: Record<string, string>) => string
}

export function promptPlaceholder(input: PromptPlaceholderInput) {
  if (input.mode === "shell") return input.t("prompt.placeholder.shell", { example: input.example })
  if (input.commentCount > 1) return input.t("prompt.placeholder.summarizeComments")
  if (input.commentCount === 1) return input.t("prompt.placeholder.summarizeComment")
  if (input.surface === "design") return input.t("prompt.placeholder.design")
  if (!input.suggest) return input.t("prompt.placeholder.simple")
  return input.t("prompt.placeholder.normal", { example: input.example })
}

export function promptActionTabIndex(input: {
  mode: "normal" | "shell"
  hiddenInShell?: boolean
}) {
  if (input.hiddenInShell && input.mode !== "normal") return -1
  return undefined
}
