/** Machine-readable reason for a {@link JSON5SyntaxError}. */
export type JSON5ErrorCode =
  | 'UNEXPECTED_CHARACTER'
  | 'UNEXPECTED_END'
  | 'UNTERMINATED_STRING'
  | 'UNTERMINATED_COMMENT'
  | 'LINE_BREAK_IN_STRING'
  | 'INVALID_ESCAPE'
  | 'INVALID_IDENTIFIER'
  | 'NON_FINITE_NOT_ALLOWED'

/**
 * Thrown by `parse()` for any input that is not valid JSON5. It is a `SyntaxError` (and its
 * `name` is `'SyntaxError'`), so existing `instanceof SyntaxError` checks and json5-style
 * `lineNumber` / `columnNumber` reads keep working.
 *
 * Positions follow json5's rules: 1-based, only LF starts a new line, and columns count UTF-16
 * code units. They always refer to the original input, never to the rewritten JSON.
 */
export class JSON5SyntaxError extends SyntaxError {
  /** 1-based line of the error. */
  readonly lineNumber: number
  /** 1-based column of the error, in UTF-16 code units. */
  readonly columnNumber: number
  /** 0-based UTF-16 offset of the error in the input. */
  readonly offset: number
  readonly code: JSON5ErrorCode
  /** The message without the position, e.g. `Unexpected character "x"; expected ':'`. */
  readonly reason: string

  constructor(source: string, offset: number, code: JSON5ErrorCode, reason: string) {
    let line = 1
    let lineStart = 0
    for (let i = source.indexOf('\n'); i >= 0 && i < offset; i = source.indexOf('\n', i + 1)) {
      line++
      lineStart = i + 1
    }
    const column = offset - lineStart + 1
    super(`${reason} at line ${line}, column ${column}`)
    this.lineNumber = line
    this.columnNumber = column
    this.offset = offset
    this.code = code
    this.reason = reason
  }
}

/** Letters, marks, numbers, punctuation and symbols print as themselves; anything else doesn't. */
const VISIBLE = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u

/** `"x"` for visible characters; `U+XXXX` for spaces, controls, format characters and lone surrogates. */
export function describe(cp: number): string {
  const char = String.fromCodePoint(cp)
  return VISIBLE.test(char) ? JSON.stringify(char) : `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
}
