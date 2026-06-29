/**
 * GoalComposerBadge — the in-composer AutoGoal indicator (variants A+B):
 *   • operator-colored step dots + "k/N" count (A)
 *   • the composer's left edge tinted to the active step's operator tone (B,
 *     applied by the parent via `indicator().bandColor`)
 *
 * Clicking focuses the AutoGoal tab. When there's no live goal it renders a
 * quiet "set goal" chip. The pure mapping lives in goal-composer-badge-pure.ts;
 * this file is the SolidJS hook (a lightweight 2s poll of goal state + chain)
 * and the presentational component.
 *
 * Note: this polls independently of the side panel's useGoal. One extra 2s
 * file read per open composer — acceptable, and isolated so it can't regress
 * the goal panel. A future refactor could lift goal state into a shared
 * session context and dedupe both readers.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import {
  chainMatchesGoal,
  parseRuntimeChainSnapshot,
  readGoalFromSdk,
  type GoalSdkClient,
  type GoalState,
  type RuntimeChainData,
} from "./goal-panel-pure"
import {
  GOAL_CHAIN_PATH,
  buildComposerGoalIndicator,
  type ComposerGoalIndicator,
} from "./goal-composer-badge-pure"

const POLL_MS = 2000

function workspaceFileContent(raw: unknown): string | null {
  if (typeof raw === "string") return raw
  if (raw && typeof raw === "object" && typeof (raw as { content?: unknown }).content === "string") {
    return (raw as { content: string }).content
  }
  return null
}

async function readChainFromSdk(sdk: GoalSdkClient, state: GoalState | null): Promise<RuntimeChainData | null> {
  try {
    const res = await sdk.client.file.read({ path: GOAL_CHAIN_PATH })
    const content = workspaceFileContent(res.data)
    if (!content || content.trim().length === 0) return null
    const chain = parseRuntimeChainSnapshot(JSON.parse(content))
    if (!chain) return null
    // Never show a stale chain from a previous goal/session.
    if (!chainMatchesGoal(chain, state)) return null
    return chain
  } catch {
    return null
  }
}

/** Poll goal state + chain and expose the composer indicator. */
export function useComposerGoalIndicator(): () => ComposerGoalIndicator {
  const sdk = useSDK() as unknown as GoalSdkClient
  const [indicator, setIndicator] = createSignal<ComposerGoalIndicator>(
    buildComposerGoalIndicator({ state: null, chain: null, now: Date.now() }),
  )

  const refresh = async () => {
    try {
      const store = await readGoalFromSdk(sdk)
      const state = store.state
      const chain = state && (state.status === "active" || state.status === "paused")
        ? await readChainFromSdk(sdk, state)
        : null
      setIndicator(buildComposerGoalIndicator({ state, chain, now: Date.now() }))
    } catch {
      // Best-effort flair — a failed read leaves the last indicator in place
      // rather than throwing into the composer.
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  return indicator
}

function kindLabel(kind: ComposerGoalIndicator["kind"], language: ReturnType<typeof useLanguage>): string {
  switch (kind) {
    case "active":
      return language.t("session.goal.composerBadge.running")
    case "paused":
      return language.t("session.goal.composerBadge.paused")
    case "stalled":
      return language.t("session.goal.composerBadge.stalled")
    default:
      return language.t("session.goal.composerBadge.idle")
  }
}

export function GoalComposerBadge(props: {
  indicator: ComposerGoalIndicator
  onOpen: () => void
  disabled?: boolean
}) {
  const language = useLanguage()
  const ind = () => props.indicator
  const live = () => ind().kind !== "idle"

  return (
    <button
      type="button"
      data-component="goal-composer-badge"
      data-kind={ind().kind}
      title={live() ? ind().title || kindLabel(ind().kind, language) : language.t("session.goal.composerBadge.idleHint")}
      aria-label={
        live()
          ? `${kindLabel(ind().kind, language)}${ind().stepTotal > 0 ? ` ${ind().stepCurrent}/${ind().stepTotal}` : ""}`
          : language.t("session.goal.composerBadge.idle")
      }
      disabled={props.disabled}
      onClick={() => props.onOpen()}
      class="group inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      classList={{
        "border-transparent text-text-weaker hover:bg-background-base/60 hover:text-text-weak": !live(),
        "text-white/90 hover:brightness-110": live(),
      }}
      style={
        live()
          ? {
              "border-color": `${ind().bandColor}66`,
              "background-color": `${ind().bandColor}1f`,
              color: ind().bandColor,
            }
          : {}
      }
    >
      <Show
        when={live()}
        fallback={
          <>
            <span class="i-target h-3 w-3" aria-hidden>
              ◎
            </span>
            <span>{language.t("session.goal.composerBadge.idle")}</span>
          </>
        }
      >
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          style={{ "background-color": ind().bandColor }}
          aria-hidden
        />
        <Show
          when={ind().stepTotal > 0}
          fallback={<span class="tabular-nums">{kindLabel(ind().kind, language)}</span>}
        >
          <span class="tabular-nums">
            {ind().stepCurrent}/{ind().stepTotal}
          </span>
          <span class="flex items-center gap-[2px]" aria-hidden>
            <For each={ind().dots}>
              {(dot) => (
                <span
                  class="h-[5px] w-[5px] rounded-[1.5px] transition-opacity"
                  style={{
                    "background-color": dot.color,
                    opacity: dot.active ? "1" : dot.done ? "0.85" : "0.3",
                  }}
                />
              )}
            </For>
          </span>
        </Show>
      </Show>
    </button>
  )
}
