import JSON5 from 'json5'
import { parse } from '../../src/index.js'
import { diffValues } from './equal.js'
import { attempt, fastParse, json5Parse, silenced, type Outcome } from './oracle.js'

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
    if (actual.ok && !expected.ok && isNewerUnicodeIdentifier(text, expected.error)) return
    fail(text, actual.ok ? `accepted, but json5 threw: ${message(expected)}` : `threw ${message(actual)}, but json5 accepted`)
  } else if (!actual.ok && !(actual.error instanceof SyntaxError)) {
    fail(text, `threw a non-SyntaxError: ${message(actual)}`)
  }
}

/**
 * Assert a reviver sees the same calls (key, value, holder type) in the same order under both
 * parsers, and that both return the same result. The reviver also edits values, so writes back
 * into holders are exercised: numbers are negated and keys named "a" are deleted.
 */
export function expectSameReviverCalls(text: string): void {
  const run = (parseWith: (text: string, reviver: Reviver) => unknown) => {
    const calls: unknown[] = []
    const reviver: Reviver = function (this: unknown, key, value) {
      calls.push([key, describe(value), Array.isArray(this) ? 'array' : typeof this])
      if (key === 'a') return undefined
      return typeof value === 'number' ? -value : value
    }
    const outcome = attempt(() => parseWith(text, reviver))
    return { calls, outcome }
  }
  const expected = run((t, r) => silenced(() => JSON5.parse(t, r)))
  const actual = run((t, r) => parse(t, r))

  if (!expected.outcome.ok) return // only valid documents are interesting here
  if (!actual.outcome.ok) fail(text, `threw ${message(actual.outcome)} with a reviver, but json5 accepted`)
  const diff = diffValues(actual.calls, expected.calls) ?? diffValues(actual.outcome.value, expected.outcome.value)
  if (diff) fail(text, `reviver behaviour differs at ${diff}`)
}

type Reviver = (this: unknown, key: string, value: unknown) => unknown

/** Values as the reviver saw them; containers are summarised since they're mutated later. */
function describe(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  return Array.isArray(value) ? `array(${value.length})` : `object(${Object.keys(value).join(',')})`
}

const ID_CHAR = /[\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]/u

/**
 * Known, intended difference: json5's identifier tables are from Unicode 10, while fast-json5
 * uses the engine's current Unicode data. True when json5 rejected `text` at an identifier
 * character (raw or `\uXXXX`-escaped) that current Unicode classes as a letter, mark, digit or
 * connector, i.e. one json5 rejects only because its tables are older.
 */
function isNewerUnicodeIdentifier(text: string, error: unknown): boolean {
  const { lineNumber, columnNumber, message } = error as { lineNumber?: number; columnNumber?: number; message?: string }
  if (!lineNumber || !columnNumber || !/invalid (identifier )?character/.test(message ?? '')) return false
  let offset = 0
  for (let line = 1; line < lineNumber; line++) offset = text.indexOf('\n', offset) + 1
  offset += columnNumber - 1
  const escaped = text.startsWith('\\u', offset) ? String.fromCharCode(parseInt(text.slice(offset + 2, offset + 6), 16)) : undefined
  const char = escaped ?? String.fromCodePoint(text.codePointAt(offset) ?? 0)
  return char.codePointAt(0)! > 127 && ID_CHAR.test(char)
}

function message(outcome: Outcome): string {
  return outcome.ok ? 'no error' : outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
}

function fail(text: string, reason: string): never {
  throw new Error(`fast-json5 disagrees with json5: ${reason}\n  input: ${JSON.stringify(text)}`)
}
