export type StatusDotInput = {
  ready: boolean
  healthy: boolean
  serverHealth: boolean | undefined
  issue?: "critical" | "warning"
}

export function statusDotTone(input: StatusDotInput): "success" | "warning" | "critical" | "weak" {
  if (!input.ready || input.serverHealth === undefined) return "weak"
  if (input.serverHealth === false) return "critical"
  if (input.issue === "critical") return "critical"
  if (input.issue === "warning") return "warning"
  if (input.healthy) return "success"
  return "weak"
}
