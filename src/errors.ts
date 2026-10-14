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
    const { line, column } = positionOf(source, offset)
    super(`${reason} at line ${line}, column ${column}`)
    this.lineNumber = line
    this.columnNumber = column
    this.offset = offset
    this.code = code
    this.reason = reason
  }
}

function positionOf(src: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = src.indexOf('\n'); i !== -1 && i < offset; i = src.indexOf('\n', i + 1)) {
    line++
    lineStart = i + 1
  }
  return { line, column: offset - lineStart + 1 }
}

export function syntaxError(src: string, offset: number, code: JSON5ErrorCode, reason: string): JSON5SyntaxError {
  return new JSON5SyntaxError(src, offset, code, reason)
}

/**
 * `Unexpected character "x"` (or `Unexpected end of input`) for the code point at `offset`,
 * optionally followed by what was expected there.
 */
export function unexpected(src: string, offset: number, expected?: string): JSON5SyntaxError {
  const suffix = expected ? `; expected ${expected}` : ''
  if (offset >= src.length) return syntaxError(src, offset, 'UNEXPECTED_END', `Unexpected end of input${suffix}`)
  return syntaxError(src, offset, 'UNEXPECTED_CHARACTER', `Unexpected character ${describe(src.codePointAt(offset) as number)}${suffix}`)
}

/** `"x"` for visible characters; `U+XXXX` for controls, spaces and other invisible ones. */
function describe(cp: number): string {
  const invisible =
    cp < 0x21 || (cp >= 0x7f && cp <= 0xa0) || cp === 0xad || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x205f && cp <= 0x206f) || cp === 0x3000 || cp === 0xfeff ||
    (cp >= 0xd800 && cp <= 0xdfff)
  return invisible ? `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` : JSON.stringify(String.fromCodePoint(cp))
}
