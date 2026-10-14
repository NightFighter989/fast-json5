import { internalize, restoreNaN } from './nan.js'
import { sawNaN, scanFast, scanStrict } from './transform.js'

export { JSON5SyntaxError, type JSON5ErrorCode } from './errors.js'

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
 *
 * @throws {JSON5SyntaxError} for invalid JSON5, with `lineNumber`, `columnNumber`, `offset` and
 *   `code` describing where and why. Errors thrown by a reviver propagate unchanged.
 */
export function parse<T = any>(text: string, reviverOrOptions?: Reviver | ParseOptions): T {
  const options: ParseOptions = typeof reviverOrOptions === 'function' ? { reviver: reviverOrOptions } : (reviverOrOptions ?? {})
  const src = String(text)
  const reject = options.nonFinite === 'reject'
  const reviver = options.reviver

  // Fast path: rewrite JSON5 tokens, skip plain JSON with native regex runs, and let JSON.parse
  // validate the structure. A token reader may throw on input it can't handle; that is not the
  // final error, which comes from the strict scanner below.
  let json: string | undefined
  try {
    json = scanFast(src, reject)
  } catch {}
  if (json !== undefined) {
    try {
      return build(json, sawNaN, reviver)
    } catch (error) {
      // A reviver's own exception must propagate as-is (and the reviver must not run twice).
      if (reviver && isValidJSON(json)) throw error
    }
  }

  // Slow path, only for invalid input or rare valid forms the fast path declines: the strict
  // scanner validates the full grammar, throwing a SyntaxError positioned in the original text.
  json = scanStrict(src, reject)
  return build(json, sawNaN, reviver)
}

function build<T>(json: string, nan: boolean, reviver: Reviver | undefined): T {
  if (!nan) return JSON.parse(json, reviver)
  // NaN path: swap sentinels back first, so a reviver only ever sees real NaN values.
  const value = restoreNaN(JSON.parse(json))
  return (reviver ? internalize({ '': value }, '', reviver) : value) as T
}

function isValidJSON(json: string): boolean {
  try {
    JSON.parse(json)
    return true
  } catch {
    return false
  }
}
