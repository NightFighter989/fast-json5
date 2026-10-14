export type PositionedSyntaxError = SyntaxError & { lineNumber: number; columnNumber: number }

/**
 * A SyntaxError located in the original source. Positions are 1-based and follow json5's rules:
 * only LF starts a new line and columns count UTF-16 code units.
 */
export function syntaxError(src: string, offset: number, message: string): PositionedSyntaxError {
  let line = 1
  let lineStart = 0
  for (let i = src.indexOf('\n'); i !== -1 && i < offset; i = src.indexOf('\n', i + 1)) {
    line++
    lineStart = i + 1
  }
  const column = offset - lineStart + 1
  const error = new SyntaxError(`${message} at line ${line}, column ${column}`) as PositionedSyntaxError
  error.lineNumber = line
  error.columnNumber = column
  return error
}

/** "Unexpected character 'x'" or "Unexpected end of input" for the code point at `offset`. */
export function unexpected(src: string, offset: number): PositionedSyntaxError {
  if (offset >= src.length) return syntaxError(src, offset, 'Unexpected end of input')
  const char = String.fromCodePoint(src.codePointAt(offset) as number)
  return syntaxError(src, offset, `Unexpected character ${JSON.stringify(char)}`)
}
