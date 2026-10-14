/**
 * NaN has no JSON spelling, so the scanner writes it as a sentinel string and parse() swaps it
 * back afterwards. The sentinel starts with NUL and ends with a per-process random suffix, so
 * input cannot produce it by accident and an attacker cannot guess it.
 */
const NAN_SENTINEL = `${String.fromCharCode(0)}NaN${Math.random()}` // ~52 random bits
/** The sentinel as a JSON string literal (JSON.stringify escapes the NUL). */
export const NAN_SENTINEL_JSON: string = JSON.stringify(NAN_SENTINEL)

type Reviver = (this: any, key: string, value: any) => any

/**
 * Replace every sentinel in a freshly parsed value with NaN. Iterative, so depth is unlimited
 * (JSON.parse's native reviver overflows the stack at around 10k levels). Arrays from JSON.parse
 * have no holes, so Object.keys walks them correctly too.
 */
export function restoreNaN(root: unknown): unknown {
  if (root === NAN_SENTINEL) return Number.NaN
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== 'object' || node === null) continue
    for (const key of Object.keys(node)) {
      const value = (node as Record<string, unknown>)[key]
      if (value === NAN_SENTINEL) setOwn(node, key, Number.NaN)
      else stack.push(value)
    }
  }
  return root
}

/**
 * Apply a reviver the way JSON.parse does (ECMA-262 InternalizeJSONProperty), for the NaN path,
 * where the native reviver can't be used because it would see sentinels instead of NaN.
 */
export function internalize(holder: object, key: string, reviver: Reviver): unknown {
  const value = (holder as Record<string, unknown>)[key]
  if (typeof value === 'object' && value !== null) {
    for (const childKey of Object.keys(value)) {
      const revived = internalize(value, childKey, reviver)
      if (revived === undefined) delete (value as Record<string, unknown>)[childKey]
      else setOwn(value, childKey, revived)
    }
  }
  return reviver.call(holder, key, value)
}

/** Assign an own data property; plain assignment to `__proto__` would change the prototype instead. */
function setOwn(node: object, key: string, value: unknown): void {
  Object.defineProperty(node, key, { value, writable: true, enumerable: true, configurable: true })
}
