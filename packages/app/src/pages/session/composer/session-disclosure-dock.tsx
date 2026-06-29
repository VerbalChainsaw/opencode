import { DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { Show, createUniqueId, mergeProps, type JSX } from "solid-js"
import { createSessionDisclosureState } from "./session-disclosure-state"

export function SessionDisclosureDock(
  props: {
    component: string
    summary: string
    preview?: string
    expandLabel: string
    collapseLabel: string
    defaultCollapsed?: boolean
    resetKey?: string
    trayStyle?: JSX.CSSProperties
    bodyClass?: string
    children: JSX.Element
  },
) {
  const resolved = mergeProps(
    {
      defaultCollapsed: false,
      bodyClass: "px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar",
    },
    props,
  )
  const contentID = createUniqueId()
  const disclosure = createSessionDisclosureState({
    defaultCollapsed: resolved.defaultCollapsed,
    resetKey: () => resolved.resetKey,
  })

  return (
    <DockTray data-component={resolved.component} style={resolved.trayStyle}>
      <button
        type="button"
        class="w-full pl-3 pr-2 py-2 flex items-center gap-2 text-left"
        aria-expanded={!disclosure.collapsed()}
        aria-controls={contentID}
        onClick={() => disclosure.toggle()}
      >
        <span class="shrink-0 text-13-medium text-text-strong">{resolved.summary}</span>
        <Show when={disclosure.collapsed() && resolved.preview}>
          <span class="min-w-0 flex-1 truncate text-13-regular text-text-base">{resolved.preview}</span>
        </Show>
        <span class="ml-auto shrink-0">
          <Icon
            name="chevron-down"
            size="normal"
            class="transition-transform"
            style={{ transform: `rotate(${disclosure.collapsed() ? 180 : 0}deg)` }}
            aria-label={disclosure.collapsed() ? resolved.expandLabel : resolved.collapseLabel}
          />
        </span>
      </button>

      <Show when={disclosure.collapsed()}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={!disclosure.collapsed()}>
        <div id={contentID} class={resolved.bodyClass}>
          {resolved.children}
        </div>
      </Show>
    </DockTray>
  )
}
