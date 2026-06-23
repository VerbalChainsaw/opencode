/** True for plain objects (`{}` or `new Object()`), false for arrays, null, and primitives. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for finite numbers; false for NaN, Infinity, -Infinity, and non-numbers. */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
