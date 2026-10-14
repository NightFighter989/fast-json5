import { expect } from 'vitest'
import { parse } from '../../src/index.js'
import { json5Parse } from './oracle.js'

export interface SourcePosition {
  line: number
  column: number
}

export type PositionedSyntaxError = SyntaxError & { lineNumber?: number; columnNumber?: number }

/**
 * 1-based line and column of `offset` in `text`, using the same rules as json5: only LF starts a
 * new line (so CR and U+2028 do not), and columns count UTF-16 code units.
 */
export function positionAt(text: string, offset: number): SourcePosition {
  let line = 1
  let lineStart = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++
    lineStart = i + 1
  }
  return { line, column: offset - lineStart + 1 }
}

/**
 * Split a test source written with a `¦` marker at the expected error location into the real
 * input and that location, e.g. `markedPosition('{a ¦b: 1}')`.
 */
export function markedPosition(source: string, marker = '¦'): { text: string; position: SourcePosition } {
  const offset = source.indexOf(marker)
  if (offset === -1 || source.indexOf(marker, offset + 1) !== -1) {
    throw new Error(`expected exactly one ${marker} marker in ${JSON.stringify(source)}`)
  }
  const text = source.slice(0, offset) + source.slice(offset + marker.length)
  return { text, position: positionAt(text, offset) }
}

/** Run `fn`, assert it throws a SyntaxError, and return that error. */
export function syntaxErrorOf(fn: () => unknown): PositionedSyntaxError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(SyntaxError)
    return error as PositionedSyntaxError
  }
  throw new Error('expected a SyntaxError, but nothing was thrown')
}

/** Where fast-json5 reports the error for `text`. */
export function errorPosition(text: string): SourcePosition {
  const error = syntaxErrorOf(() => parse(text))
  return { line: error.lineNumber ?? Number.NaN, column: error.columnNumber ?? Number.NaN }
}

/** Where json5 reports the error for `text`. */
export function json5ErrorPosition(text: string): SourcePosition {
  const outcome = json5Parse(text)
  if (outcome.ok) throw new Error(`json5 accepted ${JSON.stringify(text)}`)
  const error = outcome.error as PositionedSyntaxError
  return { line: error.lineNumber ?? Number.NaN, column: error.columnNumber ?? Number.NaN }
}

/** Assert fast-json5 rejects a `¦`-marked source at the marker. */
export function expectErrorAtMarker(source: string): void {
  const { text, position } = markedPosition(source)
  expect(errorPosition(text), JSON.stringify(text)).toEqual(position)
}
