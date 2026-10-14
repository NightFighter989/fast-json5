/**
 * Compare two parsed JSON5 values. Returns `null` when they are identical, otherwise a description
 * of the first difference. Stricter than `toEqual`: distinguishes `-0` from `0`, treats `NaN` as
 * equal to itself, and checks own-key order and prototypes (so `__proto__` keys must be own properties).
 */
export function diffValues(actual: unknown, expected: unknown, path = '$'): string | null {
  if (!isObject(actual) || !isObject(expected)) {
    return Object.is(actual, expected) ? null : `${path}: got ${show(actual)}, expected ${show(expected)}`
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) {
    return `${path}: got ${Array.isArray(actual) ? 'array' : 'object'}, expected ${Array.isArray(expected) ? 'array' : 'object'}`
  }
  if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return `${path}: prototypes differ`

  const actualKeys = Object.getOwnPropertyNames(actual)
  const expectedKeys = Object.getOwnPropertyNames(expected)
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((k, i) => k !== expectedKeys[i])) {
    return `${path}: got keys ${JSON.stringify(actualKeys)}, expected ${JSON.stringify(expectedKeys)}`
  }
  for (const key of actualKeys) {
    const diff = diffValues(
      (actual as Record<string, unknown>)[key],
      (expected as Record<string, unknown>)[key],
      `${path}[${JSON.stringify(key)}]`,
    )
    if (diff) return diff
  }
  return null
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function show(value: unknown): string {
  if (Object.is(value, -0)) return '-0'
  if (typeof value === 'string') return JSON.stringify(value)
  if (isObject(value)) return Array.isArray(value) ? 'array' : 'object'
  return String(value)
}
