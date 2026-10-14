import { internalize, restoreNaN } from './nan.js'
import { Scanner } from './transform.js'

/** Same signature as the reviver accepted by `JSON.parse`. */
export type Reviver = (this: any, key: string, value: any) => any

export interface ParseOptions {
  /** Called for every parsed value, exactly like the `JSON.parse` reviver. */
  reviver?: Reviver
  /**
   * How to handle the `Infinity`, `-Infinity` and `NaN` literals, which JSON cannot represent.
   * - `'allow'` (default): return them as numbers, as JSON5 specifies.
   * - `'reject'`: throw a `SyntaxError` at the literal. Overflowing numbers such as `1e400`
   *   are ordinary number literals and still parse to `Infinity`, as they do in `JSON.parse`.
   */
  nonFinite?: 'allow' | 'reject'
}

/**
 * Parse a JSON5 string. Drop-in compatible with `JSON5.parse(text, reviver)`.
 */
export function parse<T = any>(text: string, reviverOrOptions?: Reviver | ParseOptions): T {
  const options: ParseOptions =
    typeof reviverOrOptions === 'function' ? { reviver: reviverOrOptions } : (reviverOrOptions ?? {})
  // The scanner validates the whole document and throws positioned errors, so JSON.parse only
  // ever sees valid JSON.
  const scanner = new Scanner(String(text), options.nonFinite === 'reject')
  const json = scanner.run()
  if (!scanner.nan) return JSON.parse(json, options.reviver)

  // NaN path: swap sentinels back first, so a reviver only ever sees real NaN values.
  const value = restoreNaN(JSON.parse(json))
  return (options.reviver ? internalize({ '': value }, '', options.reviver) : value) as T
}
