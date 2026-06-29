import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { onCleanup, onMount, type Accessor } from "solid-js"

export function computeDockPromptMaxHeight(input: {
  stickyBottom: number
  dockBottom: number
  promptBottom: number
  minHeight: number
  gap?: number
}) {
  const below = Math.max(0, input.dockBottom - input.promptBottom)
  return Math.max(input.minHeight, Math.floor(input.dockBottom - input.stickyBottom - (input.gap ?? 8) - below))
}

export function updateDockPromptMaxHeight(input: {
  root: HTMLDivElement | undefined
  cssVar: string
  minHeight: number
}) {
  const root = input.root
  if (!root) return

  const scroller = document.querySelector(".scroll-view__viewport")
  const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
  const stickyBottom =
    head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
  if (!stickyBottom) {
    root.style.removeProperty(input.cssVar)
    return
  }

  const dock = root.closest('[data-component="session-prompt-dock"]')
  if (!(dock instanceof HTMLElement)) return

  root.style.setProperty(
    input.cssVar,
    `${computeDockPromptMaxHeight({
      stickyBottom,
      dockBottom: dock.getBoundingClientRect().bottom,
      promptBottom: root.getBoundingClientRect().bottom,
      minHeight: input.minHeight,
    })}px`,
  )
}

export function useDockPromptMaxHeight(input: {
  root: Accessor<HTMLDivElement | undefined>
  cssVar: string
  minHeight: number
}) {
  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        updateDockPromptMaxHeight({
          root: input.root(),
          cssVar: input.cssVar,
          minHeight: input.minHeight,
        })
      })
    }

    update()

    makeEventListener(window, "resize", update)

    const dock = input.root()?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })
  })
}
