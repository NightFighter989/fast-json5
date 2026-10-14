import { syntaxError, unexpected } from './errors.js'

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

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
const JSON5_NUMBER = /([+-]?)(?:0[xX]([0-9a-fA-F]+)|(Infinity)|(NaN)|(0|[1-9][0-9]*)?(\.[0-9]*)?([eE][+-]?[0-9]+)?)/y
const DOUBLE_QUOTED_RUN = /[^"\\\x00-\x1f]*/y
const SINGLE_QUOTED_RUN = /[^'"\\\x00-\x1f]*/y
const LINE_COMMENT_BODY = new RegExp(`[^\n\r${String.fromCharCode(LINE_SEPARATOR, PARAGRAPH_SEPARATOR)}]*`, 'y')
const HEX2 = /[0-9a-fA-F]{2}/y
const HEX4 = /[0-9a-fA-F]{4}/y
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

class Scanner {
  readonly src: string
  pos = 0
  /** Start of the source not yet copied into `parts`. */
  last = 0
  /** Output so far, as source slices interleaved with replacements. Empty while nothing changed. */
  parts: string[] = []

  constructor(src: string) {
    this.src = src
  }

  run(): string {
    const src = this.src
    /** One entry per open container: true for an object, false for an array. */
    const stack: boolean[] = []
    let state = VALUE
    // The comma most recently consumed, if it may turn out to be a trailing comma.
    let comma = -1
    let commaParts = 0
    let commaLast = 0

    for (;;) {
      const c = this.skipSpace()
      const at = this.pos

      if (state === AFTER_VALUE) {
        if (c === COMMA && stack.length > 0) {
          comma = at
          commaParts = this.parts.length
          commaLast = this.last
          this.pos = at + 1
          state = stack[stack.length - 1] ? KEY : ELEMENT
        } else if ((c === CLOSE_BRACKET || c === CLOSE_BRACE) && stack.length > 0 && stack[stack.length - 1] === (c === CLOSE_BRACE)) {
          stack.pop()
          this.pos = at + 1
        } else if (c === -1 && stack.length === 0) {
          return this.finish()
        } else {
          throw unexpected(src, at)
        }
        continue
      }

      if (state === AFTER_KEY) {
        if (c !== COLON) throw unexpected(src, at)
        this.pos = at + 1
        state = VALUE
        continue
      }

      if ((state === KEY && c === CLOSE_BRACE) || (state === ELEMENT && c === CLOSE_BRACKET)) {
        if (comma !== -1) this.dropComma(comma, commaParts, commaLast)
        comma = -1
        stack.pop()
        this.pos = at + 1
        state = AFTER_VALUE
        continue
      }

      comma = -1

      if (state === KEY) {
        if (c === DOUBLE_QUOTE || c === SINGLE_QUOTE) this.string(c)
        else this.identifier()
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
        else this.literal()
        state = AFTER_VALUE
      }
    }
  }

  /** Replace `src[from, to)` with `text` in the output. Calls must arrive in source order. */
  edit(from: number, to: number, text: string): void {
    if (from > this.last) this.parts.push(this.src.slice(this.last, from))
    this.parts.push(text)
    this.last = to
  }

  finish(): string {
    if (this.parts.length === 0) return this.src
    this.parts.push(this.src.slice(this.last))
    return this.parts.join('')
  }

  /**
   * Remove a trailing comma once the closer after it has been seen. Comments or whitespace
   * between the two may already have been edited, in which case the comma sits inside the
   * source slice that was pushed first after it was recorded.
   */
  dropComma(comma: number, partsBefore: number, lastBefore: number): void {
    if (this.parts.length === partsBefore) {
      this.edit(comma, comma + 1, '')
      return
    }
    const slice = this.parts[partsBefore] as string
    const k = comma - lastBefore
    this.parts[partsBefore] = slice.slice(0, k) + slice.slice(k + 1)
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
        this.edit(i, i + 1, '')
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
      if (close === -1) throw syntaxError(src, start, 'Unterminated block comment')
      end = close + 2
    } else {
      throw unexpected(src, start)
    }
    this.edit(start, end, '')
    return end
  }

  string(quote: number): void {
    const src = this.src
    const run = quote === DOUBLE_QUOTE ? DOUBLE_QUOTED_RUN : SINGLE_QUOTED_RUN
    const start = this.pos
    if (quote === SINGLE_QUOTE) this.edit(start, start + 1, '"')
    let i = start + 1
    for (;;) {
      run.lastIndex = i
      run.test(src)
      i = run.lastIndex
      const c = src.charCodeAt(i)
      if (c === quote) {
        if (quote === SINGLE_QUOTE) this.edit(i, i + 1, '"')
        this.pos = i + 1
        return
      }
      if (c === BACKSLASH) {
        i = this.escape(i)
      } else if (c === DOUBLE_QUOTE) {
        // Only reachable inside a single-quoted string.
        this.edit(i, i + 1, '\\"')
        i++
      } else if (c === LF || c === CR || c !== c) {
        throw syntaxError(src, i, c === c ? 'Unescaped line break in string' : 'Unterminated string')
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
        HEX4.lastIndex = i + 2
        if (!HEX4.test(src)) throw syntaxError(src, i, 'Invalid Unicode escape')
        return i + 6
      case SINGLE_QUOTE:
        this.edit(i, i + 2, "'")
        return i + 2
      case 118: // v
        this.edit(i, i + 2, unicodeEscape(VT))
        return i + 2
      case ZERO: {
        const next = src.charCodeAt(i + 2)
        if (next >= ZERO && next <= NINE) throw unexpected(src, i + 2)
        this.edit(i, i + 2, unicodeEscape(0))
        return i + 2
      }
      case 120: // x
        HEX2.lastIndex = i + 2
        if (!HEX2.test(src)) throw syntaxError(src, i, 'Invalid hexadecimal escape')
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
        if (c !== c) throw syntaxError(src, i + 1, 'Unterminated string')
        if (c >= 49 && c <= NINE) throw unexpected(src, i + 1) // \1 to \9
        // Identity escape: `\a` means `a`.
        this.edit(i, i + 2, c < SPACE ? unicodeEscape(c) : src[i + 1] as string)
        return i + 2
    }
  }

  identifier(): void {
    const src = this.src
    const start = this.pos
    let i = isAsciiIdentifierStart(src.charCodeAt(start)) ? start + 1 : this.unicodeIdentifierChar(start, true)
    for (;;) {
      ASCII_IDENTIFIER_PART.lastIndex = i
      ASCII_IDENTIFIER_PART.test(src)
      i = ASCII_IDENTIFIER_PART.lastIndex
      const c = src.charCodeAt(i)
      if (c !== BACKSLASH && !(c > 127)) break
      const next = this.unicodeIdentifierChar(i, false)
      if (next === i) break
      i = next
    }
    // The identifier's characters (including \uXXXX escapes) are all valid inside a JSON string.
    this.edit(start, i, `"${src.slice(start, i)}"`)
    this.pos = i
  }

  /**
   * Consume one identifier character at `i` that the ASCII fast path didn't: a `\uXXXX` escape or
   * a non-ASCII code point. Returns the index after it, or `i` if the identifier ends here.
   */
  unicodeIdentifierChar(i: number, isStart: boolean): number {
    const src = this.src
    if (src.charCodeAt(i) === BACKSLASH) {
      HEX4.lastIndex = i + 2
      if (src.charCodeAt(i + 1) !== 117 || !HEX4.test(src)) throw syntaxError(src, i, 'Invalid escape in identifier')
      if (!isIdentifierChar(parseInt(src.slice(i + 2, i + 6), 16), isStart)) throw syntaxError(src, i, 'Invalid identifier character')
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
    } else if (infinity !== undefined) {
      out = INFINITY_JSON
    } else if (nan !== undefined) {
      // TODO(phase 3): emit a sentinel and restore NaN after JSON.parse.
      throw syntaxError(src, start, 'NaN is not supported yet')
    } else {
      if (integer === undefined && (fraction === undefined || fraction.length === 1)) throw unexpected(src, start + (sign as string).length)
      out = `${integer ?? '0'}${fraction !== undefined && fraction.length > 1 ? fraction : ''}${exponent ?? ''}`
    }
    if (sign === '-') out = `-${out}`
    if (out !== text) this.edit(start, start + text.length, out)
    this.pos = start + text.length
  }

  literal(): void {
    const src = this.src
    const start = this.pos
    const word = src.startsWith('true', start) ? 'true' : src.startsWith('false', start) ? 'false' : src.startsWith('null', start) ? 'null' : null
    if (word === null) throw unexpected(src, start)
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
