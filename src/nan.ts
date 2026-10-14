/**
 * NaN has no JSON spelling, so the scanner writes it as a sentinel string and parse() swaps it
 * back afterwards. The sentinel starts with NUL and ends with a per-process random suffix, so
 * input cannot produce it by accident and an attacker cannot guess it.
 */
const NUL = String.fromCharCode(0)
const SUFFIX = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`

export const NAN_SENTINEL: string = `${NUL}fast-json5:NaN:${SUFFIX}`
/** The sentinel as a JSON string literal (NUL must be escaped in JSON). */
export const NAN_SENTINEL_JSON: string = `"\\u0000fast-json5:NaN:${SUFFIX}"`

/** Replace every sentinel in a freshly parsed value with NaN. Iterative, so depth is unlimited. */
export function restoreNaN(root: unknown): unknown {
  if (root === NAN_SENTINEL) return Number.NaN
  if (typeof root !== 'object' || root === null) return root
  const stack: object[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown>
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const value: unknown = node[i]
        if (value === NAN_SENTINEL) node[i] = Number.NaN
        else if (typeof value === 'object' && value !== null) stack.push(value)
      }
    } else {
      for (const key of Object.keys(node)) {
        const value = node[key]
        if (value === NAN_SENTINEL) setOwn(node, key, Number.NaN)
        else if (typeof value === 'object' && value !== null) stack.push(value)
      }
    }
  }
  return root
}

/**
 * Apply a reviver the way JSON.parse does (ECMA-262 InternalizeJSONProperty), for the NaN path,
 * where the native reviver can't be used because it would see sentinels instead of NaN.
 */
export function internalize(holder: Record<string, unknown>, key: string, reviver: (this: any, key: string, value: any) => any): unknown {
  const value = holder[key]
  if (typeof value === 'object' && value !== null) {
    const node = value as Record<string, unknown>
    if (Array.isArray(node)) {
      const length = node.length
      for (let i = 0; i < length; i++) reviveChild(node, String(i), reviver)
    } else {
      for (const childKey of Object.keys(node)) reviveChild(node, childKey, reviver)
    }
  }
  return reviver.call(holder, key, value)
}

function reviveChild(node: Record<string, unknown>, key: string, reviver: (this: any, key: string, value: any) => any): void {
  const revived = internalize(node, key, reviver)
  if (revived === undefined) delete node[key]
  else setOwn(node, key, revived)
}

/** Assign an own data property; plain assignment to `__proto__` would change the prototype instead. */
function setOwn(node: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(node, key, { value, writable: true, enumerable: true, configurable: true })
  else node[key] = value
}
