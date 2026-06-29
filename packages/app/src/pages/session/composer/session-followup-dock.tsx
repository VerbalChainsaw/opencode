import { For, createMemo } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { SessionDisclosureDock } from "./session-disclosure-dock"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
}) {
  const language = useLanguage()
  const total = createMemo(() => props.items.length)
  const summary = createMemo(() =>
    language.t(total() === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <SessionDisclosureDock
      component="session-followup-dock"
      summary={summary()}
      preview={preview()}
      expandLabel={language.t("session.followupDock.expand")}
      collapseLabel={language.t("session.followupDock.collapse")}
      trayStyle={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <For each={props.items}>
        {(item) => (
          <div class="flex items-center gap-2 min-w-0 py-1">
            <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{item.text}</span>
            <Button
              size="small"
              variant="secondary"
              class="shrink-0"
              disabled={!!props.sending}
              onClick={() => props.onSend(item.id)}
            >
              {language.t("session.followupDock.sendNow")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              class="shrink-0"
              disabled={!!props.sending}
              onClick={() => props.onEdit(item.id)}
            >
              {language.t("session.followupDock.edit")}
            </Button>
          </div>
        )}
      </For>
    </SessionDisclosureDock>
  )
}
