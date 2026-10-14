import { describe, expect, it } from 'vitest'
import { parse } from '../src/index.js'
import { transform } from '../src/transform.js'
import { expectSameAsJson5 } from './support/differential.js'
import { syntaxErrorOf } from './support/errors.js'

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
})

describe('fast path', () => {
  it('returns plain JSON unchanged, without copying', () => {
    const json = '{\n  "a": [1, -2.5e+3, "x\\n\\u00e9", true, null],\n  "b": {}\n}'
    expect(transform(json)).toBe(json)
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

  it.todo('returns NaN') // phase 3

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

describe('errors', () => {
  it('reports the position in the original source', () => {
    const error = syntaxErrorOf(() => parse('{\n  a: 1,\n  b c\n}'))
    expect([error.lineNumber, error.columnNumber]).toEqual([3, 5])
  })
})
