import JSON5 from 'json5'
import { JSON5SyntaxError, parse } from '../../src/index.js'
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
  } else if (!actual.ok && !(actual.error instanceof JSON5SyntaxError)) {
    fail(text, `threw something other than JSON5SyntaxError: ${message(actual)}`)
  }
}

/**
 * When both parsers reject `text`, assert fast-json5 throws a JSON5SyntaxError at the same line
 * and column as json5, except for three documented, intentional differences (see PLAN.md §7):
 * - a line break as the offending character: json5 says (next line, column 0), we point at it;
 * - an astral character: json5's column is one past its start (its second UTF-16 unit);
 * - an unterminated block comment: json5 points at end of input, we point at the `/*`.
 */
export function expectSameErrorPosition(text: string): void {
  const expected = json5Parse(text)
  const actual = fastParse(text)
  if (expected.ok || actual.ok) return
  if (!(actual.error instanceof JSON5SyntaxError)) fail(text, `threw something other than JSON5SyntaxError: ${message(actual)}`)
  const ours = actual.error
  const theirs = expected.error as { lineNumber: number; columnNumber: number }
  if (ours.lineNumber === theirs.lineNumber && ours.columnNumber === theirs.columnNumber) return

  const char = text.codePointAt(ours.offset)
  const lineBreakQuirk = char === 10 && theirs.lineNumber === ours.lineNumber + 1 && theirs.columnNumber === 0
  const astralQuirk = char !== undefined && char > 0xffff && theirs.lineNumber === ours.lineNumber && theirs.columnNumber === ours.columnNumber + 1
  const commentQuirk = ours.code === 'UNTERMINATED_COMMENT'
  if (lineBreakQuirk || astralQuirk || commentQuirk || isNewerUnicodeIdentifier(text, expected.error)) return
  fail(text, `error at ${ours.lineNumber}:${ours.columnNumber} (${ours.reason}), json5 at ${theirs.lineNumber}:${theirs.columnNumber}`)
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
  // json5's column for an astral character points at its second UTF-16 unit.
  const unit = text.charCodeAt(offset)
  if (unit >= 0xdc00 && unit <= 0xdfff && offset > 0) offset--
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
