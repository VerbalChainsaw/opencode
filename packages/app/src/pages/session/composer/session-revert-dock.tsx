import { For, createMemo } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { SessionDisclosureDock } from "./session-disclosure-dock"

export function SessionRevertDock(props: {
  items: { id: string; text: string }[]
  restoring?: string
  disabled?: boolean
  onRestore: (id: string) => void
}) {
  const language = useLanguage()
  const total = createMemo(() => props.items.length)
  const summary = createMemo(() =>
    language.t(total() === 1 ? "session.revertDock.summary.one" : "session.revertDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <SessionDisclosureDock
      component="session-revert-dock"
      summary={summary()}
      preview={preview()}
      expandLabel={language.t("session.revertDock.expand")}
      collapseLabel={language.t("session.revertDock.collapse")}
      defaultCollapsed={true}
      resetKey={`${props.items.length}:${props.items[0]?.id ?? ""}`}
    >
      <For each={props.items}>
        {(item) => (
          <div class="flex items-center gap-2 min-w-0 py-1">
            <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{item.text}</span>
            <Button
              size="small"
              variant="secondary"
              class="shrink-0"
              disabled={props.disabled || !!props.restoring}
              onClick={() => props.onRestore(item.id)}
            >
              {language.t("session.revertDock.restore")}
            </Button>
          </div>
        )}
      </For>
    </SessionDisclosureDock>
  )
}
