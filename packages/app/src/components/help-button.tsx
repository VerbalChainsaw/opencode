import { Icon } from "@opencode-ai/ui/v2/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"

export function HelpButton() {
  if (import.meta.env.VITE_OPENCODE_CHANNEL !== "dev") return null

  const language = useLanguage()
  const [state, setState] = /* persisted(Persist.global("help-button"), */ createStore({ dismissed: false }) /* ) */
  const [shown, setShown] = createSignal(false)

  return (
    <Show when={!state.dismissed}>
      <div class="fixed bottom-4 right-4 z-50">
        <Popover
          open={shown()}
          onOpenChange={setShown}
          triggerAs="button"
          triggerProps={{
            type: "button",
            "aria-label": language.t("sidebar.help"),
            class:
              "size-8 rounded-full bg-background-base shadow-[var(--shadow-lg-border-base)] flex items-center justify-center text-text-base hover:text-text-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong motion-reduce:transition-none",
          }}
          trigger={
            <span aria-hidden="true" class="text-12-medium leading-none">
              ?
            </span>
          }
          class="[&_[data-slot=popover-body]]:p-0 w-[min(320px,calc(100vw-2rem))] bg-transparent border-0 shadow-none rounded-lg"
          gutter={8}
          placement="top-end"
        >
          <Show when={shown()}>
            <div class="relative flex w-[min(320px,calc(100vw-2rem))] flex-col gap-2 rounded-lg border border-border-base bg-background-strong p-4 shadow-[var(--shadow-lg-border-base)]">
              <button
                type="button"
                aria-label={language.t("common.close")}
                class="absolute top-3.5 right-3.5 size-6 rounded-md flex items-center justify-center text-text-base hover:text-text-strong hover:bg-surface-raised-base-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong motion-reduce:transition-none"
                onClick={() => {
                  setShown(false)
                  setState("dismissed", true)
                }}
              >
                <Icon name="xmark-small" />
              </button>
              <span class="pr-8 text-14-medium text-text-strong">{language.t("help.dev.title")}</span>
              <p class="text-12-regular leading-5 text-text-base">{language.t("help.dev.body")}</p>
              <span class="text-11-regular text-text-weak">{language.t("help.dev.footer")}</span>
            </div>
          </Show>
        </Popover>
      </div>
    </Show>
  )
}
