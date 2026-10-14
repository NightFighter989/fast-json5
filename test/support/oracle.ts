import JSON5 from 'json5'
import { parse } from '../../src/index.js'

export type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

export function attempt(fn: () => unknown): Outcome {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Parse with the reference implementation. json5 `console.warn`s on raw U+2028/U+2029 inside
 * strings (valid JSON5, invalid ES5), which would flood fuzz output, so warnings are muted.
 */
export function json5Parse(text: string): Outcome {
  const warn = console.warn
  console.warn = () => {}
  try {
    return attempt(() => JSON5.parse(text))
  } finally {
    console.warn = warn
  }
}

export function fastParse(text: string): Outcome {
  return attempt(() => parse(text))
}
