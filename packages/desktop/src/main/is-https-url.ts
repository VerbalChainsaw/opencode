/**
 * Per audit AUDIT-DEFECTS.md MED-33: validate the protocol of a URL
 * before the host process hands it to shell.openExternal. A renderer
 * could otherwise trick the host into executing a local program via
 * e.g. file://, javascript:, or ms-windows-store: URIs. Only https:
 * is allowed.
 *
 * Extracted to its own file (rather than colocated in ipc.ts) so
 * the test suite can pin the behavior without dragging in the
 * Electron module side effects.
 */

export function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:") {
      // eslint-disable-next-line no-console
      console.warn(
        `[ipc] refusing to open-link with non-https protocol: ${parsed.protocol}`,
      )
      return false
    }
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[ipc] refusing to open-link with invalid URL: ${String(err)}`)
    return false
  }
}
