import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as uk } from "./uk"
import { dict as th } from "./th"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import { dict as tr } from "./tr"
import { mergeDictionaryWithFallback } from "../context/language"

const locales = [ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, uk, th, tr, zh, zht]
const keys = ["command.session.previous.unseen", "command.session.next.unseen"] as const

describe("i18n parity", () => {
  test("non-English locales translate targeted unseen session keys", () => {
    for (const locale of locales) {
      for (const key of keys) {
        expect(locale[key]).toBeDefined()
        expect(locale[key]).not.toBe(en[key])
      }
    }
  })

  test("GoalPanel keys have an explicit English fallback in every locale", () => {
    const goalKeys = Object.keys(en).filter((key) => key.startsWith("session.goal."))
    expect(goalKeys.length).toBeGreaterThan(100)

    for (const locale of locales) {
      const merged = mergeDictionaryWithFallback(en, locale)
      for (const key of goalKeys) {
        expect(merged[key]).toBeDefined()
      }
    }

    const zhMerged = mergeDictionaryWithFallback(en, zh)
    expect(zhMerged["session.goal.chainBuilder.shortTitle"]).toBe(zh["session.goal.chainBuilder.shortTitle"])
  })

  test("Chinese locales translate every GoalPanel key directly (no English fallback)", () => {
    const goalKeys = Object.keys(en).filter((key) => key.startsWith("session.goal."))
    for (const [name, locale] of [["zh", zh], ["zht", zht]] as const) {
      const entries = locale as Record<string, string | undefined>
      const missing = goalKeys.filter((key) => entries[key] === undefined)
      expect(missing, `${name} is missing GoalPanel keys: ${missing.join(", ")}`).toEqual([])
    }
  })

  test("GoalPanel corrupt-state recovery copy points to the in-panel reset control", () => {
    for (const locale of [en, ...locales]) {
      const merged = mergeDictionaryWithFallback(en, locale)
      expect(merged["session.goal.error.corrupt.reset"]).toBeDefined()
      expect(merged["session.goal.error.corrupt.hint"]).toBeDefined()
      expect(merged["session.goal.error.corrupt.hint"]).not.toMatch(/\/goal\s+clear|in the chat|chat to reset/i)
    }
  })

  test("GoalPanel control hint is GUI-first, not chat-only", () => {
    for (const locale of [en, ...locales]) {
      const merged = mergeDictionaryWithFallback(en, locale)
      expect(merged["session.goal.controlsHint"]).toBeDefined()
      expect(merged["session.goal.controlsHint"]).not.toMatch(/^Control from chat:/i)
    }
  })
})
