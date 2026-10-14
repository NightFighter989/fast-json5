import { syntaxError, unexpected } from './errors.js'
import { NAN_SENTINEL_JSON } from './nan.js'

// Character codes. Non-ASCII characters are written as numbers so source files stay ASCII.
const TAB = 9
const LF = 10
const VT = 11
const FF = 12
const CR = 13
const SPACE = 32
const DOUBLE_QUOTE = 34
const SINGLE_QUOTE = 39
const PLUS = 43
const COMMA = 44
const MINUS = 45
const DOT = 46
const SLASH = 47
const ZERO = 48
const NINE = 57
const COLON = 58
const BACKSLASH = 92
const OPEN_BRACKET = 91
const CLOSE_BRACKET = 93
const OPEN_BRACE = 123
const CLOSE_BRACE = 125
const ASTERISK = 42
const LINE_SEPARATOR = 0x2028
const PARAGRAPH_SEPARATOR = 0x2029
const ZWNJ = 0x200c
const ZWJ = 0x200d

// What the scanner expects next.
const VALUE = 0 // a value (document start, after ':')
const ELEMENT = 1 // a value or ']' (after '[' or ',' in an array)
const KEY = 2 // a key or '}' (after '{' or ',' in an object)
const AFTER_KEY = 3 // ':'
const AFTER_VALUE = 4 // ',', a closer, or end of input at the top level

/**
 * The fast path's workhorse: consumes a maximal run of plain-JSON tokens (and JSON whitespace) in
 * one native regex call, with no structure checks; JSON.parse validates structure afterwards.
 * Each alternative refuses to consume a token that is really the start of JSON5 syntax, so the
 * run stops exactly where a rewrite may be needed. Alternatives are ordered by frequency, and
 * punctuation and commas swallow the whitespace after them; that order measured ~35% faster.
 * The rules:
 * - strings: only those whose escapes are all valid JSON;
 * - numbers: not if JSON5 continues them (`5.`, `0x1`, `1.e5`), so the JSON5 number is read whole;
 * - literals: only when JSON whitespace and `,` `]` `}` or the end follow, so identifiers
 *   (`trueish`) and keys (`null:`, or a comment before the colon) are left for the JS word handler;
 * - commas: only when a plain-JSON token follows, so a possibly-trailing comma (before a closer,
 *   a comment, JSON5 whitespace or JSON5 syntax) is left for the JS trailing-comma check.
 */
const JSON_RUN =
  /(?:"[^"\\\x00-\x1f]*(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})[^"\\\x00-\x1f]*)*"|[{}[\]:][ \t\n\r]*|[ \t\n\r]+|,[ \t\n\r]*(?=["[{0-9tfn-])|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?(?![.eExX0-9])|(?:true|false|null)(?=[ \t\n\r]*(?:[,\]}]|$)))*/y

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
const JSON5_NUMBER = /([+-]?)(?:0[xX]([0-9a-fA-F]+)|(Infinity)|(NaN)|(0|[1-9][0-9]*)?(\.[0-9]*)?([eE][+-]?[0-9]+)?)/y
const DOUBLE_QUOTED_RUN = /[^"\\\x00-\x1f]*/y
const SINGLE_QUOTED_RUN = /[^'"\\\x00-\x1f]*/y
const LINE_COMMENT_BODY = new RegExp(`[^\n\r${String.fromCharCode(LINE_SEPARATOR, PARAGRAPH_SEPARATOR)}]*`, 'y')
const ASCII_IDENTIFIER_PART = /[A-Za-z0-9$_]*/y
// ES5 IdentifierStart / IdentifierPart categories, as the JSON5 spec defines them.
const UNICODE_ID_START = /[\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}]/u
const UNICODE_ID_PART = /[\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]/u

/** Overflows to Infinity in every conforming JSON.parse, so it stands in for Infinity with no fix-up. */
const INFINITY_JSON = '1e400'

/**
 * Rewrite JSON5 source into JSON that `JSON.parse` turns into the same value.
 * Returns the input string itself when it contains no JSON5-only syntax.
 * Throws a SyntaxError, positioned in `src`, for anything that is not valid JSON5.
 *
 * The scanner checks the full JSON5 grammar at token level, so `JSON.parse` only ever sees valid
 * JSON; its job is building the values, which is where the time would otherwise go.
 */
export function transform(src: string): string {
  return new Scanner(src).run()
}

export class Scanner {
  readonly src: string
  /** Throw on Infinity, -Infinity and NaN literals instead of converting them. */
  readonly rejectNonFinite: boolean
  /** Set once a NaN sentinel has been written; parse() then restores NaN after JSON.parse. */
  nan = false
  pos = 0
  /** Start of the source not yet copied into `out`. */
  last = 0
  /** Output so far, up to `last`. */
  out = ''
  /** Whether any edit happened; if not, the input is returned as-is. */
  edited = false

  constructor(src: string, rejectNonFinite = false) {
    this.src = src
    this.rejectNonFinite = rejectNonFinite
  }

  run(): string {
    const src = this.src
    /** One entry per open container: true for an object, false for an array. */
    const stack: boolean[] = []
    let state = VALUE

    for (;;) {
      const c = this.skipSpace()
      const at = this.pos

      if (state === AFTER_VALUE) {
        if (c === COMMA && stack.length > 0) {
          // Trailing comma: a closer is next. Decided by lookahead, so edits stay in source order.
          const next = src.charCodeAt(this.lookahead(at + 1))
          if (next === CLOSE_BRACKET || next === CLOSE_BRACE) this.edit(at, at + 1, ' ')
          this.pos = at + 1
          state = stack[stack.length - 1] ? KEY : ELEMENT
        } else if ((c === CLOSE_BRACKET || c === CLOSE_BRACE) && stack.length > 0 && stack[stack.length - 1] === (c === CLOSE_BRACE)) {
          stack.pop()
          this.pos = at + 1
        } else if (c === -1 && stack.length === 0) {
          return this.finish()
        } else {
          const expected = stack.length === 0 ? 'end of input' : stack[stack.length - 1] ? "',' or '}'" : "',' or ']'"
          throw unexpected(src, at, expected)
        }
        continue
      }

      if (state === AFTER_KEY) {
        if (c !== COLON) throw unexpected(src, at, "':' after a key")
        this.pos = at + 1
        state = VALUE
        continue
      }

      if ((state === KEY && c === CLOSE_BRACE) || (state === ELEMENT && c === CLOSE_BRACKET)) {
        stack.pop()
        this.pos = at + 1
        state = AFTER_VALUE
        continue
      }

      if (state === KEY) {
        if (c === DOUBLE_QUOTE || c === SINGLE_QUOTE) this.string(c)
        else if (isAsciiIdentifierStart(c) || c === BACKSLASH || c > 127) this.identifier()
        else throw unexpected(src, at, "a key or '}'")
        state = AFTER_KEY
        continue
      }

      // VALUE or ELEMENT: a value must start here.
      if (c === OPEN_BRACE) {
        stack.push(true)
        this.pos = at + 1
        state = KEY
      } else if (c === OPEN_BRACKET) {
        stack.push(false)
        this.pos = at + 1
        state = ELEMENT
      } else {
        if (c === DOUBLE_QUOTE || c === SINGLE_QUOTE) this.string(c)
        else if ((c >= ZERO && c <= NINE) || c === MINUS || c === PLUS || c === DOT || c === 73 /* I */ || c === 78 /* N */) this.number()
        else if (c === 116 || c === 102 || c === 110) this.literal() // t f n
        else throw unexpected(src, at, state === ELEMENT ? "a value or ']'" : 'a value')
        state = AFTER_VALUE
      }
    }
  }

  /**
   * Fast path. Skips plain JSON with one regex call per run and rewrites only JSON5 tokens, each
   * under a local rule that can only make invalid JSON5 *stay* invalid; structure is left for
   * JSON.parse to validate. Returns undefined when it meets anything it can't rewrite with
   * certainty; the caller then falls back to the strict `run()`, which also produces the error.
   *
   * Soundness (the output parses only if the input is valid JSON5, to the same value) rests on:
   * - every rewrite turns one JSON5 token into a JSON token with the same meaning and role;
   * - comments and whitespace become a space, so neighbouring tokens never merge;
   * - a comma is dropped only between a complete value and a closer;
   * - a bare word is quoted only when followed by `:`, so it can only ever end up as a key;
   * - a number or word rewritten here must not touch an identifier character or digit on either
   *   side, as JSON5's own tokenizer requires (otherwise `1Infinity` could become `11e400`).
   */
  runLax(): string | undefined {
    const src = this.src
    const n = src.length
    let i = 0
    // Last significant source character before `i`, for the trailing-comma rule (-1: none yet).
    let prev = -1
    for (;;) {
      let c = src.charCodeAt(i)
      let runEnd = i
      // Skip the regex call when the next token can only be JSON5 (the run would be empty).
      if (!(c === SINGLE_QUOTE || c === SLASH || (isAsciiIdentifierStart(c) && c !== 116 && c !== 102 && c !== 110))) {
        JSON_RUN.lastIndex = i
        JSON_RUN.test(src)
        runEnd = JSON_RUN.lastIndex
        if (runEnd >= n) return this.finish()
        c = src.charCodeAt(runEnd)
      }
      if (runEnd > i) {
        // Only the comma rule reads `prev`, and only commas, comments and whitespace can come
        // between the run and that comma; every other handler below sets `prev` itself.
        if (c === COMMA || c === SLASH || c === VT || c === FF || c > 127) {
          let k = runEnd - 1
          while (k >= i && isJsonSpace(src.charCodeAt(k))) k--
          if (k >= i) prev = src.charCodeAt(k)
        }
        i = runEnd
      }

      if (c === COMMA) {
        // Not consumed by JSON_RUN, so it may be trailing: followed by a closer or a comment.
        const next = src.charCodeAt(this.lookahead(i + 1))
        if ((next === CLOSE_BRACKET || next === CLOSE_BRACE) && prev !== -1 && prev !== COMMA && prev !== OPEN_BRACKET && prev !== OPEN_BRACE && prev !== COLON) {
          this.edit(i, i + 1, ' ')
        } else {
          prev = COMMA
        }
        i++
      } else if (c === SLASH) {
        i = this.comment(i)
      } else if (c === DOUBLE_QUOTE || c === SINGLE_QUOTE) {
        this.pos = i
        this.string(c)
        i = this.pos
        prev = DOUBLE_QUOTE
      } else if ((c >= ZERO && c <= NINE) || c === MINUS || c === PLUS || c === DOT) {
        if (!this.separatedBefore(i)) return undefined
        this.pos = i
        this.number()
        i = this.pos
        // A number is never a key; checked because -NaN becomes a *string* (the sentinel), which
        // JSON.parse would otherwise accept before a colon.
        if (!this.separatedAfter(i) || src.charCodeAt(this.lookahead(i)) === COLON) return undefined
        prev = ZERO
      } else if (isAsciiIdentifierStart(c) || c === BACKSLASH || (c > 127 && !isUnicodeSpace(c))) {
        if (!this.separatedBefore(i)) return undefined
        // Plain ASCII identifiers are read inline; identifierEnd handles escapes and Unicode.
        let end = i + 1
        let d = src.charCodeAt(end)
        while (isAsciiIdentifierPart(d)) d = src.charCodeAt(++end)
        if (d === BACKSLASH || d > 127 || c === BACKSLASH || c > 127) end = this.identifierEnd(i)
        const after = src.charCodeAt(end)
        const isKey =
          after === COLON ||
          (after === SPACE && src.charCodeAt(end + 1) === COLON) ||
          src.charCodeAt(this.lookahead(end)) === COLON
        if (isKey) {
          this.edit(i, end, `"${src.slice(i, end)}"`)
          // Step over an adjacent colon and JSON whitespace here rather than with a regex call.
          i = after === COLON ? end + 1 : after === SPACE && src.charCodeAt(end + 1) === COLON ? end + 2 : end
          if (i > end) {
            prev = COLON
            while (isJsonSpace(src.charCodeAt(i))) i++
          } else {
            prev = DOUBLE_QUOTE
          }
        } else {
          const length = end - i
          const word = length === 4 || length === 5 || length === 8 || length === 3 ? src.slice(i, end) : ''
          if (word === 'Infinity' || word === 'NaN') {
            this.pos = i
            this.number()
          } else if (word !== 'true' && word !== 'false' && word !== 'null') {
            return undefined
          }
          prev = ZERO
          i = end
        }
      } else if (c === VT || c === FF || isUnicodeSpace(c)) {
        this.edit(i, i + 1, ' ')
        i++
      } else {
        return undefined
      }
    }
  }

  /** Index of the next significant character at or after `i`, skipping whitespace and comments. Edits nothing. */
  lookahead(i: number): number {
    const src = this.src
    for (;;) {
      const c = src.charCodeAt(i)
      if (c === SPACE || c === LF || c === CR || c === TAB || c === VT || c === FF || (c > 127 && isUnicodeSpace(c))) {
        i++
      } else if (c === SLASH && src.charCodeAt(i + 1) === SLASH) {
        LINE_COMMENT_BODY.lastIndex = i + 2
        LINE_COMMENT_BODY.test(src)
        i = LINE_COMMENT_BODY.lastIndex
      } else if (c === SLASH && src.charCodeAt(i + 1) === ASTERISK) {
        const close = src.indexOf('*/', i + 2)
        if (close === -1) return src.length
        i = close + 2
      } else {
        return i
      }
    }
  }

  /** A number or word may start at `i` only if no identifier character or digit touches it from the left. */
  separatedBefore(i: number): boolean {
    if (i === 0) return true
    const c = this.src.charCodeAt(i - 1)
    if (c > 127) return !isIdentifierChar(c, false)
    return !(isAsciiIdentifierStart(c) || (c >= ZERO && c <= NINE) || c === DOT || c === BACKSLASH)
  }

  /** A number ending before `i` must not be followed by an identifier character, digit or dot. */
  separatedAfter(i: number): boolean {
    const c = this.src.charCodeAt(i)
    if (c > 127) return !isIdentifierChar(this.src.codePointAt(i) as number, false)
    return !(isAsciiIdentifierStart(c) || (c >= ZERO && c <= NINE) || c === DOT || c === BACKSLASH)
  }

  /**
   * Replace `src[from, to)` with `text` in the output. Calls must arrive in source order.
   * Builds by concatenation: V8 makes cheap rope strings, which JSON.parse flattens in one
   * native pass. That measured faster than collecting parts and joining them.
   */
  edit(from: number, to: number, text: string): void {
    this.out = this.out + this.src.slice(this.last, from) + text
    this.edited = true
    this.last = to
  }

  finish(): string {
    if (!this.edited) return this.src
    return this.out + this.src.slice(this.last)
  }

  /** Skip whitespace and comments, removing the ones JSON doesn't allow. Returns the next char code, or -1 at the end. */
  skipSpace(): number {
    const src = this.src
    let i = this.pos
    for (;;) {
      const c = src.charCodeAt(i)
      if (c === SPACE || c === LF || c === CR || c === TAB) {
        i++
      } else if (c === SLASH) {
        i = this.comment(i)
      } else if (c > 127 ? isUnicodeSpace(c) : c === VT || c === FF) {
        this.edit(i, i + 1, ' ')
        i++
      } else {
        this.pos = i
        return c === c ? c : -1 // NaN past the end
      }
    }
  }

  comment(start: number): number {
    const src = this.src
    const next = src.charCodeAt(start + 1)
    let end: number
    if (next === SLASH) {
      LINE_COMMENT_BODY.lastIndex = start + 2
      LINE_COMMENT_BODY.test(src)
      end = LINE_COMMENT_BODY.lastIndex
    } else if (next === ASTERISK) {
      const close = src.indexOf('*/', start + 2)
      if (close === -1) throw syntaxError(src, start, 'UNTERMINATED_COMMENT', 'Unterminated block comment')
      end = close + 2
    } else {
      throw unexpected(src, start + 1, "'/' or '*' after '/'")
    }
    this.edit(start, end, ' ')
    return end
  }

  string(quote: number): void {
    const src = this.src
    const run = quote === DOUBLE_QUOTE ? DOUBLE_QUOTED_RUN : SINGLE_QUOTED_RUN
    const start = this.pos
    // A single-quoted string with nothing to rewrite inside becomes one edit. The opening quote is
    // only written separately once an inner edit is needed, to keep edits in source order.
    let openPending = quote === SINGLE_QUOTE
    let i = start + 1
    for (;;) {
      run.lastIndex = i
      run.test(src)
      i = run.lastIndex
      const c = src.charCodeAt(i)
      if (c === quote) {
        if (openPending) this.edit(start, i + 1, `"${src.slice(start + 1, i)}"`)
        else if (quote === SINGLE_QUOTE) this.edit(i, i + 1, '"')
        this.pos = i + 1
        return
      }
      if (openPending && c === c) {
        this.edit(start, start + 1, '"')
        openPending = false
      }
      if (c === BACKSLASH) {
        i = this.escape(i)
      } else if (c === DOUBLE_QUOTE) {
        // Only reachable inside a single-quoted string.
        this.edit(i, i + 1, '\\"')
        i++
      } else if (c === LF || c === CR || c !== c) {
        throw c === c
          ? syntaxError(src, i, 'LINE_BREAK_IN_STRING', 'Unescaped line break in string')
          : syntaxError(src, i, 'UNTERMINATED_STRING', 'Unterminated string')
      } else {
        // Other control characters are allowed raw in JSON5 but must be escaped in JSON.
        this.edit(i, i + 1, unicodeEscape(c))
        i++
      }
    }
  }

  /** Handle the escape sequence whose backslash is at `i`. Returns the index after it. */
  escape(i: number): number {
    const src = this.src
    const c = src.charCodeAt(i + 1)
    switch (c) {
      case DOUBLE_QUOTE:
      case BACKSLASH:
      case SLASH:
      case 98: // b
      case 102: // f
      case 110: // n
      case 114: // r
      case 116: // t
        return i + 2
      case 117: // u
        this.expectHex(i + 2, 4)
        return i + 6
      case SINGLE_QUOTE:
        this.edit(i, i + 2, "'")
        return i + 2
      case 118: // v
        this.edit(i, i + 2, unicodeEscape(VT))
        return i + 2
      case ZERO: {
        const next = src.charCodeAt(i + 2)
        if (next >= ZERO && next <= NINE) throw syntaxError(src, i + 2, 'INVALID_ESCAPE', 'Invalid escape: a digit cannot follow \\0')
        this.edit(i, i + 2, unicodeEscape(0))
        return i + 2
      }
      case 120: // x
        this.expectHex(i + 2, 2)
        this.edit(i, i + 4, unicodeEscape(parseInt(src.slice(i + 2, i + 4), 16)))
        return i + 4
      case LF:
      case LINE_SEPARATOR:
      case PARAGRAPH_SEPARATOR:
        // Line continuation: the backslash and line break vanish.
        this.edit(i, i + 2, '')
        return i + 2
      case CR: {
        const end = src.charCodeAt(i + 2) === LF ? i + 3 : i + 2
        this.edit(i, end, '')
        return end
      }
      default:
        if (c !== c) throw syntaxError(src, i + 1, 'UNTERMINATED_STRING', 'Unterminated string')
        if (c >= 49 && c <= NINE) throw syntaxError(src, i + 1, 'INVALID_ESCAPE', 'Invalid escape: octal escapes are not allowed')
        // Identity escape: `\a` means `a`.
        this.edit(i, i + 2, c < SPACE ? unicodeEscape(c) : src[i + 1] as string)
        return i + 2
    }
  }

  identifier(): void {
    const start = this.pos
    const end = this.identifierEnd(start)
    // The identifier's characters (including \uXXXX escapes) are all valid inside a JSON string.
    this.edit(start, end, `"${this.src.slice(start, end)}"`)
    this.pos = end
  }

  /** End of the (validated) identifier starting at `start`; throws if none starts there. */
  identifierEnd(start: number): number {
    const src = this.src
    let i = isAsciiIdentifierStart(src.charCodeAt(start)) ? start + 1 : this.unicodeIdentifierChar(start, true)
    for (;;) {
      ASCII_IDENTIFIER_PART.lastIndex = i
      ASCII_IDENTIFIER_PART.test(src)
      i = ASCII_IDENTIFIER_PART.lastIndex
      const c = src.charCodeAt(i)
      if (c !== BACKSLASH && !(c > 127)) return i
      const next = this.unicodeIdentifierChar(i, false)
      if (next === i) return i
      i = next
    }
  }

  /**
   * Consume one identifier character at `i` that the ASCII fast path didn't: a `\uXXXX` escape or
   * a non-ASCII code point. Returns the index after it, or `i` if the identifier ends here.
   */
  unicodeIdentifierChar(i: number, isStart: boolean): number {
    const src = this.src
    if (src.charCodeAt(i) === BACKSLASH) {
      if (src.charCodeAt(i + 1) !== 117) throw unexpected(src, i + 1, "'u' (only Unicode escapes are allowed in identifiers)")
      this.expectHex(i + 2, 4)
      if (!isIdentifierChar(parseInt(src.slice(i + 2, i + 6), 16), isStart)) {
        throw syntaxError(src, i, 'INVALID_IDENTIFIER', 'Invalid identifier: the escaped character is not allowed in an identifier')
      }
      return i + 6
    }
    const cp = src.codePointAt(i)
    if (cp !== undefined && isIdentifierChar(cp, isStart)) return i + (cp > 0xffff ? 2 : 1)
    if (isStart) throw unexpected(src, i)
    return i
  }

  number(): void {
    const src = this.src
    const start = this.pos
    JSON_NUMBER.lastIndex = start
    if (JSON_NUMBER.test(src)) {
      const end = JSON_NUMBER.lastIndex
      const next = src.charCodeAt(end)
      // Already valid JSON unless JSON5 syntax continues it: `5.`, `0x1`, `1e` (or junk like `01`).
      if (!(next === DOT || next === 120 || next === 88 || next === 101 || next === 69 || (next >= ZERO && next <= NINE))) {
        this.pos = end
        return
      }
    }

    JSON5_NUMBER.lastIndex = start
    const m = JSON5_NUMBER.exec(src) as RegExpExecArray // every part is optional, so it always matches
    const [text, sign, hex, infinity, nan, integer, fraction, exponent] = m
    let out: string
    if (hex !== undefined) {
      const value = Number(`0x${hex}`)
      out = value === Infinity ? INFINITY_JSON : String(value)
    } else if (infinity !== undefined || nan !== undefined) {
      if (this.rejectNonFinite) {
        throw syntaxError(src, start, 'NON_FINITE_NOT_ALLOWED', `${sign}${infinity ?? nan} is not allowed (nonFinite: 'reject')`)
      }
      if (nan !== undefined) {
        // The sign of NaN is meaningless, so -NaN and +NaN are plain NaN too.
        this.edit(start, start + text.length, NAN_SENTINEL_JSON)
        this.nan = true
        this.pos = start + text.length
        return
      }
      out = INFINITY_JSON
    } else {
      const body = start + (sign as string).length
      if (integer === undefined && fraction === undefined) {
        // Nothing numeric matched: point at the first character of Infinity/NaN that doesn't fit.
        const c = src.charCodeAt(body)
        const word = c === 73 ? 'Infinity' : c === 78 ? 'NaN' : ''
        throw unexpected(src, body + mismatch(src, body, word), word ? `'${word}'` : 'a number')
      }
      if (integer === undefined && fraction === '.') throw unexpected(src, body + 1, 'a digit')
      out = `${integer ?? '0'}${fraction !== undefined && fraction.length > 1 ? fraction : ''}${exponent ?? ''}`
    }
    if (sign === '-') out = `-${out}`
    const end = start + text.length
    if (hex === undefined && infinity === undefined && exponent === undefined) this.checkNumberEnd(end, integer === '0' && fraction === undefined && exponent === undefined)
    if (out !== text) this.edit(start, end, out)
    this.pos = end
  }

  /**
   * After a decimal number without an exponent, an `e` or (after a bare `0`) an `x` means a malformed exponent or hex prefix (`1e`, `1e+`, `0x`).
   * Report it where the missing digit should be, as json5 does, rather than at the letter.
   */
  checkNumberEnd(end: number, isBareZero: boolean): void {
    const src = this.src
    const c = src.charCodeAt(end)
    if (c === 101 || c === 69) {
      const sign = src.charCodeAt(end + 1)
      throw unexpected(src, end + (sign === PLUS || sign === MINUS ? 2 : 1), 'a digit in the exponent')
    }
    if ((c === 120 || c === 88) && isBareZero) {
      throw unexpected(src, end + 1, 'a hexadecimal digit')
    }
  }

  /** Require `count` hex digits at `i`, reporting the first character that isn't one. */
  expectHex(i: number, count: number): void {
    const src = this.src
    for (let k = 0; k < count; k++) {
      const c = src.charCodeAt(i + k)
      if (!((c >= ZERO && c <= NINE) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) {
        throw i + k >= src.length
          ? syntaxError(src, i + k, 'UNTERMINATED_STRING', 'Unterminated string')
          : syntaxError(src, i + k, 'INVALID_ESCAPE', 'Invalid escape: expected a hexadecimal digit')
      }
    }
  }

  literal(): void {
    const src = this.src
    const start = this.pos
    const c = src.charCodeAt(start)
    const word = c === 116 ? 'true' : c === 102 ? 'false' : 'null'
    const bad = mismatch(src, start, word)
    if (bad < word.length) throw unexpected(src, start + bad, `'${word}'`)
    this.pos = start + word.length
  }
}

/** JSON5 whitespace outside ASCII: NBSP, BOM, LS, PS and the other Unicode Zs characters. */
function isUnicodeSpace(c: number): boolean {
  return (
    c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === LINE_SEPARATOR || c === PARAGRAPH_SEPARATOR || c === 0x202f || c === 0x205f || c === 0x3000
  )
}

function isAsciiIdentifierStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95
}

function isIdentifierChar(cp: number, isStart: boolean): boolean {
  if (cp < 128) return isAsciiIdentifierStart(cp) || (!isStart && cp >= ZERO && cp <= NINE)
  const char = String.fromCodePoint(cp)
  return isStart ? UNICODE_ID_START.test(char) : UNICODE_ID_PART.test(char) || cp === ZWNJ || cp === ZWJ
}

/** `\uXXXX` for a code unit, built at runtime so no escape sequence appears literally in source. */
function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`
}

function isJsonSpace(c: number): boolean {
  return c === SPACE || c === LF || c === CR || c === TAB
}

function isAsciiIdentifierPart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= ZERO && c <= NINE) || c === 36 || c === 95
}

/** Index within `word` of the first character of `src` (from `start`) that differs; `word.length` if none. */
function mismatch(src: string, start: number, word: string): number {
  let k = 0
  while (k < word.length && src.charCodeAt(start + k) === word.charCodeAt(k)) k++
  return k
}
