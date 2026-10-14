import { diffValues } from './equal.js'
import { fastParse, json5Parse, type Outcome } from './oracle.js'

/**
 * Assert fast-json5 and json5 agree on `text`: both return the same value, or both throw.
 * fast-json5 must throw a `SyntaxError`, never anything else.
 */
export function expectSameAsJson5(text: string): void {
  const expected = json5Parse(text)
  const actual = fastParse(text)

  if (actual.ok && expected.ok) {
    const diff = diffValues(actual.value, expected.value)
    if (diff) fail(text, `values differ at ${diff}`)
  } else if (actual.ok !== expected.ok) {
    fail(text, actual.ok ? `accepted, but json5 threw: ${message(expected)}` : `threw ${message(actual)}, but json5 accepted`)
  } else if (!actual.ok && !(actual.error instanceof SyntaxError)) {
    fail(text, `threw a non-SyntaxError: ${message(actual)}`)
  }
}

function message(outcome: Outcome): string {
  return outcome.ok ? 'no error' : outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
}

function fail(text: string, reason: string): never {
  throw new Error(`fast-json5 disagrees with json5: ${reason}\n  input: ${JSON.stringify(text)}`)
}
