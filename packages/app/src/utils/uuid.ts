// Per audit AUDIT-DEFECTS.md MED-25: log a warning whenever we
// fall back to Math.random() so the production telemetry surfaces the
// degraded state instead of silently accepting low-entropy IDs.
function fallback(): string {
  // eslint-disable-next-line no-console
  console.warn(
    "[uuid] crypto.randomUUID unavailable — falling back to Math.random(). " +
      "Generated IDs will be low-entropy; investigate the secure-context state.",
  )
  return Math.random().toString(16).slice(2)
}

export function uuid() {
  const c = globalThis.crypto
  if (!c || typeof c.randomUUID !== "function") return fallback()
  if (typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext) return fallback()
  try {
    return c.randomUUID()
  } catch {
    return fallback()
  }
}
