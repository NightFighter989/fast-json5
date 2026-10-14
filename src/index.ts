import { transform } from './transform.js'

/** Same signature as the reviver accepted by `JSON.parse`. */
export type Reviver = (this: any, key: string, value: any) => any

export interface ParseOptions {
  /** Called for every parsed value, exactly like the `JSON.parse` reviver. */
  reviver?: Reviver
  /**
   * How to handle `Infinity`, `-Infinity` and `NaN`, which JSON cannot represent.
   * - `'allow'` (default): return them as numbers, as JSON5 specifies.
   * - `'reject'`: throw a `SyntaxError`, which keeps the fast path free of any fix-up work.
   */
  nonFinite?: 'allow' | 'reject'
}

/**
 * Parse a JSON5 string. Drop-in compatible with `JSON5.parse(text, reviver)`.
 */
export function parse<T = any>(text: string, reviverOrOptions?: Reviver | ParseOptions): T {
  const options: ParseOptions =
    typeof reviverOrOptions === 'function' ? { reviver: reviverOrOptions } : (reviverOrOptions ?? {})
  // TODO(phase 2): handle non-finite sentinels and map JSON.parse errors back to source positions.
  return JSON.parse(transform(String(text)), options.reviver)
}
