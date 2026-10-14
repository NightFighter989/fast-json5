import { describe, JSON5SyntaxError, type JSON5ErrorCode } from './errors.js'
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
const ASTERISK = 42
const PLUS = 43
const COMMA = 44
const MINUS = 45
const DOT = 46
const SLASH = 47
const ZERO = 48
const NINE = 57
const COLON = 58
const OPEN_BRACKET = 91
const BACKSLASH = 92
const CLOSE_BRACKET = 93
const OPEN_BRACE = 123
const CLOSE_BRACE = 125

// What the strict scanner expects next.
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
 * - commas: only when an ASCII token start follows (a quote, bracket, digit, sign, dot, letter or
 *   `\`), which can't be a closer, so the comma can't be trailing. Anything else (a closer, a
 *   comment, JSON5 whitespace) is left for the JS trailing-comma check.
 */
const JSON_RUN =
  /(?:"[^"\\\x00-\x1f]*(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})[^"\\\x00-\x1f]*)*"|[{}[\]:][ \t\n\r]*|[ \t\n\r]+|,[ \t\n\r]*(?=["'[{0-9A-Za-z_$\\+.-])|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?(?![.eExX0-9])|(?:true|false|null)(?=[ \t\n\r]*(?:[,\]}]|$)))*/y
/** Every part is optional, so this always matches; the captures say which form it was. */
const NUMBER = /([+-]?)(?:0[xX]([0-9a-fA-F]+)|(Infinity)|(NaN)|(0|[1-9][0-9]*)?(\.[0-9]*)?([eE][+-]?[0-9]+)?)/y
/** String body up to the next quote, backslash or control character (either kind of string). */
const STRING_RUN = /[^'"\\\x00-\x1f]*/y
const LINE_COMMENT_BODY = new RegExp(`[^\n\r${String.fromCharCode(0x2028, 0x2029)}]*`, 'y')
// ES5 IdentifierStart / IdentifierPart categories, as the JSON5 spec defines them (\p{L} is Lu Ll Lt Lm Lo).
const UNICODE_ID_START = /[\p{L}\p{Nl}]/u
const UNICODE_ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]/u
const WHITESPACE = /\s/

/** Overflows to Infinity in every conforming JSON.parse, so it stands in for Infinity with no fix-up. */
const INFINITY_JSON = '1e400'

// Scanner state. Module-level rather than a class so the minifier can shorten every name, which
// halves the bundle. Safe because a scan never calls user code, so it can't be re-entered; the
// caller reads `sawNaN` right after the scan.
var src = ''
/** The strict scanner's cursor (token readers also report their end through it). */
var pos = 0
/** Start of the source not yet copied into `out`. */
var last = 0
/** Output so far, up to `last`. Built by concatenation: V8 ropes, flattened once by JSON.parse. */
var out = ''
/** Whether any edit happened; if not, the input is returned as-is. */
var edited = false
var rejectNonFinite = false
/** Set once a NaN sentinel has been written; parse() then restores NaN after JSON.parse. */
export var sawNaN = false

function begin(text: string, reject: boolean): void {
  src = text
  pos = last = 0
  out = ''
  edited = sawNaN = false
  rejectNonFinite = reject
}

/** Replace `src[from, to)` with `text` in the output. Calls must arrive in source order. */
function edit(from: number, to: number, text: string): void {
  out = out + src.slice(last, from) + text
  edited = true
  last = to
}

function finish(): string {
  return edited ? out + src.slice(last) : src
}

/**
 * Fast path. Skips plain JSON with one regex call per run and rewrites only JSON5 tokens, each
 * under a local rule that can only make invalid JSON5 *stay* invalid; structure is left for
 * JSON.parse to validate. Returns undefined when it meets anything it can't rewrite with
 * certainty (and token readers may throw); the caller then falls back to `scanStrict()`, which
 * also produces the error.
 *
 * Soundness (the output parses only if the input is valid JSON5, to the same value) rests on:
 * - every rewrite turns one JSON5 token into a JSON token with the same meaning and role;
 * - comments and whitespace become a space, so neighbouring tokens never merge;
 * - a comma is dropped only between a complete value and a closer;
 * - a bare word is quoted only when followed by `:`, so it can only ever end up as a key;
 * - a number or word rewritten here must not touch an identifier character or digit on either
 *   side, as JSON5's own tokenizer requires (otherwise `1Infinity` could become `11e400`), and a
 *   number must not be followed by `:` (-NaN becomes a *string*, which could pass as a key).
 */
export function scanFast(text: string, reject: boolean): string | undefined {
  begin(text, reject)
  const n = text.length
  let i = 0
  // Last significant source character before `i`, for the trailing-comma rule (-1: none yet).
  let prev = -1
  for (;;) {
    let c = text.charCodeAt(i)
    let runEnd = i
    // Skip the regex call when the next token can only be JSON5 (the run would be empty).
    if (!(c === SINGLE_QUOTE || c === SLASH || (isAsciiIdentifierStart(c) && c !== 116 && c !== 102 && c !== 110))) {
      JSON_RUN.lastIndex = i
      JSON_RUN.test(src)
      runEnd = JSON_RUN.lastIndex
      if (runEnd >= n) return finish()
      c = text.charCodeAt(runEnd)
    }
    if (runEnd > i) {
      // Only the comma rule reads `prev`, and only commas, comments and whitespace can come
      // between the run and that comma; every other handler below sets `prev` itself.
      if (c === COMMA || c === SLASH || c === VT || c === FF || c > 127) {
        let k = runEnd - 1
        while (k >= i && isJsonSpace(text.charCodeAt(k))) k--
        if (k >= i) prev = text.charCodeAt(k)
      }
      i = runEnd
    }

    if (c === COMMA) {
      // Not consumed by JSON_RUN, so it may be trailing: followed by a closer or a comment.
      const next = text.charCodeAt(lookahead(i + 1))
      if ((next === CLOSE_BRACKET || next === CLOSE_BRACE) && prev !== -1 && prev !== COMMA && prev !== OPEN_BRACKET && prev !== OPEN_BRACE && prev !== COLON) {
        edit(i, i + 1, ' ')
      } else {
        prev = COMMA
      }
      i++
    } else if (c === SLASH) {
      i = comment(i)
    } else if (c === DOUBLE_QUOTE || c === SINGLE_QUOTE) {
      pos = i
      string(c)
      i = pos
      prev = DOUBLE_QUOTE
    } else if ((c >= ZERO && c <= NINE) || c === MINUS || c === PLUS || c === DOT) {
      if (i > 0 && isWordAt(i - 1)) return undefined
      pos = i
      number()
      i = pos
      if (isWordAt(i) || text.charCodeAt(lookahead(i)) === COLON) return undefined
      prev = ZERO
    } else if (isAsciiIdentifierStart(c) || c === BACKSLASH || (c > 127 && !isUnicodeSpace(c))) {
      if (i > 0 && isWordAt(i - 1)) return undefined
      // Plain ASCII identifiers are read inline; identifierEnd handles escapes and Unicode.
      let end = i + 1
      let d = text.charCodeAt(end)
      while (isAsciiIdentifierPart(d)) d = text.charCodeAt(++end)
      if (d === BACKSLASH || d > 127 || c === BACKSLASH || c > 127) end = identifierEnd(i)
      const after = text.charCodeAt(end)
      const isKey = after === COLON || (after === SPACE && text.charCodeAt(end + 1) === COLON) || text.charCodeAt(lookahead(end)) === COLON
      if (isKey) {
        edit(i, end, `"${text.slice(i, end)}"`)
        // Step over an adjacent colon and JSON whitespace here rather than with a regex call.
        i = after === COLON ? end + 1 : after === SPACE && text.charCodeAt(end + 1) === COLON ? end + 2 : end
        if (i > end) {
          prev = COLON
          while (isJsonSpace(text.charCodeAt(i))) i++
        } else {
          prev = DOUBLE_QUOTE
        }
      } else {
        const word = text.slice(i, end)
        if (word === 'Infinity' || word === 'NaN') {
          pos = i
          number()
        } else if (word !== 'true' && word !== 'false' && word !== 'null') {
          return undefined
        }
        prev = ZERO
        i = end
      }
    } else if (c === VT || c === FF || isUnicodeSpace(c)) {
      edit(i, i + 1, ' ')
      i++
    } else {
      return undefined
    }
  }
}

/**
 * Slow path: rewrite JSON5 to JSON while validating the full grammar with a token-level state
 * machine. Throws a JSON5SyntaxError positioned in the original text for invalid input. Used for
 * errors and for the rare valid forms the fast path declines. Iterative, so depth is unlimited.
 */
export function scanStrict(text: string, reject: boolean): string {
  begin(text, reject)
  /** One entry per open container: true for an object, false for an array. */
  const stack: boolean[] = []
  let state = VALUE

  for (;;) {
    const c = skipSpace()
    const at = pos
    const top = stack.length - 1

    if (state === AFTER_VALUE) {
      if (c === COMMA && top >= 0) {
        // Trailing comma: a closer is next. Decided by lookahead, so edits stay in source order.
        const next = src.charCodeAt(lookahead(at + 1))
        if (next === CLOSE_BRACKET || next === CLOSE_BRACE) edit(at, at + 1, ' ')
        pos = at + 1
        state = stack[top] ? KEY : ELEMENT
      } else if ((c === CLOSE_BRACKET || c === CLOSE_BRACE) && top >= 0 && stack[top] === (c === CLOSE_BRACE)) {
        stack.pop()
        pos = at + 1
      } else if (c === -1 && top < 0) {
        return finish()
      } else {
        throw unexpected(at, top < 0 ? 'end of input' : stack[top] ? "',' or '}'" : "',' or ']'")
      }
    } else if (state === AFTER_KEY) {
      if (c !== COLON) throw unexpected(at, "':' after a key")
      pos = at + 1
      state = VALUE
    } else if ((state === KEY && c === CLOSE_BRACE) || (state === ELEMENT && c === CLOSE_BRACKET)) {
      stack.pop()
      pos = at + 1
      state = AFTER_VALUE
    } else if (state === KEY) {
      if (c === DOUBLE_QUOTE || c === SINGLE_QUOTE) {
        string(c)
      } else if (isAsciiIdentifierStart(c) || c === BACKSLASH || c > 127) {
        const end = identifierEnd(at)
        // The identifier's characters (including \uXXXX escapes) are all valid inside a JSON string.
        edit(at, end, `"${src.slice(at, end)}"`)
        pos = end
      } else {
        throw unexpected(at, "a key or '}'")
      }
      state = AFTER_KEY
    } else if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      // VALUE or ELEMENT from here on: a value must start.
      stack.push(c === OPEN_BRACE)
      pos = at + 1
      state = c === OPEN_BRACE ? KEY : ELEMENT
    } else {
      if (c === DOUBLE_QUOTE || c === SINGLE_QUOTE) string(c)
      else if ((c >= ZERO && c <= NINE) || c === MINUS || c === PLUS || c === DOT || c === 73 /* I */ || c === 78 /* N */) number()
      else if (c === 116 || c === 102 || c === 110) literal() // t f n
      else throw unexpected(at, state === ELEMENT ? "a value or ']'" : 'a value')
      state = AFTER_VALUE
    }
  }
}

/** Index of the next significant character at or after `i`, skipping whitespace and comments. Edits nothing. */
function lookahead(i: number): number {
  const text = src
  for (;;) {
    const c = text.charCodeAt(i)
    if (isJsonSpace(c)) {
      i++
    } else if (c === SLASH) {
      const next = text.charCodeAt(i + 1)
      if (next === SLASH) {
        LINE_COMMENT_BODY.lastIndex = i + 2
        LINE_COMMENT_BODY.test(text)
        i = LINE_COMMENT_BODY.lastIndex
      } else if (next === ASTERISK) {
        const close = text.indexOf('*/', i + 2)
        if (close < 0) return text.length
        i = close + 2
      } else {
        return i
      }
    } else if (c === VT || c === FF || isUnicodeSpace(c)) {
      i++
    } else {
      return i
    }
  }
}

/**
 * Whether the character at `i` would continue a number or identifier (a digit, identifier
 * character, `.` or `\`). The fast path won't rewrite a number or word that touches one.
 */
function isWordAt(i: number): boolean {
  const c = src.charCodeAt(i)
  return c > 127 ? isIdentifierChar(src.codePointAt(i) as number, false) : isAsciiIdentifierPart(c) || c === DOT || c === BACKSLASH
}

/** Strict path: skip whitespace and comments, removing the ones JSON doesn't allow. Returns the next char code, or -1 at the end. */
function skipSpace(): number {
  for (;;) {
    const c = src.charCodeAt(pos)
    if (isJsonSpace(c)) {
      pos++
    } else if (c === SLASH) {
      pos = comment(pos)
    } else if (c === VT || c === FF || isUnicodeSpace(c)) {
      edit(pos, pos + 1, ' ')
      pos++
    } else {
      return c === c ? c : -1 // NaN past the end
    }
  }
}

function comment(start: number): number {
  const next = src.charCodeAt(start + 1)
  let end: number
  if (next === SLASH) {
    LINE_COMMENT_BODY.lastIndex = start + 2
    LINE_COMMENT_BODY.test(src)
    end = LINE_COMMENT_BODY.lastIndex
  } else if (next === ASTERISK) {
    end = src.indexOf('*/', start + 2) + 2
    if (end < 2) throw fail(start, 'UNTERMINATED_COMMENT', 'Unterminated block comment')
  } else {
    throw unexpected(start + 1, "'/' or '*' after '/'")
  }
  edit(start, end, ' ')
  return end
}

/** Read the string whose opening quote is at `pos`; leaves `pos` after it. */
function string(quote: number): void {
  const text = src
  const start = pos
  // A single-quoted string with nothing to rewrite inside becomes one edit. The opening quote is
  // only written separately once an inner edit is needed, to keep edits in source order.
  let openPending = quote === SINGLE_QUOTE
  let i = start + 1
  for (;;) {
    STRING_RUN.lastIndex = i
    STRING_RUN.test(src)
    i = STRING_RUN.lastIndex
    const c = text.charCodeAt(i)
    if (c === quote) {
      if (openPending) edit(start, i + 1, `"${text.slice(start + 1, i)}"`)
      else if (quote === SINGLE_QUOTE) edit(i, i + 1, '"')
      pos = i + 1
      return
    }
    if (c === SINGLE_QUOTE) {
      i++ // inside a double-quoted string: just a character
      continue
    }
    if (openPending && c === c) {
      edit(start, start + 1, '"')
      openPending = false
    }
    if (c === BACKSLASH) {
      i = escape(i)
    } else if (c === DOUBLE_QUOTE) {
      // Inside a single-quoted string.
      edit(i, i + 1, '\\"')
      i++
    } else if (c !== c) {
      throw unterminated(i)
    } else if (c === LF || c === CR) {
      throw fail(i, 'LINE_BREAK_IN_STRING', 'Unescaped line break in string')
    } else {
      // Other control characters are allowed raw in JSON5 but must be escaped in JSON.
      edit(i, i + 1, unicodeEscape(c))
      i++
    }
  }
}

/** Handle the escape sequence whose backslash is at `i`. Returns the index after it. */
function escape(i: number): number {
  const c = src.charCodeAt(i + 1)
  let end = i + 2
  let text: string
  switch (c) {
    case DOUBLE_QUOTE:
    case BACKSLASH:
    case SLASH:
    case 98: // b
    case 102: // f
    case 110: // n
    case 114: // r
    case 116: // t
      return end
    case 117: // u
      expectHex(end, 4)
      return i + 6
    case SINGLE_QUOTE:
      text = "'"
      break
    case 118: // v
      text = unicodeEscape(VT)
      break
    case ZERO:
      if (isDigit(src.charCodeAt(end))) throw badEscape(end, 'a digit cannot follow \\0')
      text = unicodeEscape(0)
      break
    case 120: // x
      expectHex(end, 2)
      end = i + 4
      text = unicodeEscape(parseInt(src.slice(i + 2, end), 16))
      break
    case CR:
      if (src.charCodeAt(end) === LF) end++
    // falls through: CR, CRLF, LF, LS and PS are line continuations, which vanish
    case LF:
    case 0x2028:
    case 0x2029:
      text = ''
      break
    default:
      if (c !== c) throw unterminated(i + 1)
      if (isDigit(c)) throw badEscape(i + 1, 'octal escapes are not allowed')
      // Identity escape: `\a` means `a`.
      text = c < SPACE ? unicodeEscape(c) : (src[i + 1] as string)
  }
  edit(i, end, text)
  return end
}

/** End of the (validated) identifier starting at `start`; throws if none starts there. */
function identifierEnd(start: number): number {
  const text = src
  let i = isAsciiIdentifierStart(text.charCodeAt(start)) ? start + 1 : unicodeIdentifierChar(start, true)
  for (;;) {
    const c = text.charCodeAt(i)
    if (isAsciiIdentifierPart(c)) {
      i++
    } else if (c === BACKSLASH || c > 127) {
      const next = unicodeIdentifierChar(i, false)
      if (next === i) return i
      i = next
    } else {
      return i
    }
  }
}

/**
 * Consume one identifier character at `i` that isn't plain ASCII: a `\uXXXX` escape or a
 * non-ASCII code point. Returns the index after it, or `i` if the identifier ends here.
 */
function unicodeIdentifierChar(i: number, isStart: boolean): number {
  if (src.charCodeAt(i) === BACKSLASH) {
    if (src.charCodeAt(i + 1) !== 117) throw unexpected(i + 1, "'u'")
    expectHex(i + 2, 4)
    if (!isIdentifierChar(parseInt(src.slice(i + 2, i + 6), 16), isStart)) {
      throw fail(i, 'INVALID_IDENTIFIER', 'Escaped character is not allowed in an identifier')
    }
    return i + 6
  }
  const cp = src.codePointAt(i)
  if (cp !== undefined && isIdentifierChar(cp, isStart)) return i + (cp > 0xffff ? 2 : 1)
  if (isStart) throw unexpected(i)
  return i
}

/** Read the number at `pos`, rewriting it to JSON if needed; leaves `pos` after it. */
function number(): void {
  const start = pos
  NUMBER.lastIndex = start
  const [text, sign, hex, infinity, nan, integer, fraction, exponent] = NUMBER.exec(src) as RegExpExecArray
  const end = start + text.length
  const isNaN = nan !== undefined
  let json: string
  if (hex !== undefined) {
    const value = Number(`0x${hex}`)
    json = value === Infinity ? INFINITY_JSON : String(value)
  } else if (infinity !== undefined || isNaN) {
    if (rejectNonFinite) throw fail(start, 'NON_FINITE_NOT_ALLOWED', `${text} is not allowed (nonFinite: 'reject')`)
    if (isNaN) sawNaN = true
    json = isNaN ? NAN_SENTINEL_JSON : INFINITY_JSON
  } else {
    const body = start + (sign as string).length
    if (integer === undefined && fraction === undefined) {
      // Nothing numeric matched: point at the first character of Infinity/NaN that doesn't fit.
      const c = src.charCodeAt(body)
      const word = c === 73 ? 'Infinity' : c === 78 ? 'NaN' : ''
      throw unexpected(body + mismatch(body, word), word ? `'${word}'` : 'a number')
    }
    if (integer === undefined && fraction === '.') throw unexpected(body + 1, 'a digit')
    if (exponent === undefined) {
      // A trailing `e` (or `x` after a bare 0) is a malformed exponent or hex prefix; report where
      // the missing digit should be, as json5 does.
      const c = src.charCodeAt(end)
      if (c === 101 || c === 69) throw unexpected(end + (src[end + 1] === '+' || src[end + 1] === '-' ? 2 : 1), 'a digit in the exponent')
      if ((c === 120 || c === 88) && integer === '0' && fraction === undefined) throw unexpected(end + 1, 'a hexadecimal digit')
    }
    json = `${integer ?? '0'}${fraction !== undefined && fraction.length > 1 ? fraction : ''}${exponent ?? ''}`
  }
  // The sign of NaN is meaningless, so -NaN and +NaN are plain NaN too.
  if (sign === '-' && !isNaN) json = `-${json}`
  if (json !== text) edit(start, end, json)
  pos = end
}

/** Read `true`, `false` or `null` at `pos`, pointing at the first character that doesn't fit. */
function literal(): void {
  const c = src.charCodeAt(pos)
  const word = c === 116 ? 'true' : c === 102 ? 'false' : 'null'
  const bad = mismatch(pos, word)
  if (bad < word.length) throw unexpected(pos + bad, `'${word}'`)
  pos += word.length
}

/** Require `count` hex digits at `i`, reporting the first character that isn't one. */
function expectHex(i: number, count: number): void {
  for (const end = i + count; i < end; i++) {
    const c = src.charCodeAt(i)
    const lower = c | 32 // lower-cases ASCII letters
    if (!(isDigit(c) || (lower >= 97 && lower <= 102))) throw i < src.length ? badEscape(i, 'expected a hexadecimal digit') : unterminated(i)
  }
}

/** Index within `word` of the first character of `src` (from `start`) that differs; `word.length` if none. */
function mismatch(start: number, word: string): number {
  let k = 0
  while (k < word.length && src.charCodeAt(start + k) === word.charCodeAt(k)) k++
  return k
}

function fail(at: number, code: JSON5ErrorCode, reason: string): JSON5SyntaxError {
  return new JSON5SyntaxError(src, at, code, reason)
}

function badEscape(at: number, why: string): JSON5SyntaxError {
  return fail(at, 'INVALID_ESCAPE', `Invalid escape: ${why}`)
}

function unterminated(at: number): JSON5SyntaxError {
  return fail(at, 'UNTERMINATED_STRING', 'Unterminated string')
}

/** `Unexpected character "x"` (or `Unexpected end of input`), optionally saying what was expected. */
function unexpected(at: number, expected?: string): JSON5SyntaxError {
  const suffix = expected ? `; expected ${expected}` : ''
  return at < src.length
    ? fail(at, 'UNEXPECTED_CHARACTER', `Unexpected character ${describe(src.codePointAt(at) as number)}${suffix}`)
    : fail(at, 'UNEXPECTED_END', `Unexpected end of input${suffix}`)
}

/**
 * JSON5 whitespace outside ASCII: NBSP, BOM, LS, PS and the other Unicode Zs characters. JS `\s`
 * is exactly JSON5's whitespace set (checked over the whole BMP), so the regex can decide.
 */
function isUnicodeSpace(c: number): boolean {
  return c > 127 && WHITESPACE.test(String.fromCharCode(c))
}

function isJsonSpace(c: number): boolean {
  return c === SPACE || c === LF || c === CR || c === TAB
}

function isDigit(c: number): boolean {
  return c >= ZERO && c <= NINE
}

function isAsciiIdentifierStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95
}

function isAsciiIdentifierPart(c: number): boolean {
  return isAsciiIdentifierStart(c) || isDigit(c)
}

function isIdentifierChar(cp: number, isStart: boolean): boolean {
  if (cp < 128) return isStart ? isAsciiIdentifierStart(cp) : isAsciiIdentifierPart(cp)
  const char = String.fromCodePoint(cp)
  return isStart ? UNICODE_ID_START.test(char) : UNICODE_ID_PART.test(char) || cp === 0x200c || cp === 0x200d // ZWNJ, ZWJ
}

/** `\uXXXX` for a code unit, built at runtime so no escape sequence appears literally in source. */
function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`
}
