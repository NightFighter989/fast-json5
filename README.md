# fast-json5

[![npm](https://img.shields.io/npm/v/fast-json5)](https://www.npmjs.com/package/fast-json5) [![CI](https://github.com/NightFighter989/fast-json5/actions/workflows/ci.yml/badge.svg)](https://github.com/NightFighter989/fast-json5/actions/workflows/ci.yml) [![minzipped size](https://img.shields.io/bundlephobia/minzip/fast-json5)](https://bundlephobia.com/package/fast-json5)

A fast, spec-complete [JSON5](https://json5.org) parser. It rewrites JSON5 into plain JSON, using a native regex for every stretch that's already JSON, and lets the engine's own `JSON.parse` build the values. That makes it **5–20× faster than [json5](https://www.npmjs.com/package/json5)**, 3–4× faster than the fastest JSONC parser, and within about **1.3× of `JSON.parse`** on plain JSON.

- A drop-in replacement for `JSON5.parse(text, reviver)`
- The whole JSON5 spec, checked against the official [json5-tests](https://github.com/json5/json5-tests) suite and fuzzed against json5
- Precise `SyntaxError`s with line, column and an error code
- No dependencies, 3.3 KiB minified and gzipped (a third of json5), ESM and CommonJS, TypeScript types included
- Node 18+, Bun, Deno and browsers

```sh
npm install fast-json5
```

## Usage

```ts
import { parse } from 'fast-json5'

const config = parse(`{
  // Comments, unquoted keys and single quotes
  name: 'my-app',
  port: 0x1F90,
  ratio: .75,
  plugins: ['a', 'b',], // trailing commas
}`)
// { name: 'my-app', port: 8080, ratio: 0.75, plugins: ['a', 'b'] }
```

CommonJS works the same way: `const { parse } = require('fast-json5')`. In TypeScript, `parse` returns `any` like `JSON.parse`, or the type you pass it: `parse<Config>(text)`.

### Migrating from json5

```diff
- import JSON5 from 'json5'
- const value = JSON5.parse(text, reviver)
+ import { parse } from 'fast-json5'
+ const value = parse(text, reviver)
```

fast-json5 only parses; keep json5 (or use `JSON.stringify`) if you also need `JSON5.stringify`.

## Benchmarks

Node 22, measured with [mitata](https://github.com/evanwashere/mitata). Run `npm run build && npm run bench` to reproduce. Times are per parse; lower is better. A dash means that parser can't read that input.

| Input | fast-json5 | `JSON.parse` | [jsonc-parser](https://www.npmjs.com/package/jsonc-parser) | [strip-json-comments](https://www.npmjs.com/package/strip-json-comments) + `JSON.parse` | [confbox](https://www.npmjs.com/package/confbox) `parseJSONC` | [json5](https://www.npmjs.com/package/json5) | confbox `parseJSON5` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pure JSON, 318 KiB | **1.5 ms** | 1.1 ms | 6.4 ms | 10.9 ms | 14.1 ms | 30 ms | 32 ms |
| Minified JSON, 154 KiB | **1.3 ms** | 1.0 ms | 4.4 ms | 4.6 ms | 4.7 ms | 21 ms | 21 ms |
| JSONC (comments, trailing commas), 348 KiB | **1.9 ms** | — | 6.8 ms | 13.6 ms | 15.3 ms | 32 ms | 35 ms |
| Full JSON5, 328 KiB | **3.7 ms** | — | — | — | — | 32 ms | 35 ms |
| Small JSON config, 594 B | **3.4 µs** | 2.8 µs | 10.1 µs | 14.6 µs | 19.3 µs | 61 µs | 64 µs |
| Small JSON5 config, 451 B | **8.2 µs** | — | — | — | — | 44 µs | 48 µs |

jsonc-parser is the fastest of the others, and fast-json5 is still 3–4× faster than it while also handling full JSON5. jsonc-parser is error-tolerant: it never throws, and returns a best-effort value plus a list of errors.

## Bundle size

Each parser is bundled the way an app would import it (tree-shaken to its parse function, minified with rolldown). Run `npm run size` to reproduce.

| Parser | Parses | Minified | Minified + gzip |
| --- | --- | --- | --- |
| **fast-json5** | JSON5 | **7.4 KiB** | **3.3 KiB** |
| json5 | JSON5 | 31.3 KiB | 9.6 KiB |
| confbox `parseJSON5` | JSON5 (bundles json5) | 27.4 KiB | 8.1 KiB |
| jsonc-parser | JSONC | 9.5 KiB | 3.1 KiB |
| confbox `parseJSONC` | JSONC (bundles strip-json-comments) | 1.5 KiB | 0.9 KiB |
| strip-json-comments | removes comments and trailing commas; `JSON.parse` does the parsing | 1.0 KiB | 0.6 KiB |

fast-json5 is about a third the size of json5, and about the size of jsonc-parser, which handles only JSONC. The published files aren't minified, so stack traces stay readable; your bundler minifies them.

## How it works

json5 builds every value in JavaScript. fast-json5 never builds values at all: it only rewrites text.

1. A single sticky regex consumes each run of plain-JSON tokens in one native call. A whole pure-JSON document is one call, and its result is the original string, with no copy.
2. JavaScript only wakes up at JSON5 syntax and rewrites that one token into its JSON equivalent:
   - comments and JSON5 whitespace become spaces;
   - trailing commas are dropped;
   - `key:` becomes `"key":`, and `'str'` becomes `"str"`;
   - JSON5 escapes become JSON escapes;
   - `0xFF` becomes `255` and `.5` becomes `0.5`;
   - `Infinity` becomes `1e400`, which `JSON.parse` overflows to `Infinity`;
   - `NaN` becomes a random sentinel that's swapped back afterwards.
3. `JSON.parse` builds the values and checks the structure.

Each rewrite follows a local rule that can only leave invalid input invalid, and a differential fuzzer checks this against json5 on millions of valid and corrupted documents. Invalid input is re-read by a strict scanner, so error messages and positions refer to your text, not the rewritten JSON. [PLAN.md](./PLAN.md) has the full design.

## API

```ts
function parse<T = any>(text: string, reviver?: Reviver): T
function parse<T = any>(text: string, options?: ParseOptions): T

type Reviver = (this: any, key: string, value: any) => any

interface ParseOptions {
  reviver?: Reviver
  nonFinite?: 'allow' | 'reject'
}
```

- **`reviver`** works exactly as in `JSON.parse` and json5. It only ever sees real `NaN` values, never the internal sentinel.
- **`nonFinite`**: `'allow'` (the default) returns `Infinity`, `-Infinity` and `NaN` as numbers, as JSON5 specifies. `'reject'` throws on those literals, for when the result must survive `JSON.stringify`. Overflowing numbers such as `1e400` still parse to `Infinity`, as they do in `JSON.parse`.

### Errors

Invalid input throws a `JSON5SyntaxError`. It's a `SyntaxError` (and its `name` is `'SyntaxError'`), so existing `catch` code keeps working:

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
    error.reason       // the message without the position
  }
}
```

Positions use json5's rules: they're 1-based, only LF starts a new line, and columns count UTF-16 code units. They always refer to your original text.

| `code` | Meaning |
| --- | --- |
| `UNEXPECTED_CHARACTER` | A character that can't appear here; the message says what was expected |
| `UNEXPECTED_END` | The input ended early, including empty input |
| `UNTERMINATED_STRING` | A string has no closing quote |
| `UNTERMINATED_COMMENT` | A `/*` comment has no closing `*/` |
| `LINE_BREAK_IN_STRING` | A raw line break inside a string (escape it, or end the line with `\` to continue) |
| `INVALID_ESCAPE` | A bad escape such as `\x4`, `\u12g4`, `\01` or `\7` |
| `INVALID_IDENTIFIER` | An unquoted key contains an escaped character that isn't allowed in identifiers |
| `NON_FINITE_NOT_ALLOWED` | `Infinity` or `NaN` with `nonFinite: 'reject'` |

Errors thrown by your reviver propagate unchanged. If your app can load both the ESM and CommonJS copies of the package, check `error.code` rather than `instanceof`, since each copy has its own class.

## Differences from json5

- **Newer Unicode in unquoted keys.** json5 classifies key characters with Unicode 10 tables; fast-json5 uses your engine's current Unicode data, as the spec intends. So keys with letters added since Unicode 10 are accepted.
- **Error messages** are worded differently and say what was expected. Positions match json5's, except in three cases where fast-json5 is more precise:
  - a raw line break that causes an error is reported on its own line, where json5 reports the next line at column 0;
  - an astral character (such as an emoji) is reported at its first UTF-16 unit, where json5 reports its second;
  - an unterminated `/*` is reported where it opens, where json5 reports the end of input.

## Development

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests, the json5-tests conformance suite, and a short differential fuzz run |
| `npm run test:fuzz` | The long fuzz run: 200k cases per property |
| `npm run typecheck` | `tsc` over the source and tests, including the API type tests |
| `npm run build` | ESM and CJS builds with declarations into `dist/` |
| `npm run test:smoke` | Runtime checks against the built `dist/`, in both module formats |
| `npm run bench` | The benchmark table above |
| `npm run bench:ab -- <dir>` | Interleaved A/B timing of `dist/` against another build in `<dir>`, as median ratios |
| `npm run size` | The bundle-size table above (`-- --print` also prints fast-json5's minified code) |

The dev toolchain needs Node 22.18 or later; the published package runs on Node 18 and later. See [RELEASING.md](./RELEASING.md) for how releases are published.

## License

MIT
