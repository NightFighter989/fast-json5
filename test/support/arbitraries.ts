/**
 * fast-check generators for JSON5 source text.
 *
 * `json5Document` only produces valid JSON5 (checked against json5 in fuzz.test.ts) and leans on
 * the features the transformer rewrites: comments, exotic whitespace, unquoted/Unicode/escaped
 * keys, single quotes, JSON5-only escapes, hex and dotted numbers, signs, Infinity/NaN and
 * trailing commas. `mutatedDocument` corrupts valid documents to probe strictness.
 */
import fc, { type Arbitrary } from 'fast-check'

const LINE_TERMINATORS = ['\n', '\r', '\r\n', '\u2028', '\u2029']
const HEX = [...'0123456789abcdefABCDEF']

const pick = <T>(...values: T[]): Arbitrary<T> => fc.constantFrom(...values)
const concat = (parts: readonly string[]): string => parts.join('')
const isLineTerminator = (c: string): boolean => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029'
const hex = (length: number): Arbitrary<string> => fc.string({ unit: pick(...HEX), minLength: length, maxLength: length })

/** Any single code point, including lone surrogates and control characters. */
const anyChar = fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })

// ---------------------------------------------------------------------------
// Whitespace and comments

const whitespaceChar = pick(
  ' ', '\t', '\v', '\f', '\u00A0', '\uFEFF',
  '\u1680', '\u2000', '\u200A', '\u202F', '\u205F', '\u3000', // Unicode Zs
  ...LINE_TERMINATORS,
)

const commentText = fc.string({
  unit: fc.oneof(pick('a', ' ', '*', '/', '"', "'", '\\', '}', ']', ','), anyChar),
  maxLength: 12,
})

const lineComment = fc
  .tuple(commentText, pick(...LINE_TERMINATORS))
  .map(([text, eol]) => `//${[...text].filter((c) => !isLineTerminator(c)).join('')}${eol}`)

const blockComment = commentText.map((text) => `/*${text.replaceAll('*/', '* /')}*/`)

/** Optional run of JSON5 whitespace and comments. */
export const ws: Arbitrary<string> = fc
  .array(
    fc.oneof(
      { arbitrary: whitespaceChar, weight: 6 },
      { arbitrary: lineComment, weight: 1 },
      { arbitrary: blockComment, weight: 1 },
    ),
    { maxLength: 3 },
  )
  .map(concat)

// ---------------------------------------------------------------------------
// Numbers

const digits = (minLength = 1): Arbitrary<string> => fc.string({ unit: pick(...'0123456789'), minLength, maxLength: 8 })
const integerPart = fc.oneof(pick('0'), fc.tuple(pick(...'123456789'), digits(0)).map(concat))
const exponent = fc.option(fc.tuple(pick('e', 'E'), pick('', '+', '-'), digits()).map(concat), { nil: '' })

const unsignedNumber = fc.oneof(
  fc.tuple(integerPart, exponent).map(concat), // 12, 1e5
  fc.tuple(integerPart, digits(), exponent).map(([i, f, e]) => `${i}.${f}${e}`), // 1.5
  fc.tuple(digits(), exponent).map(([f, e]) => `.${f}${e}`), // .5
  fc.tuple(integerPart, exponent).map(([i, e]) => `${i}.${e}`), // 5.
  fc.tuple(pick('0x', '0X'), fc.string({ unit: pick(...HEX), minLength: 1, maxLength: 16 })).map(concat), // 0xFF
  pick('Infinity', 'NaN', '9007199254740993', '1e400', '5e-324', '0.1e-400', '0x20000000000001'),
)

export const numberLiteral: Arbitrary<string> = fc.tuple(pick('', '', '-', '+'), unsignedNumber).map(concat)

// ---------------------------------------------------------------------------
// Strings

/** Characters whose escape is an identity escape (`\a` means `a`). */
const identityEscaped = pick('a', 'c', 'd', 'g', 'z', 'Q', 'é', '中', '!', '~', '-', ' ', '\t')

const escapeSequence = fc.oneof(
  pick('\\b', '\\f', '\\n', '\\r', '\\t', '\\v', '\\"', "\\'", '\\\\', '\\/', '\\0'),
  hex(2).map((h) => `\\x${h}`),
  hex(4).map((h) => `\\u${h}`), // includes lone surrogates
  pick(...LINE_TERMINATORS).map((eol) => `\\${eol}`), // line continuation
  identityEscaped.map((c) => `\\${c}`),
)

export const stringLiteral: Arbitrary<string> = fc
  .tuple(
    pick('"', "'"),
    fc.array(
      fc.oneof(
        { arbitrary: anyChar, weight: 4 },
        { arbitrary: escapeSequence, weight: 2 },
        { arbitrary: pick('"', "'", '0', '7'), weight: 1 },
      ),
      { maxLength: 10 },
    ),
  )
  .map(([quote, parts]) => {
    const body = parts.map((part, i) => {
      if (part === quote) return `\\${quote}`
      if (part === '\\') return '\\\\'
      if (part === '\n') return '\\n'
      if (part === '\r') return '\\r'
      // `\0` followed by a digit is not a valid JSON5 escape.
      if (part === '\\0' && /^[0-9]/.test(parts[i + 1] ?? '')) return '\\x00'
      return part
    })
    return `${quote}${body.join('')}${quote}`
  })

// ---------------------------------------------------------------------------
// Identifiers (unquoted keys)

const identifierStart = pick(
  ...'abcxyzABCXYZ_$',
  'é', 'ü', 'π', 'Σ', '中', // Ll / Lu / Lo
  'ǅ', // Lt
  'ʰ', // Lm
  'Ⅻ', // Nl
)
const identifierPartOnly = pick(
  ...'0123456789',
  '\u0301', // Mn
  '\u0903', // Mc
  '\u0663', // Nd (Arabic-Indic three)
  '‿', // Pc
  '\u200C', '\u200D', // ZWNJ, ZWJ
)

const unicodeEscape = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
const maybeEscaped = (arb: Arbitrary<string>): Arbitrary<string> =>
  fc.oneof({ arbitrary: arb, weight: 5 }, { arbitrary: arb.map(unicodeEscape), weight: 1 })

export const identifier: Arbitrary<string> = fc.oneof(
  { arbitrary: fc.tuple(maybeEscaped(identifierStart), fc.array(maybeEscaped(fc.oneof(identifierStart, identifierPartOnly)), { maxLength: 6 })).map(([start, rest]) => start + rest.join('')), weight: 6 },
  // Reserved words and literal names are valid IdentifierNames, so valid keys.
  { arbitrary: pick('true', 'false', 'null', 'Infinity', 'NaN', 'if', 'constructor', '__proto__'), weight: 1 },
)

// ---------------------------------------------------------------------------
// Values and documents

const key = fc.oneof(identifier, stringLiteral)

const { value } = fc.letrec<{ value: string; array: string; object: string }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    pick('null', 'true', 'false'),
    numberLiteral,
    stringLiteral,
    tie('array'),
    tie('object'),
  ),
  array: fc
    .tuple(fc.array(fc.tuple(ws, tie('value'), ws).map(concat), { maxLength: 5 }), fc.boolean(), ws)
    .map(([items, trailing, inner]) => `[${items.join(',')}${trailing && items.length ? ',' : ''}${inner}]`),
  object: fc
    .tuple(
      fc.array(fc.tuple(ws, key, ws, ws, tie('value'), ws).map(([a, k, b, c, v, d]) => `${a}${k}${b}:${c}${v}${d}`), { maxLength: 5 }),
      fc.boolean(),
      ws,
    )
    .map(([entries, trailing, inner]) => `{${entries.join(',')}${trailing && entries.length ? ',' : ''}${inner}}`),
}))

/** A valid JSON5 document that exercises JSON5-only syntax. */
export const json5Document: Arbitrary<string> = fc.tuple(ws, value, ws).map(concat)

/** A valid plain-JSON document (the common case the fast path must handle). */
export const jsonDocument: Arbitrary<string> = fc
  .tuple(fc.jsonValue(), pick<string | number>(0, 2, '\t'))
  .map(([v, indent]) => JSON.stringify(v, null, indent))

// ---------------------------------------------------------------------------
// Corruption

const corruptionChar = pick(
  ',', ':', '{', '}', '[', ']', '"', "'", '\\', '/', '*', 'a', 'x', 'u', 'e', 'E', 'I', 'N',
  '0', '1', '.', '+', '-', ' ', '\t', '\n', '\r', '\u2028', '\u0000',
)

/**
 * Whole tokens, for the fast path's local rules: signed NaN/Infinity next to colons and digits,
 * hex and dotted numbers next to other numbers, comments and JSON5 whitespace next to commas.
 */
const corruptionToken = pick(
  'NaN', '-NaN', 'Infinity', '+Infinity', '0x', '0x1', '.5', '5.', '1e', 'true', 'null', 'a', '$_',
  ' : ', ',', ', ', '/**/', '//c\n', String.fromCharCode(0xfeff), String.fromCharCode(0xa0), '\v',
  "'", "''", '"', '""', '\\u0061', '\\x41', '\\', '[', ']', '{', '}',
)

const mutation = fc.record({
  kind: pick('insert', 'delete', 'replace'),
  at: fc.nat(),
  char: fc.oneof({ arbitrary: corruptionChar, weight: 3 }, { arbitrary: corruptionToken, weight: 2 }),
})

/** A valid JSON or JSON5 document with 1-3 small edits (characters or whole tokens). May or may not still be valid. */
export const mutatedDocument: Arbitrary<string> = fc
  .tuple(fc.oneof(jsonDocument, json5Document), fc.array(mutation, { minLength: 1, maxLength: 3 }))
  .map(([doc, mutations]) =>
    mutations.reduce((text, { kind, at, char }) => {
      const i = at % (text.length + 1)
      if (kind === 'insert') return text.slice(0, i) + char + text.slice(i)
      if (kind === 'delete') return text.slice(0, i) + text.slice(i + 1)
      return text.slice(0, i) + char + text.slice(i + 1)
    }, doc),
  )
