# fast-json5

> Work in progress. Not yet published.

A JSON5 parser that doesn't build values in JavaScript. It scans JSON5 source, rewrites the JSON5-only syntax into plain JSON, and passes the result to the engine's native `JSON.parse`.

```ts
import { parse } from 'fast-json5'

parse(`{
  // comments
  unquoted: 'single quotes',
  hex: 0xFF,
  trailing: [1, 2, 3,],
}`)
```

It's a drop-in replacement for `JSON5.parse(text, reviver)` from [`json5`](https://www.npmjs.com/package/json5). It has no dependencies, ships ESM and CommonJS builds, and includes TypeScript types.

## Benchmarks

Node 22, `npm run bench` (mitata). Lower is better.

| Input | fast-json5 | `JSON.parse` | json5 | strip-json-comments + `JSON.parse` |
| --- | --- | --- | --- | --- |
| Pure JSON, 318 KiB | **1.50 ms** | 1.21 ms | 30.2 ms (20× slower) | 11.1 ms |
| Minified JSON, 154 KiB | **1.23 ms** | 1.01 ms | 20.8 ms (17×) | 4.4 ms |
| JSONC, 348 KiB | **1.89 ms** | — | 31.7 ms (17×) | 13.5 ms |
| JSON5, 328 KiB | **4.53 ms** | — | 31.0 ms (6.9×) | — |
| Small JSON config, 594 B | **3.3 µs** | 2.9 µs | 57 µs (17×) | 14.6 µs |
| Small JSON5 config, 451 B | **8.8 µs** | — | 45 µs (5.2×) | — |

On plain JSON it runs within about 1.25× of the native parser.

## How it works

A sticky regex consumes each run of plain-JSON tokens in one native call. JavaScript code only wakes up for JSON5 syntax: comments, trailing commas, unquoted keys, single quotes, JSON5 escapes, hex and dotted numbers, `Infinity` and `NaN`. It rewrites each such token into its JSON equivalent, and `JSON.parse` builds the values. Invalid input goes to a strict scanner, which throws a `SyntaxError` with `lineNumber` and `columnNumber` in your original text. See [PLAN.md](./PLAN.md) for the design.

## API

```ts
parse<T = any>(text: string, reviver?: (key, value) => any): T
parse<T = any>(text: string, options?: { reviver?, nonFinite?: 'allow' | 'reject' }): T
```

`nonFinite: 'reject'` throws on `Infinity` and `NaN` literals, for when the result must be representable in JSON.

### Errors

Invalid input throws a `JSON5SyntaxError`. It's a `SyntaxError` (and its `name` is `'SyntaxError'`), so existing checks keep working:

```ts
import { parse, JSON5SyntaxError } from 'fast-json5'

try {
  parse('{\n  a: 1\n  b: 2\n}')
} catch (error) {
  if (error instanceof JSON5SyntaxError) {
    error.message      // `Unexpected character "b"; expected ',' or '}' at line 3, column 3`
    error.lineNumber   // 3
    error.columnNumber // 3
    error.offset       // 11, a 0-based index into the input
    error.code         // 'UNEXPECTED_CHARACTER'
  }
}
```

Positions refer to your original text, never to the rewritten JSON, and use json5's rules: 1-based, only LF starts a new line, and columns count UTF-16 code units. `code` is one of `UNEXPECTED_CHARACTER`, `UNEXPECTED_END`, `UNTERMINATED_STRING`, `UNTERMINATED_COMMENT`, `LINE_BREAK_IN_STRING`, `INVALID_ESCAPE`, `INVALID_IDENTIFIER` or `NON_FINITE_NOT_ALLOWED`. Errors thrown by your reviver propagate unchanged.

## Differences from json5

- **Unicode version of identifiers.** json5 classifies unquoted-key characters with Unicode 10 tables; fast-json5 uses your engine's current Unicode data. So keys containing letters added after Unicode 10 are accepted here.
- **Error messages** are worded differently and say what was expected. Positions match json5's, with three exceptions where fast-json5 is more precise:
  - a line break as the offending character is reported on its own line, where json5 reports the next line at column 0;
  - an astral character (such as an emoji) is reported at its first UTF-16 unit, where json5 reports its second;
  - an unterminated `/*` is reported where it opens, where json5 reports end of input.

## License

MIT
