import { describe, expect, it } from 'vitest'
import { JSON5SyntaxError, parse } from '../src/index.js'
import { scanFast, scanStrict } from '../src/transform.js'
import { expectSameAsJson5 } from './support/differential.js'
import { markedPosition, syntaxErrorOf } from './support/errors.js'

// Exotic characters are built at runtime so this file stays ASCII.
const ch = (...codes: number[]): string => String.fromCharCode(...codes)
const NBSP = ch(0xa0)
const BOM = ch(0xfeff)
const LS = ch(0x2028)
const PS = ch(0x2029)
const IDEOGRAPHIC_SPACE = ch(0x3000)

/** Parses to `expected`, and agrees with json5. */
function expectParse(text: string, expected: unknown): void {
  expect(parse(text)).toEqual(expected)
  expectSameAsJson5(text)
}

/** Rejected with a SyntaxError, as json5 also rejects it. */
function expectReject(text: string): void {
  syntaxErrorOf(() => parse(text))
  expectSameAsJson5(text)
}

describe('parse', () => {
  it('parses plain JSON', () => {
    expect(parse('{"a": [1, 2.5, "x", true, null]}')).toEqual({ a: [1, 2.5, 'x', true, null] })
  })

  it('accepts a reviver as the second argument', () => {
    expect(parse('[1, 2]', (_k, v) => (typeof v === 'number' ? v * 10 : v))).toEqual([10, 20])
  })

  it('accepts a reviver in the options object', () => {
    expect(parse('{a: 1}', { reviver: (k, v) => (k === 'a' ? 2 : v) })).toEqual({ a: 2 })
  })

  it('shows the reviver real NaN values, never sentinels', () => {
    const seen: unknown[] = []
    const result = parse('{a: NaN, b: [NaN, 1]}', (key, value) => {
      if (typeof value !== 'object') seen.push([key, value])
      return typeof value === 'number' && Number.isNaN(value) ? 'was NaN' : value
    })
    expect(seen).toEqual([['a', NaN], ['0', NaN], ['1', 1]])
    expect(result).toEqual({ a: 'was NaN', b: ['was NaN', 1] })
  })

  it('deletes properties when the reviver returns undefined on the NaN path', () => {
    expect(parse('{a: NaN, b: 1, c: [NaN]}', (k, v) => (k === 'a' || k === '0' ? undefined : v))).toEqual({ b: 1, c: [undefined] })
  })
})

describe('nonFinite option', () => {
  it("rejects Infinity and NaN literals with 'reject'", () => {
    for (const text of ['Infinity', '-Infinity', '+Infinity', 'NaN', '-NaN', '[1, NaN]', '{a: Infinity}']) {
      const error = syntaxErrorOf(() => parse(text, { nonFinite: 'reject' }))
      expect(error.message).toMatch(/not allowed/)
    }
  })

  it("still allows them as keys and in strings, and overflowing numbers, with 'reject'", () => {
    expect(parse("{Infinity: 'NaN', NaN: 1e400}", { nonFinite: 'reject' })).toEqual({ Infinity: 'NaN', NaN: Infinity })
  })

  it("allows them by default and with 'allow'", () => {
    expect(parse('[Infinity, NaN]', { nonFinite: 'allow' })).toEqual([Infinity, NaN])
  })
})

describe('fast path', () => {
  it('returns plain JSON unchanged, without copying', () => {
    const json = '{\n  "a": [1, -2.5e+3, "x\\n\\u00e9", true, null],\n  "b": {}\n}'
    expect(scanFast(json, false)).toBe(json)
    expect(scanStrict(json, false)).toBe(json)
  })
})

describe('comments', () => {
  it('strips line and block comments', () => {
    expectParse('// top\n{/* a */"a"/* b */:/* c */1/* d */}// end', { a: 1 })
    expectParse('/**/1/***/', 1)
    expectParse('/* * / ** */ [1]', [1])
  })

  it('ends line comments at any line terminator', () => {
    for (const eol of ['\n', '\r', '\r\n', LS, PS]) expectParse(`[1, // c${eol}2]`, [1, 2])
  })

  it('leaves comment-like text in strings alone', () => {
    expectParse('["// no", \'/* no */\']', ['// no', '/* no */'])
  })

  it('accepts a line comment at end of input', () => {
    expectParse('1 // done', 1)
  })

  it('rejects unterminated or stray comments', () => {
    expectReject('1 /* open')
    expectReject('1 /')
    expectReject('[1 / 2]')
  })
})

describe('whitespace', () => {
  it('accepts all JSON5 whitespace', () => {
    const exotic = ['\v', '\f', NBSP, BOM, LS, PS, IDEOGRAPHIC_SPACE, ch(0x1680), ch(0x2000), ch(0x200a), ch(0x202f), ch(0x205f)]
    for (const space of exotic) expectParse(`${space}{${space}a${space}:${space}1${space}}${space}`, { a: 1 })
  })

  it('accepts a leading BOM', () => {
    expectParse(`${BOM}{"a": 1}`, { a: 1 })
  })

  it('rejects non-whitespace format characters', () => {
    expectReject(`[1${ch(0x200b)}]`) // zero-width space is Cf, not Zs
  })
})

describe('trailing commas', () => {
  it('drops a trailing comma in arrays and objects', () => {
    expectParse('[1, 2,]', [1, 2])
    expectParse('{a: 1,}', { a: 1 })
    expectParse('[[1,],{a:[],},]', [[1], { a: [] }])
  })

  it('drops a trailing comma followed by comments and whitespace', () => {
    expectParse(`[1, // one\n /* two */ ${NBSP}]`, [1])
    expectParse(`{a: 1, /* x */ // y\n}`, { a: 1 })
  })

  it('rejects commas that are not trailing commas', () => {
    for (const text of ['[,]', '{,}', '[1,,]', '{a:1,,}', '[,1]', '1,', '[1],', '{a:1}, ']) expectReject(text)
  })
})

describe('keys', () => {
  it('quotes unquoted ASCII keys', () => {
    expectParse('{a: 1, $b: 2, _c3: 3, A_$9: 4}', { a: 1, $b: 2, _c3: 3, A_$9: 4 })
  })

  it('accepts reserved words and literal names as keys', () => {
    expectParse('{true: 1, null: 2, if: 3, Infinity: 4, NaN: 5}', { true: 1, null: 2, if: 3, Infinity: 4, NaN: 5 })
  })

  it('accepts Unicode letters, marks, digits and connectors', () => {
    const key = ch(0xfc, 0x6d, 0x6c, 0xe5) + ch(0x301, 0x903, 0x663, 0x203f, 0x200c, 0x200d) // letters, Mn, Mc, Nd, Pc, ZWNJ, ZWJ
    expectParse(`{${key}: 1}`, { [key]: 1 })
    expectParse(`{${ch(0x1c5)}: 1, ${ch(0x2b0)}: 2, ${ch(0x216b)}: 3}`, { [ch(0x1c5)]: 1, [ch(0x2b0)]: 2, [ch(0x216b)]: 3 }) // Lt, Lm, Nl
  })

  it('accepts astral letters', () => {
    const mathItalicX = String.fromCodePoint(0x1d465)
    expectParse(`{${mathItalicX}: 1}`, { [mathItalicX]: 1 })
  })

  it('decodes \\u escapes in keys', () => {
    expectParse('{\\u0061b: 1, s\\u03A3: 2}', { ab: 1, [`s${ch(0x3a3)}`]: 2 })
  })

  it('quotes single-quoted keys', () => {
    expectParse(`{'a"b': 1}`, { 'a"b': 1 })
  })

  it('keeps __proto__ as an own property', () => {
    const value = parse('{__proto__: {x: 1}}')
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.hasOwn(value, '__proto__')).toBe(true)
    expectSameAsJson5('{__proto__: {x: 1}}')
  })

  it('rejects invalid keys', () => {
    const invalid = ['{a b: 1}', '{1: 2}', '{-a: 1}', '{a-b: 1}', '{\\u0031: 1}', '{a\\u0020: 1}', '{a\\u0022: 1}', '{\\x61: 1}', '{\\ua: 1}', `{${ch(0x2028)}: 1}`, '{a\\uD835\\uDC65: 1}', '{:1}', '{a 1}', '{a:}']
    for (const text of invalid) expectReject(text)
  })
})

describe('strings', () => {
  it('converts single-quoted strings', () => {
    expectParse(`'a"b'`, 'a"b')
    expectParse(`'it\\'s'`, "it's")
    expectParse(`'\\"'`, '"')
    expectParse(`''`, '')
  })

  it('converts JSON5-only escapes', () => {
    expectParse('"\\x41\\v\\0"', `A${ch(11)}${ch(0)}`)
    expectParse('"\\0a"', `${ch(0)}a`)
    expectParse('"\\a\\c\\%\\ "', 'ac% ')
    expectParse(`"\\${ch(0xe9)}"`, ch(0xe9))
    expectParse("\"\\'\"", "'")
  })

  it('removes line continuations', () => {
    for (const eol of ['\n', '\r', '\r\n', LS, PS]) expectParse(`'a\\${eol}b'`, 'ab')
  })

  it('escapes raw control characters, which JSON5 allows', () => {
    expectParse(`"a${ch(9)}b${ch(0)}c${ch(0x1f)}"`, `a${ch(9)}b${ch(0)}c${ch(0x1f)}`)
    expectParse(`'\\${ch(9)}'`, ch(9)) // identity escape of a raw tab
  })

  it('allows raw LS and PS', () => {
    expectParse(`"${LS}${PS}"`, LS + PS)
  })

  it('keeps lone surrogates', () => {
    expectParse(`"${ch(0xd800)}\\uDC00x"`, `${ch(0xd800)}${ch(0xdc00)}x`)
  })

  it('rejects invalid strings', () => {
    const invalid = ['"\\1"', '"\\01"', '"\\08"', '"\\x4"', '"\\xg0"', '"\\u12"', '"\\u12g4"', "'a\nb'", '"a\rb"', '"open', "'open", '"\\', `"a"b"`]
    for (const text of invalid) expectReject(text)
  })
})

describe('numbers', () => {
  it('normalises JSON5 number syntax', () => {
    expectParse('[.5, 5., -.5, +.5, 5.e3, .5e-3, +1, -0.0]', [0.5, 5, -0.5, 0.5, 5000, 0.0005, 1, -0])
  })

  it('converts hexadecimal', () => {
    expectParse('[0xFF, 0Xff, -0x1f, +0x10, 0x0]', [255, 255, -31, 16, 0])
    expect(Object.is(parse('-0x0'), -0)).toBe(true)
    expectSameAsJson5('0x20000000000001') // rounds like Number()
    expectSameAsJson5(`0x${'f'.repeat(300)}`) // overflows to Infinity
  })

  it('returns Infinity and -Infinity', () => {
    expectParse('[Infinity, +Infinity, -Infinity]', [Infinity, Infinity, -Infinity])
  })

  it('keeps -0 and overflowing exponents', () => {
    expect(Object.is(parse('-0'), -0)).toBe(true)
    expectParse('[1e400, -1e400, 1e-400]', [Infinity, -Infinity, 0])
  })

  it('returns NaN, with any sign', () => {
    expectParse('[NaN, -NaN, +NaN, {a: NaN}]', [NaN, NaN, NaN, { a: NaN }])
    expect(parse('NaN')).toBeNaN()
  })

  it('restores NaN under __proto__ keys and in deep nesting', () => {
    const value = parse('{"__proto__": NaN}')
    expect(Object.hasOwn(value, '__proto__') && Number.isNaN(value.__proto__)).toBe(true)
    let deep: unknown = parse(`${'['.repeat(50_000)}NaN${']'.repeat(50_000)}`)
    while (Array.isArray(deep)) deep = deep[0]
    expect(deep).toBeNaN()
  })

  it('does not confuse a NaN-like string with NaN', () => {
    expectParse(String.raw`["\u0000fast-json5:NaN:", 'NaN', NaN]`, [`${ch(0)}fast-json5:NaN:`, 'NaN', NaN])
  })

  it('rejects invalid numbers', () => {
    const invalid = ['01', '-01', '00', '1.2.3', '+', '-', '.', '+.', '.e1', '1e', '1e+', '0x', '0xg', '- 1', '1 2', '0x1.5', '++1', 'Infinityx', 'Inf', '-NaNx', '1_000']
    for (const text of invalid) expectReject(text)
  })
})

describe('structure', () => {
  it('accepts any top-level value', () => {
    expectParse(' "x" ', 'x')
    expectParse('null', null)
    expectParse('[]', [])
  })

  it('handles deep nesting without recursion limits', () => {
    const depth = 100_000
    let value: unknown = parse(`${'[/**/'.repeat(depth)}${']'.repeat(depth)}`)
    let seen = 0
    for (; Array.isArray(value); value = value[0]) seen++
    expect(seen).toBe(depth)
  })

  it('rejects malformed structure', () => {
    const invalid = ['', ' ', '/* only */', '[1]]', '{}}', '[}', '{]', '[1', '{a:1', 'tru', 'nul', 'truex', 'True', 'undefined', '1 // c\n 2', '1/**/2', '{a:1 b:2}', '[1 2]', ':', '{a::1}']
    for (const text of invalid) expectReject(text)
  })
})

// The fast path rewrites tokens under local rules and lets JSON.parse check structure. These pin
// the inputs where a careless local rule would turn invalid JSON5 into valid JSON.
describe('fast-path soundness', () => {
  it('never lets a rewritten value act as a key', () => {
    for (const text of ['{-NaN: 1}', '{+NaN: 1}', '{NaN /**/ : 1, a: 1}', '{-Infinity: 1}', '{0x1: 1}', '{.5: 1}', '{1: 2}']) {
      if (text.startsWith('{NaN')) expectParse(text, { NaN: 1, a: 1 })
      else expectReject(text)
    }
  })

  it('never merges a rewritten number with a neighbour', () => {
    for (const text of ['1Infinity', '[1Infinity]', '[0x1.5]', '[1.5.5]', '[Infinity5]', '[NaN1]', '[5.e]', '[0x1g]', '[1.e5.]', '[.5.5]', '[-.5e1.0]', '[1/**/Infinity]']) {
      expectReject(text)
    }
  })

  it('drops only commas that follow a value', () => {
    for (const text of ['[/*c*/,]', '[ , /*c*/ ]', '{"a":,}', '{"a",}', '{a,}', `[1,,${BOM}]`, '[,// c\n]']) expectReject(text)
    expectParse(`[1,${BOM}]`, [1])
    expectParse('[1, /* c */ // d\n]', [1])
    expectParse(`{"a": [], ${NBSP}}`, { a: [] })
  })

  it('treats literals followed by a colon as keys, however the colon is reached', () => {
    expectParse('{true /* c */ : 1, null\v: 2, false// c\n: 3}', { true: 1, null: 2, false: 3 })
    expectParse('{trueish: 1, nullable: 2}', { trueish: 1, nullable: 2 })
  })

  it('rejects words that are neither keys nor literals', () => {
    for (const text of ['[undefined]', '[a]', '{"a": b}', '[Infinityx]', '[True]']) expectReject(text)
  })
})

describe('errors', () => {
  /** The thrown error, asserted to be a JSON5SyntaxError located at the `¦` marker. */
  function errorAt(source: string): JSON5SyntaxError {
    const { text, position } = markedPosition(source)
    const error = syntaxErrorOf(() => parse(text))
    expect(error).toBeInstanceOf(JSON5SyntaxError)
    expect({ line: error.lineNumber, column: error.columnNumber }, JSON.stringify(text)).toEqual(position)
    return error as JSON5SyntaxError
  }

  it('is a SyntaxError with json5-compatible fields', () => {
    const error = errorAt('{\n  a: 1,\n  b ¦c\n}')
    expect(error).toBeInstanceOf(SyntaxError)
    expect(error.name).toBe('SyntaxError')
    expect(error.offset).toBe(14)
    expect(error.message).toBe(`${error.reason} at line 3, column 5`)
  })

  it('says what was expected', () => {
    expect(errorAt('[1 ¦2]').reason).toBe(`Unexpected character "2"; expected ',' or ']'`)
    expect(errorAt('{a: 1 ¦b: 2}').reason).toBe(`Unexpected character "b"; expected ',' or '}'`)
    expect(errorAt('{a ¦1}').reason).toBe(`Unexpected character "1"; expected ':' after a key`)
    expect(errorAt('{¦-a: 1}').reason).toBe(`Unexpected character "-"; expected a key or '}'`)
    expect(errorAt('[¦}').reason).toBe(`Unexpected character "}"; expected a value or ']'`)
    expect(errorAt('{a: ¦]}').reason).toBe(`Unexpected character "]"; expected a value`)
    expect(errorAt('1 ¦2').reason).toBe(`Unexpected character "2"; expected end of input`)
    expect(errorAt('{a: [1, 2¦').reason).toBe(`Unexpected end of input; expected ',' or ']'`)
    expect(errorAt('¦').code).toBe('UNEXPECTED_END')
  })

  it('points at the first character of a literal that does not fit', () => {
    expect(errorAt('nu¦xl').reason).toBe(`Unexpected character "x"; expected 'null'`)
    expect(errorAt('[tr¦]').reason).toBe(`Unexpected character "]"; expected 'true'`)
    expect(errorAt('-Inf¦').reason).toBe(`Unexpected end of input; expected 'Infinity'`)
    expect(errorAt('Na¦n').code).toBe('UNEXPECTED_CHARACTER')
  })

  it('locates number errors where the missing digit should be', () => {
    errorAt('1e¦')
    errorAt('[1e+¦]')
    errorAt('0x¦')
    errorAt('[.¦e5]')
    errorAt('[1e5¦e]')
    errorAt('[0¦1]')
  })

  it('locates string and escape errors at the offending character', () => {
    expect(errorAt('"ab¦').code).toBe('UNTERMINATED_STRING')
    expect(errorAt('"a¦\nb"').code).toBe('LINE_BREAK_IN_STRING')
    expect(errorAt('"\\u12¦g4"').code).toBe('INVALID_ESCAPE')
    expect(errorAt('"\\x¦g0"').code).toBe('INVALID_ESCAPE')
    expect(errorAt('"\\0¦1"').code).toBe('INVALID_ESCAPE')
    expect(errorAt('"\\¦7"').code).toBe('INVALID_ESCAPE')
    expect(errorAt('"\\u12¦').code).toBe('UNTERMINATED_STRING')
  })

  it('locates identifier and comment errors', () => {
    expect(errorAt('{\\¦x61: 1}').reason).toMatch(/expected 'u'/)
    expect(errorAt('{¦\\u0031: 1}').code).toBe('INVALID_IDENTIFIER')
    expect(errorAt('[1 /¦ 2]').reason).toMatch(/expected '\/' or '\*' after '\/'/)
    expect(errorAt('[1, ¦/* open').code).toBe('UNTERMINATED_COMMENT')
  })

  it('names invisible characters by code point', () => {
    expect(errorAt(`[1${NBSP}¦${ch(0x200b)}]`).reason).toMatch(/U\+200B/)
    expect(errorAt('[1 ¦\u0001]').reason).toMatch(/U\+0001/)
  })

  it('reports nonFinite rejections with their own code', () => {
    const error = syntaxErrorOf(() => parse('[1, -Infinity]', { nonFinite: 'reject' })) as JSON5SyntaxError
    expect([error.code, error.columnNumber]).toEqual(['NON_FINITE_NOT_ALLOWED', 5])
  })

  it('positions errors in the original text, not the rewritten JSON', () => {
    // Everything before the error is rewritten (keys quoted, comments dropped, hex converted).
    errorAt("{a: 'x', /* c */ b: 0x10, c: [1,], d¦}")
    errorAt("{\n  // comment\n  key: 'value',\n  other: .5,\n  }¦}")
  })

  it('lets reviver errors through unchanged, calling the reviver once per value', () => {
    const boom = new TypeError('boom')
    let calls = 0
    expect(() =>
      parse('{a: 1}', () => {
        calls++
        throw boom
      }),
    ).toThrow(boom)
    expect(calls).toBe(1)
  })
})
